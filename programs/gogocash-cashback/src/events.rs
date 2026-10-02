//! The program's only event (docs/CONTRACT.md 3.4).
//!
//! Emitted with `emit!`, so it is one `Program data: <base64>` log line whose
//! payload is the 8-byte discriminator followed by the Borsh fields: 184
//! bytes. Logs can be truncated, so settlement never depends on it; the
//! finalized Receipt account is the only proof of payment (CONTRACT.md 3.8).
//! Fields are never reordered or removed; new fields are appended only.

use anchor_lang::prelude::*;

use crate::state::bytes_eq;

/// `event:PayoutClaimed` discriminator from CONTRACT.md 3.4.
const DISC: [u8; 8] = [200, 39, 105, 112, 116, 63, 58, 149];

/// Emitted by `claim` after the transfer.
#[event]
pub struct PayoutClaimed {
    /// Vault the payout came from.
    pub vault: Pubkey,
    /// Receipt created for this payout.
    pub receipt: Pubkey,
    /// The payout id the receipt is derived from.
    pub payout_id: [u8; 32],
    /// Wallet that received the USDC.
    pub recipient: Pubkey,
    /// Atomic USDC transferred.
    pub amount: u64,
    /// `now` at execution.
    pub claimed_at: i64,
    /// `current_day` after the claim.
    pub day: i64,
    /// `claimed_today` after the claim.
    pub claimed_today: u64,
    /// `claim_count` after the claim.
    pub claim_count: u64,
    /// `total_claimed` after the claim.
    pub total_claimed: u64,
}

const _: () = if !bytes_eq(PayoutClaimed::DISCRIMINATOR, &DISC) {
    panic!("PayoutClaimed discriminator differs from CONTRACT.md");
};
