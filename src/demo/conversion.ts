/**
 * Demo step 1: THB 125.00 to USDC atomic units with the contract's integer
 * arithmetic (docs/CONTRACT.md sections 6.3 and 6.4, src/amount.ts), and the
 * printable working. Pure: no clock, no RPC, no float anywhere.
 *
 * The rate is the `thb_basic` amount vector (section 6.3, row 1), so every
 * run converts THB 125.00 to exactly 3558875 atomic (3.558875 USDC) and the
 * evidence is reproducible. The demo has no FX source: the API's quote
 * (section 6.6) is not part of the public slice.
 */
import {
  checkPayoutBounds,
  formatMinorFixed2,
  formatUsdcAtomicFixed6,
  type PayoutBoundsRefusal,
  type ThbToUsdcConversion,
} from "../amount.ts";

/** The member's request in the demo: THB 125.00. */
export const DEMO_THB_AMOUNT = "125.00";
/** No fee in the demo, so all of it converts. */
export const DEMO_FEE_MINOR = 0n;
/** THB 35.12345678 per USD, the `thb_basic` vector of section 6.3. */
export const DEMO_THB_PER_USD_E8 = 3_512_345_678n;
/** What section 6.3 row 1 gives for these inputs. */
export const DEMO_EXPECTED_USDC_ATOMIC = 3_558_875n;
/** Default `SOLANA_WITHDRAW_MIN_PAYOUT_ATOMIC` (section 6.4): 1 USDC. */
export const DEMO_MIN_PAYOUT_ATOMIC = 1_000_000n;
/** Default `SOLANA_WITHDRAW_MAX_PAYOUT_ATOMIC` (section 6.4): 5 USDC. */
export const DEMO_RAIL_MAX_PAYOUT_ATOMIC = 5_000_000n;

const E8 = 100_000_000n;

/** `3512345678n` -> `"35.12345678"` (the rate scale is 10^8). */
export function formatRateE8(rateE8: bigint): string {
  return `${rateE8 / E8}.${(rateE8 % E8).toString().padStart(8, "0")}`;
}

export type DemoConversion =
  | {
      readonly ok: true;
      readonly requestedMinor: bigint;
      readonly conversion: ThbToUsdcConversion;
      readonly maxPayoutAtomic: bigint;
      readonly lines: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: PayoutBoundsRefusal;
      readonly maxPayoutAtomic: bigint;
      readonly lines: readonly string[];
    };

/**
 * Converts the demo amount and checks the section 6.4 bounds, with the
 * maximum = min(rail default, the vault's onchain `max_per_claim`). The
 * `lines` show each step of the integer working.
 */
export function demoConversion(input: {
  readonly vaultMaxPerClaim: bigint;
  readonly amount?: string;
  readonly feeMinor?: bigint;
  readonly thbPerUsdE8?: bigint;
}): DemoConversion {
  const amount = input.amount ?? DEMO_THB_AMOUNT;
  const feeMinor = input.feeMinor ?? DEMO_FEE_MINOR;
  const rate = input.thbPerUsdE8 ?? DEMO_THB_PER_USD_E8;
  const maxPayoutAtomic =
    input.vaultMaxPerClaim < DEMO_RAIL_MAX_PAYOUT_ATOMIC ? input.vaultMaxPerClaim : DEMO_RAIL_MAX_PAYOUT_ATOMIC;
  const bounds = checkPayoutBounds({
    amount,
    feeMinor,
    thbPerUsdE8: rate,
    minPayoutAtomic: DEMO_MIN_PAYOUT_ATOMIC,
    maxPayoutAtomic,
  });
  const boundsLine = `bounds (section 6.4): ${DEMO_MIN_PAYOUT_ATOMIC} <= usdc_atomic <= min(${DEMO_RAIL_MAX_PAYOUT_ATOMIC}, vault max_per_claim ${input.vaultMaxPerClaim}) = ${maxPayoutAtomic}`;
  if (bounds.ok === false) {
    return {
      ok: false,
      reason: bounds.reason,
      maxPayoutAtomic,
      lines: [`THB ${amount}, fee_minor ${feeMinor}, thb_per_usd_e8 ${rate}`, `${boundsLine}: refused (${bounds.reason})`],
    };
  }
  const c = bounds.conversion;
  const lines = [
    `THB ${amount} = requested_minor ${bounds.requestedMinor} satang (integer part x 100 plus the 2-digit fraction, no floats)`,
    `fee_minor ${feeMinor}, so net_minor = ${bounds.requestedMinor} - ${feeMinor} = ${c.netMinor}`,
    `thb_per_usd_e8 = ${rate} (THB ${formatRateE8(rate)} per USD, the thb_basic vector of section 6.3)`,
    `usdc_atomic = floor(${c.netMinor} x 10^12 / ${rate}) = ${c.usdcAtomic} (${formatUsdcAtomicFixed6(c.usdcAtomic)} USDC)`,
    `value_minor = ceil(${c.usdcAtomic} x ${rate} / 10^12) = ${c.valueMinor}`,
    `deducted_minor = value_minor + fee_minor = ${c.deductedMinor} (THB ${formatMinorFixed2(c.deductedMinor)}), remainder_minor ${c.remainderMinor} (${c.dustPolicy})`,
    `${boundsLine}: ok`,
  ];
  return { ok: true, requestedMinor: bounds.requestedMinor, conversion: c, maxPayoutAtomic, lines };
}
