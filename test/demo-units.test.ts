/**
 * The pure parts of `npm run demo` (src/demo/): the THB to USDC working,
 * consent signing and its negative, the precheck arithmetic, the simulation
 * classifications, the Clock decode, the evidence renderer and its guard, and
 * the kit adapter's simulation options, the pause drill's signature settling
 * and its Ctrl-C hold. No network; throwaway keys only.
 */
import { randomBytes } from "node:crypto";
import { getAddressEncoder, signBytes, type Address, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { demoConsentInput, newDemoIds, newPayoutId, signAndVerifyConsent } from "../src/demo/consent.ts";
import { DEMO_EXPECTED_USDC_ATOMIC, demoConversion, formatRateE8 } from "../src/demo/conversion.ts";
import {
  evidenceDate,
  evidenceFileName,
  evidenceProblems,
  overallOutcome,
  renderEvidence,
  type DemoEvidence,
  type EvidenceStep,
} from "../src/demo/evidence.ts";
import { describeVerdict, expectAlreadyClaimed, expectProgramError, judgeClaimSimulation } from "../src/demo/outcomes.ts";
import {
  claimedTodayAt,
  DEMO_FEE_BUDGET_LAMPORTS,
  demoStateProblems,
  describeShortfall,
  fundingShortfalls,
  payerLamportsNeeded,
  utcDay,
} from "../src/demo/precheck.ts";
import { decodeClockUnixTimestamp, demoRpcFromKit, SYSVAR_PROGRAM_ADDRESS } from "../src/demo/rpc.ts";
import { describeFate, settleSignature, type SettleRpc } from "../src/demo/settle.ts";
import type { SignatureStatusView } from "../src/admin/rpc.ts";
import { interruptHolder } from "../scripts/lib/demo-run.ts";
import type { Vault } from "../src/program.ts";
import { SYSTEM_PROGRAM_ADDRESS } from "../src/clusters.ts";
import { labelAddress } from "./admin-helpers.ts";
import { throwawaySigner } from "./demo-helpers.ts";

const PROGRAM = labelAddress("unit program");
const MINT = labelAddress("unit mint");
const VAULT = labelAddress("unit vault");
const VAULT_ATA = labelAddress("unit vault ata");
const ADMIN = labelAddress("unit admin");
const GUARDIAN = labelAddress("unit guardian");
const CLAIM = labelAddress("unit claim");
const PAYER = labelAddress("unit payer");

function vault(overrides: Partial<Vault> = {}): Vault {
  return {
    version: 1,
    bump: 254,
    paused: false,
    decimals: 6,
    mint: MINT,
    vaultTokenAccount: VAULT_ATA,
    admin: ADMIN,
    pendingAdmin: SYSTEM_PROGRAM_ADDRESS,
    guardian: GUARDIAN,
    claimAuthority: CLAIM,
    maxPerClaim: 5_000_000n,
    maxPerDay: 20_000_000n,
    currentDay: 20728n,
    claimedToday: 0n,
    totalClaimed: 0n,
    claimCount: 0n,
    totalWithdrawn: 0n,
    reserved: new Uint8Array(64),
    ...overrides,
  };
}

const expected = {
  mint: MINT,
  vaultTokenAccount: VAULT_ATA,
  vaultBump: 254,
  admin: ADMIN,
  guardian: GUARDIAN,
  claimAuthority: CLAIM,
  maxPerClaim: 5_000_000n,
  maxPerDay: 20_000_000n,
};

const signers = { claimAuthority: CLAIM, guardian: GUARDIAN, admin: ADMIN, payer: PAYER };
const token = { mint: MINT, owner: VAULT, amount: 20_000_000n, frozen: false, delegate: null, closeAuthority: null };
const NOW = 1_790_910_270n; // UTC day 20728

function problems(overrides: { vault?: Partial<Vault>; signers?: Partial<typeof signers>; token?: typeof token | null; amount?: bigint; now?: bigint } = {}) {
  return demoStateProblems({
    vault: vault(overrides.vault),
    expected,
    vaultTokenAccount: overrides.token === undefined ? token : overrides.token,
    vaultAddress: VAULT,
    signers: { ...signers, ...overrides.signers },
    amountAtomic: overrides.amount ?? 3_558_875n,
    unixTimestamp: overrides.now ?? NOW,
    vaultName: "demo",
  });
}

describe("step 1: THB 125.00 to USDC (src/demo/conversion.ts)", () => {
  it("reproduces the section 6.3 thb_basic row with the integer working", () => {
    const result = demoConversion({ vaultMaxPerClaim: 5_000_000n });
    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.requestedMinor).toBe(12_500n);
    expect(result.conversion.usdcAtomic).toBe(DEMO_EXPECTED_USDC_ATOMIC);
    expect(result.conversion.valueMinor).toBe(12_500n);
    expect(result.conversion.deductedMinor).toBe(12_500n);
    expect(result.conversion.remainderMinor).toBe(0n);
    expect(result.lines).toContain("usdc_atomic = floor(12500 x 10^12 / 3512345678) = 3558875 (3.558875 USDC)");
    expect(result.lines.join("\n")).not.toMatch(/\d\.\d+e/i);
  });

  it("caps the maximum at the vault's max_per_claim and refuses above it", () => {
    const result = demoConversion({ vaultMaxPerClaim: 3_000_000n });
    expect(result).toMatchObject({ ok: false, reason: "above_maximum", maxPayoutAtomic: 3_000_000n });
    expect(demoConversion({ vaultMaxPerClaim: 9_000_000n }).maxPayoutAtomic).toBe(5_000_000n);
  });

  it("formats the e8 rate without floats", () => {
    expect(formatRateE8(3_512_345_678n)).toBe("35.12345678");
    expect(formatRateE8(3_367_000_000n)).toBe("33.67000000");
  });
});

describe("step 2: consent (src/demo/consent.ts)", () => {
  it("a stand-in wallet signs the exact bytes: ok, and amount + 1 is signature_invalid", async () => {
    const wallet = await throwawaySigner("unit stand-in wallet");
    const ids = newDemoIds((n) => Uint8Array.from(randomBytes(n)));
    const consent = demoConsentInput({
      programId: PROGRAM,
      recipient: wallet.address,
      amountAtomic: 3_558_875n,
      deductedMinor: 12_500n,
      feeMinor: 0n,
      ids,
      issuedAtMs: Date.UTC(2026, 9, 3),
    });
    const result = await signAndVerifyConsent({
      consent,
      signerPublicKey: Uint8Array.from(getAddressEncoder().encode(wallet.address)),
      sign: (message) => signBytes(wallet.keyPair.privateKey, message),
    });
    expect(result).toMatchObject({ verify: "ok", tamperedVerify: "signature_invalid", pass: true });
    expect(result.text.split("\n")).toHaveLength(16);
    expect(result.byteLength).toBe(result.text.length);
  });

  it("a signature by any other key fails", async () => {
    const wallet = await throwawaySigner("unit stand-in wallet");
    const other = await throwawaySigner("unit other wallet");
    const consent = demoConsentInput({
      programId: PROGRAM,
      recipient: wallet.address,
      amountAtomic: 3_558_875n,
      deductedMinor: 12_500n,
      feeMinor: 0n,
      ids: newDemoIds((n) => new Uint8Array(n).fill(7)),
      issuedAtMs: Date.UTC(2026, 9, 3),
    });
    const result = await signAndVerifyConsent({
      consent,
      signerPublicKey: Uint8Array.from(getAddressEncoder().encode(wallet.address)),
      sign: (message) => signBytes(other.keyPair.privateKey, message),
    });
    expect(result).toMatchObject({ verify: "signature_invalid", pass: false });
  });

  it("refuses an all-zero payout id", () => {
    expect(() => newPayoutId((n) => new Uint8Array(n))).toThrow(/all zero/);
    expect(newPayoutId((n) => new Uint8Array(n).fill(1)).payoutIdHex).toBe("01".repeat(32));
  });
});

describe("precheck (src/demo/precheck.ts)", () => {
  it("a matching, unpaused, funded vault has no problems", () => {
    expect(problems()).toEqual([]);
  });

  it("names a paused vault with the unpause command", () => {
    expect(problems({ vault: { paused: true } }).join("\n")).toContain("npm run admin -- unpause --cluster devnet --vault demo");
  });

  it("names the wrong claim key, guardian and admin", () => {
    const stranger = labelAddress("unit stranger");
    const found = problems({ signers: { claimAuthority: stranger, guardian: stranger, admin: stranger } }).join("\n");
    expect(found).toContain("--claim-keypair is not the vault's claim authority");
    expect(found).toContain("--guardian-keypair is not the vault's guardian");
    expect(found).toContain("--admin-keypair is not the vault's admin");
  });

  it("names drift from deployments/devnet.json, a frozen or missing vault token account", () => {
    expect(problems({ vault: { maxPerDay: 30_000_000n } }).join("\n")).toContain("maxPerDay expected 20000000, onchain 30000000");
    expect(problems({ token: { ...token, frozen: true } }).join("\n")).toContain("6014");
    expect(problems({ token: null }).join("\n")).toContain("does not exist");
    expect(problems({ token: { ...token, owner: labelAddress("unit stranger") } }).join("\n")).toContain("not the vault's own account");
  });

  it("checks today's cap with the forward-only day roll of C9", () => {
    const full = { claimedToday: 18_000_000n };
    expect(problems({ vault: full }).join("\n")).toContain("today's cap has no room");
    // The next UTC day resets the bucket.
    expect(problems({ vault: full, now: NOW + 86_400n })).toEqual([]);
    expect(claimedTodayAt(vault(full), NOW)).toBe(18_000_000n);
    expect(claimedTodayAt(vault(full), NOW + 86_400n)).toBe(0n);
  });

  it("utcDay is div_euclid(86400)", () => {
    expect(utcDay(1_790_910_270n)).toBe(20728n);
    expect(utcDay(0n)).toBe(0n);
    expect(utcDay(-1n)).toBe(-1n);
    expect(utcDay(-86_400n)).toBe(-1n);
  });

  it("the fee payer needs rent for itself, the receipt and a new ATA, plus the fee budget", () => {
    const rent = { rentExemptEmptyAccount: 650_240n, receiptRent: 1_102_360n, tokenAccountRent: 1_488_440n };
    expect(payerLamportsNeeded({ ...rent, recipientAtaExists: false })).toBe(650_240n + 1_102_360n + 1_488_440n + DEMO_FEE_BUDGET_LAMPORTS);
    expect(payerLamportsNeeded({ ...rent, recipientAtaExists: true })).toBe(650_240n + 1_102_360n + DEMO_FEE_BUDGET_LAMPORTS);
    const base = { ...rent, recipientAtaExists: false, payer: PAYER, vault: VAULT, amountAtomic: 3_558_875n };
    expect(fundingShortfalls({ ...base, payerLamports: 3_291_040n, vaultBalanceAtomic: 3_558_875n })).toEqual([]);
    const short = fundingShortfalls({ ...base, payerLamports: 3_291_039n, vaultBalanceAtomic: 3_558_874n });
    expect(short.map((s) => s.kind)).toEqual(["payer_sol", "vault_tokens"]);
    expect(describeShortfall(short[0]!, "demo")).toBe(`fund ${PAYER} with devnet SOL: it holds 3291039 lamports and the demo needs 3291040.`);
    expect(describeShortfall(short[1]!, "demo")).toContain(`fund vault ${VAULT}: it holds 3558874 atomic`);
  });
});

describe("simulation verdicts (src/demo/outcomes.ts)", () => {
  it("a replay's Custom(0) at the claim index is already_claimed, even with truncated logs", () => {
    const logged = judgeClaimSimulation({ err: { InstructionError: [3n, { Custom: 0n }] }, logs: ["Allocate: account x already in use"], unitsConsumed: 9_000n });
    expect(expectAlreadyClaimed(logged)).toEqual({
      pass: true,
      observed: "refused: Custom(0) AccountAlreadyInUse at instruction 3, class already_claimed",
      alreadyInUseLogged: true,
    });
    const truncated = judgeClaimSimulation({ err: { InstructionError: [3, { Custom: 0 }] }, logs: null, unitsConsumed: null });
    expect(expectAlreadyClaimed(truncated)).toMatchObject({ pass: true, alreadyInUseLogged: false });
  });

  it("Custom(0) at the ATA index is needs_review, not a replay", () => {
    const verdict = judgeClaimSimulation({ err: { InstructionError: [2n, { Custom: 0n }] }, logs: [], unitsConsumed: null });
    expect(expectAlreadyClaimed(verdict).pass).toBe(false);
    expect(describeVerdict(verdict)).toBe("refused: Custom(0) InvalidOwner at instruction 2, class needs_review");
  });

  it("a successful simulation is never a refusal", () => {
    const verdict = judgeClaimSimulation({ err: null, logs: [], unitsConsumed: 31_000n });
    expect(expectAlreadyClaimed(verdict)).toMatchObject({ pass: false, observed: "NOT refused: simulation succeeded (31000 compute units)" });
    expect(expectProgramError(verdict, { code: 6010, errorClass: "needs_review" }).pass).toBe(false);
  });

  it("6010 is needs_review and 6000 is hold (program_paused); a different code fails the expectation", () => {
    const overCap = judgeClaimSimulation({ err: { InstructionError: [3n, { Custom: 6010n }] }, logs: [], unitsConsumed: null });
    expect(expectProgramError(overCap, { code: 6010, errorClass: "needs_review" })).toEqual({
      pass: true,
      observed: "refused: 6010 ExceedsMaxPerClaim at instruction 3, class needs_review",
    });
    const paused = judgeClaimSimulation({ err: { InstructionError: [3n, { Custom: 6000n }] }, logs: [], unitsConsumed: null });
    expect(expectProgramError(paused, { code: 6000, errorClass: "hold", holdReason: "program_paused" })).toEqual({
      pass: true,
      observed: "refused: 6000 Paused at instruction 3, class hold (program_paused)",
    });
    expect(expectProgramError(paused, { code: 6010, errorClass: "needs_review" }).pass).toBe(false);
  });
});

describe("Clock sysvar decode (src/demo/rpc.ts)", () => {
  it("reads unix_timestamp at offset 32 and refuses anything that is not the Clock", () => {
    const data = new Uint8Array(40);
    new DataView(data.buffer).setBigInt64(32, 1_790_910_270n, true);
    expect(decodeClockUnixTimestamp({ owner: SYSVAR_PROGRAM_ADDRESS, data })).toBe(1_790_910_270n);
    expect(() => decodeClockUnixTimestamp(null)).toThrow(/not returned/);
    expect(() => decodeClockUnixTimestamp({ owner: SYSTEM_PROGRAM_ADDRESS, data })).toThrow(/sysvar program/);
    expect(() => decodeClockUnixTimestamp({ owner: SYSVAR_PROGRAM_ADDRESS, data: new Uint8Array(39) })).toThrow(/40 bytes/);
  });
});

describe("the kit adapter (src/demo/rpc.ts)", () => {
  it("simulates unsigned bytes with sigVerify false and replaceRecentBlockhash true at confirmed", async () => {
    const calls: { method: string; args: unknown[] }[] = [];
    const call = (method: string, value: unknown) => (...args: unknown[]) => {
      calls.push({ method, args });
      return { send: async () => value };
    };
    const fake = {
      simulateTransaction: call("simulateTransaction", { context: { slot: 1n }, value: { err: null, logs: ["a"], unitsConsumed: 42n } }),
      getRecentPrioritizationFees: call("getRecentPrioritizationFees", [{ prioritizationFee: 7n, slot: 1n }]),
      getMinimumBalanceForRentExemption: call("getMinimumBalanceForRentExemption", 1_102_360n),
    } as unknown as Rpc<SolanaRpcApi>;
    const rpc = demoRpcFromKit(fake);
    expect(await rpc.simulateUnsigned("AAAA")).toEqual({ err: null, logs: ["a"], unitsConsumed: 42n });
    expect(calls[0]).toEqual({
      method: "simulateTransaction",
      args: ["AAAA", { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }],
    });
    expect(await rpc.getRecentPrioritizationFees([VAULT as Address])).toEqual([{ prioritizationFee: 7n }]);
    expect(await rpc.getMinimumBalanceForRentExemption(89n)).toBe(1_102_360n);
    expect(calls[2]).toEqual({ method: "getMinimumBalanceForRentExemption", args: [89n, { commitment: "confirmed" }] });
  });
});

describe("evidence (src/demo/evidence.ts)", () => {
  const SIGNATURE = "5WUSBHKaGrHUKiriiQwBRQJLjJEqetmQFjFFa4LBENkwEYvkyDJPnBe3Uh3NZzgRyqrti12eG9fuWLvQEMBVYVyN";
  const step = (outcome: EvidenceStep["outcome"], extra: Partial<EvidenceStep> = {}): EvidenceStep => ({
    number: 1,
    title: "A step",
    expected: "x",
    observed: "y | z",
    outcome,
    details: ["detail"],
    signatures: [{ label: "claim", signature: SIGNATURE }],
    ...extra,
  });
  const record = (steps: EvidenceStep[]): DemoEvidence => ({
    date: "2026-10-03",
    generatedAt: "2026-10-03T03:04:05.678Z",
    command: "npm run demo -- --cluster devnet --vault demo",
    genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    programId: PROGRAM,
    vault: { name: "demo", address: VAULT, mint: MINT, tokenAccount: VAULT_ATA },
    roles: { claimAuthority: CLAIM, guardian: GUARDIAN, admin: ADMIN, payer: PAYER, recipient: labelAddress("unit wallet") },
    steps,
  });

  it("renders the result, an escaped table row and explorer links", () => {
    const text = renderEvidence(record([step("PASS")]));
    expect(text).toContain("Result: **PASS** (1 of 1 steps passed).");
    expect(text).toContain("| 1 | A step | x | y \\| z | PASS |");
    expect(text).toContain(`[\`${SIGNATURE}\`](https://explorer.solana.com/tx/${SIGNATURE}?cluster=devnet)`);
    expect(text).toContain(`(https://explorer.solana.com/address/${VAULT}?cluster=devnet)`);
    expect(text.endsWith("\n")).toBe(true);
    expect(overallOutcome([step("PASS"), step("SKIPPED")])).toBe("FAIL");
    expect(overallOutcome([])).toBe("FAIL");
  });

  it("names the file by UTC date and never reuses a name", () => {
    expect(evidenceDate(Date.UTC(2026, 9, 3, 23, 59))).toBe("2026-10-03");
    expect(evidenceFileName("2026-10-03")).toBe("devnet-demo-2026-10-03.md");
    expect(evidenceFileName("2026-10-03", 2)).toBe("devnet-demo-2026-10-03-2.md");
    expect(() => evidenceFileName("03/10/2026")).toThrow();
  });

  it("the guard refuses a keypair-shaped array, an unknown 64-byte base58 value and the RPC URL", () => {
    const clean = renderEvidence(record([step("PASS")]));
    expect(evidenceProblems(clean, { allowedLongValues: [SIGNATURE], forbidden: ["https://rpc.example.invalid/key"] })).toEqual([]);
    const keyArray = `[${Array.from({ length: 64 }, (_, i) => (i * 7) % 256).join(",")}]`;
    expect(evidenceProblems(`${clean}${keyArray}\n`, { allowedLongValues: [SIGNATURE], forbidden: [] })).toEqual([
      "it holds a JSON array of 32 or more numbers (the shape of key bytes).",
    ]);
    const seedArray = `[${Array.from({ length: 32 }, () => 1).join(", ")}]`;
    expect(evidenceProblems(seedArray, { allowedLongValues: [], forbidden: [] })).toHaveLength(1);
    // An 8-byte discriminator array is fine.
    expect(evidenceProblems("[62,198,214,193,213,159,108,210]", { allowedLongValues: [], forbidden: [] })).toEqual([]);
    const unknown = "3S5A7Br6QeoEYnm3yc2dqe5ueKUCw9nmT3LjWv29ZaKmhHjwYvSQW5qgv81KLp5UrF3sUBCj259rMPTcTmaemC3r";
    expect(evidenceProblems(`${clean}${unknown}\n`, { allowedLongValues: [SIGNATURE], forbidden: [] })).toEqual([
      "it holds a 64-byte-sized base58 value that is not one of the run's signatures.",
    ]);
    expect(evidenceProblems(`${clean}rpc.example.invalid\n`, { allowedLongValues: [SIGNATURE], forbidden: ["rpc.example.invalid"] })).toEqual([
      "it holds a forbidden value (the RPC URL or its host).",
    ]);
  });
});

/** A scripted signature-status source: each poll takes the next answer; an Error answer is thrown. */
function scriptedRpc(answers: (SignatureStatusView | null | Error)[], heights: (bigint | Error)[] = [10n]) {
  const calls = { status: 0, height: 0 };
  const rpc: SettleRpc = {
    async getSignatureStatus() {
      const answer = answers[Math.min(calls.status, answers.length - 1)];
      calls.status += 1;
      if (answer instanceof Error) throw answer;
      return answer ?? null;
    },
    async getBlockHeight() {
      const height = heights[Math.min(calls.height, heights.length - 1)] as bigint | Error;
      calls.height += 1;
      if (height instanceof Error) throw height;
      return height;
    },
  };
  return { rpc, calls };
}

const confirmed: SignatureStatusView = { confirmationStatus: "confirmed", err: null };
const processed: SignatureStatusView = { confirmationStatus: "processed", err: null };
const finalized: SignatureStatusView = { confirmationStatus: "finalized", err: null };
const rateLimited = new Error("HTTP error (429): Too Many Requests");

function settle(rpc: SettleRpc, options: { maxPolls?: number; maxConsecutiveErrors?: number } = {}) {
  const sleeps: number[] = [];
  const fate = settleSignature({
    rpc,
    signature: "unit-signature",
    lastValidBlockHeight: 100n,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    describe: (error) => (error instanceof Error ? error.message : "unexpected error"),
    ...options,
  });
  return { fate, sleeps };
}

describe("settling a signature for the pause drill (src/demo/settle.ts)", () => {
  it("retries a 429 with backoff, waits through confirmed, and returns finalized", async () => {
    const { rpc, calls } = scriptedRpc([rateLimited, confirmed, confirmed, finalized]);
    const { fate, sleeps } = settle(rpc);
    expect(await fate).toEqual({ kind: "finalized" });
    expect(calls.status).toBe(4);
    expect(sleeps).toEqual([2_000, 1_000, 1_000]);
  });

  it("returns failed when the status carries an error", async () => {
    const err = { InstructionError: [0, { Custom: 6003 }] };
    const { rpc } = scriptedRpc([null, { confirmationStatus: "confirmed", err }]);
    expect(await settle(rpc).fate).toEqual({ kind: "failed", err });
  });

  it("returns expired only when no status was ever seen and the block height passed lastValidBlockHeight", async () => {
    const { rpc } = scriptedRpc([null], [50n, 101n]);
    expect(await settle(rpc).fate).toEqual({ kind: "expired" });
    // A status once seen keeps the wait open past the expiry height.
    const seen = scriptedRpc([processed, confirmed, null], [101n]);
    expect(await settle(seen.rpc, { maxPolls: 10 }).fate).toEqual({ kind: "unsettled", lastSeen: "confirmed", lastError: null });
    expect(seen.calls.height).toBe(0);
  });

  it("retries a block-height error instead of deciding", async () => {
    const { rpc } = scriptedRpc([null], [rateLimited, 101n]);
    expect(await settle(rpc).fate).toEqual({ kind: "expired" });
  });

  it("gives up as unsettled after the consecutive-error budget, with capped backoff and the last error", async () => {
    const { rpc, calls } = scriptedRpc([rateLimited]);
    const { fate, sleeps } = settle(rpc, { maxConsecutiveErrors: 5 });
    expect(await fate).toEqual({ kind: "unsettled", lastSeen: null, lastError: "HTTP error (429): Too Many Requests" });
    expect(calls.status).toBe(5);
    expect(sleeps).toEqual([2_000, 4_000, 8_000, 8_000]);
  });

  it("gives up as unsettled after the poll budget while the status stays below finalized", async () => {
    const { rpc, calls } = scriptedRpc([confirmed, processed]);
    expect(await settle(rpc, { maxPolls: 7 }).fate).toEqual({ kind: "unsettled", lastSeen: "confirmed", lastError: null });
    expect(calls.status).toBe(7);
  });

  it("describes each fate in one line", () => {
    expect(describeFate({ kind: "finalized" })).toBe("finalized");
    expect(describeFate({ kind: "failed", err: { InstructionError: [0n, { Custom: 6003n }] } })).toBe(
      'failed onchain ({"InstructionError":["0",{"Custom":"6003"}]})',
    );
    expect(describeFate({ kind: "expired" })).toBe("never landed (no status before its blockhash expired)");
    expect(describeFate({ kind: "unsettled", lastSeen: "confirmed", lastError: "HTTP error (429)" })).toBe(
      "did not settle within the poll budget (last seen at confirmed; last RPC error: HTTP error (429))",
    );
  });
});

describe("the pause drill's Ctrl-C hold (scripts/lib/demo-run.ts)", () => {
  it("lets the first Ctrl-C pass with a notice, stops on the second, and removes its listener on release", () => {
    const listeners = new Set<() => void>();
    const exits: number[] = [];
    const printed: string[] = [];
    const target = {
      on: (_event: "SIGINT", listener: () => void) => listeners.add(listener),
      off: (_event: "SIGINT", listener: () => void) => listeners.delete(listener),
      exit: (code: number) => {
        exits.push(code);
      },
    };
    const release = interruptHolder(target, (text) => printed.push(text))({ onFirst: "first notice", onSecond: "second notice" });
    expect(listeners.size).toBe(1);
    for (const listener of listeners) listener();
    expect(printed).toEqual(["first notice\n"]);
    expect(exits).toEqual([]);
    for (const listener of listeners) listener();
    expect(printed).toEqual(["first notice\n", "second notice\n"]);
    expect(exits).toEqual([130]);
    release();
    expect(listeners.size).toBe(0);
  });
});
