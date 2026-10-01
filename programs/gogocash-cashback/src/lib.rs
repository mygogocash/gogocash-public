//! GoGoCash cashback program.
//!
//! R1 stub: one `ping` instruction that logs a fixed message. It exists so CI
//! can prove the SBPFv3 build, the embedded security.txt and the LiteSVM
//! harness end to end. The cashback logic itself lands in R2.

use anchor_lang::prelude::*;
#[cfg(not(feature = "no-entrypoint"))]
use solana_security_txt::security_txt;

// Placeholder program id. Nobody holds its private key: it is
// base58(sha256("gogocash_cashback placeholder program id v0")), so it can
// never be deployed to. Replace it with the real program address before any
// deployment.
declare_id!("HWNF2cvXybfAjLbw2pydi7sNFmTfYBjpEWNtY3BJfCje");

#[cfg(not(feature = "no-entrypoint"))]
security_txt! {
    name: "gogocash_cashback",
    project_url: "https://github.com/mygogocash/gogocash-public",
    contacts: "email:support@gogocash.co",
    policy: "https://github.com/mygogocash/gogocash-public/blob/main/SECURITY.md",
    source_code: "https://github.com/mygogocash/gogocash-public"
}

#[program]
pub mod gogocash_cashback {
    use super::*;

    /// Health check: logs a fixed message and touches no accounts.
    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        msg!("gogocash_cashback: ping v0");
        Ok(())
    }
}

/// `ping` takes no accounts.
#[derive(Accounts)]
pub struct Ping {}
