/**
 * Demo step 2: a local stand-in wallet signs the section 4 consent bytes and
 * the shared verifier (src/siws.ts, section 4.7) checks them. The member's
 * real wallet signs through MWA `signMessages`; here a throwaway key made in
 * memory for the run plays that part, so the signing function is injected.
 *
 * Also proves the negative of section 4.6: the same signature over the
 * message re-rendered with amount + 1 is `signature_invalid`.
 */
import { createHash } from "node:crypto";
import { encodeBase58 } from "../base58.ts";
import { renderConsentMessage, renderConsentMessageText, verifyConsentSignature, type ConsentMessageInput, type ConsentVerifyResult } from "../siws.ts";

export type DemoIds = {
  /** 32 random bytes (section 5.1); never all zero. */
  readonly payoutId: Uint8Array;
  readonly payoutIdHex: string;
  /** `Nonce`: 32 lowercase hex (section 5.3). */
  readonly nonce: string;
  /** `Request ID`: 24 lowercase hex (section 5.2). */
  readonly withdrawalId: string;
};

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** A fresh payout id from `randomBytes` (32 bytes). Refuses an all-zero or short value (onchain C6, 6008). */
export function newPayoutId(randomBytes: (length: number) => Uint8Array): { payoutId: Uint8Array; payoutIdHex: string } {
  const payoutId = Uint8Array.from(randomBytes(32));
  if (payoutId.length !== 32) throw new TypeError("randomBytes(32) must return 32 bytes.");
  if (payoutId.every((byte) => byte === 0)) throw new TypeError("a payout id must not be all zero bytes (6008).");
  return { payoutId, payoutIdHex: hex(payoutId) };
}

/** The payout id, nonce and request id of one demo withdrawal. */
export function newDemoIds(randomBytes: (length: number) => Uint8Array): DemoIds {
  const { payoutId, payoutIdHex } = newPayoutId(randomBytes);
  const nonce = Uint8Array.from(randomBytes(16));
  const withdrawalId = Uint8Array.from(randomBytes(12));
  if (nonce.length !== 16 || withdrawalId.length !== 12) throw new TypeError("randomBytes returned the wrong length.");
  return { payoutId, payoutIdHex, nonce: hex(nonce), withdrawalId: hex(withdrawalId) };
}

/** The section 4.8 render inputs of the demo withdrawal (devnet row of section 4.4). */
export function demoConsentInput(input: {
  readonly programId: string;
  readonly recipient: string;
  readonly amountAtomic: bigint;
  readonly deductedMinor: bigint;
  readonly feeMinor: bigint;
  readonly ids: DemoIds;
  readonly issuedAtMs: number;
}): ConsentMessageInput {
  return {
    cluster: "devnet",
    recipient: input.recipient,
    amountAtomic: input.amountAtomic,
    deductedMinor: input.deductedMinor,
    feeMinor: input.feeMinor,
    nonce: input.ids.nonce,
    issuedAtMs: input.issuedAtMs,
    withdrawalId: input.ids.withdrawalId,
    payoutIdHex: input.ids.payoutIdHex,
    programId: input.programId,
  };
}

export type DemoConsentResult = {
  readonly text: string;
  readonly byteLength: number;
  readonly sha256Hex: string;
  readonly signatureBase58: string;
  /** Strict verify of the signature over the exact bytes: must be `ok`. */
  readonly verify: ConsentVerifyResult;
  /** The same signature over the message with amount + 1: must be `signature_invalid`. */
  readonly tamperedVerify: ConsentVerifyResult;
  readonly pass: boolean;
};

/**
 * Renders the consent bytes, has the stand-in wallet sign them, and verifies
 * the signature with `verifyConsentSignature` against the recipient's 32-byte
 * public key (the recipient is the signer, section 4.2 line 2).
 */
export async function signAndVerifyConsent(input: {
  readonly consent: ConsentMessageInput;
  readonly signerPublicKey: Uint8Array;
  readonly sign: (message: Uint8Array) => Promise<Uint8Array>;
}): Promise<DemoConsentResult> {
  const text = renderConsentMessageText(input.consent);
  const bytes = renderConsentMessage(input.consent);
  const signature = Uint8Array.from(await input.sign(bytes));
  const verify = verifyConsentSignature(input.signerPublicKey, bytes, signature);
  const tampered = renderConsentMessage({ ...input.consent, amountAtomic: input.consent.amountAtomic + 1n });
  const tamperedVerify = verifyConsentSignature(input.signerPublicKey, tampered, signature);
  return {
    text,
    byteLength: bytes.length,
    sha256Hex: createHash("sha256").update(bytes).digest("hex"),
    signatureBase58: encodeBase58(signature),
    verify,
    tamperedVerify,
    pass: verify === "ok" && tamperedVerify === "signature_invalid",
  };
}
