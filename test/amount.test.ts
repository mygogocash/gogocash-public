import { describe, expect, it } from "vitest";
import {
  assertU64,
  checkPayoutBounds,
  convertThbMinorToUsdc,
  DEFAULT_DUST_POLICY,
  formatAtomicAmount,
  formatMinorFixed2,
  formatUsdc,
  formatUsdcAtomicFixed6,
  isU64,
  localMinorToUsdcBaseUnits,
  parseAtomicAmount,
  parseDecimalBigint,
  parsePayoutAtomicAmount,
  parseThbAmountToMinor,
  U64_MAX,
  usdCentsToUsdcBaseUnits,
} from "../src/amount.ts";
import { AMOUNT_EXAMPLES } from "./vectors.ts";

describe("cashback amount conversion", () => {
  it("converts USD cents to USDC base units exactly", () => {
    expect(usdCentsToUsdcBaseUnits(125n)).toBe(1_250_000n);
  });

  it("converts THB satang with an exact FX fraction and rounds down", () => {
    // THB 125.00 at 0.02857 USD/THB = 3.57125 USD.
    expect(
      localMinorToUsdcBaseUnits(12_500n, { numerator: 2857n, denominator: 100_000n }),
    ).toBe(3_571_250n);
    // THB 0.01 at 0.02857 = 0.0002857 USD -> 285 base units (not 285.7).
    expect(
      localMinorToUsdcBaseUnits(1n, { numerator: 2857n, denominator: 100_000n }),
    ).toBe(285n);
  });

  it("refuses zero, negative and dust payouts", () => {
    expect(() => usdCentsToUsdcBaseUnits(0n)).toThrow(RangeError);
    expect(() =>
      localMinorToUsdcBaseUnits(-1n, { numerator: 1n, denominator: 1n }),
    ).toThrow(RangeError);
    expect(() =>
      localMinorToUsdcBaseUnits(1n, { numerator: 1n, denominator: 10n ** 12n }),
    ).toThrow(/less than 1 USDC base unit/);
  });

  it("refuses payouts above the u64 upper bound (2^64 - 1)", () => {
    // 2^64 - 1 base units is exactly reachable; one more is not.
    expect(localMinorToUsdcBaseUnits(U64_MAX * 100n, { numerator: 1n, denominator: 1_000_000n })).toBe(U64_MAX);
    expect(() =>
      localMinorToUsdcBaseUnits((U64_MAX + 1n) * 100n, { numerator: 1n, denominator: 1_000_000n }),
    ).toThrow(/u64/);
    expect(() => usdCentsToUsdcBaseUnits(U64_MAX)).toThrow(/u64/);
    expect(usdCentsToUsdcBaseUnits(U64_MAX / 10_000n)).toBe((U64_MAX / 10_000n) * 10_000n);
  });

  it("formats base units for display", () => {
    expect(formatUsdc(3_571_250n)).toBe("3.57125");
    expect(formatUsdc(1_000_000n)).toBe("1");
    expect(formatUsdc(5n)).toBe("0.000005");
  });
});

describe("u64 bound", () => {
  it("is 2^64 - 1", () => {
    expect(U64_MAX).toBe(18446744073709551615n);
    expect(isU64(0n)).toBe(true);
    expect(isU64(U64_MAX)).toBe(true);
    expect(isU64(U64_MAX + 1n)).toBe(false);
    expect(isU64(-1n)).toBe(false);
    expect(() => assertU64(U64_MAX + 1n)).toThrow(RangeError);
  });
});

describe("decimal-string grammar (contract sections 5.5 and 6.1)", () => {
  it("parses atomic amounts with BigInt, never Number", () => {
    expect(parseAtomicAmount("0")).toBe(0n);
    expect(parseAtomicAmount("18446744073709551615")).toBe(U64_MAX);
    expect(parsePayoutAtomicAmount("3972030")).toBe(3972030n);
    expect(parseDecimalBigint("123456789012345678901234567890")).toBe(123456789012345678901234567890n);
    expect(formatAtomicAmount(U64_MAX)).toBe("18446744073709551615");
  });

  it("refuses signs, leading zeros, exponents, separators, spaces and values above u64", () => {
    for (const bad of ["", "-1", "+1", "01", "1e6", "1_000", "1,000", " 1", "1 ", "1.0", "0x10", "18446744073709551616", "999999999999999999999"]) {
      expect(() => parseAtomicAmount(bad), bad).toThrow();
    }
    expect(() => parsePayoutAtomicAmount("0")).toThrow();
    expect(() => parseDecimalBigint("007")).toThrow();
    expect(() => formatAtomicAmount(-1n)).toThrow(RangeError);
  });
});

describe("consent display formats (contract section 4.3)", () => {
  it("formats U with exactly 6 decimals", () => {
    expect(formatUsdcAtomicFixed6(3972030n)).toBe("3.972030");
    expect(formatUsdcAtomicFixed6(1000000n)).toBe("1.000000");
    expect(formatUsdcAtomicFixed6(1n)).toBe("0.000001");
    expect(formatUsdcAtomicFixed6(U64_MAX)).toBe("18446744073709.551615");
    expect(() => formatUsdcAtomicFixed6(-1n)).toThrow(RangeError);
  });

  it("formats satang with exactly 2 decimals", () => {
    expect(formatMinorFixed2(15000n)).toBe("150.00");
    expect(formatMinorFixed2(1500n)).toBe("15.00");
    expect(formatMinorFixed2(0n)).toBe("0.00");
    expect(formatMinorFixed2(5n)).toBe("0.05");
    expect(formatMinorFixed2(10050n)).toBe("100.50");
    expect(() => formatMinorFixed2(-1n)).toThrow(RangeError);
  });
});

describe("THB to USDC conversion (contract section 6.3 worked examples)", () => {
  it("defaults to the member keeping the remainder (D4)", () => {
    expect(DEFAULT_DUST_POLICY).toBe("member_keeps_remainder");
  });

  for (const v of AMOUNT_EXAMPLES) {
    it(`${v.id} under both dust policies`, () => {
      const member = convertThbMinorToUsdc({ requestedMinor: v.requested, feeMinor: v.fee, thbPerUsdE8: v.rate });
      expect(member).toEqual({
        netMinor: v.net,
        usdcAtomic: v.usdc,
        valueMinor: v.value,
        deductedMinor: v.defaultDeducted,
        remainderMinor: v.defaultRemainder,
        treasuryDustMinor: 0n,
        dustPolicy: "member_keeps_remainder",
      });
      const treasury = convertThbMinorToUsdc({
        requestedMinor: v.requested,
        feeMinor: v.fee,
        thbPerUsdE8: v.rate,
        dustPolicy: "treasury_keeps_remainder",
      });
      expect(treasury).toEqual({
        netMinor: v.net,
        usdcAtomic: v.usdc,
        valueMinor: v.value,
        deductedMinor: v.altDeducted,
        remainderMinor: 0n,
        treasuryDustMinor: v.altDust,
        dustPolicy: "treasury_keeps_remainder",
      });
      expect(member.valueMinor).toBeLessThanOrEqual(member.netMinor);
      expect(member.deductedMinor).toBeLessThanOrEqual(v.requested);
    });
  }

  it("the thb_with_fee vector gives the consent amounts of section 4.6 (U = 3972030, D = 15000, F = 1500)", () => {
    const c = convertThbMinorToUsdc({ requestedMinor: 15000n, feeMinor: 1500n, thbPerUsdE8: 3398765432n });
    expect(c.usdcAtomic).toBe(3972030n);
    expect(c.deductedMinor).toBe(15000n);
  });

  it("refuses a non-positive net amount or rate", () => {
    expect(() => convertThbMinorToUsdc({ requestedMinor: 100n, feeMinor: 100n, thbPerUsdE8: 3367000000n })).toThrow(RangeError);
    expect(() => convertThbMinorToUsdc({ requestedMinor: 100n, feeMinor: 0n, thbPerUsdE8: 0n })).toThrow(RangeError);
    expect(() => convertThbMinorToUsdc({ requestedMinor: 100n, feeMinor: -1n, thbPerUsdE8: 1n })).toThrow(RangeError);
  });
});

describe("THB amount grammar and bounds (contract section 6.4)", () => {
  it("parses the amount without floats", () => {
    expect(parseThbAmountToMinor("100")).toBe(10000n);
    expect(parseThbAmountToMinor("100.5")).toBe(10050n);
    expect(parseThbAmountToMinor("0.01")).toBe(1n);
    expect(parseThbAmountToMinor("9999999999.99")).toBe(999999999999n);
    for (const bad of ["", "01", "1.", ".5", "1.234", "-1", "+1", "1e2", "10000000000", " 1", "1,000", "1.0 "]) {
      expect(parseThbAmountToMinor(bad), bad).toBeNull();
    }
  });

  const ok = { feeMinor: 1000n, thbPerUsdE8: 3367000000n, minPayoutAtomic: 1_000_000n, maxPayoutAtomic: 5_000_000n };

  it("accepts row 3 (THB 100.00, fee 10.00, 33.67 THB/USD)", () => {
    const result = checkPayoutBounds({ ...ok, amount: "100" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.requestedMinor).toBe(10000n);
      expect(result.conversion.usdcAtomic).toBe(2673002n);
      expect(result.conversion.deductedMinor).toBe(10000n);
    }
  });

  it("refuses in the contract's order, first failure wins", () => {
    expect(checkPayoutBounds({ ...ok, amount: "abc" })).toEqual({ ok: false, reason: "invalid_amount" });
    expect(checkPayoutBounds({ ...ok, amount: "0" })).toEqual({ ok: false, reason: "invalid_amount" });
    expect(checkPayoutBounds({ ...ok, amount: "0.00" })).toEqual({ ok: false, reason: "invalid_amount" });
    expect(checkPayoutBounds({ ...ok, amount: "10" })).toEqual({ ok: false, reason: "fee_exceeds_amount" });
    expect(checkPayoutBounds({ ...ok, amount: "9999999999.99", thbPerUsdE8: 1n })).toEqual({ ok: false, reason: "exceeds_u64" });
    expect(checkPayoutBounds({ ...ok, amount: "20" })).toEqual({ ok: false, reason: "below_minimum" });
    expect(checkPayoutBounds({ ...ok, amount: "1000" })).toEqual({ ok: false, reason: "above_maximum" });
  });

  it("treats the minimum and maximum as inclusive", () => {
    // thb_exact_minimum: THB 40.00 at 40 THB/USD is exactly 1 USDC.
    const min = checkPayoutBounds({ ...ok, amount: "40", feeMinor: 0n, thbPerUsdE8: 4000000000n });
    expect(min.ok).toBe(true);
    const max = checkPayoutBounds({ ...ok, amount: "200", feeMinor: 0n, thbPerUsdE8: 4000000000n });
    expect(max.ok).toBe(true);
    if (max.ok) expect(max.conversion.usdcAtomic).toBe(5_000_000n);
  });
});
