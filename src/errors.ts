/**
 * Error classification, docs/CONTRACT.md sections 3.5 (program codes
 * 6000-6023), 3.6 (Anchor built-ins), 3.7 (non-Anchor instruction errors,
 * classified by failing instruction index) and 9.1 (transaction-level errors
 * with no instruction index, D-X6).
 *
 * Classification is by number and failing instruction index, never by message
 * text. The one exception is the system program's `insufficient lamports` log
 * at the `claim` index (section 3.7).
 */

/** Off-chain handling classes (section 3.5). */
export type ErrorClass = "retry" | "hold" | "needs_review" | "already_claimed" | "bug" | "config";

/** Hold reasons section 9.1 names for specific errors. */
export type HoldReason = "program_paused" | "day_cap" | "vault_low" | "fee_payer_low";

export type ProgramErrorEntry = {
  readonly code: number;
  readonly name: string;
  /** Exact ASCII message from the program's `#[error_code]` enum. */
  readonly message: string;
  /** Instruction steps that raise it (section 3.3). */
  readonly raisedBy: readonly string[];
  readonly class: ErrorClass;
};

/** Section 3.5, in code order. Append-only: codes never change meaning or class. */
export const PROGRAM_ERRORS: readonly ProgramErrorEntry[] = [
  { code: 6000, name: "Paused", message: "Vault is paused", raisedBy: ["claim C1"], class: "hold" },
  { code: 6001, name: "InvalidClaimAuthority", message: "Signer is not the vault claim authority", raisedBy: ["claim C2"], class: "config" },
  { code: 6002, name: "NotAdmin", message: "Signer is not the vault admin", raisedBy: ["unpause U1", "update_config G1", "propose_admin A1", "withdraw W1"], class: "bug" },
  { code: 6003, name: "NotAdminOrGuardian", message: "Signer is neither the vault admin nor the guardian", raisedBy: ["pause P1"], class: "bug" },
  { code: 6004, name: "NotPendingAdmin", message: "Signer is not the pending admin", raisedBy: ["accept_admin B1"], class: "bug" },
  { code: 6005, name: "NotUpgradeAuthority", message: "Signer is not the program upgrade authority", raisedBy: ["initialize I2"], class: "config" },
  { code: 6006, name: "InvalidProgramData", message: "Account is not this program's ProgramData account", raisedBy: ["initialize I1"], class: "bug" },
  { code: 6007, name: "InvalidRole", message: "Role must not be the default public key", raisedBy: ["initialize I5", "update_config G2"], class: "bug" },
  { code: 6008, name: "ZeroPayoutId", message: "Payout id must not be all zero bytes", raisedBy: ["claim C6"], class: "bug" },
  { code: 6009, name: "ZeroAmount", message: "Amount must be greater than zero", raisedBy: ["claim C7", "withdraw W4"], class: "bug" },
  { code: 6010, name: "ExceedsMaxPerClaim", message: "Amount exceeds the per-claim cap", raisedBy: ["claim C8"], class: "needs_review" },
  { code: 6011, name: "DayCapExceeded", message: "Claim would exceed the daily cap", raisedBy: ["claim C10"], class: "hold" },
  { code: 6012, name: "Expired", message: "Claim has expired", raisedBy: ["claim C11"], class: "retry" },
  { code: 6013, name: "ExpiryTooFar", message: "Claim expiry is more than 900 seconds ahead", raisedBy: ["claim C12"], class: "bug" },
  { code: 6014, name: "VaultTokenAccountFrozen", message: "Vault token account is frozen", raisedBy: ["claim C13", "withdraw W6"], class: "hold" },
  { code: 6015, name: "RecipientTokenAccountFrozen", message: "Recipient token account is frozen", raisedBy: ["claim C14"], class: "needs_review" },
  { code: 6016, name: "InsufficientVaultBalance", message: "Vault balance is below the amount", raisedBy: ["claim C15", "withdraw W7"], class: "hold" },
  { code: 6017, name: "InvalidRecipient", message: "Recipient must not be the vault, the claim authority or the payer", raisedBy: ["claim C5"], class: "needs_review" },
  { code: 6018, name: "InvalidVaultTokenAccount", message: "Vault token account is not canonical or has a delegate or close authority", raisedBy: ["initialize I4", "claim C4", "withdraw W3"], class: "config" },
  { code: 6019, name: "InvalidMint", message: "Mint is not the vault mint or does not have 6 decimals", raisedBy: ["initialize I3", "claim C3", "withdraw W2"], class: "config" },
  { code: 6020, name: "RoleConflict", message: "Claim authority must not also be the admin or the guardian", raisedBy: ["initialize I6", "update_config G3", "propose_admin A2", "accept_admin B2"], class: "bug" },
  { code: 6021, name: "InvalidCaps", message: "Caps must be non-zero and max_per_claim must not exceed max_per_day", raisedBy: ["initialize I7", "update_config G4"], class: "bug" },
  { code: 6022, name: "InvalidWithdrawDestination", message: "Withdraw destination must be an unfrozen vault-mint token account owned by the admin", raisedBy: ["withdraw W5"], class: "bug" },
  { code: 6023, name: "MathOverflow", message: "Arithmetic overflow", raisedBy: ["claim C9", "claim C12", "claim effects", "withdraw W8"], class: "bug" },
];

export type AnchorErrorEntry = {
  readonly code: number;
  readonly name: string;
  readonly class: ErrorClass;
};

/**
 * Section 3.6 (Anchor 1.2.0 numbers). Any Anchor code not listed is `bug`.
 * 3012 is `config` for the rail and for the SDK, whose claim builder always
 * includes `createAssociatedTokenIdempotent` (section 3.6, D-R22).
 */
export const ANCHOR_ERRORS: readonly AnchorErrorEntry[] = [
  { code: 100, name: "InstructionMissing", class: "bug" },
  { code: 101, name: "InstructionFallbackNotFound", class: "config" },
  { code: 102, name: "InstructionDidNotDeserialize", class: "bug" },
  { code: 2000, name: "ConstraintMut", class: "bug" },
  { code: 2006, name: "ConstraintSeeds", class: "bug" },
  { code: 2009, name: "ConstraintAssociated", class: "bug" },
  { code: 2015, name: "ConstraintTokenOwner", class: "bug" },
  { code: 2023, name: "ConstraintAssociatedTokenTokenProgram", class: "bug" },
  { code: 2040, name: "ConstraintDuplicateMutableAccount", class: "bug" },
  { code: 2500, name: "RequireViolated", class: "bug" },
  { code: 2501, name: "RequireEqViolated", class: "bug" },
  { code: 2502, name: "RequireKeysEqViolated", class: "bug" },
  { code: 2503, name: "RequireNeqViolated", class: "bug" },
  { code: 2504, name: "RequireKeysNeqViolated", class: "bug" },
  { code: 2505, name: "RequireGtViolated", class: "bug" },
  { code: 2506, name: "RequireGteViolated", class: "bug" },
  { code: 3001, name: "AccountDiscriminatorNotFound", class: "config" },
  { code: 3002, name: "AccountDiscriminatorMismatch", class: "config" },
  { code: 3003, name: "AccountDidNotDeserialize", class: "config" },
  { code: 3005, name: "AccountNotEnoughKeys", class: "bug" },
  { code: 3007, name: "AccountOwnedByWrongProgram", class: "config" },
  { code: 3008, name: "InvalidProgramId", class: "bug" },
  { code: 3009, name: "InvalidProgramExecutable", class: "bug" },
  { code: 3010, name: "AccountNotSigner", class: "bug" },
  { code: 3011, name: "AccountNotSystemOwned", class: "needs_review" },
  { code: 3012, name: "AccountNotInitialized", class: "config" },
  { code: 3013, name: "AccountNotProgramData", class: "bug" },
  { code: 3014, name: "AccountNotAssociatedTokenAccount", class: "bug" },
  { code: 4100, name: "DeclaredProgramIdMismatch", class: "config" },
  { code: 4101, name: "TryingToInitPayerAsProgramAccount", class: "bug" },
];

const PROGRAM_ERROR_BY_CODE = new Map(PROGRAM_ERRORS.map((entry) => [entry.code, entry]));
const ANCHOR_ERROR_BY_CODE = new Map(ANCHOR_ERRORS.map((entry) => [entry.code, entry]));

/** The 8 program instructions (section 3.3). */
export type ProgramInstructionKind =
  | "initialize"
  | "claim"
  | "pause"
  | "unpause"
  | "update_config"
  | "propose_admin"
  | "accept_admin"
  | "withdraw";

/** Every top-level instruction kind a GoGoCash transaction may contain. */
export type InstructionKind =
  | ProgramInstructionKind
  | "create_associated_token_idempotent"
  | "compute_budget";

const PROGRAM_INSTRUCTIONS: ReadonlySet<string> = new Set<ProgramInstructionKind>([
  "initialize",
  "claim",
  "pause",
  "unpause",
  "update_config",
  "propose_admin",
  "accept_admin",
  "withdraw",
]);

/** `Custom(n)` or a named `InstructionError` such as `IllegalOwner`. */
export type InstructionErrorDetail = { readonly custom: number } | { readonly name: string };

export type ErrorSource =
  | "program"
  | "anchor"
  | "system"
  | "associated_token"
  | "compute_budget"
  | "transaction"
  | "unknown";

export type ErrorClassification = {
  readonly class: ErrorClass;
  readonly source: ErrorSource;
  readonly code?: number;
  readonly name?: string;
  /** Set the halt latch (bug, config, and 6014; sections 3.5 and 9.1). */
  readonly haltLatch: boolean;
  /** Raise a CRITICAL alert (same cases as `haltLatch`). */
  readonly critical: boolean;
  readonly holdReason?: HoldReason;
};

function classification(
  errorClass: ErrorClass,
  source: ErrorSource,
  extra: { code?: number; name?: string; holdReason?: HoldReason; forceCritical?: boolean } = {},
): ErrorClassification {
  const critical = errorClass === "bug" || errorClass === "config" || extra.forceCritical === true;
  return {
    class: errorClass,
    source,
    ...(extra.code === undefined ? {} : { code: extra.code }),
    ...(extra.name === undefined ? {} : { name: extra.name }),
    ...(extra.holdReason === undefined ? {} : { holdReason: extra.holdReason }),
    haltLatch: critical,
    critical,
  };
}

const PROGRAM_HOLD_REASON: ReadonlyMap<number, HoldReason> = new Map([
  [6000, "program_paused"],
  [6011, "day_cap"],
  [6016, "vault_low"],
]);

/**
 * Classifies a custom error code raised by a `gogocash_cashback`
 * instruction: the section 3.5 table, then the section 3.6 Anchor table.
 * Unknown codes (including program codes appended after 6023, which a v0
 * client cannot know) are `bug`.
 */
export function classifyProgramErrorCode(code: number): ErrorClassification {
  const program = PROGRAM_ERROR_BY_CODE.get(code);
  if (program !== undefined) {
    const holdReason = PROGRAM_HOLD_REASON.get(code);
    return classification(program.class, "program", {
      code,
      name: program.name,
      ...(holdReason === undefined ? {} : { holdReason }),
      // 6014 is hold plus CRITICAL plus the halt latch.
      forceCritical: code === 6014,
    });
  }
  const anchor = ANCHOR_ERROR_BY_CODE.get(code);
  if (anchor !== undefined) {
    return classification(anchor.class, "anchor", { code, name: anchor.name });
  }
  return classification("bug", code >= 6000 ? "program" : "unknown", { code });
}

function logsContain(logs: readonly string[] | undefined, needle: string): boolean {
  return logs !== undefined && logs.some((line) => line.includes(needle));
}

/**
 * Classifies an `InstructionError` at a known failing instruction (section
 * 3.7). `logs` are the transaction's log messages; they matter only for
 * `Custom(1)` at the `claim` index.
 */
export function classifyInstructionError(input: {
  instruction: InstructionKind;
  error: InstructionErrorDetail;
  logs?: readonly string[];
}): ErrorClassification {
  const { instruction, error } = input;
  if (instruction === "compute_budget") {
    return classification("bug", "compute_budget", "custom" in error ? { code: error.custom } : { name: error.name });
  }
  if (instruction === "create_associated_token_idempotent") {
    if ("custom" in error) {
      if (error.custom === 0) {
        return classification("needs_review", "associated_token", { code: 0, name: "InvalidOwner" });
      }
      if (error.custom === 1) {
        return classification("hold", "system", { code: 1, name: "ResultWithNegativeLamports", holdReason: "fee_payer_low" });
      }
      return classification("bug", "unknown", { code: error.custom });
    }
    if (error.name === "IllegalOwner") {
      return classification("needs_review", "associated_token", { name: "IllegalOwner" });
    }
    return classification("bug", "unknown", { name: error.name });
  }
  if (!PROGRAM_INSTRUCTIONS.has(instruction)) {
    return classification("bug", "unknown", "custom" in error ? { code: error.custom } : { name: error.name });
  }
  if (!("custom" in error)) {
    return classification("bug", "unknown", { name: error.name });
  }
  const code = error.custom;
  if (instruction === "claim" && code === 0) {
    // "already in use": the receipt for this payout_id exists. Routes to the
    // read-only receipt verification even when the logs are truncated.
    return classification("already_claimed", "system", { code: 0, name: "AccountAlreadyInUse" });
  }
  if (instruction === "claim" && code === 1 && logsContain(input.logs, "insufficient lamports")) {
    return classification("hold", "system", { code: 1, name: "ResultWithNegativeLamports", holdReason: "fee_payer_low" });
  }
  if (instruction === "initialize" && code === 0) {
    return classification("bug", "system", { code: 0, name: "AccountAlreadyInUse" });
  }
  return classifyProgramErrorCode(code);
}

/**
 * Transaction-level errors that carry no instruction index (section 9.1,
 * D-X6): `BlockhashNotFound` and `AccountInUse` are `retry`;
 * `InsufficientFundsForFee` and `InsufficientFundsForRent` are `hold`
 * (`fee_payer_low`); any other is `bug`.
 */
export function classifyTransactionLevelError(name: string): ErrorClassification {
  switch (name) {
    case "BlockhashNotFound":
    case "AccountInUse":
      return classification("retry", "transaction", { name });
    case "InsufficientFundsForFee":
    case "InsufficientFundsForRent":
      return classification("hold", "transaction", { name, holdReason: "fee_payer_low" });
    default:
      return classification("bug", "transaction", { name });
  }
}

function toSafeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  return null;
}

/**
 * Classifies a JSON-RPC `TransactionError` value (the `err` of a simulation,
 * a signature status or a transaction meta). `instructions` lists the kind
 * of each top-level instruction of the transaction, by index, so an
 * `InstructionError` can be classified against section 3.7.
 */
export function classifyTransactionError(input: {
  err: unknown;
  instructions: readonly InstructionKind[];
  logs?: readonly string[];
}): ErrorClassification {
  const { err } = input;
  if (typeof err === "string") return classifyTransactionLevelError(err);
  if (typeof err !== "object" || err === null) return classification("bug", "unknown");
  const keys = Object.keys(err);
  if (keys.length !== 1) return classification("bug", "unknown");
  const key = keys[0] as string;
  if (key !== "InstructionError") return classifyTransactionLevelError(key);
  const payload = (err as { InstructionError: unknown }).InstructionError;
  if (!Array.isArray(payload) || payload.length !== 2) return classification("bug", "unknown");
  const index = toSafeInteger(payload[0]);
  const instruction = index === null ? undefined : input.instructions[index];
  if (instruction === undefined) return classification("bug", "unknown");
  const detail: unknown = payload[1];
  let error: InstructionErrorDetail;
  if (typeof detail === "string") {
    error = { name: detail };
  } else if (typeof detail === "object" && detail !== null && "Custom" in detail) {
    const custom = toSafeInteger((detail as { Custom: unknown }).Custom);
    if (custom === null) return classification("bug", "unknown");
    error = { custom };
  } else if (typeof detail === "object" && detail !== null && Object.keys(detail).length === 1) {
    // Named errors with a payload, such as { BorshIoError: "..." }.
    error = { name: Object.keys(detail)[0] as string };
  } else {
    return classification("bug", "unknown");
  }
  return classifyInstructionError({
    instruction,
    error,
    ...(input.logs === undefined ? {} : { logs: input.logs }),
  });
}
