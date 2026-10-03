#!/usr/bin/env node
// Contract v0.1 fixture generator (docs/CONTRACT.md section 11).
//
//   node scripts/contract/gen-fixtures.mjs           # write test/fixtures/*.json
//   node scripts/contract/gen-fixtures.mjs --check   # regenerate in memory, fail on any byte difference
//   node scripts/contract/gen-fixtures.mjs --devnet-program-id <base58> [--check]
//
// This script is an independent oracle for the SDK: it imports only `node:`
// built-ins and never imports src/. It carries its own base58, PDA derivation
// (sha256 plus an Ed25519 on-curve test in BigInt), Borsh layouts, consent
// renderer, conversion arithmetic and transcribed contract tables, and signs
// with Ed25519 through `node:crypto`. test/fixtures.test.ts then checks that
// the SDK agrees with every vector, and tests-litesvm/tests/fixtures.rs
// re-derives every PDA in Rust.
//
// Determinism: keys come from public seeds sha256("gogocash contract v0 test
// key <n>"), ids from fixed id sets, role addresses from sha256 labels. There
// is no clock and no randomness. Every key here is a public test key that
// holds no funds; seeds are written as hex, never as a JSON byte array.
//
// Before writing anything the script checks its own output against the
// reference values printed in docs/CONTRACT.md (PDA table, decode vectors,
// claim data, event, worked consent example, amount table) and against the
// RFC 8032 section 7.1 test vectors, so a bug here fails loudly instead of
// producing plausible fixtures.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES_DIR = join(ROOT, "test", "fixtures");

// ---------------------------------------------------------------------------
// Bytes, hashes, base58
// ---------------------------------------------------------------------------

function sha256(data) {
  return createHash("sha256").update(data).digest();
}

function hex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

function fromHex(text) {
  if (typeof text !== "string" || !/^([0-9a-f]{2})*$/.test(text)) throw new Error(`not lowercase hex: ${text}`);
  return Buffer.from(text, "hex");
}

function fail(message) {
  throw new Error(`gen-fixtures: ${message}`);
}

function assertEqual(actual, expected, what) {
  if (actual !== expected) fail(`${what}: expected ${String(expected)}, got ${String(actual)}`);
}

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = B58_ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  return "1".repeat(zeros) + out;
}

/** Decodes base58 (each leading `1` is one zero byte); `null` on a character outside the alphabet. */
function b58decode(text) {
  let value = 0n;
  for (const ch of text) {
    const digit = B58_ALPHABET.indexOf(ch);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros += 1;
  const body = [];
  while (value > 0n) {
    body.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  return Buffer.from([...new Array(zeros).fill(0), ...body]);
}

/** Section 5.4 strict validator, written independently of src/base58.ts. */
function isStrictBase58(value, n) {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return false;
  const [min, max] = n === 32 ? [32, 44] : n === 64 ? [64, 88] : [1, 0];
  if (value.length < min || value.length > max) return false;
  const bytes = b58decode(value);
  return bytes !== null && bytes.length === n && b58encode(bytes) === value;
}

/** 32 address bytes of a strict base58 address. */
function addressBytes(b58) {
  if (!isStrictBase58(b58, 32)) fail(`not a strict base58 address: ${b58}`);
  return b58decode(b58);
}

function u64le(value) {
  const v = BigInt(value);
  if (v < 0n || v > U64_MAX) fail(`u64 out of range: ${value}`);
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(v);
  return out;
}

function i64le(value) {
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(BigInt(value));
  return out;
}

function readLe(bytes) {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[i]);
  return value;
}

function le32(value) {
  const out = Buffer.alloc(32);
  let v = value;
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

const U64_MAX = (1n << 64n) - 1n;

// ---------------------------------------------------------------------------
// Curve25519 field arithmetic: only the on-curve test PDA derivation needs
// ---------------------------------------------------------------------------

const FIELD_P = (1n << 255n) - 19n;
const GROUP_L = (1n << 252n) + 27742317777372353535851937790883648493n;

function modP(a) {
  const r = a % FIELD_P;
  return r < 0n ? r + FIELD_P : r;
}

function powModP(base, exponent) {
  let result = 1n;
  let b = modP(base);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % FIELD_P;
    b = (b * b) % FIELD_P;
    e >>= 1n;
  }
  return result;
}

const EDWARDS_D = modP(-121665n * powModP(121666n, FIELD_P - 2n));

/**
 * True if the 32 bytes decompress to an Ed25519 point, as curve25519-dalek's
 * `CompressedEdwardsY::decompress` decides (which Solana's
 * `bytes_are_curve_point` uses): y is the low 255 bits taken mod p, and the
 * point exists when (y^2 - 1) / (d y^2 + 1) is a square mod p.
 */
function isOnCurve(bytes32) {
  const y = modP(readLe(bytes32) & ((1n << 255n) - 1n));
  const y2 = (y * y) % FIELD_P;
  const u = modP(y2 - 1n);
  const v = modP(EDWARDS_D * y2 + 1n);
  const w = (u * powModP(v, FIELD_P - 2n)) % FIELD_P;
  if (w === 0n) return true;
  return powModP(w, (FIELD_P - 1n) / 2n) === 1n;
}

const PDA_MARKER = Buffer.from("ProgramDerivedAddress", "utf8");

/** Solana `Pubkey::find_program_address`: the highest bump whose hash is off the curve. */
function findProgramAddress(seeds, programIdB58) {
  if (seeds.length > 15) fail("too many seeds");
  for (const seed of seeds) if (seed.length > 32) fail("seed longer than 32 bytes");
  const program = addressBytes(programIdB58);
  for (let bump = 255; bump >= 0; bump -= 1) {
    const hash = createHash("sha256");
    for (const seed of seeds) hash.update(seed);
    hash.update(Buffer.of(bump));
    hash.update(program);
    hash.update(PDA_MARKER);
    const candidate = hash.digest();
    if (!isOnCurve(candidate)) return { address: b58encode(candidate), bump };
  }
  fail("no viable bump");
}

// ---------------------------------------------------------------------------
// Ed25519 through node:crypto (signing and the raw verify step only)
// ---------------------------------------------------------------------------

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function privateKeyFromSeed(seed) {
  if (seed.length !== 32) fail("Ed25519 seed must be 32 bytes");
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
}

function publicKeyFromSeed(seed) {
  const spki = createPublicKey(privateKeyFromSeed(seed)).export({ format: "der", type: "spki" });
  if (!spki.subarray(0, 12).equals(SPKI_ED25519_PREFIX)) fail("unexpected SPKI prefix");
  return Buffer.from(spki.subarray(12));
}

function ed25519Sign(seed, message) {
  return Buffer.from(sign(null, message, privateKeyFromSeed(seed)));
}

function ed25519VerifyRaw(publicKey, message, signature) {
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, publicKey]), format: "der", type: "spki" });
    return verify(null, message, key, signature) === true;
  } catch {
    return false;
  }
}

function testKeySeed(n) {
  return sha256(`gogocash contract v0 test key ${n}`);
}

function testKeyAddress(n) {
  return b58encode(publicKeyFromSeed(testKeySeed(n)));
}

const SMALL_ORDER_PUBLIC_KEYS_HEX = [
  "0100000000000000000000000000000000000000000000000000000000000000",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0000000000000000000000000000000000000000000000000000000000000080",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
];

const CONSENT_MESSAGE_MAX_BYTES = 1024;

function nonCanonicalPoint(bytes32) {
  return (readLe(bytes32) & ((1n << 255n) - 1n)) >= FIELD_P;
}

/**
 * Section 4.7 `verifyConsentSignature`, used here to double-check the expected
 * result of every constructed vector. The message cap returns `bad_length`
 * (v0.1 changelog, proposed: the v0 text caps messages at 1024 bytes in 4.1
 * but names no refusal).
 */
function consentVerify(publicKey, message, signature) {
  if (publicKey.length !== 32 || signature.length !== 64 || message.length > CONSENT_MESSAGE_MAX_BYTES) {
    return "bad_length";
  }
  if (SMALL_ORDER_PUBLIC_KEYS_HEX.includes(hex(publicKey))) return "A_small_order";
  if (nonCanonicalPoint(publicKey)) return "A_non_canonical";
  if (nonCanonicalPoint(signature.subarray(0, 32))) return "R_non_canonical";
  if (readLe(signature.subarray(32, 64)) >= GROUP_L) return "S_not_reduced";
  return ed25519VerifyRaw(publicKey, message, signature) ? "ok" : "signature_invalid";
}

// ---------------------------------------------------------------------------
// Contract constants (transcribed from docs/CONTRACT.md v0)
// ---------------------------------------------------------------------------

/** Section 2.4: base58(sha256("gogocash_cashback placeholder program id v0")); no private key exists. */
const PLACEHOLDER_PROGRAM_ID = b58encode(sha256("gogocash_cashback placeholder program id v0"));

// ===========================================================================
// G0a PLACEHOLDER: the devnet program id.
// Contract v0 has no real program id (section 2.4, SCHED-8), so the devnet
// slot holds the keyless placeholder. After G0a and the R1 key generation,
// replace this one value with the real devnet program id (or pass
// --devnet-program-id <base58>), regenerate, and commit the new clusters.json
// and pda.json. Everything that depends on the deployment id reads it from
// here; the frozen reference vectors of sections 3.2, 3.4 and 4.6 stay on the
// placeholder by definition.
// ===========================================================================
const DEVNET_PROGRAM_ID_DEFAULT = PLACEHOLDER_PROGRAM_ID;

const LOADER_V3 = "BPFLoaderUpgradeab1e11111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const DEFAULT_PUBKEY = SYSTEM_PROGRAM;

const CLUSTERS = [
  {
    cluster: "devnet",
    genesis_hash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    caip2_chain_id: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    chain_id: "solana:devnet",
    usdc_mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  },
  {
    cluster: "mainnet",
    genesis_hash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    caip2_chain_id: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    chain_id: "solana:mainnet",
    usdc_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
];
const USDC_MINT = Object.fromEntries(CLUSTERS.map((c) => [c.cluster, c.usdc_mint]));

const SIWS_ENVIRONMENT = {
  devnet: { domain: "app-staging.gogocash.co", uri: "https://app-staging.gogocash.co", ttl: 300, label: "devnet (test network, no real value)" },
  mainnet: { domain: "app.gogocash.co", uri: "https://app.gogocash.co", ttl: 180, label: "mainnet" },
};

/** Fixture role addresses: sha256("gogocash contract v0 role <name>") as raw 32 bytes. Nobody holds a key for them. */
function roleAddress(name) {
  return b58encode(sha256(`gogocash contract v0 role ${name}`));
}

/** Fixed id set n (section 4.6 uses set 1). */
function idSet(n) {
  return {
    nonce: hex(sha256(`gogocash contract v0 nonce ${n}`).subarray(0, 16)),
    withdrawal_id: hex(sha256(`gogocash contract v0 withdrawal id ${n}`).subarray(0, 12)),
    payout_id: hex(sha256(`gogocash contract v0 payout id ${n}`)),
  };
}

// Reference values printed in docs/CONTRACT.md v0. The generator must reproduce them.
const REF = {
  placeholder: "HWNF2cvXybfAjLbw2pydi7sNFmTfYBjpEWNtY3BJfCje",
  signer1Seed: "3b18aeea0800c3391609967bac2e46dbf311ff29a50ba8384079366dd89bbc61",
  signer1Address: "HupSGTuM8ra7TEsYhF4M2NuDt3iEPQVJv3WGnrtDg9D4",
  idSet1: {
    nonce: "75443685f715416cc93848184b356559",
    withdrawal_id: "cddbbad6db231771bc0060be",
    payout_id: "c6a87a9e170995438a78874587cb95773a9fa752c5b1633c9e7ae23928c88021",
  },
  pda: {
    programData: ["5TKnZEGM435amgcnJX53LoPoiTsYA3yxUMFmd6UvLF7g", 254],
    devnet: {
      vault: ["4CyfLznBBXqSvKhsLTXgRiqHX5NoxeAe7eaMjfKVsWNG", 254],
      vaultAta: "CgjjwVZpirGFVos8ugDeYXLVCbnbikEhTM2JUsD58wQZ",
      receipt: ["3abi6WfgCceNoMX3Gq5HcqhBePA6T6oNuy7ahhWUQNJR", 251],
      recipientAta: "8ozizdVK9uxjW7HSYXVyquw3Yn2BfNLkPTPLByfieR62",
    },
    mainnet: {
      vault: ["2eDusayXKM6xkoo86HM2iYjVuJtizTwAL9qvrFpZTinb", 253],
      vaultAta: "6zCWEQMokz27mauLBMsUU1Luw9yvf3zadojdM1pqAsrX",
      receipt: ["Av2ptRUTGRweiHbZxmg82ixJRu5XZiixaGy7mZnQEFPZ", 253],
      recipientAta: "59WLigKFPCo26D5NByV2nsdtTjbRvivTPi1gUJrLuDoN",
    },
  },
  discriminators: {
    "account:Vault": "d308e82b02987577",
    "account:Receipt": "279a496a50669199",
    "event:PayoutClaimed": "c8276970743f3a95",
    "global:initialize": "afaf6d1f0d989bed",
    "global:claim": "3ec6d6c1d59f6cd2",
    "global:pause": "d316ddfb4a79c12f",
    "global:unpause": "a99004260a8dbcff",
    "global:update_config": "1d9efcbf0a53db63",
    "global:propose_admin": "79d6c7d4572775ea",
    "global:accept_admin": "702a2d5a74b50daa",
    "global:withdraw": "b712469c946da122",
  },
  receiptHex:
    "279a496a50669199fbc6a87a9e170995438a78874587cb95773a9fa752c5b1633c9e7ae23928c88021fb42d41abb4d2f1daf215c9c992f2b77bd5b28151dba1a4f6a9156690feabf53db4d3600000000003e1fbf6a00000000",
  vaultV1Hex:
    "d308e82b0298757701fe01063b442cb3912157f13a933d0134282d032b5ffecd01a2dbf1b7790608df002ea7ad9e88ce36000f85568c63289a49ddb5ad5c2e62d1ef6ee076f8cf409e6538c6bb1f73e0018299d2baa571fb466bbc997d040e1dfcef3a49b10e363542b95c2a0000000000000000000000000000000000000000000000000000000000000000c659a02bdcd91d24d2608551c37a158ca8fe04fde0365b347de421756e22f2b70a955ff259cacd683426a5247f00cc6d836abe6e88a776cf86397852dbd90c04404b4c0000000000002d310100000000f850000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  claimDataHex:
    "3ec6d6c1d59f6cd2c6a87a9e170995438a78874587cb95773a9fa752c5b1633c9e7ae23928c88021db4d3600000000006520bf6a00000000",
  eventBase64:
    "yCdpcHQ/OpUvpIRAZiyB8sbisxG+o+Rd4XcyW/Sq7bdpC7divXNZNSZSyR4+gTDyDOzyPXg1lEV8b3o70UKeY/qdK7VF4XBOxqh6nhcJlUOKeIdFh8uVdzqfp1LFsWM8nnriOSjIgCH7QtQau00vHa8hXJyZLyt3vVsoFR26Gk9qkVZpD+q/U9tNNgAAAAAAPh+/agAAAAD4UAAAAAAAANtNNgAAAAAAAQAAAAAAAADbTTYAAAAAAA==",
  consent: {
    byteLength: 756,
    sha256: "bfe513dd2f04a2b297170eaf366ef06710189d1a778e94230634979a4db7ac36",
    signatureB58: "5EMWeLtCM3Bofpf5DHDq3fKbgWPk2C4SZYFq6vCkPd4kYXWJWeePWvJyvJ3yfrC1tSEGMNcPDiRdUHD4RVYfg5Ru",
    signatureHex:
      "d3956b1a12bf7219756157f7e32aea85bd2af06eeb825488bee7e3fed442872ec05bc374d28a46cbea4728a9884e39677e82bd7151159e8af16b116313ee430c",
    maxLength: 813,
  },
  /** Section 6.3 worked examples: [id, requested, fee, net, rate, usdc, value, defaultDeducted, defaultRemainder, altDeducted, altDust]. */
  amounts: [
    ["thb_basic", 12500n, 0n, 12500n, 3512345678n, 3558875n, 12500n, 12500n, 0n, 12500n, 0n],
    ["thb_with_fee", 15000n, 1500n, 13500n, 3398765432n, 3972030n, 13500n, 15000n, 0n, 15000n, 0n],
    ["provider_rate_2026_10_02", 10000n, 1000n, 9000n, 3367000000n, 2673002n, 9000n, 10000n, 0n, 10000n, 0n],
    ["thb_exact_minimum", 4000n, 0n, 4000n, 4000000000n, 1000000n, 4000n, 4000n, 0n, 4000n, 0n],
    ["edge_rate_policies_differ", 12600n, 100n, 12500n, 2600000000000n, 4807n, 12499n, 12599n, 1n, 12600n, 1n],
  ],
};

/** RFC 8032 section 7.1 test vectors (seed, public key, message, signature; all hex). */
const RFC8032 = [
  {
    id: "rfc8032_test_1",
    seed: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    public_key: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    message: "",
    signature:
      "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
    source: "RFC 8032 section 7.1, TEST 1",
  },
  {
    id: "rfc8032_test_2",
    seed: "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
    public_key: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
    message: "72",
    signature:
      "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
    source: "RFC 8032 section 7.1, TEST 2",
  },
  {
    id: "rfc8032_test_3",
    seed: "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
    public_key: "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025",
    message: "af82",
    signature:
      "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a",
    source: "RFC 8032 section 7.1, TEST 3",
  },
  {
    id: "rfc8032_test_sha_abc",
    seed: "833fe62409237b9d62ec77587520911e9a759cec1d19755b7da901b96dca3d42",
    public_key: "ec172b93ad5e563bf4932c70e1245034c35467ef2efd4d64ebf819683467e2bf",
    message:
      "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
    signature:
      "dc2a4459e7369633a52b1bf277839a00201009a3efbf3ecb69bea2186c26b58909351fc9ac90b3ecfdfbc7c66431e0303dca179c138ac17ad9bef1177331a704",
    source: "RFC 8032 section 7.1, TEST SHA(abc)",
  },
];

// ---------------------------------------------------------------------------
// Layouts (sections 3.2, 3.3, 3.4) and a generic Borsh encoder over them
// ---------------------------------------------------------------------------

const TYPE_SIZE = { u8: 1, bool: 1, Pubkey: 32, u64: 8, i64: 8, "[u8;8]": 8, "[u8;32]": 32, "[u8;64]": 64 };

function layout(fieldList) {
  let offset = 0;
  return fieldList.map(([name, type]) => {
    const size = TYPE_SIZE[type];
    if (size === undefined) fail(`unknown type ${type}`);
    const field = { name, offset, size, type };
    offset += size;
    return field;
  });
}

function layoutSize(fields) {
  const last = fields[fields.length - 1];
  return last.offset + last.size;
}

const VAULT_FIELDS = layout([
  ["discriminator", "[u8;8]"],
  ["version", "u8"],
  ["bump", "u8"],
  ["paused", "bool"],
  ["decimals", "u8"],
  ["mint", "Pubkey"],
  ["vault_token_account", "Pubkey"],
  ["admin", "Pubkey"],
  ["pending_admin", "Pubkey"],
  ["guardian", "Pubkey"],
  ["claim_authority", "Pubkey"],
  ["max_per_claim", "u64"],
  ["max_per_day", "u64"],
  ["current_day", "i64"],
  ["claimed_today", "u64"],
  ["total_claimed", "u64"],
  ["claim_count", "u64"],
  ["total_withdrawn", "u64"],
  ["reserved", "[u8;64]"],
]);

const RECEIPT_FIELDS = layout([
  ["discriminator", "[u8;8]"],
  ["bump", "u8"],
  ["payout_id", "[u8;32]"],
  ["recipient", "Pubkey"],
  ["amount", "u64"],
  ["claimed_at", "i64"],
]);

const EVENT_FIELDS = layout([
  ["discriminator", "[u8;8]"],
  ["vault", "Pubkey"],
  ["receipt", "Pubkey"],
  ["payout_id", "[u8;32]"],
  ["recipient", "Pubkey"],
  ["amount", "u64"],
  ["claimed_at", "i64"],
  ["day", "i64"],
  ["claimed_today", "u64"],
  ["claim_count", "u64"],
  ["total_claimed", "u64"],
]);

/** Section 3.3: the 8 instructions in their frozen declaration order, with Borsh args. */
const INSTRUCTIONS = [
  ["initialize", [["admin", "Pubkey"], ["guardian", "Pubkey"], ["claim_authority", "Pubkey"], ["max_per_claim", "u64"], ["max_per_day", "u64"]], 120],
  ["claim", [["payout_id", "[u8;32]"], ["amount", "u64"], ["expires_at", "i64"]], 56],
  ["pause", [], 8],
  ["unpause", [], 8],
  ["update_config", [["guardian", "Pubkey"], ["claim_authority", "Pubkey"], ["max_per_claim", "u64"], ["max_per_day", "u64"]], 88],
  ["propose_admin", [["new_admin", "Pubkey"]], 40],
  ["accept_admin", [], 8],
  ["withdraw", [["amount", "u64"]], 16],
].map(([name, args, dataLength]) => {
  const fields = layout([["discriminator", "[u8;8]"], ...args]);
  assertEqual(layoutSize(fields), dataLength, `${name} data length`);
  return { name, fields, dataLength };
});

function discriminator(preimage) {
  const value = hex(sha256(preimage).subarray(0, 8));
  if (REF.discriminators[preimage] !== undefined) assertEqual(value, REF.discriminators[preimage], `discriminator ${preimage}`);
  return value;
}

/** Encodes `values` (fixture JSON form: numbers, booleans, base58, decimal strings, hex) over a layout. */
function encodeLayout(fields, discriminatorHex, values) {
  const parts = [];
  for (const field of fields) {
    if (field.name === "discriminator") {
      parts.push(fromHex(discriminatorHex));
      continue;
    }
    const value = values[field.name];
    if (value === undefined) fail(`missing value for ${field.name}`);
    switch (field.type) {
      case "u8":
        if (!Number.isInteger(value) || value < 0 || value > 255) fail(`${field.name} is not a u8`);
        parts.push(Buffer.of(value));
        break;
      case "bool":
        if (typeof value !== "boolean") fail(`${field.name} is not a bool`);
        parts.push(Buffer.of(value ? 1 : 0));
        break;
      case "Pubkey":
        parts.push(addressBytes(value));
        break;
      case "u64":
        parts.push(u64le(value));
        break;
      case "i64":
        parts.push(i64le(value));
        break;
      default: {
        const bytes = fromHex(value);
        if (bytes.length !== field.size) fail(`${field.name} must be ${field.size} bytes`);
        parts.push(bytes);
      }
    }
  }
  const out = Buffer.concat(parts);
  assertEqual(out.length, layoutSize(fields), "encoded length");
  return out;
}

// ---------------------------------------------------------------------------
// Consent message (section 4)
// ---------------------------------------------------------------------------

function fixed6(atomic) {
  return `${atomic / 1000000n}.${(atomic % 1000000n).toString().padStart(6, "0")}`;
}

function fixed2(minor) {
  return `${minor / 100n}.${(minor % 100n).toString().padStart(2, "0")}`;
}

function consentInputs({ cluster, recipient, amountAtomic, deductedMinor, feeMinor, ids, issuedAt, programId }) {
  const env = SIWS_ENVIRONMENT[cluster];
  const issuedAtMs = Date.parse(issuedAt);
  if (new Date(issuedAtMs).toISOString() !== issuedAt) fail(`issued_at is not a toISOString() value: ${issuedAt}`);
  const expirationMs = issuedAtMs + env.ttl * 1000;
  return {
    cluster,
    domain: env.domain,
    uri: env.uri,
    recipient,
    amount_atomic: amountAtomic.toString(),
    deducted_minor: deductedMinor.toString(),
    fee_minor: feeMinor.toString(),
    nonce: ids.nonce,
    issued_at_ms: issuedAtMs,
    expiration_ms: expirationMs,
    issued_at: issuedAt,
    expiration_time: new Date(expirationMs).toISOString(),
    withdrawal_id: ids.withdrawal_id,
    payout_id: ids.payout_id,
    program_id: programId,
  };
}

/** Renders the 16-line consent message of sections 4.1 to 4.5 and checks the encoding rules. */
function renderConsent(inputs) {
  const env = SIWS_ENVIRONMENT[inputs.cluster];
  if (env === undefined) fail("unknown cluster");
  if (inputs.domain !== env.domain || inputs.uri !== env.uri) fail("domain/uri do not match section 4.4");
  if (!isStrictBase58(inputs.recipient, 32) || !isStrictBase58(inputs.program_id, 32)) fail("bad address");
  if (!/^[1-9][0-9]{0,19}$/.test(inputs.amount_atomic) || BigInt(inputs.amount_atomic) > U64_MAX) fail("bad amount");
  const d = BigInt(inputs.deducted_minor);
  const f = BigInt(inputs.fee_minor);
  if (d < 0n || d > U64_MAX || f < 0n || f > U64_MAX || f > d) fail("D and F must be 0..2^64-1 with F <= D");
  if (!/^[0-9a-f]{32}$/.test(inputs.nonce) || !/^[0-9a-f]{24}$/.test(inputs.withdrawal_id) || !/^[0-9a-f]{64}$/.test(inputs.payout_id)) {
    fail("bad id");
  }
  if (inputs.expiration_ms !== inputs.issued_at_ms + env.ttl * 1000) fail("expiration must equal issued_at + TTL");
  const statement =
    `Withdraw ${fixed6(BigInt(inputs.amount_atomic))} USDC to this wallet on Solana ${env.label}. ` +
    `GoGoCash deducts THB ${fixed2(d)} from your cashback balance, including a THB ${fixed2(f)} fee. ` +
    "Sign only if you started this withdrawal in the GoGoCash app.";
  const lines = [
    `${env.domain} wants you to sign in with your Solana account:`,
    inputs.recipient,
    "",
    statement,
    "",
    `URI: ${env.uri}`,
    "Version: 1",
    `Chain ID: solana:${inputs.cluster}`,
    `Nonce: ${inputs.nonce}`,
    `Issued At: ${inputs.issued_at}`,
    `Expiration Time: ${inputs.expiration_time}`,
    `Request ID: ${inputs.withdrawal_id}`,
    "Resources:",
    `- gogocash:payout:${inputs.payout_id}`,
    `- gogocash:amount:${inputs.amount_atomic}`,
    `- solana:${inputs.cluster}:${inputs.program_id}`,
  ];
  const text = lines.join("\n");
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c !== 0x0a && (c < 0x20 || c > 0x7e)) fail("consent message must be printable ASCII plus LF");
  }
  if (lines.length !== 16 || lines[2] !== "" || lines[4] !== "") fail("consent message line structure");
  for (const line of lines) if (line.startsWith(" ") || line.endsWith(" ") || line.includes("  ")) fail("consent spacing");
  if (text.length > CONSENT_MESSAGE_MAX_BYTES) fail("consent message over 1024 bytes");
  return Buffer.from(text, "latin1");
}

// ---------------------------------------------------------------------------
// Amounts (sections 6.3 and 6.4)
// ---------------------------------------------------------------------------

const RATE_SCALE = 10n ** 12n;

function convert(requested, fee, rate) {
  const net = requested - fee;
  if (net <= 0n || fee < 0n || rate <= 0n) fail("conversion needs net > 0, fee >= 0, rate > 0");
  const usdc = (net * RATE_SCALE) / rate;
  const value = (usdc * rate + RATE_SCALE - 1n) / RATE_SCALE;
  return {
    net,
    usdc,
    value,
    member: { deducted: value + fee, remainder: requested - (value + fee), dust: 0n },
    treasury: { deducted: requested, remainder: 0n, dust: net - value },
  };
}

const THB_AMOUNT = /^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$/;

function parseThb(amount) {
  const match = THB_AMOUNT.exec(amount);
  if (match === null) return null;
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? ".").slice(1).padEnd(2, "0"));
}

function bounds({ amount, fee, rate, min, max }) {
  const requested = parseThb(amount);
  if (requested === null || requested <= 0n) return { expect: "invalid_amount", requested: null, usdc: null };
  if (!(fee < requested)) return { expect: "fee_exceeds_amount", requested, usdc: null };
  const { usdc } = convert(requested, fee, rate);
  if (!(usdc <= U64_MAX)) return { expect: "exceeds_u64", requested, usdc };
  if (!(usdc >= min)) return { expect: "below_minimum", requested, usdc };
  if (!(usdc <= max)) return { expect: "above_maximum", requested, usdc };
  return { expect: "ok", requested, usdc };
}

const D4_SWEEP = { seed: "gogocash contract v0 d4 sweep", count: 10000 };

function d4SweepInput(i) {
  const h = sha256(`${D4_SWEEP.seed} ${i}`);
  const fee = h.readBigUInt64BE(16) % 100000n;
  const net = 1n + (h.readBigUInt64BE(0) % (999999999999n - 100000n));
  const rate = 1n + (h.readBigUInt64BE(8) % (RATE_SCALE - 1n));
  return { requested: net + fee, fee, rate };
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function doc(file, vectors) {
  const ids = new Set();
  for (const v of vectors) {
    if (typeof v.id !== "string" || v.id === "") fail(`${file}: vector without id`);
    if (ids.has(v.id)) fail(`${file}: duplicate id ${v.id}`);
    ids.add(v.id);
  }
  return { contract: "v0", file, vectors };
}

function buildClusters(devnetProgramId) {
  return doc(
    "clusters.json",
    CLUSTERS.map((c) => {
      assertEqual(c.caip2_chain_id, `solana:${c.genesis_hash.slice(0, 32)}`, `${c.cluster} CAIP-2 id`);
      const programId = c.cluster === "devnet" ? devnetProgramId : null;
      return {
        id: c.cluster,
        cluster: c.cluster,
        genesis_hash: c.genesis_hash,
        caip2_chain_id: c.caip2_chain_id,
        chain_id: c.chain_id,
        usdc_mint: c.usdc_mint,
        usdc_mint_owner: TOKEN_PROGRAM,
        usdc_decimals: 6,
        program_id: programId,
        program_id_status: programId === null ? "unassigned" : programId === PLACEHOLDER_PROGRAM_ID ? "placeholder" : "assigned",
        programs: {
          token: TOKEN_PROGRAM,
          associated_token: ATA_PROGRAM,
          system: SYSTEM_PROGRAM,
          bpf_loader_upgradeable: LOADER_V3,
          compute_budget: COMPUTE_BUDGET_PROGRAM,
          token_2022_refused: TOKEN_2022_PROGRAM,
        },
        source: "sections 2.1 to 2.4",
      };
    }),
  );
}

function classicAta(owner, mint) {
  return findProgramAddress([addressBytes(owner), addressBytes(TOKEN_PROGRAM), addressBytes(mint)], ATA_PROGRAM);
}

function buildAccounts() {
  const programId = PLACEHOLDER_PROGRAM_ID;
  const mint = USDC_MINT.devnet;
  const vault = findProgramAddress([Buffer.from("vault"), addressBytes(mint)], programId);
  const vaultAta = classicAta(vault.address, mint).address;
  const payoutId = REF.idSet1.payout_id;
  const receipt = findProgramAddress([Buffer.from("receipt"), addressBytes(vault.address), fromHex(payoutId)], programId);
  const recipient = testKeyAddress(1);
  const roles = { admin: roleAddress("admin"), guardian: roleAddress("guardian"), claim_authority: roleAddress("claim_authority") };

  const vectors = [];
  const layoutVector = (id, kind, name, preimage, fields) => ({
    id,
    kind,
    name,
    discriminator_preimage: preimage,
    discriminator: discriminator(preimage),
    size: layoutSize(fields),
    fields,
    inputs: null,
    bytes: null,
    source: kind === "event_layout" ? "section 3.4" : kind === "instruction_layout" ? "section 3.3" : "section 3.2",
  });
  vectors.push(layoutVector("vault_layout", "account_layout", "Vault", "account:Vault", VAULT_FIELDS));
  vectors.push(layoutVector("receipt_layout", "account_layout", "Receipt", "account:Receipt", RECEIPT_FIELDS));
  vectors.push(layoutVector("payout_claimed_layout", "event_layout", "PayoutClaimed", "event:PayoutClaimed", EVENT_FIELDS));
  assertEqual(layoutSize(VAULT_FIELDS), 324, "Vault size");
  assertEqual(layoutSize(RECEIPT_FIELDS), 89, "Receipt size");
  assertEqual(layoutSize(EVENT_FIELDS), 184, "PayoutClaimed size");
  assertEqual(VAULT_FIELDS.find((f) => f.name === "claim_authority").offset, 172, "Vault claim_authority offset");
  for (const ix of INSTRUCTIONS) {
    vectors.push(layoutVector(`${ix.name}_layout`, "instruction_layout", ix.name, `global:${ix.name}`, ix.fields));
  }

  const vaultV1 = {
    program_id: programId,
    address: vault.address,
    bump: vault.bump,
    version: 1,
    paused: true,
    decimals: 6,
    mint,
    vault_token_account: vaultAta,
    admin: roles.admin,
    pending_admin: DEFAULT_PUBKEY,
    guardian: roles.guardian,
    claim_authority: roles.claim_authority,
    max_per_claim: "5000000",
    max_per_day: "20000000",
    current_day: "20728",
    claimed_today: "0",
    total_claimed: "0",
    claim_count: "0",
    total_withdrawn: "0",
    reserved: "00".repeat(64),
  };
  assertEqual(Math.floor(Date.parse("2026-10-02T00:00:00.000Z") / 86_400_000), 20728, "UTC day of 2026-10-02");
  const vaultV1Bytes = encodeLayout(VAULT_FIELDS, discriminator("account:Vault"), vaultV1);
  assertEqual(hex(vaultV1Bytes), REF.vaultV1Hex, "section 3.2 Vault V1 decode vector");
  vectors.push({
    id: "vault_v1_devnet",
    kind: "account",
    name: "Vault",
    discriminator_preimage: "account:Vault",
    discriminator: discriminator("account:Vault"),
    size: 324,
    fields: null,
    inputs: vaultV1,
    bytes: hex(vaultV1Bytes),
    source: "section 3.2 decode vector V1 (placeholder program id, devnet mint)",
  });

  const amount = "3558875";
  const claimedAt = "1790910270";
  const vaultAfter = { ...vaultV1, paused: false, claimed_today: amount, total_claimed: amount, claim_count: "1" };
  vectors.push({
    id: "vault_after_first_claim_devnet",
    kind: "account",
    name: "Vault",
    discriminator_preimage: "account:Vault",
    discriminator: discriminator("account:Vault"),
    size: 324,
    fields: null,
    inputs: vaultAfter,
    bytes: hex(encodeLayout(VAULT_FIELDS, discriminator("account:Vault"), vaultAfter)),
    source: "section 3.2 (V1 unpaused, after the section 3.4 claim)",
  });

  const receiptInputs = {
    program_id: programId,
    address: receipt.address,
    vault: vault.address,
    bump: receipt.bump,
    payout_id: payoutId,
    recipient,
    amount,
    claimed_at: claimedAt,
  };
  const receiptBytes = encodeLayout(RECEIPT_FIELDS, discriminator("account:Receipt"), receiptInputs);
  assertEqual(hex(receiptBytes), REF.receiptHex, "section 3.2 Receipt decode vector");
  vectors.push({
    id: "receipt_v1_devnet",
    kind: "account",
    name: "Receipt",
    discriminator_preimage: "account:Receipt",
    discriminator: discriminator("account:Receipt"),
    size: 89,
    fields: null,
    inputs: receiptInputs,
    bytes: hex(receiptBytes),
    source: "section 3.2 decode vector (placeholder program id, devnet mint)",
  });

  const eventInputs = {
    program_id: programId,
    vault: vault.address,
    receipt: receipt.address,
    payout_id: payoutId,
    recipient,
    amount,
    claimed_at: claimedAt,
    day: "20728",
    claimed_today: amount,
    claim_count: "1",
    total_claimed: amount,
  };
  const eventBytes = encodeLayout(EVENT_FIELDS, discriminator("event:PayoutClaimed"), eventInputs);
  assertEqual(eventBytes.toString("base64"), REF.eventBase64, "section 3.4 PayoutClaimed vector");
  vectors.push({
    id: "payout_claimed_first_claim_devnet",
    kind: "event",
    name: "PayoutClaimed",
    discriminator_preimage: "event:PayoutClaimed",
    discriminator: discriminator("event:PayoutClaimed"),
    size: 184,
    fields: null,
    inputs: eventInputs,
    bytes: hex(eventBytes),
    source: "section 3.4 vector (first claim of the day)",
  });

  const dataInputs = {
    initialize: { ...roles, max_per_claim: "5000000", max_per_day: "20000000" },
    claim: { payout_id: payoutId, amount, expires_at: "1790910565" },
    pause: {},
    unpause: {},
    update_config: { guardian: roles.guardian, claim_authority: roles.claim_authority, max_per_claim: "5000000", max_per_day: "20000000" },
    propose_admin: { new_admin: roleAddress("new_admin") },
    accept_admin: {},
    withdraw: { amount: "1000000" },
  };
  for (const ix of INSTRUCTIONS) {
    const preimage = `global:${ix.name}`;
    const bytes = encodeLayout(ix.fields, discriminator(preimage), dataInputs[ix.name]);
    if (ix.name === "claim") assertEqual(hex(bytes), REF.claimDataHex, "section 3.3 claim data vector");
    vectors.push({
      id: `${ix.name}_data`,
      kind: "instruction_data",
      name: ix.name,
      discriminator_preimage: preimage,
      discriminator: discriminator(preimage),
      size: ix.dataLength,
      fields: null,
      inputs: dataInputs[ix.name],
      bytes: hex(bytes),
      source: ix.name === "claim" ? "section 3.3 claim data vector" : "section 3.3 (fixture role addresses)",
    });
  }
  return doc("accounts.json", vectors);
}

function buildPda(devnetProgramId) {
  const status = devnetProgramId === PLACEHOLDER_PROGRAM_ID ? "placeholder" : "assigned";
  // Every vector is derived under the devnet program id slot of clusters.json,
  // so `cluster` (the cluster whose program id derived the vector) is "devnet"
  // for all of them: the mainnet program id is null (section 2.4), and no
  // vector may name a cluster whose program does not exist. The section 2.4
  // column "mainnet USDC mint (derivation only)" is keyed by the mint instead:
  // `mint_cluster: "mainnet"`, ids `mainnet_usdc_*`, always derivation_only,
  // also after G0a assigns the real devnet id.
  const cluster = "devnet";
  const vectors = [];
  const push = (id, mintCluster, kind, deriveProgram, seedNames, seeds) => {
    const { address, bump } = findProgramAddress(seeds, deriveProgram);
    vectors.push({
      id,
      program_id: devnetProgramId,
      program_status: status,
      cluster,
      mint_cluster: mintCluster,
      kind,
      derive_program: deriveProgram,
      seed_names: seedNames,
      seeds: seeds.map(hex),
      address,
      bump,
      derivation_only: status === "placeholder" || (mintCluster !== null && mintCluster !== cluster),
      source: "section 2.4",
    });
    return { address, bump };
  };
  // ProgramData does not depend on the mint, so it has one vector.
  const programData = push(`${cluster}_program_data`, null, "program_data", LOADER_V3, ["program_id"], [addressBytes(devnetProgramId)]);
  const derived = {};
  for (const { cluster: mintCluster } of CLUSTERS) {
    const prefix = mintCluster === cluster ? cluster : `${mintCluster}_usdc`;
    const mint = USDC_MINT[mintCluster];
    const vault = push(`${prefix}_vault`, mintCluster, "vault", devnetProgramId, ["utf8:vault", "mint"], [Buffer.from("vault"), addressBytes(mint)]);
    const ataSeeds = (owner) => [addressBytes(owner), addressBytes(TOKEN_PROGRAM), addressBytes(mint)];
    const ataNames = ["owner", "token_program", "mint"];
    const vaultAta = push(`${prefix}_vault_ata`, mintCluster, "associated_token_account", ATA_PROGRAM, ataNames, ataSeeds(vault.address));
    const receipts = [1, 2, 3].map((n) =>
      push(`${prefix}_receipt_${n}`, mintCluster, "receipt", devnetProgramId, ["utf8:receipt", "vault", "payout_id"], [
        Buffer.from("receipt"),
        addressBytes(vault.address),
        fromHex(idSet(n).payout_id),
      ]),
    );
    const recipientAtas = [1, 2].map((n) =>
      push(`${prefix}_recipient_ata_test_key_${n}`, mintCluster, "associated_token_account", ATA_PROGRAM, ataNames, ataSeeds(testKeyAddress(n))),
    );
    derived[mintCluster] = { vault, vaultAta, receipt: receipts[0], recipientAta: recipientAtas[0] };
  }
  // Section 2.4 table, which is computed under the placeholder. Its columns
  // are the devnet and the mainnet USDC mint.
  const ref = REF.pda;
  for (const { cluster: mintCluster } of CLUSTERS) {
    assertEqual(derived[mintCluster].recipientAta.address, ref[mintCluster].recipientAta, `${mintCluster} USDC recipient ATA`);
  }
  if (status === "placeholder") {
    assertEqual(`${programData.address}/${programData.bump}`, ref.programData.join("/"), "ProgramData");
    for (const { cluster: mintCluster } of CLUSTERS) {
      const d = derived[mintCluster];
      assertEqual(`${d.vault.address}/${d.vault.bump}`, ref[mintCluster].vault.join("/"), `${mintCluster} USDC vault`);
      assertEqual(d.vaultAta.address, ref[mintCluster].vaultAta, `${mintCluster} USDC vault ATA`);
      assertEqual(`${d.receipt.address}/${d.receipt.bump}`, ref[mintCluster].receipt.join("/"), `${mintCluster} USDC receipt`);
    }
  }
  return doc("pda.json", vectors);
}

function buildSiws() {
  const programId = PLACEHOLDER_PROGRAM_ID;
  const issuedAt = "2026-10-02T03:04:05.678Z";
  const vectors = [];
  const consentVector = ({ id, inputs, signedBy, signerKey, tamper, messageBytes, signature, expect, source }) => {
    const signer = testKeyAddress(signerKey);
    assertEqual(consentVerify(addressBytes(signer), messageBytes, signature), expect, `${id} expected result`);
    vectors.push({
      id,
      inputs,
      tamper,
      message_b64: messageBytes.toString("base64"),
      byte_length: messageBytes.length,
      sha256: hex(sha256(messageBytes)),
      signer_b58: signer,
      signed_by: `test key ${signedBy}`,
      signature_b58: b58encode(signature),
      expect,
      source,
    });
  };
  const signed = (id, inputs, keyN, source) => {
    const message = renderConsent(inputs);
    const signature = ed25519Sign(testKeySeed(keyN), message);
    consentVector({ id, inputs, signedBy: keyN, signerKey: keyN, tamper: null, messageBytes: message, signature, expect: "ok", source });
    return { message, signature };
  };

  // Section 4.6 worked example.
  const ids1 = idSet(1);
  for (const [k, v] of Object.entries(REF.idSet1)) assertEqual(ids1[k], v, `fixed id set 1 ${k}`);
  const withFee = convert(15000n, 1500n, 3398765432n);
  const exampleInputs = consentInputs({
    cluster: "devnet",
    recipient: testKeyAddress(1),
    amountAtomic: withFee.usdc,
    deductedMinor: withFee.member.deducted,
    feeMinor: 1500n,
    ids: ids1,
    issuedAt,
    programId,
  });
  const example = signed("consent_devnet_thb_with_fee", exampleInputs, 1, "section 4.6 worked example (amount vector thb_with_fee, id set 1)");
  assertEqual(example.message.length, REF.consent.byteLength, "section 4.6 byte length");
  assertEqual(hex(sha256(example.message)), REF.consent.sha256, "section 4.6 sha256");
  assertEqual(b58encode(example.signature), REF.consent.signatureB58, "section 4.6 signature (base58)");
  assertEqual(hex(example.signature), REF.consent.signatureHex, "section 4.6 signature (hex)");

  // The widest legal message (section 4.1): u64-max amounts, 44-character address and program id, devnet domain.
  const maxInputs = consentInputs({
    cluster: "devnet",
    recipient: testKeyAddress(1),
    amountAtomic: U64_MAX,
    deductedMinor: U64_MAX,
    feeMinor: U64_MAX,
    ids: idSet(2),
    issuedAt,
    programId,
  });
  if (maxInputs.recipient.length !== 44 || maxInputs.program_id.length !== 44) fail("max-length vector needs 44-character keys");
  const max = signed("consent_devnet_max_length", maxInputs, 1, "section 4.1 maximum length (813 bytes)");
  assertEqual(max.message.length, REF.consent.maxLength, "section 4.1 widest legal message");

  // Mainnet row of section 4.4. Mainnet has no program id in v0, so this tests the renderer only.
  const basic = convert(12500n, 0n, 3512345678n);
  signed(
    "consent_mainnet_renderer_only",
    consentInputs({
      cluster: "mainnet",
      recipient: testKeyAddress(2),
      amountAtomic: basic.usdc,
      deductedMinor: basic.member.deducted,
      feeMinor: 0n,
      ids: idSet(2),
      issuedAt,
      programId,
    }),
    2,
    "section 4.4 mainnet row; renderer only (mainnet has no program id in v0, the placeholder stands in)",
  );

  // Open item O7: a non-zero remainder needs a synthetic rate at or above 10^12; renderer only.
  const edge = convert(12600n, 100n, 2600000000000n);
  if (edge.member.remainder === 0n) fail("O7 vector needs a non-zero remainder");
  signed(
    "consent_devnet_edge_rate_remainder",
    consentInputs({
      cluster: "devnet",
      recipient: testKeyAddress(1),
      amountAtomic: edge.usdc,
      deductedMinor: edge.member.deducted,
      feeMinor: 100n,
      ids: idSet(3),
      issuedAt,
      programId,
    }),
    1,
    "section 12 O7 (amount vector edge_rate_policies_differ, member keeps the remainder); renderer only",
  );

  // Tamper negatives of section 4.6, each verified with the original signature.
  const text = example.message.toString("latin1");
  const amountLine = `- gogocash:amount:${exampleInputs.amount_atomic}`;
  const plusOne = `- gogocash:amount:${BigInt(exampleInputs.amount_atomic) + 1n}`;
  if (!text.includes(amountLine)) fail("amount line not found");
  const tampers = [
    ["consent_devnet_tamper_amount_plus_1", "amount_plus_1", text.replace(amountLine, plusOne)],
    ["consent_devnet_tamper_trailing_lf", "trailing_lf", `${text}\n`],
    ["consent_devnet_tamper_crlf", "crlf", text.replaceAll("\n", "\r\n")],
  ];
  for (const [id, tamper, tamperedText] of tampers) {
    consentVector({
      id,
      inputs: exampleInputs,
      signedBy: 1,
      signerKey: 1,
      tamper,
      messageBytes: Buffer.from(tamperedText, "latin1"),
      signature: example.signature,
      expect: "signature_invalid",
      source: "section 4.6 negative",
    });
  }
  // Wrong signer: the stored bytes signed by test key 2, verified against test key 1.
  consentVector({
    id: "consent_devnet_wrong_signer",
    inputs: exampleInputs,
    signedBy: 2,
    signerKey: 1,
    tamper: null,
    messageBytes: example.message,
    signature: ed25519Sign(testKeySeed(2), example.message),
    expect: "signature_invalid",
    source: "section 4.7 negative (wrong signer)",
  });
  return doc("siws.json", vectors);
}

function buildEd25519() {
  const vectors = [];
  for (const v of RFC8032) {
    const seed = fromHex(v.seed);
    assertEqual(hex(publicKeyFromSeed(seed)), v.public_key, `${v.id} public key`);
    assertEqual(hex(ed25519Sign(seed, fromHex(v.message))), v.signature, `${v.id} signature`);
    assertEqual(consentVerify(fromHex(v.public_key), fromHex(v.message), fromHex(v.signature)), "ok", `${v.id} verify`);
    vectors.push({ id: v.id, kind: "rfc8032", seed: v.seed, public_key: v.public_key, message: v.message, signature: v.signature, expect: "ok", source: v.source });
  }
  for (const n of [1, 2, 3]) {
    const seed = testKeySeed(n);
    const publicKey = publicKeyFromSeed(seed);
    if (n === 1) {
      assertEqual(hex(seed), REF.signer1Seed, "test key 1 seed");
      assertEqual(b58encode(publicKey), REF.signer1Address, "test key 1 address");
    }
    vectors.push({
      id: `test_key_${n}`,
      kind: "test_key",
      seed_preimage: `gogocash contract v0 test key ${n}`,
      seed: hex(seed),
      public_key: hex(publicKey),
      public_key_b58: b58encode(publicKey),
      source: "section 4.6 (public test key; holds no funds)",
    });
  }

  const seed1 = testKeySeed(1);
  const key1 = publicKeyFromSeed(seed1);
  const key2 = publicKeyFromSeed(testKeySeed(2));
  const message = Buffer.from("gogocash contract v0 ed25519 verify vector", "latin1");
  const sig = ed25519Sign(seed1, message);
  const withR = (r) => Buffer.concat([r, sig.subarray(32)]);
  const withS = (s) => Buffer.concat([sig.subarray(0, 32), le32(s)]);
  const sValue = readLe(sig.subarray(32));
  const flippedMessage = Buffer.from(message);
  flippedMessage[flippedMessage.length - 1] ^= 0x01;
  const msg1024 = Buffer.alloc(1024, 0x41);
  const msg1025 = Buffer.alloc(1025, 0x41);
  const withSignBit = (bytes) => {
    const out = Buffer.from(bytes);
    out[31] |= 0x80;
    return out;
  };
  const cases = [
    ["verify_ok_test_key_1", key1, message, sig, "ok", "section 4.7 positive"],
    ["verify_ok_message_1024_bytes", key1, msg1024, ed25519Sign(seed1, msg1024), "ok", "section 4.1 maximum length"],
    ["bad_length_public_key_31_bytes", key1.subarray(0, 31), message, sig, "bad_length", "section 4.7 step 1"],
    ["bad_length_public_key_33_bytes", Buffer.concat([key1, Buffer.of(0)]), message, sig, "bad_length", "section 4.7 step 1"],
    ["bad_length_signature_63_bytes", key1, message, sig.subarray(0, 63), "bad_length", "section 4.7 step 1"],
    ["bad_length_signature_65_bytes", key1, message, Buffer.concat([sig, Buffer.of(0)]), "bad_length", "section 4.7 step 1"],
    [
      "bad_length_message_1025_bytes",
      key1,
      msg1025,
      ed25519Sign(seed1, msg1025),
      "bad_length",
      "sections 4.1 and 4.7; refusal name proposed in the v0.1 changelog",
    ],
    ...SMALL_ORDER_PUBLIC_KEYS_HEX.map((k, i) => [`a_small_order_${i}`, fromHex(k), message, sig, "A_small_order", "section 4.7 step 2"]),
    ["a_non_canonical_y_eq_p", le32(FIELD_P), message, sig, "A_non_canonical", "section 4.7 step 3"],
    ["a_non_canonical_y_eq_p_plus_1_sign_bit", withSignBit(le32(FIELD_P + 1n)), message, sig, "A_non_canonical", "section 4.7 step 3"],
    ["a_non_canonical_all_ff", Buffer.alloc(32, 0xff), message, sig, "A_non_canonical", "section 4.7 step 3"],
    ["r_non_canonical_y_eq_p", key1, message, withR(le32(FIELD_P)), "R_non_canonical", "section 4.7 step 4"],
    ["r_non_canonical_y_eq_p_plus_5_sign_bit", key1, message, withR(withSignBit(le32(FIELD_P + 5n))), "R_non_canonical", "section 4.7 step 4"],
    ["s_not_reduced_s_plus_l", key1, message, withS(sValue + GROUP_L), "S_not_reduced", "section 4.7 step 5 (malleated S + L)"],
    ["s_not_reduced_s_eq_l", key1, message, withS(GROUP_L), "S_not_reduced", "section 4.7 step 5"],
    ["signature_invalid_s_eq_l_minus_1", key1, message, withS(GROUP_L - 1n), "signature_invalid", "section 4.7 step 6"],
    ["signature_invalid_wrong_message", key1, flippedMessage, sig, "signature_invalid", "section 4.7 step 6 (wrong message)"],
    ["signature_invalid_wrong_key", key2, message, sig, "signature_invalid", "section 4.7 step 6 (wrong key)"],
    ["signature_invalid_wrong_signer", key1, message, ed25519Sign(testKeySeed(2), message), "signature_invalid", "section 4.7 step 6 (wrong signer)"],
    ["order_a_non_canonical_before_s", le32(FIELD_P), message, withS(GROUP_L), "A_non_canonical", "section 4.7 (first failure wins)"],
    ["order_r_non_canonical_before_s", key1, message, Buffer.concat([le32(FIELD_P), le32(GROUP_L)]), "R_non_canonical", "section 4.7 (first failure wins)"],
    ["order_small_order_before_r", Buffer.alloc(32), message, withR(le32(FIELD_P)), "A_small_order", "section 4.7 (first failure wins)"],
  ];
  if (sValue >= GROUP_L) fail("node:crypto produced an unreduced S");
  for (const [id, publicKey, msg, signature, expect, source] of cases) {
    assertEqual(consentVerify(publicKey, msg, signature), expect, `${id} expected result`);
    vectors.push({ id, kind: "verify", public_key: hex(publicKey), message: hex(msg), signature: hex(signature), expect, source });
  }

  // Section 5.4 strict base58 self-check values.
  const signatureB58 = b58encode(sig);
  const key1B58 = b58encode(key1);
  const replaceAt = (text, index, ch) => text.slice(0, index) + ch + text.slice(index + 1);
  const base58Cases = [
    ["b58_ok_test_key_1", key1B58, 32, "ok", "section 5.4 (test key 1 passes)"],
    ["b58_ok_test_key_1_signature", signatureB58, 64, "ok", "section 5.4 (its signature passes)"],
    ["b58_ok_all_zero_address", DEFAULT_PUBKEY, 32, "ok", "section 5.4 (32 zero bytes)"],
    ["b58_ok_token_program", TOKEN_PROGRAM, 32, "ok", "section 2.2"],
    ["b58_invalid_31_bytes", b58encode(key1.subarray(0, 31)), 32, "invalid", "section 5.4 (31-byte value)"],
    ["b58_invalid_contains_zero", replaceAt(key1B58, 5, "0"), 32, "invalid", "section 5.4 (character 0)"],
    ["b58_invalid_contains_capital_o", replaceAt(key1B58, 5, "O"), 32, "invalid", "section 5.4 (character O)"],
    ["b58_invalid_contains_capital_i", replaceAt(key1B58, 5, "I"), 32, "invalid", "section 5.4 (character I)"],
    ["b58_invalid_contains_lower_l", replaceAt(key1B58, 5, "l"), 32, "invalid", "section 5.4 (character l)"],
    ["b58_invalid_lower_cased", key1B58.toLowerCase(), 32, "invalid", "section 5.4 (lower-cased address)"],
    ["b58_invalid_extra_leading_1", `1${key1B58}`, 32, "invalid", "section 5.4 (extra leading 1)"],
    ["b58_invalid_trailing_space", `${key1B58} `, 32, "invalid", "section 5.4 (no trimming)"],
    ["b58_invalid_empty", "", 32, "invalid", "section 5.4"],
    ["b58_invalid_signature_as_address", signatureB58, 32, "invalid", "section 5.4 (n = 32)"],
    ["b58_invalid_address_as_signature", key1B58, 64, "invalid", "section 5.4 (n = 64)"],
  ];
  for (const [id, value, n, expect, source] of base58Cases) {
    assertEqual(isStrictBase58(value, n) ? "ok" : "invalid", expect, `${id} strict base58`);
    vectors.push({ id, kind: "strict_base58", value, n, expect, source });
  }
  return doc("ed25519.json", vectors);
}

const PROGRAM_ERRORS = [
  [6000, "Paused", "Vault is paused", ["claim C1"], "hold"],
  [6001, "InvalidClaimAuthority", "Signer is not the vault claim authority", ["claim C2"], "config"],
  [6002, "NotAdmin", "Signer is not the vault admin", ["unpause U1", "update_config G1", "propose_admin A1", "withdraw W1"], "bug"],
  [6003, "NotAdminOrGuardian", "Signer is neither the vault admin nor the guardian", ["pause P1"], "bug"],
  [6004, "NotPendingAdmin", "Signer is not the pending admin", ["accept_admin B1"], "bug"],
  [6005, "NotUpgradeAuthority", "Signer is not the program upgrade authority", ["initialize I2"], "config"],
  [6006, "InvalidProgramData", "Account is not this program's ProgramData account", ["initialize I1"], "bug"],
  [6007, "InvalidRole", "Role must not be the default public key", ["initialize I5", "update_config G2"], "bug"],
  [6008, "ZeroPayoutId", "Payout id must not be all zero bytes", ["claim C6"], "bug"],
  [6009, "ZeroAmount", "Amount must be greater than zero", ["claim C7", "withdraw W4"], "bug"],
  [6010, "ExceedsMaxPerClaim", "Amount exceeds the per-claim cap", ["claim C8"], "needs_review"],
  [6011, "DayCapExceeded", "Claim would exceed the daily cap", ["claim C10"], "hold"],
  [6012, "Expired", "Claim has expired", ["claim C11"], "retry"],
  [6013, "ExpiryTooFar", "Claim expiry is more than 900 seconds ahead", ["claim C12"], "bug"],
  [6014, "VaultTokenAccountFrozen", "Vault token account is frozen", ["claim C13", "withdraw W6"], "hold"],
  [6015, "RecipientTokenAccountFrozen", "Recipient token account is frozen", ["claim C14"], "needs_review"],
  [6016, "InsufficientVaultBalance", "Vault balance is below the amount", ["claim C15", "withdraw W7"], "hold"],
  [6017, "InvalidRecipient", "Recipient must not be the vault, the claim authority or the payer", ["claim C5"], "needs_review"],
  [6018, "InvalidVaultTokenAccount", "Vault token account is not canonical or has a delegate or close authority", ["initialize I4", "claim C4", "withdraw W3"], "config"],
  [6019, "InvalidMint", "Mint is not the vault mint or does not have 6 decimals", ["initialize I3", "claim C3", "withdraw W2"], "config"],
  [6020, "RoleConflict", "Claim authority must not also be the admin or the guardian", ["initialize I6", "update_config G3", "propose_admin A2", "accept_admin B2"], "bug"],
  [6021, "InvalidCaps", "Caps must be non-zero and max_per_claim must not exceed max_per_day", ["initialize I7", "update_config G4"], "bug"],
  [6022, "InvalidWithdrawDestination", "Withdraw destination must be an unfrozen vault-mint token account owned by the admin", ["withdraw W5"], "bug"],
  [6023, "MathOverflow", "Arithmetic overflow", ["claim C9", "claim C12", "claim effects", "withdraw W8"], "bug"],
];

const PROGRAM_HOLD_REASONS = { 6000: "program_paused", 6011: "day_cap", 6016: "vault_low" };
/** Section 9.1 class table: a `config` error is a T3 hold with `config_mismatch`. */
const holdReasonOf = (cls, code) => (cls === "config" ? "config_mismatch" : (PROGRAM_HOLD_REASONS[code] ?? null));

const ANCHOR_ERRORS = [
  [100, "InstructionMissing", "data shorter than 8 bytes", "bug"],
  [101, "InstructionFallbackNotFound", "unknown discriminator: wrong program at the address, stub or older build", "config"],
  [102, "InstructionDidNotDeserialize", "args malformed", "bug"],
  [2000, "ConstraintMut", "writable flag missing", "bug"],
  [2006, "ConstraintSeeds", "vault or receipt address not the canonical PDA (wrong program id or mint in derivation)", "bug"],
  [2009, "ConstraintAssociated", "recipient or vault token account is not the canonical ATA", "bug"],
  [2015, "ConstraintTokenOwner", "claim: the recipient token account passed is not owned by recipient (a re-owned canonical ATA fails earlier at the ATA index); initialize: vault ATA not owned by the vault", "bug"],
  [2023, "ConstraintAssociatedTokenTokenProgram", "ATA not under classic Token", "bug"],
  [2040, "ConstraintDuplicateMutableAccount", "the same account passed twice as mutable (for example destination = vault token account)", "bug"],
  [2500, "RequireViolated", "Require*: not used (the program uses custom codes)", "bug"],
  [2501, "RequireEqViolated", "Require*: not used (the program uses custom codes)", "bug"],
  [2502, "RequireKeysEqViolated", "Require*: not used (the program uses custom codes)", "bug"],
  [2503, "RequireNeqViolated", "Require*: not used (the program uses custom codes)", "bug"],
  [2504, "RequireKeysNeqViolated", "Require*: not used (the program uses custom codes)", "bug"],
  [2505, "RequireGtViolated", "Require*: not used (the program uses custom codes)", "bug"],
  [2506, "RequireGteViolated", "Require*: not used (the program uses custom codes)", "bug"],
  [3001, "AccountDiscriminatorNotFound", "vault address holds something else; layout or program-id mismatch", "config"],
  [3002, "AccountDiscriminatorMismatch", "vault address holds something else; layout or program-id mismatch", "config"],
  [3003, "AccountDidNotDeserialize", "vault address holds something else; layout or program-id mismatch", "config"],
  [3005, "AccountNotEnoughKeys", "account list too short", "bug"],
  [3007, "AccountOwnedByWrongProgram", "Token-2022 mint or token account, or a vault from another program", "config"],
  [3008, "InvalidProgramId", "wrong token or system program passed", "bug"],
  [3009, "InvalidProgramExecutable", "program account not executable", "bug"],
  [3010, "AccountNotSigner", "claim_authority, payer or admin did not sign", "bug"],
  [3011, "AccountNotSystemOwned", "recipient is owned by a program (not a wallet)", "needs_review"],
  [3012, "AccountNotInitialized", "recipient ATA missing (or vault not initialized); config for the rail and for the SDK claim-tx builder, which always sends createAssociatedTokenIdempotent", "config"],
  [3013, "AccountNotProgramData", "initialize given a non-ProgramData account", "bug"],
  [3014, "AccountNotAssociatedTokenAccount", "not expected with these constraints", "bug"],
  [4100, "DeclaredProgramIdMismatch", "the deployed binary was built for another program id (wrong cargo feature)", "config"],
  [4101, "TryingToInitPayerAsProgramAccount", "payer equals an init account", "bug"],
];

function buildErrors() {
  const vectors = [];
  const latches = (cls, code) => cls === "bug" || cls === "config" || code === 6014;
  for (const [code, name, message, raisedBy, cls] of PROGRAM_ERRORS) {
    vectors.push({
      id: `program_${code}`,
      kind: "program",
      code,
      name,
      message,
      raised_by: raisedBy,
      where: null,
      instruction: null,
      error: { custom: code },
      logs: null,
      class: cls,
      hold_reason: holdReasonOf(cls, code),
      halt_latch: latches(cls, code),
      source:
        code === 6014
          ? "section 3.5 (hold + CRITICAL + halt latch); hold reason unnamed, see the v0.1 changelog"
          : cls === "config"
            ? "sections 3.5 and 9.1 (config: T3 hold config_mismatch)"
            : "section 3.5",
    });
  }
  if (vectors.map((v) => v.code).join(",") !== Array.from({ length: 24 }, (_, i) => 6000 + i).join(",")) fail("program codes 6000-6023");
  for (const [code, name, where, cls] of ANCHOR_ERRORS) {
    vectors.push({
      id: `anchor_${code}`,
      kind: "anchor",
      code,
      name,
      message: null,
      raised_by: null,
      where,
      instruction: null,
      error: { custom: code },
      logs: null,
      class: cls,
      hold_reason: holdReasonOf(cls, code),
      halt_latch: latches(cls, code),
      source:
        code === 100
          ? "section 3.6 (v0 text; see the v0.1 changelog: Anchor 1.2.0 returns 101 for data shorter than 8 bytes)"
          : cls === "config"
            ? "sections 3.6 and 9.1 (config: T3 hold config_mismatch)"
            : "section 3.6",
    });
  }
  const indexRule = (id, instruction, error, logs, name, where, cls, holdReason, source) => ({
    id,
    kind: "instruction_index",
    code: "custom" in error ? error.custom : null,
    name,
    message: null,
    raised_by: null,
    where,
    instruction,
    error,
    logs,
    class: cls,
    hold_reason: holdReason,
    halt_latch: latches(cls, null),
    source,
  });
  const alreadyInUseLog = "Create Account: account Address { address: 3abi6WfgCceNoMX3Gq5HcqhBePA6T6oNuy7ahhWUQNJR, base: None } already in use";
  vectors.push(
    indexRule("claim_custom_0_already_in_use", "claim", { custom: 0 }, [alreadyInUseLog], "AccountAlreadyInUse", "receipt for this payout_id already exists", "already_claimed", null, "section 3.7"),
    indexRule("claim_custom_0_logs_truncated", "claim", { custom: 0 }, null, "AccountAlreadyInUse", "Custom(0) at the claim index alone still routes to receipt verification", "already_claimed", null, "section 3.7"),
    indexRule("claim_custom_1_insufficient_lamports", "claim", { custom: 1 }, ["Transfer: insufficient lamports 1000, need 1102360"], "ResultWithNegativeLamports", "payer cannot fund the receipt rent", "hold", "fee_payer_low", "sections 3.7 and 9.1"),
    indexRule("claim_custom_1_without_log", "claim", { custom: 1 }, [], null, "Custom(1) without the insufficient-lamports log falls to the any-other row", "bug", null, "section 3.7 (made explicit in the v0.1 changelog)"),
    indexRule("claim_custom_4_spl_token", "claim", { custom: 4 }, null, null, "any other Custom(n) with n < 6000 not in 3.6 (here SPL Token OwnerMismatch from transfer_checked)", "bug", null, "section 3.7"),
    indexRule("claim_named_unlisted", "claim", { name: "InvalidAccountData" }, null, "InvalidAccountData", "a named (non-Custom) error at the claim index, not listed in 3.7", "bug", null, "section 3.7 (made explicit in the v0.1 changelog)"),
    indexRule("initialize_custom_0_already_in_use", "initialize", { custom: 0 }, null, "AccountAlreadyInUse", "vault for this mint already exists", "bug", null, "section 3.7"),
    indexRule("ata_custom_0_invalid_owner", "create_associated_token_idempotent", { custom: 0 }, null, "InvalidOwner", "the recipient's ATA exists but was re-owned", "needs_review", null, "section 3.7"),
    indexRule("ata_illegal_owner", "create_associated_token_idempotent", { name: "IllegalOwner" }, null, "IllegalOwner", "the recipient's ATA exists but was re-owned", "needs_review", null, "section 3.7"),
    indexRule("ata_custom_1_insufficient_lamports", "create_associated_token_idempotent", { custom: 1 }, null, "ResultWithNegativeLamports", "payer cannot fund ATA rent", "hold", "fee_payer_low", "sections 3.7 and 9.1"),
    indexRule("ata_custom_2_unlisted", "create_associated_token_idempotent", { custom: 2 }, null, null, "an ATA-index error not listed in 3.7", "bug", null, "section 3.7 (made explicit in the v0.1 changelog)"),
    indexRule("ata_named_unlisted", "create_associated_token_idempotent", { name: "InvalidAccountData" }, null, "InvalidAccountData", "an ATA-index error not listed in 3.7", "bug", null, "section 3.7 (made explicit in the v0.1 changelog)"),
    indexRule("compute_budget_any", "compute_budget", { name: "InvalidInstructionData" }, null, "InvalidInstructionData", "malformed budget instruction", "bug", null, "section 3.7"),
  );
  const txLevel = (name, cls, holdReason) => ({
    id: `transaction_${name}`,
    kind: "transaction",
    code: null,
    name,
    message: null,
    raised_by: null,
    where: "transaction-level error without an instruction index",
    instruction: null,
    error: { name },
    logs: null,
    class: cls,
    hold_reason: holdReason,
    halt_latch: latches(cls, null),
    source: "section 9.1 (referenced by section 3.7)",
  });
  vectors.push(
    txLevel("BlockhashNotFound", "retry", null),
    txLevel("AccountInUse", "retry", null),
    txLevel("InsufficientFundsForFee", "hold", "fee_payer_low"),
    txLevel("InsufficientFundsForRent", "hold", "fee_payer_low"),
    txLevel("AccountNotFound", "bug", null),
  );
  return doc("errors.json", vectors);
}

function buildAmounts() {
  const vectors = [];
  for (const [id, requested, fee, net, rate, usdc, value, dd, dr, ad, adust] of REF.amounts) {
    const c = convert(requested, fee, rate);
    const got = [c.net, c.usdc, c.value, c.member.deducted, c.member.remainder, c.treasury.deducted, c.treasury.dust].join("/");
    assertEqual(got, [net, usdc, value, dd, dr, ad, adust].join("/"), `section 6.3 row ${id}`);
  }
  const conversion = (id, requested, fee, rate, source) => {
    const c = convert(requested, fee, rate);
    if (c.value > c.net || c.member.deducted > requested) fail(`${id}: over-deduction`);
    if (rate < RATE_SCALE && c.value !== c.net) fail(`${id}: D4 invariant`);
    vectors.push({
      id,
      kind: "conversion",
      requested_minor: requested.toString(),
      fee_minor: fee.toString(),
      net_minor: c.net.toString(),
      thb_per_usd_e8: rate.toString(),
      usdc_atomic: c.usdc.toString(),
      value_minor: c.value.toString(),
      member_keeps_remainder: {
        deducted_minor: c.member.deducted.toString(),
        remainder_minor: c.member.remainder.toString(),
        treasury_dust_minor: "0",
      },
      treasury_keeps_remainder: {
        deducted_minor: c.treasury.deducted.toString(),
        remainder_minor: "0",
        treasury_dust_minor: c.treasury.dust.toString(),
      },
      policies_deduct_equal: c.member.deducted === c.treasury.deducted,
      expect: "ok",
      source,
    });
  };
  for (const [id, requested, fee, , rate] of REF.amounts) conversion(id, requested, fee, rate, "section 6.3 worked example");
  conversion("edge_rate_exactly_1e12", 10000n, 0n, RATE_SCALE, "section 6.3 (rate = 10^12: still no remainder)");
  conversion("edge_rate_fx_band_min", 10000n, 1000n, 2500000000n, "sections 6.3 and 6.6 (SOLANA_WITHDRAW_FX_MIN_E8 default)");
  conversion("edge_rate_fx_band_max", 10000n, 1000n, 4500000000n, "sections 6.3 and 6.6 (SOLANA_WITHDRAW_FX_MAX_E8 default)");
  conversion("edge_net_one_satang", 101n, 100n, 3367000000n, "section 6.3 (net_minor = 1)");

  // D4 invariant: below 10^12 the two dust policies deduct identical satang.
  const lines = [];
  for (let i = 0; i < D4_SWEEP.count; i += 1) {
    const { requested, fee, rate } = d4SweepInput(i);
    const c = convert(requested, fee, rate);
    if (c.value !== c.net || c.member.deducted !== c.treasury.deducted || c.member.remainder !== 0n) fail(`D4 sweep ${i}`);
    lines.push(`${requested},${fee},${rate},${c.usdc},${c.value},${c.member.deducted},${c.member.remainder},${c.treasury.deducted},${c.treasury.dust}\n`);
  }
  vectors.push({
    id: "d4_invariant_sweep",
    kind: "d4_invariant",
    statement: "for 1 <= thb_per_usd_e8 < 10^12 and net_minor > 0: value_minor == net_minor, so both dust policies deduct the same satang and the remainder is 0",
    rate_max_exclusive: RATE_SCALE.toString(),
    sweep_seed: D4_SWEEP.seed,
    sweep_count: D4_SWEEP.count,
    sweep_rule:
      "h = sha256(seed + ' ' + i); fee = be_u64(h[16..24]) mod 100000; net = 1 + be_u64(h[0..8]) mod 999999899999; rate = 1 + be_u64(h[8..16]) mod 999999999999; requested = net + fee",
    line_format: "requested,fee,rate,usdc,value,member_deducted,member_remainder,treasury_deducted,treasury_dust LF",
    lines_sha256: hex(sha256(lines.join(""))),
    expect: "ok",
    source: "section 6.3 (founder decision D4)",
  });

  const MIN = 1000000n;
  const MAX = 5000000n;
  const RATE = 3367000000n;
  const boundsCases = [
    ["bounds_ok_provider_rate", "100.00", 1000n, RATE],
    ["bounds_ok_exact_minimum", "40.00", 0n, 4000000000n],
    ["bounds_ok_exact_maximum", "168.35", 0n, RATE],
    ["bounds_ok_integer_amount", "100", 1000n, RATE],
    ["bounds_invalid_amount_empty", "", 0n, RATE],
    ["bounds_invalid_amount_zero", "0", 0n, RATE],
    ["bounds_invalid_amount_zero_decimals", "0.00", 0n, RATE],
    ["bounds_invalid_amount_three_decimals", "1.234", 0n, RATE],
    ["bounds_invalid_amount_leading_zero", "01", 0n, RATE],
    ["bounds_invalid_amount_negative", "-1", 0n, RATE],
    ["bounds_invalid_amount_exponent", "1e3", 0n, RATE],
    ["bounds_invalid_amount_eleven_digits", "12345678901", 0n, RATE],
    ["bounds_invalid_amount_leading_space", " 100", 0n, RATE],
    ["bounds_invalid_amount_trailing_dot", "100.", 0n, RATE],
    ["bounds_invalid_amount_separator", "1,000", 0n, RATE],
    ["bounds_fee_equals_amount", "1.00", 100n, RATE],
    ["bounds_fee_exceeds_amount", "1.00", 101n, RATE],
    ["bounds_fee_checked_before_minimum", "0.50", 60n, RATE],
    ["bounds_exceeds_u64_synthetic_rate", "9999999999.99", 0n, 1n],
    ["bounds_below_minimum", "30.00", 0n, RATE],
    ["bounds_above_maximum", "200.00", 0n, RATE],
  ];
  for (const [id, amount, fee, rate] of boundsCases) {
    const r = bounds({ amount, fee, rate, min: MIN, max: MAX });
    vectors.push({
      id,
      kind: "bounds",
      amount,
      fee_minor: fee.toString(),
      thb_per_usd_e8: rate.toString(),
      min_payout_atomic: MIN.toString(),
      max_payout_atomic: MAX.toString(),
      requested_minor: r.requested === null ? null : r.requested.toString(),
      usdc_atomic: r.usdc === null ? null : r.usdc.toString(),
      expect: r.expect,
      source: "section 6.4",
    });
  }
  const expectBounds = {
    bounds_ok_exact_maximum: "ok",
    bounds_fee_equals_amount: "fee_exceeds_amount",
    bounds_exceeds_u64_synthetic_rate: "exceeds_u64",
    bounds_below_minimum: "below_minimum",
    bounds_above_maximum: "above_maximum",
  };
  for (const [id, expect] of Object.entries(expectBounds)) assertEqual(vectors.find((v) => v.id === id).expect, expect, id);

  for (const [id, amount, minor] of [
    ["parse_integer", "100", "10000"],
    ["parse_one_decimal", "100.5", "10050"],
    ["parse_one_satang", "0.01", "1"],
    ["parse_max_digits", "9999999999.99", "999999999999"],
    ["parse_zero", "0", "0"],
    ["parse_invalid_three_decimals", "1.001", null],
    ["parse_invalid_leading_zero", "00.10", null],
  ]) {
    const parsed = parseThb(amount);
    assertEqual(parsed === null ? null : parsed.toString(), minor, id);
    vectors.push({ id, kind: "parse_thb", amount, requested_minor: minor, expect: minor === null ? "invalid_amount" : "ok", source: "section 6.4" });
  }
  for (const [id, atomic, text] of [
    ["display_usdc_thb_with_fee", 3972030n, "3.972030"],
    ["display_usdc_one", 1000000n, "1.000000"],
    ["display_usdc_one_atomic", 1n, "0.000001"],
    ["display_usdc_zero", 0n, "0.000000"],
    ["display_usdc_u64_max", U64_MAX, "18446744073709.551615"],
  ]) {
    assertEqual(fixed6(atomic), text, id);
    vectors.push({ id, kind: "display_usdc", usdc_atomic: atomic.toString(), text, source: "section 4.3 <U>" });
  }
  for (const [id, minor, text] of [
    ["display_minor_150", 15000n, "150.00"],
    ["display_minor_fee_15", 1500n, "15.00"],
    ["display_minor_zero", 0n, "0.00"],
    ["display_minor_one_satang", 1n, "0.01"],
    ["display_minor_u64_max", U64_MAX, "184467440737095516.15"],
  ]) {
    assertEqual(fixed2(minor), text, id);
    vectors.push({ id, kind: "display_minor", minor: minor.toString(), text, source: "section 4.3 <D> and <F>" });
  }
  return doc("amounts.json", vectors);
}

const STATES = [
  ["reserved", false, true, "processing", "pending", "reserved"],
  ["sending", false, true, "processing", "pending", "reserved"],
  ["submitted", false, true, "processing", "pending", "reserved"],
  ["needs_review", false, true, "processing", "pending", "reserved"],
  ["finalized", true, null, "paid", "paid", "deducted"],
  ["released", true, null, "cancelled", "rejected", "released"],
];

/** Section 8.2: [id, from[], to[], actor, guards, reasons, excluded pairs]. */
const TRANSITIONS = [
  ["T1", [null], ["reserved"], "intake", ["verified_submit_committed"], []],
  ["T2", ["reserved"], ["sending"], "sender", ["next_attempt_due", "no_live_lease", "brakes_open", "latch_clear", "config_complete"], []],
  [
    "T3",
    ["sending"],
    ["reserved"],
    "sender",
    ["send_time_hold", "no_attempt_persisted_in_lease"],
    ["program_paused", "day_cap", "vault_low", "fee_payer_low", "settlements_paused", "rpc_error", "config_mismatch"],
  ],
  ["T4", ["sending"], ["submitted"], "sender", ["lease_owner_matches", "lease_unexpired", "attempt_pushed_in_same_cas", "write_majority_journaled"], []],
  ["T5", ["sending"], ["submitted"], "sender", ["receipt_exists_at_confirmed_or_simulation_already_claimed"], []],
  [
    "T6",
    ["sending"],
    ["needs_review"],
    "sender",
    ["send_time_check_needs_human"],
    ["account_blocked", "allowlist_removed", "consent_invalid", "attempts_exhausted", "simulation_rejected", "deployment_mismatch"],
  ],
  ["T7", ["sending"], ["submitted"], "reconciler", ["lease_expired", "live_attempt_present"], []],
  ["T8", ["sending"], ["reserved"], "reconciler", ["lease_expired", "no_live_attempt"], []],
  ["T9", ["submitted"], ["finalized"], "reconciler", ["receipt_finalized_tuple_match"], []],
  ["T10", ["submitted"], ["reserved"], "reconciler", ["no_receipt", "receipt_seen_at_unset", "has_attempt", "every_attempt_dead", "attempts_below_limit"], []],
  ["T11", ["submitted"], ["needs_review"], "reconciler", ["review_condition"], ["attempts_exhausted", "receipt_mismatch", "inconsistent_rpc", "deployment_mismatch"]],
  ["T12", ["reserved", "sending", "needs_review"], ["finalized"], "reconciler_or_watcher", ["receipt_finalized_tuple_match"], []],
  [
    "T13",
    ["reserved", "sending", "submitted", "needs_review"],
    ["finalized", "reserved", "needs_review"],
    "admin_reverify",
    ["no_live_lease", "reconciler_read_path_once", "from_needs_review_only_to_finalized"],
    [],
  ],
  [
    "T14",
    ["needs_review"],
    ["reserved"],
    "admin_retry",
    ["review_reason_retryable", "acknowledged_payout_id_equal", "settlements_on", "latch_clear", "every_attempt_dead"],
    [],
  ],
  [
    "T15",
    ["reserved", "needs_review", "submitted"],
    ["released"],
    "admin_cancel",
    ["devnet_only", "no_live_lease", "every_attempt_dead_if_submitted", "release_proof_passes", "acknowledged_tuple_equal", "latch_clear", "cas_bound_to_assessed_attempts"],
    [],
  ],
];

function buildStates() {
  const vectors = [];
  for (const [state, terminal, slotActive, display, ledger, balance] of STATES) {
    vectors.push({
      id: `state_${state}`,
      kind: "state",
      state,
      terminal,
      slot_active: slotActive,
      display_state: display,
      ledger_status: ledger,
      balance,
      source: "sections 8.1 and 8.3",
    });
  }
  const allowed = new Set();
  for (const [id, froms, tos, actor, guards, reasons] of TRANSITIONS) {
    const multi = froms.length * tos.length > 1;
    for (const from of froms) {
      for (const to of tos) {
        if (id === "T13" && from === "needs_review" && to !== "finalized") continue;
        allowed.add(`${from}>${to}`);
        vectors.push({
          id: multi ? `${id}_${from}_to_${to}` : id,
          kind: "transition",
          transition: id,
          from,
          to,
          actor,
          guards,
          reasons,
          allowed: true,
          source: "section 8.2",
        });
      }
    }
  }
  for (const from of [null, ...STATES.map(([s]) => s)]) {
    for (const [to] of STATES) {
      if (allowed.has(`${from}>${to}`)) continue;
      vectors.push({
        id: `refused_${from ?? "none"}_to_${to}`,
        kind: "transition",
        transition: null,
        from,
        to,
        actor: null,
        guards: [],
        reasons: [],
        allowed: false,
        source: "section 8 (a transition not in the table is a bug and is refused)",
      });
    }
  }
  return doc("states.json", vectors);
}

const MWA_ROWS = [
  [-1, "number", "ERROR_AUTHORIZATION_FAILED (declined or identity failure)", "clear_token_then_reauthorize", "mwa.declined", false],
  [-2, "number", "ERROR_INVALID_PAYLOADS", "bug_report", "mwa.generic", true],
  [-3, "number", "ERROR_NOT_SIGNED (member declined)", "keep_token_no_retry", "mwa.sign_declined", false],
  [-4, "number", "ERROR_NOT_SUBMITTED (we never sign-and-send)", "report", "mwa.generic", true],
  [-5, "number", "spec ERROR_NOT_CLONED; unused, since we never clone", "report", "mwa.generic", true],
  [-6, "number", "spec ERROR_TOO_MANY_PAYLOADS", "bug_report", "mwa.generic", true],
  [-7, "number", "spec ERROR_CHAIN_NOT_SUPPORTED", "devnet_retry_once_on_mainnet_chain", "mwa.wallet_not_supported", false],
  [-100, "number", "ERROR_ATTEST_ORIGIN_ANDROID: a web-origin attestation challenge, not a Digital Asset Links failure", "report", "mwa.attestation_failed", true],
  [null, "other_number", "wallet-specific JSON-RPC error", "wallet_error", "mwa.generic", true],
  ["ERROR_WALLET_NOT_FOUND", "string", "ActivityNotFoundException: no MWA wallet installed", "retry_without_base_uri_once", "mwa.install_wallet", false],
  ["Session not established: Local association cancelled by user", "string", "member backed out of the wallet chooser or association", "cancelled_keep_token", "mwa.cancelled", false],
  ["Timed out waiting for local association to be ready", "string", "association not ready within 10 s", "timeout", "mwa.timeout", false],
  ["Timed out waiting for response", "string", "no wallet response within 90 s", "timeout_new_challenge", "mwa.timeout", false],
  ["Failed to end session", "string", "the native endSession rejected in transact's finally", "use_captured_result", "mwa.generic", false],
  ["EUNSPECIFIED", "string", "React Native default code for a bare-Throwable rejection", "wallet_error", "mwa.generic", true],
  ["ERROR_SESSION_TIMEOUT", "string", "browser build only; not emitted on RN Android", "timeout", "mwa.timeout", false],
  ["ERROR_SESSION_CLOSED", "string", "browser build only; not emitted on RN Android", "cancelled_keep_token", "mwa.cancelled", false],
  ["ERROR_ASSOCIATION_CANCELLED", "string", "browser build only; not emitted on RN Android", "cancelled_keep_token", "mwa.cancelled", false],
  [null, "absent", "error without code (JS error, such as the non-Android Proxy or LINKING_ERROR)", "bug_report", "mwa.unavailable", true],
];

function buildMwa() {
  const slug = (code, type) =>
    type === "other_number" ? "other_number" : type === "absent" ? "no_code" : String(code).replace(/^-/, "minus_").replace(/[^A-Za-z0-9]+/g, "_").replace(/_+$/, "").toLowerCase();
  return doc(
    "mwa-errors.provisional.json",
    MWA_ROWS.map(([code, codeType, origin, handling, copyKey, report]) => ({
      id: `mwa_${slug(code, codeType)}`,
      code,
      code_type: codeType,
      origin,
      handling,
      copy_key: copyKey,
      report,
      provisional: true,
      source: "section 10.8 (PROVISIONAL until the B0 device capture, #2993)",
    })),
  );
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

// The gitleaks rule `solana-keypair-json` (.gitleaks.toml): a JSON array of exactly 64 byte values.
const KEYPAIR_ARRAY = /\[\s*(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\s*,\s*){63}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\s*\]/;

function serialize(document) {
  const text = `${JSON.stringify(document, null, 2)}\n`;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c !== 0x0a && (c < 0x20 || c > 0x7e)) fail(`${document.file}: non-ASCII or control character at ${i}`);
  }
  if (KEYPAIR_ARRAY.test(text)) fail(`${document.file}: contains a 64-number JSON array`);
  return text;
}

function generate(devnetProgramId) {
  assertEqual(PLACEHOLDER_PROGRAM_ID, REF.placeholder, "section 2.4 placeholder program id");
  const documents = [
    buildClusters(devnetProgramId),
    buildAccounts(),
    buildErrors(),
    buildPda(devnetProgramId),
    buildSiws(),
    buildEd25519(),
    buildAmounts(),
    buildStates(),
    buildMwa(),
  ];
  return new Map(documents.map((d) => [d.file, serialize(d)]));
}

function parseArgs(argv) {
  const options = { check: false, devnetProgramId: DEVNET_PROGRAM_ID_DEFAULT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") options.check = true;
    else if (arg === "--devnet-program-id") {
      options.devnetProgramId = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--devnet-program-id=")) options.devnetProgramId = arg.slice("--devnet-program-id=".length);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else fail(`unknown argument ${arg}`);
  }
  if (!isStrictBase58(options.devnetProgramId, 32)) fail("--devnet-program-id must be a strict base58 32-byte address");
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("usage: node scripts/contract/gen-fixtures.mjs [--check] [--devnet-program-id <base58>]");
    return;
  }
  const outputs = generate(options.devnetProgramId);
  if (options.check) {
    const problems = [];
    for (const [file, text] of outputs) {
      const path = join(FIXTURES_DIR, file);
      if (!existsSync(path)) problems.push(`${file}: missing`);
      else if (readFileSync(path, "utf8") !== text) problems.push(`${file}: differs from the generator output`);
    }
    const extras = existsSync(FIXTURES_DIR) ? readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json") && !outputs.has(f)) : [];
    for (const file of extras) problems.push(`${file}: not produced by the generator`);
    if (problems.length > 0) {
      console.error(`gen-fixtures --check failed:\n  ${problems.join("\n  ")}\nRegenerate with: node scripts/contract/gen-fixtures.mjs`);
      process.exit(1);
    }
    console.log(`gen-fixtures --check: ${outputs.size} fixture files match (devnet program id ${options.devnetProgramId}).`);
    return;
  }
  mkdirSync(FIXTURES_DIR, { recursive: true });
  for (const [file, text] of outputs) writeFileSync(join(FIXTURES_DIR, file), text);
  console.log(`gen-fixtures: wrote ${outputs.size} files to test/fixtures (devnet program id ${options.devnetProgramId}).`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
