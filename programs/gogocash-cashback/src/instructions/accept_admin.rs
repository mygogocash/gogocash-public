//! `accept_admin` (docs/CONTRACT.md 3.3.7): second step of the two-step admin
//! handover. The proposed admin signs to take over.

use anchor_lang::prelude::*;

use crate::errors::CashbackError;
use crate::state::Vault;

/// Accounts of `accept_admin`, in contract order.
#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    /// The vault whose admin is being handed over.
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    /// Must be the pending admin (B1).
    pub new_admin: Signer<'info>,
}

/// Handler checks B1 and B2 in contract order, then the effect.
pub(crate) fn handler(ctx: Context<AcceptAdmin>) -> Result<()> {
    let new_admin = ctx.accounts.new_admin.key();
    let vault = &mut ctx.accounts.vault;

    // B1
    let has_proposal = vault.pending_admin != Pubkey::default();
    let is_pending_admin = has_proposal && new_admin == vault.pending_admin;
    require!(is_pending_admin, CashbackError::NotPendingAdmin);

    // B2: re-checked because `update_config` may have run since the proposal.
    let conflicts = new_admin == vault.claim_authority;
    require!(!conflicts, CashbackError::RoleConflict);

    vault.admin = new_admin;
    vault.pending_admin = Pubkey::default();
    Ok(())
}
