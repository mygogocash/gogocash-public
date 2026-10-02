import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderConsentMessage, SMALL_ORDER_PUBLIC_KEYS_HEX, verifyConsentSignature } from "../src/siws.ts";
import { CONSENT_EXAMPLE, contractTestKey, fromHex, hex, privateKeyFromSeed, rawPublicKey } from "./vectors.ts";

const P = (1n << 255n) - 19n;
const L = (1n << 252n) + 27742317777372353535851937790883648493n;

function le32(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function readLe(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) v = (v << 8n) | BigInt(bytes[i] ?? 0);
  return v;
}

/** A throwaway key pair, a message and a valid signature over it. */
function throwaway(message: Uint8Array = Uint8Array.from(randomBytes(100))) {
  const { privateKey } = generateKeyPairSync("ed25519");
  const publicKey = rawPublicKey(privateKey);
  const signature = Uint8Array.from(sign(null, message, privateKey));
  return { privateKey, publicKey, message, signature };
}

function withR(signature: Uint8Array, r: Uint8Array): Uint8Array {
  const out = Uint8Array.from(signature);
  out.set(r, 0);
  return out;
}

function withS(signature: Uint8Array, s: bigint): Uint8Array {
  const out = Uint8Array.from(signature);
  out.set(le32(s), 32);
  return out;
}

describe("verifyConsentSignature positives (contract section 4.7)", () => {
  it("RFC 8032 section 7.1 test 1 (empty message)", () => {
    const secret = fromHex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
    const publicKey = fromHex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
    const signature = fromHex(
      "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
    );
    const message = new Uint8Array(0);
    const privateKey = privateKeyFromSeed(secret);
    expect(hex(rawPublicKey(privateKey))).toBe(hex(publicKey));
    expect(hex(Uint8Array.from(sign(null, message, privateKey)))).toBe(hex(signature));
    expect(verifyConsentSignature(publicKey, message, signature)).toBe("ok");
  });

  it("throwaway keys sign and verify random messages", () => {
    for (let i = 0; i < 20; i += 1) {
      const { publicKey, message, signature } = throwaway(Uint8Array.from(randomBytes(1 + i * 50)));
      expect(verifyConsentSignature(publicKey, message, signature)).toBe("ok");
    }
  });

  it("accepts a message of exactly 1024 bytes", () => {
    const { publicKey, message, signature } = throwaway(new Uint8Array(1024).fill(0x41));
    expect(verifyConsentSignature(publicKey, message, signature)).toBe("ok");
  });
});

describe("verifyConsentSignature negatives (contract section 4.7)", () => {
  const base = throwaway();

  it("bad_length: key not 32 bytes, signature not 64 bytes, message over 1024 bytes", () => {
    expect(verifyConsentSignature(base.publicKey.subarray(0, 31), base.message, base.signature)).toBe("bad_length");
    expect(verifyConsentSignature(Uint8Array.of(...base.publicKey, 0), base.message, base.signature)).toBe("bad_length");
    expect(verifyConsentSignature(base.publicKey, base.message, base.signature.subarray(0, 63))).toBe("bad_length");
    expect(verifyConsentSignature(base.publicKey, base.message, Uint8Array.of(...base.signature, 0))).toBe("bad_length");
    const long = throwaway(new Uint8Array(1025).fill(0x41));
    expect(verifyConsentSignature(long.publicKey, long.message, long.signature)).toBe("bad_length");
    expect(verifyConsentSignature("x" as never, base.message, base.signature)).toBe("bad_length");
  });

  it("A_small_order for each of the 8 small-order encodings", () => {
    expect(SMALL_ORDER_PUBLIC_KEYS_HEX).toHaveLength(8);
    expect(new Set(SMALL_ORDER_PUBLIC_KEYS_HEX).size).toBe(8);
    for (const keyHex of SMALL_ORDER_PUBLIC_KEYS_HEX) {
      expect(verifyConsentSignature(fromHex(keyHex), base.message, base.signature)).toBe("A_small_order");
    }
  });

  it("A_small_order rejects the all-zero address 11111111111111111111111111111111 as a signer", () => {
    expect(verifyConsentSignature(new Uint8Array(32), base.message, base.signature)).toBe("A_small_order");
  });

  it("never accepts the trivial forgery for an x = 0 point carrying the sign bit", () => {
    // The identity (y = 1) and the order-2 point (y = p - 1) have x = 0, so
    // their encodings with bit 255 set are canonical in y but not in x. They
    // are not among the 8 encodings above, so the precheck lets them through
    // and node:crypto has to refuse them. With A of small order, R = identity
    // and S = 0 satisfy [S]B = R + [k]A for every message: a signature
    // "valid" for anything. This pins that it never verifies.
    const forged = fromHex(`01${"00".repeat(31)}${"00".repeat(32)}`);
    for (const keyHex of [`01${"00".repeat(30)}80`, `ec${"ff".repeat(31)}`]) {
      for (const message of [base.message, new Uint8Array(0), new TextEncoder().encode("any text")]) {
        expect(verifyConsentSignature(fromHex(keyHex), message, forged)).not.toBe("ok");
      }
    }
  });

  it("A_non_canonical for y >= p, with and without the sign bit", () => {
    const encodings: Uint8Array[] = [];
    for (const y of [P, P + 1n, P + 2n, P + 18n]) {
      const plain = le32(y);
      const signed = Uint8Array.from(plain);
      signed[31] = (signed[31] ?? 0) | 0x80;
      encodings.push(plain, signed);
    }
    encodings.push(new Uint8Array(32).fill(0xff));
    for (const key of encodings) {
      expect(readLe(key) & ((1n << 255n) - 1n)).toBeGreaterThanOrEqual(P);
      expect(verifyConsentSignature(key, base.message, base.signature)).toBe("A_non_canonical");
    }
    // p - 1 itself is canonical (it is a small-order point, caught one step earlier).
    expect(verifyConsentSignature(le32(P - 1n), base.message, base.signature)).toBe("A_small_order");
  });

  it("R_non_canonical for an R encoding with y >= p", () => {
    for (const y of [P, P + 5n]) {
      const r = le32(y);
      expect(verifyConsentSignature(base.publicKey, base.message, withR(base.signature, r))).toBe("R_non_canonical");
      r[31] = (r[31] ?? 0) | 0x80;
      expect(verifyConsentSignature(base.publicKey, base.message, withR(base.signature, r))).toBe("R_non_canonical");
    }
  });

  it("S_not_reduced for S = L, S + L (malleated) and S = 2^256 - 1", () => {
    const s = readLe(base.signature.subarray(32));
    expect(s).toBeLessThan(L);
    expect(verifyConsentSignature(base.publicKey, base.message, withS(base.signature, L))).toBe("S_not_reduced");
    expect(verifyConsentSignature(base.publicKey, base.message, withS(base.signature, s + L))).toBe("S_not_reduced");
    expect(verifyConsentSignature(base.publicKey, base.message, withS(base.signature, (1n << 256n) - 1n))).toBe(
      "S_not_reduced",
    );
    expect(verifyConsentSignature(base.publicKey, base.message, withS(base.signature, L - 1n))).toBe("signature_invalid");
  });

  it("signature_invalid for a valid signature with one message byte changed", () => {
    for (const index of [0, 50, base.message.length - 1]) {
      const tampered = Uint8Array.from(base.message);
      tampered[index] = (tampered[index] ?? 0) ^ 0x01;
      expect(verifyConsentSignature(base.publicKey, tampered, base.signature)).toBe("signature_invalid");
    }
  });

  it("signature_invalid for a wrong key, a wrong signer and a flipped signature bit", () => {
    const other = throwaway(base.message);
    expect(verifyConsentSignature(other.publicKey, base.message, base.signature)).toBe("signature_invalid");
    const consent = renderConsentMessage({ ...CONSENT_EXAMPLE.input });
    const signedByKey2 = Uint8Array.from(sign(null, consent, contractTestKey(2)));
    expect(verifyConsentSignature(rawPublicKey(contractTestKey(1)), consent, signedByKey2)).toBe("signature_invalid");
    const flipped = Uint8Array.from(base.signature);
    flipped[0] = (flipped[0] ?? 0) ^ 0x01;
    const result = verifyConsentSignature(base.publicKey, base.message, flipped);
    expect(["signature_invalid", "R_non_canonical"]).toContain(result);
  });

  it("checks run in order and stop at the first failure", () => {
    // Non-canonical A with an unreduced S reports the A failure.
    expect(verifyConsentSignature(le32(P), base.message, withS(base.signature, L))).toBe("A_non_canonical");
    // Non-canonical R with an unreduced S reports the R failure.
    expect(verifyConsentSignature(base.publicKey, base.message, withS(withR(base.signature, le32(P)), L))).toBe(
      "R_non_canonical",
    );
    // A small-order key with a non-canonical R reports the small-order failure.
    expect(verifyConsentSignature(new Uint8Array(32), base.message, withR(base.signature, le32(P)))).toBe("A_small_order");
  });
});

describe("no @noble/curves on the verification path (contract section 4.7)", () => {
  it("src/ and scripts/ never import @noble/curves", () => {
    for (const dir of ["src", "scripts"]) {
      const root = new URL(`../${dir}/`, import.meta.url);
      for (const name of readdirSync(root, { recursive: true }) as string[]) {
        if (!/\.(ts|mts|js|mjs|cjs)$/.test(name)) continue;
        const text = readFileSync(new URL(name, root), "utf8");
        expect(text, `${dir}/${name}`).not.toMatch(/from\s+["']@noble\/curves|import\(\s*["']@noble\/curves|require\(\s*["']@noble\/curves/);
      }
    }
  });
});
