//! Account layouts (docs/CONTRACT.md 3.2) and the shared constants and pure
//! helpers the instruction handlers use.
//!
//! Both layouts are append-only (CONTRACT.md 3.9): sizes and existing offsets
//! never change. New Vault fields are carved from the front of `reserved`, and
//! their all-zero value must mean "v0 behavior". The Receipt has no reserved
//! bytes. The compile-time assertions at the bottom pin both sizes.

use anchor_lang::prelude::*;

/// Seed prefix of the Vault PDA `["vault", mint]`.
pub const VAULT_SEED: &[u8] = b"vault";

/// Seed prefix of the Receipt PDA `["receipt", vault, payout_id]`.
pub const RECEIPT_SEED: &[u8] = b"receipt";

/// Vault layout version written by `initialize` in v0.
pub const VAULT_VERSION: u8 = 1;

/// The only mint decimals `initialize` accepts (USDC; CONTRACT.md D-P6).
pub const REQUIRED_MINT_DECIMALS: u8 = 6;

/// Furthest `claim.expires_at` may lie after `now`, in seconds (claim C12).
pub const MAX_EXPIRY_SECONDS: i64 = 900;

/// Length of one UTC day in seconds.
pub const SECONDS_PER_DAY: i64 = 86_400;

/// UTC day number of a unix timestamp: `t.div_euclid(86_400)`
/// (CONTRACT.md 3.1). 2026-10-02 is day 20728.
pub fn day(unix_timestamp: i64) -> i64 {
    unix_timestamp.div_euclid(SECONDS_PER_DAY)
}

/// Byte-slice equality usable in `const` assertions (slice `==` is not
/// `const`). Used to pin every discriminator to its contract value.
pub const fn bytes_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut i = 0;
    while i < left.len() {
        if left[i] != right[i] {
            return false;
        }
        i += 1;
    }
    true
}

/// The cap rule shared by `initialize` I7 and `update_config` G4: both caps
/// are non-zero and the per-claim cap does not exceed the daily cap.
pub fn caps_are_valid(max_per_claim: u64, max_per_day: u64) -> bool {
    max_per_claim != 0 && max_per_day != 0 && max_per_claim <= max_per_day
}

/// One vault per mint: PDA `["vault", mint]`, 324 bytes.
///
/// Field order is the Borsh order and therefore the byte layout of
/// CONTRACT.md 3.2; do not reorder.
#[account]
#[derive(InitSpace)]
pub struct Vault {
    /// Layout version. `1` in v0.
    pub version: u8,
    /// Canonical bump of `["vault", mint]`.
    pub bump: u8,
    /// `true` blocks `claim` only.
    pub paused: bool,
    /// Mint decimals copied at `initialize`; always 6.
    pub decimals: u8,
    /// Configured USDC mint.
    pub mint: Pubkey,
    /// Canonical associated token account of (vault, mint, classic Token).
    pub vault_token_account: Pubkey,
    /// Admin (later the Squads vault).
    pub admin: Pubkey,
    /// Proposed admin; the default key means none.
    pub pending_admin: Pubkey,
    /// May pause only.
    pub guardian: Pubkey,
    /// Worker hot key that co-signs `claim`.
    pub claim_authority: Pubkey,
    /// Atomic USDC cap per claim.
    pub max_per_claim: u64,
    /// Atomic USDC cap per UTC day.
    pub max_per_day: u64,
    /// `day(now)` of the bucket `claimed_today` counts.
    pub current_day: i64,
    /// Atomic USDC claimed in `current_day`.
    pub claimed_today: u64,
    /// Lifetime atomic USDC claimed.
    pub total_claimed: u64,
    /// Lifetime number of successful claims (equals receipts created).
    pub claim_count: u64,
    /// Lifetime atomic USDC moved out by `withdraw`.
    pub total_withdrawn: u64,
    /// Zero at `initialize`. Not interpreted in v0.
    pub reserved: [u8; 64],
}

impl Vault {
    /// Account size including the 8-byte discriminator (CONTRACT.md 3.2).
    pub const LEN: usize = 324;
}

/// Proof that one payout was paid: PDA `["receipt", vault, payout_id]`,
/// 89 bytes, permanent (there is no close instruction).
///
/// Field order is the Borsh order and therefore the byte layout of
/// CONTRACT.md 3.2; do not reorder.
#[account]
#[derive(InitSpace)]
pub struct Receipt {
    /// Canonical bump of `["receipt", vault, payout_id]`.
    pub bump: u8,
    /// The 32 random bytes issued by the API at challenge time.
    pub payout_id: [u8; 32],
    /// Wallet (system account) that received the USDC.
    pub recipient: Pubkey,
    /// Atomic USDC transferred.
    pub amount: u64,
    /// `now` at execution.
    pub claimed_at: i64,
}

impl Receipt {
    /// Account size including the 8-byte discriminator (CONTRACT.md 3.2).
    pub const LEN: usize = 89;
}

/// `account:Vault` discriminator from CONTRACT.md 3.2.
const VAULT_DISCRIMINATOR: [u8; 8] = [211, 8, 232, 43, 2, 152, 117, 119];

/// `account:Receipt` discriminator from CONTRACT.md 3.2.
const RECEIPT_DISCRIMINATOR: [u8; 8] = [39, 154, 73, 106, 80, 102, 145, 153];

// Frozen discriminators and sizes (CONTRACT.md 3.2 and 3.9). A rename or a
// layout change that moves any of these fails the build instead of shipping
// a wrong account.
const _: () = if !bytes_eq(Vault::DISCRIMINATOR, &VAULT_DISCRIMINATOR) {
    panic!("Vault discriminator differs from CONTRACT.md 3.2");
};
const _: () = if !bytes_eq(Receipt::DISCRIMINATOR, &RECEIPT_DISCRIMINATOR) {
    panic!("Receipt discriminator differs from CONTRACT.md 3.2");
};
const _: () = if Vault::LEN != 324 || Vault::LEN != 8 + Vault::INIT_SPACE {
    panic!("Vault must be 324 bytes including the discriminator");
};
const _: () = if Receipt::LEN != 89 || Receipt::LEN != 8 + Receipt::INIT_SPACE {
    panic!("Receipt must be 89 bytes including the discriminator");
};
