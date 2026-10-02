/**
 * Cluster identity and well-known addresses, docs/CONTRACT.md section 2.
 *
 * Clients never hardcode an RPC URL. They pin and check the genesis hash, and
 * they take the program id from `release/manifest.json.programIds[cluster]`,
 * never from an IDL or a generated client default (section 2.4).
 */
import { address, type Address } from "@solana/kit";
import { isStrictBase58 } from "./base58.ts";

/** The cluster key used by the contract, the manifest, the API and the DB. */
export type Cluster = "devnet" | "mainnet";

export const CLUSTERS: readonly Cluster[] = ["devnet", "mainnet"];

export function isCluster(value: unknown): value is Cluster {
  return value === "devnet" || value === "mainnet";
}

/** `getGenesisHash` result per cluster (section 2.1). */
export const GENESIS_HASH: Readonly<Record<Cluster, string>> = {
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
};

/**
 * CAIP-2 chain id: `solana:` plus the first 32 characters of the genesis hash.
 * Informational only; no v0 component uses it (section 2.1, D-X1).
 */
export const CAIP2_CHAIN_ID: Readonly<Record<Cluster, string>> = {
  devnet: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  mainnet: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
};

/** Wallet Standard / MWA `chain` and SIWS `Chain ID` (section 2.1, D-C1). */
export const WALLET_CHAIN_ID: Readonly<Record<Cluster, "solana:devnet" | "solana:mainnet">> = {
  devnet: "solana:devnet",
  mainnet: "solana:mainnet",
};

/**
 * True only if `cluster` is a known cluster and the RPC's genesis hash is a
 * string equal to the pinned one. Checked at runtime too, so a plain-JS caller
 * passing an unknown cluster and an `undefined` hash gets `false`, not
 * `undefined === undefined`.
 */
export function genesisHashMatches(cluster: Cluster, observedGenesisHash: string): boolean {
  if (!isCluster(cluster) || typeof observedGenesisHash !== "string") return false;
  return GENESIS_HASH[cluster] === observedGenesisHash;
}

// Section 2.2: token and system programs.
export const TOKEN_PROGRAM_ADDRESS: Address = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ADDRESS: Address = address(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
export const SYSTEM_PROGRAM_ADDRESS: Address = address("11111111111111111111111111111111");
export const BPF_LOADER_UPGRADEABLE_ADDRESS: Address = address(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);
export const COMPUTE_BUDGET_PROGRAM_ADDRESS: Address = address(
  "ComputeBudget111111111111111111111111111111",
);
/** Token-2022. Refused everywhere in v0; listed so callers can reject it. */
export const TOKEN_2022_PROGRAM_ADDRESS: Address = address(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);

/** USDC (classic SPL Token mint, 6 decimals) per cluster (section 2.3). */
export const USDC_MINT: Readonly<Record<Cluster, Address>> = {
  devnet: address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
  mainnet: address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
};

export const USDC_MINT_DECIMALS = 6;

/**
 * The v0 devnet program id: a placeholder with no private key
 * (`base58(sha256("gogocash_cashback placeholder program id v0"))`). It is
 * not deployable, and the rail's executable check always fails on it, so a v0
 * build can never send (section 2.4, SCHED-8). Use it for derivation tests
 * only; production code reads the id from the release manifest.
 */
export const V0_PLACEHOLDER_PROGRAM_ID: Address = address(
  "HWNF2cvXybfAjLbw2pydi7sNFmTfYBjpEWNtY3BJfCje",
);

/** The part of `release/manifest.json` this SDK reads. */
export type ReleaseManifestProgramIds = {
  readonly programIds: Readonly<Partial<Record<Cluster, string | null>>>;
};

/**
 * Returns `manifest.programIds[cluster]` as an address, or `null` when the
 * cluster is unavailable (`null` or missing id, section 2.4). Throws if the
 * value is present but is not a strict base58 32-byte address.
 */
export function programIdFromManifest(
  manifest: ReleaseManifestProgramIds,
  cluster: Cluster,
): Address | null {
  const value = manifest.programIds[cluster];
  if (value === null || value === undefined) return null;
  if (!isStrictBase58(value, 32)) {
    throw new TypeError(`release manifest programIds.${cluster} is not a strict base58 address.`);
  }
  return address(value);
}
