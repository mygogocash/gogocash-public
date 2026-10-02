//! `withdraw` (docs/CONTRACT.md 3.3.8): the admin moves float out of the
//! vault. Allowed while paused. No event.
//!
//! Conservation identity for watchers: `vault_token_account.amount ==
//! deposits - total_claimed - total_withdrawn`, where deposits are inbound
//! transfers observed off-chain.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::errors::CashbackError;
use crate::state::{Vault, VAULT_SEED};

/// Accounts of `withdraw`, in contract order.
#[derive(Accounts)]
pub struct Withdraw<'info> {
    /// The vault paying out, PDA `["vault", mint]`.
    #[account(
        mut,
        seeds = [VAULT_SEED, mint.key().as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,
    /// Must be the vault admin (W1).
    pub admin: Signer<'info>,
    /// The vault mint (classic SPL Token); checked in W2.
    pub mint: Account<'info, Mint>,
    /// The vault's token account; checked in W3.
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,
    /// An admin-owned token account of the vault mint; checked in W5.
    /// Passing the vault token account here fails Anchor's duplicate check.
    #[account(mut)]
    pub destination: Account<'info, TokenAccount>,
    /// Classic SPL Token.
    pub token_program: Program<'info, Token>,
}

/// Handler checks W1 to W8 in contract order, then the effect and the
/// transfer.
pub(crate) fn handler(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    let accounts = &ctx.accounts;
    let vault = &accounts.vault;

    // W1
    let is_admin = accounts.admin.key() == vault.admin;
    require!(is_admin, CashbackError::NotAdmin);

    // W2
    let is_vault_mint = accounts.mint.key() == vault.mint;
    require!(is_vault_mint, CashbackError::InvalidMint);

    // W3
    let vault_token_account = accounts.vault_token_account.key();
    let canonical = vault_token_account == vault.vault_token_account;
    require!(canonical, CashbackError::InvalidVaultTokenAccount);

    // W4
    require!(amount > 0, CashbackError::ZeroAmount);

    // W5
    let destination = &accounts.destination;
    let owned_by_admin = destination.owner == vault.admin;
    let holds_vault_mint = destination.mint == vault.mint;
    let thawed = !destination.is_frozen();
    let destination_ok = owned_by_admin && holds_vault_mint && thawed;
    require!(destination_ok, CashbackError::InvalidWithdrawDestination);

    // W6
    let vault_unfrozen = !accounts.vault_token_account.is_frozen();
    require!(vault_unfrozen, CashbackError::VaultTokenAccountFrozen);

    // W7
    let has_balance = accounts.vault_token_account.amount >= amount;
    require!(has_balance, CashbackError::InsufficientVaultBalance);

    // W8
    let total_withdrawn = vault
        .total_withdrawn
        .checked_add(amount)
        .ok_or(CashbackError::MathOverflow)?;

    // Effect, then the transfer signed by the vault PDA.
    ctx.accounts.vault.total_withdrawn = total_withdrawn;

    let accounts = &ctx.accounts;
    let vault_mint = accounts.vault.mint;
    let vault_bump = [accounts.vault.bump];
    let vault_seeds: [&[u8]; 3] = [VAULT_SEED, vault_mint.as_ref(), &vault_bump];
    let signer_seeds: [&[&[u8]]; 1] = [&vault_seeds];
    let transfer = TransferChecked {
        from: accounts.vault_token_account.to_account_info(),
        mint: accounts.mint.to_account_info(),
        to: accounts.destination.to_account_info(),
        authority: accounts.vault.to_account_info(),
    };
    let token_program = accounts.token_program.key();
    let cpi = CpiContext::new_with_signer(token_program, transfer, &signer_seeds);
    token::transfer_checked(cpi, amount, accounts.mint.decimals)
}
