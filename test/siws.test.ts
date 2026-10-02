import { createHash, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { U64_MAX } from "../src/amount.ts";
import { decodeStrictBase58, encodeBase58 } from "../src/base58.ts";
import {
  CONSENT_MESSAGE_MAX_BYTES,
  ConsentMessageError,
  renderConsentMessage,
  renderConsentMessageText,
  SIWS_ENVIRONMENT,
  verifyConsentSignature,
  type ConsentMessageInput,
} from "../src/siws.ts";
import { CONSENT_EXAMPLE, contractTestKey, hex, rawPublicKey } from "./vectors.ts";

const example: ConsentMessageInput = { ...CONSENT_EXAMPLE.input };
const testKey1 = contractTestKey(1);
const testKey1Public = rawPublicKey(testKey1);

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("consent message render (contract sections 4.1-4.6)", () => {
  it("reproduces the section 4.6 worked example byte for byte", () => {
    const bytes = renderConsentMessage(example);
    expect(renderConsentMessageText(example)).toBe(CONSENT_EXAMPLE.text);
    expect(bytes.length).toBe(CONSENT_EXAMPLE.byteLength);
    expect(sha256Hex(bytes)).toBe(CONSENT_EXAMPLE.sha256);
    // No trailing newline: the last byte is the last character of the program id ("e").
    expect(bytes[bytes.length - 1]).toBe(0x65);
    expect(Buffer.from(bytes).toString("latin1").endsWith("HWNF2cvXybfAjLbw2pydi7sNFmTfYBjpEWNtY3BJfCje")).toBe(true);
  });

  it("reproduces the worked example signature with test key 1 and verifies it", () => {
    const bytes = renderConsentMessage(example);
    expect(encodeBase58(testKey1Public)).toBe(CONSENT_EXAMPLE.input.recipient);
    const signature = Uint8Array.from(sign(null, bytes, testKey1));
    expect(hex(signature)).toBe(CONSENT_EXAMPLE.signatureHex);
    expect(encodeBase58(signature)).toBe(CONSENT_EXAMPLE.signatureBase58);
    const recipient = decodeStrictBase58(CONSENT_EXAMPLE.input.recipient, 32);
    expect(verifyConsentSignature(recipient, bytes, decodeStrictBase58(CONSENT_EXAMPLE.signatureBase58, 64))).toBe("ok");
  });

  it("MWA shape A is message || signature (820 bytes); shape B is the 64-byte signature", () => {
    const bytes = renderConsentMessage(example);
    const signature = decodeStrictBase58(CONSENT_EXAMPLE.signatureBase58, 64);
    const shapeA = Uint8Array.of(...bytes, ...signature);
    expect(shapeA.length).toBe(820);
    expect(hex(shapeA.subarray(0, shapeA.length - 64))).toBe(hex(bytes));
    expect(hex(shapeA.subarray(shapeA.length - 64))).toBe(CONSENT_EXAMPLE.signatureHex);
  });

  it("section 4.6 negatives: amount +1, trailing LF and CRLF all fail with signature_invalid", () => {
    const signature = decodeStrictBase58(CONSENT_EXAMPLE.signatureBase58, 64);
    const enc = (text: string) => new TextEncoder().encode(text);
    const amountPlusOne = CONSENT_EXAMPLE.text.replace("- gogocash:amount:3972030", "- gogocash:amount:3972031");
    expect(amountPlusOne).not.toBe(CONSENT_EXAMPLE.text);
    expect(verifyConsentSignature(testKey1Public, enc(amountPlusOne), signature)).toBe("signature_invalid");
    expect(verifyConsentSignature(testKey1Public, enc(`${CONSENT_EXAMPLE.text}\n`), signature)).toBe("signature_invalid");
    expect(verifyConsentSignature(testKey1Public, enc(CONSENT_EXAMPLE.text.replaceAll("\n", "\r\n")), signature)).toBe(
      "signature_invalid",
    );
  });

  it("follows the encoding rules: 16 lines, 15 LF, no CR, no trailing newline, printable ASCII", () => {
    const text = renderConsentMessageText(example);
    expect(text.split("\n")).toHaveLength(16);
    expect([...text].filter((c) => c === "\n")).toHaveLength(15);
    expect(text).not.toMatch(/[\r\t]/);
    expect(text.endsWith("\n")).toBe(false);
    expect(/^[\x20-\x7e\n]+$/.test(text)).toBe(true);
    const lines = text.split("\n");
    expect(lines[2]).toBe("");
    expect(lines[4]).toBe("");
  });

  it("renders the mainnet row (app.gogocash.co, 180 s TTL, mainnet label)", () => {
    const text = renderConsentMessageText({ ...example, cluster: "mainnet" });
    const lines = text.split("\n");
    expect(lines[0]).toBe("app.gogocash.co wants you to sign in with your Solana account:");
    expect(lines[3]).toContain("on Solana mainnet. GoGoCash deducts THB 150.00");
    expect(lines[5]).toBe("URI: https://app.gogocash.co");
    expect(lines[7]).toBe("Chain ID: solana:mainnet");
    expect(lines[9]).toBe("Issued At: 2026-10-02T03:04:05.678Z");
    expect(lines[10]).toBe("Expiration Time: 2026-10-02T03:07:05.678Z");
    expect(lines[15]).toBe(`- solana:mainnet:${example.programId}`);
    expect(SIWS_ENVIRONMENT.mainnet.ttlSeconds).toBe(180);
    expect(SIWS_ENVIRONMENT.devnet.ttlSeconds).toBe(300);
  });

  it("formats U with exactly 6 decimals and D/F with exactly 2", () => {
    const text = renderConsentMessageText({ ...example, amountAtomic: 1_000_000n, deductedMinor: 5n, feeMinor: 0n });
    expect(text).toContain("Withdraw 1.000000 USDC");
    expect(text).toContain("deducts THB 0.05 from");
    expect(text).toContain("including a THB 0.00 fee.");
    expect(text).toContain("- gogocash:amount:1000000");
  });

  it("the widest legal message is 813 bytes, under the 1024-byte cap", () => {
    const widest = encodeBase58(new Uint8Array(32).fill(0xff));
    expect(widest.length).toBe(44);
    const bytes = renderConsentMessage({
      ...example,
      recipient: widest,
      programId: widest,
      amountAtomic: U64_MAX,
      deductedMinor: U64_MAX,
      feeMinor: U64_MAX,
    });
    expect(bytes.length).toBe(813);
    expect(bytes.length).toBeLessThanOrEqual(CONSENT_MESSAGE_MAX_BYTES);
  });

  it("accepts the stored expiration and domain when they equal the section 4.4 row", () => {
    const text = renderConsentMessageText({
      ...example,
      expirationMs: example.issuedAtMs + 300_000,
      domain: "app-staging.gogocash.co",
      uri: "https://app-staging.gogocash.co",
    });
    expect(text).toBe(CONSENT_EXAMPLE.text);
  });

  const invalid: Array<[string, Partial<ConsentMessageInput>]> = [
    ["expiration not issued + TTL", { expirationMs: example.issuedAtMs + 299_999 }],
    ["mainnet TTL on devnet", { expirationMs: example.issuedAtMs + 180_000 }],
    ["domain from another environment", { domain: "app.gogocash.co" }],
    ["uri with trailing slash", { uri: "https://app-staging.gogocash.co/" }],
    ["lower-cased recipient", { recipient: example.recipient.toLowerCase() }],
    ["recipient with a space", { recipient: ` ${example.recipient}` }],
    ["program id with an extra leading 1", { programId: `1${example.programId}` }],
    ["zero amount", { amountAtomic: 0n }],
    ["amount above u64", { amountAtomic: U64_MAX + 1n }],
    ["negative D", { deductedMinor: -1n }],
    ["fee above D", { feeMinor: 15001n }],
    ["upper-case nonce", { nonce: example.nonce.toUpperCase() }],
    ["short nonce", { nonce: example.nonce.slice(1) }],
    ["upper-case withdrawal id", { withdrawalId: "CDDBBAD6DB231771BC0060BE" }],
    ["upper-case payout id", { payoutIdHex: example.payoutIdHex.toUpperCase() }],
    ["fractional issued at", { issuedAtMs: example.issuedAtMs + 0.5 }],
    ["issued at beyond year 9999", { issuedAtMs: Date.parse("+010000-01-01T00:00:00.000Z") }],
    ["unknown cluster", { cluster: "testnet" as never }],
  ];
  for (const [name, patch] of invalid) {
    it(`refuses ${name}`, () => {
      expect(() => renderConsentMessageText({ ...example, ...patch })).toThrow(ConsentMessageError);
    });
  }
});
