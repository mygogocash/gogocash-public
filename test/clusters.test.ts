import { createHash } from "node:crypto";
import { COMPUTE_BUDGET_PROGRAM_ADDRESS as CB_PKG } from "@solana-program/compute-budget";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS as ATA_PKG,
  TOKEN_PROGRAM_ADDRESS as TOKEN_PKG,
} from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { encodeBase58, isStrictBase58 } from "../src/base58.ts";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  BPF_LOADER_UPGRADEABLE_ADDRESS,
  CAIP2_CHAIN_ID,
  CLUSTERS,
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  GENESIS_HASH,
  genesisHashMatches,
  isCluster,
  programIdFromManifest,
  SYSTEM_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  USDC_MINT,
  USDC_MINT_DECIMALS,
  V0_PLACEHOLDER_PROGRAM_ID,
  WALLET_CHAIN_ID,
} from "../src/clusters.ts";

describe("clusters (contract section 2)", () => {
  it("pins the genesis hashes of section 2.1", () => {
    expect(GENESIS_HASH).toEqual({
      devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
      mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    });
    expect(CLUSTERS).toEqual(["devnet", "mainnet"]);
  });

  it("derives CAIP-2 ids as solana: plus the first 32 genesis characters", () => {
    for (const cluster of CLUSTERS) {
      expect(CAIP2_CHAIN_ID[cluster]).toBe(`solana:${GENESIS_HASH[cluster].slice(0, 32)}`);
    }
    expect(CAIP2_CHAIN_ID.devnet).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    expect(CAIP2_CHAIN_ID.mainnet).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
  });

  it("uses solana:devnet / solana:mainnet as the wallet and SIWS chain id", () => {
    expect(WALLET_CHAIN_ID).toEqual({ devnet: "solana:devnet", mainnet: "solana:mainnet" });
  });

  it("matches genesis hashes exactly and case-sensitively", () => {
    expect(genesisHashMatches("devnet", GENESIS_HASH.devnet)).toBe(true);
    expect(genesisHashMatches("mainnet", GENESIS_HASH.devnet)).toBe(false);
    expect(genesisHashMatches("devnet", GENESIS_HASH.devnet.toLowerCase())).toBe(false);
    expect(genesisHashMatches("devnet", ` ${GENESIS_HASH.devnet}`)).toBe(false);
  });

  it("never matches an unknown cluster or a non-string hash (plain-JS callers)", () => {
    const unknown = "testnet" as unknown as Parameters<typeof genesisHashMatches>[0];
    const missing = undefined as unknown as string;
    expect(genesisHashMatches(unknown, missing)).toBe(false);
    expect(genesisHashMatches(unknown, GENESIS_HASH.devnet)).toBe(false);
    expect(genesisHashMatches("devnet", missing)).toBe(false);
    expect(genesisHashMatches("__proto__" as unknown as Parameters<typeof genesisHashMatches>[0], missing)).toBe(false);
  });

  it("pins the USDC mints of section 2.3", () => {
    expect(USDC_MINT.devnet).toBe("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    expect(USDC_MINT.mainnet).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(USDC_MINT_DECIMALS).toBe(6);
  });

  it("pins the program ids of section 2.2 and agrees with the program packages", () => {
    expect(TOKEN_PROGRAM_ADDRESS).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    expect(ASSOCIATED_TOKEN_PROGRAM_ADDRESS).toBe("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    expect(SYSTEM_PROGRAM_ADDRESS).toBe("11111111111111111111111111111111");
    expect(BPF_LOADER_UPGRADEABLE_ADDRESS).toBe("BPFLoaderUpgradeab1e11111111111111111111111");
    expect(COMPUTE_BUDGET_PROGRAM_ADDRESS).toBe("ComputeBudget111111111111111111111111111111");
    expect(TOKEN_2022_PROGRAM_ADDRESS).toBe("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
    expect(TOKEN_PROGRAM_ADDRESS).toBe(TOKEN_PKG);
    expect(ASSOCIATED_TOKEN_PROGRAM_ADDRESS).toBe(ATA_PKG);
    expect(COMPUTE_BUDGET_PROGRAM_ADDRESS).toBe(CB_PKG);
  });

  it("the v0 placeholder is base58(sha256(the documented preimage))", () => {
    const digest = createHash("sha256").update("gogocash_cashback placeholder program id v0").digest();
    expect(encodeBase58(Uint8Array.from(digest))).toBe(V0_PLACEHOLDER_PROGRAM_ID);
    expect(V0_PLACEHOLDER_PROGRAM_ID).toBe("HWNF2cvXybfAjLbw2pydi7sNFmTfYBjpEWNtY3BJfCje");
  });

  it("every pinned address is strict base58", () => {
    const all = [
      ...Object.values(GENESIS_HASH),
      ...Object.values(USDC_MINT),
      TOKEN_PROGRAM_ADDRESS,
      ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
      SYSTEM_PROGRAM_ADDRESS,
      BPF_LOADER_UPGRADEABLE_ADDRESS,
      COMPUTE_BUDGET_PROGRAM_ADDRESS,
      V0_PLACEHOLDER_PROGRAM_ID,
    ];
    for (const value of all) expect(isStrictBase58(value, 32)).toBe(true);
  });

  it("reads the program id from the manifest; null or missing means unavailable", () => {
    const v0Manifest = { programIds: { devnet: V0_PLACEHOLDER_PROGRAM_ID, mainnet: null } };
    expect(programIdFromManifest(v0Manifest, "devnet")).toBe(V0_PLACEHOLDER_PROGRAM_ID);
    expect(programIdFromManifest(v0Manifest, "mainnet")).toBeNull();
    expect(programIdFromManifest({ programIds: {} }, "devnet")).toBeNull();
    expect(() =>
      programIdFromManifest({ programIds: { devnet: V0_PLACEHOLDER_PROGRAM_ID.toLowerCase() } }, "devnet"),
    ).toThrow(TypeError);
    expect(() =>
      programIdFromManifest({ programIds: { devnet: ` ${V0_PLACEHOLDER_PROGRAM_ID}` } }, "devnet"),
    ).toThrow(TypeError);
  });

  it("recognizes only the two cluster keys", () => {
    expect(isCluster("devnet")).toBe(true);
    expect(isCluster("mainnet")).toBe(true);
    for (const value of ["testnet", "mainnet-beta", "Devnet", "", null, 1]) expect(isCluster(value)).toBe(false);
  });
});
