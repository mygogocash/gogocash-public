import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { TOKEN_PROGRAM_ADDRESS, V0_PLACEHOLDER_PROGRAM_ID } from "../src/clusters.ts";
import {
  decodePayoutClaimedEvent,
  EventDecodeError,
  findPayoutClaimedEvents,
  isPayoutClaimedEvent,
  PAYOUT_CLAIMED_EVENT_SIZE,
} from "../src/events.ts";
import { PAYOUT_CLAIMED_EVENT_DISCRIMINATOR } from "../src/generated/events/payoutClaimed.ts";
import { fromHex, hex, PAYOUT_CLAIMED_VECTOR } from "./vectors.ts";

const vectorBytes = Uint8Array.from(Buffer.from(PAYOUT_CLAIMED_VECTOR.base64, "base64"));

const expectedEvent = {
  vault: PAYOUT_CLAIMED_VECTOR.vault,
  receipt: PAYOUT_CLAIMED_VECTOR.receipt,
  payoutId: fromHex(PAYOUT_CLAIMED_VECTOR.payoutIdHex),
  payoutIdHex: PAYOUT_CLAIMED_VECTOR.payoutIdHex,
  recipient: PAYOUT_CLAIMED_VECTOR.recipient,
  amount: PAYOUT_CLAIMED_VECTOR.amount,
  claimedAt: PAYOUT_CLAIMED_VECTOR.claimedAt,
  day: PAYOUT_CLAIMED_VECTOR.day,
  claimedToday: PAYOUT_CLAIMED_VECTOR.claimedToday,
  claimCount: PAYOUT_CLAIMED_VECTOR.claimCount,
  totalClaimed: PAYOUT_CLAIMED_VECTOR.totalClaimed,
};

describe("PayoutClaimed decoder (section 3.4)", () => {
  it("decodes the section 3.4 vector from base64 and from bytes", () => {
    expect(vectorBytes.length).toBe(PAYOUT_CLAIMED_EVENT_SIZE);
    expect(hex(Uint8Array.from(PAYOUT_CLAIMED_EVENT_DISCRIMINATOR))).toBe(PAYOUT_CLAIMED_VECTOR.discriminatorHex);
    expect(hex(vectorBytes.subarray(0, 8))).toBe(PAYOUT_CLAIMED_VECTOR.discriminatorHex);
    expect(decodePayoutClaimedEvent(PAYOUT_CLAIMED_VECTOR.base64)).toEqual(expectedEvent);
    expect(decodePayoutClaimedEvent(vectorBytes)).toEqual(expectedEvent);
    expect(isPayoutClaimedEvent(vectorBytes)).toBe(true);
  });

  it("refuses a wrong length, a wrong discriminator and loose base64", () => {
    expect(() => decodePayoutClaimedEvent(vectorBytes.subarray(0, 183))).toThrow(EventDecodeError);
    expect(() => decodePayoutClaimedEvent(Uint8Array.from([...vectorBytes, 0]))).toThrow(EventDecodeError);
    const other = Uint8Array.from(vectorBytes);
    other[0] = (other[0] ?? 0) ^ 0xff;
    expect(isPayoutClaimedEvent(other)).toBe(false);
    expect(() => decodePayoutClaimedEvent(other)).toThrow(/discriminator/);
    expect(() => decodePayoutClaimedEvent(PAYOUT_CLAIMED_VECTOR.base64.replace(/=+$/, ""))).toThrow(EventDecodeError);
    expect(() => decodePayoutClaimedEvent(` ${PAYOUT_CLAIMED_VECTOR.base64}`)).toThrow(EventDecodeError);
  });
});

describe("findPayoutClaimedEvents", () => {
  const program = V0_PLACEHOLDER_PROGRAM_ID;
  const dataLine = `Program data: ${PAYOUT_CLAIMED_VECTOR.base64}`;

  it("finds the event the program emitted after its token CPI returned", () => {
    const logs = [
      "Program ComputeBudget111111111111111111111111111111 invoke [1]",
      "Program ComputeBudget111111111111111111111111111111 success",
      `Program ${program} invoke [1]`,
      "Program log: Instruction: Claim",
      `Program ${TOKEN_PROGRAM_ADDRESS} invoke [2]`,
      "Program log: Instruction: TransferChecked",
      `Program ${TOKEN_PROGRAM_ADDRESS} consumed 6200 of 380000 compute units`,
      `Program ${TOKEN_PROGRAM_ADDRESS} success`,
      dataLine,
      `Program ${program} consumed 30000 of 400000 compute units`,
      `Program ${program} success`,
    ];
    expect(findPayoutClaimedEvents(logs, program)).toEqual([expectedEvent]);
  });

  it("ignores the same bytes printed by another program or outside any frame", () => {
    const impostor = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    const logs = [
      dataLine,
      `Program ${impostor} invoke [1]`,
      dataLine,
      `Program ${impostor} success`,
      `Program ${program} invoke [1]`,
      `Program ${TOKEN_PROGRAM_ADDRESS} invoke [2]`,
      dataLine,
      `Program ${TOKEN_PROGRAM_ADDRESS} failed: custom program error: 0x1`,
      `Program ${program} failed: custom program error: 0x1`,
    ];
    expect(findPayoutClaimedEvents(logs, program)).toEqual([]);
    expect(findPayoutClaimedEvents([`Program ${program} invoke [1]`, dataLine], impostor)).toEqual([]);
  });

  it("skips other events and multi-slice lines, and throws on a broken PayoutClaimed payload", () => {
    const otherEvent = Buffer.from(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9])).toString("base64");
    const frame = (line: string) => [`Program ${program} invoke [1]`, line, `Program ${program} success`];
    expect(findPayoutClaimedEvents(frame(`Program data: ${otherEvent}`), program)).toEqual([]);
    expect(findPayoutClaimedEvents(frame(`${dataLine} ${otherEvent}`), program)).toEqual([]);
    expect(findPayoutClaimedEvents(frame("Program data: !!!"), program)).toEqual([]);
    const truncated = Buffer.from(vectorBytes.subarray(0, 100)).toString("base64");
    expect(() => findPayoutClaimedEvents(frame(`Program data: ${truncated}`), program)).toThrow(EventDecodeError);
  });
});
