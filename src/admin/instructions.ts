/**
 * Pure instruction builders for the operator CLI (`npm run admin`),
 * docs/CONTRACT.md section 3.3. No RPC call and no key material: signer
 * accounts take a `TransactionSigner` (a key-pair signer for local signing,
 * or a noop signer that only carries the address for `--export-squads`).
 *
 * Every program instruction is built with the generated client and an
 * explicit `programAddress` (section 2.4), and the result is checked to
 * target that address. Checks that need only the inputs run here; checks
 * that need the onchain vault live in state.ts.
 */
import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import {
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from "@solana-program/token";
import { isU64, USDC_DECIMALS } from "../amount.ts";
import { SYSTEM_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "../clusters.ts";
import { getAcceptAdminInstruction } from "../generated/instructions/acceptAdmin.ts";
import { getInitializeInstruction } from "../generated/instructions/initialize.ts";
import { getPauseInstruction } from "../generated/instructions/pause.ts";
import { getProposeAdminInstruction } from "../generated/instructions/proposeAdmin.ts";
import { getUnpauseInstruction } from "../generated/instructions/unpause.ts";
import { getUpdateConfigInstruction } from "../generated/instructions/updateConfig.ts";
import { getWithdrawInstruction } from "../generated/instructions/withdraw.ts";
import { findClassicAta, findProgramDataAddress, findVaultPda, type Pda } from "../program.ts";
import { capsProblem, rolesProblem } from "./config.ts";

export class AdminInstructionError extends Error {
  override name = "AdminInstructionError";
}

function refuse(message: string): never {
  throw new AdminInstructionError(message);
}

function assertPositiveU64(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || !isU64(value) || value === 0n) {
    refuse(`${label} must be a bigint from 1 to 2^64 - 1.`);
  }
  return value;
}

function targets<T extends Instruction>(instruction: T, programAddress: Address): T {
  if (instruction.programAddress !== programAddress) {
    throw new Error("the instruction does not target the explicit programAddress.");
  }
  return instruction;
}

// ---------------------------------------------------------------------------
// initialize (section 3.3.1)
// ---------------------------------------------------------------------------

export type InitializeInput = {
  /** `release/manifest.json.programIds[cluster]`. */
  readonly programAddress: Address;
  readonly mint: Address;
  /** The program's loader-v3 upgrade authority (I2). */
  readonly upgradeAuthority: TransactionSigner;
  /** Pays the ATA and vault rent; the transaction fee payer. */
  readonly payer: TransactionSigner;
  readonly admin: Address;
  readonly guardian: Address;
  readonly claimAuthority: Address;
  readonly maxPerClaim: bigint;
  readonly maxPerDay: bigint;
};

export type InitializeInstructions = {
  /** Exactly `[createAssociatedTokenIdempotent(ata(vault, mint)), initialize]`. */
  readonly instructions: readonly [Instruction, Instruction];
  readonly vault: Pda;
  readonly vaultTokenAccount: Address;
  readonly programData: Address;
};

/**
 * The one initialize transaction of section 3.3.1:
 * `[createAssociatedTokenIdempotent(payer, ata(vault, mint), vault, mint, classic Token), initialize]`.
 * The vault ATA is taken as existing by `initialize`, so creating it
 * idempotently in the same transaction means a stranger who created it first
 * cannot block initialization.
 *
 * Refuses (before anything is signed) what the program would refuse from the
 * inputs alone (I5, I6, I7), and `claim_authority == upgrade authority`, which
 * the contract enforces offchain in this CLI.
 */
export async function buildInitializeInstructions(input: InitializeInput): Promise<InitializeInstructions> {
  const roles = rolesProblem(input);
  if (roles !== null) refuse(roles);
  const maxPerClaim = assertPositiveU64(input.maxPerClaim, "maxPerClaim");
  const maxPerDay = assertPositiveU64(input.maxPerDay, "maxPerDay");
  const caps = capsProblem(maxPerClaim, maxPerDay);
  if (caps !== null) refuse(caps);
  if (input.claimAuthority === input.upgradeAuthority.address) {
    refuse("claimAuthority must not be the upgrade authority (section 3.3.1).");
  }
  const vault = await findVaultPda({ programAddress: input.programAddress, mint: input.mint });
  const [vaultTokenAccount, programData] = await Promise.all([
    findClassicAta({ owner: vault.address, mint: input.mint }),
    findProgramDataAddress(input.programAddress).then((pda) => pda.address),
  ]);
  const createAta = getCreateAssociatedTokenIdempotentInstruction({
    payer: input.payer,
    ata: vaultTokenAccount,
    owner: vault.address,
    mint: input.mint,
    systemProgram: SYSTEM_PROGRAM_ADDRESS,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const initialize = targets(
    getInitializeInstruction(
      {
        vault: vault.address,
        mint: input.mint,
        vaultTokenAccount,
        programData,
        upgradeAuthority: input.upgradeAuthority,
        payer: input.payer,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        systemProgram: SYSTEM_PROGRAM_ADDRESS,
        admin: input.admin,
        guardian: input.guardian,
        claimAuthority: input.claimAuthority,
        maxPerClaim,
        maxPerDay,
      },
      { programAddress: input.programAddress },
    ),
    input.programAddress,
  );
  return { instructions: [createAta, initialize], vault, vaultTokenAccount, programData };
}

// ---------------------------------------------------------------------------
// pause, unpause, update_config, propose_admin, accept_admin (3.3.3 to 3.3.7)
// ---------------------------------------------------------------------------

type VaultTarget = { readonly programAddress: Address; readonly vault: Address };

/** `pause()`: signed by the admin or the guardian (P1). */
export function buildPauseInstruction(input: VaultTarget & { readonly authority: TransactionSigner }): Instruction {
  return targets(
    getPauseInstruction({ vault: input.vault, authority: input.authority }, { programAddress: input.programAddress }),
    input.programAddress,
  );
}

/** `unpause()`: signed by the admin (U1). */
export function buildUnpauseInstruction(input: VaultTarget & { readonly admin: TransactionSigner }): Instruction {
  return targets(
    getUnpauseInstruction({ vault: input.vault, admin: input.admin }, { programAddress: input.programAddress }),
    input.programAddress,
  );
}

/** `update_config(guardian, claim_authority, max_per_claim, max_per_day)`, admin-signed (G1 to G4). */
export function buildUpdateConfigInstruction(
  input: VaultTarget & {
    readonly admin: TransactionSigner;
    readonly guardian: Address;
    readonly claimAuthority: Address;
    readonly maxPerClaim: bigint;
    readonly maxPerDay: bigint;
  },
): Instruction {
  const roles = rolesProblem({
    admin: input.admin.address,
    guardian: input.guardian,
    claimAuthority: input.claimAuthority,
  });
  if (roles !== null) refuse(roles);
  const maxPerClaim = assertPositiveU64(input.maxPerClaim, "maxPerClaim");
  const maxPerDay = assertPositiveU64(input.maxPerDay, "maxPerDay");
  const caps = capsProblem(maxPerClaim, maxPerDay);
  if (caps !== null) refuse(caps);
  return targets(
    getUpdateConfigInstruction(
      {
        vault: input.vault,
        admin: input.admin,
        guardian: input.guardian,
        claimAuthority: input.claimAuthority,
        maxPerClaim,
        maxPerDay,
      },
      { programAddress: input.programAddress },
    ),
    input.programAddress,
  );
}

/**
 * `propose_admin(new_admin)`, admin-signed (A1). The default key
 * (`11111111111111111111111111111111`) cancels a pending proposal.
 */
export function buildProposeAdminInstruction(
  input: VaultTarget & { readonly admin: TransactionSigner; readonly newAdmin: Address },
): Instruction {
  return targets(
    getProposeAdminInstruction(
      { vault: input.vault, admin: input.admin, newAdmin: input.newAdmin },
      { programAddress: input.programAddress },
    ),
    input.programAddress,
  );
}

/** `accept_admin()`, signed by the pending admin (B1). */
export function buildAcceptAdminInstruction(
  input: VaultTarget & { readonly newAdmin: TransactionSigner },
): Instruction {
  return targets(
    getAcceptAdminInstruction({ vault: input.vault, newAdmin: input.newAdmin }, { programAddress: input.programAddress }),
    input.programAddress,
  );
}

// ---------------------------------------------------------------------------
// withdraw (3.3.8) and deposit (classic SPL Token transfer_checked)
// ---------------------------------------------------------------------------

/**
 * `withdraw(amount)` to an admin-owned token account of the vault mint. With
 * `createDestinationAtaPayer`, the admin's canonical ATA is created
 * idempotently first (the destination must then be that ATA).
 */
export async function buildWithdrawInstructions(
  input: VaultTarget & {
    readonly admin: TransactionSigner;
    readonly mint: Address;
    readonly vaultTokenAccount: Address;
    readonly destination: Address;
    readonly amount: bigint;
    readonly createDestinationAtaPayer?: TransactionSigner;
  },
): Promise<Instruction[]> {
  const amount = assertPositiveU64(input.amount, "amount");
  if (input.destination === input.vaultTokenAccount) {
    refuse("the destination must not be the vault token account (2040).");
  }
  const instructions: Instruction[] = [];
  if (input.createDestinationAtaPayer !== undefined) {
    const adminAta = await findClassicAta({ owner: input.admin.address, mint: input.mint });
    if (adminAta !== input.destination) refuse("the destination must be the admin's canonical ATA to create it.");
    instructions.push(
      getCreateAssociatedTokenIdempotentInstruction({
        payer: input.createDestinationAtaPayer,
        ata: adminAta,
        owner: input.admin.address,
        mint: input.mint,
        systemProgram: SYSTEM_PROGRAM_ADDRESS,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      }),
    );
  }
  instructions.push(
    targets(
      getWithdrawInstruction(
        {
          vault: input.vault,
          admin: input.admin,
          mint: input.mint,
          vaultTokenAccount: input.vaultTokenAccount,
          destination: input.destination,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          amount,
        },
        { programAddress: input.programAddress },
      ),
      input.programAddress,
    ),
  );
  return instructions;
}

/**
 * The vault funding transfer: classic SPL Token
 * `transfer_checked(source, mint, destination = vault.vault_token_account, owner, amount, decimals)`.
 * The destination must be the address read from the onchain vault, never one
 * typed by hand or picked in a wallet UI (the vault is an off-curve PDA).
 */
export function buildDepositInstruction(input: {
  readonly mint: Address;
  readonly source: Address;
  readonly vaultTokenAccount: Address;
  readonly owner: TransactionSigner;
  readonly amount: bigint;
  readonly decimals: number;
}): Instruction {
  const amount = assertPositiveU64(input.amount, "amount");
  if (input.decimals !== USDC_DECIMALS) refuse("the vault mint must have 6 decimals (6019 InvalidMint).");
  if (input.source === input.vaultTokenAccount) refuse("the source must not be the vault token account.");
  const instruction = getTransferCheckedInstruction(
    {
      source: input.source,
      mint: input.mint,
      destination: input.vaultTokenAccount,
      authority: input.owner,
      amount,
      decimals: input.decimals,
    },
    { programAddress: TOKEN_PROGRAM_ADDRESS },
  );
  return targets(instruction, TOKEN_PROGRAM_ADDRESS);
}
