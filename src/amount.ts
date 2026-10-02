/**
 * Money on the payout path is integer-only. Cashback is approved in the
 * member's ledger currency as minor units (cents / satang), and USDC on Solana
 * has 6 decimals, so every conversion is exact bigint arithmetic. There is no
 * floating point anywhere between "cashback approved" and "tokens sent".
 *
 * The contract rules implemented here are docs/CONTRACT.md sections 4.3
 * (display formats), 5.5 and 6.1 (decimal-string grammar), 6.3 (THB to USDC
 * conversion and the dust policy) and 6.4 (bounds, including the u64 limit).
 */

export const USDC_DECIMALS = 6;

/** Largest value of a Solana `u64`: 2^64 - 1 = 18446744073709551615. */
export const U64_MAX = (1n << 64n) - 1n;

/** 1 USD cent = 10^(6-2) USDC base units. */
const USD_CENT_TO_USDC_BASE_UNITS = 10n ** BigInt(USDC_DECIMALS - 2);

/** `10^6` (USDC decimals) x `10^8` (rate scale) / `10^2` (satang), section 6.3. */
const THB_E8_SCALE = 10n ** 12n;

/**
 * A USD-per-local-unit rate expressed as an exact fraction, e.g. 1 THB =
 * 0.02857 USD is `{ numerator: 2857n, denominator: 100000n }`. Rates come from
 * the FX source the ledger already trusts; they are never floats here.
 */
export type ExactRate = { numerator: bigint; denominator: bigint };

/** True if `value` fits a Solana `u64` (0 to 2^64 - 1). */
export function isU64(value: bigint): boolean {
  return typeof value === "bigint" && value >= 0n && value <= U64_MAX;
}

/** Throws a RangeError unless `value` fits a Solana `u64`. */
export function assertU64(value: bigint, label = "amount"): bigint {
  if (!isU64(value)) {
    throw new RangeError(`${label} must be an integer from 0 to 2^64 - 1.`);
  }
  return value;
}

function assertPayoutU64(base: bigint): bigint {
  if (base > U64_MAX) {
    throw new RangeError("Cashback converts to more than a u64 of USDC base units (2^64 - 1).");
  }
  return base;
}

export function usdCentsToUsdcBaseUnits(usdCents: bigint): bigint {
  if (usdCents <= 0n) {
    throw new RangeError("Cashback payout must be a positive amount.");
  }
  return assertPayoutU64(usdCents * USD_CENT_TO_USDC_BASE_UNITS);
}

/**
 * Converts cashback approved in a local currency (minor units, 2 decimals,
 * e.g. THB satang) to USDC base units. Rounds DOWN so the treasury never pays
 * more than the approved cashback; the remainder stays in the member's ledger.
 * The result must fit a `u64`, the type of the onchain `amount`.
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
  return assertPayoutU64(base);
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

// ---------------------------------------------------------------------------
// Decimal-string grammar (sections 5.5 and 6.1)
// ---------------------------------------------------------------------------

const DECIMAL_BIGINT = /^(0|[1-9][0-9]*)$/;
const ATOMIC_AMOUNT = /^(0|[1-9][0-9]{0,19})$/;
const PAYOUT_ATOMIC_AMOUNT = /^[1-9][0-9]{0,19}$/;

/**
 * Parses a non-negative bigint from its wire form (section 6.1): decimal, no
 * sign, no exponent, no leading zeros, no separators. Never via `Number`.
 */
export function parseDecimalBigint(value: string): bigint {
  if (typeof value !== "string" || !DECIMAL_BIGINT.test(value)) {
    throw new TypeError("Expected a decimal integer string with no sign or leading zeros.");
  }
  return BigInt(value);
}

/** Parses an atomic USDC amount string: `^(0|[1-9][0-9]{0,19})$` and `<= 2^64 - 1`. */
export function parseAtomicAmount(value: string): bigint {
  if (typeof value !== "string" || !ATOMIC_AMOUNT.test(value)) {
    throw new TypeError("Expected an atomic amount string matching ^(0|[1-9][0-9]{0,19})$.");
  }
  return assertU64(BigInt(value), "atomic amount");
}

/** Parses a payout amount (`amount_atomic`, `solana_amount_atomic`): at least 1. */
export function parsePayoutAtomicAmount(value: string): bigint {
  if (typeof value !== "string" || !PAYOUT_ATOMIC_AMOUNT.test(value)) {
    throw new TypeError("Expected a payout amount string matching ^[1-9][0-9]{0,19}$.");
  }
  return assertU64(BigInt(value), "payout amount");
}

/** Wire form of a `u64` atomic amount (the inverse of `parseAtomicAmount`). */
export function formatAtomicAmount(value: bigint): string {
  return assertU64(value, "atomic amount").toString(10);
}

// ---------------------------------------------------------------------------
// Consent-message display formats (section 4.3)
// ---------------------------------------------------------------------------

/**
 * `<U>` of the consent statement: `floor(U / 10^6)`, `.`, then `U mod 10^6`
 * zero-padded to exactly 6 digits. `3972030n` -> `"3.972030"`.
 */
export function formatUsdcAtomicFixed6(atomic: bigint): string {
  assertU64(atomic, "amount_atomic");
  const scale = 10n ** BigInt(USDC_DECIMALS);
  return `${atomic / scale}.${(atomic % scale).toString().padStart(USDC_DECIMALS, "0")}`;
}

/**
 * `<D>` and `<F>` of the consent statement: `floor(m / 100)`, `.`, then
 * `m mod 100` zero-padded to exactly 2 digits. `15000n` -> `"150.00"`.
 */
export function formatMinorFixed2(minor: bigint): string {
  if (typeof minor !== "bigint" || minor < 0n) {
    throw new RangeError("Minor-unit amount must be a non-negative bigint.");
  }
  return `${minor / 100n}.${(minor % 100n).toString().padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// THB to USDC (section 6.3) and bounds (section 6.4)
// ---------------------------------------------------------------------------

/** `solana_dust_policy` (founder decision D4; v0 default `member_keeps_remainder`). */
export type DustPolicy = "member_keeps_remainder" | "treasury_keeps_remainder";

export const DEFAULT_DUST_POLICY: DustPolicy = "member_keeps_remainder";

export type ThbToUsdcConversion = {
  netMinor: bigint;
  usdcAtomic: bigint;
  /** THB value of what is sent, `ceil(usdcAtomic x rate / 10^12)`; `<= netMinor`. */
  valueMinor: bigint;
  deductedMinor: bigint;
  /** Stays in the member's ledger balance (default policy only). */
  remainderMinor: bigint;
  /** Deducted from the member but not sent (alternative policy only). */
  treasuryDustMinor: bigint;
  dustPolicy: DustPolicy;
};

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/**
 * Section 6.3: `usdc_atomic = floor(net_minor x 10^12 / thb_per_usd_e8)`,
 * `value_minor = ceil(usdc_atomic x thb_per_usd_e8 / 10^12)`, then the
 * deduction under the chosen dust policy. The rate is THB per 1 USD x 10^8.
 * This function does not apply the section 6.4 bounds; see
 * `checkPayoutBounds`.
 */
export function convertThbMinorToUsdc(input: {
  requestedMinor: bigint;
  feeMinor: bigint;
  thbPerUsdE8: bigint;
  dustPolicy?: DustPolicy;
}): ThbToUsdcConversion {
  const { requestedMinor, feeMinor, thbPerUsdE8 } = input;
  const dustPolicy = input.dustPolicy ?? DEFAULT_DUST_POLICY;
  if (dustPolicy !== "member_keeps_remainder" && dustPolicy !== "treasury_keeps_remainder") {
    throw new TypeError("Unknown dust policy.");
  }
  if (feeMinor < 0n) throw new RangeError("fee_minor must not be negative.");
  if (thbPerUsdE8 <= 0n) throw new RangeError("thb_per_usd_e8 must be positive.");
  const netMinor = requestedMinor - feeMinor;
  if (netMinor <= 0n) throw new RangeError("net_minor must be greater than zero.");
  const usdcAtomic = (netMinor * THB_E8_SCALE) / thbPerUsdE8;
  const valueMinor = ceilDiv(usdcAtomic * thbPerUsdE8, THB_E8_SCALE);
  if (dustPolicy === "member_keeps_remainder") {
    const deductedMinor = valueMinor + feeMinor;
    return {
      netMinor,
      usdcAtomic,
      valueMinor,
      deductedMinor,
      remainderMinor: requestedMinor - deductedMinor,
      treasuryDustMinor: 0n,
      dustPolicy,
    };
  }
  return {
    netMinor,
    usdcAtomic,
    valueMinor,
    deductedMinor: requestedMinor,
    remainderMinor: 0n,
    treasuryDustMinor: netMinor - valueMinor,
    dustPolicy,
  };
}

const THB_AMOUNT = /^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$/;

/**
 * Parses the member's THB amount (section 6.4 grammar, at most 10 integer
 * digits and 2 decimals) to satang without floats: `"100"` -> 10000,
 * `"100.5"` -> 10050, `"0.01"` -> 1. Returns `null` if the grammar fails.
 */
export function parseThbAmountToMinor(amount: string): bigint | null {
  if (typeof amount !== "string") return null;
  const match = THB_AMOUNT.exec(amount);
  if (match === null) return null;
  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? ".").slice(1).padEnd(2, "0");
  return BigInt(whole) * 100n + BigInt(fraction);
}

export type PayoutBoundsRefusal =
  | "invalid_amount"
  | "fee_exceeds_amount"
  | "exceeds_u64"
  | "below_minimum"
  | "above_maximum";

export type PayoutBoundsResult =
  | { ok: true; requestedMinor: bigint; conversion: ThbToUsdcConversion }
  | { ok: false; reason: PayoutBoundsRefusal };

/**
 * Section 6.4 bounds, checked in the contract's order (the first failure
 * wins): amount grammar and `requested_minor > 0`; `fee_minor <
 * requested_minor`; `usdc_atomic < 2^64`; `usdc_atomic >= min`; `usdc_atomic
 * <= max`. `maxPayoutAtomic` is the caller's min(configured max, onchain
 * `max_per_claim`).
 */
export function checkPayoutBounds(input: {
  amount: string;
  feeMinor: bigint;
  thbPerUsdE8: bigint;
  minPayoutAtomic: bigint;
  maxPayoutAtomic: bigint;
  dustPolicy?: DustPolicy;
}): PayoutBoundsResult {
  const requestedMinor = parseThbAmountToMinor(input.amount);
  if (requestedMinor === null || requestedMinor <= 0n) {
    return { ok: false, reason: "invalid_amount" };
  }
  if (!(input.feeMinor < requestedMinor)) {
    return { ok: false, reason: "fee_exceeds_amount" };
  }
  const conversion = convertThbMinorToUsdc({
    requestedMinor,
    feeMinor: input.feeMinor,
    thbPerUsdE8: input.thbPerUsdE8,
    ...(input.dustPolicy === undefined ? {} : { dustPolicy: input.dustPolicy }),
  });
  if (!(conversion.usdcAtomic <= U64_MAX)) {
    return { ok: false, reason: "exceeds_u64" };
  }
  if (!(conversion.usdcAtomic >= input.minPayoutAtomic)) {
    return { ok: false, reason: "below_minimum" };
  }
  if (!(conversion.usdcAtomic <= input.maxPayoutAtomic)) {
    return { ok: false, reason: "above_maximum" };
  }
  return { ok: true, requestedMinor, conversion };
}
