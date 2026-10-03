/**
 * scripts/check-workflows.ts: every committed workflow passes the hardening
 * lint, each rule fires on a minimal bad workflow, and deploy-devnet.yml runs
 * the #2982 steps in order with its secrets confined to one step.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Block, lintWorkflow, parseWorkflowYaml, type YNode } from "../scripts/check-workflows.ts";

const repo = new URL("..", import.meta.url).pathname;
const workflowsDir = join(repo, ".github", "workflows");
const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";

function rules(source: string): string[] {
  return lintWorkflow(source, "test.yml").map((f) => f.rule);
}

/** A clean single-job workflow; `steps` is spliced in under `steps:`. */
function workflow(steps: string, extra: { on?: string; job?: string; top?: string } = {}): string {
  return [
    "name: t",
    "on:",
    extra.on ?? "  push:\n    branches: [main]",
    "permissions:",
    "  contents: read",
    extra.top ?? "",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-24.04",
    extra.job ?? "",
    "    steps:",
    steps,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

const CHECKOUT = `      - uses: actions/checkout@${SHA} # v7.0.1\n        with:\n          persist-credentials: false`;

describe("committed workflows", () => {
  const files = readdirSync(workflowsDir).filter((name) => /\.ya?ml$/.test(name));

  it("includes deploy-devnet.yml, and every workflow passes the lint", () => {
    expect(files).toContain("deploy-devnet.yml");
    for (const file of files) {
      expect(lintWorkflow(readFileSync(join(workflowsDir, file), "utf8"), file)).toEqual([]);
    }
  });
});

describe("deploy-devnet.yml", () => {
  const source = readFileSync(join(workflowsDir, "deploy-devnet.yml"), "utf8");
  const root = parseWorkflowYaml(source) as Record<string, YNode>;
  const jobs = root.jobs as Record<string, Record<string, YNode>>;
  const deploy = jobs.deploy!;
  const steps = deploy.steps as Record<string, YNode>[];
  const runOf = (step: Record<string, YNode>): string => (step.run instanceof Block ? step.run.block : String(step.run ?? ""));
  const indexOf = (pattern: RegExp): number => steps.findIndex((step) => pattern.test(runOf(step)));

  it("runs on v* tags (and a no-input dispatch), in the devnet environment, from the verifiable build of the same run", () => {
    const on = root.on as Record<string, YNode>;
    expect((on.push as Record<string, YNode>).tags).toBe('["v*"]');
    expect(on.workflow_dispatch).toBe("{}");
    expect(deploy.environment).toBe("devnet");
    expect(deploy.needs).toBe("verifiable-build");
    expect(jobs["verifiable-build"]!.uses).toBe("./.github/workflows/verifiable-build.yml");
  });

  it("runs the #2982 steps in order: hash check, deploy, program hash, initialize, verify-from-repo, record, cleanup", () => {
    const order = [
      indexOf(/sha256sum -c/),
      indexOf(/solana program deploy/),
      indexOf(/solana-verify[^\n]*get-program-hash/),
      indexOf(/admin -- initialize --cluster devnet\s*\\\n\s*--keypair/),
      indexOf(/verify-from-repo/),
      indexOf(/scripts\/deploy-record\.ts/),
    ];
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const deployRun = runOf(steps[order[1]!]!);
    expect(deployRun).toMatch(/--upgrade-authority "\$\{keys\}\/deployer\.json"/);
    expect(deployRun).not.toMatch(/--final/);
    expect(runOf(steps[order[4]!]!)).toMatch(/--arch v3/);
    // The key directory is deleted in an always() step, before any upload.
    const cleanup = steps.findIndex((step) => /always\(\)/.test(String(step.if)) && /rm -rf -- "\$\{RUNNER_TEMP\}\/keys"/.test(runOf(step)));
    expect(cleanup).toBeGreaterThan(order[5]!);
    const uploads = steps.flatMap((step, index) => (/upload-artifact/.test(String(step.uses ?? "")) ? [index] : []));
    expect(uploads.length).toBeGreaterThan(0);
    expect(uploads.every((index) => index > cleanup)).toBe(true);
  });

  it("a re-run whose program already has the verified hash skips the deploy and still initializes", () => {
    const deployRun = runOf(steps[indexOf(/solana program deploy/)]!);
    expect(deployRun).toMatch(/get-program-hash "\$\{PROGRAM_ID\}"/);
    expect(deployRun).toMatch(/if \[ "\$\{deployed_hash\}" = "\$\{PROGRAM_HASH\}" \]/);
    expect(deployRun.indexOf('rm -f "${keys}/program.json"')).toBeGreaterThan(deployRun.indexOf("fi"));
  });

  it("only one step receives the two secrets, and it writes them after umask 077", () => {
    const withSecrets = steps.filter((step) => /secrets\./.test(JSON.stringify(step.env ?? {})));
    expect(withSecrets).toHaveLength(1);
    expect(withSecrets[0]!.env).toEqual({
      DEVNET_PROGRAM_KEYPAIR: "${{ secrets.DEVNET_PROGRAM_KEYPAIR }}",
      DEVNET_DEPLOYER_KEYPAIR: "${{ secrets.DEVNET_DEPLOYER_KEYPAIR }}",
    });
    const run = runOf(withSecrets[0]!);
    expect(run.indexOf("umask 077")).toBeLessThan(run.indexOf("DEVNET_PROGRAM_KEYPAIR"));
    expect(source.match(/secrets\./g)).toHaveLength(2);
    // Unset right after the two writes, before any external command inherits them.
    const lines = run.split("\n");
    const unset = lines.findIndex((line) => /^\s*unset DEVNET_PROGRAM_KEYPAIR DEVNET_DEPLOYER_KEYPAIR\s*$/.test(line));
    const writes = lines.flatMap((line, index) => (/^\s*printf '%s' "\$\{DEVNET_[A-Z_]+\}" > /.test(line) ? [index] : []));
    expect(writes).toHaveLength(2);
    const lastWrite = writes[1]!;
    expect(unset).toBeGreaterThan(lastWrite);
    expect(lines.slice(lastWrite + 1, unset).every((line) => /^\s*(#.*)?$/.test(line))).toBe(true);
    expect(lines.slice(unset + 1).some((line) => /\$\{?DEVNET_(PROGRAM|DEPLOYER)_KEYPAIR/.test(line))).toBe(false);
  });

  it("the deploy passes its own buffer key, so the CLI never prints an ephemeral seed phrase, and a failed deploy's buffer is closed", () => {
    const deployIndex = indexOf(/solana program deploy/);
    const deployRun = runOf(steps[deployIndex]!);
    expect(steps[deployIndex]!.id).toBe("deploy");
    const keygen = deployRun.indexOf('solana-keygen new --no-bip39-passphrase --silent --outfile "${keys}/buffer.json"');
    expect(keygen).toBeGreaterThan(-1);
    expect(deployRun.indexOf('--buffer "${keys}/buffer.json"')).toBeGreaterThan(keygen);
    expect(deployRun.indexOf("umask 077")).toBeLessThan(keygen);
    const close = steps.findIndex((step) => /solana program close "\$\{buffer\}"/.test(runOf(step)));
    expect(String(steps[close]!.if)).toMatch(/failure\(\) && steps\.deploy\.outcome == 'failure'/);
    const cleanup = steps.findIndex((step) => /rm -rf -- "\$\{RUNNER_TEMP\}\/keys"/.test(runOf(step)));
    expect(close).toBeGreaterThan(deployIndex);
    expect(close).toBeLessThan(cleanup);
  });

  it("the record keeps earlier initialize signatures from the committed deployments/devnet.json", () => {
    expect(runOf(steps[indexOf(/scripts\/deploy-record\.ts/)]!)).toMatch(/--previous deployments\/devnet\.json/);
  });

  it("never pushes: the token is read-only and no step runs git push", () => {
    expect(root.permissions).toEqual({ contents: "read" });
    expect(source).not.toMatch(/git push|contents: write/);
  });
});

describe("each rule fires on a minimal bad workflow", () => {
  it("a clean workflow has no findings", () => {
    expect(rules(workflow(`${CHECKOUT}\n      - run: echo ok`))).toEqual([]);
  });

  it("pinned-uses: tags and branches are refused; SHAs, local paths and docker digests pass", () => {
    expect(rules(workflow("      - uses: actions/setup-node@v4"))).toEqual(["pinned-uses"]);
    expect(rules(workflow("      - uses: actions/setup-node@main"))).toEqual(["pinned-uses"]);
    expect(rules(workflow(`      - uses: actions/setup-node@${SHA}`))).toEqual([]);
    expect(rules(workflow("      - uses: ./.github/actions/local"))).toEqual([]);
    expect(rules(workflow(`      - uses: docker://alpine@sha256:${"a".repeat(64)}`))).toEqual([]);
    expect(rules(workflow("      - uses: docker://alpine:3"))).toEqual(["pinned-uses"]);
  });

  it("no-expression-in-run: ${{ }} in a run script, even in a comment", () => {
    expect(rules(workflow("      - run: echo ${{ github.ref_name }}"))).toEqual(["no-expression-in-run"]);
    expect(rules(workflow("      - run: |\n          # ${{ github.ref }}\n          echo ok"))).toEqual(["no-expression-in-run"]);
  });

  it("no-xtrace: set -x, set -ex, set -o xtrace, bash -x", () => {
    for (const line of ["set -x", "set -euxo pipefail", "set -o xtrace", "bash -x script.sh"]) {
      expect(rules(workflow(`      - run: |\n          ${line}\n          echo ok`))).toEqual(["no-xtrace"]);
    }
  });

  it("secrets: only as NAME: ${{ secrets.NAME }} in one step's env, never in run, with, or job/workflow env", () => {
    const job = '    environment: devnet\n';
    const cleanup = '      - if: ${{ always() }}\n        run: rm -rf -- "${RUNNER_TEMP}/keys"';
    const good = `      - env:\n          KEY: \${{ secrets.KEY }}\n        run: |\n          umask 077\n          printf '%s' "\${KEY}" > "\${RUNNER_TEMP}/keys/k.json"\n${cleanup}`;
    expect(rules(workflow(good, { job }))).toEqual([]);

    expect(rules(workflow("      - run: echo ${{ secrets.KEY }}"))).toEqual(
      expect.arrayContaining(["no-expression-in-run", "secrets-in-step-env"]),
    );
    expect(rules(workflow(`      - uses: some/action@${SHA}\n        with:\n          token: \${{ secrets.KEY }}`))).toContain("secrets-in-step-env");
    expect(rules(workflow("      - run: echo ok", { top: "env:\n  KEY: ${{ secrets.KEY }}" }))).toContain("secrets-in-step-env");
    expect(rules(workflow("      - run: echo ok", { job: "    env:\n      KEY: ${{ secrets.KEY }}" }))).toContain("secrets-in-step-env");
    const wrapped = good.replace("KEY: ${{ secrets.KEY }}", 'KEY: "prefix-${{ secrets.KEY }}"');
    expect(rules(workflow(wrapped, { job }))).toContain("secrets-in-step-env");
    expect(
      rules(
        [
          "on:",
          "  push:",
          "permissions:",
          "  contents: read",
          "jobs:",
          "  call:",
          "    uses: ./.github/workflows/other.yml",
          "    secrets: inherit",
        ].join("\n"),
      ),
    ).toContain("secrets-in-step-env");
  });

  it("umask-before-secret, secret-job-environment and secret-cleanup", () => {
    const noUmask = `      - env:\n          KEY: \${{ secrets.KEY }}\n        run: |\n          printf '%s' "\${KEY}" > k.json\n          umask 077`;
    expect(rules(workflow(noUmask))).toEqual(
      expect.arrayContaining(["umask-before-secret", "secret-job-environment", "secret-cleanup"]),
    );
    const usesStep = `      - uses: some/action@${SHA}\n        env:\n          KEY: \${{ secrets.KEY }}`;
    expect(rules(workflow(usesStep, { job: "    environment: devnet" }))).toEqual(
      expect.arrayContaining(["umask-before-secret", "secret-cleanup"]),
    );
  });

  it("secret-cleanup: the always() step must delete the key directory the secrets are written to, before any upload", () => {
    const job = "    environment: devnet";
    const write = (target: string, prelude = ""): string =>
      `      - env:\n          KEY: \${{ secrets.KEY }}\n        run: |\n          umask 077\n${prelude}          printf '%s' "\${KEY}" > ${target}\n`;
    const cleanup = (command: string): string => `      - if: \${{ always() }}\n        run: ${command}\n`;
    const upload = `      - uses: actions/upload-artifact@${SHA}\n        with:\n          path: out\n`;
    const keysCleanup = cleanup('rm -rf -- "${RUNNER_TEMP}/keys"');

    // Through a variable, as deploy-devnet.yml does.
    const viaVariable = write('"${keys}/k.json"', '          keys="${RUNNER_TEMP}/keys"\n          mkdir -m 700 "${keys}"\n');
    expect(rules(workflow(viaVariable + keysCleanup + upload, { job }))).toEqual([]);
    // An unrelated rm -f in an always() step is not a cleanup.
    expect(rules(workflow(write('"${RUNNER_TEMP}/keys/k.json"') + cleanup("rm -f /tmp/unrelated"), { job }))).toEqual(["secret-cleanup"]);
    // Keys written outside ${RUNNER_TEMP}/keys/ are never deleted by the cleanup.
    const elsewhere = write('"${k}/k.json"', '          k="${RUNNER_TEMP}/k"\n');
    expect(rules(workflow(elsewhere + keysCleanup, { job }))).toEqual(["secret-cleanup"]);
    expect(rules(workflow(write('"${GITHUB_ENV}"') + keysCleanup, { job }))).toEqual(["secret-cleanup"]);
    // A variable holding the secret counts as the secret.
    const copied = write('"${RUNNER_TEMP}/k.json"', '          copy="${KEY}"\n').replace('"${KEY}" >', '"${copy}" >');
    expect(rules(workflow(copied + keysCleanup, { job }))).toEqual(["secret-cleanup"]);
    // The cleanup must come after the secret step and before every upload.
    expect(rules(workflow(write('"${RUNNER_TEMP}/keys/k.json"') + upload + keysCleanup, { job }))).toEqual(["secret-cleanup"]);
    expect(rules(workflow(keysCleanup + write('"${RUNNER_TEMP}/keys/k.json"'), { job }))).toEqual(["secret-cleanup"]);
  });

  it("checkout-no-credentials, read-only-token, dispatch-no-inputs, no-risky-triggers", () => {
    expect(rules(workflow(`      - uses: actions/checkout@${SHA}`))).toEqual(["checkout-no-credentials"]);
    expect(rules(workflow("      - run: echo ok").replace("  contents: read", "  contents: write"))).toEqual(["read-only-token"]);
    expect(rules(workflow("      - run: echo ok").replace("permissions:\n  contents: read\n", ""))).toEqual(["read-only-token"]);
    expect(
      rules(workflow("      - run: echo ok", { on: "  workflow_dispatch:\n    inputs:\n      ref:\n        type: string" })),
    ).toEqual(["dispatch-no-inputs"]);
    expect(rules(workflow("      - run: echo ok", { on: "  pull_request_target:" }))).toEqual(["no-risky-triggers"]);
    expect(rules(workflow("      - run: echo ok", { on: "  workflow_run:\n    workflows: [CI]" }))).toEqual(["no-risky-triggers"]);
  });

  it("checksummed-downloads and no-pipe-to-shell", () => {
    expect(rules(workflow("      - run: curl -sSfL -o tool.tgz https://example.invalid/tool.tgz"))).toEqual(["checksummed-downloads"]);
    expect(
      rules(workflow("      - run: |\n          curl -sSfL -o t.tgz https://example.invalid/t.tgz\n          echo \"abc  t.tgz\" | sha256sum -c -")),
    ).toEqual([]);
    expect(
      rules(workflow("      - run: |\n          curl -sSfL https://example.invalid/install.sh | sh\n          echo x | sha256sum -c -")),
    ).toEqual(["no-pipe-to-shell"]);
  });

  it("an unparseable workflow is a finding, not a pass", () => {
    expect(rules("on:\n\tpush:")).toEqual(["parse"]);
  });
});
