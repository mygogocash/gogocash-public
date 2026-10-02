/**
 * Wire decoding of a persisted claim attempt, docs/CONTRACT.md section 9.5
 * (review SEC-13): the release assessor takes every value from the signed
 * wire bytes (`wire_base64`), never from side fields.
 *
 * `decodeClaimWire` decodes the wire and refuses anything that is not a
 * fully signed v0 claim transaction with a recent-blockhash lifetime: every
 * signer slot must be filled and every signature must verify against its
 * signer over the message bytes (section 9.1 step 6 persists only signed
 * wires, so an empty or bad slot means a sender bug or an altered row).
 * `checkClaimWireForRelease` adds the section 9.5 equality preconditions:
 *
 *   - the first signature equals `attempt.signature`;
 *   - the recent blockhash equals `attempt.blockhash`;
 *   - the lifetime is a blockhash, not a durable nonce (the first instruction
 *     is not `AdvanceNonceAccount`);
 *   - the `claim` instruction's `payout_id` and `amount` equal the row;
 *   - `expires_at` is read from the `claim` data (returned for P3);
 *   - defense in depth beyond section 9.5: the `claim` vault equals the row's
 *     `solana_vault`, so the receipt P5 reads (derived from that vault) is
 *     the one this wire would create. The program binds the receipt address
 *     to `["receipt", vault, payout_id]` (2006 otherwise), so vault plus
 *     payout id pin it.
 *
 * Any refusal maps to `503 SOLANA_RELEASE_NOT_PROVABLE` with
 * `wire_decode_mismatch` (section 9.5). Because the first signature verifies
 * against the fee payer over the message bytes, the decoded values are the
 * ones that signature (the transaction id checked in P4) commits to.
 */
import {
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Address,
} from "@solana/kit";
import { decodeStrictBase58, encodeBase58, isStrictBase58 } from "./base58.ts";
import { decodeStrictBase64 } from "./base64.ts";
import { SYSTEM_PROGRAM_ADDRESS } from "./clusters.ts";
import { verifyEd25519Raw } from "./ed25519.ts";
import {
  CLAIM_DISCRIMINATOR,
  getClaimInstructionDataDecoder,
} from "./generated/instructions/claim.ts";
import { payoutIdFromHex, payoutIdToHex } from "./program.ts";

/** Largest serialized transaction the network accepts (packet data size). */
export const MAX_WIRE_TRANSACTION_BYTES = 1232;
/** `claim` data: 8-byte discriminator + payout_id (32) + amount (8) + expires_at (8). */
export const CLAIM_INSTRUCTION_DATA_LENGTH = 56;
/** `claim` takes exactly 10 accounts (section 3.3.2). */
export const CLAIM_INSTRUCTION_ACCOUNT_COUNT = 10;

/** System program `AdvanceNonceAccount` instruction index (u32 little-endian). */
const ADVANCE_NONCE_ACCOUNT_INDEX = 4;

export type ClaimWireRefusal =
  /** Not strict base64, empty, too large, or not a decodable transaction. */
  | "malformed"
  /** Not a v0 message. */
  | "unsupported_version"
  /** The v0 message uses an address lookup table. */
  | "address_lookup_tables"
  /** A signer's signature slot is empty (all-zero), the fee payer's included. */
  | "unsigned"
  /** A signature does not verify against its signer over the message bytes. */
  | "signature_invalid"
  /** The first instruction is `AdvanceNonceAccount` (durable nonce lifetime). */
  | "durable_nonce"
  /** No instruction targets the expected program. */
  | "claim_not_found"
  /** More than one instruction targets the expected program. */
  | "claim_ambiguous"
  /** The instruction for the expected program is not a well-formed `claim`. */
  | "claim_malformed"
  | "signature_mismatch"
  | "blockhash_mismatch"
  | "payout_id_mismatch"
  | "amount_mismatch"
  /** The `claim` vault (account 1 of section 3.3.2) is not the row's `solana_vault`. */
  | "vault_mismatch";

/** The values section 9.5 takes from the wire. */
export type ClaimWireTuple = {
  /** First signature (the transaction id), base58. */
  readonly signature: string;
  /** Recent blockhash (the lifetime token), base58. */
  readonly blockhash: string;
  readonly feePayer: Address;
  readonly claimAuthority: Address;
  /** The `claim` vault (account 1 of section 3.3.2). */
  readonly vault: Address;
  readonly recipient: Address;
  readonly payoutId: Uint8Array;
  readonly payoutIdHex: string;
  readonly amount: bigint;
  readonly expiresAt: bigint;
};

export type ClaimWireResult =
  | { readonly ok: true; readonly tuple: ClaimWireTuple }
  | { readonly ok: false; readonly refusal: ClaimWireRefusal; readonly detail: string };

function refuse(refusal: ClaimWireRefusal, detail: string): ClaimWireResult {
  return { ok: false, refusal, detail };
}

function wireBytes(wire: unknown): Uint8Array | null {
  let bytes: Uint8Array | null;
  if (typeof wire === "string") bytes = decodeStrictBase64(wire);
  else if (wire instanceof Uint8Array) bytes = Uint8Array.from(wire);
  else return null;
  if (bytes === null || bytes.length === 0 || bytes.length > MAX_WIRE_TRANSACTION_BYTES) return null;
  return bytes;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

type DecodedWire =
  | {
      readonly transaction: ReturnType<ReturnType<typeof getTransactionDecoder>["decode"]>;
      readonly message: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>;
    }
  | { readonly error: string };

function decodeTransactionBytes(bytes: Uint8Array): DecodedWire {
  try {
    const [transaction, transactionEnd] = getTransactionDecoder().read(bytes, 0);
    if (transactionEnd !== bytes.length) return { error: "trailing bytes after the transaction" };
    const messageBytes = Uint8Array.from(transaction.messageBytes);
    const [message, messageEnd] = getCompiledTransactionMessageDecoder().read(messageBytes, 0);
    if (messageEnd !== messageBytes.length) return { error: "trailing bytes after the message" };
    return { transaction, message };
  } catch {
    return { error: "the bytes do not decode as a transaction" };
  }
}

/**
 * Decodes a signed claim wire transaction (base64 string or raw bytes) and
 * returns the section 9.5 tuple, or a refusal. `programAddress` is the
 * program the `claim` must target (the row's `solana_program_id`).
 */
export function decodeClaimWire(wire: string | Uint8Array, programAddress: Address): ClaimWireResult {
  if (!isStrictBase58(programAddress, 32)) {
    throw new TypeError("programAddress must be a strict base58 address.");
  }
  const bytes = wireBytes(wire);
  if (bytes === null) return refuse("malformed", "not strict base64 or raw bytes of 1 to 1232 bytes");

  const decodedWire = decodeTransactionBytes(bytes);
  if ("error" in decodedWire) return refuse("malformed", decodedWire.error);
  const { transaction, message } = decodedWire;

  if (message.version !== 0) return refuse("unsupported_version", `message version ${String(message.version)}`);
  if ((message.addressTableLookups?.length ?? 0) > 0) {
    return refuse("address_lookup_tables", "the message loads accounts from a lookup table");
  }
  const staticAccounts = message.staticAccounts;
  const signerCount = message.header.numSignerAccounts;
  const signatureEntries = Object.entries(transaction.signatures);
  if (
    staticAccounts.length === 0 ||
    signerCount < 1 ||
    signerCount > staticAccounts.length ||
    signatureEntries.length !== signerCount
  ) {
    return refuse("malformed", "signature count does not match the message header");
  }
  for (const instruction of message.instructions) {
    const indices = [instruction.programAddressIndex, ...(instruction.accountIndices ?? [])];
    if (indices.some((index) => index >= staticAccounts.length)) {
      return refuse("malformed", "an instruction references an account index out of range");
    }
  }

  // Every signer slot, fee payer (index 0) first, so an unsigned wire reports
  // the fee payer and a partially signed one reports the empty slot.
  const messageBytes = Uint8Array.from(transaction.messageBytes);
  for (let index = 0; index < signerCount; index += 1) {
    const signer = staticAccounts[index] as Address;
    const slot = transaction.signatures[signer];
    const who = index === 0 ? "the fee payer" : `signer ${String(index)}`;
    if (slot === null || slot === undefined) {
      return refuse("unsigned", `the signature slot of ${who} is empty`);
    }
    if (!verifyEd25519Raw(decodeStrictBase58(signer, 32), messageBytes, Uint8Array.from(slot))) {
      return refuse("signature_invalid", `the signature of ${who} does not verify`);
    }
  }
  const feePayer = staticAccounts[0] as Address;
  const signatureBytes = Uint8Array.from(transaction.signatures[feePayer] ?? []);

  const first = message.instructions[0];
  if (first !== undefined && staticAccounts[first.programAddressIndex] === SYSTEM_PROGRAM_ADDRESS) {
    const data = first.data ?? new Uint8Array();
    const index = data.length >= 4 ? Buffer.from(data.slice(0, 4)).readUInt32LE(0) : null;
    if (index === ADVANCE_NONCE_ACCOUNT_INDEX) {
      return refuse("durable_nonce", "the first instruction is AdvanceNonceAccount");
    }
  }

  const claims = message.instructions.filter(
    (instruction) => staticAccounts[instruction.programAddressIndex] === programAddress,
  );
  if (claims.length === 0) return refuse("claim_not_found", "no instruction targets the program");
  if (claims.length > 1) return refuse("claim_ambiguous", "more than one instruction targets the program");
  const claim = claims[0];
  const data = Uint8Array.from(claim?.data ?? []);
  const accountIndices = claim?.accountIndices ?? [];
  if (
    data.length !== CLAIM_INSTRUCTION_DATA_LENGTH ||
    !bytesEqual(data.subarray(0, 8), Uint8Array.from(CLAIM_DISCRIMINATOR)) ||
    accountIndices.length !== CLAIM_INSTRUCTION_ACCOUNT_COUNT
  ) {
    return refuse("claim_malformed", "the program instruction is not a 56-byte, 10-account claim");
  }
  const decoded = getClaimInstructionDataDecoder().decode(data);
  const payoutId = Uint8Array.from(decoded.payoutId);
  const account = (position: number): Address => staticAccounts[accountIndices[position] ?? -1] as Address;

  return {
    ok: true,
    tuple: {
      signature: encodeBase58(signatureBytes),
      blockhash: message.lifetimeToken,
      feePayer,
      claimAuthority: account(6),
      vault: account(0),
      recipient: account(4),
      payoutId,
      payoutIdHex: payoutIdToHex(payoutId),
      amount: decoded.amount,
      expiresAt: decoded.expiresAt,
    },
  };
}

/** What the attempt record and the row say the wire must contain (section 9.5). */
export type ClaimWireExpectation = {
  /** The row's `solana_program_id`. */
  readonly programAddress: Address;
  /** `attempt.signature`, base58. */
  readonly signature: string;
  /** `attempt.blockhash`, base58. */
  readonly blockhash: string;
  /** The row's payout id, 64 lowercase hex characters. */
  readonly payoutIdHex: string;
  /** The row's `solana_amount_atomic`. */
  readonly amount: bigint;
  /** The row's `solana_vault` (the vault P5 derives the receipt from). */
  readonly vault: Address;
};

/**
 * `decodeClaimWire` plus the section 9.5 equality preconditions, checked in
 * the contract's order: first signature, blockhash, payout id, amount; then
 * the vault (defense in depth). On success the tuple carries `expiresAt` for
 * P3.
 *
 * Throws `TypeError` when `expected` itself is not well formed (a program
 * address or vault that is not a strict base58 address, a payout id that is
 * not 64 lowercase hex characters, an amount that is not a bigint). That is a
 * caller bug or a corrupt row, not a wire mismatch; nothing is released and
 * the caller keeps the row's state unchanged either way.
 */
export function checkClaimWireForRelease(
  wire: string | Uint8Array,
  expected: ClaimWireExpectation,
): ClaimWireResult {
  const expectedPayoutId = payoutIdFromHex(expected.payoutIdHex);
  if (typeof expected.amount !== "bigint") throw new TypeError("expected.amount must be a bigint.");
  if (!isStrictBase58(expected.vault, 32)) throw new TypeError("expected.vault must be a strict base58 address.");
  const result = decodeClaimWire(wire, expected.programAddress);
  if (!result.ok) return result;
  const { tuple } = result;
  if (tuple.signature !== expected.signature) {
    return refuse("signature_mismatch", "the first signature is not attempt.signature");
  }
  if (tuple.blockhash !== expected.blockhash) {
    return refuse("blockhash_mismatch", "the recent blockhash is not attempt.blockhash");
  }
  if (!bytesEqual(tuple.payoutId, expectedPayoutId)) {
    return refuse("payout_id_mismatch", "the claim payout_id is not the row's");
  }
  if (tuple.amount !== expected.amount) {
    return refuse("amount_mismatch", "the claim amount is not the row's");
  }
  if (tuple.vault !== expected.vault) {
    return refuse("vault_mismatch", "the claim vault is not the row's solana_vault");
  }
  return result;
}
