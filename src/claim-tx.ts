/**
 * The claim transaction, docs/CONTRACT.md section 9.1 step 5 (and the
 * recommended transaction of section 3.3.2), built by pure functions: no RPC
 * call and no key material.
 *
 * The transaction is a v0 message with no address lookup table and a
 * recent-blockhash lifetime (never a durable nonce), with exactly these
 * instructions, in this order:
 *
 *   1. `SetComputeUnitLimit(limit)`, where `limit = ceil(simulated x 115 / 100)`
 *      capped at 60,000 when the recipient ATA exists and 90,000 when it does not;
 *   2. `SetComputeUnitPrice(price)`, capped at the configured cap;
 *   3. `createAssociatedTokenIdempotent(payer, ata(recipient, mint), recipient, mint)`
 *      under classic SPL Token, always included (section 3.3.0);
 *   4. `claim(payout_id, amount, expires_at)` from the generated client, with
 *      `programAddress` passed explicitly (section 2.4).
 *
 * Signers are the fee payer (first, also the claim `payer`) and the claim
 * authority; they may be the same key. The builder takes their addresses
 * only. It returns the compiled, unsigned transaction: sign it with
 * `signTransaction([feePayerKeyPair, claimAuthorityKeyPair], transaction)`
 * from @solana/kit, persist, then broadcast (section 9.1 steps 6 and 7).
 *
 * `simulated_units` must come from an unsigned simulation (all-zero
 * signatures, `sigVerify: false`, `replaceRecentBlockhash: true`) of the same
 * instruction list: `buildClaimSimulationTransaction` builds it with the cap
 * as the limit, and `claimComputeUnitLimitFromSimulation` turns the result
 * into the limit for `buildClaimTransaction`. A signed transaction is never
 * simulated (review SEC-13).
 */
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getTransactionEncoder,
  isTransactionWithinSizeLimit,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
  type Transaction,
  type TransactionSigner,
  type TransactionWithBlockhashLifetime,
} from "@solana/kit";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import { getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token";
import { isU64 } from "./amount.ts";
import { isStrictBase58 } from "./base58.ts";
import { SYSTEM_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "./clusters.ts";
import { getClaimInstruction } from "./generated/instructions/claim.ts";
import { findClassicAta, findReceiptPda, findVaultPda } from "./program.ts";

/** Compute-unit margin over the simulated units: x 115 / 100 (section 9.1). */
export const CLAIM_CU_MARGIN_PERCENT = 115n;
/** Compute-unit limit cap when the recipient ATA already exists (section 9.1). */
export const CLAIM_CU_LIMIT_CAP_ATA_EXISTS = 60_000;
/** Compute-unit limit cap when the ATA is created in the same transaction (section 9.1). */
export const CLAIM_CU_LIMIT_CAP_ATA_MISSING = 90_000;
/** Default of `SOLANA_WITHDRAW_PRIORITY_FEE_CAP_MICROLAMPORTS` (section 9.1). */
export const DEFAULT_PRIORITY_FEE_CAP_MICROLAMPORTS = 100_000n;

const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

export type ClaimTransactionErrorCode =
  /** An input has the wrong type, length or range. */
  | "invalid_input"
  /** `vault` is not `["vault", mint]` under `programAddress`. */
  | "vault_mismatch"
  /** The recipient is the vault, the claim authority or the payer (onchain C5, 6017). */
  | "recipient_conflict"
  /** The simulated units alone exceed the cap, so the claim could only fail. */
  | "compute_units_exceed_cap";

export class ClaimTransactionError extends Error {
  override name = "ClaimTransactionError";
  readonly code: ClaimTransactionErrorCode;

  constructor(code: ClaimTransactionErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function invalid(message: string): ClaimTransactionError {
  return new ClaimTransactionError("invalid_input", message);
}

// ---------------------------------------------------------------------------
// Compute-unit limit (section 9.1 step 5.1)
// ---------------------------------------------------------------------------

/** 60,000 when the recipient ATA exists, 90,000 when it does not. */
export function claimComputeUnitCap(recipientAtaExists: boolean): number {
  if (typeof recipientAtaExists !== "boolean") {
    throw invalid("recipientAtaExists must be a boolean.");
  }
  return recipientAtaExists ? CLAIM_CU_LIMIT_CAP_ATA_EXISTS : CLAIM_CU_LIMIT_CAP_ATA_MISSING;
}

function positiveUnits(value: unknown): bigint | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return null;
    return value > 0 ? BigInt(value) : null;
  }
  if (typeof value === "bigint") return value > 0n ? value : null;
  return null;
}

/**
 * `limit = ceil(simulatedUnits x 115 / 100)`, capped at 60,000 (ATA exists)
 * or 90,000 (ATA created here). Exact integer arithmetic.
 *
 * Throws `invalid_input` unless `simulatedUnits` is a positive integer, and
 * `compute_units_exceed_cap` when the simulated units alone are above the
 * cap: any limit the contract allows would then be below the units the claim
 * needs, so the transaction could only fail onchain.
 */
export function computeClaimComputeUnitLimit(input: {
  readonly simulatedUnits: bigint | number;
  readonly recipientAtaExists: boolean;
}): number {
  const cap = BigInt(claimComputeUnitCap(input.recipientAtaExists));
  const units = positiveUnits(input.simulatedUnits);
  if (units === null) throw invalid("simulatedUnits must be a positive integer.");
  if (units > cap) {
    throw new ClaimTransactionError(
      "compute_units_exceed_cap",
      `Simulated ${units} compute units exceed the ${cap} cap.`,
    );
  }
  const withMargin = (units * CLAIM_CU_MARGIN_PERCENT + 99n) / 100n;
  return Number(withMargin < cap ? withMargin : cap);
}

/** The part of a `simulateTransaction` result value this module reads. */
export type ClaimSimulationValue = {
  /** `null` when the simulation succeeded. */
  readonly err: unknown;
  readonly unitsConsumed?: bigint | number | null;
};

export type ClaimSimulationOutcome =
  | { readonly ok: true; readonly simulatedUnits: bigint; readonly computeUnitLimit: number }
  /** Classify `err` with errors.ts; no attempt is persisted (section 9.1). */
  | { readonly ok: false; readonly reason: "simulation_error"; readonly err: unknown }
  | { readonly ok: false; readonly reason: "units_missing" }
  | {
      readonly ok: false;
      readonly reason: "exceeds_cap";
      readonly simulatedUnits: bigint;
      readonly cap: number;
    };

/**
 * Turns the value of an unsigned simulation of
 * `buildClaimSimulationTransaction` into the compute-unit limit for
 * `buildClaimTransaction`. A failed simulation, missing units or units above
 * the cap give no limit.
 */
export function claimComputeUnitLimitFromSimulation(
  simulation: ClaimSimulationValue,
  options: { readonly recipientAtaExists: boolean },
): ClaimSimulationOutcome {
  const cap = claimComputeUnitCap(options.recipientAtaExists);
  if (simulation.err !== null) {
    return { ok: false, reason: "simulation_error", err: simulation.err };
  }
  const units = positiveUnits(simulation.unitsConsumed);
  if (units === null) return { ok: false, reason: "units_missing" };
  if (units > BigInt(cap)) return { ok: false, reason: "exceeds_cap", simulatedUnits: units, cap };
  return {
    ok: true,
    simulatedUnits: units,
    computeUnitLimit: computeClaimComputeUnitLimit({
      simulatedUnits: units,
      recipientAtaExists: options.recipientAtaExists,
    }),
  };
}

// ---------------------------------------------------------------------------
// Compute-unit price (section 9.1 step 5.2)
// ---------------------------------------------------------------------------

function assertU64Input(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || !isU64(value)) {
    throw invalid(`${label} must be a bigint from 0 to 2^64 - 1.`);
  }
  return value;
}

/** `min(price, cap)`, both in micro-lamports per compute unit. */
export function capPriorityPrice(input: {
  readonly priceMicroLamports: bigint;
  readonly capMicroLamports: bigint;
}): bigint {
  const price = assertU64Input(input.priceMicroLamports, "priceMicroLamports");
  const cap = assertU64Input(input.capMicroLamports, "capMicroLamports");
  return price < cap ? price : cap;
}

/**
 * The 75th percentile of `getRecentPrioritizationFees([vault,
 * vault_token_account])`, capped. The percentile is nearest-rank: sort
 * ascending and take the value at rank `ceil(0.75 x n)`. No samples give 0.
 */
export function priorityPriceFromRecentFees(
  fees: readonly { readonly prioritizationFee: bigint | number }[],
  capMicroLamports: bigint = DEFAULT_PRIORITY_FEE_CAP_MICROLAMPORTS,
): bigint {
  const samples = fees.map((fee, index) => {
    const value = fee.prioritizationFee;
    const asBigint =
      typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : value;
    return assertU64Input(asBigint, `fees[${index}].prioritizationFee`);
  });
  if (samples.length === 0) return capPriorityPrice({ priceMicroLamports: 0n, capMicroLamports });
  samples.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = BigInt(samples.length);
  const rank = (3n * n + 3n) / 4n; // ceil(3n / 4), from 1 to n
  const p75 = samples[Number(rank) - 1] ?? 0n;
  return capPriorityPrice({ priceMicroLamports: p75, capMicroLamports });
}

// ---------------------------------------------------------------------------
// The transaction (section 9.1 step 5)
// ---------------------------------------------------------------------------

export type ClaimTransactionInput = {
  /**
   * `release/manifest.json.programIds[cluster]`. Required: the generated
   * client's default address is never used (section 2.4).
   */
  readonly programAddress: Address;
  /** The vault PDA `["vault", mint]` under `programAddress`; checked. */
  readonly vault: Address;
  readonly mint: Address;
  /** The member's wallet (the row's `solana_recipient`). */
  readonly recipient: Address;
  /** The fee payer: pays the fee, the receipt rent and any ATA rent. */
  readonly payer: Address;
  /** The vault's claim authority (signer of `claim`). */
  readonly claimAuthority: Address;
  /** The 32 raw payout id bytes (section 5.1). */
  readonly payoutId: Uint8Array;
  /** Atomic USDC, the row's `solana_amount_atomic`. */
  readonly amount: bigint;
  /** `clock.unix_timestamp + 300` from the confirmed Clock (section 9.1 step 4). */
  readonly expiresAt: bigint;
  /** From `getLatestBlockhash({ commitment: "confirmed" })`. */
  readonly blockhash: string;
  readonly lastValidBlockHeight: bigint;
  /** Whether the recipient ATA exists; selects the 60,000 or 90,000 cap. */
  readonly recipientAtaExists: boolean;
  /** The observed priority price (for example `priorityPriceFromRecentFees`). */
  readonly priorityPriceMicroLamports: bigint;
  /** `SOLANA_WITHDRAW_PRIORITY_FEE_CAP_MICROLAMPORTS`. */
  readonly priorityPriceCapMicroLamports: bigint;
};

export type ClaimTransaction = {
  /** Compiled and unsigned: every signature slot is `null`. */
  readonly transaction: Transaction & TransactionWithBlockhashLifetime;
  /** Wire bytes with all-zero signatures (the unsigned simulation form). */
  readonly unsignedWire: Uint8Array;
  readonly computeUnitLimit: number;
  readonly computeUnitPriceMicroLamports: bigint;
  /** The four instructions, in transaction order. */
  readonly instructions: readonly Instruction[];
  readonly accounts: {
    readonly vault: Address;
    readonly receipt: Address;
    readonly vaultTokenAccount: Address;
    readonly recipientTokenAccount: Address;
  };
  /** Required signers, fee payer first (one entry when payer = claim authority). */
  readonly signers: readonly Address[];
  readonly lifetime: { readonly blockhash: string; readonly lastValidBlockHeight: bigint };
};

function assertAddress(value: unknown, label: string): Address {
  if (!isStrictBase58(value, 32)) throw invalid(`${label} must be a strict base58 address.`);
  return value as Address;
}

type CheckedInput = {
  programAddress: Address;
  vault: Address;
  mint: Address;
  recipient: Address;
  payer: Address;
  claimAuthority: Address;
  payoutId: Uint8Array;
  amount: bigint;
  expiresAt: bigint;
  blockhash: Blockhash;
  lastValidBlockHeight: bigint;
  recipientAtaExists: boolean;
  priceMicroLamports: bigint;
};

function checkInput(input: ClaimTransactionInput): CheckedInput {
  const programAddress = assertAddress(input.programAddress, "programAddress");
  const vault = assertAddress(input.vault, "vault");
  const mint = assertAddress(input.mint, "mint");
  const recipient = assertAddress(input.recipient, "recipient");
  const payer = assertAddress(input.payer, "payer");
  const claimAuthority = assertAddress(input.claimAuthority, "claimAuthority");
  if (!(input.payoutId instanceof Uint8Array) || input.payoutId.length !== 32) {
    throw invalid("payoutId must be exactly 32 bytes.");
  }
  if (input.payoutId.every((byte) => byte === 0)) {
    throw invalid("payoutId must not be all zero bytes (onchain C6, 6008).");
  }
  const amount = assertU64Input(input.amount, "amount");
  if (amount === 0n) throw invalid("amount must be greater than zero (onchain C7, 6009).");
  if (typeof input.expiresAt !== "bigint" || input.expiresAt < I64_MIN || input.expiresAt > I64_MAX) {
    throw invalid("expiresAt must be a bigint in the i64 range.");
  }
  if (!isStrictBase58(input.blockhash, 32)) {
    throw invalid("blockhash must be a strict base58 32-byte value.");
  }
  const lastValidBlockHeight = assertU64Input(input.lastValidBlockHeight, "lastValidBlockHeight");
  claimComputeUnitCap(input.recipientAtaExists);
  const priceMicroLamports = capPriorityPrice({
    priceMicroLamports: input.priorityPriceMicroLamports,
    capMicroLamports: input.priorityPriceCapMicroLamports,
  });
  if (recipient === vault || recipient === claimAuthority || recipient === payer) {
    throw new ClaimTransactionError(
      "recipient_conflict",
      "recipient must not be the vault, the claim authority or the payer (onchain C5, 6017).",
    );
  }
  return {
    programAddress,
    vault,
    mint,
    recipient,
    payer,
    claimAuthority,
    payoutId: Uint8Array.from(input.payoutId),
    amount,
    expiresAt: input.expiresAt,
    blockhash: input.blockhash as Blockhash,
    lastValidBlockHeight,
    recipientAtaExists: input.recipientAtaExists,
    priceMicroLamports,
  };
}

async function assemble(input: CheckedInput, computeUnitLimit: number): Promise<ClaimTransaction> {
  const vaultPda = await findVaultPda({ programAddress: input.programAddress, mint: input.mint });
  if (vaultPda.address !== input.vault) {
    throw new ClaimTransactionError(
      "vault_mismatch",
      'vault is not the PDA ["vault", mint] under programAddress.',
    );
  }
  const [receipt, vaultTokenAccount, recipientTokenAccount] = await Promise.all([
    findReceiptPda({
      programAddress: input.programAddress,
      vault: input.vault,
      payoutId: input.payoutId,
    }).then((pda) => pda.address),
    findClassicAta({ owner: input.vault, mint: input.mint }),
    findClassicAta({ owner: input.recipient, mint: input.mint }),
  ]);

  // Noop signers carry the address and the signer role; they never sign.
  // One object per address, so payer = claim authority stays one signer.
  const payerSigner: TransactionSigner = createNoopSigner(input.payer);
  const claimAuthoritySigner: TransactionSigner =
    input.claimAuthority === input.payer ? payerSigner : createNoopSigner(input.claimAuthority);

  const claim = getClaimInstruction(
    {
      vault: input.vault,
      receipt,
      mint: input.mint,
      vaultTokenAccount,
      recipient: input.recipient,
      recipientTokenAccount,
      claimAuthority: claimAuthoritySigner,
      payer: payerSigner,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      systemProgram: SYSTEM_PROGRAM_ADDRESS,
      payoutId: input.payoutId,
      amount: input.amount,
      expiresAt: input.expiresAt,
    },
    { programAddress: input.programAddress },
  );
  if (claim.programAddress !== input.programAddress) {
    throw new Error("claim instruction does not target programAddress.");
  }

  const instructions: readonly Instruction[] = [
    getSetComputeUnitLimitInstruction({ units: computeUnitLimit }),
    getSetComputeUnitPriceInstruction({ microLamports: input.priceMicroLamports }),
    getCreateAssociatedTokenIdempotentInstruction({
      payer: payerSigner,
      ata: recipientTokenAccount,
      owner: input.recipient,
      mint: input.mint,
      systemProgram: SYSTEM_PROGRAM_ADDRESS,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    }),
    claim,
  ];

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payerSigner, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: input.blockhash, lastValidBlockHeight: input.lastValidBlockHeight },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const transaction = compileTransaction(message);
  if (!isTransactionWithinSizeLimit(transaction)) {
    throw invalid("The claim transaction exceeds the transaction size limit.");
  }
  const signers =
    input.payer === input.claimAuthority ? [input.payer] : [input.payer, input.claimAuthority];

  return {
    transaction,
    unsignedWire: Uint8Array.from(getTransactionEncoder().encode(transaction)),
    computeUnitLimit,
    computeUnitPriceMicroLamports: input.priceMicroLamports,
    instructions,
    accounts: { vault: input.vault, receipt, vaultTokenAccount, recipientTokenAccount },
    signers,
    lifetime: { blockhash: input.blockhash, lastValidBlockHeight: input.lastValidBlockHeight },
  };
}

/**
 * Builds the claim transaction to sign and send, with
 * `limit = computeClaimComputeUnitLimit({ simulatedUnits, recipientAtaExists })`.
 */
export async function buildClaimTransaction(
  input: ClaimTransactionInput & { readonly simulatedUnits: bigint | number },
): Promise<ClaimTransaction> {
  const checked = checkInput(input);
  const limit = computeClaimComputeUnitLimit({
    simulatedUnits: input.simulatedUnits,
    recipientAtaExists: checked.recipientAtaExists,
  });
  return assemble(checked, limit);
}

/**
 * Builds the same transaction with the cap (60,000 or 90,000) as its limit,
 * for the unsigned simulation that measures `simulated_units`. Simulate
 * `unsignedWire` with `sigVerify: false` and `replaceRecentBlockhash: true`;
 * never sign or send this transaction.
 */
export async function buildClaimSimulationTransaction(
  input: ClaimTransactionInput,
): Promise<ClaimTransaction> {
  const checked = checkInput(input);
  return assemble(checked, claimComputeUnitCap(checked.recipientAtaExists));
}
