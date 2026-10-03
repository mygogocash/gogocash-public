/**
 * Operator configuration files, parsed strictly (pure, no I/O):
 *
 * - `release/manifest.json`: the program id per cluster (docs/CONTRACT.md
 *   section 2.4) and, once a cluster is deployed, the deployment summary the
 *   keyless verifier reads (program hash, deploy slot, vaults and mints).
 * - `deploy/vaults.<cluster>.json`: the vaults the deploy workflow and
 *   `npm run admin -- initialize` create. Public keys only.
 * - `deployments/<cluster>.json`: the full record the deploy workflow writes
 *   and the founder commits; `npm run admin -- show` compares the chain with it.
 *
 * Unknown keys are refused, so a typo can't silently drop a field. Amounts
 * are decimal strings in JSON and `bigint` in code.
 */
import { address, type Address } from "@solana/kit";
import { formatAtomicAmount, parseAtomicAmount } from "../amount.ts";
import { isStrictBase58 } from "../base58.ts";
import {
  BPF_LOADER_UPGRADEABLE_ADDRESS,
  CLUSTERS,
  GENESIS_HASH,
  isCluster,
  SYSTEM_PROGRAM_ADDRESS,
  USDC_MINT,
  V0_PLACEHOLDER_PROGRAM_ID,
  type Cluster,
} from "../clusters.ts";

export class AdminConfigError extends Error {
  override name = "AdminConfigError";
}

const HEX64 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const VAULT_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const SLOT = /^(0|[1-9][0-9]{0,19})$/;
const TAG = /^v[0-9A-Za-z._-]{1,64}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

type Json = Record<string, unknown>;

function fail(where: string, message: string): never {
  throw new AdminConfigError(`${where}: ${message}`);
}

function asObject(value: unknown, where: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(where, "must be a JSON object.");
  }
  return value as Json;
}

function onlyKeys(object: Json, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) fail(where, `unknown key "${key}".`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(object, key)) fail(where, `missing key "${key}".`);
  }
}

function asAddress(value: unknown, where: string): Address {
  if (!isStrictBase58(value, 32)) fail(where, "must be a strict base58 address.");
  return address(value as string);
}

function asNullableAddress(value: unknown, where: string): Address | null {
  return value === null ? null : asAddress(value, where);
}

function asRole(value: unknown, where: string): Address {
  const role = asAddress(value, where);
  if (role === SYSTEM_PROGRAM_ADDRESS) fail(where, "must not be the default public key (6007 InvalidRole).");
  return role;
}

function asNullableRole(value: unknown, where: string): Address | null {
  return value === null ? null : asRole(value, where);
}

function asAtomic(value: unknown, where: string): bigint {
  if (typeof value !== "string") fail(where, "must be a decimal string.");
  try {
    return parseAtomicAmount(value);
  } catch {
    return fail(where, "must be a u64 decimal string without leading zeros.");
  }
}

function asString(value: unknown, pattern: RegExp, where: string, description: string): string {
  if (typeof value !== "string" || !pattern.test(value)) fail(where, `must be ${description}.`);
  return value;
}

function asSlot(value: unknown, where: string): bigint {
  return BigInt(asString(value, SLOT, where, "a decimal slot string"));
}

function asBool(value: unknown, where: string): boolean {
  if (typeof value !== "boolean") fail(where, "must be true or false.");
  return value;
}

function asArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) fail(where, "must be a JSON array.");
  return value;
}

function asSchema(value: unknown, where: string): 1 {
  if (value !== 1) fail(where, "schema must be 1.");
  return 1;
}

function asCluster(value: unknown, where: string): Cluster {
  if (!isCluster(value)) fail(where, 'must be "devnet" or "mainnet".');
  return value;
}

/** Caps rule of initialize I7 / update_config G4. */
export function capsProblem(maxPerClaim: bigint, maxPerDay: bigint): string | null {
  if (maxPerClaim <= 0n || maxPerDay <= 0n) return "caps must be greater than zero (6021 InvalidCaps).";
  if (maxPerClaim > maxPerDay) return "maxPerClaim must not exceed maxPerDay (6021 InvalidCaps).";
  return null;
}

/** Role rule of initialize I5/I6 and update_config G2/G3. */
export function rolesProblem(roles: {
  readonly admin: Address;
  readonly guardian: Address;
  readonly claimAuthority: Address;
}): string | null {
  for (const [name, value] of Object.entries(roles)) {
    if (value === SYSTEM_PROGRAM_ADDRESS) return `${name} must not be the default public key (6007 InvalidRole).`;
  }
  if (roles.claimAuthority === roles.admin) return "claimAuthority must not be the admin (6020 RoleConflict).";
  if (roles.claimAuthority === roles.guardian) return "claimAuthority must not be the guardian (6020 RoleConflict).";
  return null;
}

// ---------------------------------------------------------------------------
// release/manifest.json
// ---------------------------------------------------------------------------

export type ManifestVault = {
  readonly name: string;
  readonly mint: Address;
  readonly vault: Address;
  readonly vaultTokenAccount: Address;
};

export type ManifestDeployment = {
  /** `solana-verify get-program-hash` of the deployed program (64 hex). */
  readonly programHash: string;
  /** sha256 of the verified `.so` file (64 hex). */
  readonly soSha256: string;
  readonly deploySlot: bigint;
  readonly upgradeAuthority: Address;
  readonly commit: string;
  readonly tag: string;
  readonly vaults: readonly ManifestVault[];
};

export type ReleaseManifest = {
  readonly schema: 1;
  readonly contract: string;
  readonly programIds: Readonly<Record<Cluster, Address | null>>;
  readonly deployments: Readonly<Record<Cluster, ManifestDeployment | null>>;
};

function parseManifestVault(value: unknown, where: string): ManifestVault {
  const object = asObject(value, where);
  onlyKeys(object, ["name", "mint", "vault", "vaultTokenAccount"], where);
  return {
    name: asString(object.name, VAULT_NAME, `${where}.name`, "a lowercase vault name"),
    mint: asAddress(object.mint, `${where}.mint`),
    vault: asAddress(object.vault, `${where}.vault`),
    vaultTokenAccount: asAddress(object.vaultTokenAccount, `${where}.vaultTokenAccount`),
  };
}

function parseManifestDeployment(value: unknown, where: string): ManifestDeployment | null {
  if (value === null) return null;
  const object = asObject(value, where);
  onlyKeys(
    object,
    ["programHash", "soSha256", "deploySlot", "upgradeAuthority", "commit", "tag", "vaults"],
    where,
  );
  const vaults = asArray(object.vaults, `${where}.vaults`).map((entry, index) =>
    parseManifestVault(entry, `${where}.vaults[${index}]`),
  );
  assertUnique(vaults.map((v) => v.name), `${where}.vaults`, "name");
  assertUnique(vaults.map((v) => v.mint), `${where}.vaults`, "mint");
  return {
    programHash: asString(object.programHash, HEX64, `${where}.programHash`, "64 lowercase hex"),
    soSha256: asString(object.soSha256, HEX64, `${where}.soSha256`, "64 lowercase hex"),
    deploySlot: asSlot(object.deploySlot, `${where}.deploySlot`),
    upgradeAuthority: asAddress(object.upgradeAuthority, `${where}.upgradeAuthority`),
    commit: asString(object.commit, COMMIT, `${where}.commit`, "a 40-hex commit"),
    tag: asString(object.tag, TAG, `${where}.tag`, "a v* tag"),
    vaults,
  };
}

function assertUnique(values: readonly string[], where: string, field: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) fail(where, `duplicate ${field} ${value}.`);
    seen.add(value);
  }
}

/** Parses `release/manifest.json` strictly. */
export function parseReleaseManifest(json: unknown): ReleaseManifest {
  const where = "release/manifest.json";
  const object = asObject(json, where);
  onlyKeys(object, ["schema", "contract", "programIds", "deployments"], where);
  const programIdsObject = asObject(object.programIds, `${where}.programIds`);
  onlyKeys(programIdsObject, CLUSTERS, `${where}.programIds`);
  const deploymentsObject = asObject(object.deployments, `${where}.deployments`);
  onlyKeys(deploymentsObject, CLUSTERS, `${where}.deployments`);
  const programIds = {
    devnet: asNullableAddress(programIdsObject.devnet, `${where}.programIds.devnet`),
    mainnet: asNullableAddress(programIdsObject.mainnet, `${where}.programIds.mainnet`),
  };
  const deployments = {
    devnet: parseManifestDeployment(deploymentsObject.devnet, `${where}.deployments.devnet`),
    mainnet: parseManifestDeployment(deploymentsObject.mainnet, `${where}.deployments.mainnet`),
  };
  for (const cluster of CLUSTERS) {
    if (deployments[cluster] !== null && programIds[cluster] === null) {
      fail(where, `deployments.${cluster} is set but programIds.${cluster} is null.`);
    }
  }
  return {
    schema: asSchema(object.schema, `${where}.schema`),
    contract: asString(object.contract, /^v[0-9][0-9.]*$/, `${where}.contract`, 'a contract version such as "v0"'),
    programIds,
    deployments,
  };
}

export type ProgramIdResolution =
  | { readonly ok: true; readonly cluster: Cluster; readonly programId: Address }
  | {
      readonly ok: false;
      readonly reason:
        | "unknown_cluster"
        | "mainnet_flag_missing"
        | "mainnet_unavailable"
        | "cluster_unavailable"
        | "placeholder_program_id";
      readonly message: string;
    };

/**
 * The program id an operator command may use (section 2.4: always the
 * manifest's, never an IDL or generated default).
 *
 * - mainnet needs BOTH `iUnderstandMainnet` and a non-null
 *   `programIds.mainnet`; contract v0 has none, so mainnet always refuses;
 * - a `null` id means the cluster is unavailable;
 * - the v0 placeholder has no key and no deployed program, so it is refused
 *   for any command that reads or writes the chain.
 */
export function resolveProgramId(
  manifest: ReleaseManifest,
  cluster: unknown,
  options: { readonly iUnderstandMainnet: boolean },
): ProgramIdResolution {
  if (!isCluster(cluster)) {
    return { ok: false, reason: "unknown_cluster", message: '--cluster must be "devnet" or "mainnet".' };
  }
  if (cluster === "mainnet") {
    if (options.iUnderstandMainnet !== true) {
      return {
        ok: false,
        reason: "mainnet_flag_missing",
        message: "mainnet is refused without --i-understand-mainnet.",
      };
    }
    if (manifest.programIds.mainnet === null) {
      return {
        ok: false,
        reason: "mainnet_unavailable",
        message: "release/manifest.json has no mainnet program id (contract v0 assigns none), so mainnet is refused.",
      };
    }
  }
  const programId = manifest.programIds[cluster];
  if (programId === null) {
    return {
      ok: false,
      reason: "cluster_unavailable",
      message: `release/manifest.json has no ${cluster} program id.`,
    };
  }
  if (programId === V0_PLACEHOLDER_PROGRAM_ID) {
    return {
      ok: false,
      reason: "placeholder_program_id",
      message: `programIds.${cluster} is the v0 placeholder, which has no key and no deployed program. Commit the real program id first (docs/RUNBOOK-DEVNET.md).`,
    };
  }
  return { ok: true, cluster, programId };
}

// ---------------------------------------------------------------------------
// deploy/vaults.<cluster>.json
// ---------------------------------------------------------------------------

export type VaultConfigEntry = {
  readonly name: string;
  readonly enabled: boolean;
  readonly mint: Address | null;
  readonly admin: Address | null;
  readonly guardian: Address | null;
  readonly claimAuthority: Address | null;
  readonly maxPerClaim: bigint;
  readonly maxPerDay: bigint;
};

/** An enabled, complete vault entry: what `initialize` sends. */
export type ReadyVault = {
  readonly name: string;
  readonly mint: Address;
  readonly admin: Address;
  readonly guardian: Address;
  readonly claimAuthority: Address;
  readonly maxPerClaim: bigint;
  readonly maxPerDay: bigint;
};

export type VaultConfig = {
  readonly cluster: Cluster;
  readonly vaults: readonly VaultConfigEntry[];
};

const VAULT_CONFIG_KEYS = [
  "name",
  "enabled",
  "mint",
  "admin",
  "guardian",
  "claimAuthority",
  "maxPerClaim",
  "maxPerDay",
] as const;

/**
 * Parses `deploy/vaults.<cluster>.json`. Disabled entries may leave keys
 * `null` (not created yet); enabled ones must be complete. Across entries:
 * names, mints and claim authorities are unique (the demo vault has its own
 * claim key, so drills never touch the API's vault), and the vault named
 * `usdc` is exactly the one on the cluster's USDC mint (section 2.3).
 */
export function parseVaultConfig(json: unknown, expectedCluster: Cluster, where = "vault config"): VaultConfig {
  const object = asObject(json, where);
  onlyKeys(object, ["schema", "cluster", "vaults"], where);
  asSchema(object.schema, `${where}.schema`);
  const cluster = asCluster(object.cluster, `${where}.cluster`);
  if (cluster !== expectedCluster) fail(where, `is for ${cluster}, not ${expectedCluster}.`);
  const vaults = asArray(object.vaults, `${where}.vaults`).map((value, index): VaultConfigEntry => {
    const at = `${where}.vaults[${index}]`;
    const entry = asObject(value, at);
    onlyKeys(entry, VAULT_CONFIG_KEYS, at);
    const parsed: VaultConfigEntry = {
      name: asString(entry.name, VAULT_NAME, `${at}.name`, "a lowercase vault name"),
      enabled: asBool(entry.enabled, `${at}.enabled`),
      mint: asNullableAddress(entry.mint, `${at}.mint`),
      admin: asNullableRole(entry.admin, `${at}.admin`),
      guardian: asNullableRole(entry.guardian, `${at}.guardian`),
      claimAuthority: asNullableRole(entry.claimAuthority, `${at}.claimAuthority`),
      maxPerClaim: asAtomic(entry.maxPerClaim, `${at}.maxPerClaim`),
      maxPerDay: asAtomic(entry.maxPerDay, `${at}.maxPerDay`),
    };
    const caps = capsProblem(parsed.maxPerClaim, parsed.maxPerDay);
    if (caps !== null) fail(at, caps);
    if (parsed.claimAuthority !== null) {
      if (parsed.claimAuthority === parsed.admin) fail(at, "claimAuthority must not be the admin (6020 RoleConflict).");
      if (parsed.claimAuthority === parsed.guardian) {
        fail(at, "claimAuthority must not be the guardian (6020 RoleConflict).");
      }
    }
    const isUsdcMint = parsed.mint === USDC_MINT[cluster];
    if (parsed.name === "usdc" && parsed.mint !== null && !isUsdcMint) {
      fail(at, `the "usdc" vault must use the ${cluster} USDC mint ${USDC_MINT[cluster]}.`);
    }
    if (isUsdcMint && parsed.name !== "usdc") fail(at, `only the vault named "usdc" may use the USDC mint.`);
    if (parsed.enabled) {
      for (const key of ["mint", "admin", "guardian", "claimAuthority"] as const) {
        if (parsed[key] === null) fail(at, `is enabled but ${key} is not set.`);
      }
    }
    return parsed;
  });
  assertUnique(vaults.map((v) => v.name), `${where}.vaults`, "name");
  assertUnique(vaults.flatMap((v) => (v.mint === null ? [] : [v.mint])), `${where}.vaults`, "mint");
  assertUnique(
    vaults.flatMap((v) => (v.claimAuthority === null ? [] : [v.claimAuthority])),
    `${where}.vaults`,
    "claimAuthority",
  );
  return { cluster, vaults };
}

/**
 * The vaults to initialize: the named ones (each must exist and be enabled),
 * or every enabled one. Refuses an empty selection.
 */
export function selectReadyVaults(config: VaultConfig, names: readonly string[] = []): ReadyVault[] {
  const chosen =
    names.length === 0
      ? config.vaults.filter((v) => v.enabled)
      : names.map((name) => {
          const found = config.vaults.find((v) => v.name === name);
          if (found === undefined) throw new AdminConfigError(`vault "${name}" is not in the vault config.`);
          if (!found.enabled) throw new AdminConfigError(`vault "${name}" is not enabled in the vault config.`);
          return found;
        });
  if (chosen.length === 0) throw new AdminConfigError("the vault config has no enabled vault.");
  return chosen.map((v) => ({
    name: v.name,
    // Enabled entries are complete (checked by parseVaultConfig).
    mint: v.mint as Address,
    admin: v.admin as Address,
    guardian: v.guardian as Address,
    claimAuthority: v.claimAuthority as Address,
    maxPerClaim: v.maxPerClaim,
    maxPerDay: v.maxPerDay,
  }));
}

// ---------------------------------------------------------------------------
// deployments/<cluster>.json
// ---------------------------------------------------------------------------

export type DeploymentVault = ReadyVault & {
  readonly vault: Address;
  readonly vaultBump: number;
  readonly vaultTokenAccount: Address;
  /** `null` when the vault already existed and was only checked. */
  readonly initializeSignature: string | null;
};

export type DeploymentRecord = {
  readonly schema: 1;
  readonly cluster: Cluster;
  readonly genesisHash: string;
  readonly programId: Address;
  readonly programDataAddress: Address;
  readonly upgradeAuthority: Address;
  readonly loader: Address;
  readonly deploySlot: bigint;
  readonly programHash: string;
  readonly soSha256: string;
  readonly source: { readonly repository: string; readonly commit: string; readonly tag: string };
  readonly vaults: readonly DeploymentVault[];
};

const DEPLOYMENT_VAULT_KEYS = [
  "name",
  "mint",
  "vault",
  "vaultBump",
  "vaultTokenAccount",
  "admin",
  "guardian",
  "claimAuthority",
  "maxPerClaim",
  "maxPerDay",
  "initializeSignature",
] as const;

export function parseDeploymentVault(value: unknown, where: string): DeploymentVault {
  const object = asObject(value, where);
  onlyKeys(object, DEPLOYMENT_VAULT_KEYS, where);
  const bump = object.vaultBump;
  if (typeof bump !== "number" || !Number.isInteger(bump) || bump < 0 || bump > 255) {
    fail(`${where}.vaultBump`, "must be an integer from 0 to 255.");
  }
  const signature = object.initializeSignature;
  if (signature !== null && !isStrictBase58(signature, 64)) {
    fail(`${where}.initializeSignature`, "must be null or a strict base58 signature.");
  }
  const vault: DeploymentVault = {
    name: asString(object.name, VAULT_NAME, `${where}.name`, "a lowercase vault name"),
    mint: asAddress(object.mint, `${where}.mint`),
    vault: asAddress(object.vault, `${where}.vault`),
    vaultBump: bump,
    vaultTokenAccount: asAddress(object.vaultTokenAccount, `${where}.vaultTokenAccount`),
    admin: asRole(object.admin, `${where}.admin`),
    guardian: asRole(object.guardian, `${where}.guardian`),
    claimAuthority: asRole(object.claimAuthority, `${where}.claimAuthority`),
    maxPerClaim: asAtomic(object.maxPerClaim, `${where}.maxPerClaim`),
    maxPerDay: asAtomic(object.maxPerDay, `${where}.maxPerDay`),
    initializeSignature: signature as string | null,
  };
  const roles = rolesProblem(vault);
  if (roles !== null) fail(where, roles);
  const caps = capsProblem(vault.maxPerClaim, vault.maxPerDay);
  if (caps !== null) fail(where, caps);
  return vault;
}

export function parseDeploymentVaults(json: unknown, where = "vault records"): DeploymentVault[] {
  const vaults = asArray(json, where).map((value, index) => parseDeploymentVault(value, `${where}[${index}]`));
  assertUnique(vaults.map((v) => v.name), where, "name");
  assertUnique(vaults.map((v) => v.mint), where, "mint");
  return vaults;
}

/** Parses `deployments/<cluster>.json` strictly. */
export function parseDeploymentRecord(json: unknown, expectedCluster: Cluster): DeploymentRecord {
  const where = `deployments/${expectedCluster}.json`;
  const object = asObject(json, where);
  onlyKeys(
    object,
    [
      "schema",
      "cluster",
      "genesisHash",
      "programId",
      "programDataAddress",
      "upgradeAuthority",
      "loader",
      "deploySlot",
      "programHash",
      "soSha256",
      "source",
      "vaults",
    ],
    where,
  );
  const cluster = asCluster(object.cluster, `${where}.cluster`);
  if (cluster !== expectedCluster) fail(where, `is for ${cluster}, not ${expectedCluster}.`);
  if (object.genesisHash !== GENESIS_HASH[cluster]) fail(`${where}.genesisHash`, `must be ${GENESIS_HASH[cluster]}.`);
  const loader = asAddress(object.loader, `${where}.loader`);
  if (loader !== BPF_LOADER_UPGRADEABLE_ADDRESS) fail(`${where}.loader`, "must be the loader-v3 address.");
  const source = asObject(object.source, `${where}.source`);
  onlyKeys(source, ["repository", "commit", "tag"], `${where}.source`);
  return {
    schema: asSchema(object.schema, `${where}.schema`),
    cluster,
    genesisHash: GENESIS_HASH[cluster],
    programId: asAddress(object.programId, `${where}.programId`),
    programDataAddress: asAddress(object.programDataAddress, `${where}.programDataAddress`),
    upgradeAuthority: asAddress(object.upgradeAuthority, `${where}.upgradeAuthority`),
    loader,
    deploySlot: asSlot(object.deploySlot, `${where}.deploySlot`),
    programHash: asString(object.programHash, HEX64, `${where}.programHash`, "64 lowercase hex"),
    soSha256: asString(object.soSha256, HEX64, `${where}.soSha256`, "64 lowercase hex"),
    source: {
      repository: asString(source.repository, REPOSITORY, `${where}.source.repository`, "owner/name"),
      commit: asString(source.commit, COMMIT, `${where}.source.commit`, "a 40-hex commit"),
      tag: asString(source.tag, TAG, `${where}.source.tag`, "a v* tag"),
    },
    vaults: parseDeploymentVaults(object.vaults, `${where}.vaults`),
  };
}

export function deploymentVaultToJson(vault: DeploymentVault): Json {
  return {
    name: vault.name,
    mint: vault.mint,
    vault: vault.vault,
    vaultBump: vault.vaultBump,
    vaultTokenAccount: vault.vaultTokenAccount,
    admin: vault.admin,
    guardian: vault.guardian,
    claimAuthority: vault.claimAuthority,
    maxPerClaim: formatAtomicAmount(vault.maxPerClaim),
    maxPerDay: formatAtomicAmount(vault.maxPerDay),
    initializeSignature: vault.initializeSignature,
  };
}

export function deploymentRecordToJson(record: DeploymentRecord): Json {
  return {
    schema: record.schema,
    cluster: record.cluster,
    genesisHash: record.genesisHash,
    programId: record.programId,
    programDataAddress: record.programDataAddress,
    upgradeAuthority: record.upgradeAuthority,
    loader: record.loader,
    deploySlot: record.deploySlot.toString(10),
    programHash: record.programHash,
    soSha256: record.soSha256,
    source: { repository: record.source.repository, commit: record.source.commit, tag: record.source.tag },
    vaults: record.vaults.map(deploymentVaultToJson),
  };
}

function manifestDeploymentToJson(deployment: ManifestDeployment | null): Json | null {
  if (deployment === null) return null;
  return {
    programHash: deployment.programHash,
    soSha256: deployment.soSha256,
    deploySlot: deployment.deploySlot.toString(10),
    upgradeAuthority: deployment.upgradeAuthority,
    commit: deployment.commit,
    tag: deployment.tag,
    vaults: deployment.vaults.map((v) => ({
      name: v.name,
      mint: v.mint,
      vault: v.vault,
      vaultTokenAccount: v.vaultTokenAccount,
    })),
  };
}

export function releaseManifestToJson(manifest: ReleaseManifest): Json {
  return {
    schema: manifest.schema,
    contract: manifest.contract,
    programIds: { devnet: manifest.programIds.devnet, mainnet: manifest.programIds.mainnet },
    deployments: {
      devnet: manifestDeploymentToJson(manifest.deployments.devnet),
      mainnet: manifestDeploymentToJson(manifest.deployments.mainnet),
    },
  };
}

/** Two-space JSON with a trailing LF, the repository's committed format. */
export function toJsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * The manifest after a deployment: same program ids (the deployed id must
 * already be the manifest's, committed before the tag), with
 * `deployments[cluster]` replaced by the record's summary.
 */
export function manifestWithDeployment(manifest: ReleaseManifest, record: DeploymentRecord): ReleaseManifest {
  const pinned = manifest.programIds[record.cluster];
  if (pinned !== record.programId) {
    throw new AdminConfigError(
      `the deployed program id ${record.programId} is not release/manifest.json programIds.${record.cluster} (${String(pinned)}).`,
    );
  }
  if (record.vaults.length === 0) throw new AdminConfigError("a deployment record needs at least one vault.");
  return {
    ...manifest,
    deployments: {
      ...manifest.deployments,
      [record.cluster]: {
        programHash: record.programHash,
        soSha256: record.soSha256,
        deploySlot: record.deploySlot,
        upgradeAuthority: record.upgradeAuthority,
        commit: record.source.commit,
        tag: record.source.tag,
        vaults: record.vaults.map((v) => ({
          name: v.name,
          mint: v.mint,
          vault: v.vault,
          vaultTokenAccount: v.vaultTokenAccount,
        })),
      },
    },
  };
}

/**
 * Keeps the original `initializeSignature` of a vault that a later run only
 * checked (`initialize --skip-existing` records `null` for it). The previous
 * record must be for the same program, and the vault must have the same
 * name, mint and vault address; anything else is left as it is.
 */
export function carryForwardInitializeSignatures(
  vaults: readonly DeploymentVault[],
  programId: Address,
  previous: DeploymentRecord | null,
): DeploymentVault[] {
  if (previous === null || previous.programId !== programId) return [...vaults];
  return vaults.map((vault) => {
    if (vault.initializeSignature !== null) return vault;
    const earlier = previous.vaults.find((v) => v.name === vault.name && v.mint === vault.mint && v.vault === vault.vault);
    return earlier === undefined || earlier.initializeSignature === null
      ? vault
      : { ...vault, initializeSignature: earlier.initializeSignature };
  });
}

/** Builds and validates a deployment record (round-trips it through the parser). */
export function buildDeploymentRecord(input: Omit<DeploymentRecord, "schema" | "genesisHash" | "loader">): DeploymentRecord {
  const record: DeploymentRecord = {
    schema: 1,
    genesisHash: GENESIS_HASH[input.cluster],
    loader: BPF_LOADER_UPGRADEABLE_ADDRESS,
    ...input,
  };
  return parseDeploymentRecord(JSON.parse(JSON.stringify(deploymentRecordToJson(record))), input.cluster);
}
