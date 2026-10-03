/**
 * The operator CLI's pure instruction builders against the IDL and
 * docs/CONTRACT.md section 3.3: account order, signer and writable flags,
 * discriminators and argument bytes, and the explicit program address.
 */
import {
  createNoopSigner,
  getAddressEncoder,
  getCompiledTransactionMessageEncoder,
  isSignerRole,
  isWritableRole,
  type Address,
  type Instruction,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  USDC_MINT,
  V0_PLACEHOLDER_PROGRAM_ID,
} from "../src/clusters.ts";
import { GOGOCASH_CASHBACK_PROGRAM_ADDRESS } from "../src/generated/programs/gogocashCashback.ts";
import { findClassicAta } from "../src/program.ts";
import {
  AdminInstructionError,
  buildAcceptAdminInstruction,
  buildDepositInstruction,
  buildInitializeInstructions,
  buildPauseInstruction,
  buildProposeAdminInstruction,
  buildUnpauseInstruction,
  buildUpdateConfigInstruction,
  buildWithdrawInstructions,
} from "../src/admin/instructions.ts";
import { buildAdminTransactionMessage, compiledMessageBytes, decodeExportedMessage, exportSquadsMessage } from "../src/admin/transaction.ts";
import { labelAddress, TEST_BLOCKHASH } from "./admin-helpers.ts";
import { IDL } from "./tx-helpers.ts";
import { hex, INSTRUCTION_DISCRIMINATORS_HEX, PDA_VECTORS, PROGRAM_DATA } from "./vectors.ts";

const ADMIN = labelAddress("admin");
const GUARDIAN = labelAddress("guardian");
const CLAIM = labelAddress("claim authority");
const DEPLOYER = labelAddress("deployer");
const OTHER_PROGRAM = labelAddress("another program id");
const VAULT = PDA_VECTORS.devnet.vault.address as Address;
const VAULT_ATA = PDA_VECTORS.devnet.vaultAta as Address;
const MINT = USDC_MINT.devnet;
const signer = (a: Address) => createNoopSigner(a);
const enc = getAddressEncoder();

function u64(value: bigint): string {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return hex(bytes);
}

/** Compares an instruction with the IDL entry: names, order, signer and writable flags, fixed addresses. */
function expectMatchesIdl(instruction: Instruction, name: string, addresses: readonly string[]): void {
  const idl = IDL.instructions.find((ix) => ix.name === name);
  expect(idl, name).toBeDefined();
  const metas = instruction.accounts ?? [];
  expect(metas.map((m) => m.address)).toEqual(addresses);
  expect(metas.length).toBe(idl?.accounts.length);
  idl?.accounts.forEach((account, index) => {
    const meta = metas[index]!;
    expect({ name: account.name, signer: isSignerRole(meta.role), writable: isWritableRole(meta.role) }).toEqual({
      name: account.name,
      signer: account.signer === true,
      writable: account.writable === true,
    });
    if (account.address !== undefined) expect(meta.address).toBe(account.address);
  });
  expect(hex(Uint8Array.from(instruction.data ?? [])).slice(0, 16)).toBe(
    INSTRUCTION_DISCRIMINATORS_HEX[name as keyof typeof INSTRUCTION_DISCRIMINATORS_HEX],
  );
}

describe("initialize (section 3.3.1): exactly [createAssociatedTokenIdempotent, initialize]", () => {
  const input = {
    programAddress: V0_PLACEHOLDER_PROGRAM_ID,
    mint: MINT,
    upgradeAuthority: signer(DEPLOYER),
    payer: signer(DEPLOYER),
    admin: ADMIN,
    guardian: GUARDIAN,
    claimAuthority: CLAIM,
    maxPerClaim: 5_000_000n,
    maxPerDay: 20_000_000n,
  };

  it("returns the two instructions in order, on the contract's PDA vectors", async () => {
    const built = await buildInitializeInstructions(input);
    expect(built.instructions).toHaveLength(2);
    const [ata, initialize] = built.instructions;
    expect(built.vault).toEqual(PDA_VECTORS.devnet.vault);
    expect(built.vaultTokenAccount).toBe(VAULT_ATA);
    expect(built.programData).toBe(PROGRAM_DATA.address);

    // createAssociatedTokenIdempotent(payer, ata(vault, mint), vault, mint, system, classic Token).
    expect(ata.programAddress).toBe(ASSOCIATED_TOKEN_PROGRAM_ADDRESS);
    expect(Array.from(ata.data ?? [])).toEqual([1]);
    expect(ata.accounts?.map((m) => [m.address, isSignerRole(m.role), isWritableRole(m.role)])).toEqual([
      [DEPLOYER, true, true],
      [VAULT_ATA, false, true],
      [VAULT, false, false],
      [MINT, false, false],
      [SYSTEM_PROGRAM_ADDRESS, false, false],
      [TOKEN_PROGRAM_ADDRESS, false, false],
    ]);

    expect(initialize.programAddress).toBe(V0_PLACEHOLDER_PROGRAM_ID);
    expectMatchesIdl(initialize, "initialize", [
      VAULT,
      MINT,
      VAULT_ATA,
      PROGRAM_DATA.address,
      DEPLOYER,
      DEPLOYER,
      TOKEN_PROGRAM_ADDRESS,
      SYSTEM_PROGRAM_ADDRESS,
    ]);
    const data = Uint8Array.from(initialize.data ?? []);
    expect(data.length).toBe(120);
    expect(hex(data)).toBe(
      INSTRUCTION_DISCRIMINATORS_HEX.initialize +
        hex(Uint8Array.from(enc.encode(ADMIN))) +
        hex(Uint8Array.from(enc.encode(GUARDIAN))) +
        hex(Uint8Array.from(enc.encode(CLAIM))) +
        u64(5_000_000n) +
        u64(20_000_000n),
    );
  });

  it("uses the explicit program address, never the IDL default", async () => {
    expect(OTHER_PROGRAM).not.toBe(GOGOCASH_CASHBACK_PROGRAM_ADDRESS);
    const built = await buildInitializeInstructions({ ...input, programAddress: OTHER_PROGRAM });
    expect(built.instructions[1].programAddress).toBe(OTHER_PROGRAM);
    expect(built.vault.address).not.toBe(VAULT);
    expect(built.instructions[1].accounts?.[0]?.address).toBe(built.vault.address);
  });

  it("refuses what the program or the contract would refuse, before signing", async () => {
    const cases: [Partial<typeof input>, RegExp][] = [
      [{ claimAuthority: DEPLOYER }, /upgrade authority/],
      [{ claimAuthority: ADMIN }, /6020/],
      [{ claimAuthority: GUARDIAN }, /6020/],
      [{ admin: SYSTEM_PROGRAM_ADDRESS }, /6007/],
      [{ maxPerClaim: 0n }, /maxPerClaim/],
      [{ maxPerClaim: 30_000_000n }, /6021/],
      [{ maxPerDay: 1n << 64n }, /maxPerDay/],
    ];
    for (const [patch, message] of cases) {
      await expect(buildInitializeInstructions({ ...input, ...patch })).rejects.toThrow(message);
      await expect(buildInitializeInstructions({ ...input, ...patch })).rejects.toBeInstanceOf(AdminInstructionError);
    }
  });
});

describe("pause, unpause, update_config, propose_admin, accept_admin (sections 3.3.3 to 3.3.7)", () => {
  const target = { programAddress: OTHER_PROGRAM, vault: VAULT };

  it("pause: [vault (w), authority (s)], data = discriminator only", () => {
    const ix = buildPauseInstruction({ ...target, authority: signer(GUARDIAN) });
    expect(ix.programAddress).toBe(OTHER_PROGRAM);
    expectMatchesIdl(ix, "pause", [VAULT, GUARDIAN]);
    expect(ix.data?.length).toBe(8);
  });

  it("unpause: [vault (w), admin (s)]", () => {
    const ix = buildUnpauseInstruction({ ...target, admin: signer(ADMIN) });
    expect(ix.programAddress).toBe(OTHER_PROGRAM);
    expectMatchesIdl(ix, "unpause", [VAULT, ADMIN]);
    expect(ix.data?.length).toBe(8);
  });

  it("update_config: 88 bytes of discriminator, guardian, claim authority and caps", () => {
    const ix = buildUpdateConfigInstruction({
      ...target,
      admin: signer(ADMIN),
      guardian: GUARDIAN,
      claimAuthority: CLAIM,
      maxPerClaim: 1_000_000n,
      maxPerDay: 2_000_000n,
    });
    expectMatchesIdl(ix, "update_config", [VAULT, ADMIN]);
    expect(hex(Uint8Array.from(ix.data ?? []))).toBe(
      INSTRUCTION_DISCRIMINATORS_HEX.update_config +
        hex(Uint8Array.from(enc.encode(GUARDIAN))) +
        hex(Uint8Array.from(enc.encode(CLAIM))) +
        u64(1_000_000n) +
        u64(2_000_000n),
    );
    expect(() =>
      buildUpdateConfigInstruction({ ...target, admin: signer(ADMIN), guardian: GUARDIAN, claimAuthority: ADMIN, maxPerClaim: 1n, maxPerDay: 1n }),
    ).toThrow(/6020/);
    expect(() =>
      buildUpdateConfigInstruction({ ...target, admin: signer(ADMIN), guardian: GUARDIAN, claimAuthority: CLAIM, maxPerClaim: 2n, maxPerDay: 1n }),
    ).toThrow(/6021/);
  });

  it("propose_admin: 40 bytes; the default key cancels", () => {
    const ix = buildProposeAdminInstruction({ ...target, admin: signer(ADMIN), newAdmin: GUARDIAN });
    expectMatchesIdl(ix, "propose_admin", [VAULT, ADMIN]);
    expect(hex(Uint8Array.from(ix.data ?? []))).toBe(
      INSTRUCTION_DISCRIMINATORS_HEX.propose_admin + hex(Uint8Array.from(enc.encode(GUARDIAN))),
    );
    const cancel = buildProposeAdminInstruction({ ...target, admin: signer(ADMIN), newAdmin: SYSTEM_PROGRAM_ADDRESS });
    expect(hex(Uint8Array.from(cancel.data ?? [])).slice(16)).toBe("00".repeat(32));
  });

  it("accept_admin: [vault (w), new_admin (s)]", () => {
    const ix = buildAcceptAdminInstruction({ ...target, newAdmin: signer(GUARDIAN) });
    expectMatchesIdl(ix, "accept_admin", [VAULT, GUARDIAN]);
    expect(ix.data?.length).toBe(8);
  });
});

describe("withdraw (section 3.3.8) and deposit (transfer_checked)", () => {
  it("withdraw: [vault, admin, mint, vault token account, destination, token program], 16 bytes", async () => {
    const destination = await findClassicAta({ owner: ADMIN, mint: MINT });
    const [ix, ...rest] = await buildWithdrawInstructions({
      programAddress: OTHER_PROGRAM,
      vault: VAULT,
      admin: signer(ADMIN),
      mint: MINT,
      vaultTokenAccount: VAULT_ATA,
      destination,
      amount: 1_500_000n,
    });
    expect(rest).toHaveLength(0);
    expect(ix!.programAddress).toBe(OTHER_PROGRAM);
    expectMatchesIdl(ix!, "withdraw", [VAULT, ADMIN, MINT, VAULT_ATA, destination, TOKEN_PROGRAM_ADDRESS]);
    expect(hex(Uint8Array.from(ix!.data ?? []))).toBe(INSTRUCTION_DISCRIMINATORS_HEX.withdraw + u64(1_500_000n));
  });

  it("withdraw can create the admin's ATA first, and refuses a zero amount or the vault account as destination", async () => {
    const destination = await findClassicAta({ owner: ADMIN, mint: MINT });
    const base = {
      programAddress: OTHER_PROGRAM,
      vault: VAULT,
      admin: signer(ADMIN),
      mint: MINT,
      vaultTokenAccount: VAULT_ATA,
      destination,
      amount: 1n,
    };
    const withAta = await buildWithdrawInstructions({ ...base, createDestinationAtaPayer: signer(ADMIN) });
    expect(withAta.map((ix) => ix.programAddress)).toEqual([ASSOCIATED_TOKEN_PROGRAM_ADDRESS, OTHER_PROGRAM]);
    expect(withAta[0]?.accounts?.[1]?.address).toBe(destination);
    await expect(buildWithdrawInstructions({ ...base, amount: 0n })).rejects.toThrow(/amount/);
    await expect(buildWithdrawInstructions({ ...base, destination: VAULT_ATA })).rejects.toThrow(/2040/);
  });

  it("deposit: classic SPL Token transfer_checked into the vault token account", () => {
    const source = labelAddress("depositor ata");
    const ix = buildDepositInstruction({
      mint: MINT,
      source,
      vaultTokenAccount: VAULT_ATA,
      owner: signer(ADMIN),
      amount: 20_000_000n,
      decimals: 6,
    });
    expect(ix.programAddress).toBe(TOKEN_PROGRAM_ADDRESS);
    expect(ix.accounts?.map((m) => [m.address, isSignerRole(m.role), isWritableRole(m.role)])).toEqual([
      [source, false, true],
      [MINT, false, false],
      [VAULT_ATA, false, true],
      [ADMIN, true, false],
    ]);
    // TransferChecked = instruction 12, then amount (u64) and decimals (u8).
    expect(hex(Uint8Array.from(ix.data ?? []))).toBe(`0c${u64(20_000_000n)}06`);
    expect(() => buildDepositInstruction({ mint: MINT, source, vaultTokenAccount: VAULT_ATA, owner: signer(ADMIN), amount: 1n, decimals: 9 })).toThrow(/6 decimals/);
    expect(() => buildDepositInstruction({ mint: MINT, source: VAULT_ATA, vaultTokenAccount: VAULT_ATA, owner: signer(ADMIN), amount: 1n, decimals: 6 })).toThrow(/source/);
  });
});

describe("--export-squads message", () => {
  it("is the compiled v0 message in base58 and decodes back to the same message", async () => {
    const built = await buildInitializeInstructions({
      programAddress: OTHER_PROGRAM,
      mint: MINT,
      upgradeAuthority: signer(DEPLOYER),
      payer: signer(DEPLOYER),
      admin: ADMIN,
      guardian: GUARDIAN,
      claimAuthority: CLAIM,
      maxPerClaim: 5_000_000n,
      maxPerDay: 20_000_000n,
    });
    const message = buildAdminTransactionMessage({
      feePayer: signer(DEPLOYER),
      instructions: built.instructions,
      lifetime: { blockhash: TEST_BLOCKHASH, lastValidBlockHeight: 99n },
    });
    const exported = exportSquadsMessage(message);
    expect(exported).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    const decoded = decodeExportedMessage(exported);
    expect(Uint8Array.from(getCompiledTransactionMessageEncoder().encode(decoded))).toEqual(compiledMessageBytes(message));
    if (decoded.version !== 0) throw new Error("expected a v0 message");
    expect(decoded.staticAccounts[0]).toBe(DEPLOYER);
    expect(decoded.lifetimeToken).toBe(TEST_BLOCKHASH);
    expect(decoded.instructions.map((ix) => decoded.staticAccounts[ix.programAddressIndex])).toEqual([
      ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
      OTHER_PROGRAM,
    ]);
    expect(decoded.addressTableLookups ?? []).toEqual([]);
    expect(() => decodeExportedMessage("not base58!")).toThrow(/base58/);
  });
});
