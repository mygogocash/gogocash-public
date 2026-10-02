/**
 * The `PayoutClaimed` event, docs/CONTRACT.md section 3.4: one
 * `Program data: <base64>` log line per claim, 184 bytes (8-byte
 * discriminator + Borsh fields).
 *
 * The event is informational (Explorer, demo, telemetry). Logs can be
 * truncated, so settlement never depends on it: the finalized receipt
 * account is the only proof of payment (section 3.8).
 */
import type { Address } from "@solana/kit";
import { isStrictBase58 } from "./base58.ts";
import { decodeStrictBase64 } from "./base64.ts";
import {
  getPayoutClaimedEventDecoder,
  PAYOUT_CLAIMED_EVENT_DISCRIMINATOR,
} from "./generated/events/payoutClaimed.ts";
import { payoutIdToHex } from "./program.ts";

/** Discriminator (8) + vault, receipt, payout_id, recipient (4 x 32) + six 8-byte integers. */
export const PAYOUT_CLAIMED_EVENT_SIZE = 184;

export type PayoutClaimed = {
  readonly vault: Address;
  readonly receipt: Address;
  readonly payoutId: Uint8Array;
  /** `payoutId` as 64 lowercase hex characters. */
  readonly payoutIdHex: string;
  readonly recipient: Address;
  readonly amount: bigint;
  readonly claimedAt: bigint;
  /** `current_day` after the claim. */
  readonly day: bigint;
  /** After the claim. */
  readonly claimedToday: bigint;
  /** After the claim. */
  readonly claimCount: bigint;
  /** After the claim. */
  readonly totalClaimed: bigint;
};

export class EventDecodeError extends Error {
  override name = "EventDecodeError";
}

function startsWithDiscriminator(data: Uint8Array): boolean {
  if (data.length < 8) return false;
  for (let i = 0; i < 8; i += 1) {
    if (data[i] !== PAYOUT_CLAIMED_EVENT_DISCRIMINATOR[i]) return false;
  }
  return true;
}

/** True if `data` starts with the `event:PayoutClaimed` discriminator. */
export function isPayoutClaimedEvent(data: Uint8Array): boolean {
  return data instanceof Uint8Array && startsWithDiscriminator(data);
}

/**
 * Decodes one `PayoutClaimed` payload: the raw bytes, or the base64 text of
 * a `Program data:` line. Requires strict base64, exactly 184 bytes and the
 * discriminator.
 */
export function decodePayoutClaimedEvent(data: Uint8Array | string): PayoutClaimed {
  const bytes = typeof data === "string" ? decodeStrictBase64(data) : data;
  if (!(bytes instanceof Uint8Array)) {
    throw new EventDecodeError("PayoutClaimed payload is not strict base64.");
  }
  if (bytes.length !== PAYOUT_CLAIMED_EVENT_SIZE) {
    throw new EventDecodeError(
      `PayoutClaimed must be ${PAYOUT_CLAIMED_EVENT_SIZE} bytes, got ${bytes.length}.`,
    );
  }
  if (!startsWithDiscriminator(bytes)) {
    throw new EventDecodeError("PayoutClaimed discriminator mismatch.");
  }
  const event = getPayoutClaimedEventDecoder().decode(bytes);
  const payoutId = Uint8Array.from(event.payoutId);
  return {
    vault: event.vault,
    receipt: event.receipt,
    payoutId,
    payoutIdHex: payoutIdToHex(payoutId),
    recipient: event.recipient,
    amount: event.amount,
    claimedAt: event.claimedAt,
    day: event.day,
    claimedToday: event.claimedToday,
    claimCount: event.claimCount,
    totalClaimed: event.totalClaimed,
  };
}

const INVOKE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[\d+\]$/;
const EXIT = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (?:success|failed: .*)$/;
const DATA_PREFIX = "Program data: ";

/**
 * Finds the `PayoutClaimed` events in a transaction's log messages. Only
 * `Program data:` lines written while `programAddress` is the executing
 * program count, so another program (or a CPI target) printing the same
 * bytes is ignored. Lines with another discriminator are skipped; a line
 * from the program that carries the `PayoutClaimed` discriminator but does
 * not decode throws `EventDecodeError`.
 */
export function findPayoutClaimedEvents(
  logs: readonly string[],
  programAddress: Address,
): PayoutClaimed[] {
  if (!isStrictBase58(programAddress, 32)) {
    throw new TypeError("programAddress must be a strict base58 address.");
  }
  const stack: string[] = [];
  const events: PayoutClaimed[] = [];
  for (const line of logs) {
    const invoke = INVOKE.exec(line);
    if (invoke !== null) {
      stack.push(invoke[1] ?? "");
      continue;
    }
    if (EXIT.test(line)) {
      stack.pop();
      continue;
    }
    if (!line.startsWith(DATA_PREFIX) || stack[stack.length - 1] !== programAddress) continue;
    const chunks = line.slice(DATA_PREFIX.length).split(" ");
    // `emit!` logs exactly one data slice.
    if (chunks.length !== 1) continue;
    const bytes = decodeStrictBase64(chunks[0]);
    if (bytes === null || !startsWithDiscriminator(bytes)) continue;
    events.push(decodePayoutClaimedEvent(bytes));
  }
  return events;
}
