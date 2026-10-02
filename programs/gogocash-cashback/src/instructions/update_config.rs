//! `update_config` (docs/CONTRACT.md 3.3.5): the admin replaces the guardian,
//! the claim authority and both caps. Allowed while paused. Does not change
//! `admin`, `pending_admin`, `paused` or any counter. Lowering `max_per_day`
//! below `claimed_today` is allowed and blocks further claims that day.

use anchor_lang::prelude::*;

use crate::errors::CashbackError;
use crate::state::{caps_are_valid, Vault};

/// Accounts of `update_config` (as `unpause`), in contract order.
#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    /// The vault to reconfigure.
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    /// Must be the vault admin (G1).
    pub admin: Signer<'info>,
}

/// Handler checks G1 to G4 in contract order, then the effect.
pub(crate) fn handler(
    ctx: Context<UpdateConfig>,
    guardian: Pubkey,
    claim_authority: Pubkey,
    max_per_claim: u64,
    max_per_day: u64,
) -> Result<()> {
    let admin = ctx.accounts.admin.key();
    let vault = &mut ctx.accounts.vault;

    // G1
    require!(admin == vault.admin, CashbackError::NotAdmin);

    // G2 (SEC-5)
    let none = Pubkey::default();
    let roles_are_set = guardian != none && claim_authority != none;
    require!(roles_are_set, CashbackError::InvalidRole);

    // G3
    let roles_are_separate = claim_authority != vault.admin && claim_authority != guardian;
    require!(roles_are_separate, CashbackError::RoleConflict);

    // G4 (SEC-5)
    let caps_ok = caps_are_valid(max_per_claim, max_per_day);
    require!(caps_ok, CashbackError::InvalidCaps);

    vault.guardian = guardian;
    vault.claim_authority = claim_authority;
    vault.max_per_claim = max_per_claim;
    vault.max_per_day = max_per_day;
    Ok(())
}
