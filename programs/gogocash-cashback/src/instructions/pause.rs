//! `pause` (docs/CONTRACT.md 3.3.3): the admin or the guardian blocks
//! `claim`. Idempotent, so the guardian's emergency pause never fails
//! because of state (D-P7). No CPI, no event.

use anchor_lang::prelude::*;

use crate::errors::CashbackError;
use crate::state::Vault;

/// Accounts of `pause`, in contract order.
#[derive(Accounts)]
pub struct Pause<'info> {
    /// The vault to pause.
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    /// The admin or the guardian (P1).
    pub authority: Signer<'info>,
}

/// Handler check P1, then the effect.
pub(crate) fn handler(ctx: Context<Pause>) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    let vault = &mut ctx.accounts.vault;

    // P1
    let may_pause = authority == vault.admin || authority == vault.guardian;
    require!(may_pause, CashbackError::NotAdminOrGuardian);

    vault.paused = true;
    Ok(())
}
