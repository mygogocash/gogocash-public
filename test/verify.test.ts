import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { MEMO_PROGRAM_ID } from "../src/payout.js";
import { verifyCashbackPayoutTransaction } from "../src/verify.js";

const treasury = Keypair.generate().publicKey;
const usdcMint = Keypair.generate().publicKey;
const memberWallet = Keypair.generate().publicKey;
const rails = { treasury, usdcMint };
const payout = { payoutId: "wd_000123", memberWallet, amountBaseUnits: 3_571_250n };

type Overrides = {
  err?: unknown;
  amount?: string;
  decimals?: number;
  mint?: string;
  destination?: string;
  source?: string;
  authority?: string;
  memo?: string | null;
  transfers?: number;
};

/** A confirmed transaction as `getParsedTransaction` returns it. */
function parsedTx(o: Overrides = {}): ParsedTransactionWithMeta {
  const transfer = {
    program: "spl-token",
    programId: TOKEN_PROGRAM_ID,
    parsed: {
      type: "transferChecked",
      info: {
        source: o.source ?? getAssociatedTokenAddressSync(usdcMint, treasury).toBase58(),
        mint: o.mint ?? usdcMint.toBase58(),
        destination:
          o.destination ?? getAssociatedTokenAddressSync(usdcMint, memberWallet).toBase58(),
        authority: o.authority ?? treasury.toBase58(),
        tokenAmount: { amount: o.amount ?? "3571250", decimals: o.decimals ?? 6 },
      },
    },
  };
  const memo = { program: "spl-memo", programId: MEMO_PROGRAM_ID, parsed: o.memo ?? "gogocash:cashback:wd_000123" };
  const instructions = [
    ...Array.from({ length: o.transfers ?? 1 }, () => transfer),
    ...(o.memo === null ? [] : [memo]),
  ];
  return {
    slot: 42,
    blockTime: null,
    meta: { err: o.err ?? null, fee: 5000, preBalances: [], postBalances: [] },
    transaction: {
      signatures: ["sig111"],
      message: { accountKeys: [], instructions, recentBlockhash: "x" },
    },
  } as unknown as ParsedTransactionWithMeta;
}

const ok = (tx: ParsedTransactionWithMeta | null) => verifyCashbackPayoutTransaction(tx, rails, payout);

describe("onchain payout verification", () => {
  it("accepts the exact approved transfer", () => {
    expect(ok(parsedTx())).toEqual({ ok: true, signature: "sig111", slot: 42 });
  });

  it.each<[string, Overrides, RegExp]>([
    ["failed transaction", { err: { InstructionError: [0, "Custom"] } }, /failed onchain/],
    ["wrong amount", { amount: "3571251" }, /amount mismatch/],
    ["wrong decimals", { decimals: 9 }, /decimals/],
    ["wrong mint", { mint: Keypair.generate().publicKey.toBase58() }, /mint/],
    ["wrong recipient", { destination: Keypair.generate().publicKey.toBase58() }, /wrong wallet/],
    ["not from treasury account", { source: Keypair.generate().publicKey.toBase58() }, /treasury token account/],
    ["not signed by treasury", { authority: Keypair.generate().publicKey.toBase58() }, /signed by the treasury/],
    ["memo for another payout", { memo: "gogocash:cashback:wd_999999" }, /memo/],
    ["memo missing", { memo: null }, /memo/],
    ["two transfers in one tx", { transfers: 2 }, /exactly 1/],
  ])("rejects %s", (_name, overrides, reason) => {
    const result = ok(parsedTx(overrides));
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toMatch(reason);
  });

  it("rejects a transaction that does not exist", () => {
    expect(ok(null)).toEqual({ ok: false, reason: "transaction not found" });
  });
});
