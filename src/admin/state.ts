/**
 * Checks over decoded onchain state, pure. The operator CLI runs these
 * before it signs anything, so a transaction the program would refuse (with
 * the codes of docs/CONTRACT.md section 3.5) is never sent, and `show`
 * reports every difference between the chain and `deployments/<cluster>.json`.
 */
import { isSome, type Address } from "@solana/kit";
import { AccountState, getMintDecoder, getTokenDecoder } from "@solana-program/token";
import { USDC_DECIMALS } from "../amount.ts";
import { SYSTEM_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "../clusters.ts";
import { VAULT_LAYOUT_VERSION, type Vault } from "../program.ts";
import { capsProblem } from "./config.ts";

/** Classic SPL Token account and mint sizes (no extensions; Token-2022 is refused). */
export const TOKEN_ACCOUNT_SIZE = 165;
export const MINT_ACCOUNT_SIZE = 82;

export class StateDecodeError extends Error {
  override name = "StateDecodeError";
}

export type RawAccount = { readonly owner: string; readonly data: Uint8Array };

export type TokenAccountView = {
  readonly mint: Address;
  readonly owner: Address;
  readonly amount: bigint;
  readonly frozen: boolean;
  readonly delegate: Address | null;
  readonly closeAuthority: Address | null;
};

/** Decodes a classic SPL Token account (owner program and size checked). */
export function decodeTokenAccount(account: RawAccount): TokenAccountView {
  if (account.owner !== TOKEN_PROGRAM_ADDRESS) throw new StateDecodeError("the token account is not owned by classic SPL Token.");
  if (account.data.length !== TOKEN_ACCOUNT_SIZE) throw new StateDecodeError("the token account is not 165 bytes.");
  const token = getTokenDecoder().decode(account.data);
  if (token.state === AccountState.Uninitialized) throw new StateDecodeError("the token account is not initialized.");
  return {
    mint: token.mint,
    owner: token.owner,
    amount: token.amount,
    frozen: token.state === AccountState.Frozen,
    delegate: isSome(token.delegate) ? token.delegate.value : null,
    closeAuthority: isSome(token.closeAuthority) ? token.closeAuthority.value : null,
  };
}

/** Decodes a classic SPL Token mint and returns its decimals (owner program and size checked). */
export function decodeMintDecimals(account: RawAccount): number {
  if (account.owner !== TOKEN_PROGRAM_ADDRESS) throw new StateDecodeError("the mint is not owned by classic SPL Token.");
  if (account.data.length !== MINT_ACCOUNT_SIZE) throw new StateDecodeError("the mint is not 82 bytes.");
  const mint = getMintDecoder().decode(account.data);
  if (!mint.isInitialized) throw new StateDecodeError("the mint is not initialized.");
  return mint.decimals;
}

export type Drift = { readonly field: string; readonly expected: string; readonly actual: string };

export type ExpectedVault = {
  readonly mint: Address;
  readonly vaultTokenAccount: Address;
  readonly vaultBump: number;
  readonly admin: Address;
  readonly guardian: Address;
  readonly claimAuthority: Address;
  readonly maxPerClaim: bigint;
  readonly maxPerDay: bigint;
};

/**
 * Every difference between an onchain vault and the expected one (a
 * deployment record, or the vault config for `initialize --skip-existing`).
 * A pending admin proposal is reported too.
 */
export function compareVault(vault: Vault, expected: ExpectedVault): Drift[] {
  const drift: Drift[] = [];
  const check = (field: string, want: string | number | bigint, got: string | number | bigint): void => {
    if (want !== got) drift.push({ field, expected: String(want), actual: String(got) });
  };
  check("version", VAULT_LAYOUT_VERSION, vault.version);
  check("decimals", USDC_DECIMALS, vault.decimals);
  check("bump", expected.vaultBump, vault.bump);
  check("mint", expected.mint, vault.mint);
  check("vaultTokenAccount", expected.vaultTokenAccount, vault.vaultTokenAccount);
  check("admin", expected.admin, vault.admin);
  check("pendingAdmin", SYSTEM_PROGRAM_ADDRESS, vault.pendingAdmin);
  check("guardian", expected.guardian, vault.guardian);
  check("claimAuthority", expected.claimAuthority, vault.claimAuthority);
  check("maxPerClaim", expected.maxPerClaim, vault.maxPerClaim);
  check("maxPerDay", expected.maxPerDay, vault.maxPerDay);
  return drift;
}

/** pause P1: the signer is the admin or the guardian. */
export function pauseProblem(vault: Vault, signer: Address): string | null {
  if (signer !== vault.admin && signer !== vault.guardian) {
    return "the signer is neither the vault admin nor the guardian (6003 NotAdminOrGuardian).";
  }
  return null;
}

function adminProblem(vault: Vault, signer: Address): string | null {
  return signer === vault.admin ? null : "the signer is not the vault admin (6002 NotAdmin).";
}

/** unpause U1. */
export function unpauseProblem(vault: Vault, signer: Address): string | null {
  return adminProblem(vault, signer);
}

/** update_config G1 to G4 (G3 compares the claim authority with the vault's admin). */
export function updateConfigProblem(
  vault: Vault,
  signer: Address,
  next: { guardian: Address; claimAuthority: Address; maxPerClaim: bigint; maxPerDay: bigint },
): string | null {
  const admin = adminProblem(vault, signer);
  if (admin !== null) return admin;
  if (next.guardian === SYSTEM_PROGRAM_ADDRESS || next.claimAuthority === SYSTEM_PROGRAM_ADDRESS) {
    return "guardian and claimAuthority must not be the default public key (6007 InvalidRole).";
  }
  if (next.claimAuthority === vault.admin || next.claimAuthority === next.guardian) {
    return "claimAuthority must not be the admin or the guardian (6020 RoleConflict).";
  }
  return capsProblem(next.maxPerClaim, next.maxPerDay);
}

/** propose_admin A1 and A2 (the default key cancels and skips A2). */
export function proposeAdminProblem(vault: Vault, signer: Address, newAdmin: Address): string | null {
  const admin = adminProblem(vault, signer);
  if (admin !== null) return admin;
  if (newAdmin !== SYSTEM_PROGRAM_ADDRESS && newAdmin === vault.claimAuthority) {
    return "the new admin must not be the claim authority (6020 RoleConflict).";
  }
  return null;
}

/** accept_admin B1 and B2. */
export function acceptAdminProblem(vault: Vault, signer: Address): string | null {
  if (vault.pendingAdmin === SYSTEM_PROGRAM_ADDRESS || signer !== vault.pendingAdmin) {
    return "the signer is not the pending admin (6004 NotPendingAdmin).";
  }
  if (signer === vault.claimAuthority) return "the new admin must not be the claim authority (6020 RoleConflict).";
  return null;
}

/**
 * withdraw W1 to W7. `destination` is `null` when the admin's canonical ATA
 * does not exist yet (it is created idempotently in the same transaction).
 */
export function withdrawProblem(input: {
  vault: Vault;
  signer: Address;
  vaultTokenAccount: TokenAccountView;
  destination: TokenAccountView | null;
  amount: bigint;
}): string | null {
  const { vault } = input;
  const admin = adminProblem(vault, input.signer);
  if (admin !== null) return admin;
  if (input.amount <= 0n) return "amount must be greater than zero (6009 ZeroAmount).";
  if (input.destination !== null) {
    if (input.destination.owner !== vault.admin || input.destination.mint !== vault.mint || input.destination.frozen) {
      return "the destination must be an unfrozen vault-mint token account owned by the admin (6022 InvalidWithdrawDestination).";
    }
  }
  if (input.vaultTokenAccount.frozen) return "the vault token account is frozen (6014 VaultTokenAccountFrozen).";
  if (input.vaultTokenAccount.amount < input.amount) return "the vault balance is below the amount (6016 InsufficientVaultBalance).";
  return null;
}

/**
 * The deposit target read from chain must be the vault's own token account:
 * owned by the vault PDA, of the vault mint, unfrozen, with no delegate or
 * close authority (the I4 invariant). The source must hold the amount.
 */
export function depositProblem(input: {
  vault: Vault;
  vaultAddress: Address;
  vaultTokenAccount: TokenAccountView;
  source: TokenAccountView;
  depositor: Address;
  amount: bigint;
}): string | null {
  const target = input.vaultTokenAccount;
  if (target.owner !== input.vaultAddress) return "the vault token account read from chain is not owned by the vault.";
  if (target.mint !== input.vault.mint) return "the vault token account read from chain is not of the vault mint.";
  if (target.frozen) return "the vault token account is frozen (6014 VaultTokenAccountFrozen).";
  if (target.delegate !== null || target.closeAuthority !== null) {
    return "the vault token account has a delegate or a close authority (6018 InvalidVaultTokenAccount).";
  }
  if (input.amount <= 0n) return "amount must be greater than zero.";
  if (input.source.mint !== input.vault.mint) return "the source token account is not of the vault mint.";
  if (input.source.owner !== input.depositor) return "the source token account is not owned by the depositor.";
  if (input.source.frozen) return "the source token account is frozen.";
  if (input.source.amount < input.amount) return "the source balance is below the amount.";
  return null;
}
