import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeStrictBase58, encodeBase58, isStrictBase58 } from "../src/base58.ts";
import { CONSENT_EXAMPLE, TEST_SIGNER_1, fromHex, hex } from "./vectors.ts";

describe("strict base58 (contract section 5.4)", () => {
  it("accepts test key 1 and its signature (section 5.4 self-check)", () => {
    expect(isStrictBase58(TEST_SIGNER_1, 32)).toBe(true);
    expect(isStrictBase58(CONSENT_EXAMPLE.signatureBase58, 64)).toBe(true);
    expect(hex(decodeStrictBase58(CONSENT_EXAMPLE.signatureBase58, 64))).toBe(CONSENT_EXAMPLE.signatureHex);
  });

  it("rejects the section 5.4 negatives", () => {
    // A 31-byte value.
    const value31 = encodeBase58(Uint8Array.from(randomBytes(31)).map((b, i) => (i === 0 ? b | 1 : b)));
    expect(isStrictBase58(value31, 32)).toBe(false);
    // The address with a 0 (not in the alphabet).
    expect(isStrictBase58(`${TEST_SIGNER_1.slice(0, -1)}0`, 32)).toBe(false);
    // The lower-cased address.
    expect(isStrictBase58(TEST_SIGNER_1.toLowerCase(), 32)).toBe(false);
    // The address with an extra leading 1 (33 bytes).
    expect(isStrictBase58(`1${TEST_SIGNER_1}`, 32)).toBe(false);
  });

  it("never trims, folds or normalizes", () => {
    for (const bad of [
      ` ${TEST_SIGNER_1}`,
      `${TEST_SIGNER_1} `,
      `${TEST_SIGNER_1}\n`,
      `\t${TEST_SIGNER_1}`,
      TEST_SIGNER_1.replace("H", "I"),
      TEST_SIGNER_1.replace("u", "l"),
      TEST_SIGNER_1.replace("M", "O"),
      `0x${TEST_SIGNER_1}`,
    ]) {
      expect(isStrictBase58(bad, 32)).toBe(false);
    }
  });

  it("rejects non-strings, empty strings and wrong byte lengths", () => {
    for (const bad of [undefined, null, 42, {}, [], ""]) expect(isStrictBase58(bad, 32)).toBe(false);
    expect(isStrictBase58(TEST_SIGNER_1, 64)).toBe(false);
    expect(isStrictBase58(CONSENT_EXAMPLE.signatureBase58, 32)).toBe(false);
    expect(isStrictBase58(encodeBase58(new Uint8Array(33).fill(7)), 32)).toBe(false);
    expect(isStrictBase58(encodeBase58(new Uint8Array(65).fill(7)), 64)).toBe(false);
  });

  it("enforces the encodable length ranges (32-44 and 64-88)", () => {
    const allZero32 = encodeBase58(new Uint8Array(32));
    expect(allZero32).toBe("11111111111111111111111111111111");
    expect(isStrictBase58(allZero32, 32)).toBe(true);
    const allFf32 = encodeBase58(new Uint8Array(32).fill(0xff));
    expect(allFf32.length).toBe(44);
    expect(isStrictBase58(allFf32, 32)).toBe(true);
    const allZero64 = encodeBase58(new Uint8Array(64));
    expect(allZero64.length).toBe(64);
    expect(isStrictBase58(allZero64, 64)).toBe(true);
    expect(isStrictBase58(encodeBase58(new Uint8Array(64).fill(0xff)), 64)).toBe(true);
    expect(isStrictBase58("1".repeat(31), 32)).toBe(false);
    expect(isStrictBase58("1".repeat(45), 32)).toBe(false);
  });

  it("round-trips random 32- and 64-byte values exactly", () => {
    for (let i = 0; i < 200; i += 1) {
      const n = i % 2 === 0 ? 32 : 64;
      const bytes = Uint8Array.from(randomBytes(n));
      if (i % 10 === 0) bytes.fill(0, 0, 3); // leading zero bytes become leading 1s
      const text = encodeBase58(bytes);
      expect(isStrictBase58(text, n)).toBe(true);
      expect(hex(decodeStrictBase58(text, n))).toBe(hex(bytes));
    }
  });

  it("decodeStrictBase58 throws on anything isStrictBase58 rejects", () => {
    expect(() => decodeStrictBase58(TEST_SIGNER_1.toLowerCase(), 32)).toThrow(TypeError);
    expect(() => decodeStrictBase58(`1${TEST_SIGNER_1}`, 32)).toThrow(TypeError);
    expect(decodeStrictBase58(TEST_SIGNER_1, 32)).toEqual(decodeStrictBase58(TEST_SIGNER_1, 32));
    expect(fromHex(hex(decodeStrictBase58(TEST_SIGNER_1, 32))).length).toBe(32);
  });
});
