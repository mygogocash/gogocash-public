import { describe, expect, it } from "vitest";
import { GENESIS_HASH } from "../src/clusters.ts";
import {
  assessReleaseProof,
  isReleaseAllowedOnCluster,
  type ReleaseAttemptObservation,
  type ReleaseObservation,
} from "../src/release.ts";
import { CONSENT_EXAMPLE } from "./vectors.ts";

const deadAttempt = (over: Partial<ReleaseAttemptObservation> = {}): ReleaseAttemptObservation => ({
  signature: CONSENT_EXAMPLE.signatureBase58,
  lastValidBlockHeight: 1_000n,
  expiresAt: 1_790_910_565n,
  blockhashValidAtProcessed: false,
  status: null,
  ...over,
});

/** All five conditions hold. */
const provable = (over: Partial<ReleaseObservation> = {}): ReleaseObservation => ({
  cluster: "devnet",
  genesisHash: GENESIS_HASH.devnet,
  finalizedBlockHeight: 1_001n,
  finalizedSlot: 5_000n,
  finalizedUnixTimestamp: 1_790_910_565n + 121n,
  attempts: [deadAttempt(), deadAttempt({ lastValidBlockHeight: 990n, expiresAt: 1_790_910_500n })],
  receipt: { absent: true, contextSlot: 5_000n },
  ...over,
});

describe("release proof assessor (contract section 9.5)", () => {
  it("is provable when P1-P5 all hold, and reports the proof maxima", () => {
    const result = assessReleaseProof(provable());
    expect(result).toEqual({
      provable: true,
      refusal: null,
      failed: [],
      maxLastValidBlockHeight: 1_000n,
      maxExpiresAt: 1_790_910_565n,
      signaturesChecked: [CONSENT_EXAMPLE.signatureBase58, CONSENT_EXAMPLE.signatureBase58],
    });
  });

  it("P1 fails on a genesis mismatch (including the other cluster's genesis)", () => {
    expect(assessReleaseProof(provable({ genesisHash: GENESIS_HASH.mainnet })).failed).toEqual(["P1"]);
    expect(assessReleaseProof(provable({ genesisHash: GENESIS_HASH.devnet.toLowerCase() })).failed).toEqual(["P1"]);
  });

  it("P2 fails when H is not above every last_valid_block_height (equal is not enough)", () => {
    expect(assessReleaseProof(provable({ finalizedBlockHeight: 1_000n })).failed).toEqual(["P2"]);
    expect(assessReleaseProof(provable({ finalizedBlockHeight: 995n })).failed).toEqual(["P2"]);
  });

  it("P2 fails when any wire blockhash is still valid at processed", () => {
    const attempts = [deadAttempt(), deadAttempt({ blockhashValidAtProcessed: true })];
    expect(assessReleaseProof(provable({ attempts })).failed).toEqual(["P2"]);
  });

  it("P3 needs the finalized clock strictly past max(expires_at) + 120 s", () => {
    expect(assessReleaseProof(provable({ finalizedUnixTimestamp: 1_790_910_565n + 120n })).failed).toEqual(["P3"]);
    expect(assessReleaseProof(provable({ finalizedUnixTimestamp: 1_790_910_565n + 121n })).failed).toEqual([]);
  });

  it("P4 fails when any attempt shows a success; failed statuses are fine", () => {
    const failedStatus = deadAttempt({ status: { err: { InstructionError: [3, { Custom: 6012 }] } } });
    expect(assessReleaseProof(provable({ attempts: [failedStatus] })).failed).toEqual([]);
    const success = deadAttempt({ status: { err: null } });
    expect(assessReleaseProof(provable({ attempts: [failedStatus, success] })).failed).toEqual(["P4"]);
    const malformed = deadAttempt({ status: {} as { err: unknown } });
    expect(assessReleaseProof(provable({ attempts: [malformed] })).failed).toEqual(["P4"]);
  });

  it("P5 fails when the receipt exists or was read at a slot older than H's slot", () => {
    expect(assessReleaseProof(provable({ receipt: { absent: false, contextSlot: 5_000n } })).failed).toEqual(["P5"]);
    expect(assessReleaseProof(provable({ receipt: { absent: true, contextSlot: 4_999n } })).failed).toEqual(["P5"]);
    expect(assessReleaseProof(provable({ receipt: { absent: true, contextSlot: 5_001n } })).failed).toEqual([]);
  });

  it("a row with zero attempts satisfies P2-P4 trivially", () => {
    const result = assessReleaseProof(provable({ attempts: [], finalizedBlockHeight: 0n, finalizedUnixTimestamp: 0n }));
    expect(result).toMatchObject({ provable: true, failed: [], maxLastValidBlockHeight: null, maxExpiresAt: null, signaturesChecked: [] });
  });

  it("reports every failed condition, in order", () => {
    const result = assessReleaseProof(
      provable({
        genesisHash: "x",
        finalizedBlockHeight: 0n,
        finalizedUnixTimestamp: 0n,
        attempts: [deadAttempt({ status: { err: null } })],
        receipt: { absent: false, contextSlot: 0n },
      }),
    );
    expect(result.provable).toBe(false);
    expect(result.failed).toEqual(["P1", "P2", "P3", "P4", "P5"]);
  });

  it("v0 refuses release on mainnet even when every condition holds", () => {
    expect(isReleaseAllowedOnCluster("devnet")).toBe(true);
    expect(isReleaseAllowedOnCluster("mainnet")).toBe(false);
    const result = assessReleaseProof(provable({ cluster: "mainnet", genesisHash: GENESIS_HASH.mainnet }));
    expect(result).toMatchObject({ provable: false, refusal: "mainnet_release_disabled", failed: [] });
  });
});
