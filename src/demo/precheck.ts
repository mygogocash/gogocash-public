/**
 * The demo's checks before anything changes onchain, pure. The demo reads
 * the chain first, then runs these, and only if every one passes does it send
 * its first transaction:
 *
 * - `demoStateProblems`: the onchain vault matches deployments/devnet.json,
 *   is unpaused and unfrozen, the key files are the vault's claim authority,
 *   guardian and admin, and today's cap has room (contract section 3.3.2);
 * - `fundingShortfalls`: the fee payer can fund every rent and fee of the run,
 *   and the vault holds the one real payout. A shortfall exits before any
 *   state change and names only the address to fund.
 */
import type { Address } from "@solana/kit";
import { U64_MAX } from "../amount.ts";
import type { Vault } from "../program.ts";
import { compareVault, type ExpectedVault, type TokenAccountView } from "../admin/state.ts";

/**
 * Fees of the run's three sent transactions (claim, pause, unpause), each at
 * most two signatures x 5,000 lamports, plus the claim's priority fee at the
 * caps (90,000 CU x 100,000 micro-lamports = 9,000 lamports), with margin.
 * Simulations cost nothing.
 */
export const DEMO_FEE_BUDGET_LAMPORTS = 50_000n;

const SECONDS_PER_DAY = 86_400n;

/** `day(t) = t.div_euclid(86_400)` (section 3.1). */
export function utcDay(unixTimestamp: bigint): bigint {
  const q = unixTimestamp / SECONDS_PER_DAY;
  return unixTimestamp % SECONDS_PER_DAY < 0n ? q - 1n : q;
}

/**
 * What `claimed_today` will be when a claim runs at `unixTimestamp` (C9: the
 * bucket only moves forward).
 */
export function claimedTodayAt(vault: Pick<Vault, "currentDay" | "claimedToday">, unixTimestamp: bigint): bigint {
  return utcDay(unixTimestamp) > vault.currentDay ? 0n : vault.claimedToday;
}

export type DemoSigners = {
  readonly claimAuthority: Address;
  readonly guardian: Address;
  readonly admin: Address;
  readonly payer: Address;
};

/**
 * Everything that would make a demo step fail for a reason that is not the
 * point of the step. Each entry is a sentence safe to print (addresses and
 * amounts only).
 */
export function demoStateProblems(input: {
  readonly vault: Vault;
  readonly expected: ExpectedVault;
  readonly vaultTokenAccount: TokenAccountView | null;
  readonly vaultAddress: Address;
  readonly signers: DemoSigners;
  readonly amountAtomic: bigint;
  readonly unixTimestamp: bigint;
  readonly vaultName: string;
}): string[] {
  const { vault, signers } = input;
  const problems: string[] = [];
  for (const d of compareVault(vault, input.expected)) {
    problems.push(`the onchain vault differs from deployments/devnet.json: ${d.field} expected ${d.expected}, onchain ${d.actual}.`);
  }
  if (signers.claimAuthority !== vault.claimAuthority) {
    problems.push("--claim-keypair is not the vault's claim authority (6001 InvalidClaimAuthority).");
  }
  if (signers.guardian !== vault.guardian) problems.push("--guardian-keypair is not the vault's guardian.");
  if (signers.admin !== vault.admin) problems.push("--admin-keypair is not the vault's admin (6002 NotAdmin).");
  if (signers.claimAuthority === vault.admin || signers.claimAuthority === vault.guardian) {
    problems.push("the claim authority must not also be the admin or the guardian (6020 RoleConflict).");
  }
  if (vault.paused) {
    problems.push(
      `the vault is paused. Unpause it first: npm run admin -- unpause --cluster devnet --vault ${input.vaultName} --keypair <admin.json>`,
    );
  }
  const token = input.vaultTokenAccount;
  if (token === null) {
    problems.push("the vault token account does not exist.");
  } else {
    if (token.owner !== input.vaultAddress || token.mint !== vault.mint) {
      problems.push("the vault token account read from chain is not the vault's own account of its mint.");
    }
    if (token.frozen) problems.push("the vault token account is frozen (6014 VaultTokenAccountFrozen).");
  }
  if (input.amountAtomic > vault.maxPerClaim) {
    problems.push(`the demo amount ${input.amountAtomic} is above the vault's max_per_claim ${vault.maxPerClaim} (6010).`);
  }
  if (vault.maxPerClaim >= U64_MAX) problems.push("max_per_claim is u64 max, so no claim can be over the cap.");
  const claimed = claimedTodayAt(vault, input.unixTimestamp);
  if (claimed + input.amountAtomic > vault.maxPerDay) {
    problems.push(
      `today's cap has no room: claimed_today ${claimed} + ${input.amountAtomic} > max_per_day ${vault.maxPerDay} (6011). Run again after 00:00 UTC.`,
    );
  }
  return problems;
}

export type FundingShortfall =
  | { readonly kind: "payer_sol"; readonly address: Address; readonly haveLamports: bigint; readonly needLamports: bigint }
  | { readonly kind: "vault_tokens"; readonly address: Address; readonly haveAtomic: bigint; readonly needAtomic: bigint };

/**
 * Lamports the fee payer needs for the whole run: it must stay rent-exempt
 * itself, fund the one receipt the real claim creates (never reclaimed), the
 * recipient's ATA when it does not exist yet, and the fee budget.
 */
export function payerLamportsNeeded(input: {
  readonly rentExemptEmptyAccount: bigint;
  readonly receiptRent: bigint;
  readonly tokenAccountRent: bigint;
  readonly recipientAtaExists: boolean;
}): bigint {
  return (
    input.rentExemptEmptyAccount +
    input.receiptRent +
    (input.recipientAtaExists ? 0n : input.tokenAccountRent) +
    DEMO_FEE_BUDGET_LAMPORTS
  );
}

/**
 * The fee payer must hold `payerLamportsNeeded`, and the vault token account
 * must hold the one payout the demo really sends (the replay, over-cap and
 * paused claims are simulations and fail before the transfer).
 */
export function fundingShortfalls(input: {
  readonly payer: Address;
  readonly payerLamports: bigint;
  readonly rentExemptEmptyAccount: bigint;
  readonly receiptRent: bigint;
  readonly tokenAccountRent: bigint;
  readonly recipientAtaExists: boolean;
  readonly vault: Address;
  readonly vaultBalanceAtomic: bigint;
  readonly amountAtomic: bigint;
}): FundingShortfall[] {
  const shortfalls: FundingShortfall[] = [];
  const needLamports = payerLamportsNeeded(input);
  if (input.payerLamports < needLamports) {
    shortfalls.push({ kind: "payer_sol", address: input.payer, haveLamports: input.payerLamports, needLamports });
  }
  if (input.vaultBalanceAtomic < input.amountAtomic) {
    shortfalls.push({ kind: "vault_tokens", address: input.vault, haveAtomic: input.vaultBalanceAtomic, needAtomic: input.amountAtomic });
  }
  return shortfalls;
}

/** One line per shortfall: the address to fund and how much, nothing else. */
export function describeShortfall(shortfall: FundingShortfall, vaultName: string): string {
  if (shortfall.kind === "payer_sol") {
    return `fund ${shortfall.address} with devnet SOL: it holds ${shortfall.haveLamports} lamports and the demo needs ${shortfall.needLamports}.`;
  }
  return `fund vault ${shortfall.address}: it holds ${shortfall.haveAtomic} atomic and the demo pays ${shortfall.needAtomic}. Deposit with npm run admin -- deposit --cluster devnet --vault ${vaultName} --amount <atomic> --keypair <admin.json> (never from a wallet UI).`;
}
