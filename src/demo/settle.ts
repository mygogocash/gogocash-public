/**
 * Settles the fate of a sent transaction for the pause drill of
 * `npm run demo` (plan step R5, #2983), over an injected RPC and sleep.
 *
 * `sendAndConfirm` (src/admin/rpc.ts) throws on the first RPC error and gives
 * up when its poll budget runs out. Neither says whether the transaction
 * landed. The pause drill needs to know: a pause that lands after the demo
 * decided "never paused" leaves the demo vault paused. So this polls the
 * signature status, retrying RPC errors with capped exponential backoff,
 * until one of these happens:
 *
 * - the status carries an error: `failed` (it landed and changed nothing);
 * - the status reaches `finalized`: `finalized`;
 * - no status was ever seen and the confirmed block height is past the
 *   transaction's `lastValidBlockHeight`: `expired` (it can never land);
 * - the poll budget or the consecutive-error budget runs out: `unsettled`,
 *   with the highest status seen and the last RPC error.
 *
 * A status once seen at `processed` or `confirmed` never turns into
 * `expired`: a later null may be a lagging RPC node, so only `finalized`, an
 * error or the budget ends the wait.
 */
import type { AdminRpc } from "../admin/rpc.ts";

export type SettleRpc = Pick<AdminRpc, "getSignatureStatus" | "getBlockHeight">;

/** The highest status seen before the transaction settled. */
export type SeenStatus = "processed" | "confirmed" | null;

export type SignatureFate =
  | { readonly kind: "finalized" }
  | { readonly kind: "failed"; readonly err: unknown }
  | { readonly kind: "expired" }
  | { readonly kind: "unsettled"; readonly lastSeen: SeenStatus; readonly lastError: string | null };

export const SETTLE_DEFAULTS = {
  pollIntervalMs: 1_000,
  /** About ten minutes at one poll a second, as `sendAndConfirm`. */
  maxPolls: 600,
  maxBackoffMs: 8_000,
  /** About two and a half minutes of back-to-back errors with the backoff above. */
  maxConsecutiveErrors: 20,
} as const;

export type SettleOptions = {
  readonly pollIntervalMs?: number;
  readonly maxPolls?: number;
  readonly maxBackoffMs?: number;
  readonly maxConsecutiveErrors?: number;
};

const RANK = { processed: 0, confirmed: 1 } as const;

/** Polls until the signature's fate is known or the budget runs out. Never throws for an RPC error. */
export async function settleSignature(
  input: {
    readonly rpc: SettleRpc;
    readonly signature: string;
    readonly lastValidBlockHeight: bigint;
    readonly sleep: (ms: number) => Promise<void>;
    /** Turns an RPC error into a printable line (the caller removes the RPC URL). */
    readonly describe: (error: unknown) => string;
  } & SettleOptions,
): Promise<SignatureFate> {
  const pollIntervalMs = input.pollIntervalMs ?? SETTLE_DEFAULTS.pollIntervalMs;
  const maxPolls = input.maxPolls ?? SETTLE_DEFAULTS.maxPolls;
  const maxBackoffMs = input.maxBackoffMs ?? SETTLE_DEFAULTS.maxBackoffMs;
  const maxConsecutiveErrors = input.maxConsecutiveErrors ?? SETTLE_DEFAULTS.maxConsecutiveErrors;
  let lastSeen: SeenStatus = null;
  let lastError: string | null = null;
  let consecutiveErrors = 0;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    try {
      const status = await input.rpc.getSignatureStatus(input.signature);
      if (status !== null) {
        if (status.err !== null && status.err !== undefined) return { kind: "failed", err: status.err };
        if (status.confirmationStatus === "finalized") return { kind: "finalized" };
        const seen = status.confirmationStatus;
        if (seen !== null && (lastSeen === null || RANK[seen] > RANK[lastSeen])) lastSeen = seen;
      } else if (lastSeen === null && (await input.rpc.getBlockHeight("confirmed")) > input.lastValidBlockHeight) {
        return { kind: "expired" };
      }
      consecutiveErrors = 0;
      await input.sleep(pollIntervalMs);
    } catch (error) {
      consecutiveErrors += 1;
      lastError = input.describe(error);
      if (consecutiveErrors >= maxConsecutiveErrors) break;
      await input.sleep(Math.min(pollIntervalMs * 2 ** consecutiveErrors, maxBackoffMs));
    }
  }
  return { kind: "unsettled", lastSeen, lastError };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v)) ?? String(value);
  } catch {
    return String(value);
  }
}

/** One line for the evidence file and the console, completing "the <label> ...". */
export function describeFate(fate: SignatureFate): string {
  if (fate.kind === "finalized") return "finalized";
  if (fate.kind === "failed") return `failed onchain (${safeStringify(fate.err)})`;
  if (fate.kind === "expired") return "never landed (no status before its blockhash expired)";
  const seen = fate.lastSeen === null ? "no status seen" : `last seen at ${fate.lastSeen}`;
  return `did not settle within the poll budget (${seen}${fate.lastError === null ? "" : `; last RPC error: ${fate.lastError}`})`;
}
