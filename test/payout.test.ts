import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  MEMO_PROGRAM_ID,
  buildCashbackPayoutInstructions,
  buildCashbackPayoutTransaction,
  payoutMemo,
} from "../src/payout.js";

const treasury = Keypair.generate().publicKey;
const usdcMint = Keypair.generate().publicKey;
const memberWallet = Keypair.generate().publicKey;
const rails = { treasury, usdcMint };
const payout = { payoutId: "wd_000123", memberWallet, amountBaseUnits: 3_571_250n };

describe("cashback payout instructions", () => {
  it("creates the member token account, transfers, then tags the payout id", () => {
    const [createAta, transfer, memo] = buildCashbackPayoutInstructions(rails, payout);
    expect(createAta!.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect(transfer!.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(memo!.programId.equals(MEMO_PROGRAM_ID)).toBe(true);
    expect(memo!.data.toString("utf8")).toBe("gogocash:cashback:wd_000123");

    const memberAta = getAssociatedTokenAddressSync(usdcMint, memberWallet);
    const treasuryAta = getAssociatedTokenAddressSync(usdcMint, treasury);
    const keys = transfer!.keys.map((k) => k.pubkey.toBase58());
    expect(keys).toEqual([
      treasuryAta.toBase58(),
      usdcMint.toBase58(),
      memberAta.toBase58(),
      treasury.toBase58(),
    ]);
    // transferChecked data: [12, amount u64 LE, decimals u8]
    expect(transfer!.data[0]).toBe(12);
    expect(transfer!.data.readBigUInt64LE(1)).toBe(3_571_250n);
    expect(transfer!.data[9]).toBe(6);
  });

  it("has the treasury pay fees", () => {
    const tx = buildCashbackPayoutTransaction(rails, payout, Keypair.generate().publicKey.toBase58(), 100);
    expect(tx.feePayer?.equals(treasury)).toBe(true);
    expect(tx.instructions).toHaveLength(3);
  });

  it("rejects bad payout ids and non-positive amounts", () => {
    expect(() => payoutMemo("x")).toThrow(RangeError);
    expect(() => payoutMemo("has space here")).toThrow(RangeError);
    expect(() =>
      buildCashbackPayoutInstructions(rails, { ...payout, amountBaseUnits: 0n }),
    ).toThrow(RangeError);
  });
});
