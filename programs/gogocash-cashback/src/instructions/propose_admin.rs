//! `propose_admin` (docs/CONTRACT.md 3.3.6): first step of the two-step admin
//! handover. Passing the default key cancels a pending proposal (D-P8).

use anchor_lang::prelude::*;

use crate::errors::CashbackError;
use crate::state::Vault;

/// Accounts of `propose_admin` (as `unpause`), in contract order.
#[derive(Accounts)]
pub struct ProposeAdmin<'info> {
    /// The vault whose admin is being handed over.
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    /// Must be the vault admin (A1).
    pub admin: Signer<'info>,
}

/// Handler checks A1 and A2 in contract order, then the effect.
pub(crate) fn handler(ctx: Context<ProposeAdmin>, new_admin: Pubkey) -> Result<()> {
    let admin = ctx.accounts.admin.key();
    let vault = &mut ctx.accounts.vault;

    // A1
    require!(admin == vault.admin, CashbackError::NotAdmin);

    // A2: only a real proposal can conflict; the default key cancels.
    let cancels = new_admin == Pubkey::default();
    let conflicts = !cancels && new_admin == vault.claim_authority;
    require!(!conflicts, CashbackError::RoleConflict);

    vault.pending_admin = new_admin;
    Ok(())
}
