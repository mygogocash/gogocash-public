import { describe, expect, it } from "vitest";
import {
  formatUsdc,
  localMinorToUsdcBaseUnits,
  usdCentsToUsdcBaseUnits,
} from "../src/amount.js";

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

  it("formats base units for display", () => {
    expect(formatUsdc(3_571_250n)).toBe("3.57125");
    expect(formatUsdc(1_000_000n)).toBe("1");
    expect(formatUsdc(5n)).toBe("0.000005");
  });
});
