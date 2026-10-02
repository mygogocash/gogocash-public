//! `initialize` (docs/CONTRACT.md 3.3.1): create the vault for one mint.
//!
//! Only the loader-v3 upgrade authority of this program may call it. The
//! vault token account is taken as an existing canonical ATA (not `init`), so
//! a stranger who creates it first cannot block initialization. The vault
//! starts paused; the admin unpauses it after the SEC-5 ceremony.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::CashbackError;
use crate::state::{caps_are_valid, day, Vault, REQUIRED_MINT_DECIMALS, VAULT_SEED, VAULT_VERSION};

/// Accounts of `initialize`, in contract order.
#[derive(Accounts)]
pub struct Initialize<'info> {
    /// The new vault, PDA `["vault", mint]` with the canonical bump.
    #[account(
        init,
        payer = payer,
        space = Vault::LEN,
        seeds = [VAULT_SEED, mint.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    /// The USDC mint (classic SPL Token).
    pub mint: Account<'info, Mint>,
    /// The canonical ATA of (vault, mint, classic Token). Must already exist.
    #[account(
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    /// This program's ProgramData account; its address is checked in I1.
    pub program_data: Account<'info, ProgramData>,
    /// Must be the program's upgrade authority (I2).
    pub upgrade_authority: Signer<'info>,
    /// Pays the vault rent.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Classic SPL Token.
    pub token_program: Program<'info, Token>,
    /// System program, used by `init`.
    pub system_program: Program<'info, System>,
}

/// Handler checks I1 to I7 in contract order, then the effects.
pub(crate) fn handler(
    ctx: Context<Initialize>,
    admin: Pubkey,
    guardian: Pubkey,
    claim_authority: Pubkey,
    max_per_claim: u64,
    max_per_day: u64,
) -> Result<()> {
    let accounts = &ctx.accounts;

    // I1 (SEC-5): bind to this program's own ProgramData, not a foreign one.
    let loader = anchor_lang::solana_program::bpf_loader_upgradeable::ID;
    let (own_program_data, _) = Pubkey::find_program_address(&[crate::ID.as_ref()], &loader);
    let is_own_program_data = accounts.program_data.key() == own_program_data;
    require!(is_own_program_data, CashbackError::InvalidProgramData);

    // I2: an immutable program (authority `None`) is refused.
    let signer = Some(accounts.upgrade_authority.key());
    let is_upgrade_authority = accounts.program_data.upgrade_authority_address == signer;
    require!(is_upgrade_authority, CashbackError::NotUpgradeAuthority);

    // I3
    let has_required_decimals = accounts.mint.decimals == REQUIRED_MINT_DECIMALS;
    require!(has_required_decimals, CashbackError::InvalidMint);

    // I4
    let vault_token_account = &accounts.vault_token_account;
    let has_no_delegate = vault_token_account.delegate.is_none();
    let has_no_close_authority = vault_token_account.close_authority.is_none();
    let clean = has_no_delegate && has_no_close_authority;
    require!(clean, CashbackError::InvalidVaultTokenAccount);

    // I5
    let none = Pubkey::default();
    let roles_are_set = admin != none && guardian != none && claim_authority != none;
    require!(roles_are_set, CashbackError::InvalidRole);

    // I6
    let roles_are_separate = claim_authority != admin && claim_authority != guardian;
    require!(roles_are_separate, CashbackError::RoleConflict);

    // I7
    let caps_ok = caps_are_valid(max_per_claim, max_per_day);
    require!(caps_ok, CashbackError::InvalidCaps);

    // Effects.
    let now = Clock::get()?.unix_timestamp;
    let mint = accounts.mint.key();
    let decimals = accounts.mint.decimals;
    let vault_token_account = accounts.vault_token_account.key();
    let bump = ctx.bumps.vault;

    let vault = &mut ctx.accounts.vault;
    vault.version = VAULT_VERSION;
    vault.bump = bump;
    vault.paused = true;
    vault.decimals = decimals;
    vault.mint = mint;
    vault.vault_token_account = vault_token_account;
    vault.admin = admin;
    vault.pending_admin = Pubkey::default();
    vault.guardian = guardian;
    vault.claim_authority = claim_authority;
    vault.max_per_claim = max_per_claim;
    vault.max_per_day = max_per_day;
    vault.current_day = day(now);
    vault.claimed_today = 0;
    vault.total_claimed = 0;
    vault.claim_count = 0;
    vault.total_withdrawn = 0;
    vault.reserved = [0u8; 64];
    Ok(())
}
