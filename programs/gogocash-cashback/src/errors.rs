//! Program error table (docs/CONTRACT.md 3.5).
//!
//! Anchor numbers these from 6000 in declaration order, so the order below
//! is the contract. Codes never change number, name, meaning or class; new
//! codes are appended from 6024 and a removed check leaves its code reserved
//! (CONTRACT.md 3.9). Clients classify by number and instruction index, never
//! by message text.

use anchor_lang::prelude::*;

/// Custom errors of `gogocash_cashback`. The doc line of each variant names
/// the check that raises it and its off-chain class.
#[error_code]
pub enum CashbackError {
    /// 6000. claim C1. Class: hold.
    #[msg("Vault is paused")]
    Paused,
    /// 6001. claim C2. Class: config.
    #[msg("Signer is not the vault claim authority")]
    InvalidClaimAuthority,
    /// 6002. unpause U1, update_config G1, propose_admin A1, withdraw W1. Class: bug.
    #[msg("Signer is not the vault admin")]
    NotAdmin,
    /// 6003. pause P1. Class: bug.
    #[msg("Signer is neither the vault admin nor the guardian")]
    NotAdminOrGuardian,
    /// 6004. accept_admin B1. Class: bug.
    #[msg("Signer is not the pending admin")]
    NotPendingAdmin,
    /// 6005. initialize I2. Class: config.
    #[msg("Signer is not the program upgrade authority")]
    NotUpgradeAuthority,
    /// 6006. initialize I1. Class: bug.
    #[msg("Account is not this program's ProgramData account")]
    InvalidProgramData,
    /// 6007. initialize I5, update_config G2. Class: bug.
    #[msg("Role must not be the default public key")]
    InvalidRole,
    /// 6008. claim C6. Class: bug.
    #[msg("Payout id must not be all zero bytes")]
    ZeroPayoutId,
    /// 6009. claim C7, withdraw W4. Class: bug.
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    /// 6010. claim C8. Class: needs_review.
    #[msg("Amount exceeds the per-claim cap")]
    ExceedsMaxPerClaim,
    /// 6011. claim C10. Class: hold.
    #[msg("Claim would exceed the daily cap")]
    DayCapExceeded,
    /// 6012. claim C11. Class: retry.
    #[msg("Claim has expired")]
    Expired,
    /// 6013. claim C12. Class: bug.
    #[msg("Claim expiry is more than 900 seconds ahead")]
    ExpiryTooFar,
    /// 6014. claim C13, withdraw W6. Class: hold (plus CRITICAL and the halt latch).
    #[msg("Vault token account is frozen")]
    VaultTokenAccountFrozen,
    /// 6015. claim C14. Class: needs_review.
    #[msg("Recipient token account is frozen")]
    RecipientTokenAccountFrozen,
    /// 6016. claim C15, withdraw W7. Class: hold.
    #[msg("Vault balance is below the amount")]
    InsufficientVaultBalance,
    /// 6017. claim C5. Class: needs_review.
    #[msg("Recipient must not be the vault, the claim authority or the payer")]
    InvalidRecipient,
    /// 6018. initialize I4, claim C4, withdraw W3. Class: config.
    #[msg("Vault token account is not canonical or has a delegate or close authority")]
    InvalidVaultTokenAccount,
    /// 6019. initialize I3, claim C3, withdraw W2. Class: config.
    #[msg("Mint is not the vault mint or does not have 6 decimals")]
    InvalidMint,
    /// 6020. initialize I6, update_config G3, propose_admin A2, accept_admin B2. Class: bug.
    #[msg("Claim authority must not also be the admin or the guardian")]
    RoleConflict,
    /// 6021. initialize I7, update_config G4. Class: bug.
    #[msg("Caps must be non-zero and max_per_claim must not exceed max_per_day")]
    InvalidCaps,
    /// 6022. withdraw W5. Class: bug.
    #[msg("Withdraw destination must be an unfrozen vault-mint token account owned by the admin")]
    InvalidWithdrawDestination,
    /// 6023. claim C9, C12 and the effects; withdraw W8. Class: bug.
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
