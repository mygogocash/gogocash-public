/**
 * Money on the payout path is integer-only. Cashback is approved in the
 * member's ledger currency as minor units (cents / satang), and USDC on Solana
 * has 6 decimals, so every conversion is exact bigint arithmetic. There is no
 * floating point anywhere between "cashback approved" and "tokens sent".
 */

export const USDC_DECIMALS = 6;

/** 1 USD cent = 10^(6-2) USDC base units. */
const USD_CENT_TO_USDC_BASE_UNITS = 10n ** BigInt(USDC_DECIMALS - 2);

/**
 * A USD-per-local-unit rate expressed as an exact fraction, e.g. 1 THB =
 * 0.02857 USD is `{ numerator: 2857n, denominator: 100000n }`. Rates come from
 * the FX source the ledger already trusts; they are never floats here.
 */
export type ExactRate = { numerator: bigint; denominator: bigint };

export function usdCentsToUsdcBaseUnits(usdCents: bigint): bigint {
  if (usdCents <= 0n) {
    throw new RangeError("Cashback payout must be a positive amount.");
  }
  return usdCents * USD_CENT_TO_USDC_BASE_UNITS;
}

/**
 * Converts cashback approved in a local currency (minor units, 2 decimals,
 * e.g. THB satang) to USDC base units. Rounds DOWN so the treasury never pays
 * more than the approved cashback; the remainder stays in the member's ledger.
 */
export function localMinorToUsdcBaseUnits(
  localMinor: bigint,
  usdPerLocalUnit: ExactRate,
): bigint {
  if (localMinor <= 0n) {
    throw new RangeError("Cashback payout must be a positive amount.");
  }
  if (usdPerLocalUnit.numerator <= 0n || usdPerLocalUnit.denominator <= 0n) {
    throw new RangeError("FX rate must be a positive fraction.");
  }
  // localMinor / 100 local units * rate USD * 10^6 base units per USD.
  const scaled =
    localMinor * usdPerLocalUnit.numerator * 10n ** BigInt(USDC_DECIMALS);
  const base = scaled / (100n * usdPerLocalUnit.denominator);
  if (base === 0n) {
    throw new RangeError("Cashback converts to less than 1 USDC base unit.");
  }
  return base;
}

/** Human-readable USDC string for logs and UI, e.g. 1250000n -> "1.25". */
export function formatUsdc(baseUnits: bigint): string {
  const scale = 10n ** BigInt(USDC_DECIMALS);
  const whole = baseUnits / scale;
  const fraction = (baseUnits % scale)
    .toString()
    .padStart(USDC_DECIMALS, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}
