/**
 * How the demo judges a claim simulation, pure. The error is classified by
 * number and failing instruction index with src/errors.ts (contract sections
 * 3.5 to 3.7), exactly as the rail's sender does (section 9.1 step 5), and
 * each refusal step states the classification it expects:
 *
 * - replay of a paid payout_id: `Custom(0)` "already in use" at the claim
 *   index, class `already_claimed` (section 3.3.0, S2);
 * - over the per-claim cap: 6010 `ExceedsMaxPerClaim`, class `needs_review`;
 * - while paused: 6000 `Paused`, class `hold` (`program_paused`).
 */
import { classifyTransactionError, type ErrorClass, type ErrorClassification, type HoldReason, type InstructionKind } from "../errors.ts";
import type { DemoSimulation } from "./rpc.ts";

/** The claim transaction's instructions by index (src/claim-tx.ts, section 9.1 step 5). */
export const CLAIM_TRANSACTION_KINDS: readonly InstructionKind[] = [
  "compute_budget",
  "compute_budget",
  "create_associated_token_idempotent",
  "claim",
];

/** The index of `claim` in the claim transaction. */
export const CLAIM_INSTRUCTION_INDEX = 3;

export type SimulationVerdict =
  | { readonly refused: false; readonly unitsConsumed: bigint | null }
  | {
      readonly refused: true;
      readonly classification: ErrorClassification;
      readonly failingInstruction: number | null;
      readonly logs: readonly string[];
    };

function failingIndex(err: unknown): number | null {
  if (typeof err !== "object" || err === null || !("InstructionError" in err)) return null;
  const payload = (err as { InstructionError: unknown }).InstructionError;
  if (!Array.isArray(payload)) return null;
  const index = payload[0];
  if (typeof index === "number" && Number.isSafeInteger(index)) return index;
  if (typeof index === "bigint" && index >= 0n && index <= 255n) return Number(index);
  return null;
}

/** Classifies an unsigned claim simulation (success, or the error by number and index). */
export function judgeClaimSimulation(simulation: DemoSimulation): SimulationVerdict {
  if (simulation.err === null || simulation.err === undefined) {
    return { refused: false, unitsConsumed: simulation.unitsConsumed };
  }
  const logs = simulation.logs ?? [];
  return {
    refused: true,
    classification: classifyTransactionError({ err: simulation.err, instructions: CLAIM_TRANSACTION_KINDS, logs }),
    failingInstruction: failingIndex(simulation.err),
    logs,
  };
}

/** A short, printable description of a verdict. */
export function describeVerdict(verdict: SimulationVerdict): string {
  if (verdict.refused === false) {
    return `simulation succeeded (${verdict.unitsConsumed === null ? "units not reported" : `${verdict.unitsConsumed} compute units`})`;
  }
  const c = verdict.classification;
  // Program and Anchor codes read as their number; system and token codes as `Custom(n)` (section 3.7).
  const code = c.code === undefined ? null : c.source === "program" || c.source === "anchor" ? `${c.code}` : `Custom(${c.code})`;
  const what = code === null ? (c.name ?? "unknown error") : c.name === undefined ? code : `${code} ${c.name}`;
  const where = verdict.failingInstruction === null ? "" : ` at instruction ${verdict.failingInstruction}`;
  return `refused: ${what}${where}, class ${c.class}${c.holdReason === undefined ? "" : ` (${c.holdReason})`}`;
}

export type Expectation = { readonly pass: boolean; readonly observed: string };

/**
 * Replay: the simulation must fail at the claim index with `Custom(0)`
 * classified `already_claimed`. Whether the logs carry the system program's
 * "already in use" line is reported too (logs can be truncated, section 3.7).
 */
export function expectAlreadyClaimed(verdict: SimulationVerdict): Expectation & { readonly alreadyInUseLogged: boolean } {
  if (verdict.refused === false) {
    return { pass: false, observed: `NOT refused: ${describeVerdict(verdict)}`, alreadyInUseLogged: false };
  }
  const alreadyInUseLogged = verdict.logs.some((line) => line.includes("already in use"));
  const pass =
    verdict.classification.class === "already_claimed" && verdict.failingInstruction === CLAIM_INSTRUCTION_INDEX;
  return { pass, observed: describeVerdict(verdict), alreadyInUseLogged };
}

/** A refusal with this program error code and class at the claim index. */
export function expectProgramError(
  verdict: SimulationVerdict,
  expected: { readonly code: number; readonly errorClass: ErrorClass; readonly holdReason?: HoldReason },
): Expectation {
  if (verdict.refused === false) return { pass: false, observed: `NOT refused: ${describeVerdict(verdict)}` };
  const c = verdict.classification;
  const pass =
    c.source === "program" &&
    c.code === expected.code &&
    c.class === expected.errorClass &&
    (expected.holdReason === undefined || c.holdReason === expected.holdReason) &&
    verdict.failingInstruction === CLAIM_INSTRUCTION_INDEX;
  return { pass, observed: describeVerdict(verdict) };
}
