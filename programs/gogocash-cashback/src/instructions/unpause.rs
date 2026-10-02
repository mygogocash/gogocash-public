//! `unpause` (docs/CONTRACT.md 3.3.4): the admin re-enables `claim`.
//! Idempotent. The guardian cannot unpause. No CPI, no event.

use anchor_lang::prelude::*;

use crate::errors::CashbackError;
use crate::state::Vault;

/// Accounts of `unpause`, in contract order.
#[derive(Accounts)]
pub struct Unpause<'info> {
    /// The vault to unpause.
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    /// Must be the vault admin (U1).
    pub admin: Signer<'info>,
}

/// Handler check U1, then the effect.
pub(crate) fn handler(ctx: Context<Unpause>) -> Result<()> {
    let admin = ctx.accounts.admin.key();
    let vault = &mut ctx.accounts.vault;

    // U1
    require!(admin == vault.admin, CashbackError::NotAdmin);

    vault.paused = false;
    Ok(())
}
