import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import type {
  Connection,
  ParsedInstruction,
  ParsedTransactionWithMeta,
  PartiallyDecodedInstruction,
} from "@solana/web3.js";
import { USDC_DECIMALS } from "./amount.js";
import { payoutMemo, type CashbackPayout, type PayoutRails } from "./payout.js";

/**
 * A payout is only marked "paid" in the ledger after the chain proves it.
 * This is the Solana version of the receipt check GoGoCash already runs
 * before settling a stablecoin withdrawal: read the confirmed transaction and
 * require that it moved exactly the approved amount of the right token from
 * the treasury to the member, tagged with this payout's id.
 */
export type PayoutVerification =
  | { ok: true; signature: string; slot: number }
  | { ok: false; reason: string };

type AnyInstruction = ParsedInstruction | PartiallyDecodedInstruction;

function isParsed(ix: AnyInstruction): ix is ParsedInstruction {
  return "parsed" in ix;
}

type TransferCheckedInfo = {
  source: string;
  mint: string;
  destination: string;
  authority?: string;
  multisigAuthority?: string;
  tokenAmount: { amount: string; decimals: number };
};

export function verifyCashbackPayoutTransaction(
  tx: ParsedTransactionWithMeta | null,
  rails: PayoutRails,
  payout: CashbackPayout,
): PayoutVerification {
  if (!tx) return { ok: false, reason: "transaction not found" };
  if (!tx.meta) return { ok: false, reason: "transaction has no status" };
  if (tx.meta.err) return { ok: false, reason: "transaction failed onchain" };

  const signature = tx.transaction.signatures[0] ?? "";
  const instructions = tx.transaction.message.instructions as AnyInstruction[];
  const treasury = rails.treasury.toBase58();
  const mint = rails.usdcMint.toBase58();
  const treasuryAta = getAssociatedTokenAddressSync(
    rails.usdcMint,
    rails.treasury,
  ).toBase58();
  const memberAta = getAssociatedTokenAddressSync(
    rails.usdcMint,
    payout.memberWallet,
  ).toBase58();

  const transfers = instructions.filter(
    (ix): ix is ParsedInstruction =>
      isParsed(ix) &&
      ix.program === "spl-token" &&
      (ix.parsed as { type?: string })?.type === "transferChecked",
  );
  if (transfers.length !== 1) {
    return {
      ok: false,
      reason: `expected exactly 1 USDC transfer, found ${transfers.length}`,
    };
  }
  const info = (transfers[0]!.parsed as { info: TransferCheckedInfo }).info;
  if (info.mint !== mint) return { ok: false, reason: "wrong token mint" };
  if (info.source !== treasuryAta) {
    return { ok: false, reason: "not paid from the treasury token account" };
  }
  if ((info.authority ?? info.multisigAuthority) !== treasury) {
    return { ok: false, reason: "transfer not signed by the treasury" };
  }
  if (info.destination !== memberAta) {
    return { ok: false, reason: "paid to the wrong wallet" };
  }
  if (info.tokenAmount.decimals !== USDC_DECIMALS) {
    return { ok: false, reason: "unexpected token decimals" };
  }
  if (BigInt(info.tokenAmount.amount) !== payout.amountBaseUnits) {
    return {
      ok: false,
      reason: `amount mismatch: sent ${info.tokenAmount.amount}, approved ${payout.amountBaseUnits}`,
    };
  }

  const expectedMemo = payoutMemo(payout.payoutId);
  const memos = instructions.filter(
    (ix): ix is ParsedInstruction =>
      isParsed(ix) && ix.program === "spl-memo",
  );
  if (!memos.some((ix) => ix.parsed === expectedMemo)) {
    return { ok: false, reason: "payout id memo missing or different" };
  }

  return { ok: true, signature, slot: tx.slot };
}

/** Fetches a transaction at `confirmed` commitment and verifies it. */
export async function fetchAndVerifyCashbackPayout(
  connection: Connection,
  signature: string,
  rails: PayoutRails,
  payout: CashbackPayout,
): Promise<PayoutVerification> {
  const tx = await connection.getParsedTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  return verifyCashbackPayoutTransaction(tx, rails, payout);
}
