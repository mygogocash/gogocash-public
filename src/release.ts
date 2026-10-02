/**
 * The release proof assessor, docs/CONTRACT.md section 9.5: a reservation is
 * returned only when the chain proves the payout can never land.
 *
 * This module is the pure part. The caller does the reads (genesis, finalized
 * epoch info and Clock, `isBlockhashValid` at `processed`, signature statuses
 * with history, the receipt PDA at `finalized`) and decodes each attempt's
 * `wire_base64` (first signature, blockhash, `expires_at` from the `claim`
 * data). The assessor then evaluates the five conditions over those
 * observations and reports every condition that failed.
 */
import { genesisHashMatches, type Cluster } from "./clusters.ts";

export type ReleaseCondition = "P1" | "P2" | "P3" | "P4" | "P5";

/** Slack added to the largest `expires_at` in P3 (section 9.5). */
export const RELEASE_EXPIRY_SLACK_SECONDS = 120n;

export type ReleaseAttemptObservation = {
  /** The attempt's first signature, base58, as decoded from its wire bytes. */
  readonly signature: string;
  /** From the attempt record (persisted from the same `getLatestBlockhash`). */
  readonly lastValidBlockHeight: bigint;
  /** `expires_at` decoded from the wire's `claim` instruction data. */
  readonly expiresAt: bigint;
  /** `isBlockhashValid(wireBlockhash, { commitment: "processed" })`. */
  readonly blockhashValidAtProcessed: boolean;
  /**
   * `getSignatureStatuses([signature], { searchTransactionHistory: true })`
   * entry: `null` if unknown, otherwise its `err` (`null` means success).
   */
  readonly status: null | { readonly err: unknown };
};

export type ReleaseObservation = {
  readonly cluster: Cluster;
  /** `getGenesisHash` result from the RPC used for this assessment. */
  readonly genesisHash: string;
  /** Finalized block height `H` and the slot it was observed at. */
  readonly finalizedBlockHeight: bigint;
  readonly finalizedSlot: bigint;
  /** Finalized Clock sysvar `unix_timestamp`. */
  readonly finalizedUnixTimestamp: bigint;
  readonly attempts: readonly ReleaseAttemptObservation[];
  /** The receipt PDA read at `finalized`. */
  readonly receipt: { readonly absent: boolean; readonly contextSlot: bigint };
};

export type ReleaseAssessment = {
  /** True only if the cluster allows release and all five conditions hold. */
  readonly provable: boolean;
  /** Set when v0 policy refuses release on this cluster, whatever the conditions say. */
  readonly refusal: "mainnet_release_disabled" | null;
  /** Every condition that failed, in P1..P5 order. Empty when provable. */
  readonly failed: readonly ReleaseCondition[];
  /** `null` when there are no attempts. */
  readonly maxLastValidBlockHeight: bigint | null;
  readonly maxExpiresAt: bigint | null;
  /** The k signatures the assessment covered (for `solana_release_proof`). */
  readonly signaturesChecked: readonly string[];
};

function maxOf(values: readonly bigint[]): bigint | null {
  let max: bigint | null = null;
  for (const value of values) {
    if (max === null || value > max) max = value;
  }
  return max;
}

/**
 * Evaluates P1 to P5 of section 9.5:
 *
 * - P1: the RPC genesis hash equals the pinned genesis of the cluster.
 * - P2: `H > max(last_valid_block_height)` and every wire blockhash is not
 *   valid at `processed`.
 * - P3: finalized Clock `unix_timestamp > max(expires_at) + 120`.
 * - P4: no attempt signature shows a success (any status with `err: null`).
 * - P5: the receipt PDA is absent at `finalized`, read at a context slot at
 *   least the slot observed with `H`.
 *
 * A row with zero attempts satisfies P2 to P4 trivially. In v0, mainnet
 * release is refused (`mainnet_release_disabled`) until the proof must agree
 * across two RPC providers (SEC-4). The caller refuses before any read (see
 * `isReleaseAllowedOnCluster`), and the assessor also never reports a mainnet
 * proof as provable.
 */
export function assessReleaseProof(observation: ReleaseObservation): ReleaseAssessment {
  const { attempts } = observation;
  const failed: ReleaseCondition[] = [];
  const maxLastValidBlockHeight = maxOf(attempts.map((a) => a.lastValidBlockHeight));
  const maxExpiresAt = maxOf(attempts.map((a) => a.expiresAt));

  if (!genesisHashMatches(observation.cluster, observation.genesisHash)) failed.push("P1");

  const heightPassed =
    maxLastValidBlockHeight === null || observation.finalizedBlockHeight > maxLastValidBlockHeight;
  const noBlockhashValid = attempts.every((a) => a.blockhashValidAtProcessed === false);
  if (!(heightPassed && noBlockhashValid)) failed.push("P2");

  if (
    maxExpiresAt !== null &&
    !(observation.finalizedUnixTimestamp > maxExpiresAt + RELEASE_EXPIRY_SLACK_SECONDS)
  ) {
    failed.push("P3");
  }

  // A status with `err: null` is a success. A status object without `err`
  // is malformed and also counts as a possible success.
  if (attempts.some((a) => a.status !== null && (a.status.err === null || a.status.err === undefined))) {
    failed.push("P4");
  }

  const { receipt } = observation;
  if (!(receipt.absent === true && receipt.contextSlot >= observation.finalizedSlot)) failed.push("P5");

  const refusal = isReleaseAllowedOnCluster(observation.cluster) ? null : "mainnet_release_disabled";
  return {
    provable: refusal === null && failed.length === 0,
    refusal,
    failed,
    maxLastValidBlockHeight,
    maxExpiresAt,
    signaturesChecked: attempts.map((a) => a.signature),
  };
}

/** In v0 the release proof is available on devnet only (section 9.5, SEC-4). */
export function isReleaseAllowedOnCluster(cluster: Cluster): boolean {
  return cluster === "devnet";
}
