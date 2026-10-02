/**
 * The one `node:crypto` Ed25519 verify call of the SDK (docs/CONTRACT.md
 * section 4.7, step 6), shared by the consent verifier (siws.ts) and the
 * claim wire decoder (wire.ts) so the two cannot drift.
 *
 * This is the raw step only. It does not apply the section 4.7 strictness
 * checks (small-order A, non-canonical A or R, S >= L); consent signatures
 * must go through `verifyConsentSignature`, which runs them first.
 */
import { createPublicKey, verify as cryptoVerify } from "node:crypto";

/** DER SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 key. */
const SPKI_PREFIX = Uint8Array.from(Buffer.from("302a300506032b6570032100", "hex"));

/**
 * `crypto.verify(null, message, spki(publicKey), signature)`. Returns `false`
 * for a key that is not 32 bytes, a signature that is not 64 bytes, a failed
 * verification, or any throw.
 */
export function verifyEd25519Raw(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const spki = new Uint8Array(SPKI_PREFIX.length + 32);
    spki.set(SPKI_PREFIX, 0);
    spki.set(publicKey, SPKI_PREFIX.length);
    const key = createPublicKey({ key: Buffer.from(spki), format: "der", type: "spki" });
    return cryptoVerify(null, message, key, signature) === true;
  } catch {
    return false;
  }
}
