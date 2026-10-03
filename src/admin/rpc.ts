/**
 * The small RPC surface the operator CLI uses, behind an injected interface
 * (tests pass a fake; nothing here opens a connection by itself), plus the
 * send-and-confirm loop over it and the adapter for a @solana/kit client.
 *
 * The RPC URL never passes through this module: the adapter receives an
 * already-built client.
 */
import {
  getBase64Encoder,
  type Address,
  type Base64EncodedWireTransaction,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
} from "@solana/kit";

export type AdminCommitment = "confirmed" | "finalized";

export type AdminAccount = {
  readonly owner: string;
  readonly executable: boolean;
  readonly lamports: bigint;
  readonly data: Uint8Array;
};

export type SignatureStatusView = {
  readonly confirmationStatus: "processed" | "confirmed" | "finalized" | null;
  /** `null` when the transaction succeeded. */
  readonly err: unknown;
};

export interface AdminRpc {
  getGenesisHash(): Promise<string>;
  /** `getAccountInfo(address, { commitment, encoding: "base64" })`. */
  getAccount(
    accountAddress: Address,
    commitment: AdminCommitment,
  ): Promise<{ readonly contextSlot: bigint; readonly account: AdminAccount | null }>;
  getLatestBlockhash(
    commitment: AdminCommitment,
  ): Promise<{ readonly blockhash: string; readonly lastValidBlockHeight: bigint }>;
  getBlockHeight(commitment: AdminCommitment): Promise<bigint>;
  /** Sends base64 wire bytes with preflight at `confirmed`; returns the signature. */
  sendTransaction(wireBase64: string): Promise<string>;
  /** `getSignatureStatuses([signature])[0]`. */
  getSignatureStatus(signature: string): Promise<SignatureStatusView | null>;
}

export class TransactionFailedError extends Error {
  override name = "TransactionFailedError";
  readonly signature: string;
  readonly err: unknown;

  constructor(signature: string, err: unknown) {
    super(`transaction ${signature} failed: ${safeStringify(err)}`);
    this.signature = signature;
    this.err = err;
  }
}

export class TransactionExpiredError extends Error {
  override name = "TransactionExpiredError";
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return String(value);
  }
}

const RANK = { processed: 0, confirmed: 1, finalized: 2 } as const;

/**
 * Sends signed wire bytes and waits until the signature reaches
 * `commitment`. A failed transaction throws `TransactionFailedError`; a
 * signature still unknown after the block height passed
 * `lastValidBlockHeight` throws `TransactionExpiredError` (the transaction
 * can no longer land, so the caller may rebuild it). `sleep` is injected.
 */
export async function sendAndConfirm(input: {
  readonly rpc: AdminRpc;
  readonly wireBase64: string;
  readonly signature: string;
  readonly lastValidBlockHeight: bigint;
  readonly commitment: AdminCommitment;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pollIntervalMs?: number;
  readonly maxPolls?: number;
}): Promise<{ readonly signature: string }> {
  const sent = await input.rpc.sendTransaction(input.wireBase64);
  if (sent !== input.signature) {
    throw new Error("the RPC returned a different signature than the signed transaction's.");
  }
  const maxPolls = input.maxPolls ?? 600;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    const status = await input.rpc.getSignatureStatus(input.signature);
    if (status !== null) {
      if (status.err !== null && status.err !== undefined) throw new TransactionFailedError(input.signature, status.err);
      const reached = status.confirmationStatus === null ? -1 : RANK[status.confirmationStatus];
      if (reached >= RANK[input.commitment]) return { signature: input.signature };
    } else if ((await input.rpc.getBlockHeight("confirmed")) > input.lastValidBlockHeight) {
      throw new TransactionExpiredError(
        `transaction ${input.signature} was not seen before its blockhash expired; nothing landed, rebuild and resend.`,
      );
    }
    await input.sleep(input.pollIntervalMs ?? 1000);
  }
  throw new TransactionExpiredError(`transaction ${input.signature} did not reach ${input.commitment} in time; check it before resending.`);
}

/** Adapts a @solana/kit RPC client to `AdminRpc`. */
export function adminRpcFromKit(rpc: Rpc<SolanaRpcApi>): AdminRpc {
  const base64 = getBase64Encoder();
  return {
    async getGenesisHash() {
      return rpc.getGenesisHash().send();
    },
    async getAccount(accountAddress, commitment) {
      const response = await rpc.getAccountInfo(accountAddress, { commitment, encoding: "base64" }).send();
      const value = response.value;
      return {
        contextSlot: response.context.slot,
        account:
          value === null
            ? null
            : {
                owner: value.owner,
                executable: value.executable,
                lamports: value.lamports,
                data: Uint8Array.from(base64.encode(value.data[0])),
              },
      };
    },
    async getLatestBlockhash(commitment) {
      const response = await rpc.getLatestBlockhash({ commitment }).send();
      return {
        blockhash: response.value.blockhash,
        lastValidBlockHeight: response.value.lastValidBlockHeight,
      };
    },
    async getBlockHeight(commitment) {
      return rpc.getBlockHeight({ commitment }).send();
    },
    async sendTransaction(wireBase64) {
      return rpc
        .sendTransaction(wireBase64 as Base64EncodedWireTransaction, {
          encoding: "base64",
          preflightCommitment: "confirmed",
        })
        .send();
    },
    async getSignatureStatus(signature) {
      const response = await rpc.getSignatureStatuses([signature as Signature]).send();
      const status = response.value[0] ?? null;
      if (status === null) return null;
      return { confirmationStatus: status.confirmationStatus ?? null, err: status.err };
    },
  };
}
