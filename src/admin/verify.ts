/**
 * The keyless devnet payout verifier (`npm run verify:devnet`), on top of the
 * section 3.8 receipt verification in ../verify-receipt.ts.
 *
 * Given a receipt address or a claim transaction signature, it finds which
 * vault of `release/manifest.json` the receipt belongs to by re-deriving
 * `["receipt", vault, payout_id]` under the manifest's program id for each
 * vault, then runs `verifyReceipt` at `finalized` and reports the mint and the
 * `(recipient, amount, payout_id)` tuple. It never needs a key, and it reads
 * through an injected RPC interface (tests pass a fake).
 */
import {
  getBase58Encoder,
  type Address,
  type GetAccountInfoApi,
  type GetGenesisHashApi,
  type GetTransactionApi,
  type Rpc,
  type Signature,
} from "@solana/kit";
import { genesisHashMatches, type Cluster } from "../clusters.ts";
import { CLAIM_DISCRIMINATOR, getClaimInstructionDataDecoder } from "../generated/instructions/claim.ts";
import {
  decodeReceipt,
  findReceiptPda,
  isReceiptAccount,
  payoutIdToHex,
  RECEIPT_ACCOUNT_SIZE,
  type Receipt,
} from "../program.ts";
import {
  crossCheckTokenBalances,
  receiptRpcFromKit,
  verifyReceipt,
  type ReceiptAccount,
  type ReceiptMismatchReason,
  type ReceiptRpc,
  type TokenBalanceCrossCheck,
  type TransactionMetaForCrossCheck,
} from "../verify-receipt.ts";

export type VaultRef = {
  readonly name: string;
  readonly vault: Address;
  readonly mint: Address;
  readonly vaultTokenAccount: Address;
};

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

export type ReceiptLocation =
  | { readonly ok: true; readonly vault: VaultRef; readonly receipt: Receipt; readonly bump: number }
  | { readonly ok: false; readonly reason: "owner" | "length" | "discriminator" | "unbound" | "bump" };

/**
 * Decodes a receipt account (owner = program id, 89 bytes, Receipt
 * discriminator) and finds the manifest vault whose
 * `["receipt", vault, payout_id]` PDA is `receiptAddress`, with the canonical
 * bump stored at byte 8.
 */
export async function locateReceiptVault(input: {
  readonly programId: Address;
  readonly vaults: readonly VaultRef[];
  readonly receiptAddress: Address;
  readonly account: ReceiptAccount;
}): Promise<ReceiptLocation> {
  const { account } = input;
  if (account.owner !== input.programId) return { ok: false, reason: "owner" };
  if (account.data.length !== RECEIPT_ACCOUNT_SIZE) return { ok: false, reason: "length" };
  if (!isReceiptAccount(account.data)) return { ok: false, reason: "discriminator" };
  const receipt = decodeReceipt(account.data);
  for (const vault of input.vaults) {
    const pda = await findReceiptPda({ programAddress: input.programId, vault: vault.vault, payoutId: receipt.payoutId });
    if (pda.address === input.receiptAddress) {
      if (receipt.bump !== pda.bump) return { ok: false, reason: "bump" };
      return { ok: true, vault, receipt, bump: pda.bump };
    }
  }
  return { ok: false, reason: "unbound" };
}

export type TransactionView = {
  readonly slot: bigint;
  /** The message's static account keys, in order. */
  readonly staticAccountKeys: readonly string[];
  readonly instructions: readonly {
    readonly programIdIndex: number;
    readonly accounts: readonly number[];
    readonly data: Uint8Array;
  }[];
  readonly meta: TransactionMetaForCrossCheck | null;
};

export type ClaimInTransaction = {
  readonly instructionIndex: number;
  readonly vault: string;
  readonly receipt: string;
  readonly mint: string;
  readonly vaultTokenAccount: string;
  readonly recipient: string;
  readonly recipientTokenAccount: string;
  readonly payoutId: Uint8Array;
  readonly amount: bigint;
  readonly expiresAt: bigint;
};

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * Every top-level `claim` instruction of `programId` in a transaction, with
 * its accounts resolved (static keys, then loaded writable, then loaded
 * readonly addresses) and its data decoded. Instructions with a wrong length,
 * discriminator or account count are skipped.
 */
export function extractClaims(transaction: TransactionView, programId: Address): ClaimInTransaction[] {
  const keys = [
    ...transaction.staticAccountKeys,
    ...(transaction.meta?.loadedAddresses?.writable ?? []),
    ...(transaction.meta?.loadedAddresses?.readonly ?? []),
  ];
  const decoder = getClaimInstructionDataDecoder();
  const claims: ClaimInTransaction[] = [];
  transaction.instructions.forEach((instruction, instructionIndex) => {
    if (keys[instruction.programIdIndex] !== programId) return;
    if (instruction.data.length !== 56 || !bytesEqual(instruction.data.subarray(0, 8), Uint8Array.from(CLAIM_DISCRIMINATOR))) {
      return;
    }
    if (instruction.accounts.length !== 10) return;
    const account = (position: number): string | undefined => {
      const index = instruction.accounts[position];
      return index === undefined ? undefined : keys[index];
    };
    const resolved = [0, 1, 2, 3, 4, 5].map(account);
    if (resolved.some((value) => value === undefined)) return;
    const [vault, receipt, mint, vaultTokenAccount, recipient, recipientTokenAccount] = resolved as string[];
    const data = decoder.decode(instruction.data);
    claims.push({
      instructionIndex,
      vault: vault!,
      receipt: receipt!,
      mint: mint!,
      vaultTokenAccount: vaultTokenAccount!,
      recipient: recipient!,
      recipientTokenAccount: recipientTokenAccount!,
      payoutId: Uint8Array.from(data.payoutId),
      amount: data.amount,
      expiresAt: data.expiresAt,
    });
  });
  return claims;
}

// ---------------------------------------------------------------------------
// The verifier over an injected RPC
// ---------------------------------------------------------------------------

export interface VerifierRpc extends ReceiptRpc {
  /** `getTransaction(signature, { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 })`. */
  getFinalizedTransaction(signature: string): Promise<TransactionView | null>;
}

export type Expectation = {
  readonly recipient?: string;
  readonly amountAtomic?: bigint;
  readonly payoutIdHex?: string;
};

export type VerifiedPayout = {
  readonly vault: VaultRef;
  readonly receipt: string;
  readonly payoutIdHex: string;
  readonly recipient: string;
  readonly amountAtomic: bigint;
  readonly claimedAt: bigint;
  readonly contextSlot: bigint;
};

export type VerifyDevnetResult =
  | { readonly status: "paid"; readonly payout: VerifiedPayout; readonly transaction?: TransactionEvidence }
  | {
      readonly status: "mismatch";
      readonly reasons: readonly (ReceiptMismatchReason | "receipt_address" | "unbound")[];
      readonly receipt: string;
      readonly decoded?: Omit<VerifiedPayout, "vault" | "contextSlot" | "receipt">;
      readonly transaction?: TransactionEvidence;
    }
  | { readonly status: "absent"; readonly receipt: string; readonly contextSlot: bigint }
  | { readonly status: "genesis_mismatch"; readonly observedGenesisHash: string }
  | { readonly status: "stale_read"; readonly receipt: string }
  | { readonly status: "transaction_not_found"; readonly signature: string }
  | { readonly status: "not_a_claim"; readonly signature: string; readonly claims: number };

export type TransactionEvidence = {
  readonly signature: string;
  readonly slot: bigint;
  /** `meta.err === null`: this transaction itself succeeded. */
  readonly succeeded: boolean;
  /** Supplementary only: the finalized receipt is the proof of payment. */
  readonly tokenBalances: TokenBalanceCrossCheck | null;
};

const CLUSTER: Cluster = "devnet";

async function verifyAt(input: {
  rpc: ReceiptRpc;
  programId: Address;
  vaults: readonly VaultRef[];
  receiptAddress: Address;
  expect: Expectation;
  transaction?: TransactionEvidence;
}): Promise<VerifyDevnetResult> {
  const read = await input.rpc.getFinalizedAccount(input.receiptAddress, {});
  if (read.account === null) return { status: "absent", receipt: input.receiptAddress, contextSlot: read.contextSlot };
  const location = await locateReceiptVault({
    programId: input.programId,
    vaults: input.vaults,
    receiptAddress: input.receiptAddress,
    account: read.account,
  });
  const extra = input.transaction === undefined ? {} : { transaction: input.transaction };
  // `=== false`, not `!location.ok`: the vendoring API typechecks with
  // strictNullChecks off, where negation does not narrow the union.
  if (location.ok === false) {
    return {
      status: "mismatch",
      reasons: [location.reason === "unbound" ? "unbound" : location.reason],
      receipt: input.receiptAddress,
      ...extra,
    };
  }
  const { receipt, vault } = location;
  const decoded = {
    payoutIdHex: receipt.payoutIdHex,
    recipient: receipt.recipient,
    amountAtomic: receipt.amount,
    claimedAt: receipt.claimedAt,
  };
  if (input.expect.payoutIdHex !== undefined && input.expect.payoutIdHex !== receipt.payoutIdHex) {
    return { status: "mismatch", reasons: ["payout_id"], receipt: input.receiptAddress, decoded, ...extra };
  }
  const result = await verifyReceipt({
    rpc: input.rpc,
    cluster: CLUSTER,
    programId: input.programId,
    vault: vault.vault,
    payoutId: receipt.payoutId,
    recipient: input.expect.recipient ?? receipt.recipient,
    amountAtomic: input.expect.amountAtomic ?? receipt.amount,
    minContextSlot: read.contextSlot,
  });
  switch (result.outcome) {
    case "genesis_mismatch":
      return { status: "genesis_mismatch", observedGenesisHash: result.observedGenesisHash };
    case "stale_read":
      return { status: "stale_read", receipt: input.receiptAddress };
    case "absent":
      return { status: "absent", receipt: input.receiptAddress, contextSlot: result.contextSlot };
    case "mismatch":
      return { status: "mismatch", reasons: result.reasons, receipt: input.receiptAddress, decoded, ...extra };
    case "match":
      if (result.receiptAddress !== input.receiptAddress) {
        return { status: "mismatch", reasons: ["receipt_address"], receipt: input.receiptAddress, decoded, ...extra };
      }
      return {
        status: "paid",
        payout: { vault, receipt: input.receiptAddress, contextSlot: result.contextSlot, ...decoded },
        ...extra,
      };
  }
}

/** `--receipt <address>`: verify a receipt account against every manifest vault. */
export async function verifyDevnetReceipt(input: {
  readonly rpc: VerifierRpc;
  readonly programId: Address;
  readonly vaults: readonly VaultRef[];
  readonly receiptAddress: Address;
  readonly expect?: Expectation;
}): Promise<VerifyDevnetResult> {
  const observedGenesisHash = await input.rpc.getGenesisHash();
  if (!genesisHashMatches(CLUSTER, observedGenesisHash)) return { status: "genesis_mismatch", observedGenesisHash };
  return verifyAt({ ...input, expect: input.expect ?? {} });
}

/**
 * `--signature <sig>`: read the finalized transaction, take its one `claim`
 * instruction, and verify that claim's receipt with the claim's own
 * `(recipient, amount, payout_id)` as the expectation (each overridable).
 * The pre/post token balances are cross-checked as supplementary evidence.
 */
export async function verifyDevnetSignature(input: {
  readonly rpc: VerifierRpc;
  readonly programId: Address;
  readonly vaults: readonly VaultRef[];
  readonly signature: string;
  readonly expect?: Expectation;
}): Promise<VerifyDevnetResult> {
  const observedGenesisHash = await input.rpc.getGenesisHash();
  if (!genesisHashMatches(CLUSTER, observedGenesisHash)) return { status: "genesis_mismatch", observedGenesisHash };
  const transaction = await input.rpc.getFinalizedTransaction(input.signature);
  if (transaction === null) return { status: "transaction_not_found", signature: input.signature };
  const claims = extractClaims(transaction, input.programId);
  const claim = claims[0];
  if (claims.length !== 1 || claim === undefined) {
    return { status: "not_a_claim", signature: input.signature, claims: claims.length };
  }
  const vault = input.vaults.find((v) => v.vault === claim.vault);
  const evidence: TransactionEvidence = {
    signature: input.signature,
    slot: transaction.slot,
    succeeded: transaction.meta !== null && transaction.meta.err === null,
    tokenBalances:
      transaction.meta === null || vault === undefined
        ? null
        : crossCheckTokenBalances({
            staticAccountKeys: transaction.staticAccountKeys,
            meta: transaction.meta,
            mint: vault.mint,
            vault: vault.vault,
            vaultTokenAccount: vault.vaultTokenAccount,
            recipient: claim.recipient,
            recipientTokenAccount: claim.recipientTokenAccount,
            amountAtomic: claim.amount,
          }),
  };
  if (vault === undefined || claim.mint !== vault.mint) {
    return { status: "mismatch", reasons: ["unbound"], receipt: claim.receipt, transaction: evidence };
  }
  return verifyAt({
    rpc: input.rpc,
    programId: input.programId,
    vaults: input.vaults,
    receiptAddress: claim.receipt as Address,
    expect: {
      recipient: input.expect?.recipient ?? claim.recipient,
      amountAtomic: input.expect?.amountAtomic ?? claim.amount,
      payoutIdHex: input.expect?.payoutIdHex ?? payoutIdToHex(claim.payoutId),
    },
    transaction: evidence,
  });
}

/** Adapts a @solana/kit RPC client to `VerifierRpc` (reads at `finalized` only). */
export function verifierRpcFromKit(rpc: Rpc<GetGenesisHashApi & GetAccountInfoApi & GetTransactionApi>): VerifierRpc {
  const receiptRpc = receiptRpcFromKit(rpc);
  const base58 = getBase58Encoder();
  return {
    ...receiptRpc,
    async getFinalizedTransaction(signature) {
      const response = await rpc
        .getTransaction(signature as Signature, {
          commitment: "finalized",
          encoding: "json",
          maxSupportedTransactionVersion: 0,
        })
        .send();
      if (response === null) return null;
      const message = response.transaction.message;
      const meta = response.meta;
      return {
        slot: response.slot,
        staticAccountKeys: message.accountKeys,
        instructions: message.instructions.map((instruction) => ({
          programIdIndex: instruction.programIdIndex,
          accounts: instruction.accounts,
          data: Uint8Array.from(base58.encode(instruction.data)),
        })),
        meta:
          meta === null
            ? null
            : {
                err: meta.err,
                preTokenBalances: meta.preTokenBalances ?? null,
                postTokenBalances: meta.postTokenBalances ?? null,
                loadedAddresses: meta.loadedAddresses ?? null,
              },
      };
    },
  };
}

/** Plain-JSON form of a result (bigints as decimal strings). */
export function verifyResultToJson(result: VerifyDevnetResult): unknown {
  return JSON.parse(JSON.stringify(result, (_key, value: unknown) => (typeof value === "bigint" ? value.toString(10) : value)));
}
