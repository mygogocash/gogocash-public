/**
 * Solana keypair files (the solana-keygen format: a JSON array of 64 bytes,
 * the 32-byte Ed25519 seed followed by the 32-byte public key).
 *
 * - `writeNewKeypairFile` generates a key with node:crypto and writes it
 *   under umask 077 (mode 0600), never over an existing file, and only to a
 *   path outside every git worktree or git-ignored.
 * - `readKeypairSigner` loads one for signing: mode 0600 or stricter, exactly
 *   64 bytes, and the last 32 bytes must be the public key of the first 32.
 *
 * Refusals never quote the file content or the path. Buffers that held the
 * seed are zeroed after use (best effort: the signer keeps a non-extractable
 * CryptoKey, and JavaScript strings cannot be wiped).
 */
import { spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";
import { encodeBase58 } from "../../src/base58.ts";

export class KeyFileError extends Error {
  override name = "KeyFileError";
}

// DER header of a PKCS#8 Ed25519 private key; the 32-byte seed follows it.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const MAX_KEY_FILE_BYTES = 1024;

// Variables that would point git at some repository other than the one that
// holds the path (a git hook exports several of them).
const GIT_LOCATION_VARIABLES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_CEILING_DIRECTORIES",
];

function publicKeyFromSeed(seed: Uint8Array): Buffer {
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  try {
    const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
    return Buffer.from(spki.subarray(spki.length - 32));
  } finally {
    der.fill(0);
  }
}

/** The JSON text bytes `[n,n,...,n]`, built without an intermediate string. */
function keypairJsonBytes(secret: Uint8Array): Buffer {
  const out = Buffer.alloc(1 + secret.length * 4 + 1);
  let offset = 0;
  out[offset++] = 0x5b; // [
  secret.forEach((byte, index) => {
    if (index > 0) out[offset++] = 0x2c; // ,
    if (byte >= 100) out[offset++] = 0x30 + Math.floor(byte / 100);
    if (byte >= 10) out[offset++] = 0x30 + (Math.floor(byte / 10) % 10);
    out[offset++] = 0x30 + (byte % 10);
  });
  out[offset++] = 0x5d; // ]
  const text = Buffer.from(out.subarray(0, offset));
  out.fill(0);
  return text;
}

/** Parses keypair file bytes into the 64-byte secret key. Refusals name counts only. */
export function parseKeypairBytes(text: Buffer): Uint8Array {
  // Parse digits by hand so no JavaScript string ever holds the key.
  const values: number[] = [];
  let index = 0;
  const skipSpace = (): void => {
    while (index < text.length && (text[index] === 0x20 || text[index] === 0x0a || text[index] === 0x0d || text[index] === 0x09)) {
      index += 1;
    }
  };
  skipSpace();
  if (text[index] !== 0x5b) throw new KeyFileError("the keypair file must hold a JSON array of 64 bytes.");
  index += 1;
  skipSpace();
  while (index < text.length && text[index] !== 0x5d) {
    let value = 0;
    let digits = 0;
    while (index < text.length && (text[index] as number) >= 0x30 && (text[index] as number) <= 0x39) {
      value = value * 10 + ((text[index] as number) - 0x30);
      digits += 1;
      index += 1;
    }
    if (digits === 0 || digits > 3 || value > 255) {
      values.fill(0);
      throw new KeyFileError(`keypair value ${values.length} is not an integer from 0 to 255.`);
    }
    values.push(value);
    skipSpace();
    if (text[index] === 0x2c) {
      index += 1;
      skipSpace();
    } else if (text[index] !== 0x5d) {
      values.fill(0);
      throw new KeyFileError("the keypair file must hold a JSON array of 64 bytes.");
    }
  }
  if (text[index] !== 0x5d) {
    values.fill(0);
    throw new KeyFileError("the keypair file must hold a JSON array of 64 bytes.");
  }
  index += 1;
  skipSpace();
  if (index !== text.length) {
    values.fill(0);
    throw new KeyFileError("the keypair file has content after the JSON array.");
  }
  if (values.length !== 64) {
    const count = values.length;
    values.fill(0);
    throw new KeyFileError(`the keypair file holds ${count} values; a Solana keypair has 64.`);
  }
  const secret = Uint8Array.from(values);
  values.fill(0);
  const derived = publicKeyFromSeed(secret.subarray(0, 32));
  const matches = derived.equals(Buffer.from(secret.subarray(32)));
  if (!matches) {
    secret.fill(0);
    throw new KeyFileError("the last 32 bytes are not the public key of the first 32, so this is not a Solana keypair file.");
  }
  return secret;
}

/** Throws unless a key file is mode 0600 or stricter (no group or other access). */
function assertPrivateMode(stat: fs.Stats, flag: string): void {
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new KeyFileError(`the ${flag} file is readable by group or others; run chmod 600 on it first.`);
  }
}

/** Loads a keypair file into a non-extractable kit signer. */
export async function readKeypairSigner(filePath: string, flag = "--keypair"): Promise<KeyPairSigner> {
  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY);
  } catch {
    throw new KeyFileError(`the ${flag} file cannot be opened.`);
  }
  let text: Buffer = Buffer.alloc(0);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new KeyFileError(`the ${flag} path is not a regular file.`);
    assertPrivateMode(stat, flag);
    if (stat.size > MAX_KEY_FILE_BYTES) throw new KeyFileError(`the ${flag} file is too large to be a keypair file.`);
    text = Buffer.alloc(stat.size);
    let read = 0;
    while (read < stat.size) {
      const n = fs.readSync(fd, text, read, stat.size - read, read);
      if (n === 0) break;
      read += n;
    }
    const secret = parseKeypairBytes(text.subarray(0, read));
    try {
      return await createKeyPairSignerFromBytes(secret, false);
    } finally {
      secret.fill(0);
    }
  } finally {
    text.fill(0);
    fs.closeSync(fd);
  }
}

/** The nearest existing ancestor directory of a path. */
function nearestExistingDirectory(target: string): string {
  let dir = path.dirname(target);
  for (;;) {
    const stat = fs.statSync(dir, { throwIfNoEntry: false });
    if (stat?.isDirectory()) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
}

/**
 * Refuses a path git could pick up: inside a git worktree and not ignored.
 * Works for paths whose directories do not exist yet.
 */
export function assertNotTrackable(target: string): void {
  const absolute = path.resolve(target);
  const dir = nearestExistingDirectory(absolute);
  const env: Record<string, string | undefined> = { ...process.env, LC_ALL: "C" };
  for (const name of GIT_LOCATION_VARIABLES) delete env[name];
  const git = (...args: string[]) =>
    spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  const inside = git("rev-parse", "--is-inside-work-tree");
  if (inside.error) throw new KeyFileError("git is unavailable, so the key path cannot be proven outside git.");
  if (inside.status !== 0) {
    if (/not a git repository/i.test(inside.stderr)) return;
    throw new KeyFileError("git could not tell whether the key path is in a worktree.");
  }
  if (inside.stdout.trim() !== "true") throw new KeyFileError("the key path is inside a .git directory.");
  const relative = path.relative(dir, absolute);
  const ignored = git("check-ignore", "-q", "--no-index", "--", relative);
  if (ignored.status === 0) return;
  if (ignored.status === 1) {
    throw new KeyFileError(
      "the key path is inside a git worktree and not git-ignored; use a path outside the repository such as ~/.config/gogocash/devnet/.",
    );
  }
  throw new KeyFileError("git check-ignore failed for the key path.");
}

/**
 * Generates an Ed25519 key with node:crypto and writes it in solana-keygen
 * format. The file is created under umask 077 with mode 0600 as a temp file
 * in the same directory, then hard-linked into place, which fails if the
 * target exists (never overwritten, never half-written). Missing parent
 * directories are created with mode 0700. Returns only the base58 public key.
 */
export function writeNewKeypairFile(target: string): { publicKey: string } {
  const absolute = path.resolve(target);
  assertNotTrackable(absolute);
  if (fs.lstatSync(absolute, { throwIfNoEntry: false }) !== undefined) {
    throw new KeyFileError("the --out file already exists; keygen never overwrites a key.");
  }
  const previousUmask = process.umask(0o077);
  let secret = new Uint8Array(0);
  let text: Buffer = Buffer.alloc(0);
  try {
    const dir = path.dirname(absolute);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
    const spki = publicKey.export({ format: "der", type: "spki" });
    if (pkcs8.length !== 48 || !pkcs8.subarray(0, 16).equals(PKCS8_ED25519_PREFIX)) {
      pkcs8.fill(0);
      throw new KeyFileError("node:crypto returned an unexpected Ed25519 key encoding.");
    }
    secret = new Uint8Array(64);
    secret.set(pkcs8.subarray(16, 48), 0);
    secret.set(spki.subarray(spki.length - 32), 32);
    pkcs8.fill(0);
    if (!publicKeyFromSeed(secret.subarray(0, 32)).equals(Buffer.from(secret.subarray(32)))) {
      throw new KeyFileError("the generated key failed its own public-key check.");
    }
    text = keypairJsonBytes(secret);
    const temp = path.join(dir, `.keygen-${randomBytes(8).toString("hex")}.tmp`);
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      fs.writeSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.chmodSync(temp, 0o600);
      fs.linkSync(temp, absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new KeyFileError("the --out file already exists; keygen never overwrites a key.");
      }
      throw new KeyFileError("the key file could not be written.");
    } finally {
      fs.rmSync(temp, { force: true });
    }
    return { publicKey: encodeBase58(secret.subarray(32)) };
  } finally {
    secret.fill(0);
    text.fill(0);
    process.umask(previousUmask);
  }
}
