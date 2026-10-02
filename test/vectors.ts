/**
 * Vectors copied verbatim from docs/CONTRACT.md (v0). The §11 fixture files
 * land in contract v0.1; until then these are the reference copies, and
 * test/vectors.test.ts asserts that every one still appears in the contract.
 *
 * Keys are public test keys derived from public seeds
 * (`sha256("gogocash contract v0 test key <n>")`, section 4.6). They hold
 * no funds and are not secrets.
 */
import { createHash, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";

// Section 2.4: placeholder program id and PDA vectors.
export const PLACEHOLDER_PROGRAM_ID = "HWNF2cvXybfAjLbw2pydi7sNFmTfYBjpEWNtY3BJfCje";
export const PROGRAM_DATA = { address: "5TKnZEGM435amgcnJX53LoPoiTsYA3yxUMFmd6UvLF7g", bump: 254 };
export const PAYOUT_ID_HEX = "c6a87a9e170995438a78874587cb95773a9fa752c5b1633c9e7ae23928c88021";
export const TEST_SIGNER_1 = "HupSGTuM8ra7TEsYhF4M2NuDt3iEPQVJv3WGnrtDg9D4";
export const PDA_VECTORS = {
  devnet: {
    mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    vault: { address: "4CyfLznBBXqSvKhsLTXgRiqHX5NoxeAe7eaMjfKVsWNG", bump: 254 },
    vaultAta: "CgjjwVZpirGFVos8ugDeYXLVCbnbikEhTM2JUsD58wQZ",
    receipt: { address: "3abi6WfgCceNoMX3Gq5HcqhBePA6T6oNuy7ahhWUQNJR", bump: 251 },
    recipientAta: "8ozizdVK9uxjW7HSYXVyquw3Yn2BfNLkPTPLByfieR62",
  },
  mainnet: {
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    vault: { address: "2eDusayXKM6xkoo86HM2iYjVuJtizTwAL9qvrFpZTinb", bump: 253 },
    vaultAta: "6zCWEQMokz27mauLBMsUU1Luw9yvf3zadojdM1pqAsrX",
    receipt: { address: "Av2ptRUTGRweiHbZxmg82ixJRu5XZiixaGy7mZnQEFPZ", bump: 253 },
    recipientAta: "59WLigKFPCo26D5NByV2nsdtTjbRvivTPi1gUJrLuDoN",
  },
} as const;

// Section 3.2: decode vectors (placeholder program id, devnet mint).
export const RECEIPT_HEX =
  "279a496a50669199fbc6a87a9e170995438a78874587cb95773a9fa752c5b1633c9e7ae23928c88021fb42d41abb4d2f1daf215c9c992f2b77bd5b28151dba1a4f6a9156690feabf53db4d3600000000003e1fbf6a00000000";
export const VAULT_V1_HEX =
  "d308e82b0298757701fe01063b442cb3912157f13a933d0134282d032b5ffecd01a2dbf1b7790608df002ea7ad9e88ce36000f85568c63289a49ddb5ad5c2e62d1ef6ee076f8cf409e6538c6bb1f73e0018299d2baa571fb466bbc997d040e1dfcef3a49b10e363542b95c2a0000000000000000000000000000000000000000000000000000000000000000c659a02bdcd91d24d2608551c37a158ca8fe04fde0365b347de421756e22f2b70a955ff259cacd683426a5247f00cc6d836abe6e88a776cf86397852dbd90c04404b4c0000000000002d310100000000f850000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

// Section 4.6: worked example `consent_devnet_thb_with_fee`.
export const CONSENT_EXAMPLE = {
  input: {
    cluster: "devnet",
    recipient: TEST_SIGNER_1,
    amountAtomic: 3972030n,
    deductedMinor: 15000n,
    feeMinor: 1500n,
    nonce: "75443685f715416cc93848184b356559",
    issuedAtMs: Date.parse("2026-10-02T03:04:05.678Z"),
    withdrawalId: "cddbbad6db231771bc0060be",
    payoutIdHex: PAYOUT_ID_HEX,
    programId: PLACEHOLDER_PROGRAM_ID,
  },
  text: [
    "app-staging.gogocash.co wants you to sign in with your Solana account:",
    "HupSGTuM8ra7TEsYhF4M2NuDt3iEPQVJv3WGnrtDg9D4",
    "",
    "Withdraw 3.972030 USDC to this wallet on Solana devnet (test network, no real value). GoGoCash deducts THB 150.00 from your cashback balance, including a THB 15.00 fee. Sign only if you started this withdrawal in the GoGoCash app.",
    "",
    "URI: https://app-staging.gogocash.co",
    "Version: 1",
    "Chain ID: solana:devnet",
    "Nonce: 75443685f715416cc93848184b356559",
    "Issued At: 2026-10-02T03:04:05.678Z",
    "Expiration Time: 2026-10-02T03:09:05.678Z",
    "Request ID: cddbbad6db231771bc0060be",
    "Resources:",
    "- gogocash:payout:c6a87a9e170995438a78874587cb95773a9fa752c5b1633c9e7ae23928c88021",
    "- gogocash:amount:3972030",
    "- solana:devnet:HWNF2cvXybfAjLbw2pydi7sNFmTfYBjpEWNtY3BJfCje",
  ].join("\n"),
  byteLength: 756,
  sha256: "bfe513dd2f04a2b297170eaf366ef06710189d1a778e94230634979a4db7ac36",
  signatureBase58: "5EMWeLtCM3Bofpf5DHDq3fKbgWPk2C4SZYFq6vCkPd4kYXWJWeePWvJyvJ3yfrC1tSEGMNcPDiRdUHD4RVYfg5Ru",
  signatureHex:
    "d3956b1a12bf7219756157f7e32aea85bd2af06eeb825488bee7e3fed442872ec05bc374d28a46cbea4728a9884e39677e82bd7151159e8af16b116313ee430c",
} as const;

// Section 6.3: the five worked conversion examples.
export const AMOUNT_EXAMPLES = [
  { id: "thb_basic", requested: 12500n, fee: 0n, net: 12500n, rate: 3512345678n, usdc: 3558875n, value: 12500n, defaultDeducted: 12500n, defaultRemainder: 0n, altDeducted: 12500n, altDust: 0n },
  { id: "thb_with_fee", requested: 15000n, fee: 1500n, net: 13500n, rate: 3398765432n, usdc: 3972030n, value: 13500n, defaultDeducted: 15000n, defaultRemainder: 0n, altDeducted: 15000n, altDust: 0n },
  { id: "provider_rate_2026_10_02", requested: 10000n, fee: 1000n, net: 9000n, rate: 3367000000n, usdc: 2673002n, value: 9000n, defaultDeducted: 10000n, defaultRemainder: 0n, altDeducted: 10000n, altDust: 0n },
  { id: "thb_exact_minimum", requested: 4000n, fee: 0n, net: 4000n, rate: 4000000000n, usdc: 1000000n, value: 4000n, defaultDeducted: 4000n, defaultRemainder: 0n, altDeducted: 4000n, altDust: 0n },
  { id: "edge_rate_policies_differ", requested: 12600n, fee: 100n, net: 12500n, rate: 2600000000000n, usdc: 4807n, value: 12499n, defaultDeducted: 12599n, defaultRemainder: 1n, altDeducted: 12600n, altDust: 1n },
] as const;

// ---------------------------------------------------------------------------
// Key helpers (node:crypto only)
// ---------------------------------------------------------------------------

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Ed25519 private key from a 32-byte seed (RFC 8032 secret key). */
export function privateKeyFromSeed(seed: Uint8Array): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
}

/** Raw 32-byte public key of a private key. */
export function rawPublicKey(privateKey: KeyObject): Uint8Array {
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return Uint8Array.from(spki.subarray(spki.length - 32));
}

/** Contract test key n: seed = sha256("gogocash contract v0 test key <n>"). */
export function contractTestKey(n: number): KeyObject {
  const seed = createHash("sha256").update(`gogocash contract v0 test key ${n}`).digest();
  return privateKeyFromSeed(seed);
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function fromHex(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "hex"));
}
