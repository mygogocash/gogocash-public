/**
 * The RPC surface of the devnet demo (`npm run demo`, plan step R5, #2983),
 * behind an injected interface so tests pass a fake chain and nothing here
 * opens a connection by itself:
 *
 * - the operator CLI's reads and sends (`AdminRpc`);
 * - the keyless verifier's finalized reads (`VerifierRpc`);
 * - the three calls a claim needs: the rent-exempt minimum, recent priority
 *   fees, and the unsigned simulation of docs/CONTRACT.md section 9.1 step 5
 *   (all-zero signatures, `sigVerify: false`, `replaceRecentBlockhash: true`).
 *
 * The RPC URL never passes through this module: `demoRpcFromKit` receives an
 * already-built client.
 */
import {
  address,
  type Address,
  type Base64EncodedWireTransaction,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import { adminRpcFromKit, type AdminCommitment, type AdminRpc } from "../admin/rpc.ts";
import { verifierRpcFromKit, type VerifierRpc } from "../admin/verify.ts";

/** The part of a `simulateTransaction` result the demo reads. */
export type DemoSimulation = {
  /** `null` when the simulation succeeded. */
  readonly err: unknown;
  readonly logs: readonly string[] | null;
  readonly unitsConsumed: bigint | null;
};

export interface DemoRpc extends AdminRpc, VerifierRpc {
  /** `getMinimumBalanceForRentExemption(size)` at `confirmed`. */
  getMinimumBalanceForRentExemption(size: bigint): Promise<bigint>;
  /** `getRecentPrioritizationFees(addresses)`. */
  getRecentPrioritizationFees(addresses: readonly Address[]): Promise<readonly { readonly prioritizationFee: bigint }[]>;
  /**
   * Simulates unsigned wire bytes (all-zero signatures) with
   * `sigVerify: false`, `replaceRecentBlockhash: true` at `confirmed`. A
   * signed transaction is never simulated (review SEC-13).
   */
  simulateUnsigned(wireBase64: string): Promise<DemoSimulation>;
}

// ---------------------------------------------------------------------------
// Clock sysvar (pure decode)
// ---------------------------------------------------------------------------

export const SYSVAR_CLOCK_ADDRESS: Address = address("SysvarC1ock11111111111111111111111111111111");
export const SYSVAR_PROGRAM_ADDRESS: Address = address("Sysvar1111111111111111111111111111111111111");
/** `slot: u64, epoch_start_timestamp: i64, epoch: u64, leader_schedule_epoch: u64, unix_timestamp: i64`. */
export const CLOCK_SYSVAR_SIZE = 40;

export class ClockDecodeError extends Error {
  override name = "ClockDecodeError";
}

/** The cluster Clock's `unix_timestamp` (offset 32, little-endian i64). */
export function decodeClockUnixTimestamp(account: { readonly owner: string; readonly data: Uint8Array } | null): bigint {
  if (account === null) throw new ClockDecodeError("the Clock sysvar account was not returned.");
  if (account.owner !== SYSVAR_PROGRAM_ADDRESS) throw new ClockDecodeError("the Clock account is not owned by the sysvar program.");
  if (account.data.length !== CLOCK_SYSVAR_SIZE) throw new ClockDecodeError(`the Clock sysvar is ${CLOCK_SYSVAR_SIZE} bytes, got ${account.data.length}.`);
  return new DataView(account.data.buffer, account.data.byteOffset, account.data.byteLength).getBigInt64(32, true);
}

/** Reads the cluster Clock at `commitment` and returns its `unix_timestamp` (section 9.1 step 4). */
export async function readClockUnixTimestamp(rpc: AdminRpc, commitment: AdminCommitment = "confirmed"): Promise<bigint> {
  const read = await rpc.getAccount(SYSVAR_CLOCK_ADDRESS, commitment);
  return decodeClockUnixTimestamp(read.account);
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

function toBigint(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  return null;
}

/** Adapts a @solana/kit RPC client to `DemoRpc`. */
export function demoRpcFromKit(rpc: Rpc<SolanaRpcApi>): DemoRpc {
  const admin = adminRpcFromKit(rpc);
  const verifier = verifierRpcFromKit(rpc);
  return {
    getGenesisHash: admin.getGenesisHash,
    getAccount: admin.getAccount,
    getLatestBlockhash: admin.getLatestBlockhash,
    getBlockHeight: admin.getBlockHeight,
    sendTransaction: admin.sendTransaction,
    getSignatureStatus: admin.getSignatureStatus,
    getFinalizedAccount: verifier.getFinalizedAccount,
    getFinalizedTransaction: verifier.getFinalizedTransaction,
    async getMinimumBalanceForRentExemption(size) {
      const lamports = await rpc.getMinimumBalanceForRentExemption(size, { commitment: "confirmed" }).send();
      return BigInt(lamports);
    },
    async getRecentPrioritizationFees(addresses) {
      const fees = await rpc.getRecentPrioritizationFees(addresses).send();
      return fees.map((fee) => ({ prioritizationFee: BigInt(fee.prioritizationFee) }));
    },
    async simulateUnsigned(wireBase64) {
      const response = await rpc
        .simulateTransaction(wireBase64 as Base64EncodedWireTransaction, {
          encoding: "base64",
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: "confirmed",
        })
        .send();
      const value = response.value;
      return {
        err: value.err,
        logs: value.logs === null ? null : [...value.logs],
        unitsConsumed: toBigint(value.unitsConsumed),
      };
    },
  };
}
