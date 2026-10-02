/**
 * Receipt verification, docs/CONTRACT.md section 3.8. A row is paid only
 * when this returns `match` at `finalized` commitment; the finalized Receipt
 * account is the only proof of payment.
 *
 * Everything here is pure except `verifyReceipt` / `verifyRowReceipt`, which
 * read through the tiny injected `ReceiptRpc` interface (two calls:
 * `getGenesisHash` and a finalized `getAccountInfo`). `receiptRpcFromKit`
 * adapts a @solana/kit RPC client to it.
 */
import {
  address,
  getBase64Encoder,
  type Address,
  type GetAccountInfoApi,
  type GetGenesisHashApi,
  type Rpc,
} from "@solana/kit";
import { parseAtomicAmount } from "./amount.ts";
import { isStrictBase58 } from "./base58.ts";
import { genesisHashMatches, isCluster, TOKEN_PROGRAM_ADDRESS, type Cluster } from "./clusters.ts";
import {
  decodeReceipt,
  findReceiptPda,
  isReceiptAccount,
  payoutIdFromHex,
  RECEIPT_ACCOUNT_SIZE,
  type Pda,
  type Receipt,
} from "./program.ts";

// ---------------------------------------------------------------------------
// Step 1: deployment binding (pure, no chain read)
// ---------------------------------------------------------------------------

/** The deployment fields a row stores and the running config pins (section 3.8 step 1). */
export type DeploymentFields = {
  readonly cluster: Cluster;
  readonly genesisHash: string;
  readonly programId: string;
  readonly mint: string;
  readonly vault: string;
  readonly vaultTokenAccount: string;
};

/** The row fields receipt verification reads. */
export type ReceiptRow = DeploymentFields & {
  /** 64 lowercase hex. */
  readonly payoutIdHex: string;
  readonly recipient: string;
  readonly amountAtomic: bigint;
  /** The stored `solana_receipt_address`. */
  readonly receiptAddress: string;
};

export type DeploymentField = keyof DeploymentFields | "receiptAddress" | "payoutIdHex";

export type DeploymentBindingResult =
  | { readonly ok: true; readonly receipt: Pda }
  | { readonly ok: false; readonly reason: "deployment_mismatch"; readonly mismatched: readonly DeploymentField[] };

const DEPLOYMENT_KEYS: readonly (keyof DeploymentFields)[] = [
  "cluster",
  "genesisHash",
  "programId",
  "mint",
  "vault",
  "vaultTokenAccount",
];

/**
 * Section 3.8 step 1. Requires the row's cluster, genesis hash, program id,
 * mint, vault and vault token account to equal the running config (exact,
 * case-sensitive), then re-derives
 * `receipt = find_program_address(["receipt", row.vault, payout_id], row.programId)`
 * and requires it to equal the stored receipt address. Any difference is
 * `deployment_mismatch` (needs_review + CRITICAL + halt latch), with no chain read.
 */
export async function checkDeploymentBinding(
  row: ReceiptRow,
  running: DeploymentFields,
): Promise<DeploymentBindingResult> {
  const mismatched: DeploymentField[] = DEPLOYMENT_KEYS.filter((key) => row[key] !== running[key]);
  if (mismatched.length > 0) return { ok: false, reason: "deployment_mismatch", mismatched };
  if (!isCluster(row.cluster)) return { ok: false, reason: "deployment_mismatch", mismatched: ["cluster"] };
  if (!isStrictBase58(row.programId, 32)) return { ok: false, reason: "deployment_mismatch", mismatched: ["programId"] };
  if (!isStrictBase58(row.vault, 32)) return { ok: false, reason: "deployment_mismatch", mismatched: ["vault"] };
  let payoutId: Uint8Array;
  try {
    payoutId = payoutIdFromHex(row.payoutIdHex);
  } catch {
    return { ok: false, reason: "deployment_mismatch", mismatched: ["payoutIdHex"] };
  }
  const receipt = await findReceiptPda({
    programAddress: address(row.programId),
    vault: address(row.vault),
    payoutId,
  });
  if (receipt.address !== row.receiptAddress) {
    return { ok: false, reason: "deployment_mismatch", mismatched: ["receiptAddress"] };
  }
  return { ok: true, receipt };
}

// ---------------------------------------------------------------------------
// Steps 3 to 5: evaluate the fetched receipt account (pure)
// ---------------------------------------------------------------------------

export type ReceiptAccount = { readonly owner: string; readonly data: Uint8Array };

export type ReceiptMismatchReason =
  | "owner"
  | "length"
  | "discriminator"
  | "bump"
  | "payout_id"
  | "recipient"
  | "amount";

export type ReceiptCheck =
  | { readonly outcome: "absent" }
  | { readonly outcome: "match"; readonly receipt: Receipt }
  | {
      readonly outcome: "mismatch";
      readonly reasons: readonly ReceiptMismatchReason[];
      /** Present when the bytes could be decoded. */
      readonly receipt?: Receipt;
    };

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Section 3.8 steps 3 to 5 over an already-fetched account. `null` is
 * `absent`. Otherwise owner == program id, length 89, the Receipt
 * discriminator and the derived bump are required (step 4), then the decoded
 * `(payout_id, recipient, amount)` must equal the expected tuple (step 5).
 */
export function evaluateReceiptAccount(input: {
  account: ReceiptAccount | null;
  programId: string;
  bump: number;
  payoutId: Uint8Array;
  recipient: string;
  amountAtomic: bigint;
}): ReceiptCheck {
  const { account } = input;
  if (account === null) return { outcome: "absent" };
  const structural: ReceiptMismatchReason[] = [];
  if (account.owner !== input.programId) structural.push("owner");
  if (account.data.length !== RECEIPT_ACCOUNT_SIZE) structural.push("length");
  if (!isReceiptAccount(account.data)) structural.push("discriminator");
  if (account.data[8] !== input.bump) structural.push("bump");
  if (structural.length > 0) return { outcome: "mismatch", reasons: structural };
  const receipt = decodeReceipt(account.data);
  const tuple: ReceiptMismatchReason[] = [];
  if (!bytesEqual(receipt.payoutId, input.payoutId)) tuple.push("payout_id");
  if (receipt.recipient !== input.recipient) tuple.push("recipient");
  if (receipt.amount !== input.amountAtomic) tuple.push("amount");
  if (tuple.length > 0) return { outcome: "mismatch", reasons: tuple, receipt };
  return { outcome: "match", receipt };
}

// ---------------------------------------------------------------------------
// Token-balance cross-check over an already-fetched transaction meta (pure)
// ---------------------------------------------------------------------------

/** One entry of `meta.preTokenBalances` / `meta.postTokenBalances`. */
export type TokenBalanceEntry = {
  readonly accountIndex: number;
  readonly mint: string;
  readonly owner?: string;
  readonly programId?: string;
  readonly uiTokenAmount: { readonly amount: string };
};

export type TransactionMetaForCrossCheck = {
  readonly err: unknown;
  readonly preTokenBalances?: readonly TokenBalanceEntry[] | null;
  readonly postTokenBalances?: readonly TokenBalanceEntry[] | null;
  readonly loadedAddresses?: { readonly writable: readonly string[]; readonly readonly: readonly string[] } | null;
};

export type TokenBalanceMismatchReason =
  | "transaction_failed"
  | "balances_missing"
  | "vault_token_account_not_in_transaction"
  | "recipient_token_account_not_in_transaction"
  | "vault_delta"
  | "recipient_delta"
  | "wrong_mint"
  | "wrong_owner"
  | "wrong_token_program"
  /** A vault or recipient entry omits `owner` or `programId`, so neither can be confirmed. */
  | "balance_fields_missing"
  | "unexpected_balance_change";

export type TokenBalanceCrossCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: readonly TokenBalanceMismatchReason[] };

/**
 * Cross-checks a claim transaction's token movement from its pre/post token
 * balances. Unlike instruction parsing, this sees the program's CPI
 * `transfer_checked` too. Requires a successful transaction in which the
 * vault token account lost exactly `amountAtomic`, the recipient token
 * account gained exactly `amountAtomic` (a recipient ATA created in the same
 * transaction counts from 0), both under `mint`, the expected owners and
 * classic SPL Token, and no other account of `mint` changed. A vault or
 * recipient entry that omits `owner` or `programId` fails
 * (`balance_fields_missing`) instead of being skipped.
 *
 * Supplementary evidence only: the finalized Receipt (section 3.8) is the
 * proof of payment, because a transaction's meta can be pruned or truncated.
 */
export function crossCheckTokenBalances(input: {
  /** The message's static account keys, in order. Loaded addresses come from `meta`. */
  staticAccountKeys: readonly string[];
  meta: TransactionMetaForCrossCheck;
  mint: string;
  vault: string;
  vaultTokenAccount: string;
  recipient: string;
  recipientTokenAccount: string;
  amountAtomic: bigint;
}): TokenBalanceCrossCheck {
  const { meta } = input;
  if (meta.err !== null) return { ok: false, reasons: ["transaction_failed"] };
  const pre = meta.preTokenBalances;
  const post = meta.postTokenBalances;
  if (pre === undefined || pre === null || post === undefined || post === null) {
    return { ok: false, reasons: ["balances_missing"] };
  }
  const keys = [
    ...input.staticAccountKeys,
    ...(meta.loadedAddresses?.writable ?? []),
    ...(meta.loadedAddresses?.readonly ?? []),
  ];
  const reasons = new Set<TokenBalanceMismatchReason>();
  type Balance = { amount: bigint; entry: TokenBalanceEntry };
  const index = (entries: readonly TokenBalanceEntry[]): Map<string, Balance> => {
    const byAddress = new Map<string, Balance>();
    for (const entry of entries) {
      const key = keys[entry.accountIndex];
      if (key === undefined) {
        reasons.add("unexpected_balance_change");
        continue;
      }
      let amount: bigint;
      try {
        amount = parseAtomicAmount(entry.uiTokenAmount.amount);
      } catch {
        reasons.add("unexpected_balance_change");
        continue;
      }
      byAddress.set(key, { amount, entry });
    }
    return byAddress;
  };
  const preBy = index(pre);
  const postBy = index(post);

  const checkEntry = (balance: Balance | undefined, owner: string): void => {
    if (balance === undefined) return;
    if (balance.entry.mint !== input.mint) reasons.add("wrong_mint");
    // Fail closed: an entry without `owner` or `programId` (older RPC nodes, a
    // trimmed or hand-built meta) cannot prove either, so it never passes.
    if (balance.entry.owner === undefined || balance.entry.programId === undefined) {
      reasons.add("balance_fields_missing");
    }
    if (balance.entry.owner !== undefined && balance.entry.owner !== owner) reasons.add("wrong_owner");
    if (balance.entry.programId !== undefined && balance.entry.programId !== TOKEN_PROGRAM_ADDRESS) {
      reasons.add("wrong_token_program");
    }
  };

  const vaultPre = preBy.get(input.vaultTokenAccount);
  const vaultPost = postBy.get(input.vaultTokenAccount);
  if (vaultPre === undefined || vaultPost === undefined) {
    reasons.add("vault_token_account_not_in_transaction");
  } else if (vaultPre.amount - vaultPost.amount !== input.amountAtomic) {
    reasons.add("vault_delta");
  }
  checkEntry(vaultPre, input.vault);
  checkEntry(vaultPost, input.vault);

  const recipientPre = preBy.get(input.recipientTokenAccount);
  const recipientPost = postBy.get(input.recipientTokenAccount);
  if (recipientPost === undefined) {
    reasons.add("recipient_token_account_not_in_transaction");
  } else if (recipientPost.amount - (recipientPre?.amount ?? 0n) !== input.amountAtomic) {
    reasons.add("recipient_delta");
  }
  checkEntry(recipientPre, input.recipient);
  checkEntry(recipientPost, input.recipient);

  const touched = new Set([...preBy.keys(), ...postBy.keys()]);
  for (const key of touched) {
    if (key === input.vaultTokenAccount || key === input.recipientTokenAccount) continue;
    const before = preBy.get(key);
    const after = postBy.get(key);
    const mint = (after ?? before)?.entry.mint;
    if (mint !== input.mint) continue;
    if ((before?.amount ?? 0n) !== (after?.amount ?? 0n)) reasons.add("unexpected_balance_change");
  }

  return reasons.size === 0 ? { ok: true } : { ok: false, reasons: [...reasons] };
}

// ---------------------------------------------------------------------------
// The I/O wrapper behind an injected interface
// ---------------------------------------------------------------------------

/** The two reads receipt verification needs. */
export interface ReceiptRpc {
  getGenesisHash(): Promise<string>;
  /** `getAccountInfo(address, { commitment: "finalized", encoding: "base64", minContextSlot })`. */
  getFinalizedAccount(
    accountAddress: Address,
    options: { minContextSlot?: bigint },
  ): Promise<{ contextSlot: bigint; account: ReceiptAccount | null }>;
}

export type VerifyReceiptResult =
  | { readonly outcome: "genesis_mismatch"; readonly observedGenesisHash: string }
  | {
      /**
       * The RPC answered from a slot older than the requested `minContextSlot`
       * (an adapter or provider that ignored it). The account is not
       * evaluated: treat this like an RPC error (section 9.2, nothing changes,
       * retry next tick), never as `absent` or `match`.
       */
      readonly outcome: "stale_read";
      readonly receiptAddress: Address;
      readonly bump: number;
      readonly contextSlot: bigint;
      readonly minContextSlot: bigint;
    }
  | (ReceiptCheck & {
      readonly receiptAddress: Address;
      readonly bump: number;
      readonly contextSlot: bigint;
    });

/**
 * Section 3.8 steps 2 to 5 for an SDK caller that passes `programId`, `vault`
 * and `payoutId` explicitly: checks the RPC's genesis hash, derives the
 * receipt PDA, reads it at `finalized` (with `minContextSlot` if given) and
 * evaluates it. When `minContextSlot` is given, a read whose context slot is
 * lower (or not a bigint) is `stale_read` and is never evaluated, so a stale
 * view can never yield `absent` or `match` (section 9.2 step 2: the receipt
 * read is never older than the height read).
 */
export async function verifyReceipt(input: {
  rpc: ReceiptRpc;
  cluster: Cluster;
  programId: Address;
  vault: Address;
  payoutId: Uint8Array;
  recipient: string;
  amountAtomic: bigint;
  minContextSlot?: bigint;
}): Promise<VerifyReceiptResult> {
  const observedGenesisHash = await input.rpc.getGenesisHash();
  if (!genesisHashMatches(input.cluster, observedGenesisHash)) {
    return { outcome: "genesis_mismatch", observedGenesisHash };
  }
  const pda = await findReceiptPda({
    programAddress: input.programId,
    vault: input.vault,
    payoutId: input.payoutId,
  });
  const read = await input.rpc.getFinalizedAccount(
    pda.address,
    input.minContextSlot === undefined ? {} : { minContextSlot: input.minContextSlot },
  );
  if (
    input.minContextSlot !== undefined &&
    !(typeof read.contextSlot === "bigint" && read.contextSlot >= input.minContextSlot)
  ) {
    return {
      outcome: "stale_read",
      receiptAddress: pda.address,
      bump: pda.bump,
      contextSlot: read.contextSlot,
      minContextSlot: input.minContextSlot,
    };
  }
  const check = evaluateReceiptAccount({
    account: read.account,
    programId: input.programId,
    bump: pda.bump,
    payoutId: input.payoutId,
    recipient: input.recipient,
    amountAtomic: input.amountAtomic,
  });
  return { ...check, receiptAddress: pda.address, bump: pda.bump, contextSlot: read.contextSlot };
}

export type VerifyRowReceiptResult =
  | { readonly outcome: "deployment_mismatch"; readonly mismatched: readonly DeploymentField[] }
  | VerifyReceiptResult;

/**
 * The full section 3.8 procedure for a stored row: deployment binding first
 * (no chain read on any difference), then `verifyReceipt` with the row's own
 * program id, vault and payout id.
 */
export async function verifyRowReceipt(input: {
  rpc: ReceiptRpc;
  row: ReceiptRow;
  running: DeploymentFields;
  minContextSlot?: bigint;
}): Promise<VerifyRowReceiptResult> {
  const binding = await checkDeploymentBinding(input.row, input.running);
  // `=== false`, not `!binding.ok`: the vendoring API typechecks with
  // strictNullChecks off, where negation does not narrow the union.
  if (binding.ok === false) return { outcome: "deployment_mismatch", mismatched: binding.mismatched };
  return verifyReceipt({
    rpc: input.rpc,
    cluster: input.row.cluster,
    programId: address(input.row.programId),
    vault: address(input.row.vault),
    payoutId: payoutIdFromHex(input.row.payoutIdHex),
    recipient: input.row.recipient,
    amountAtomic: input.row.amountAtomic,
    ...(input.minContextSlot === undefined ? {} : { minContextSlot: input.minContextSlot }),
  });
}

/** Adapts a @solana/kit RPC client to `ReceiptRpc`. */
export function receiptRpcFromKit(rpc: Rpc<GetGenesisHashApi & GetAccountInfoApi>): ReceiptRpc {
  const base64 = getBase64Encoder();
  return {
    async getGenesisHash() {
      return rpc.getGenesisHash().send();
    },
    async getFinalizedAccount(accountAddress, options) {
      const response = await rpc
        .getAccountInfo(accountAddress, {
          commitment: "finalized",
          encoding: "base64",
          ...(options.minContextSlot === undefined ? {} : { minContextSlot: options.minContextSlot }),
        })
        .send();
      const value = response.value;
      return {
        contextSlot: response.context.slot,
        account:
          value === null
            ? null
            : { owner: value.owner, data: Uint8Array.from(base64.encode(value.data[0])) },
      };
    },
  };
}
