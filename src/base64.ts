/**
 * Strict standard base64 (RFC 4648 section 4, padded), used for stored wire
 * transactions (`wire_base64`, docs/CONTRACT.md section 9.1 step 6) and for
 * `Program data:` event payloads (section 3.4).
 *
 * `Buffer.from(value, "base64")` silently skips characters it doesn't know
 * and accepts missing padding, so two different strings can decode to the
 * same bytes. Here one byte string has exactly one accepted form: the value
 * must use the standard alphabet, carry canonical padding, and re-encode to
 * itself.
 */

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Decodes strict padded base64, or returns `null` for any other input. */
export function decodeStrictBase64(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || !BASE64_PATTERN.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  // Rejects non-zero trailing bits in the last group (a second spelling).
  if (bytes.toString("base64") !== value) return null;
  return Uint8Array.from(bytes);
}
