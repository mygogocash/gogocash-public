/**
 * `npm run admin` end to end over a fake chain (no network): the initialize
 * transaction, the mainnet gate, --export-squads, deposit into the vault
 * token account read from chain, the role checks run before signing, show's
 * comparison with deployments/<cluster>.json, and the RPC URL never printed.
 * Key files are throwaway keys written to a temp directory.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { rmSync } from "node:fs";
import { getCompiledTransactionMessageEncoder, type Address } from "@solana/kit";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  GENESIS_HASH,
  SYSTEM_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  USDC_MINT,
} from "../src/clusters.ts";
import { getInitializeInstructionDataDecoder } from "../src/generated/instructions/initialize.ts";
import { getUpdateConfigInstructionDataDecoder } from "../src/generated/instructions/updateConfig.ts";
import { findClassicAta, findProgramDataAddress, findVaultPda } from "../src/program.ts";
import { buildDeploymentRecord, deploymentRecordToJson, releaseManifestToJson, parseReleaseManifest, toJsonText } from "../src/admin/config.ts";
import { buildPauseInstruction } from "../src/admin/instructions.ts";
import { buildAdminTransactionMessage, compiledMessageBytes, decodeExportedMessage } from "../src/admin/transaction.ts";
import { runAdmin } from "../scripts/lib/admin-run.ts";
import {
  FakeChain,
  fakeIo,
  labelAddress,
  mintAccount,
  programAccount,
  programDataAccount,
  sentInstructions,
  tempDir,
  TEST_BLOCKHASH,
  tokenAccount,
  vaultAccount,
  writeKeyFile,
  type CapturedIo,
} from "./admin-helpers.ts";
import { hex, INSTRUCTION_DISCRIMINATORS_HEX, privateKeyFromSeed } from "./vectors.ts";
import { createNoopSigner } from "@solana/kit";

const dir = tempDir();
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const keys = {
  deployer: writeKeyFile(dir, "deployer"),
  admin: writeKeyFile(dir, "admin"),
  guardian: writeKeyFile(dir, "guardian"),
  stranger: writeKeyFile(dir, "stranger"),
  depositor: writeKeyFile(dir, "depositor"),
  claim: writeKeyFile(dir, "claim authority"),
};
const PROGRAM = labelAddress("test program");
const MINT = USDC_MINT.devnet;
const RPC_URL = "https://secret-rpc.example.invalid/v2/api-key-AbCdEf0123456789";

type World = {
  chain: FakeChain;
  files: Record<string, string>;
  vault: Address;
  vaultBump: number;
  vaultAta: Address;
  programData: Address;
};

let world: World;

function vaultConfigText(overrides: Record<string, unknown> = {}): string {
  return toJsonText({
    schema: 1,
    cluster: "devnet",
    vaults: [
      {
        name: "usdc",
        enabled: true,
        mint: MINT,
        admin: keys.admin.address,
        guardian: keys.guardian.address,
        claimAuthority: keys.claim.address,
        maxPerClaim: "5000000",
        maxPerDay: "20000000",
        ...overrides,
      },
    ],
  });
}

function manifestText(programIds: { devnet: string | null; mainnet: string | null } = { devnet: PROGRAM, mainnet: null }): string {
  return toJsonText(
    releaseManifestToJson(parseReleaseManifest({ schema: 1, contract: "v0", programIds, deployments: { devnet: null, mainnet: null } })),
  );
}

function deploymentText(w: { vault: Address; vaultBump: number; vaultAta: Address; programData: Address }, overrides: Record<string, unknown> = {}): string {
  const record = buildDeploymentRecord({
    cluster: "devnet",
    programId: PROGRAM,
    programDataAddress: w.programData,
    upgradeAuthority: keys.deployer.address,
    deploySlot: 1000n,
    programHash: "ab".repeat(32),
    soSha256: "cd".repeat(32),
    source: { repository: "mygogocash/gogocash-public", commit: "e".repeat(40), tag: "v0.1.0" },
    vaults: [
      {
        name: "usdc",
        mint: MINT,
        vault: w.vault,
        vaultBump: w.vaultBump,
        vaultTokenAccount: w.vaultAta,
        admin: keys.admin.address,
        guardian: keys.guardian.address,
        claimAuthority: keys.claim.address,
        maxPerClaim: 5_000_000n,
        maxPerDay: 20_000_000n,
        initializeSignature: null,
        ...overrides,
      },
    ],
  });
  return toJsonText(deploymentRecordToJson(record));
}

function liveVault(overrides: Partial<Parameters<typeof vaultAccount>[1]> = {}) {
  return vaultAccount(PROGRAM, {
    bump: world.vaultBump,
    paused: true,
    mint: MINT,
    vaultTokenAccount: world.vaultAta,
    admin: keys.admin.address,
    guardian: keys.guardian.address,
    claimAuthority: keys.claim.address,
    maxPerClaim: 5_000_000n,
    maxPerDay: 20_000_000n,
    ...overrides,
  });
}

beforeEach(async () => {
  const pda = await findVaultPda({ programAddress: PROGRAM, mint: MINT });
  const vaultAta = await findClassicAta({ owner: pda.address, mint: MINT });
  const programData = (await findProgramDataAddress(PROGRAM)).address;
  const chain = new FakeChain();
  chain.setAccount(PROGRAM, programAccount(programData));
  chain.setAccount(programData, programDataAccount(1000n, keys.deployer.address));
  chain.setAccount(MINT, mintAccount(6));
  world = { chain, files: {}, vault: pda.address, vaultBump: pda.bump, vaultAta, programData };
  world.files = {
    "/repo/release/manifest.json": manifestText(),
    "/repo/deploy/vaults.devnet.json": vaultConfigText(),
    "/repo/deployments/devnet.json": deploymentText(world),
  };
});

async function run(argv: string[], io?: CapturedIo): Promise<{ code: number; io: CapturedIo }> {
  const captured = io ?? fakeIo({ chain: world.chain, files: world.files, env: { SOLANA_RPC_URL: RPC_URL } });
  const code = await runAdmin(argv, captured);
  return { code, io: captured };
}

function stdoutJson(io: CapturedIo): Record<string, unknown> {
  return JSON.parse(io.out.join("")) as Record<string, unknown>;
}

function publicKeyOf(label: string) {
  const seed = createHash("sha256").update(`gogocash-public throwaway test key: ${label}`).digest();
  return createPublicKey(privateKeyFromSeed(seed));
}

/** Creates the vault account when an initialize transaction lands, like the program would. */
function landInitialize(): void {
  world.chain.onSend = (tx) => {
    const ixs = sentInstructions(tx);
    const init = ixs.find((ix) => ix.programAddress === PROGRAM);
    if (init === undefined) return;
    const args = getInitializeInstructionDataDecoder().decode(init.data);
    world.chain.setAccount(world.vaultAta, tokenAccount({ mint: MINT, owner: world.vault, amount: 0n }));
    world.chain.setAccount(
      world.vault,
      liveVault({ admin: args.admin, guardian: args.guardian, claimAuthority: args.claimAuthority, maxPerClaim: args.maxPerClaim, maxPerDay: args.maxPerDay }),
    );
  };
}

describe("initialize", () => {
  it("sends ONE transaction with exactly [createAssociatedTokenIdempotent, initialize], signed by the upgrade authority", async () => {
    landInitialize();
    const { code, io } = await run(["initialize", "--cluster", "devnet", "--keypair", keys.deployer.path, "--record", "/out/vaults.json"]);
    expect(io.err.join("")).not.toMatch(/admin: /);
    expect(code).toBe(0);
    expect(world.chain.sent).toHaveLength(1);
    const tx = world.chain.sent[0]!;
    const ixs = sentInstructions(tx);
    expect(ixs.map((ix) => ix.programAddress)).toEqual([ASSOCIATED_TOKEN_PROGRAM_ADDRESS, PROGRAM]);
    expect(ixs[0]!.data).toEqual(Uint8Array.of(1));
    expect(ixs[0]!.accounts).toEqual([keys.deployer.address, world.vaultAta, world.vault, MINT, SYSTEM_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS]);
    expect(ixs[1]!.accounts).toEqual([
      world.vault,
      MINT,
      world.vaultAta,
      world.programData,
      keys.deployer.address,
      keys.deployer.address,
      TOKEN_PROGRAM_ADDRESS,
      SYSTEM_PROGRAM_ADDRESS,
    ]);
    expect(hex(ixs[1]!.data).slice(0, 16)).toBe(INSTRUCTION_DISCRIMINATORS_HEX.initialize);
    const args = getInitializeInstructionDataDecoder().decode(ixs[1]!.data);
    expect(args).toMatchObject({
      admin: keys.admin.address,
      guardian: keys.guardian.address,
      claimAuthority: keys.claim.address,
      maxPerClaim: 5_000_000n,
      maxPerDay: 20_000_000n,
    });
    // The upgrade authority is the only signer and the fee payer; its signature verifies.
    expect(Object.keys(tx.signatures)).toEqual([keys.deployer.address]);
    const signature = tx.signatures[keys.deployer.address as Address];
    expect(signature).toBeTruthy();
    expect(verify(null, tx.messageBytes, publicKeyOf("deployer"), signature!)).toBe(true);
    if (tx.message.version !== 0) throw new Error("v0 expected");
    expect(tx.message.lifetimeToken).toBe(TEST_BLOCKHASH);

    const record = JSON.parse(io.files.get("/out/vaults.json")!) as Record<string, unknown>[];
    expect(record).toEqual([
      expect.objectContaining({ name: "usdc", vault: world.vault, vaultBump: world.vaultBump, vaultTokenAccount: world.vaultAta, initializeSignature: tx.signature }),
    ]);
    expect(stdoutJson(io)).toMatchObject({ command: "initialize", cluster: "devnet", programId: PROGRAM });
    expect(world.chain.reads.every((r) => r.commitment === "finalized")).toBe(true);
  });

  it("--check-only validates the config and never opens the RPC or a key", async () => {
    const io = fakeIo({
      chain: world.chain,
      files: world.files,
      createRpc: () => {
        throw new Error("the RPC must not be opened");
      },
    });
    const { code } = await run(["initialize", "--cluster", "devnet", "--check-only"], io);
    expect(io.err.join("")).toBe("");
    expect(code).toBe(0);
    expect(stdoutJson(io)).toMatchObject({ checkOnly: true, vaults: [{ name: "usdc", vault: world.vault, vaultTokenAccount: world.vaultAta }] });
  });

  it("refuses before sending: claim key = upgrade authority, a signer that is not the upgrade authority, an existing vault", async () => {
    world.files["/repo/deploy/vaults.devnet.json"] = vaultConfigText({ claimAuthority: keys.deployer.address });
    let result = await run(["initialize", "--cluster", "devnet", "--keypair", keys.deployer.path]);
    expect(result.code).toBe(2);
    expect(result.io.err.join("")).toMatch(/must not be the upgrade authority/);

    world.files["/repo/deploy/vaults.devnet.json"] = vaultConfigText();
    result = await run(["initialize", "--cluster", "devnet", "--keypair", keys.stranger.path]);
    expect(result.code).toBe(2);
    expect(result.io.err.join("")).toMatch(/6005/);

    world.chain.setAccount(world.vault, liveVault());
    result = await run(["initialize", "--cluster", "devnet", "--keypair", keys.deployer.path]);
    expect(result.code).toBe(2);
    expect(result.io.err.join("")).toMatch(/already exists/);
    expect(world.chain.sent).toHaveLength(0);
  });

  it("--skip-existing keeps a matching vault and refuses a drifted one", async () => {
    world.chain.setAccount(world.vault, liveVault());
    let result = await run(["initialize", "--cluster", "devnet", "--keypair", keys.deployer.path, "--skip-existing", "--record", "/out/v.json"]);
    expect(result.code).toBe(0);
    expect(world.chain.sent).toHaveLength(0);
    expect(JSON.parse(result.io.files.get("/out/v.json")!)).toEqual([expect.objectContaining({ name: "usdc", initializeSignature: null })]);

    world.chain.setAccount(world.vault, liveVault({ maxPerDay: 9_000_000n }));
    result = await run(["initialize", "--cluster", "devnet", "--keypair", keys.deployer.path, "--skip-existing"]);
    expect(result.code).toBe(2);
    expect(result.io.err.join("")).toMatch(/maxPerDay expected 20000000, onchain 9000000/);
  });

  it("refuses a mint without 6 decimals and an immutable program", async () => {
    world.chain.setAccount(MINT, mintAccount(9));
    let result = await run(["initialize", "--cluster", "devnet", "--keypair", keys.deployer.path]);
    expect(result.code).toBe(2);
    expect(result.io.err.join("")).toMatch(/6 decimals/);
    world.chain.setAccount(MINT, mintAccount(6));
    world.chain.setAccount(world.programData, programDataAccount(1000n, null));
    result = await run(["initialize", "--cluster", "devnet", "--keypair", keys.deployer.path]);
    expect(result.code).toBe(2);
    expect(result.io.err.join("")).toMatch(/immutable/);
  });
});

describe("cluster and program gates", () => {
  it("mainnet is refused without --i-understand-mainnet, before any RPC or key", async () => {
    const io = fakeIo({ chain: world.chain, files: world.files, createRpc: () => { throw new Error("no RPC"); } });
    const { code } = await run(["show", "--cluster", "mainnet"], io);
    expect(code).toBe(2);
    expect(io.err.join("")).toMatch(/--i-understand-mainnet/);
  });

  it("mainnet with the flag is still refused while the manifest has no mainnet program id (v0)", async () => {
    const io = fakeIo({ chain: world.chain, files: world.files, createRpc: () => { throw new Error("no RPC"); } });
    const { code } = await run(["pause", "--cluster", "mainnet", "--i-understand-mainnet", "--vault", "usdc", "--keypair", keys.admin.path], io);
    expect(code).toBe(2);
    expect(io.err.join("")).toMatch(/no mainnet program id/);
  });

  it("with both the flag and a manifest id, mainnet proceeds to the genesis check (which a devnet RPC fails)", async () => {
    world.files["/repo/release/manifest.json"] = manifestText({ devnet: PROGRAM, mainnet: PROGRAM });
    const { code, io } = await run(["show", "--cluster", "mainnet", "--i-understand-mainnet", "--mint", MINT]);
    expect(code).toBe(2);
    expect(io.err.join("")).toMatch(/genesis hash/);
  });

  it("the committed v0 manifest (placeholder program id) is refused", async () => {
    world.files["/repo/release/manifest.json"] = manifestText({ devnet: "HWNF2cvXybfAjLbw2pydi7sNFmTfYBjpEWNtY3BJfCje", mainnet: null });
    const { code, io } = await run(["show", "--cluster", "devnet"]);
    expect(code).toBe(2);
    expect(io.err.join("")).toMatch(/placeholder/);
  });

  it("a wrong-cluster RPC and a non-executable program are refused", async () => {
    world.chain.genesisHash = GENESIS_HASH.mainnet;
    let result = await run(["show", "--cluster", "devnet"]);
    expect(result.code).toBe(2);
    expect(result.io.err.join("")).toMatch(/not devnet/);
    world.chain.genesisHash = GENESIS_HASH.devnet;
    world.chain.setAccount(PROGRAM, { ...programAccount(world.programData), executable: false });
    result = await run(["show", "--cluster", "devnet"]);
    expect(result.code).toBe(2);
    expect(result.io.err.join("")).toMatch(/not executable/);
  });
});

describe("--export-squads", () => {
  it("prints only the base58 message, signs and sends nothing, and the message decodes back", async () => {
    world.chain.setAccount(world.vault, liveVault());
    const { code, io } = await run(["pause", "--cluster", "devnet", "--vault", "usdc", "--export-squads", "--authority", keys.admin.address]);
    expect(code).toBe(0);
    expect(world.chain.sent).toHaveLength(0);
    expect(io.out).toHaveLength(1);
    const line = io.out[0]!;
    expect(line).toMatch(/^[1-9A-HJ-NP-Za-km-z]+\n$/);
    const decoded = decodeExportedMessage(line.trim());
    // The same message, built independently, has the same bytes.
    const expected = buildAdminTransactionMessage({
      feePayer: createNoopSigner(keys.admin.address),
      instructions: [buildPauseInstruction({ programAddress: PROGRAM, vault: world.vault, authority: createNoopSigner(keys.admin.address) })],
      lifetime: { blockhash: TEST_BLOCKHASH, lastValidBlockHeight: 1000n },
    });
    expect(Uint8Array.from(getCompiledTransactionMessageEncoder().encode(decoded))).toEqual(compiledMessageBytes(expected));
    if (decoded.version !== 0) throw new Error("v0 expected");
    expect(decoded.staticAccounts[0]).toBe(keys.admin.address);
    expect(decoded.staticAccounts[decoded.instructions[0]!.programAddressIndex]).toBe(PROGRAM);
  });

  it("refuses a key file in export mode, and an authority with the shape of a secret key", async () => {
    world.chain.setAccount(world.vault, liveVault());
    let result = await run(["pause", "--cluster", "devnet", "--vault", "usdc", "--export-squads", "--authority", keys.admin.address, "--keypair", keys.admin.path]);
    expect(result.code).toBe(2);
    expect(result.io.err.join("")).toMatch(/signs nothing/);
    const secretShaped = "5".repeat(87);
    result = await run(["pause", "--cluster", "devnet", "--vault", "usdc", "--export-squads", "--authority", secretShaped]);
    expect(result.code).toBe(2);
    expect(result.io.err.join("")).not.toContain(secretShaped);
  });
});

describe("deposit", () => {
  it("transfers into vault.vault_token_account as read from chain, never a derived or typed address", async () => {
    // The onchain vault names a non-canonical token account the vault owns:
    // the deposit must go there, proving the destination comes from chain.
    const onchainVta = labelAddress("onchain vault token account");
    world.chain.setAccount(world.vault, liveVault({ vaultTokenAccount: onchainVta }));
    world.chain.setAccount(onchainVta, tokenAccount({ mint: MINT, owner: world.vault, amount: 0n }));
    const source = await findClassicAta({ owner: keys.depositor.address, mint: MINT });
    world.chain.setAccount(source, tokenAccount({ mint: MINT, owner: keys.depositor.address, amount: 25_000_000n }));
    const { code, io } = await run(["deposit", "--cluster", "devnet", "--vault", "usdc", "--amount", "20000000", "--keypair", keys.depositor.path]);
    expect(io.err.join("")).not.toMatch(/admin: /);
    expect(code).toBe(0);
    const ixs = sentInstructions(world.chain.sent[0]!);
    expect(ixs).toHaveLength(1);
    expect(ixs[0]!.programAddress).toBe(TOKEN_PROGRAM_ADDRESS);
    expect(ixs[0]!.accounts).toEqual([source, MINT, onchainVta, keys.depositor.address]);
    expect(hex(ixs[0]!.data)).toBe("0c002d31010000000006");
    expect(stdoutJson(io)).toMatchObject({ destination: onchainVta, amountAtomic: "20000000" });
  });

  it("refuses a vault token account not owned by the vault, and an amount above the source balance", async () => {
    world.chain.setAccount(world.vault, liveVault());
    world.chain.setAccount(world.vaultAta, tokenAccount({ mint: MINT, owner: keys.stranger.address, amount: 0n }));
    const source = await findClassicAta({ owner: keys.depositor.address, mint: MINT });
    world.chain.setAccount(source, tokenAccount({ mint: MINT, owner: keys.depositor.address, amount: 1_000_000n }));
    let result = await run(["deposit", "--cluster", "devnet", "--vault", "usdc", "--amount", "1000000", "--keypair", keys.depositor.path]);
    expect(result.code).toBe(2);
    expect(result.io.err.join("")).toMatch(/not owned by the vault/);
    world.chain.setAccount(world.vaultAta, tokenAccount({ mint: MINT, owner: world.vault, amount: 0n }));
    result = await run(["deposit", "--cluster", "devnet", "--vault", "usdc", "--amount", "2000000", "--keypair", keys.depositor.path]);
    expect(result.code).toBe(2);
    expect(result.io.err.join("")).toMatch(/source balance/);
    result = await run(["deposit", "--cluster", "devnet", "--vault", "usdc", "--amount", "1.5", "--keypair", keys.depositor.path]);
    expect(result.code).toBe(2);
    expect(world.chain.sent).toHaveLength(0);
  });
});

describe("role checks run before signing", () => {
  beforeEach(() => {
    world.chain.setAccount(world.vault, liveVault());
    world.chain.setAccount(world.vaultAta, tokenAccount({ mint: MINT, owner: world.vault, amount: 20_000_000n }));
  });

  it("pause: the guardian may, a stranger may not (6003)", async () => {
    let result = await run(["pause", "--cluster", "devnet", "--vault", "usdc", "--keypair", keys.stranger.path]);
    expect(result.code).toBe(2);
    expect(result.io.err.join("")).toMatch(/6003/);
    result = await run(["pause", "--cluster", "devnet", "--vault", "usdc", "--keypair", keys.guardian.path]);
    expect(result.code).toBe(0);
    expect(sentInstructions(world.chain.sent[0]!)[0]!.accounts).toEqual([world.vault, keys.guardian.address]);
  });

  it("unpause: admin only, and only a verified, funded vault", async () => {
    let result = await run(["unpause", "--cluster", "devnet", "--vault", "usdc", "--keypair", keys.guardian.path]);
    expect(result.code).toBe(2);
    expect(result.io.err.join("")).toMatch(/6002/);
    world.chain.setAccount(world.vaultAta, tokenAccount({ mint: MINT, owner: world.vault, amount: 0n }));
    result = await run(["unpause", "--cluster", "devnet", "--vault", "usdc", "--keypair", keys.admin.path]);
    expect(result.code).toBe(2);
    expect(result.io.err.join("")).toMatch(/deposit before unpausing/);
    world.chain.setAccount(world.vaultAta, tokenAccount({ mint: MINT, owner: world.vault, amount: 1n }));
    world.files["/repo/deployments/devnet.json"] = deploymentText(world, { maxPerDay: 10_000_000n });
    result = await run(["unpause", "--cluster", "devnet", "--vault", "usdc", "--keypair", keys.admin.path]);
    expect(result.code).toBe(2);
    expect(result.io.err.join("")).toMatch(/differs from deployments/);
    world.files["/repo/deployments/devnet.json"] = deploymentText(world);
    result = await run(["unpause", "--cluster", "devnet", "--vault", "usdc", "--keypair", keys.admin.path]);
    expect(result.code).toBe(0);
    expect(hex(sentInstructions(world.chain.sent[0]!)[0]!.data)).toBe(INSTRUCTION_DISCRIMINATORS_HEX.unpause);
  });

  it("update_config: merges the onchain values and refuses conflicts and bad caps", async () => {
    let result = await run(["update_config", "--cluster", "devnet", "--vault", "usdc", "--keypair", keys.admin.path, "--claim-authority", keys.admin.address]);
    expect(result.code).toBe(2);
    expect(result.io.err.join("")).toMatch(/6020/);
    result = await run(["update_config", "--cluster", "devnet", "--vault", "usdc", "--keypair", keys.admin.path, "--max-per-claim", "30000000"]);
    expect(result.code).toBe(2);
    expect(result.io.err.join("")).toMatch(/6021/);
    result = await run(["update_config", "--cluster", "devnet", "--vault", "usdc", "--keypair", keys.admin.path, "--claim-authority", keys.deployer.address]);
    expect(result.code).toBe(2);
    expect(result.io.err.join("")).toMatch(/upgrade authority/);
    result = await run(["update_config", "--cluster", "devnet", "--vault", "usdc", "--keypair", keys.admin.path, "--max-per-day", "10000000"]);
    expect(result.code).toBe(0);
    const ix = sentInstructions(world.chain.sent[0]!)[0]!;
    expect(getUpdateConfigInstructionDataDecoder().decode(ix.data)).toMatchObject({
      guardian: keys.guardian.address,
      claimAuthority: keys.claim.address,
      maxPerClaim: 5_000_000n,
      maxPerDay: 10_000_000n,
    });
  });

  it("propose_admin / accept_admin: only the pending admin accepts", async () => {
    let result = await run(["propose_admin", "--cluster", "devnet", "--vault", "usdc", "--keypair", keys.admin.path, "--new-admin", keys.claim.address]);
    expect(result.code).toBe(2);
    expect(result.io.err.join("")).toMatch(/6020/);
    result = await run(["propose_admin", "--cluster", "devnet", "--vault", "usdc", "--keypair", keys.admin.path, "--new-admin", keys.stranger.address]);
    expect(result.code).toBe(0);
    world.chain.setAccount(world.vault, liveVault({ pendingAdmin: keys.stranger.address }));
    result = await run(["accept_admin", "--cluster", "devnet", "--vault", "usdc", "--keypair", keys.guardian.path]);
    expect(result.code).toBe(2);
    expect(result.io.err.join("")).toMatch(/6004/);
    result = await run(["accept_admin", "--cluster", "devnet", "--vault", "usdc", "--keypair", keys.stranger.path]);
    expect(result.code).toBe(0);
    expect(sentInstructions(world.chain.sent[1]!)[0]!.accounts).toEqual([world.vault, keys.stranger.address]);
    result = await run(["propose_admin", "--cluster", "devnet", "--vault", "usdc", "--keypair", keys.admin.path, "--cancel", "--new-admin", keys.stranger.address]);
    expect(result.code).toBe(2);
  });

  it("withdraw: creates the admin's ATA when missing, and refuses more than the vault holds", async () => {
    let result = await run(["withdraw", "--cluster", "devnet", "--vault", "usdc", "--keypair", keys.admin.path, "--amount", "30000000"]);
    expect(result.code).toBe(2);
    expect(result.io.err.join("")).toMatch(/6016/);
    result = await run(["withdraw", "--cluster", "devnet", "--vault", "usdc", "--keypair", keys.admin.path, "--amount", "1000000"]);
    expect(result.code).toBe(0);
    const ixs = sentInstructions(world.chain.sent[0]!);
    const adminAta = await findClassicAta({ owner: keys.admin.address, mint: MINT });
    expect(ixs.map((ix) => ix.programAddress)).toEqual([ASSOCIATED_TOKEN_PROGRAM_ADDRESS, PROGRAM]);
    expect(ixs[1]!.accounts).toEqual([world.vault, keys.admin.address, MINT, world.vaultAta, adminAta, TOKEN_PROGRAM_ADDRESS]);
  });

  it("refuses a key file readable by others", async () => {
    const loose = writeKeyFile(dir, "loose admin", 0o644);
    const result = await run(["pause", "--cluster", "devnet", "--vault", "usdc", "--keypair", loose.path]);
    expect(result.code).toBe(2);
    expect(result.io.err.join("")).toMatch(/chmod 600/);
  });
});

describe("show", () => {
  it("matches deployments/devnet.json (exit 0) and reports drift (exit 1)", async () => {
    world.chain.setAccount(world.vault, liveVault());
    world.chain.setAccount(world.vaultAta, tokenAccount({ mint: MINT, owner: world.vault, amount: 7n }));
    let result = await run(["show", "--cluster", "devnet"]);
    expect(result.code).toBe(0);
    expect(stdoutJson(result.io)).toMatchObject({ driftCount: 0, vaults: [{ name: "usdc", paused: true, vaultBalanceAtomic: "7", drift: [] }] });

    world.chain.setAccount(world.vault, liveVault({ guardian: keys.stranger.address }));
    result = await run(["show", "--cluster", "devnet"]);
    expect(result.code).toBe(1);
    expect(stdoutJson(result.io)).toMatchObject({
      driftCount: 1,
      vaults: [{ drift: [{ field: "guardian", expected: keys.guardian.address, actual: keys.stranger.address }] }],
    });

    world.chain.setAccount(world.programData, programDataAccount(1000n, keys.stranger.address));
    world.chain.setAccount(world.vault, liveVault());
    result = await run(["show", "--cluster", "devnet"]);
    expect(result.code).toBe(1);
    expect(stdoutJson(result.io)).toMatchObject({ program: { drift: [{ field: "upgradeAuthority" }] } });
  });
});

describe("the RPC URL is never printed", () => {
  it("not in errors that quote it, nor in normal output", async () => {
    const url = new URL(RPC_URL);
    const leaky = new FakeChain();
    leaky.getGenesisHash = async () => {
      throw new Error(`fetch failed: getaddrinfo ENOTFOUND ${url.hostname} while calling ${RPC_URL}`);
    };
    const io = fakeIo({ chain: leaky, files: world.files, env: { SOLANA_RPC_URL: RPC_URL } });
    const { code } = await run(["show", "--cluster", "devnet"], io);
    expect(code).toBe(1);
    const printed = io.err.join("") + io.out.join("");
    expect(printed).toMatch(/ENOTFOUND <rpc-url>/);
    for (const secret of [RPC_URL, url.hostname, "api-key-AbCdEf0123456789"]) expect(printed).not.toContain(secret);

    world.chain.setAccount(world.vault, liveVault());
    const flagged = await run(["show", "--cluster", "devnet", "--rpc-url", RPC_URL], fakeIo({ chain: world.chain, files: world.files, env: {} }));
    expect(flagged.code).toBe(0);
    const all = flagged.io.err.join("") + flagged.io.out.join("");
    expect(all).not.toContain(url.hostname);
  });

  it("a missing RPC URL is a usage error", async () => {
    const io = fakeIo({ chain: world.chain, files: world.files, env: {} });
    const { code } = await run(["show", "--cluster", "devnet"], io);
    expect(code).toBe(2);
    expect(io.err.join("")).toMatch(/SOLANA_RPC_URL/);
  });
});

describe("argument handling", () => {
  it("never echoes an unexpected value, and refuses a key-shaped path", async () => {
    const pasted = `[${Array.from({ length: 64 }, (_, i) => i).join(",")}]`;
    let result = await run(["pause", "--cluster", "devnet", "--vault", "usdc", pasted]);
    expect(result.code).toBe(2);
    expect(result.io.err.join("")).not.toContain(pasted);
    result = await run(["pause", "--cluster", "devnet", "--vault", "usdc", "--keypair", pasted]);
    expect(result.code).toBe(2);
    expect(result.io.err.join("")).toMatch(/shape of key text/);
    expect(result.io.err.join("")).not.toContain(pasted);
    result = await run(["frobnicate"]);
    expect(result.code).toBe(2);
    expect(result.io.err.join("")).toMatch(/unknown command frobnicate/);
  });
});
