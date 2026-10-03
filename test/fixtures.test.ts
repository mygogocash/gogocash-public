/**
 * Contract v0.1 fixtures (docs/CONTRACT.md section 11) against the SDK.
 *
 * test/fixtures/*.json are written by scripts/contract/gen-fixtures.mjs, an
 * independent oracle that never imports src/. This file checks that the SDK
 * in src/ agrees with every vector, and that the reference vectors still
 * match the contract text. A disagreement means either the SDK or the
 * generator drifted from the contract; neither side may be "fixed" by
 * editing the fixtures by hand.
 */
import { spawnSync } from "node:child_process";
import { createHash, sign } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { address, getProgramDerivedAddress, type Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  checkPayoutBounds,
  convertThbMinorToUsdc,
  formatMinorFixed2,
  formatUsdcAtomicFixed6,
  parseThbAmountToMinor,
  U64_MAX,
} from "../src/amount.ts";
import { decodeStrictBase58, encodeBase58, isStrictBase58 } from "../src/base58.ts";
import { decodeStrictBase64 } from "../src/base64.ts";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  BPF_LOADER_UPGRADEABLE_ADDRESS,
  CAIP2_CHAIN_ID,
  CLUSTERS,
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  GENESIS_HASH,
  programIdFromManifest,
  SYSTEM_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  USDC_MINT,
  USDC_MINT_DECIMALS,
  V0_PLACEHOLDER_PROGRAM_ID,
  WALLET_CHAIN_ID,
  type Cluster,
} from "../src/clusters.ts";
import {
  ANCHOR_ERRORS,
  classifyInstructionError,
  classifyTransactionLevelError,
  PROGRAM_ERRORS,
  type ErrorClassification,
  type InstructionErrorDetail,
  type InstructionKind,
  type ProgramInstructionKind,
} from "../src/errors.ts";
import { decodePayoutClaimedEvent, PAYOUT_CLAIMED_EVENT_SIZE } from "../src/events.ts";
import * as generated from "../src/generated/index.ts";
import {
  decodeReceipt,
  decodeVault,
  findClassicAta,
  findProgramDataAddress,
  findReceiptPda,
  findVaultPda,
  payoutIdFromHex,
  RECEIPT_ACCOUNT_SIZE,
  RECEIPT_DISCRIMINATOR,
  VAULT_ACCOUNT_SIZE,
  VAULT_DISCRIMINATOR,
} from "../src/program.ts";
import { renderConsentMessage, SIWS_ENVIRONMENT, SMALL_ORDER_PUBLIC_KEYS_HEX, verifyConsentSignature } from "../src/siws.ts";
import {
  AMOUNT_EXAMPLES,
  CONSENT_EXAMPLE,
  contractTestKey,
  fromHex,
  hex,
  PAYOUT_CLAIMED_VECTOR,
  PDA_VECTORS,
  PROGRAM_DATA,
  privateKeyFromSeed,
  rawPublicKey,
} from "./vectors.ts";

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const FIXTURES_DIR = new URL("./fixtures/", import.meta.url);
const GENERATOR = new URL("../scripts/contract/gen-fixtures.mjs", import.meta.url);
const contract = readFileSync(new URL("../docs/CONTRACT.md", import.meta.url), "utf8");

const FIXTURE_FILES = [
  "clusters.json",
  "accounts.json",
  "errors.json",
  "pda.json",
  "siws.json",
  "ed25519.json",
  "amounts.json",
  "states.json",
  "mwa-errors.provisional.json",
] as const;

type Fixture<V> = { contract: string; file: string; vectors: V[] };

function load<V>(name: (typeof FIXTURE_FILES)[number]): Fixture<V> {
  return JSON.parse(readFileSync(new URL(name, FIXTURES_DIR), "utf8")) as Fixture<V>;
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function byId<V extends { id: string }>(vectors: V[], id: string): V {
  const found = vectors.find((v) => v.id === id);
  if (found === undefined) throw new Error(`vector ${id} not found`);
  return found;
}

/** The section of docs/CONTRACT.md between two headings. */
function contractSection(start: string, end: string): string {
  const from = contract.indexOf(start);
  const to = contract.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`contract section ${start} not found`);
  return contract.slice(from, to);
}

/** Table rows (`| ... |` lines) of a markdown fragment, split into trimmed cells. */
function tableRows(fragment: string): string[][] {
  return fragment
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|[-:| ]+\|$/.test(line))
    .map((line) =>
      line
        .slice(1, -1)
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim()),
    );
}

function backticked(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
}

// ---------------------------------------------------------------------------
// Common format (section 11)
// ---------------------------------------------------------------------------

const KEYPAIR_ARRAY = /\[\s*(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\s*,\s*){63}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\s*\]/;
const HEX_FIELDS = new Set(["seed", "public_key", "signature", "bytes", "discriminator", "payout_id", "sha256", "reserved", "lines_sha256"]);

function walkFields(value: unknown, visit: (key: string, value: unknown) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkFields(item, visit);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      visit(key, inner);
      walkFields(inner, visit);
    }
  }
}

describe("fixture files: common format (contract section 11)", () => {
  it("test/fixtures holds exactly the section 11 files", () => {
    const present = readdirSync(FIXTURES_DIR).filter((name) => name.endsWith(".json")).sort();
    expect(present).toEqual([...FIXTURE_FILES].sort());
  });

  for (const name of FIXTURE_FILES) {
    it(`${name}: canonical JSON, top-level shape, unique ids, encodings`, () => {
      const text = readFileSync(new URL(name, FIXTURES_DIR), "utf8");
      const parsed = JSON.parse(text) as Fixture<{ id: string }>;
      // Two-space indent, LF line endings, trailing LF, keys in generator order.
      expect(text).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
      expect(text).not.toContain("\r");
      expect(/^[\x20-\x7e\n]*$/.test(text)).toBe(true);
      // gitleaks `solana-keypair-json`: never a JSON array of 64 numbers.
      expect(KEYPAIR_ARRAY.test(text)).toBe(false);
      expect(Object.keys(parsed)).toEqual(["contract", "file", "vectors"]);
      expect(parsed.contract).toBe("v0");
      expect(parsed.file).toBe(name);
      expect(parsed.vectors.length).toBeGreaterThan(0);
      const ids = parsed.vectors.map((v) => v.id);
      expect(new Set(ids).size).toBe(ids.length);
      // `message` is a byte string in ed25519.json and the exact program error text in errors.json.
      const hexFields = name === "ed25519.json" ? new Set([...HEX_FIELDS, "message"]) : HEX_FIELDS;
      walkFields(parsed.vectors, (key, value) => {
        if (hexFields.has(key) && typeof value === "string") expect(value, key).toMatch(/^([0-9a-f]{2})*$/);
        if (key === "seeds" && Array.isArray(value)) for (const seed of value) expect(seed).toMatch(/^([0-9a-f]{2})+$/);
        if (key.endsWith("_b64") && typeof value === "string") expect(decodeStrictBase64(value), key).not.toBeNull();
        if (key.endsWith("_b58") && typeof value === "string") {
          expect(isStrictBase58(value, 32) || isStrictBase58(value, 64), `${key} ${value}`).toBe(true);
        }
      });
    });
  }

  it("the generator is an independent oracle: node: built-ins only, never src/", () => {
    const source = readFileSync(GENERATOR, "utf8");
    const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gms)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) expect(specifier).toMatch(/^node:/);
    expect(source).not.toMatch(/import\(|require\(/);
    expect(source).not.toMatch(/["'][./]*src\//);
  });

  it("the committed fixtures equal the generator output (gen-fixtures --check)", () => {
    const result = spawnSync(process.execPath, [fileURLToPath(GENERATOR), "--check"], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// clusters.json (sections 2.1 to 2.4)
// ---------------------------------------------------------------------------

type ClusterVector = {
  id: string;
  cluster: Cluster;
  genesis_hash: string;
  caip2_chain_id: string;
  chain_id: string;
  usdc_mint: string;
  usdc_mint_owner: string;
  usdc_decimals: number;
  program_id: string | null;
  program_id_status: "placeholder" | "assigned" | "unassigned";
  programs: Record<string, string>;
};

const clusters = load<ClusterVector>("clusters.json");
const devnetProgramId = byId(clusters.vectors, "devnet").program_id;

describe("clusters.json against src/clusters.ts", () => {
  it("covers exactly the SDK's clusters", () => {
    expect(clusters.vectors.map((v) => v.cluster)).toEqual([...CLUSTERS]);
  });

  for (const v of clusters.vectors) {
    it(`${v.id}: genesis, chain ids, USDC mint and programs`, () => {
      expect(v.genesis_hash).toBe(GENESIS_HASH[v.cluster]);
      expect(v.caip2_chain_id).toBe(CAIP2_CHAIN_ID[v.cluster]);
      expect(v.chain_id).toBe(WALLET_CHAIN_ID[v.cluster]);
      expect(v.usdc_mint).toBe(USDC_MINT[v.cluster]);
      expect(v.usdc_mint_owner).toBe(TOKEN_PROGRAM_ADDRESS);
      expect(v.usdc_decimals).toBe(USDC_MINT_DECIMALS);
      expect(v.programs).toEqual({
        token: TOKEN_PROGRAM_ADDRESS,
        associated_token: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
        system: SYSTEM_PROGRAM_ADDRESS,
        bpf_loader_upgradeable: BPF_LOADER_UPGRADEABLE_ADDRESS,
        compute_budget: COMPUTE_BUDGET_PROGRAM_ADDRESS,
        token_2022_refused: TOKEN_2022_PROGRAM_ADDRESS,
      });
      for (const value of [v.genesis_hash, v.usdc_mint, ...Object.values(v.programs)]) expect(contract).toContain(value);
    });
  }

  it("program ids: devnet from the generator input, mainnet null, both equal to release/manifest.json", () => {
    const manifest = JSON.parse(readFileSync(new URL("../release/manifest.json", import.meta.url), "utf8")) as {
      programIds: Record<Cluster, string | null>;
    };
    expect(byId(clusters.vectors, "mainnet").program_id).toBeNull();
    expect(byId(clusters.vectors, "mainnet").program_id_status).toBe("unassigned");
    expect(programIdFromManifest(manifest, "mainnet")).toBeNull();
    expect(programIdFromManifest(manifest, "devnet")).toBe(devnetProgramId);
    const status = byId(clusters.vectors, "devnet").program_id_status;
    if (devnetProgramId === V0_PLACEHOLDER_PROGRAM_ID) {
      expect(status).toBe("placeholder");
    } else {
      expect(status).toBe("assigned");
    }
  });
});

// ---------------------------------------------------------------------------
// accounts.json (sections 3.2 to 3.4)
// ---------------------------------------------------------------------------

type LayoutField = { name: string; offset: number; size: number; type: string };
type AccountsVector = {
  id: string;
  kind: "account_layout" | "event_layout" | "instruction_layout" | "account" | "event" | "instruction_data";
  name: string;
  discriminator_preimage: string;
  discriminator: string;
  size: number;
  fields: LayoutField[] | null;
  inputs: Record<string, string | number | boolean> | null;
  bytes: string | null;
};

const accounts = load<AccountsVector>("accounts.json");

const INSTRUCTION_NAMES: readonly ProgramInstructionKind[] = [
  "initialize",
  "claim",
  "pause",
  "unpause",
  "update_config",
  "propose_admin",
  "accept_admin",
  "withdraw",
];

const GENERATED_INSTRUCTION_DISCRIMINATORS: Record<ProgramInstructionKind, Uint8Array> = {
  initialize: Uint8Array.from(generated.INITIALIZE_DISCRIMINATOR),
  claim: Uint8Array.from(generated.CLAIM_DISCRIMINATOR),
  pause: Uint8Array.from(generated.PAUSE_DISCRIMINATOR),
  unpause: Uint8Array.from(generated.UNPAUSE_DISCRIMINATOR),
  update_config: Uint8Array.from(generated.UPDATE_CONFIG_DISCRIMINATOR),
  propose_admin: Uint8Array.from(generated.PROPOSE_ADMIN_DISCRIMINATOR),
  accept_admin: Uint8Array.from(generated.ACCEPT_ADMIN_DISCRIMINATOR),
  withdraw: Uint8Array.from(generated.WITHDRAW_DISCRIMINATOR),
};

function str(inputs: Record<string, string | number | boolean>, key: string): string {
  const value = inputs[key];
  if (typeof value !== "string") throw new Error(`${key} is not a string`);
  return value;
}

/** Instruction data through the generated Codama encoders. */
function encodeInstructionData(name: ProgramInstructionKind, i: Record<string, string | number | boolean>): Uint8Array {
  switch (name) {
    case "initialize":
      return Uint8Array.from(
        generated.getInitializeInstructionDataEncoder().encode({
          admin: address(str(i, "admin")),
          guardian: address(str(i, "guardian")),
          claimAuthority: address(str(i, "claim_authority")),
          maxPerClaim: BigInt(str(i, "max_per_claim")),
          maxPerDay: BigInt(str(i, "max_per_day")),
        }),
      );
    case "claim":
      return Uint8Array.from(
        generated.getClaimInstructionDataEncoder().encode({
          payoutId: payoutIdFromHex(str(i, "payout_id")),
          amount: BigInt(str(i, "amount")),
          expiresAt: BigInt(str(i, "expires_at")),
        }),
      );
    case "pause":
      return Uint8Array.from(generated.getPauseInstructionDataEncoder().encode({}));
    case "unpause":
      return Uint8Array.from(generated.getUnpauseInstructionDataEncoder().encode({}));
    case "update_config":
      return Uint8Array.from(
        generated.getUpdateConfigInstructionDataEncoder().encode({
          guardian: address(str(i, "guardian")),
          claimAuthority: address(str(i, "claim_authority")),
          maxPerClaim: BigInt(str(i, "max_per_claim")),
          maxPerDay: BigInt(str(i, "max_per_day")),
        }),
      );
    case "propose_admin":
      return Uint8Array.from(generated.getProposeAdminInstructionDataEncoder().encode({ newAdmin: address(str(i, "new_admin")) }));
    case "accept_admin":
      return Uint8Array.from(generated.getAcceptAdminInstructionDataEncoder().encode({}));
    case "withdraw":
      return Uint8Array.from(generated.getWithdrawInstructionDataEncoder().encode({ amount: BigInt(str(i, "amount")) }));
  }
}

describe("accounts.json against src/program.ts, src/events.ts and the generated client", () => {
  it("every discriminator is sha256(preimage)[0..8] and matches the SDK constants", () => {
    for (const v of accounts.vectors) {
      expect(sha256Hex(v.discriminator_preimage).slice(0, 16), v.id).toBe(v.discriminator);
      expect(contract).toContain(v.discriminator);
    }
    expect(hex(VAULT_DISCRIMINATOR)).toBe(byId(accounts.vectors, "vault_layout").discriminator);
    expect(hex(RECEIPT_DISCRIMINATOR)).toBe(byId(accounts.vectors, "receipt_layout").discriminator);
    expect(hex(Uint8Array.from(generated.VAULT_DISCRIMINATOR))).toBe(byId(accounts.vectors, "vault_layout").discriminator);
    expect(hex(Uint8Array.from(generated.RECEIPT_DISCRIMINATOR))).toBe(byId(accounts.vectors, "receipt_layout").discriminator);
    expect(hex(Uint8Array.from(generated.PAYOUT_CLAIMED_EVENT_DISCRIMINATOR))).toBe(
      byId(accounts.vectors, "payout_claimed_layout").discriminator,
    );
  });

  it("layouts: contiguous fields, the frozen sizes, and the section 3.2 / 3.4 offset tables", () => {
    const sizes: Record<string, number> = {
      vault_layout: VAULT_ACCOUNT_SIZE,
      receipt_layout: RECEIPT_ACCOUNT_SIZE,
      payout_claimed_layout: PAYOUT_CLAIMED_EVENT_SIZE,
    };
    for (const [id, size] of Object.entries(sizes)) {
      const v = byId(accounts.vectors, id);
      const fields = v.fields ?? [];
      expect(v.size).toBe(size);
      let offset = 0;
      for (const field of fields) {
        expect(field.offset, `${id}.${field.name}`).toBe(offset);
        offset += field.size;
        if (field.name === "discriminator") continue;
        // Each row of the contract's offset table: | offset | size | name | `type` |.
        expect(contract, `${id}.${field.name}`).toMatch(
          new RegExp(`\\| ${field.offset} \\| ${field.size} \\| ${field.name} \\| \`${field.type.replace(/[[\]]/g, "\\$&")}\`[^|\\n]*\\|`),
        );
      }
      expect(offset).toBe(size);
    }
  });

  it("instructions: the frozen order, discriminators and data lengths of section 3.3", () => {
    const layouts = accounts.vectors.filter((v) => v.kind === "instruction_layout");
    expect(layouts.map((v) => v.name)).toEqual(INSTRUCTION_NAMES);
    for (const [index, v] of layouts.entries()) {
      const name = v.name as ProgramInstructionKind;
      expect(hex(GENERATED_INSTRUCTION_DISCRIMINATORS[name])).toBe(v.discriminator);
      expect(contract).toContain(`| ${index + 1} | \`${name}\` | \`${v.discriminator}\` |`);
      expect(contract).toMatch(new RegExp(`\\| ${index + 1} \\| \`${name}\` \\| \`${v.discriminator}\` \\|[^\\n]*\\| ${v.size} \\|`));
    }
  });

  it("instruction data vectors encode identically through the generated client", () => {
    const data = accounts.vectors.filter((v) => v.kind === "instruction_data");
    expect(data.map((v) => v.name)).toEqual(INSTRUCTION_NAMES);
    for (const v of data) {
      const bytes = encodeInstructionData(v.name as ProgramInstructionKind, v.inputs ?? {});
      expect(hex(bytes), v.id).toBe(v.bytes);
      expect(bytes.length).toBe(v.size);
    }
    expect(contract).toContain(`\`\`\`\n${byId(accounts.vectors, "claim_data").bytes}\n\`\`\``);
  });

  for (const id of ["vault_v1_devnet", "vault_after_first_claim_devnet"]) {
    it(`${id} decodes through decodeVault`, () => {
      const v = byId(accounts.vectors, id);
      const i = v.inputs ?? {};
      const vault = decodeVault(fromHex(v.bytes ?? ""));
      expect({
        version: vault.version,
        bump: vault.bump,
        paused: vault.paused,
        decimals: vault.decimals,
        mint: vault.mint,
        vault_token_account: vault.vaultTokenAccount,
        admin: vault.admin,
        pending_admin: vault.pendingAdmin,
        guardian: vault.guardian,
        claim_authority: vault.claimAuthority,
        max_per_claim: vault.maxPerClaim.toString(),
        max_per_day: vault.maxPerDay.toString(),
        current_day: vault.currentDay.toString(),
        claimed_today: vault.claimedToday.toString(),
        total_claimed: vault.totalClaimed.toString(),
        claim_count: vault.claimCount.toString(),
        total_withdrawn: vault.totalWithdrawn.toString(),
        reserved: hex(vault.reserved),
      }).toEqual(Object.fromEntries(Object.entries(i).filter(([k]) => !["program_id", "address"].includes(k))));
    });
  }

  it("vault_v1_devnet is the contract's V1 decode vector, at the PDA and bump the SDK derives", async () => {
    const v = byId(accounts.vectors, "vault_v1_devnet");
    const i = v.inputs ?? {};
    expect(contract).toContain(v.bytes);
    expect(str(i, "program_id")).toBe(V0_PLACEHOLDER_PROGRAM_ID);
    const pda = await findVaultPda({ programAddress: address(str(i, "program_id")), mint: address(str(i, "mint")) });
    expect(pda).toEqual({ address: str(i, "address"), bump: i.bump });
    expect(await findClassicAta({ owner: pda.address, mint: address(str(i, "mint")) })).toBe(str(i, "vault_token_account"));
  });

  it("receipt_v1_devnet decodes through decodeReceipt at the SDK-derived PDA", async () => {
    const v = byId(accounts.vectors, "receipt_v1_devnet");
    const i = v.inputs ?? {};
    expect(contract).toContain(v.bytes);
    const receipt = decodeReceipt(fromHex(v.bytes ?? ""));
    expect(receipt.bump).toBe(i.bump);
    expect(receipt.payoutIdHex).toBe(i.payout_id);
    expect(receipt.recipient).toBe(i.recipient);
    expect(receipt.amount.toString()).toBe(i.amount);
    expect(receipt.claimedAt.toString()).toBe(i.claimed_at);
    const pda = await findReceiptPda({
      programAddress: address(str(i, "program_id")),
      vault: address(str(i, "vault")),
      payoutId: payoutIdFromHex(str(i, "payout_id")),
    });
    expect(pda).toEqual({ address: str(i, "address"), bump: i.bump });
  });

  it("payout_claimed_first_claim_devnet decodes through decodePayoutClaimedEvent and is the section 3.4 vector", () => {
    const v = byId(accounts.vectors, "payout_claimed_first_claim_devnet");
    const i = v.inputs ?? {};
    const bytes = fromHex(v.bytes ?? "");
    expect(Buffer.from(bytes).toString("base64")).toBe(PAYOUT_CLAIMED_VECTOR.base64);
    expect(contract).toContain(Buffer.from(bytes).toString("base64"));
    const event = decodePayoutClaimedEvent(bytes);
    expect({
      vault: event.vault,
      receipt: event.receipt,
      payout_id: event.payoutIdHex,
      recipient: event.recipient,
      amount: event.amount.toString(),
      claimed_at: event.claimedAt.toString(),
      day: event.day.toString(),
      claimed_today: event.claimedToday.toString(),
      claim_count: event.claimCount.toString(),
      total_claimed: event.totalClaimed.toString(),
    }).toEqual(Object.fromEntries(Object.entries(i).filter(([k]) => k !== "program_id")));
  });
});

// ---------------------------------------------------------------------------
// errors.json (sections 3.5 to 3.7, 9.1)
// ---------------------------------------------------------------------------

type ErrorVector = {
  id: string;
  kind: "program" | "anchor" | "instruction_index" | "transaction";
  code: number | null;
  name: string | null;
  message: string | null;
  raised_by: string[] | null;
  where: string | null;
  instruction: InstructionKind | null;
  error: { custom: number } | { name: string };
  logs: string[] | null;
  class: string;
  hold_reason: string | null;
  halt_latch: boolean;
};

const errors = load<ErrorVector>("errors.json");

function expectClassification(actual: ErrorClassification, v: ErrorVector, context: string): void {
  expect(actual.class, context).toBe(v.class);
  expect(actual.holdReason ?? null, context).toBe(v.hold_reason);
  expect(actual.haltLatch, context).toBe(v.halt_latch);
  expect(actual.critical, context).toBe(v.halt_latch);
}

describe("errors.json against src/errors.ts", () => {
  it("program codes 6000-6023 equal PROGRAM_ERRORS and the section 3.5 table", () => {
    const program = errors.vectors.filter((v) => v.kind === "program");
    expect(program.map((v) => v.code)).toEqual(PROGRAM_ERRORS.map((e) => e.code));
    for (const v of program) {
      const sdk = PROGRAM_ERRORS.find((e) => e.code === v.code);
      expect(sdk, v.id).toBeDefined();
      expect({ name: v.name, message: v.message, raisedBy: v.raised_by, class: v.class }).toEqual({
        name: sdk?.name,
        message: sdk?.message,
        raisedBy: sdk?.raisedBy,
        class: sdk?.class,
      });
      expect(contract).toContain(`| ${v.code} | ${v.name} | ${v.message} |`);
    }
  });

  it("Anchor codes equal ANCHOR_ERRORS and the section 3.6 table", () => {
    const anchor = errors.vectors.filter((v) => v.kind === "anchor");
    expect(anchor.map((v) => v.code)).toEqual(ANCHOR_ERRORS.map((e) => e.code));
    for (const v of anchor) {
      const sdk = ANCHOR_ERRORS.find((e) => e.code === v.code);
      expect({ name: v.name, class: v.class }, v.id).toEqual({ name: sdk?.name, class: sdk?.class });
      if (v.code !== null && (v.code < 2500 || v.code > 2506)) {
        expect(contract, v.id).toMatch(new RegExp(`\\| (\\d+ / )*${v.code}( / \\d+)* \\|[^\\n]*${v.name}`));
      }
    }
    expect(contract).toContain("| 2500-2506 | Require* |");
  });

  for (const v of errors.vectors.filter((e) => e.kind === "program" || e.kind === "anchor")) {
    it(`${v.id} classifies as ${v.class} at every program instruction index`, () => {
      for (const instruction of INSTRUCTION_NAMES) {
        expectClassification(classifyInstructionError({ instruction, error: v.error }), v, `${v.id} at ${instruction}`);
      }
    });
  }

  for (const v of errors.vectors.filter((e) => e.kind === "instruction_index")) {
    it(`${v.id}: ${v.instruction} index -> ${v.class}`, () => {
      expect(v.instruction).not.toBeNull();
      const result = classifyInstructionError({
        instruction: v.instruction as InstructionKind,
        error: v.error as InstructionErrorDetail,
        ...(v.logs === null ? {} : { logs: v.logs }),
      });
      expectClassification(result, v, v.id);
    });
  }

  for (const v of errors.vectors.filter((e) => e.kind === "transaction")) {
    it(`${v.id}: transaction-level -> ${v.class}`, () => {
      expectClassification(classifyTransactionLevelError(v.name ?? ""), v, v.id);
    });
  }
});

// ---------------------------------------------------------------------------
// pda.json (section 2.4)
// ---------------------------------------------------------------------------

type PdaVector = {
  id: string;
  program_id: string;
  program_status: "placeholder" | "assigned";
  /** The cluster whose clusters.json program id derived the vector. */
  cluster: Cluster;
  /** The cluster whose USDC mint is in the seeds (null for ProgramData). */
  mint_cluster: Cluster | null;
  kind: "program_data" | "vault" | "receipt" | "associated_token_account";
  derive_program: string;
  seed_names: string[];
  seeds: string[];
  address: string;
  bump: number;
  derivation_only: boolean;
};

const pda = load<PdaVector>("pda.json");

describe("pda.json against src/program.ts", () => {
  // The vector id prefix of each USDC mint: the devnet mint under the devnet
  // program, and the section 2.4 "mainnet USDC mint (derivation only)" column.
  const mintPrefix = (mintCluster: Cluster): string => (mintCluster === "devnet" ? "devnet" : `${mintCluster}_usdc`);

  it("every vector is under the clusters.json devnet program id", () => {
    for (const v of pda.vectors) {
      expect(v.program_id, v.id).toBe(devnetProgramId);
      expect(v.program_status).toBe(devnetProgramId === V0_PLACEHOLDER_PROGRAM_ID ? "placeholder" : "assigned");
    }
  });

  it("names no cluster whose program id is unassigned, and keys the mainnet column by mint", () => {
    for (const v of pda.vectors) {
      // A consumer that selects by cluster must never get addresses for a
      // program that does not exist there (mainnet is null in clusters.json).
      expect(byId(clusters.vectors, v.cluster).program_id, v.id).toBe(v.program_id);
      expect(v.cluster, v.id).toBe("devnet");
      expect(v.mint_cluster === null, v.id).toBe(v.kind === "program_data");
      const derivationOnly = v.program_status === "placeholder" || (v.mint_cluster !== null && v.mint_cluster !== v.cluster);
      expect(v.derivation_only, v.id).toBe(derivationOnly);
      if (v.mint_cluster !== null) expect(v.id.startsWith(`${mintPrefix(v.mint_cluster)}_`), v.id).toBe(true);
    }
    expect(pda.vectors.filter((v) => v.kind === "program_data").map((v) => v.id)).toEqual(["devnet_program_data"]);
    expect(pda.vectors.filter((v) => v.mint_cluster === "mainnet").every((v) => v.derivation_only)).toBe(true);
  });

  for (const v of pda.vectors) {
    it(`${v.id}: generic derivation and the SDK helper agree`, async () => {
      const seeds = v.seeds.map((s) => fromHex(s));
      const [generic, bump] = await getProgramDerivedAddress({ programAddress: address(v.derive_program), seeds });
      expect({ address: generic, bump }).toEqual({ address: v.address, bump: v.bump });
      const programAddress = address(v.program_id);
      const seedAddress = (index: number): Address => address(encodeBase58(seeds[index] ?? new Uint8Array()));
      switch (v.kind) {
        case "program_data":
          expect(v.derive_program).toBe(BPF_LOADER_UPGRADEABLE_ADDRESS);
          expect(await findProgramDataAddress(programAddress)).toEqual({ address: v.address, bump: v.bump });
          break;
        case "vault": {
          expect(v.derive_program).toBe(v.program_id);
          expect(Buffer.from(seeds[0] ?? []).toString("utf8")).toBe("vault");
          expect(v.mint_cluster).not.toBeNull();
          const mint = USDC_MINT[v.mint_cluster as Cluster];
          expect(seedAddress(1)).toBe(mint);
          expect(await findVaultPda({ programAddress, mint })).toEqual({ address: v.address, bump: v.bump });
          break;
        }
        case "receipt": {
          expect(v.derive_program).toBe(v.program_id);
          expect(Buffer.from(seeds[0] ?? []).toString("utf8")).toBe("receipt");
          expect(v.mint_cluster).not.toBeNull();
          expect(seedAddress(1)).toBe(byId(pda.vectors, `${mintPrefix(v.mint_cluster as Cluster)}_vault`).address);
          const found = await findReceiptPda({ programAddress, vault: seedAddress(1), payoutId: seeds[2] ?? new Uint8Array() });
          expect(found).toEqual({ address: v.address, bump: v.bump });
          break;
        }
        case "associated_token_account":
          expect(v.derive_program).toBe(ASSOCIATED_TOKEN_PROGRAM_ADDRESS);
          expect(seedAddress(1)).toBe(TOKEN_PROGRAM_ADDRESS);
          expect(v.mint_cluster).not.toBeNull();
          expect(seedAddress(2)).toBe(USDC_MINT[v.mint_cluster as Cluster]);
          expect(await findClassicAta({ owner: seedAddress(0), mint: seedAddress(2) })).toBe(v.address);
          break;
      }
    });
  }

  it("under the placeholder, the vectors are the section 2.4 table", () => {
    // Recipient ATAs do not depend on the program id.
    for (const mintCluster of CLUSTERS) {
      const id = `${mintPrefix(mintCluster)}_recipient_ata_test_key_1`;
      expect(byId(pda.vectors, id).address).toBe(PDA_VECTORS[mintCluster].recipientAta);
    }
    if (devnetProgramId !== V0_PLACEHOLDER_PROGRAM_ID) return;
    expect(byId(pda.vectors, "devnet_program_data")).toMatchObject(PROGRAM_DATA);
    for (const mintCluster of CLUSTERS) {
      const ref = PDA_VECTORS[mintCluster];
      const prefix = mintPrefix(mintCluster);
      expect(byId(pda.vectors, `${prefix}_vault`)).toMatchObject(ref.vault);
      expect(byId(pda.vectors, `${prefix}_vault_ata`).address).toBe(ref.vaultAta);
      expect(byId(pda.vectors, `${prefix}_receipt_1`)).toMatchObject(ref.receipt);
    }
  });
});

// ---------------------------------------------------------------------------
// siws.json (section 4)
// ---------------------------------------------------------------------------

type SiwsVector = {
  id: string;
  inputs: {
    cluster: Cluster;
    domain: string;
    uri: string;
    recipient: string;
    amount_atomic: string;
    deducted_minor: string;
    fee_minor: string;
    nonce: string;
    issued_at_ms: number;
    expiration_ms: number;
    issued_at: string;
    expiration_time: string;
    withdrawal_id: string;
    payout_id: string;
    program_id: string;
  };
  tamper: null | "amount_plus_1" | "trailing_lf" | "crlf";
  message_b64: string;
  byte_length: number;
  sha256: string;
  signer_b58: string;
  signed_by: string;
  signature_b58: string;
  expect: string;
};

const siws = load<SiwsVector>("siws.json");

function renderFromInputs(i: SiwsVector["inputs"]): Uint8Array {
  return renderConsentMessage({
    cluster: i.cluster,
    recipient: i.recipient,
    amountAtomic: BigInt(i.amount_atomic),
    deductedMinor: BigInt(i.deducted_minor),
    feeMinor: BigInt(i.fee_minor),
    nonce: i.nonce,
    issuedAtMs: i.issued_at_ms,
    expirationMs: i.expiration_ms,
    withdrawalId: i.withdrawal_id,
    payoutIdHex: i.payout_id,
    programId: i.program_id,
    domain: i.domain,
    uri: i.uri,
  });
}

function applyTamper(message: Uint8Array, v: SiwsVector): Uint8Array {
  const text = Buffer.from(message).toString("latin1");
  switch (v.tamper) {
    case null:
      return message;
    case "amount_plus_1":
      return Buffer.from(
        text.replace(`- gogocash:amount:${v.inputs.amount_atomic}`, `- gogocash:amount:${BigInt(v.inputs.amount_atomic) + 1n}`),
        "latin1",
      );
    case "trailing_lf":
      return Buffer.from(`${text}\n`, "latin1");
    case "crlf":
      return Buffer.from(text.replaceAll("\n", "\r\n"), "latin1");
  }
}

describe("siws.json against src/siws.ts", () => {
  for (const v of siws.vectors) {
    it(`${v.id}: render, length, sha256, verify -> ${v.expect}`, () => {
      const message = decodeStrictBase64(v.message_b64);
      expect(message).not.toBeNull();
      const bytes = message ?? new Uint8Array();
      expect(bytes.length).toBe(v.byte_length);
      expect(sha256Hex(bytes)).toBe(v.sha256);
      const env = SIWS_ENVIRONMENT[v.inputs.cluster];
      expect({ domain: v.inputs.domain, uri: v.inputs.uri }).toEqual({ domain: env.domain, uri: env.uri });
      expect(new Date(v.inputs.issued_at_ms).toISOString()).toBe(v.inputs.issued_at);
      expect(new Date(v.inputs.expiration_ms).toISOString()).toBe(v.inputs.expiration_time);
      expect(v.inputs.expiration_ms - v.inputs.issued_at_ms).toBe(env.ttlSeconds * 1000);
      const rendered = renderFromInputs(v.inputs);
      expect(hex(applyTamper(rendered, v))).toBe(hex(bytes));
      const result = verifyConsentSignature(
        decodeStrictBase58(v.signer_b58, 32),
        bytes,
        decodeStrictBase58(v.signature_b58, 64),
      );
      expect(result).toBe(v.expect);
      // Ed25519 is deterministic: re-sign the untampered render with the named key.
      const signer = Number(/^test key (\d+)$/.exec(v.signed_by)?.[1]);
      const signature = Uint8Array.from(sign(null, rendered, contractTestKey(signer)));
      expect(encodeBase58(signature)).toBe(v.signature_b58);
      // Only an untampered message verified with its own signer's key is "ok".
      const ownSigner = encodeBase58(rawPublicKey(contractTestKey(signer))) === v.signer_b58;
      expect(v.expect === "ok").toBe(v.tamper === null && ownSigner);
    });
  }

  it("consent_devnet_thb_with_fee is the section 4.6 worked example", () => {
    const v = byId(siws.vectors, "consent_devnet_thb_with_fee");
    expect(v.byte_length).toBe(CONSENT_EXAMPLE.byteLength);
    expect(v.sha256).toBe(CONSENT_EXAMPLE.sha256);
    expect(v.signature_b58).toBe(CONSENT_EXAMPLE.signatureBase58);
    expect(Buffer.from(decodeStrictBase64(v.message_b64) ?? []).toString("latin1")).toBe(CONSENT_EXAMPLE.text);
    expect(contract).toContain(`**${v.byte_length}**`);
    expect(contract).toContain(v.sha256);
    expect(contract).toContain(v.signature_b58);
  });

  it("consent_devnet_max_length is the widest legal message of section 4.1", () => {
    const v = byId(siws.vectors, "consent_devnet_max_length");
    expect(v.inputs.amount_atomic).toBe(U64_MAX.toString());
    expect(v.inputs.recipient).toHaveLength(44);
    expect(v.inputs.program_id).toHaveLength(44);
    expect(contract).toContain(`is ${v.byte_length} bytes`);
  });

  it("covers the section 4.6 tamper negatives and the O7 remainder vector", () => {
    const tampers = siws.vectors.map((v) => v.tamper).filter((t) => t !== null);
    expect(tampers.sort()).toEqual(["amount_plus_1", "crlf", "trailing_lf"]);
    const o7 = byId(siws.vectors, "consent_devnet_edge_rate_remainder");
    const edge = convertThbMinorToUsdc({ requestedMinor: 12600n, feeMinor: 100n, thbPerUsdE8: 2600000000000n });
    expect(edge.remainderMinor).toBeGreaterThan(0n);
    expect(o7.inputs.amount_atomic).toBe(edge.usdcAtomic.toString());
    expect(o7.inputs.deducted_minor).toBe(edge.deductedMinor.toString());
  });
});

// ---------------------------------------------------------------------------
// ed25519.json (sections 4.7 and 5.4)
// ---------------------------------------------------------------------------

type Ed25519Vector =
  | { id: string; kind: "rfc8032"; seed: string; public_key: string; message: string; signature: string; expect: string }
  | { id: string; kind: "test_key"; seed_preimage: string; seed: string; public_key: string; public_key_b58: string }
  | { id: string; kind: "verify"; public_key: string; message: string; signature: string; expect: string }
  | { id: string; kind: "strict_base58"; value: string; n: 32 | 64; expect: "ok" | "invalid" };

const ed25519 = load<Ed25519Vector>("ed25519.json");

describe("ed25519.json against src/siws.ts and src/base58.ts", () => {
  for (const v of ed25519.vectors) {
    if (v.kind === "rfc8032") {
      it(`${v.id}: node:crypto reproduces RFC 8032 and verifyConsentSignature says ${v.expect}`, () => {
        const privateKey = privateKeyFromSeed(fromHex(v.seed));
        expect(hex(rawPublicKey(privateKey))).toBe(v.public_key);
        expect(hex(Uint8Array.from(sign(null, fromHex(v.message), privateKey)))).toBe(v.signature);
        expect(verifyConsentSignature(fromHex(v.public_key), fromHex(v.message), fromHex(v.signature))).toBe(v.expect);
      });
    } else if (v.kind === "test_key") {
      it(`${v.id}: seed and public key`, () => {
        expect(sha256Hex(v.seed_preimage)).toBe(v.seed);
        const n = Number(/^gogocash contract v0 test key (\d+)$/.exec(v.seed_preimage)?.[1]);
        expect(hex(rawPublicKey(contractTestKey(n)))).toBe(v.public_key);
        expect(encodeBase58(fromHex(v.public_key))).toBe(v.public_key_b58);
      });
    } else if (v.kind === "verify") {
      it(`${v.id}: verifyConsentSignature -> ${v.expect}`, () => {
        expect(verifyConsentSignature(fromHex(v.public_key), fromHex(v.message), fromHex(v.signature))).toBe(v.expect);
      });
    } else {
      it(`${v.id}: isStrictBase58(n = ${v.n}) -> ${v.expect}`, () => {
        expect(isStrictBase58(v.value, v.n)).toBe(v.expect === "ok");
      });
    }
  }

  it("covers the 8 small-order keys and at least the 11 precheck negatives of section 4.7", () => {
    const verifies = ed25519.vectors.filter((v): v is Extract<Ed25519Vector, { kind: "verify" }> => v.kind === "verify");
    const smallOrder = verifies.filter((v) => v.expect === "A_small_order" && v.id.startsWith("a_small_order_"));
    expect(smallOrder.map((v) => v.public_key).sort()).toEqual([...SMALL_ORDER_PUBLIC_KEYS_HEX].sort());
    const prechecks = verifies.filter((v) => ["A_small_order", "A_non_canonical", "R_non_canonical", "S_not_reduced"].includes(v.expect));
    expect(prechecks.length).toBeGreaterThanOrEqual(11);
    for (const reason of ["ok", "bad_length", "A_small_order", "A_non_canonical", "R_non_canonical", "S_not_reduced", "signature_invalid"]) {
      expect(verifies.some((v) => v.expect === reason), reason).toBe(true);
    }
  });

  it("test key 1 is the section 4.6 signer", () => {
    const v = byId(ed25519.vectors, "test_key_1") as Extract<Ed25519Vector, { kind: "test_key" }>;
    expect(contract).toContain(v.seed);
    expect(v.public_key_b58).toBe(CONSENT_EXAMPLE.input.recipient);
  });
});

// ---------------------------------------------------------------------------
// amounts.json (sections 4.3, 6.3 and 6.4)
// ---------------------------------------------------------------------------

type PolicyResult = { deducted_minor: string; remainder_minor: string; treasury_dust_minor: string };
type AmountVector =
  | {
      id: string;
      kind: "conversion";
      requested_minor: string;
      fee_minor: string;
      net_minor: string;
      thb_per_usd_e8: string;
      usdc_atomic: string;
      value_minor: string;
      member_keeps_remainder: PolicyResult;
      treasury_keeps_remainder: PolicyResult;
      policies_deduct_equal: boolean;
      expect: string;
    }
  | {
      id: string;
      kind: "d4_invariant";
      rate_max_exclusive: string;
      sweep_seed: string;
      sweep_count: number;
      lines_sha256: string;
      expect: string;
    }
  | {
      id: string;
      kind: "bounds";
      amount: string;
      fee_minor: string;
      thb_per_usd_e8: string;
      min_payout_atomic: string;
      max_payout_atomic: string;
      requested_minor: string | null;
      usdc_atomic: string | null;
      expect: string;
    }
  | { id: string; kind: "parse_thb"; amount: string; requested_minor: string | null; expect: string }
  | { id: string; kind: "display_usdc"; usdc_atomic: string; text: string }
  | { id: string; kind: "display_minor"; minor: string; text: string };

const amounts = load<AmountVector>("amounts.json");
const RATE_SCALE = 10n ** 12n;

describe("amounts.json against src/amount.ts", () => {
  for (const v of amounts.vectors) {
    if (v.kind === "conversion") {
      it(`${v.id}: both dust policies, and the D4 invariant below 10^12`, () => {
        const input = { requestedMinor: BigInt(v.requested_minor), feeMinor: BigInt(v.fee_minor), thbPerUsdE8: BigInt(v.thb_per_usd_e8) };
        const member = convertThbMinorToUsdc({ ...input, dustPolicy: "member_keeps_remainder" });
        const treasury = convertThbMinorToUsdc({ ...input, dustPolicy: "treasury_keeps_remainder" });
        for (const c of [member, treasury]) {
          expect(c.netMinor.toString()).toBe(v.net_minor);
          expect(c.usdcAtomic.toString()).toBe(v.usdc_atomic);
          expect(c.valueMinor.toString()).toBe(v.value_minor);
        }
        expect({
          deducted_minor: member.deductedMinor.toString(),
          remainder_minor: member.remainderMinor.toString(),
          treasury_dust_minor: member.treasuryDustMinor.toString(),
        }).toEqual(v.member_keeps_remainder);
        expect({
          deducted_minor: treasury.deductedMinor.toString(),
          remainder_minor: treasury.remainderMinor.toString(),
          treasury_dust_minor: treasury.treasuryDustMinor.toString(),
        }).toEqual(v.treasury_keeps_remainder);
        expect(member.deductedMinor === treasury.deductedMinor).toBe(v.policies_deduct_equal);
        // Never over-deducts.
        expect(member.valueMinor <= member.netMinor).toBe(true);
        expect(member.deductedMinor <= input.requestedMinor).toBe(true);
        if (input.thbPerUsdE8 < RATE_SCALE) {
          expect(member.valueMinor).toBe(member.netMinor);
          expect(v.policies_deduct_equal).toBe(true);
        }
      });
    } else if (v.kind === "d4_invariant") {
      it(`${v.id}: the SDK replays the sweep with the same results and the invariant holds`, () => {
        expect(BigInt(v.rate_max_exclusive)).toBe(RATE_SCALE);
        const lines: string[] = [];
        for (let i = 0; i < v.sweep_count; i += 1) {
          const h = createHash("sha256").update(`${v.sweep_seed} ${i}`).digest();
          const fee = h.readBigUInt64BE(16) % 100000n;
          const net = 1n + (h.readBigUInt64BE(0) % (999999999999n - 100000n));
          const rate = 1n + (h.readBigUInt64BE(8) % (RATE_SCALE - 1n));
          const requested = net + fee;
          const input = { requestedMinor: requested, feeMinor: fee, thbPerUsdE8: rate };
          const m = convertThbMinorToUsdc({ ...input, dustPolicy: "member_keeps_remainder" });
          const t = convertThbMinorToUsdc({ ...input, dustPolicy: "treasury_keeps_remainder" });
          expect(m.valueMinor === m.netMinor && m.deductedMinor === t.deductedMinor && m.remainderMinor === 0n).toBe(true);
          lines.push(`${requested},${fee},${rate},${m.usdcAtomic},${m.valueMinor},${m.deductedMinor},${m.remainderMinor},${t.deductedMinor},${t.treasuryDustMinor}\n`);
        }
        expect(sha256Hex(lines.join(""))).toBe(v.lines_sha256);
      });
    } else if (v.kind === "bounds") {
      it(`${v.id}: checkPayoutBounds -> ${v.expect}`, () => {
        const result = checkPayoutBounds({
          amount: v.amount,
          feeMinor: BigInt(v.fee_minor),
          thbPerUsdE8: BigInt(v.thb_per_usd_e8),
          minPayoutAtomic: BigInt(v.min_payout_atomic),
          maxPayoutAtomic: BigInt(v.max_payout_atomic),
        });
        if (result.ok) {
          expect(v.expect).toBe("ok");
          expect(result.requestedMinor.toString()).toBe(v.requested_minor);
          expect(result.conversion.usdcAtomic.toString()).toBe(v.usdc_atomic);
        } else {
          expect(result.reason).toBe(v.expect);
        }
      });
    } else if (v.kind === "parse_thb") {
      it(`${v.id}: parseThbAmountToMinor(${JSON.stringify(v.amount)})`, () => {
        const parsed = parseThbAmountToMinor(v.amount);
        expect(parsed === null ? null : parsed.toString()).toBe(v.requested_minor);
      });
    } else if (v.kind === "display_usdc") {
      it(`${v.id}: <U> format`, () => {
        expect(formatUsdcAtomicFixed6(BigInt(v.usdc_atomic))).toBe(v.text);
      });
    } else {
      it(`${v.id}: <D>/<F> format`, () => {
        expect(formatMinorFixed2(BigInt(v.minor))).toBe(v.text);
      });
    }
  }

  it("the five section 6.3 worked examples are present and equal the contract table", () => {
    for (const ref of AMOUNT_EXAMPLES) {
      const v = byId(amounts.vectors, ref.id);
      if (v.kind !== "conversion") throw new Error(`${ref.id} is not a conversion vector`);
      expect([v.requested_minor, v.fee_minor, v.net_minor, v.thb_per_usd_e8, v.usdc_atomic, v.value_minor]).toEqual(
        [ref.requested, ref.fee, ref.net, ref.rate, ref.usdc, ref.value].map(String),
      );
      expect(v.member_keeps_remainder.deducted_minor).toBe(String(ref.defaultDeducted));
      expect(v.member_keeps_remainder.remainder_minor).toBe(String(ref.defaultRemainder));
      expect(v.treasury_keeps_remainder.deducted_minor).toBe(String(ref.altDeducted));
      expect(v.treasury_keeps_remainder.treasury_dust_minor).toBe(String(ref.altDust));
    }
  });

  it("covers every section 6.4 refusal reason", () => {
    const reasons = new Set(amounts.vectors.flatMap((v) => (v.kind === "bounds" ? [v.expect] : [])));
    expect([...reasons].sort()).toEqual(["above_maximum", "below_minimum", "exceeds_u64", "fee_exceeds_amount", "invalid_amount", "ok"]);
  });
});

// ---------------------------------------------------------------------------
// states.json (section 8)
// ---------------------------------------------------------------------------

type StateVector =
  | {
      id: string;
      kind: "state";
      state: string;
      terminal: boolean;
      slot_active: boolean | null;
      display_state: string;
      ledger_status: string;
      balance: string;
    }
  | {
      id: string;
      kind: "transition";
      transition: string | null;
      from: string | null;
      to: string;
      actor: string | null;
      guards: string[];
      reasons: string[];
      allowed: boolean;
    };

const states = load<StateVector>("states.json");
const stateVectors = states.vectors.filter((v): v is Extract<StateVector, { kind: "state" }> => v.kind === "state");
const transitionVectors = states.vectors.filter((v): v is Extract<StateVector, { kind: "transition" }> => v.kind === "transition");

describe("states.json against the section 8 tables (the SDK has no claim-state module; the API owns it)", () => {
  it("the claim-state list equals section 8.1, the section 6.7 enum and the TL;DR", () => {
    const rows = tableRows(contractSection("### 8.1 States", "### 8.2 Transitions")).slice(1);
    const fromTable = rows.map((cells) => backticked(cells[0] ?? "")[0]);
    expect(stateVectors.map((v) => v.state)).toEqual(fromTable);
    for (const [index, cells] of rows.entries()) {
      expect(stateVectors[index]?.terminal).toBe((cells[2] ?? "").includes("yes"));
      expect(stateVectors[index]?.slot_active).toBe((cells[3] ?? "").includes("true") ? true : null);
    }
    const enumMatch = /`solana_claim_state` \| String, enum ([^|]+)\|/.exec(contract);
    expect(backticked(enumMatch?.[1] ?? "").sort()).toEqual(stateVectors.map((v) => v.state).sort());
    const tldr = /six claim states \(([^)]+)\)/.exec(contract);
    expect(backticked(tldr?.[1] ?? "")).toEqual(stateVectors.map((v) => v.state));
  });

  it("display_state and ledger status equal section 8.3", () => {
    const rows = tableRows(contractSection("### 8.3 Display and ledger mapping", "## 9.")).slice(1);
    for (const cells of rows) {
      const state = backticked(cells[0] ?? "")[0];
      const v = stateVectors.find((s) => s.state === state);
      expect(v, state).toBeDefined();
      expect(backticked(cells[1] ?? "")[0]).toBe(v?.display_state);
      expect(backticked(cells[2] ?? "")[0]).toBe(v?.ledger_status);
    }
    expect(rows).toHaveLength(stateVectors.length);
  });

  it("every T1-T15 row of section 8.2 appears with its from states, to states and actor", () => {
    const rows = tableRows(contractSection("### 8.2 Transitions", "Notes:")).slice(1);
    expect(rows.map((cells) => cells[0])).toEqual(Array.from({ length: 15 }, (_, i) => `T${i + 1}`));
    for (const cells of rows) {
      const id = cells[0] ?? "";
      const froms = (cells[1] ?? "").startsWith("(none)") ? [null] : backticked(cells[1] ?? "");
      const tos = [...new Set(backticked((cells[2] ?? "").split(";")[0] ?? ""))];
      const actor = (cells[3] ?? "").replaceAll("`", "").replaceAll(" ", "_");
      const vectors = transitionVectors.filter((v) => v.transition === id);
      expect(vectors.length, id).toBeGreaterThan(0);
      expect(new Set(vectors.map((v) => v.from)), id).toEqual(new Set(froms));
      expect(new Set(vectors.map((v) => v.to)), id).toEqual(new Set(tos));
      for (const v of vectors) {
        expect(v.actor, id).toBe(actor);
        expect(v.allowed).toBe(true);
      }
    }
    // T13: from needs_review only to finalized.
    expect(transitionVectors.filter((v) => v.transition === "T13" && v.from === "needs_review").map((v) => v.to)).toEqual(["finalized"]);
  });

  it("allowed and refused transitions partition every (from, to) pair, and terminal states have no exit", () => {
    const names = stateVectors.map((v) => v.state);
    const key = (from: string | null, to: string): string => `${from ?? "(none)"}>${to}`;
    const allowed = new Set(transitionVectors.filter((v) => v.allowed).map((v) => key(v.from, v.to)));
    const refused = transitionVectors.filter((v) => !v.allowed).map((v) => key(v.from, v.to));
    expect(new Set(refused).size).toBe(refused.length);
    for (const pair of refused) expect(allowed.has(pair), pair).toBe(false);
    const all = [null, ...names].flatMap((from) => names.map((to) => key(from, to)));
    expect(new Set([...allowed, ...refused])).toEqual(new Set(all));
    for (const terminal of stateVectors.filter((v) => v.terminal)) {
      expect(transitionVectors.filter((v) => v.allowed && v.from === terminal.state)).toEqual([]);
    }
    expect(transitionVectors.filter((v) => v.allowed && v.to === "released").map((v) => v.transition)).toEqual(["T15", "T15", "T15"]);
  });
});

// ---------------------------------------------------------------------------
// mwa-errors.provisional.json (section 10.8)
// ---------------------------------------------------------------------------

type MwaVector = {
  id: string;
  code: number | string | null;
  code_type: "number" | "string" | "other_number" | "absent";
  origin: string;
  handling: string;
  copy_key: string;
  report: boolean;
  provisional: boolean;
};

const mwa = load<MwaVector>("mwa-errors.provisional.json");

describe("mwa-errors.provisional.json against the section 10.8 table", () => {
  it("is provisional until the B0 device capture (#2993)", () => {
    for (const v of mwa.vectors) expect(v.provisional, v.id).toBe(true);
    expect(contract).toContain("`test/fixtures/mwa-errors.provisional.json`");
  });

  it("has one vector per raw code of the table, plus the other-number and no-code rows", () => {
    const rows = tableRows(contractSection("### 10.8 Error mapping", "- **Source evidence:**")).slice(1);
    const expected: (number | string)[] = [];
    let otherNumber = 0;
    let noCode = 0;
    for (const cells of rows) {
      const first = cells[0] ?? "";
      if (first === "other number") otherNumber += 1;
      else if (first.startsWith("error without")) noCode += 1;
      else {
        for (const token of backticked(first)) expected.push(/^-?\d+$/.test(token) ? Number(token) : token.replace(/^'|'$/g, ""));
      }
    }
    expect([otherNumber, noCode]).toEqual([1, 1]);
    const codes = mwa.vectors.filter((v) => v.code_type === "number" || v.code_type === "string").map((v) => v.code);
    expect(codes).toEqual(expected);
    for (const v of mwa.vectors) {
      if (v.code_type === "number") expect(typeof v.code).toBe("number");
      if (v.code_type === "string") expect(typeof v.code).toBe("string");
      if (v.code_type === "other_number" || v.code_type === "absent") expect(v.code).toBeNull();
    }
    expect(mwa.vectors.filter((v) => v.code_type === "other_number")).toHaveLength(1);
    expect(mwa.vectors.filter((v) => v.code_type === "absent")).toHaveLength(1);
  });
});
