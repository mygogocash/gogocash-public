//! GoGoCash cashback program, contract v0.
//!
//! Pays approved shopping-cashback payouts in USDC (classic SPL Token) from
//! one vault per mint, exactly once per payout id. `docs/CONTRACT.md` section 3
//! is normative for everything here: the account layouts (3.2), the eight
//! instructions with their accounts and the order of their checks (3.3), the
//! `PayoutClaimed` event (3.4) and the error table 6000-6023 (3.5). All of it
//! is append-only (3.9).
//!
//! Roles: the loader-v3 upgrade authority may `initialize` a vault; the admin
//! configures, unpauses, withdraws and hands over the admin role in two steps
//! (`propose_admin`, then `accept_admin`); the guardian may only `pause`; the
//! claim authority co-signs `claim`. The claim authority must never be the
//! admin or the guardian.
//!
//! Every business check runs in the handler in the contract's order and maps
//! to exactly one error code; account structs use only Anchor's type, `mut`,
//! `seeds`, `init` and `associated_token` constraints (CONTRACT.md D-P3).
//! Build and CI: `docs/BUILD.md`.

use anchor_lang::prelude::*;
#[cfg(not(feature = "no-entrypoint"))]
use solana_security_txt::security_txt;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

pub use errors::*;
pub use events::*;
pub use instructions::*;
pub use state::*;

// Contract v0 assigns no mainnet program id (docs/CONTRACT.md 2.4, D-P13).
#[cfg(feature = "mainnet")]
compile_error!("contract v0 has no mainnet program id (CONTRACT.md 2.4)");

// Placeholder program id. Nobody holds its private key: it is
// base58(sha256("gogocash_cashback placeholder program id v0")), so it can
// never be deployed to. Replace it with the real program address before any
// deployment.
declare_id!("HWNF2cvXybfAjLbw2pydi7sNFmTfYBjpEWNtY3BJfCje");

// The status the ticket requires in security.txt (#2980): unaudited, devnet
// only, the source repository and a contact.
#[cfg(not(feature = "no-entrypoint"))]
security_txt! {
    name: "gogocash_cashback (devnet only, contract v0)",
    project_url: "https://github.com/mygogocash/gogocash-public",
    contacts: "email:support@gogocash.co",
    policy: "https://github.com/mygogocash/gogocash-public/blob/main/SECURITY.md",
    preferred_languages: "en",
    source_code: "https://github.com/mygogocash/gogocash-public",
    auditors: "None: unaudited, devnet only. Do not use it to hold real funds."
}

/// The eight v0 instructions, declared in contract order (CONTRACT.md 3.3).
#[program]
pub mod gogocash_cashback {
    use super::*;

    /// Creates the vault for one mint, paused. Upgrade authority only.
    pub fn initialize(
        ctx: Context<Initialize>,
        admin: Pubkey,
        guardian: Pubkey,
        claim_authority: Pubkey,
        max_per_claim: u64,
        max_per_day: u64,
    ) -> Result<()> {
        instructions::initialize::handler(
            ctx,
            admin,
            guardian,
            claim_authority,
            max_per_claim,
            max_per_day,
        )
    }

    /// Pays one approved payout exactly once and writes its receipt.
    pub fn claim(
        ctx: Context<Claim>,
        payout_id: [u8; 32],
        amount: u64,
        expires_at: i64,
    ) -> Result<()> {
        instructions::claim::handler(ctx, payout_id, amount, expires_at)
    }

    /// Blocks `claim`. Admin or guardian; idempotent.
    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        instructions::pause::handler(ctx)
    }

    /// Re-enables `claim`. Admin only; idempotent.
    pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
        instructions::unpause::handler(ctx)
    }

    /// Replaces the guardian, the claim authority and both caps. Admin only.
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        guardian: Pubkey,
        claim_authority: Pubkey,
        max_per_claim: u64,
        max_per_day: u64,
    ) -> Result<()> {
        instructions::update_config::handler(
            ctx,
            guardian,
            claim_authority,
            max_per_claim,
            max_per_day,
        )
    }

    /// Proposes a new admin; the default key cancels. Admin only.
    pub fn propose_admin(ctx: Context<ProposeAdmin>, new_admin: Pubkey) -> Result<()> {
        instructions::propose_admin::handler(ctx, new_admin)
    }

    /// Completes the admin handover. Pending admin only.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::accept_admin::handler(ctx)
    }

    /// Moves float out of the vault to an admin-owned token account.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::withdraw::handler(ctx, amount)
    }
}
