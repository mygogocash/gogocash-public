//! `claim` (docs/CONTRACT.md 3.3.2): pay one approved payout exactly once.
//!
//! Exactly-once comes from the Receipt PDA `["receipt", vault, payout_id]`:
//! it is created with `init` (never `init_if_needed`), so a replay fails in
//! Anchor's account stage with the system program's "already in use" before
//! any handler check, even while the vault is paused (CONTRACT.md 3.3.0).

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::errors::CashbackError;
use crate::events::PayoutClaimed;
use crate::state::{day, Receipt, Vault, MAX_EXPIRY_SECONDS, RECEIPT_SEED, VAULT_SEED};

/// Accounts of `claim`, in contract order.
#[derive(Accounts)]
#[instruction(payout_id: [u8; 32])]
pub struct Claim<'info> {
    /// The vault paying out, PDA `["vault", mint]`.
    #[account(
        mut,
        seeds = [VAULT_SEED, mint.key().as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,
    /// The new receipt, PDA `["receipt", vault, payout_id]` with the
    /// canonical bump. Its rent is paid by `payer` and never reclaimed.
    #[account(
        init,
        payer = payer,
        space = Receipt::LEN,
        seeds = [RECEIPT_SEED, vault.key().as_ref(), payout_id.as_ref()],
        bump
    )]
    pub receipt: Account<'info, Receipt>,
    /// The vault mint (classic SPL Token); checked in C3.
    pub mint: Account<'info, Mint>,
    /// The vault's token account; checked in C4.
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,
    /// The wallet being paid. Must be system-owned; a never-funded wallet
    /// passes. Checked in C5.
    pub recipient: SystemAccount<'info>,
    /// The canonical ATA of (recipient, mint, classic Token). Must exist.
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = recipient,
        associated_token::token_program = token_program
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,
    /// Must equal `vault.claim_authority` (C2).
    pub claim_authority: Signer<'info>,
    /// Any key (not pinned in v0); funds the receipt rent.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Classic SPL Token.
    pub token_program: Program<'info, Token>,
    /// System program, used by `init`.
    pub system_program: Program<'info, System>,
}

/// Handler checks C1 to C15 in contract order, then the effects, the
/// transfer and the event.
pub(crate) fn handler(
    ctx: Context<Claim>,
    payout_id: [u8; 32],
    amount: u64,
    expires_at: i64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let accounts = &ctx.accounts;
    let vault = &accounts.vault;

    // C1
    require!(!vault.paused, CashbackError::Paused);

    // C2
    let claim_authority = accounts.claim_authority.key();
    let is_claim_authority = claim_authority == vault.claim_authority;
    require!(is_claim_authority, CashbackError::InvalidClaimAuthority);

    // C3: defense in depth; the vault seeds already bind the vault to the mint.
    let is_vault_mint = accounts.mint.key() == vault.mint;
    require!(is_vault_mint, CashbackError::InvalidMint);

    // C4
    let vault_token_account = accounts.vault_token_account.key();
    let canonical = vault_token_account == vault.vault_token_account;
    require!(canonical, CashbackError::InvalidVaultTokenAccount);

    // C5
    let recipient = accounts.recipient.key();
    let pays_vault = recipient == vault.key();
    let pays_claim_authority = recipient == claim_authority;
    let pays_payer = recipient == accounts.payer.key();
    let forbidden = pays_vault || pays_claim_authority || pays_payer;
    require!(!forbidden, CashbackError::InvalidRecipient);

    // C6
    require!(payout_id != [0u8; 32], CashbackError::ZeroPayoutId);

    // C7
    require!(amount > 0, CashbackError::ZeroAmount);

    // C8
    let within_claim_cap = amount <= vault.max_per_claim;
    require!(within_claim_cap, CashbackError::ExceedsMaxPerClaim);

    // C9: the day bucket only moves forward. A clock that moved back keeps
    // counting in the newer bucket.
    let today = day(now);
    let mut current_day = vault.current_day;
    let mut claimed_today = vault.claimed_today;
    if today > current_day {
        current_day = today;
        claimed_today = 0;
    }
    let new_today = claimed_today
        .checked_add(amount)
        .ok_or(CashbackError::MathOverflow)?;

    // C10
    let within_day_cap = new_today <= vault.max_per_day;
    require!(within_day_cap, CashbackError::DayCapExceeded);

    // C11
    require!(now <= expires_at, CashbackError::Expired);

    // C12
    let latest_expiry = now
        .checked_add(MAX_EXPIRY_SECONDS)
        .ok_or(CashbackError::MathOverflow)?;
    require!(expires_at <= latest_expiry, CashbackError::ExpiryTooFar);

    // C13
    let vault_unfrozen = !accounts.vault_token_account.is_frozen();
    require!(vault_unfrozen, CashbackError::VaultTokenAccountFrozen);

    // C14
    let thawed = !accounts.recipient_token_account.is_frozen();
    require!(thawed, CashbackError::RecipientTokenAccountFrozen);

    // C15
    let has_balance = accounts.vault_token_account.amount >= amount;
    require!(has_balance, CashbackError::InsufficientVaultBalance);

    // Effects, in contract order: the receipt, the day bucket, the counters.
    let receipt_bump = ctx.bumps.receipt;
    let receipt = &mut ctx.accounts.receipt;
    receipt.bump = receipt_bump;
    receipt.payout_id = payout_id;
    receipt.recipient = recipient;
    receipt.amount = amount;
    receipt.claimed_at = now;

    let vault = &mut ctx.accounts.vault;
    vault.current_day = current_day;
    vault.claimed_today = new_today;
    vault.total_claimed = vault
        .total_claimed
        .checked_add(amount)
        .ok_or(CashbackError::MathOverflow)?;
    vault.claim_count = vault
        .claim_count
        .checked_add(1)
        .ok_or(CashbackError::MathOverflow)?;

    // Transfer, signed by the vault PDA `["vault", vault.mint, [vault.bump]]`.
    let accounts = &ctx.accounts;
    let vault_mint = accounts.vault.mint;
    let vault_bump = [accounts.vault.bump];
    let vault_seeds: [&[u8]; 3] = [VAULT_SEED, vault_mint.as_ref(), &vault_bump];
    let signer_seeds: [&[&[u8]]; 1] = [&vault_seeds];
    let transfer = TransferChecked {
        from: accounts.vault_token_account.to_account_info(),
        mint: accounts.mint.to_account_info(),
        to: accounts.recipient_token_account.to_account_info(),
        authority: accounts.vault.to_account_info(),
    };
    let token_program = accounts.token_program.key();
    let cpi = CpiContext::new_with_signer(token_program, transfer, &signer_seeds);
    token::transfer_checked(cpi, amount, accounts.mint.decimals)?;

    emit!(PayoutClaimed {
        vault: accounts.vault.key(),
        receipt: accounts.receipt.key(),
        payout_id,
        recipient,
        amount,
        claimed_at: now,
        day: accounts.vault.current_day,
        claimed_today: accounts.vault.claimed_today,
        claim_count: accounts.vault.claim_count,
        total_claimed: accounts.vault.total_claimed,
    });
    Ok(())
}
