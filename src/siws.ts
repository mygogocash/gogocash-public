/**
 * The SIWS consent message, docs/CONTRACT.md section 4: the exact bytes a
 * member signs through MWA `signMessages`, and the one shared signature
 * verifier (section 4.7).
 *
 * The renderer is deterministic. The API stores the bytes it renders and the
 * sender re-renders them from the row's stored inputs; both sides must get
 * the same bytes, so nothing here depends on locale, clock or environment.
 */
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { formatMinorFixed2, formatUsdcAtomicFixed6, U64_MAX } from "./amount.ts";
import { isStrictBase58 } from "./base58.ts";
import { isCluster, WALLET_CHAIN_ID, type Cluster } from "./clusters.ts";

/** Hard cap on the message length, checked by the renderer and the verifier (section 4.1). */
export const CONSENT_MESSAGE_MAX_BYTES = 1024;

/** Number of lines in every consent message (section 4.1). */
export const CONSENT_MESSAGE_LINE_COUNT = 16;

/** Per-cluster SIWS values (section 4.4). Local and test environments use the devnet row. */
export const SIWS_ENVIRONMENT: Readonly<
  Record<Cluster, { readonly domain: string; readonly uri: string; readonly ttlSeconds: number }>
> = {
  devnet: { domain: "app-staging.gogocash.co", uri: "https://app-staging.gogocash.co", ttlSeconds: 300 },
  mainnet: { domain: "app.gogocash.co", uri: "https://app.gogocash.co", ttlSeconds: 180 },
};

/** `<cluster_label>` of the statement (section 4.3). */
export const CLUSTER_LABEL: Readonly<Record<Cluster, string>> = {
  devnet: "devnet (test network, no real value)",
  mainnet: "mainnet",
};

/** Every render input of section 4.8, as the challenge record stores them. */
export type ConsentMessageInput = {
  cluster: Cluster;
  /** Recipient = signer, strict base58 (32 bytes). */
  recipient: string;
  /** USDC atomic units, 1 to 2^64 - 1 (line 15 and `<U>`). */
  amountAtomic: bigint;
  /** THB deducted including the fee, in satang (`<D>`). */
  deductedMinor: bigint;
  /** Fee in satang, may be 0 (`<F>`). */
  feeMinor: bigint;
  /** 32 lowercase hex. */
  nonce: string;
  /** Issued At, integer epoch milliseconds. */
  issuedAtMs: number;
  /** Expiration Time, integer epoch milliseconds; must equal `issuedAtMs + TTL`. Derived if omitted. */
  expirationMs?: number;
  /** `Request ID`: 24 lowercase hex. */
  withdrawalId: string;
  /** 64 lowercase hex. */
  payoutIdHex: string;
  /** `release/manifest.json.programIds[cluster]`, strict base58 (32 bytes). */
  programId: string;
  /** Optional stored copies; if given they must equal the section 4.4 row for `cluster`. */
  domain?: string;
  uri?: string;
};

export class ConsentMessageError extends Error {
  override name = "ConsentMessageError";
}

const NONCE = /^[0-9a-f]{32}$/;
const WITHDRAWAL_ID = /^[0-9a-f]{24}$/;
const PAYOUT_ID = /^[0-9a-f]{64}$/;
const ISO_MS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function fail(message: string): never {
  throw new ConsentMessageError(message);
}

function isoTimestamp(ms: number, field: string): string {
  if (!Number.isSafeInteger(ms) || ms < 0) fail(`${field} must be a non-negative integer of epoch milliseconds.`);
  const text = new Date(ms).toISOString();
  if (!ISO_MS_UTC.test(text)) fail(`${field} does not render as YYYY-MM-DDTHH:MM:SS.sssZ.`);
  return text;
}

function checkMinor(value: bigint, field: string): void {
  if (typeof value !== "bigint" || value < 0n || value > U64_MAX) {
    fail(`${field} must be a bigint from 0 to 2^64 - 1.`);
  }
}

/** Asserts the section 4.1 encoding rules on rendered text. */
function assertEncodingRules(text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c !== 0x0a && (c < 0x20 || c > 0x7e)) fail("message must be printable ASCII plus LF only.");
  }
  const lines = text.split("\n");
  if (lines.length !== CONSENT_MESSAGE_LINE_COUNT) fail("message must have exactly 16 lines.");
  if (lines[2] !== "" || lines[4] !== "") fail("lines 3 and 5 must be empty.");
  for (const line of lines) {
    if (line.startsWith(" ") || line.endsWith(" ") || line.includes("  ")) {
      fail("no line may start or end with a space or contain a double space.");
    }
  }
  if (text.length > CONSENT_MESSAGE_MAX_BYTES) fail("message exceeds 1024 bytes.");
}

/**
 * Renders the consent message text (sections 4.1 to 4.5): 16 LF-separated
 * ASCII lines, no trailing newline. Throws `ConsentMessageError` on any input
 * outside the contract.
 */
export function renderConsentMessageText(input: ConsentMessageInput): string {
  const { cluster } = input;
  if (!isCluster(cluster)) fail("cluster must be devnet or mainnet.");
  const env = SIWS_ENVIRONMENT[cluster];
  if (input.domain !== undefined && input.domain !== env.domain) fail("domain does not match the cluster's SIWS domain.");
  if (input.uri !== undefined && input.uri !== env.uri) fail("uri does not match the cluster's SIWS URI.");
  if (!isStrictBase58(input.recipient, 32)) fail("recipient must be a strict base58 address.");
  if (!isStrictBase58(input.programId, 32)) fail("programId must be a strict base58 address.");
  if (typeof input.amountAtomic !== "bigint" || input.amountAtomic < 1n || input.amountAtomic > U64_MAX) {
    fail("amountAtomic must be a bigint from 1 to 2^64 - 1.");
  }
  checkMinor(input.deductedMinor, "deductedMinor");
  checkMinor(input.feeMinor, "feeMinor");
  if (input.feeMinor > input.deductedMinor) fail("feeMinor must not exceed deductedMinor (D includes the fee).");
  if (typeof input.nonce !== "string" || !NONCE.test(input.nonce)) fail("nonce must be 32 lowercase hex characters.");
  if (typeof input.withdrawalId !== "string" || !WITHDRAWAL_ID.test(input.withdrawalId)) {
    fail("withdrawalId must be 24 lowercase hex characters.");
  }
  if (typeof input.payoutIdHex !== "string" || !PAYOUT_ID.test(input.payoutIdHex)) {
    fail("payoutIdHex must be 64 lowercase hex characters.");
  }
  const issuedAt = isoTimestamp(input.issuedAtMs, "issuedAtMs");
  const expectedExpirationMs = input.issuedAtMs + env.ttlSeconds * 1000;
  const expirationMs = input.expirationMs ?? expectedExpirationMs;
  if (expirationMs !== expectedExpirationMs) {
    fail(`expirationMs must equal issuedAtMs + ${env.ttlSeconds} s exactly.`);
  }
  const expirationTime = isoTimestamp(expirationMs, "expirationMs");
  const chainId = WALLET_CHAIN_ID[cluster];
  const statement =
    `Withdraw ${formatUsdcAtomicFixed6(input.amountAtomic)} USDC to this wallet on Solana ` +
    `${CLUSTER_LABEL[cluster]}. GoGoCash deducts THB ${formatMinorFixed2(input.deductedMinor)} ` +
    `from your cashback balance, including a THB ${formatMinorFixed2(input.feeMinor)} fee. ` +
    `Sign only if you started this withdrawal in the GoGoCash app.`;
  const text = [
    `${env.domain} wants you to sign in with your Solana account:`,
    input.recipient,
    "",
    statement,
    "",
    `URI: ${env.uri}`,
    "Version: 1",
    `Chain ID: ${chainId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expirationTime}`,
    `Request ID: ${input.withdrawalId}`,
    "Resources:",
    `- gogocash:payout:${input.payoutIdHex}`,
    `- gogocash:amount:${input.amountAtomic.toString(10)}`,
    `- ${chainId}:${input.programId}`,
  ].join("\n");
  assertEncodingRules(text);
  return text;
}

/** The exact consent bytes to sign (ASCII, so one byte per character). */
export function renderConsentMessage(input: ConsentMessageInput): Uint8Array {
  return new TextEncoder().encode(renderConsentMessageText(input));
}

// ---------------------------------------------------------------------------
// Signature verification (section 4.7)
// ---------------------------------------------------------------------------

export type ConsentVerifyResult =
  | "ok"
  | "bad_length"
  | "A_small_order"
  | "A_non_canonical"
  | "R_non_canonical"
  | "S_not_reduced"
  | "signature_invalid";

/** The 8 small-order Ed25519 point encodings section 4.7 rejects as public keys. */
export const SMALL_ORDER_PUBLIC_KEYS_HEX: readonly string[] = [
  "0100000000000000000000000000000000000000000000000000000000000000",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0000000000000000000000000000000000000000000000000000000000000080",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
];

/** p = 2^255 - 19. */
const FIELD_P = (1n << 255n) - 19n;
/** L = 2^252 + 27742317777372353535851937790883648493. */
const GROUP_L = (1n << 252n) + 27742317777372353535851937790883648493n;
/** DER SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 key. */
const SPKI_PREFIX = Uint8Array.from(Buffer.from("302a300506032b6570032100", "hex"));

function isUint8Array(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function readLittleEndian(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    value = (value << 8n) | BigInt(bytes[i] ?? 0);
  }
  return value;
}

/** Clears bit 255 and reports whether the remaining y is `>= p`. */
function isNonCanonicalPointEncoding(bytes32: Uint8Array): boolean {
  const y = Uint8Array.from(bytes32);
  y[31] = (y[31] ?? 0) & 0x7f;
  return readLittleEndian(y) >= FIELD_P;
}

/**
 * `verifyConsentSignature(publicKey32, messageBytes, signature64)` of section
 * 4.7. The steps run in order and stop at the first failure:
 * lengths (also the 1024-byte message cap), small-order A, non-canonical A,
 * non-canonical R, S >= L, then `node:crypto` Ed25519 verify. Byte
 * comparisons plus one `node:crypto` call; no curve arithmetic and no
 * `@noble/curves`.
 */
export function verifyConsentSignature(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): ConsentVerifyResult {
  if (!isUint8Array(publicKey) || !isUint8Array(message) || !isUint8Array(signature)) {
    return "bad_length";
  }
  if (publicKey.length !== 32 || signature.length !== 64 || message.length > CONSENT_MESSAGE_MAX_BYTES) {
    return "bad_length";
  }
  const publicKeyHex = Buffer.from(publicKey).toString("hex");
  if (SMALL_ORDER_PUBLIC_KEYS_HEX.includes(publicKeyHex)) return "A_small_order";
  if (isNonCanonicalPointEncoding(publicKey)) return "A_non_canonical";
  if (isNonCanonicalPointEncoding(signature.subarray(0, 32))) return "R_non_canonical";
  if (readLittleEndian(signature.subarray(32, 64)) >= GROUP_L) return "S_not_reduced";
  try {
    const spki = new Uint8Array(SPKI_PREFIX.length + 32);
    spki.set(SPKI_PREFIX, 0);
    spki.set(publicKey, SPKI_PREFIX.length);
    const key = createPublicKey({ key: Buffer.from(spki), format: "der", type: "spki" });
    return cryptoVerify(null, message, key, signature) === true ? "ok" : "signature_invalid";
  } catch {
    return "signature_invalid";
  }
}
