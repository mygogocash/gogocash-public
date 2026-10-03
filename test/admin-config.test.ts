/**
 * release/manifest.json, deploy/vaults.<cluster>.json and
 * deployments/<cluster>.json: strict parsing, the mainnet gate, and the
 * deployment record the workflow writes (scripts/deploy-record.ts).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GENESIS_HASH, SYSTEM_PROGRAM_ADDRESS, USDC_MINT, V0_PLACEHOLDER_PROGRAM_ID } from "../src/clusters.ts";
import {
  AdminConfigError,
  buildDeploymentRecord,
  carryForwardInitializeSignatures,
  deploymentRecordToJson,
  manifestWithDeployment,
  parseDeploymentRecord,
  parseReleaseManifest,
  parseVaultConfig,
  releaseManifestToJson,
  resolveProgramId,
  selectReadyVaults,
  toJsonText,
  type DeploymentRecord,
  type ReleaseManifest,
} from "../src/admin/config.ts";
import { encodeBase58 } from "../src/base58.ts";
import { labelAddress, tempDir } from "./admin-helpers.ts";

const repo = new URL("..", import.meta.url).pathname;
const committedManifest = JSON.parse(readFileSync(join(repo, "release/manifest.json"), "utf8")) as unknown;
const committedVaults = JSON.parse(readFileSync(join(repo, "deploy/vaults.devnet.json"), "utf8")) as Record<string, unknown>;

const PROGRAM = labelAddress("test program");
const ADMIN = labelAddress("admin");
const GUARDIAN = labelAddress("guardian");
const CLAIM = labelAddress("claim authority");
const DEMO_CLAIM = labelAddress("demo claim authority");
const DEMO_MINT = labelAddress("demo mint");
const DEPLOYER = labelAddress("deployer");

function manifestWith(programIds: { devnet: string | null; mainnet: string | null }): ReleaseManifest {
  return parseReleaseManifest({ schema: 1, contract: "v0", programIds, deployments: { devnet: null, mainnet: null } });
}

function vaultConfig(vaults: Record<string, unknown>[]): unknown {
  return { schema: 1, cluster: "devnet", vaults };
}

const usdcEntry = {
  name: "usdc",
  enabled: true,
  mint: USDC_MINT.devnet,
  admin: ADMIN,
  guardian: GUARDIAN,
  claimAuthority: CLAIM,
  maxPerClaim: "5000000",
  maxPerDay: "20000000",
};
const demoEntry = { ...usdcEntry, name: "demo", mint: DEMO_MINT, claimAuthority: DEMO_CLAIM };

describe("release/manifest.json", () => {
  it("the committed v0 manifest: devnet placeholder, mainnet null, nothing deployed", () => {
    const manifest = parseReleaseManifest(committedManifest);
    expect(manifest.programIds).toEqual({ devnet: V0_PLACEHOLDER_PROGRAM_ID, mainnet: null });
    expect(manifest.deployments).toEqual({ devnet: null, mainnet: null });
    expect(toJsonText(releaseManifestToJson(manifest))).toBe(readFileSync(join(repo, "release/manifest.json"), "utf8"));
  });

  it("refuses unknown keys, bad addresses and a deployment without a program id", () => {
    expect(() => parseReleaseManifest({ ...(committedManifest as object), extra: 1 })).toThrow(AdminConfigError);
    expect(() => manifestWith({ devnet: "not-an-address", mainnet: null })).toThrow(/strict base58/);
    expect(() =>
      parseReleaseManifest({
        schema: 1,
        contract: "v0",
        programIds: { devnet: null, mainnet: null },
        deployments: {
          devnet: { programHash: "a".repeat(64), soSha256: "b".repeat(64), deploySlot: "1", upgradeAuthority: DEPLOYER, commit: "c".repeat(40), tag: "v0.1.0", vaults: [] },
          mainnet: null,
        },
      }),
    ).toThrow(/programIds.devnet is null/);
  });
});

describe("resolveProgramId: the mainnet gate and the placeholder", () => {
  it("mainnet needs --i-understand-mainnet AND a manifest id; v0 has none, so it always refuses", () => {
    const v0 = parseReleaseManifest(committedManifest);
    expect(resolveProgramId(v0, "mainnet", { iUnderstandMainnet: false })).toMatchObject({ ok: false, reason: "mainnet_flag_missing" });
    expect(resolveProgramId(v0, "mainnet", { iUnderstandMainnet: true })).toMatchObject({ ok: false, reason: "mainnet_unavailable" });
    const withMainnet = manifestWith({ devnet: PROGRAM, mainnet: PROGRAM });
    expect(resolveProgramId(withMainnet, "mainnet", { iUnderstandMainnet: false })).toMatchObject({ ok: false, reason: "mainnet_flag_missing" });
    expect(resolveProgramId(withMainnet, "mainnet", { iUnderstandMainnet: true })).toEqual({ ok: true, cluster: "mainnet", programId: PROGRAM });
  });

  it("devnet: the placeholder and a null id are refused; a real id resolves", () => {
    const v0 = parseReleaseManifest(committedManifest);
    expect(resolveProgramId(v0, "devnet", { iUnderstandMainnet: false })).toMatchObject({ ok: false, reason: "placeholder_program_id" });
    expect(resolveProgramId(manifestWith({ devnet: null, mainnet: null }), "devnet", { iUnderstandMainnet: false })).toMatchObject({
      ok: false,
      reason: "cluster_unavailable",
    });
    expect(resolveProgramId(manifestWith({ devnet: PROGRAM, mainnet: null }), "devnet", { iUnderstandMainnet: false })).toEqual({
      ok: true,
      cluster: "devnet",
      programId: PROGRAM,
    });
    expect(resolveProgramId(v0, "testnet", { iUnderstandMainnet: true })).toMatchObject({ ok: false, reason: "unknown_cluster" });
  });
});

describe("deploy/vaults.devnet.json", () => {
  it("the committed config is refused until the operator commits the role public keys", () => {
    // Fail closed: the usdc vault is enabled with null roles, so the deploy
    // workflow's --check-only step stops before any key is written.
    expect(() => parseVaultConfig(committedVaults, "devnet")).toThrow(/vaults\[0\]: is enabled but admin is not set/);
    const vaults = committedVaults.vaults as Record<string, unknown>[];
    expect(vaults.map((v) => [v.name, v.enabled, v.mint])).toEqual([
      ["usdc", true, USDC_MINT.devnet],
      ["demo", false, null],
    ]);
    const filled = { ...committedVaults, vaults: [{ ...vaults[0], admin: ADMIN, guardian: GUARDIAN, claimAuthority: CLAIM }, vaults[1]] };
    const config = parseVaultConfig(filled, "devnet");
    expect(selectReadyVaults(config).map((v) => [v.name, v.maxPerClaim, v.maxPerDay])).toEqual([["usdc", 5_000_000n, 20_000_000n]]);
  });

  it("an enabled entry must be complete", () => {
    expect(() => parseVaultConfig(vaultConfig([{ ...usdcEntry, admin: null }]), "devnet")).toThrow(/enabled but admin is not set/);
  });

  it("selects enabled vaults, or the named ones", () => {
    const config = parseVaultConfig(vaultConfig([usdcEntry, { ...demoEntry, enabled: false }]), "devnet");
    expect(selectReadyVaults(config).map((v) => v.name)).toEqual(["usdc"]);
    expect(() => selectReadyVaults(config, ["demo"])).toThrow(/not enabled/);
    expect(() => selectReadyVaults(config, ["nope"])).toThrow(/not in the vault config/);
    const both = parseVaultConfig(vaultConfig([usdcEntry, demoEntry]), "devnet");
    expect(selectReadyVaults(both).map((v) => v.name)).toEqual(["usdc", "demo"]);
    expect(selectReadyVaults(both)[0]).toEqual({
      name: "usdc",
      mint: USDC_MINT.devnet,
      admin: ADMIN,
      guardian: GUARDIAN,
      claimAuthority: CLAIM,
      maxPerClaim: 5_000_000n,
      maxPerDay: 20_000_000n,
    });
    expect(() => selectReadyVaults(parseVaultConfig(vaultConfig([{ ...demoEntry, enabled: false }]), "devnet"))).toThrow(/no enabled vault/);
  });

  it("refuses role conflicts, shared claim keys, the wrong USDC mint, bad caps and unknown keys", () => {
    const refuse = (vaults: Record<string, unknown>[], message: RegExp, cluster: "devnet" | "mainnet" = "devnet") =>
      expect(() => parseVaultConfig(vaultConfig(vaults), cluster)).toThrow(message);
    refuse([{ ...usdcEntry, claimAuthority: ADMIN }], /6020/);
    refuse([{ ...usdcEntry, claimAuthority: GUARDIAN }], /6020/);
    refuse([{ ...usdcEntry, admin: SYSTEM_PROGRAM_ADDRESS }], /6007/);
    refuse([usdcEntry, { ...demoEntry, claimAuthority: CLAIM }], /duplicate claimAuthority/);
    refuse([usdcEntry, { ...demoEntry, mint: USDC_MINT.devnet }], /only the vault named "usdc"/);
    refuse([{ ...usdcEntry, mint: DEMO_MINT }], /must use the devnet USDC mint/);
    refuse([usdcEntry, { ...usdcEntry, mint: null, enabled: false, claimAuthority: null }], /duplicate name/);
    refuse([{ ...usdcEntry, maxPerClaim: "0" }], /6021/);
    refuse([{ ...usdcEntry, maxPerClaim: "30000000" }], /6021/);
    refuse([{ ...usdcEntry, maxPerDay: "01" }], /u64 decimal string/);
    refuse([{ ...usdcEntry, note: "x" }], /unknown key/);
    refuse([{ ...usdcEntry, name: "USDC" }], /lowercase/);
    expect(() => parseVaultConfig(vaultConfig([usdcEntry]), "mainnet")).toThrow(/is for devnet, not mainnet/);
  });
});

describe("deployment record and manifest update", () => {
  const vaults = [
    {
      name: "usdc",
      mint: USDC_MINT.devnet,
      vault: labelAddress("vault pda"),
      vaultBump: 254,
      vaultTokenAccount: labelAddress("vault ata"),
      admin: ADMIN,
      guardian: GUARDIAN,
      claimAuthority: CLAIM,
      maxPerClaim: 5_000_000n,
      maxPerDay: 20_000_000n,
      initializeSignature: null,
    },
  ];
  const input: Omit<DeploymentRecord, "schema" | "genesisHash" | "loader"> = {
    cluster: "devnet",
    programId: PROGRAM,
    programDataAddress: labelAddress("program data"),
    upgradeAuthority: DEPLOYER,
    deploySlot: 412_345_678n,
    programHash: "ab".repeat(32),
    soSha256: "cd".repeat(32),
    source: { repository: "mygogocash/gogocash-public", commit: "e".repeat(40), tag: "v0.1.0" },
    vaults,
  };

  it("round-trips through JSON and fills the manifest's deployment summary", () => {
    const record = buildDeploymentRecord(input);
    expect(record.genesisHash).toBe(GENESIS_HASH.devnet);
    expect(parseDeploymentRecord(JSON.parse(toJsonText(deploymentRecordToJson(record))), "devnet")).toEqual(record);
    const manifest = manifestWithDeployment(manifestWith({ devnet: PROGRAM, mainnet: null }), record);
    expect(manifest.deployments.devnet).toEqual({
      programHash: input.programHash,
      soSha256: input.soSha256,
      deploySlot: 412_345_678n,
      upgradeAuthority: DEPLOYER,
      commit: input.source.commit,
      tag: "v0.1.0",
      vaults: [{ name: "usdc", mint: USDC_MINT.devnet, vault: vaults[0]!.vault, vaultTokenAccount: vaults[0]!.vaultTokenAccount }],
    });
    expect(manifest.programIds).toEqual({ devnet: PROGRAM, mainnet: null });
    expect(parseReleaseManifest(JSON.parse(toJsonText(releaseManifestToJson(manifest))))).toEqual(manifest);
  });

  it("a vault a later run only checked keeps its original initialize signature", () => {
    const signature = encodeBase58(new Uint8Array(64).fill(7));
    const first = buildDeploymentRecord({ ...input, vaults: [{ ...vaults[0]!, initializeSignature: signature }] });
    const demo = { ...vaults[0]!, name: "demo", mint: DEMO_MINT, vault: labelAddress("demo vault pda"), claimAuthority: DEMO_CLAIM };
    const demoSignature = encodeBase58(new Uint8Array(64).fill(9));
    const later = [vaults[0]!, { ...demo, initializeSignature: demoSignature }];
    expect(carryForwardInitializeSignatures(later, PROGRAM, first).map((v) => v.initializeSignature)).toEqual([signature, demoSignature]);
    // Nothing is carried from another program, another vault address, or no record.
    expect(carryForwardInitializeSignatures(later, labelAddress("other program"), first)[0]!.initializeSignature).toBeNull();
    const moved = [{ ...vaults[0]!, vault: labelAddress("another vault pda") }];
    expect(carryForwardInitializeSignatures(moved, PROGRAM, first)[0]!.initializeSignature).toBeNull();
    expect(carryForwardInitializeSignatures(later, PROGRAM, null)[0]!.initializeSignature).toBeNull();
    // A signature this run recorded is never replaced.
    const fresh = encodeBase58(new Uint8Array(64).fill(5));
    expect(carryForwardInitializeSignatures([{ ...vaults[0]!, initializeSignature: fresh }], PROGRAM, first)[0]!.initializeSignature).toBe(fresh);
  });

  it("refuses a program id that is not the manifest's, bad hashes and the wrong genesis", () => {
    const record = buildDeploymentRecord(input);
    expect(() => manifestWithDeployment(parseReleaseManifest(committedManifest), record)).toThrow(/is not release\/manifest.json/);
    expect(() => buildDeploymentRecord({ ...input, programHash: "AB".repeat(32) })).toThrow(/64 lowercase hex/);
    expect(() => buildDeploymentRecord({ ...input, source: { ...input.source, tag: "release-1" } })).toThrow(/v\* tag/);
    const json = deploymentRecordToJson(record);
    expect(() => parseDeploymentRecord({ ...json, genesisHash: GENESIS_HASH.mainnet }, "devnet")).toThrow(/genesisHash/);
    expect(() => parseDeploymentRecord(json, "mainnet")).toThrow(/is for devnet/);
  });
});

describe("scripts/deploy-record.ts", () => {
  const dir = tempDir("gogocash-record-");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("writes deployments/devnet.json and release/manifest.json into --out-dir only", () => {
    const manifestPath = join(dir, "manifest.json");
    writeFileSync(manifestPath, toJsonText(releaseManifestToJson(manifestWith({ devnet: PROGRAM, mainnet: null }))));
    const vaultsPath = join(dir, "vaults.json");
    writeFileSync(
      vaultsPath,
      toJsonText([
        {
          name: "usdc",
          mint: USDC_MINT.devnet,
          vault: labelAddress("vault pda"),
          vaultBump: 254,
          vaultTokenAccount: labelAddress("vault ata"),
          admin: ADMIN,
          guardian: GUARDIAN,
          claimAuthority: CLAIM,
          maxPerClaim: "5000000",
          maxPerDay: "20000000",
          initializeSignature: null,
        },
      ]),
    );
    const outDir = join(dir, "out");
    const args = [
      "scripts/deploy-record.ts",
      "--cluster", "devnet",
      "--program-id", PROGRAM,
      "--program-data", labelAddress("program data"),
      "--upgrade-authority", DEPLOYER,
      "--deploy-slot", "412345678",
      "--program-hash", "ab".repeat(32),
      "--so-sha256", "cd".repeat(32),
      "--repository", "mygogocash/gogocash-public",
      "--commit", "e".repeat(40),
      "--tag", "v0.1.0",
      "--vaults", vaultsPath,
      "--manifest", manifestPath,
      "--out-dir", outDir,
    ];
    const run = spawnSync(process.execPath, args, { cwd: repo, encoding: "utf8" });
    expect(run.stderr.replace(/^.*ExperimentalWarning.*\n?/gm, "").replace(/^\(Use .*\n?/gm, "")).toBe("");
    expect(run.status).toBe(0);
    const record = parseDeploymentRecord(JSON.parse(readFileSync(join(outDir, "deployments/devnet.json"), "utf8")), "devnet");
    expect(record.deploySlot).toBe(412_345_678n);
    const manifest = parseReleaseManifest(JSON.parse(readFileSync(join(outDir, "release/manifest.json"), "utf8")));
    expect(manifest.deployments.devnet?.vaults.map((v) => v.name)).toEqual(["usdc"]);

    const refused = spawnSync(process.execPath, [...args.slice(0, -4), "--manifest", join(repo, "release/manifest.json"), "--out-dir", join(dir, "out2")], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/is not release\/manifest.json/);

    // A later tag: the vault was only checked (null), the committed record
    // (--previous) holds its initialize signature, and the new record keeps it.
    const signature = encodeBase58(new Uint8Array(64).fill(7));
    const previousPath = join(dir, "previous-devnet.json");
    const previousJson = JSON.parse(readFileSync(join(outDir, "deployments/devnet.json"), "utf8")) as { vaults: Record<string, unknown>[] };
    previousJson.vaults[0]!.initializeSignature = signature;
    writeFileSync(previousPath, toJsonText(previousJson));
    const laterOut = join(dir, "out3");
    const later = spawnSync(process.execPath, [...args.slice(0, -2), "--previous", previousPath, "--out-dir", laterOut], { cwd: repo, encoding: "utf8" });
    expect(later.status).toBe(0);
    const laterRecord = parseDeploymentRecord(JSON.parse(readFileSync(join(laterOut, "deployments/devnet.json"), "utf8")), "devnet");
    expect(laterRecord.vaults[0]!.initializeSignature).toBe(signature);

    // The first deployment has no committed record yet: a missing file carries nothing.
    const firstOut = join(dir, "out4");
    const first = spawnSync(process.execPath, [...args.slice(0, -2), "--previous", join(dir, "missing.json"), "--out-dir", firstOut], { cwd: repo, encoding: "utf8" });
    expect(first.status).toBe(0);
    const firstRecord = parseDeploymentRecord(JSON.parse(readFileSync(join(firstOut, "deployments/devnet.json"), "utf8")), "devnet");
    expect(firstRecord.vaults[0]!.initializeSignature).toBeNull();

    // A committed record that does not parse is refused, not ignored.
    writeFileSync(previousPath, "{}\n");
    const broken = spawnSync(process.execPath, [...args.slice(0, -2), "--previous", previousPath, "--out-dir", join(dir, "out5")], { cwd: repo, encoding: "utf8" });
    expect(broken.status).toBe(2);
  });
});
