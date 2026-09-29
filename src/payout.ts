import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { USDC_DECIMALS } from "./amount.js";

/**
 * One approved cashback payout. `payoutId` is the ledger's id for this
 * withdrawal; it is written onchain as a memo so every transfer can be tied
 * back to exactly one approved payout (and a second transfer for the same id
 * is detectable).
 */
export type CashbackPayout = {
  payoutId: string;
  /** Wallet the member connected on their Solana Mobile phone. */
  memberWallet: PublicKey;
  /** USDC base units (6 decimals). Produce this with `src/amount.ts`. */
  amountBaseUnits: bigint;
};

export type PayoutRails = {
  /** Treasury wallet that holds USDC and signs payouts. */
  treasury: PublicKey;
  /** USDC mint for the cluster (a demo mint on devnet). */
  usdcMint: PublicKey;
};

/** SPL Memo program (v2). Writes a UTF-8 note into the transaction. */
export const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);

function memoInstruction(memo: string, signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data: Buffer.from(memo, "utf8"),
  });
}

const PAYOUT_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

export function payoutMemo(payoutId: string): string {
  if (!PAYOUT_ID_PATTERN.test(payoutId)) {
    throw new RangeError(
      "payoutId must be 6-64 characters of letters, digits, '-' or '_'.",
    );
  }
  return `gogocash:cashback:${payoutId}`;
}

/**
 * The three instructions that make one cashback payout:
 *  1. create the member's USDC token account if it does not exist yet
 *     (idempotent, paid by the treasury, so a brand-new wallet can receive);
 *  2. `transferChecked` the exact amount from the treasury's USDC account,
 *     which makes the token program re-check the mint and decimals;
 *  3. a memo carrying the payout id, signed by the treasury.
 */
export function buildCashbackPayoutInstructions(
  rails: PayoutRails,
  payout: CashbackPayout,
): TransactionInstruction[] {
  if (payout.amountBaseUnits <= 0n) {
    throw new RangeError("Payout amount must be positive.");
  }
  const treasuryAta = getAssociatedTokenAddressSync(
    rails.usdcMint,
    rails.treasury,
  );
  const memberAta = getAssociatedTokenAddressSync(
    rails.usdcMint,
    payout.memberWallet,
  );
  return [
    createAssociatedTokenAccountIdempotentInstruction(
      rails.treasury,
      memberAta,
      payout.memberWallet,
      rails.usdcMint,
    ),
    createTransferCheckedInstruction(
      treasuryAta,
      rails.usdcMint,
      memberAta,
      rails.treasury,
      payout.amountBaseUnits,
      USDC_DECIMALS,
    ),
    memoInstruction(payoutMemo(payout.payoutId), rails.treasury),
  ];
}

export function buildCashbackPayoutTransaction(
  rails: PayoutRails,
  payout: CashbackPayout,
  recentBlockhash: string,
  lastValidBlockHeight: number,
): Transaction {
  const tx = new Transaction({
    feePayer: rails.treasury,
    blockhash: recentBlockhash,
    lastValidBlockHeight,
  });
  tx.add(...buildCashbackPayoutInstructions(rails, payout));
  return tx;
}
