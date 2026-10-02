// Proves the repository can't quietly accept key material.
//
// 1. Ignore rules: every path a Solana, Anchor or signing tool writes keys or
//    build output to must be git-ignored.
// 2. Secret-scan rules: a committed Solana keypair, in either of its two
//    common shapes, must fail `gitleaks git` with this repo's config, and the
//    report must be redacted.
// 3. No over-reach: a public key or a short byte array must not be flagged.
//
// Every fixture is generated at runtime from random bytes, so this file never
// holds a scannable key itself. Runs in CI after gitleaks is installed:
//   node scripts/check-hygiene.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(repoRoot, ".gitleaks.toml");

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes) {
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let out = "";
  while (value > 0n) {
    out = BASE58[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

function checkIgnored() {
  const mustBeIgnored = [
    "target/deploy/gogocash_cashback.so",
    "target/deploy/gogocash_cashback-keypair.json",
    "programs/gogocash-cashback/target/debug/build.log",
    ".anchor/program-logs/x.log",
    "test-ledger/validator.log",
    "keys/devnet-deployer.json",
    "deployer-keypair.json",
    "scripts/claim-authority-keypair.json",
    "fee-payer.keypair.json",
    "credentials.json",
    ".env",
    ".env.devnet",
  ];
  const notIgnored = mustBeIgnored.filter(
    (path) =>
      spawnSync("git", ["check-ignore", "-q", "--no-index", path], { cwd: repoRoot }).status !== 0,
  );
  assert.deepEqual(notIgnored, [], `these paths must be git-ignored: ${notIgnored.join(", ")}`);
}

function scan(files) {
  const root = mkdtempSync(join(tmpdir(), "gogocash-public-hygiene-"));
  try {
    cpSync(configPath, join(root, ".gitleaks.toml"));
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "Hygiene Canary",
      GIT_AUTHOR_EMAIL: "hygiene-canary@test.invalid",
      GIT_COMMITTER_NAME: "Hygiene Canary",
      GIT_COMMITTER_EMAIL: "hygiene-canary@test.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    };
    const git = (...args) => execFileSync("git", args, { cwd: root, env, stdio: "pipe" });
    git("init", "-q", "--initial-branch=main");
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(root, name), body, { mode: 0o600 });
    }
    git("add", ".");
    git("commit", "-q", "-m", "canary");

    const reportPath = join(root, "report.json");
    const result = spawnSync(
      "gitleaks",
      [
        "git",
        "--no-banner",
        "--redact=100",
        "--config",
        join(root, ".gitleaks.toml"),
        "--report-format",
        "json",
        "--report-path",
        reportPath,
        ".",
      ],
      { cwd: root, encoding: "utf8" },
    );
    // A missing binary must never read as a clean scan.
    assert.equal(result.error, undefined, `gitleaks did not start: ${result.error}`);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    return { status: result.status, report, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function checkKeyMaterialIsCaught() {
  const secretKey = randomBytes(64);
  const { status, report, output } = scan({
    "devnet-wallet.json": `${JSON.stringify([...secretKey])}\n`,
    "settings.env": `SOLANA_CLAIM_AUTHORITY_KEYPAIR=${base58(randomBytes(64))}\n`,
    // The public-address allowlist for *token_account keys must not let a
    // 64-byte secret through under the same key name.
    // Pretty-printed, one property per line, so the line has the same shape
    // as a public address that the allowlist does accept.
    "leaked-account.json": `${JSON.stringify({ recipient_token_account: base58(randomBytes(64)) }, null, 2)}\n`,
  });
  assert.equal(status, 1, `expected gitleaks to report leaks (exit 1), got ${status}\n${output}`);
  for (const [file, ruleId] of [
    ["devnet-wallet.json", "solana-keypair-json"],
    ["settings.env", "solana-secret-key-base58"],
  ]) {
    assert.ok(
      report.some((f) => f.File === file && f.RuleID === ruleId && f.Secret === "REDACTED"),
      `${file} must be reported by ${ruleId}, redacted; got ${JSON.stringify(
        report.map((f) => [f.File, f.RuleID]),
      )}`,
    );
  }
  // Asserted by rule ID: the upstream generic-api-key rule also matches this
  // line, but it skips values that contain one of its stopwords, so relying
  // on it made this check fail at random (about 2% of runs).
  assert.ok(
    report.some(
      (f) =>
        f.File === "leaked-account.json" &&
        f.RuleID === "solana-secret-key-base58-token-account" &&
        f.Secret === "REDACTED",
    ),
    `a 64-byte base58 value under a *token_account key must still be reported; got ${JSON.stringify(
      report.map((f) => [f.File, f.RuleID]),
    )}`,
  );
}

function checkPublicDataIsNotFlagged() {
  const { status, output } = scan({
    "deployment.json": `${JSON.stringify(
      {
        programId: base58(randomBytes(32)),
        publicKey: base58(randomBytes(32)),
        // A public associated token account. generic-api-key matches on the
        // word "token" in the key name; docs/CONTRACT.md carries these.
        recipient_token_account: base58(randomBytes(32)),
        vault_token_account: base58(randomBytes(32)),
        discriminator: [...randomBytes(8)],
        pdaSeed: [...randomBytes(32)],
      },
      null,
      2,
    )}\n`,
  });
  assert.equal(status, 0, `public keys and short byte arrays must not be flagged\n${output}`);
}

checkIgnored();
checkKeyMaterialIsCaught();
checkPublicDataIsNotFlagged();
console.log("check-hygiene: ignore rules and secret-scan rules OK");
