/**
 * Strict base58 (Bitcoin alphabet) for Solana addresses and signatures,
 * docs/CONTRACT.md section 5.4. One string has exactly one accepted form:
 * no whitespace, no normalization, no extra leading `1`, and the decoded
 * bytes must re-encode to the identical string.
 *
 * The byte conversion uses the @solana/kit base58 codec; every strictness
 * rule of section 5.4 is enforced here, on top of it.
 */
import { getBase58Decoder, getBase58Encoder } from "@solana/kit";

/** Byte lengths section 5.4 defines: 32 for addresses, 64 for signatures. */
export type StrictBase58Length = 32 | 64;

const BASE58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** Encodable character range per byte length (section 5.4 rule 2). */
const LENGTH_RANGE: Record<StrictBase58Length, readonly [number, number]> = {
  32: [32, 44],
  64: [64, 88],
};

// Kit names these from the codec's point of view: the "encoder" turns a
// string into bytes, the "decoder" turns bytes into a string.
const stringToBytes = getBase58Encoder();
const bytesToString = getBase58Decoder();

function decodeOrNull(value: unknown, n: StrictBase58Length): Uint8Array | null {
  if (typeof value !== "string") return null;
  if (!BASE58_PATTERN.test(value)) return null;
  const range = LENGTH_RANGE[n];
  if (range === undefined) return null;
  if (value.length < range[0] || value.length > range[1]) return null;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(stringToBytes.encode(value));
  } catch {
    return null;
  }
  if (bytes.length !== n) return null;
  if (bytesToString.decode(bytes) !== value) return null;
  return bytes;
}

/**
 * `isStrictBase58(s, n)` of section 5.4: true only if `s` is a string of
 * alphabet characters, its length is in the encodable range for `n` bytes,
 * it decodes to exactly `n` bytes, and those bytes re-encode to `s`.
 */
export function isStrictBase58(value: unknown, n: StrictBase58Length): boolean {
  return decodeOrNull(value, n) !== null;
}

/** Decodes a strict base58 value to exactly `n` bytes, or throws. */
export function decodeStrictBase58(value: unknown, n: StrictBase58Length): Uint8Array {
  const bytes = decodeOrNull(value, n);
  if (bytes === null) {
    throw new TypeError(`Expected a strict base58 value of ${n} bytes.`);
  }
  return bytes;
}

/** Encodes bytes as base58 (the canonical form `isStrictBase58` accepts). */
export function encodeBase58(bytes: Uint8Array): string {
  return bytesToString.decode(bytes);
}
