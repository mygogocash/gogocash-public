// Enforces the org's release-age hold on Cargo lockfiles: every crates.io
// package must have been published at least MIN_AGE_DAYS days ago.
//
// Usage:
//   node scripts/check-crate-age.mjs <Cargo.lock> [<Cargo.lock> ...]
//   node scripts/check-crate-age.mjs --self-test
//
// The publish time comes from the `pubtime` field of the crates.io sparse
// index (https://index.crates.io/<prefix>/<name>), one JSON line per version.
// Only `source = "registry+https://github.com/rust-lang/crates.io-index"`
// packages are checked; path and git packages have no publish time.
//
// Fails (exit 1) when a package is inside the hold, when its version is not in
// the index, when the index line has no pubtime, or when the index cannot be
// read after retries. An age that cannot be proven is treated as too new.
// Exit 2 is bad usage. No dependencies; needs Node 18+ (global fetch).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import process from "node:process";

const MIN_AGE_DAYS = 7;
const DAY_MS = 86_400_000;
const CRATES_IO = "registry+https://github.com/rust-lang/crates.io-index";
const INDEX = "https://index.crates.io";
const USER_AGENT = "gogocash-public-ci release-age check (github.com/mygogocash/gogocash-public)";
const CONCURRENCY = 16;
const ATTEMPTS = 4;
const TIMEOUT_MS = 20_000;

/** Sparse index path for a crate name (cargo's documented layout). */
function indexPath(name) {
  const n = name.toLowerCase();
  if (n.length === 0) throw new Error("empty crate name");
  if (n.length <= 2) return `${n.length}/${n}`;
  if (n.length === 3) return `3/${n[0]}/${n}`;
  return `${n.slice(0, 2)}/${n.slice(2, 4)}/${n}`;
}

/** Returns the unique crates.io {name, version} pairs in a Cargo.lock text. */
function parseLock(text) {
  const out = new Map();
  for (const block of text.split(/^\[\[package\]\]$/m).slice(1)) {
    const name = /^name = "([^"]+)"$/m.exec(block)?.[1];
    const version = /^version = "([^"]+)"$/m.exec(block)?.[1];
    const source = /^source = "([^"]+)"$/m.exec(block)?.[1];
    if (!name || !version) throw new Error(`malformed [[package]] block:\n${block.trim()}`);
    if (source === CRATES_IO) out.set(`${name}@${version}`, { name, version });
  }
  return out;
}

/** Classifies one index entry against the cutoff. */
function classify(entry, cutoffMs) {
  if (!entry) return "not-in-index";
  if (typeof entry.pubtime !== "string") return "no-pubtime";
  const t = Date.parse(entry.pubtime);
  if (Number.isNaN(t)) return "no-pubtime";
  return t > cutoffMs ? "too-new" : "ok";
}

async function fetchIndex(name) {
  const url = `${INDEX}/${indexPath(name)}`;
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        return (await res.text())
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line));
      }
      lastError = new Error(`HTTP ${res.status} for ${url}`);
      if (res.status === 404) break;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  throw new Error(`could not read ${url}: ${lastError?.message ?? lastError}`);
}

function selfTest() {
  assert.equal(indexPath("a"), "1/a");
  assert.equal(indexPath("cc"), "2/cc");
  assert.equal(indexPath("syn"), "3/s/syn");
  assert.equal(indexPath("Serde"), "se/rd/serde");
  assert.equal(indexPath("litesvm"), "li/te/litesvm");

  const lock = [
    "version = 4",
    "",
    "[[package]]",
    'name = "gogocash-cashback"',
    'version = "0.1.0"',
    "",
    "[[package]]",
    'name = "syn"',
    'version = "2.0.0"',
    `source = "${CRATES_IO}"`,
    'checksum = "00"',
    "",
    "[[package]]",
    'name = "forked"',
    'version = "1.0.0"',
    'source = "git+https://example.invalid/forked#abc"',
    "",
  ].join("\n");
  assert.deepEqual([...parseLock(lock).keys()], ["syn@2.0.0"]);
  assert.throws(() => parseLock('[[package]]\nversion = "1.0.0"\n'));

  const cutoff = Date.parse("2026-09-24T00:00:00Z");
  assert.equal(classify({ pubtime: "2026-09-23T23:59:59Z" }, cutoff), "ok");
  assert.equal(classify({ pubtime: "2026-09-24T00:00:01Z" }, cutoff), "too-new");
  assert.equal(classify({}, cutoff), "no-pubtime");
  assert.equal(classify({ pubtime: "yesterday-ish" }, cutoff), "no-pubtime");
  assert.equal(classify(undefined, cutoff), "not-in-index");
  console.log("check-crate-age: self-test passed");
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === "--self-test") return selfTest();
  if (argv.length === 0 || argv.some((a) => a.startsWith("-"))) {
    console.error("usage: node scripts/check-crate-age.mjs <Cargo.lock> [<Cargo.lock> ...]");
    console.error("       node scripts/check-crate-age.mjs --self-test");
    process.exit(2);
  }

  const pkgs = new Map();
  for (const file of argv) {
    const found = parseLock(readFileSync(file, "utf8"));
    if (found.size === 0) {
      console.error(`::error file=${file}::no crates.io packages found; is this a Cargo.lock?`);
      process.exit(1);
    }
    for (const [k, v] of found) pkgs.set(k, v);
  }

  const cutoffMs = Date.now() - MIN_AGE_DAYS * DAY_MS;
  const byName = new Map();
  for (const { name, version } of pkgs.values()) {
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(version);
  }

  const problems = [];
  const names = [...byName.keys()].sort();
  for (let i = 0; i < names.length; i += CONCURRENCY) {
    await Promise.all(
      names.slice(i, i + CONCURRENCY).map(async (name) => {
        let entries;
        try {
          entries = await fetchIndex(name);
        } catch (err) {
          problems.push(`${name}: ${err.message}`);
          return;
        }
        for (const version of byName.get(name)) {
          const entry = entries.find((e) => e.vers === version);
          const verdict = classify(entry, cutoffMs);
          if (verdict !== "ok") {
            problems.push(`${name}@${version}: ${verdict}${entry?.pubtime ? ` (published ${entry.pubtime})` : ""}`);
          }
        }
      }),
    );
  }

  const cutoff = new Date(cutoffMs).toISOString();
  console.log(`checked ${pkgs.size} crates.io packages (${names.length} crates) against a ${MIN_AGE_DAYS}-day hold, cutoff ${cutoff}`);
  if (problems.length > 0) {
    for (const p of problems.sort()) console.log(`::error::release-age hold: ${p}`);
    console.log(
      "Pin each too-new crate back with `cargo update -p <name> --precise <older-version>` " +
        "(in the workspace that owns the lockfile) before committing the lockfile.",
    );
    process.exit(1);
  }
  console.log("check-crate-age: every crates.io package is outside the hold");
}

await main(process.argv.slice(2));
