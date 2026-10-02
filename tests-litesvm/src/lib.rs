//! Shared fixtures for the gogocash_cashback LiteSVM suite.
//!
//! Everything here is written from the frozen interface of contract v0
//! (docs/CONTRACT.md section 3) only: instruction names and order, Borsh
//! arguments, account order and flags, discriminators, account layouts and
//! error codes. Nothing reads the program source.
//!
//! The suite never builds the program. It loads a prebuilt SBF artifact so CI
//! tests exactly the bytes it built and checked (`anchor build` output or the
//! `solana-verify build` output).
//!
//! No key material exists in this crate. Every signer is an ephemeral
//! in-memory `Keypair::new()`, and the program id stays the keyless
//! placeholder.

// LiteSVM's TransactionResult carries a ~200-byte FailedTransactionMetadata
// by value. That is LiteSVM's API, not ours; litesvm v0.16.0 allows this lint
// workspace-wide for the same reason.
#![allow(clippy::result_large_err)]

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::PathBuf;
use std::sync::OnceLock;

use litesvm::types::FailedTransactionMetadata;
use litesvm::types::TransactionMetadata;
use litesvm::types::TransactionResult;
use litesvm::LiteSVM;
use sha2::Digest;
use sha2::Sha256;
use solana_account::Account;
use solana_address::address;
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::error::InstructionError;
use solana_instruction::AccountMeta;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;

// ---------------------------------------------------------------------------
// Program artifact
// ---------------------------------------------------------------------------

/// Environment variable that names the program artifact under test.
pub const SO_PATH_ENV: &str = "GOGOCASH_CASHBACK_SO";

/// Environment variable that, when set, names the file the compute-unit
/// report is written to (JSON, see [`CuReport`]).
pub const CU_REPORT_ENV: &str = "GOGOCASH_CU_REPORT";

/// Marker that solana-security-txt writes at the start of the embedded file.
pub const SECURITY_TXT_BEGIN: &[u8] = b"=======BEGIN SECURITY.TXT V1=======\0";

/// Offset of `e_flags` in an ELF64 header; SBF stores the SBPF version there.
pub const ELF64_E_FLAGS_OFFSET: usize = 48;

/// SBPF version the build must target (`--arch v3`).
pub const EXPECTED_SBPF_VERSION: u32 = 3;

/// Default artifact location, relative to this crate's directory.
pub const DEFAULT_SO_PATH: &str = "../target/deploy/gogocash_cashback.so";

/// Artifact path: `$GOGOCASH_CASHBACK_SO` when set, otherwise
/// [`DEFAULT_SO_PATH`]. A relative value is resolved
/// against this crate's directory, so the result does not depend on the
/// directory cargo was started from.
pub fn program_so_path() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    match std::env::var_os(SO_PATH_ENV) {
        Some(path) => manifest_dir.join(path),
        None => manifest_dir.join(DEFAULT_SO_PATH),
    }
}

/// Reads the program artifact, panicking with the path and the override hint.
pub fn read_program() -> Vec<u8> {
    let path = program_so_path();
    match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(err) => panic!("cannot read {} ({SO_PATH_ENV}): {err}", path.display()),
    }
}

static PROGRAM_BYTES: OnceLock<Vec<u8>> = OnceLock::new();

/// The artifact bytes, read once per test binary.
pub fn program_bytes() -> &'static [u8] {
    PROGRAM_BYTES.get_or_init(read_program)
}

/// Lowercase hex SHA-256 of `bytes` (used to tie the CU report to the binary).
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex_encode(&Sha256::digest(bytes))
}

/// Returns `e_flags` of an ELF64 little-endian image, or `None` for anything
/// that is not one.
pub fn elf64_le_e_flags(elf: &[u8]) -> Option<u32> {
    if elf.len() < 64 || !elf.starts_with(b"\x7fELF") {
        return None;
    }
    // EI_CLASS must be ELFCLASS64 (2) and EI_DATA must be ELFDATA2LSB (1).
    if elf[4] != 2 || elf[5] != 1 {
        return None;
    }
    let end = ELF64_E_FLAGS_OFFSET + 4;
    let field: [u8; 4] = elf[ELF64_E_FLAGS_OFFSET..end].try_into().ok()?;
    Some(u32::from_le_bytes(field))
}

/// True when `needle` is non-empty and occurs somewhere in `bytes`.
pub fn contains_bytes(bytes: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && bytes.windows(needle.len()).any(|w| w == needle)
}

// ---------------------------------------------------------------------------
// Addresses (contract §2.2, §2.4)
// ---------------------------------------------------------------------------

/// Placeholder program id with no known private key:
/// base58(sha256("gogocash_cashback placeholder program id v0")).
/// Must equal `declare_id!` in programs/gogocash-cashback/src/lib.rs.
pub const PROGRAM_ID: Address = address!("HWNF2cvXybfAjLbw2pydi7sNFmTfYBjpEWNtY3BJfCje");

/// Classic SPL Token, the only token program contract v0 accepts.
pub const TOKEN_PROGRAM_ID: Address = address!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/// Token-2022, refused everywhere in contract v0.
pub const TOKEN_2022_PROGRAM_ID: Address = address!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/// Associated Token Account program.
pub const ATA_PROGRAM_ID: Address = address!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/// System program.
pub const SYSTEM_PROGRAM_ID: Address = address!("11111111111111111111111111111111");

/// BPF Loader Upgradeable (loader-v3).
pub const LOADER_V3_ID: Address = address!("BPFLoaderUpgradeab1e11111111111111111111111");

/// A fresh random address that nobody holds a key for in this process.
pub fn random_address() -> Address {
    Keypair::new().pubkey()
}

/// 32 fresh random bytes, used as a payout id.
pub fn random_payout_id() -> [u8; 32] {
    random_address().to_bytes()
}

// ---------------------------------------------------------------------------
// Discriminators (contract §3.1, §3.2, §3.3, §3.4)
// ---------------------------------------------------------------------------

/// The 8 v0 instructions, in their frozen `#[program]` order.
pub const INSTRUCTION_NAMES: [&str; 8] = [
    "initialize",
    "claim",
    "pause",
    "unpause",
    "update_config",
    "propose_admin",
    "accept_admin",
    "withdraw",
];

/// Instruction discriminators as published in §3.3, in [`INSTRUCTION_NAMES`]
/// order. Unit tests recompute each one from `sha256("global:<name>")`.
pub const INSTRUCTION_DISCRIMINATORS: [[u8; 8]; 8] = [
    [175, 175, 109, 31, 13, 152, 155, 237],
    [62, 198, 214, 193, 213, 159, 108, 210],
    [211, 22, 221, 251, 74, 121, 193, 47],
    [169, 144, 4, 38, 10, 141, 188, 255],
    [29, 158, 252, 191, 10, 83, 219, 99],
    [121, 214, 199, 212, 87, 39, 117, 234],
    [112, 42, 45, 90, 116, 181, 13, 170],
    [183, 18, 70, 156, 148, 109, 161, 34],
];

/// Borsh data length of each instruction (discriminator plus arguments), in
/// [`INSTRUCTION_NAMES`] order (§3.3).
pub const INSTRUCTION_DATA_LENS: [usize; 8] = [120, 56, 8, 8, 88, 40, 8, 16];

/// `account:Vault` discriminator (§3.2).
pub const VAULT_DISCRIMINATOR: [u8; 8] = [211, 8, 232, 43, 2, 152, 117, 119];

/// `account:Receipt` discriminator (§3.2).
pub const RECEIPT_DISCRIMINATOR: [u8; 8] = [39, 154, 73, 106, 80, 102, 145, 153];

/// `event:PayoutClaimed` discriminator (§3.4).
pub const PAYOUT_CLAIMED_DISCRIMINATOR: [u8; 8] = [200, 39, 105, 112, 116, 63, 58, 149];

/// Discriminator of the R1 `ping` stub, which contract v0 removes.
pub const PING_DISCRIMINATOR: [u8; 8] = [173, 0, 94, 236, 73, 133, 225, 153];

/// First 8 bytes of `sha256(preimage)`, the Anchor 1.2.0 discriminator rule.
pub fn discriminator(preimage: &str) -> [u8; 8] {
    let digest = Sha256::digest(preimage.as_bytes());
    let mut out = [0u8; 8];
    out.copy_from_slice(&digest[..8]);
    out
}

/// Discriminator of instruction `name`: `sha256("global:<name>")[..8]`.
pub fn instruction_discriminator(name: &str) -> [u8; 8] {
    discriminator(&format!("global:{name}"))
}

// ---------------------------------------------------------------------------
// Account and event layouts (contract §3.2, §3.4)
// ---------------------------------------------------------------------------

/// Vault account size, discriminator included.
pub const VAULT_SIZE: usize = 324;

/// Receipt account size, discriminator included.
pub const RECEIPT_SIZE: usize = 89;

/// `PayoutClaimed` payload size, discriminator included.
pub const PAYOUT_CLAIMED_SIZE: usize = 184;

/// Byte offsets of the Vault fields (§3.2).
pub mod vault_offset {
    pub const VERSION: usize = 8;
    pub const BUMP: usize = 9;
    pub const PAUSED: usize = 10;
    pub const DECIMALS: usize = 11;
    pub const MINT: usize = 12;
    pub const VAULT_TOKEN_ACCOUNT: usize = 44;
    pub const ADMIN: usize = 76;
    pub const PENDING_ADMIN: usize = 108;
    pub const GUARDIAN: usize = 140;
    pub const CLAIM_AUTHORITY: usize = 172;
    pub const MAX_PER_CLAIM: usize = 204;
    pub const MAX_PER_DAY: usize = 212;
    pub const CURRENT_DAY: usize = 220;
    pub const CLAIMED_TODAY: usize = 228;
    pub const TOTAL_CLAIMED: usize = 236;
    pub const CLAIM_COUNT: usize = 244;
    pub const TOTAL_WITHDRAWN: usize = 252;
    pub const RESERVED: usize = 260;
}

/// Reads `N` bytes at `offset`, or `None` when the slice is too short.
pub fn read_array<const N: usize>(data: &[u8], offset: usize) -> Option<[u8; N]> {
    let end = offset.checked_add(N)?;
    let slice = data.get(offset..end)?;
    slice.try_into().ok()
}

/// Reads a `u8` at `offset`.
pub fn read_u8(data: &[u8], offset: usize) -> Option<u8> {
    data.get(offset).copied()
}

/// Reads a Borsh `bool` at `offset`; any byte other than 0 or 1 is a decode
/// error (§3.1).
pub fn read_bool(data: &[u8], offset: usize) -> Option<bool> {
    match read_u8(data, offset)? {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    }
}

/// Reads a little-endian `u64` at `offset`.
pub fn read_u64(data: &[u8], offset: usize) -> Option<u64> {
    read_array::<8>(data, offset).map(u64::from_le_bytes)
}

/// Reads a little-endian `i64` at `offset`.
pub fn read_i64(data: &[u8], offset: usize) -> Option<i64> {
    read_array::<8>(data, offset).map(i64::from_le_bytes)
}

/// Reads a 32-byte public key at `offset`.
pub fn read_address(data: &[u8], offset: usize) -> Option<Address> {
    read_array::<32>(data, offset).map(Address::new_from_array)
}

/// Decoded Vault account (§3.2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultState {
    pub discriminator: [u8; 8],
    pub version: u8,
    pub bump: u8,
    pub paused: bool,
    pub decimals: u8,
    pub mint: Address,
    pub vault_token_account: Address,
    pub admin: Address,
    pub pending_admin: Address,
    pub guardian: Address,
    pub claim_authority: Address,
    pub max_per_claim: u64,
    pub max_per_day: u64,
    pub current_day: i64,
    pub claimed_today: u64,
    pub total_claimed: u64,
    pub claim_count: u64,
    pub total_withdrawn: u64,
    pub reserved: [u8; 64],
}

impl VaultState {
    /// Decodes a Vault account. `None` unless the data is exactly 324 bytes,
    /// starts with the Vault discriminator and `paused` is 0 or 1.
    pub fn decode(data: &[u8]) -> Option<Self> {
        if data.len() != VAULT_SIZE {
            return None;
        }
        let discriminator = read_array::<8>(data, 0)?;
        if discriminator != VAULT_DISCRIMINATOR {
            return None;
        }
        Some(Self {
            discriminator,
            version: read_u8(data, vault_offset::VERSION)?,
            bump: read_u8(data, vault_offset::BUMP)?,
            paused: read_bool(data, vault_offset::PAUSED)?,
            decimals: read_u8(data, vault_offset::DECIMALS)?,
            mint: read_address(data, vault_offset::MINT)?,
            vault_token_account: read_address(data, vault_offset::VAULT_TOKEN_ACCOUNT)?,
            admin: read_address(data, vault_offset::ADMIN)?,
            pending_admin: read_address(data, vault_offset::PENDING_ADMIN)?,
            guardian: read_address(data, vault_offset::GUARDIAN)?,
            claim_authority: read_address(data, vault_offset::CLAIM_AUTHORITY)?,
            max_per_claim: read_u64(data, vault_offset::MAX_PER_CLAIM)?,
            max_per_day: read_u64(data, vault_offset::MAX_PER_DAY)?,
            current_day: read_i64(data, vault_offset::CURRENT_DAY)?,
            claimed_today: read_u64(data, vault_offset::CLAIMED_TODAY)?,
            total_claimed: read_u64(data, vault_offset::TOTAL_CLAIMED)?,
            claim_count: read_u64(data, vault_offset::CLAIM_COUNT)?,
            total_withdrawn: read_u64(data, vault_offset::TOTAL_WITHDRAWN)?,
            reserved: read_array::<64>(data, vault_offset::RESERVED)?,
        })
    }
}

/// Decoded Receipt account (§3.2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReceiptState {
    pub discriminator: [u8; 8],
    pub bump: u8,
    pub payout_id: [u8; 32],
    pub recipient: Address,
    pub amount: u64,
    pub claimed_at: i64,
}

impl ReceiptState {
    /// Decodes a Receipt account. `None` unless the data is exactly 89 bytes
    /// and starts with the Receipt discriminator (§3.8 step 4).
    pub fn decode(data: &[u8]) -> Option<Self> {
        if data.len() != RECEIPT_SIZE {
            return None;
        }
        let discriminator = read_array::<8>(data, 0)?;
        if discriminator != RECEIPT_DISCRIMINATOR {
            return None;
        }
        Some(Self {
            discriminator,
            bump: read_u8(data, 8)?,
            payout_id: read_array::<32>(data, 9)?,
            recipient: read_address(data, 41)?,
            amount: read_u64(data, 73)?,
            claimed_at: read_i64(data, 81)?,
        })
    }
}

/// Decoded `PayoutClaimed` event (§3.4).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PayoutClaimed {
    pub vault: Address,
    pub receipt: Address,
    pub payout_id: [u8; 32],
    pub recipient: Address,
    pub amount: u64,
    pub claimed_at: i64,
    pub day: i64,
    pub claimed_today: u64,
    pub claim_count: u64,
    pub total_claimed: u64,
}

impl PayoutClaimed {
    /// Decodes an event payload. Trailing bytes are ignored (§3.9 rule 5).
    pub fn decode(data: &[u8]) -> Option<Self> {
        if data.len() < PAYOUT_CLAIMED_SIZE {
            return None;
        }
        if read_array::<8>(data, 0)? != PAYOUT_CLAIMED_DISCRIMINATOR {
            return None;
        }
        Some(Self {
            vault: read_address(data, 8)?,
            receipt: read_address(data, 40)?,
            payout_id: read_array::<32>(data, 72)?,
            recipient: read_address(data, 104)?,
            amount: read_u64(data, 136)?,
            claimed_at: read_i64(data, 144)?,
            day: read_i64(data, 152)?,
            claimed_today: read_u64(data, 160)?,
            claim_count: read_u64(data, 168)?,
            total_claimed: read_u64(data, 176)?,
        })
    }
}

/// Prefix of the log line `emit!` produces (`sol_log_data`).
pub const PROGRAM_DATA_LOG_PREFIX: &str = "Program data: ";

/// Every `PayoutClaimed` event found in `logs`.
pub fn payout_claimed_events(logs: &[String]) -> Vec<PayoutClaimed> {
    let mut events = Vec::new();
    for line in logs {
        let Some(encoded) = line.strip_prefix(PROGRAM_DATA_LOG_PREFIX) else {
            continue;
        };
        let Some(bytes) = base64_decode(encoded) else {
            continue;
        };
        if let Some(event) = PayoutClaimed::decode(&bytes) {
            events.push(event);
        }
    }
    events
}

// ---------------------------------------------------------------------------
// Errors (contract §3.5, §3.6, §3.7)
// ---------------------------------------------------------------------------

/// Program error codes 6000-6023 (§3.5).
pub mod code {
    pub const PAUSED: u32 = 6000;
    pub const INVALID_CLAIM_AUTHORITY: u32 = 6001;
    pub const NOT_ADMIN: u32 = 6002;
    pub const NOT_ADMIN_OR_GUARDIAN: u32 = 6003;
    pub const NOT_PENDING_ADMIN: u32 = 6004;
    pub const NOT_UPGRADE_AUTHORITY: u32 = 6005;
    pub const INVALID_PROGRAM_DATA: u32 = 6006;
    pub const INVALID_ROLE: u32 = 6007;
    pub const ZERO_PAYOUT_ID: u32 = 6008;
    pub const ZERO_AMOUNT: u32 = 6009;
    pub const EXCEEDS_MAX_PER_CLAIM: u32 = 6010;
    pub const DAY_CAP_EXCEEDED: u32 = 6011;
    pub const EXPIRED: u32 = 6012;
    pub const EXPIRY_TOO_FAR: u32 = 6013;
    pub const VAULT_TOKEN_ACCOUNT_FROZEN: u32 = 6014;
    pub const RECIPIENT_TOKEN_ACCOUNT_FROZEN: u32 = 6015;
    pub const INSUFFICIENT_VAULT_BALANCE: u32 = 6016;
    pub const INVALID_RECIPIENT: u32 = 6017;
    pub const INVALID_VAULT_TOKEN_ACCOUNT: u32 = 6018;
    pub const INVALID_MINT: u32 = 6019;
    pub const ROLE_CONFLICT: u32 = 6020;
    pub const INVALID_CAPS: u32 = 6021;
    pub const INVALID_WITHDRAW_DESTINATION: u32 = 6022;
    pub const MATH_OVERFLOW: u32 = 6023;
}

/// Anchor 1.2.0 built-in error numbers the suite asserts (§3.6).
pub mod anchor_code {
    pub const INSTRUCTION_MISSING: u32 = 100;
    pub const FALLBACK_NOT_FOUND: u32 = 101;
    pub const DID_NOT_DESERIALIZE: u32 = 102;
    pub const CONSTRAINT_MUT: u32 = 2000;
    pub const CONSTRAINT_SEEDS: u32 = 2006;
    pub const CONSTRAINT_ASSOCIATED: u32 = 2009;
    pub const CONSTRAINT_TOKEN_OWNER: u32 = 2015;
    pub const DUPLICATE_MUTABLE_ACCOUNT: u32 = 2040;
    pub const ACCOUNT_DISCRIMINATOR_MISMATCH: u32 = 3002;
    pub const NOT_ENOUGH_KEYS: u32 = 3005;
    pub const OWNED_BY_WRONG_PROGRAM: u32 = 3007;
    pub const INVALID_PROGRAM_ID: u32 = 3008;
    pub const NOT_SIGNER: u32 = 3010;
    pub const NOT_SYSTEM_OWNED: u32 = 3011;
    pub const NOT_INITIALIZED: u32 = 3012;
    pub const NOT_PROGRAM_DATA: u32 = 3013;
    pub const DECLARED_PROGRAM_ID_MISMATCH: u32 = 4100;
}

/// System program `AccountAlreadyInUse` (`Custom(0)`, §3.7).
pub const SYSTEM_ALREADY_IN_USE: u32 = 0;

/// Log text that accompanies [`SYSTEM_ALREADY_IN_USE`] (open item O6).
pub const ALREADY_IN_USE_LOG: &str = "already in use";

/// Associated Token Account program `InvalidOwner` (`Custom(0)`, §3.7).
pub const ATA_INVALID_OWNER: u32 = 0;

/// First program error code.
pub const FIRST_PROGRAM_ERROR: u32 = 6000;

/// One row of the §3.5 error table.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProgramErrorSpec {
    pub code: u32,
    pub name: &'static str,
    pub message: &'static str,
}

impl ProgramErrorSpec {
    /// The part of Anchor's error log line that names this error, for example
    /// `Error Code: Paused. Error Number: 6000. Error Message: Vault is paused.`
    pub fn log_fragment(&self) -> String {
        let name = self.name;
        let code = self.code;
        let message = self.message;
        let head = format!("Error Code: {name}. Error Number: {code}.");
        format!("{head} Error Message: {message}.")
    }
}

/// Message of 6022, kept apart because the line would exceed 100 columns.
const INVALID_WITHDRAW_DESTINATION_MESSAGE: &str =
    "Withdraw destination must be an unfrozen vault-mint token account owned by the admin";

/// The §3.5 error table: exact names, codes and messages, in code order.
pub static PROGRAM_ERRORS: [ProgramErrorSpec; 24] = [
    ProgramErrorSpec {
        code: 6000,
        name: "Paused",
        message: "Vault is paused",
    },
    ProgramErrorSpec {
        code: 6001,
        name: "InvalidClaimAuthority",
        message: "Signer is not the vault claim authority",
    },
    ProgramErrorSpec {
        code: 6002,
        name: "NotAdmin",
        message: "Signer is not the vault admin",
    },
    ProgramErrorSpec {
        code: 6003,
        name: "NotAdminOrGuardian",
        message: "Signer is neither the vault admin nor the guardian",
    },
    ProgramErrorSpec {
        code: 6004,
        name: "NotPendingAdmin",
        message: "Signer is not the pending admin",
    },
    ProgramErrorSpec {
        code: 6005,
        name: "NotUpgradeAuthority",
        message: "Signer is not the program upgrade authority",
    },
    ProgramErrorSpec {
        code: 6006,
        name: "InvalidProgramData",
        message: "Account is not this program's ProgramData account",
    },
    ProgramErrorSpec {
        code: 6007,
        name: "InvalidRole",
        message: "Role must not be the default public key",
    },
    ProgramErrorSpec {
        code: 6008,
        name: "ZeroPayoutId",
        message: "Payout id must not be all zero bytes",
    },
    ProgramErrorSpec {
        code: 6009,
        name: "ZeroAmount",
        message: "Amount must be greater than zero",
    },
    ProgramErrorSpec {
        code: 6010,
        name: "ExceedsMaxPerClaim",
        message: "Amount exceeds the per-claim cap",
    },
    ProgramErrorSpec {
        code: 6011,
        name: "DayCapExceeded",
        message: "Claim would exceed the daily cap",
    },
    ProgramErrorSpec {
        code: 6012,
        name: "Expired",
        message: "Claim has expired",
    },
    ProgramErrorSpec {
        code: 6013,
        name: "ExpiryTooFar",
        message: "Claim expiry is more than 900 seconds ahead",
    },
    ProgramErrorSpec {
        code: 6014,
        name: "VaultTokenAccountFrozen",
        message: "Vault token account is frozen",
    },
    ProgramErrorSpec {
        code: 6015,
        name: "RecipientTokenAccountFrozen",
        message: "Recipient token account is frozen",
    },
    ProgramErrorSpec {
        code: 6016,
        name: "InsufficientVaultBalance",
        message: "Vault balance is below the amount",
    },
    ProgramErrorSpec {
        code: 6017,
        name: "InvalidRecipient",
        message: "Recipient must not be the vault, the claim authority or the payer",
    },
    ProgramErrorSpec {
        code: 6018,
        name: "InvalidVaultTokenAccount",
        message: "Vault token account is not canonical or has a delegate or close authority",
    },
    ProgramErrorSpec {
        code: 6019,
        name: "InvalidMint",
        message: "Mint is not the vault mint or does not have 6 decimals",
    },
    ProgramErrorSpec {
        code: 6020,
        name: "RoleConflict",
        message: "Claim authority must not also be the admin or the guardian",
    },
    ProgramErrorSpec {
        code: 6021,
        name: "InvalidCaps",
        message: "Caps must be non-zero and max_per_claim must not exceed max_per_day",
    },
    ProgramErrorSpec {
        code: 6022,
        name: "InvalidWithdrawDestination",
        message: INVALID_WITHDRAW_DESTINATION_MESSAGE,
    },
    ProgramErrorSpec {
        code: 6023,
        name: "MathOverflow",
        message: "Arithmetic overflow",
    },
];

/// The §3.5 row for `code`, or `None` outside 6000-6023.
pub fn program_error(code: u32) -> Option<&'static ProgramErrorSpec> {
    let index = code.checked_sub(FIRST_PROGRAM_ERROR)?;
    let index = usize::try_from(index).ok()?;
    PROGRAM_ERRORS.get(index)
}

// ---------------------------------------------------------------------------
// Time, caps and amounts
// ---------------------------------------------------------------------------

/// Clock used by every environment: 2026-10-02T03:04:30Z, UTC day 20728.
/// It equals the `claimed_at` of the contract's receipt vector.
pub const NOW: i64 = 1_790_910_270;

/// Seconds per UTC day.
pub const SECONDS_PER_DAY: i64 = 86_400;

/// Furthest `expires_at` may be ahead of `now` (§3.3.2 C12).
pub const MAX_EXPIRY_AHEAD: i64 = 900;

/// `expires_at - now` the fixtures use for an ordinary claim (§9.1: at most 300).
pub const DEFAULT_EXPIRY_AHEAD: i64 = 300;

/// USDC decimals (§2.3).
pub const USDC_DECIMALS: u8 = 6;

/// Initial `max_per_claim` used by the admin CLI (§2.5): 5 USDC.
pub const DEFAULT_MAX_PER_CLAIM: u64 = 5_000_000;

/// Initial `max_per_day` used by the admin CLI (§2.5): 20 USDC.
pub const DEFAULT_MAX_PER_DAY: u64 = 20_000_000;

/// Float minted into the vault by [`Env::live`]: 100 USDC.
pub const VAULT_FUNDING: u64 = 100_000_000;

/// Lamports per SOL.
pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

/// Compute budget target for `claim` (§3.3.2, #2980).
pub const CLAIM_CU_BUDGET: u64 = 45_000;

/// `day(t) = t.div_euclid(86_400)` (§3.1).
pub fn utc_day(unix_timestamp: i64) -> i64 {
    unix_timestamp.div_euclid(SECONDS_PER_DAY)
}

// ---------------------------------------------------------------------------
// PDAs (contract §2.4, §3.2, §3.9 rule 3)
// ---------------------------------------------------------------------------

/// Vault PDA `["vault", mint]` and its canonical bump.
pub fn vault_pda(mint: &Address) -> (Address, u8) {
    let seeds: [&[u8]; 2] = [b"vault", mint.as_ref()];
    Address::find_program_address(&seeds, &PROGRAM_ID)
}

/// Receipt PDA `["receipt", vault, payout_id]` and its canonical bump.
pub fn receipt_pda(vault: &Address, payout_id: &[u8; 32]) -> (Address, u8) {
    let seeds: [&[u8]; 3] = [b"receipt", vault.as_ref(), payout_id];
    Address::find_program_address(&seeds, &PROGRAM_ID)
}

/// ProgramData `find_program_address([program_id], loader-v3)`.
pub fn program_data_pda(program_id: &Address) -> (Address, u8) {
    let seeds: [&[u8]; 1] = [program_id.as_ref()];
    Address::find_program_address(&seeds, &LOADER_V3_ID)
}

/// Canonical classic-Token ATA of `(wallet, mint)`.
pub fn associated_token_address(wallet: &Address, mint: &Address) -> Address {
    let token_program = TOKEN_PROGRAM_ID;
    let seeds: [&[u8]; 3] = [wallet.as_ref(), token_program.as_ref(), mint.as_ref()];
    Address::find_program_address(&seeds, &ATA_PROGRAM_ID).0
}

// ---------------------------------------------------------------------------
// Instruction builders (contract §3.3, fixed account order and flags)
// ---------------------------------------------------------------------------

/// Arguments of `initialize` (§3.3.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InitializeArgs {
    pub admin: Address,
    pub guardian: Address,
    pub claim_authority: Address,
    pub max_per_claim: u64,
    pub max_per_day: u64,
}

/// Accounts of `initialize`, in order (§3.3.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InitializeAccounts {
    pub vault: Address,
    pub mint: Address,
    pub vault_token_account: Address,
    pub program_data: Address,
    pub upgrade_authority: Address,
    pub payer: Address,
    pub token_program: Address,
    pub system_program: Address,
}

/// Arguments of `claim` (§3.3.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClaimArgs {
    pub payout_id: [u8; 32],
    pub amount: u64,
    pub expires_at: i64,
}

/// Accounts of `claim`, in order (§3.3.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClaimAccounts {
    pub vault: Address,
    pub receipt: Address,
    pub mint: Address,
    pub vault_token_account: Address,
    pub recipient: Address,
    pub recipient_token_account: Address,
    pub claim_authority: Address,
    pub payer: Address,
    pub token_program: Address,
    pub system_program: Address,
}

/// Arguments of `update_config` (§3.3.5).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UpdateConfigArgs {
    pub guardian: Address,
    pub claim_authority: Address,
    pub max_per_claim: u64,
    pub max_per_day: u64,
}

/// Accounts of `withdraw`, in order (§3.3.8).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WithdrawAccounts {
    pub vault: Address,
    pub admin: Address,
    pub mint: Address,
    pub vault_token_account: Address,
    pub destination: Address,
    pub token_program: Address,
}

/// Borsh data of `initialize`: 120 bytes.
pub fn initialize_data(args: &InitializeArgs) -> Vec<u8> {
    let mut data = instruction_discriminator("initialize").to_vec();
    data.extend_from_slice(args.admin.as_ref());
    data.extend_from_slice(args.guardian.as_ref());
    data.extend_from_slice(args.claim_authority.as_ref());
    data.extend_from_slice(&args.max_per_claim.to_le_bytes());
    data.extend_from_slice(&args.max_per_day.to_le_bytes());
    data
}

/// Borsh data of `claim`: 56 bytes.
pub fn claim_data(args: &ClaimArgs) -> Vec<u8> {
    let mut data = instruction_discriminator("claim").to_vec();
    data.extend_from_slice(&args.payout_id);
    data.extend_from_slice(&args.amount.to_le_bytes());
    data.extend_from_slice(&args.expires_at.to_le_bytes());
    data
}

/// Borsh data of `update_config`: 88 bytes.
pub fn update_config_data(args: &UpdateConfigArgs) -> Vec<u8> {
    let mut data = instruction_discriminator("update_config").to_vec();
    data.extend_from_slice(args.guardian.as_ref());
    data.extend_from_slice(args.claim_authority.as_ref());
    data.extend_from_slice(&args.max_per_claim.to_le_bytes());
    data.extend_from_slice(&args.max_per_day.to_le_bytes());
    data
}

/// Borsh data of `propose_admin`: 40 bytes.
pub fn propose_admin_data(new_admin: &Address) -> Vec<u8> {
    let mut data = instruction_discriminator("propose_admin").to_vec();
    data.extend_from_slice(new_admin.as_ref());
    data
}

/// Borsh data of `withdraw`: 16 bytes.
pub fn withdraw_data(amount: u64) -> Vec<u8> {
    let mut data = instruction_discriminator("withdraw").to_vec();
    data.extend_from_slice(&amount.to_le_bytes());
    data
}

/// An instruction for this program with arbitrary data and no accounts.
pub fn raw_ix(data: Vec<u8>) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: Vec::new(),
        data,
    }
}

/// `initialize` (§3.3.1).
pub fn initialize_ix(accounts: &InitializeAccounts, args: &InitializeArgs) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(accounts.vault, false),
            AccountMeta::new_readonly(accounts.mint, false),
            AccountMeta::new_readonly(accounts.vault_token_account, false),
            AccountMeta::new_readonly(accounts.program_data, false),
            AccountMeta::new_readonly(accounts.upgrade_authority, true),
            AccountMeta::new(accounts.payer, true),
            AccountMeta::new_readonly(accounts.token_program, false),
            AccountMeta::new_readonly(accounts.system_program, false),
        ],
        data: initialize_data(args),
    }
}

/// Index of the `claim_authority` account in `claim` (§3.3.2 row 7).
pub const CLAIM_AUTHORITY_ACCOUNT_INDEX: usize = 6;

/// `claim` (§3.3.2).
pub fn claim_ix(accounts: &ClaimAccounts, args: &ClaimArgs) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(accounts.vault, false),
            AccountMeta::new(accounts.receipt, false),
            AccountMeta::new_readonly(accounts.mint, false),
            AccountMeta::new(accounts.vault_token_account, false),
            AccountMeta::new_readonly(accounts.recipient, false),
            AccountMeta::new(accounts.recipient_token_account, false),
            AccountMeta::new_readonly(accounts.claim_authority, true),
            AccountMeta::new(accounts.payer, true),
            AccountMeta::new_readonly(accounts.token_program, false),
            AccountMeta::new_readonly(accounts.system_program, false),
        ],
        data: claim_data(args),
    }
}

/// The two-account shape shared by `pause`, `unpause`, `update_config`,
/// `propose_admin` and `accept_admin`: vault (writable), signer.
fn vault_signer_ix(vault: &Address, signer: &Address, data: Vec<u8>) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*vault, false),
            AccountMeta::new_readonly(*signer, true),
        ],
        data,
    }
}

/// `pause` (§3.3.3); `authority` is the admin or the guardian.
pub fn pause_ix(vault: &Address, authority: &Address) -> Instruction {
    let data = instruction_discriminator("pause").to_vec();
    vault_signer_ix(vault, authority, data)
}

/// `unpause` (§3.3.4).
pub fn unpause_ix(vault: &Address, admin: &Address) -> Instruction {
    let data = instruction_discriminator("unpause").to_vec();
    vault_signer_ix(vault, admin, data)
}

/// `update_config` (§3.3.5).
pub fn update_config_ix(vault: &Address, admin: &Address, args: &UpdateConfigArgs) -> Instruction {
    vault_signer_ix(vault, admin, update_config_data(args))
}

/// `propose_admin` (§3.3.6).
pub fn propose_admin_ix(vault: &Address, admin: &Address, new_admin: &Address) -> Instruction {
    vault_signer_ix(vault, admin, propose_admin_data(new_admin))
}

/// `accept_admin` (§3.3.7).
pub fn accept_admin_ix(vault: &Address, new_admin: &Address) -> Instruction {
    let data = instruction_discriminator("accept_admin").to_vec();
    vault_signer_ix(vault, new_admin, data)
}

/// `withdraw` (§3.3.8).
pub fn withdraw_ix(accounts: &WithdrawAccounts, amount: u64) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(accounts.vault, false),
            AccountMeta::new_readonly(accounts.admin, true),
            AccountMeta::new_readonly(accounts.mint, false),
            AccountMeta::new(accounts.vault_token_account, false),
            AccountMeta::new(accounts.destination, false),
            AccountMeta::new_readonly(accounts.token_program, false),
        ],
        data: withdraw_data(amount),
    }
}

// ---------------------------------------------------------------------------
// Classic SPL Token and ATA helpers (LiteSVM 0.16.0 bundles both programs)
// ---------------------------------------------------------------------------

/// Classic mint account size.
pub const MINT_SIZE: usize = 82;

/// Classic token account size.
pub const TOKEN_ACCOUNT_SIZE: usize = 165;

/// `AccountState::Initialized`.
pub const TOKEN_STATE_INITIALIZED: u8 = 1;

/// `AccountState::Frozen`.
pub const TOKEN_STATE_FROZEN: u8 = 2;

fn put_coption_address(out: &mut Vec<u8>, value: Option<Address>) {
    match value {
        Some(key) => {
            out.extend_from_slice(&1u32.to_le_bytes());
            out.extend_from_slice(key.as_ref());
        }
        None => out.extend_from_slice(&[0u8; 36]),
    }
}

fn read_coption_address(data: &[u8], offset: usize) -> Option<Option<Address>> {
    let tag = u32::from_le_bytes(read_array::<4>(data, offset)?);
    let key = read_address(data, offset + 4)?;
    match tag {
        0 => Some(None),
        1 => Some(Some(key)),
        _ => None,
    }
}

/// Packs a classic SPL Token mint (82 bytes, `is_initialized = true`).
pub fn pack_mint(
    mint_authority: Option<Address>,
    supply: u64,
    decimals: u8,
    freeze_authority: Option<Address>,
) -> Vec<u8> {
    let mut data = Vec::with_capacity(MINT_SIZE);
    put_coption_address(&mut data, mint_authority);
    data.extend_from_slice(&supply.to_le_bytes());
    data.push(decimals);
    data.push(1);
    put_coption_address(&mut data, freeze_authority);
    data
}

/// A classic SPL Token account (165 bytes; `is_native` is always `None`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TokenAccountState {
    pub mint: Address,
    pub owner: Address,
    pub amount: u64,
    pub delegate: Option<Address>,
    pub state: u8,
    pub delegated_amount: u64,
    pub close_authority: Option<Address>,
}

impl TokenAccountState {
    /// An initialized account with no delegate and no close authority.
    pub fn initialized(mint: Address, owner: Address, amount: u64) -> Self {
        Self {
            mint,
            owner,
            amount,
            delegate: None,
            state: TOKEN_STATE_INITIALIZED,
            delegated_amount: 0,
            close_authority: None,
        }
    }

    /// Packs the account in the classic SPL Token layout.
    pub fn pack(&self) -> Vec<u8> {
        let mut data = Vec::with_capacity(TOKEN_ACCOUNT_SIZE);
        data.extend_from_slice(self.mint.as_ref());
        data.extend_from_slice(self.owner.as_ref());
        data.extend_from_slice(&self.amount.to_le_bytes());
        put_coption_address(&mut data, self.delegate);
        data.push(self.state);
        // is_native: COption<u64>::None.
        data.extend_from_slice(&[0u8; 12]);
        data.extend_from_slice(&self.delegated_amount.to_le_bytes());
        put_coption_address(&mut data, self.close_authority);
        data
    }

    /// Unpacks a classic SPL Token account.
    pub fn unpack(data: &[u8]) -> Option<Self> {
        if data.len() != TOKEN_ACCOUNT_SIZE {
            return None;
        }
        Some(Self {
            mint: read_address(data, 0)?,
            owner: read_address(data, 32)?,
            amount: read_u64(data, 64)?,
            delegate: read_coption_address(data, 72)?,
            state: read_u8(data, 108)?,
            delegated_amount: read_u64(data, 121)?,
            close_authority: read_coption_address(data, 129)?,
        })
    }
}

/// ATA program `CreateIdempotent` for `(wallet, mint)` under classic Token.
pub fn create_ata_idempotent(funder: &Address, wallet: &Address, mint: &Address) -> Instruction {
    Instruction {
        program_id: ATA_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*funder, true),
            AccountMeta::new(associated_token_address(wallet, mint), false),
            AccountMeta::new_readonly(*wallet, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        ],
        data: vec![1],
    }
}

/// SPL Token `MintTo` (instruction 7).
pub fn mint_to_ix(
    mint: &Address,
    destination: &Address,
    authority: &Address,
    amount: u64,
) -> Instruction {
    let mut data = vec![7];
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*mint, false),
            AccountMeta::new(*destination, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

fn freeze_or_thaw_ix(
    tag: u8,
    account: &Address,
    mint: &Address,
    authority: &Address,
) -> Instruction {
    Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*account, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data: vec![tag],
    }
}

/// SPL Token `FreezeAccount` (instruction 10), signed by the freeze authority.
pub fn freeze_account_ix(account: &Address, mint: &Address, authority: &Address) -> Instruction {
    freeze_or_thaw_ix(10, account, mint, authority)
}

/// SPL Token `ThawAccount` (instruction 11), signed by the freeze authority.
pub fn thaw_account_ix(account: &Address, mint: &Address, authority: &Address) -> Instruction {
    freeze_or_thaw_ix(11, account, mint, authority)
}

// ---------------------------------------------------------------------------
// LiteSVM helpers
// ---------------------------------------------------------------------------

/// Signs `instructions` with exactly the keypairs the message requires
/// (picked from `signers`, which must include `fee_payer`) and sends them.
///
/// The blockhash is expired first, so two identical transactions never
/// collide in LiteSVM's duplicate-signature check.
pub fn sign_and_send(
    svm: &mut LiteSVM,
    fee_payer: &Keypair,
    instructions: &[Instruction],
    signers: &[&Keypair],
) -> TransactionResult {
    svm.expire_blockhash();
    let blockhash = svm.latest_blockhash();
    let payer = fee_payer.pubkey();
    let message = Message::new_with_blockhash(instructions, Some(&payer), &blockhash);
    let required = usize::from(message.header.num_required_signatures);
    let mut chosen: Vec<&Keypair> = Vec::with_capacity(required);
    for key in message.account_keys.iter().take(required) {
        let found = signers.iter().find(|keypair| keypair.pubkey() == *key);
        let Some(keypair) = found else {
            panic!("no keypair supplied for required signer {key}");
        };
        chosen.push(*keypair);
    }
    let transaction = Transaction::new(&chosen, message, blockhash);
    svm.send_transaction(transaction)
}

/// Airdrops `lamports` to `address` (a system transfer from LiteSVM's
/// internal faucet, so the account stays system-owned).
pub fn fund_lamports(svm: &mut LiteSVM, address: &Address, lamports: u64) {
    svm.expire_blockhash();
    if let Err(failed) = svm.airdrop(address, lamports) {
        panic!("airdrop to {address} failed: {:?}", failed.err);
    }
}

/// Writes a rent-exempt, non-executable account directly into LiteSVM.
pub fn put_account(svm: &mut LiteSVM, address: Address, owner: Address, data: Vec<u8>) {
    let lamports = svm.minimum_balance_for_rent_exemption(data.len());
    let account = Account {
        lamports,
        data,
        owner,
        executable: false,
        rent_epoch: 0,
    };
    if let Err(err) = svm.set_account(address, account) {
        panic!("cannot write account {address}: {err}");
    }
}

/// Writes a classic mint whose mint and freeze authority are `authority`.
pub fn put_mint(svm: &mut LiteSVM, address: Address, decimals: u8, authority: Address) {
    let data = pack_mint(Some(authority), 0, decimals, Some(authority));
    put_account(svm, address, TOKEN_PROGRAM_ID, data);
}

/// Writes a token account in the classic layout, owned by classic Token.
pub fn put_token_account(svm: &mut LiteSVM, address: Address, state: &TokenAccountState) {
    put_account(svm, address, TOKEN_PROGRAM_ID, state.pack());
}

/// The data of the account at `address`, if it exists.
pub fn account_data(svm: &LiteSVM, address: &Address) -> Option<Vec<u8>> {
    svm.get_account(address).map(|account| account.data)
}

/// `Clock::unix_timestamp`.
pub fn unix_timestamp(svm: &LiteSVM) -> i64 {
    svm.get_sysvar::<Clock>().unix_timestamp
}

/// Sets `Clock::unix_timestamp`, keeping every other Clock field.
pub fn set_unix_timestamp(svm: &mut LiteSVM, timestamp: i64) {
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = timestamp;
    svm.set_sysvar(&clock);
}

/// Length of the loader-v3 ProgramData header (`size_of_programdata_metadata`).
pub const PROGRAM_DATA_METADATA_LEN: usize = 45;

/// Bincode tag of `UpgradeableLoaderState::ProgramData`.
pub const LOADER_V3_PROGRAM_DATA_TAG: u32 = 3;

/// Loader-v3 ProgramData header: bincode
/// `UpgradeableLoaderState::ProgramData { slot, upgrade_authority_address }`
/// (u32 tag 3, u64 slot, `Option<Pubkey>` as a 1-byte tag plus 32 bytes),
/// zero-padded to 45 bytes.
pub fn program_data_metadata(slot: u64, upgrade_authority: Option<Address>) -> [u8; 45] {
    let mut out = [0u8; PROGRAM_DATA_METADATA_LEN];
    out[..4].copy_from_slice(&LOADER_V3_PROGRAM_DATA_TAG.to_le_bytes());
    out[4..12].copy_from_slice(&slot.to_le_bytes());
    if let Some(key) = upgrade_authority {
        out[12] = 1;
        out[13..].copy_from_slice(key.as_ref());
    }
    out
}

/// Rewrites the ProgramData header of a program that LiteSVM deployed with
/// `add_program` (loader-v3, upgrade authority `None`), keeping its slot and
/// its ELF bytes. LiteSVM 0.16.0 has no API to set the upgrade authority, so
/// the header is written by hand in the loader-v3 layout.
pub fn set_upgrade_authority(svm: &mut LiteSVM, program_id: &Address, authority: Option<Address>) {
    let program_data = program_data_pda(program_id).0;
    let Some(mut account) = svm.get_account(&program_data) else {
        panic!("no ProgramData account at {program_data}");
    };
    assert_eq!(account.owner, LOADER_V3_ID, "ProgramData owner");
    let tag = read_array::<4>(&account.data, 0).map(u32::from_le_bytes);
    assert_eq!(tag, Some(LOADER_V3_PROGRAM_DATA_TAG), "ProgramData tag");
    let slot = read_u64(&account.data, 4).unwrap_or_default();
    let metadata = program_data_metadata(slot, authority);
    account.data[..PROGRAM_DATA_METADATA_LEN].copy_from_slice(&metadata);
    if let Err(err) = svm.set_account(program_data, account) {
        panic!("cannot rewrite ProgramData {program_data}: {err}");
    }
}

// ---------------------------------------------------------------------------
// Result assertions
// ---------------------------------------------------------------------------

/// True when any log line contains `needle`.
pub fn logs_contain(logs: &[String], needle: &str) -> bool {
    logs.iter().any(|line| line.contains(needle))
}

/// Unwraps a successful transaction, panicking with the logs otherwise.
#[track_caller]
pub fn expect_ok(result: TransactionResult) -> TransactionMetadata {
    match result {
        Ok(meta) => meta,
        Err(failed) => {
            let logs = failed.meta.pretty_logs();
            panic!("transaction failed: {:?}\n{logs}", failed.err);
        }
    }
}

/// Asserts the transaction failed with `InstructionError(index, Custom(code))`.
#[track_caller]
pub fn expect_code(result: TransactionResult, index: u8, code: u32) -> FailedTransactionMetadata {
    let expected = TransactionError::InstructionError(index, InstructionError::Custom(code));
    match result {
        Ok(meta) => {
            let logs = meta.pretty_logs();
            panic!("expected {expected:?}, got success\n{logs}");
        }
        Err(failed) => {
            if failed.err != expected {
                let logs = failed.meta.pretty_logs();
                panic!("expected {expected:?}, got {:?}\n{logs}", failed.err);
            }
            failed
        }
    }
}

/// Asserts a §3.5 program error at instruction `index`, and that Anchor's
/// error log names it with the exact contract name and message.
#[track_caller]
pub fn expect_program_error(
    result: TransactionResult,
    index: u8,
    code: u32,
) -> FailedTransactionMetadata {
    let Some(spec) = program_error(code) else {
        panic!("{code} is not a contract v0 program error code");
    };
    let failed = expect_code(result, index, code);
    let needle = spec.log_fragment();
    if !logs_contain(&failed.meta.logs, &needle) {
        let logs = failed.meta.pretty_logs();
        panic!("missing Anchor error log `{needle}`\n{logs}");
    }
    failed
}

/// [`expect_program_error`] at [`INITIALIZE_INDEX`].
#[track_caller]
pub fn expect_init_error(result: TransactionResult, code: u32) -> FailedTransactionMetadata {
    expect_program_error(result, INITIALIZE_INDEX, code)
}

/// [`expect_program_error`] at [`CLAIM_INDEX`].
#[track_caller]
pub fn expect_claim_error(result: TransactionResult, code: u32) -> FailedTransactionMetadata {
    expect_program_error(result, CLAIM_INDEX, code)
}

/// Compute units of a successful transaction.
#[track_caller]
pub fn compute_units(result: TransactionResult) -> u64 {
    expect_ok(result).compute_units_consumed
}

/// Asserts system `AccountAlreadyInUse` (`Custom(0)`) at instruction `index`
/// with the "already in use" log line (§3.7, open item O6).
#[track_caller]
pub fn expect_already_in_use(result: TransactionResult, index: u8) -> FailedTransactionMetadata {
    let failed = expect_code(result, index, SYSTEM_ALREADY_IN_USE);
    if !logs_contain(&failed.meta.logs, ALREADY_IN_USE_LOG) {
        let logs = failed.meta.pretty_logs();
        panic!("missing `{ALREADY_IN_USE_LOG}` log line\n{logs}");
    }
    failed
}

// ---------------------------------------------------------------------------
// Test environment
// ---------------------------------------------------------------------------

/// Index of `initialize` in [`Env::send_initialize`]'s transaction.
pub const INITIALIZE_INDEX: u8 = 1;

/// Index of `claim` in [`Env::send_claim`]'s transaction.
pub const CLAIM_INDEX: u8 = 1;

/// A LiteSVM instance with the program deployed as an upgradeable program,
/// one classic 6-decimal mint, and an ephemeral keypair for every role.
pub struct Env {
    pub svm: LiteSVM,
    /// Fee payer of every transaction and default `payer` account.
    pub payer: Keypair,
    pub upgrade_authority: Keypair,
    pub admin: Keypair,
    pub guardian: Keypair,
    pub claim_authority: Keypair,
    /// Mint and freeze authority of every mint the environment creates
    /// (the freeze authority stands in for Circle's, §2.3).
    pub mint_authority: Keypair,
    pub mint: Address,
    pub vault: Address,
    pub vault_bump: u8,
    pub vault_token_account: Address,
}

impl Env {
    /// Program deployed, upgrade authority set, clock at [`NOW`], mint
    /// created, vault not initialized.
    pub fn deployed() -> Self {
        Self::deployed_with_mint(random_address())
    }

    /// As [`Env::deployed`], with the mint at a fixed address.
    pub fn deployed_with_mint(mint: Address) -> Self {
        let mut svm = LiteSVM::new();
        if let Err(err) = svm.add_program(PROGRAM_ID, program_bytes()) {
            panic!("LiteSVM refused the program: {err}");
        }
        set_unix_timestamp(&mut svm, NOW);
        let upgrade_authority = Keypair::new();
        set_upgrade_authority(&mut svm, &PROGRAM_ID, Some(upgrade_authority.pubkey()));
        let payer = Keypair::new();
        fund_lamports(&mut svm, &payer.pubkey(), 1_000 * LAMPORTS_PER_SOL);
        let mint_authority = Keypair::new();
        let authority = mint_authority.pubkey();
        put_mint(&mut svm, mint, USDC_DECIMALS, authority);
        let (vault, vault_bump) = vault_pda(&mint);
        let vault_token_account = associated_token_address(&vault, &mint);
        Self {
            svm,
            payer,
            upgrade_authority,
            admin: Keypair::new(),
            guardian: Keypair::new(),
            claim_authority: Keypair::new(),
            mint_authority,
            mint,
            vault,
            vault_bump,
            vault_token_account,
        }
    }

    /// Deployed and initialized with the default roles and caps. The vault
    /// is paused and holds no tokens (§3.3.1 effects).
    pub fn initialized() -> Self {
        let mut env = Self::deployed();
        let accounts = env.initialize_accounts();
        let args = env.initialize_args();
        expect_ok(env.send_initialize(&accounts, &args, &[]));
        env
    }

    /// Initialized, funded with [`VAULT_FUNDING`] and unpaused.
    pub fn live() -> Self {
        Self::live_with_balance(VAULT_FUNDING)
    }

    /// Initialized, funded with `balance` and unpaused.
    pub fn live_with_balance(balance: u64) -> Self {
        let mut env = Self::initialized();
        if balance > 0 {
            env.fund_vault(balance);
        }
        let unpause = unpause_ix(&env.vault, &env.admin.pubkey());
        expect_ok(env.send(&[unpause], &[]));
        env
    }

    /// Sends `ixs` with [`Env::payer`] as fee payer. The signers are picked
    /// from the environment's role keypairs plus `extra`.
    pub fn send(&mut self, ixs: &[Instruction], extra: &[&Keypair]) -> TransactionResult {
        let mut signers: Vec<&Keypair> = vec![
            &self.payer,
            &self.upgrade_authority,
            &self.admin,
            &self.guardian,
            &self.claim_authority,
            &self.mint_authority,
        ];
        signers.extend_from_slice(extra);
        sign_and_send(&mut self.svm, &self.payer, ixs, &signers)
    }

    /// Rent-exempt minimum for `len` bytes.
    pub fn rent(&self, len: usize) -> u64 {
        self.svm.minimum_balance_for_rent_exemption(len)
    }

    /// Current `Clock::unix_timestamp`.
    pub fn now(&self) -> i64 {
        unix_timestamp(&self.svm)
    }

    /// Moves `Clock::unix_timestamp` (`set_sysvar::<Clock>`).
    pub fn set_now(&mut self, timestamp: i64) {
        set_unix_timestamp(&mut self.svm, timestamp);
    }

    /// The canonical `initialize` accounts for this environment.
    pub fn initialize_accounts(&self) -> InitializeAccounts {
        InitializeAccounts {
            vault: self.vault,
            mint: self.mint,
            vault_token_account: self.vault_token_account,
            program_data: program_data_pda(&PROGRAM_ID).0,
            upgrade_authority: self.upgrade_authority.pubkey(),
            payer: self.payer.pubkey(),
            token_program: TOKEN_PROGRAM_ID,
            system_program: SYSTEM_PROGRAM_ID,
        }
    }

    /// The default roles and the admin CLI's initial caps (§2.5).
    pub fn initialize_args(&self) -> InitializeArgs {
        InitializeArgs {
            admin: self.admin.pubkey(),
            guardian: self.guardian.pubkey(),
            claim_authority: self.claim_authority.pubkey(),
            max_per_claim: DEFAULT_MAX_PER_CLAIM,
            max_per_day: DEFAULT_MAX_PER_DAY,
        }
    }

    /// Sends the admin CLI's single transaction (§3.3.1):
    /// `[createAssociatedTokenIdempotent(payer, ata(vault, mint)), initialize]`.
    /// `initialize` is instruction [`INITIALIZE_INDEX`].
    pub fn send_initialize(
        &mut self,
        accounts: &InitializeAccounts,
        args: &InitializeArgs,
        extra: &[&Keypair],
    ) -> TransactionResult {
        let payer = self.payer.pubkey();
        let ixs = [
            create_ata_idempotent(&payer, &accounts.vault, &accounts.mint),
            initialize_ix(accounts, args),
        ];
        self.send(&ixs, extra)
    }

    /// The canonical `claim` accounts for `recipient` and `payout_id`.
    pub fn claim_accounts(&self, recipient: &Address, payout_id: &[u8; 32]) -> ClaimAccounts {
        ClaimAccounts {
            vault: self.vault,
            receipt: receipt_pda(&self.vault, payout_id).0,
            mint: self.mint,
            vault_token_account: self.vault_token_account,
            recipient: *recipient,
            recipient_token_account: associated_token_address(recipient, &self.mint),
            claim_authority: self.claim_authority.pubkey(),
            payer: self.payer.pubkey(),
            token_program: TOKEN_PROGRAM_ID,
            system_program: SYSTEM_PROGRAM_ID,
        }
    }

    /// `claim` arguments expiring [`DEFAULT_EXPIRY_AHEAD`] seconds from now.
    pub fn claim_args(&self, payout_id: [u8; 32], amount: u64) -> ClaimArgs {
        ClaimArgs {
            payout_id,
            amount,
            expires_at: self.now() + DEFAULT_EXPIRY_AHEAD,
        }
    }

    /// Sends the rail's claim shape (§3.3.2, §9.1) without the compute-budget
    /// instructions: `[createAssociatedTokenIdempotent(payer, ata(recipient,
    /// mint)), claim]`. `claim` is instruction [`CLAIM_INDEX`].
    pub fn send_claim(
        &mut self,
        accounts: &ClaimAccounts,
        args: &ClaimArgs,
        extra: &[&Keypair],
    ) -> TransactionResult {
        let payer = self.payer.pubkey();
        let ixs = [
            create_ata_idempotent(&payer, &accounts.recipient, &accounts.mint),
            claim_ix(accounts, args),
        ];
        self.send(&ixs, extra)
    }

    /// Sends `claim` alone (instruction 0), with no ATA instruction.
    pub fn send_claim_only(
        &mut self,
        accounts: &ClaimAccounts,
        args: &ClaimArgs,
        extra: &[&Keypair],
    ) -> TransactionResult {
        self.send(&[claim_ix(accounts, args)], extra)
    }

    /// One canonical claim of `amount` to `recipient` with a fresh payout id.
    pub fn claim(&mut self, recipient: &Address, amount: u64) -> ([u8; 32], TransactionResult) {
        let payout_id = random_payout_id();
        let accounts = self.claim_accounts(recipient, &payout_id);
        let args = self.claim_args(payout_id, amount);
        (payout_id, self.send_claim(&accounts, &args, &[]))
    }

    /// `update_config` arguments equal to the default roles and caps.
    pub fn update_config_args(&self) -> UpdateConfigArgs {
        UpdateConfigArgs {
            guardian: self.guardian.pubkey(),
            claim_authority: self.claim_authority.pubkey(),
            max_per_claim: DEFAULT_MAX_PER_CLAIM,
            max_per_day: DEFAULT_MAX_PER_DAY,
        }
    }

    /// The canonical `withdraw` accounts, signed by [`Env::admin`].
    pub fn withdraw_accounts(&self, destination: &Address) -> WithdrawAccounts {
        WithdrawAccounts {
            vault: self.vault,
            admin: self.admin.pubkey(),
            mint: self.mint,
            vault_token_account: self.vault_token_account,
            destination: *destination,
            token_program: TOKEN_PROGRAM_ID,
        }
    }

    /// The decoded vault; panics if it is missing or does not decode.
    pub fn vault_state(&self) -> VaultState {
        let Some(data) = account_data(&self.svm, &self.vault) else {
            panic!("no vault account at {}", self.vault);
        };
        let Some(state) = VaultState::decode(&data) else {
            panic!("the vault at {} does not decode", self.vault);
        };
        state
    }

    /// The decoded receipt for `payout_id`, if it exists and decodes.
    pub fn receipt_state(&self, payout_id: &[u8; 32]) -> Option<ReceiptState> {
        let receipt = receipt_pda(&self.vault, payout_id).0;
        let data = account_data(&self.svm, &receipt)?;
        ReceiptState::decode(&data)
    }

    /// The decoded token account at `address`; panics if it is missing.
    pub fn token_account(&self, address: &Address) -> TokenAccountState {
        let Some(data) = account_data(&self.svm, address) else {
            panic!("no token account at {address}");
        };
        let Some(state) = TokenAccountState::unpack(&data) else {
            panic!("the account at {address} is not a classic token account");
        };
        state
    }

    /// Token balance of the account at `address`.
    pub fn token_balance(&self, address: &Address) -> u64 {
        self.token_account(address).amount
    }

    /// Mints `amount` of `mint` into `destination` (`MintTo`).
    pub fn mint_tokens(&mut self, mint: &Address, destination: &Address, amount: u64) {
        let authority = self.mint_authority.pubkey();
        let ix = mint_to_ix(mint, destination, &authority, amount);
        expect_ok(self.send(&[ix], &[]));
    }

    /// Mints `amount` of the environment's mint into the vault ATA.
    pub fn fund_vault(&mut self, amount: u64) {
        let mint = self.mint;
        let vault_token_account = self.vault_token_account;
        self.mint_tokens(&mint, &vault_token_account, amount);
    }

    /// Creates the canonical ATA of `(wallet, mint)` and returns its address.
    pub fn create_ata_for(&mut self, wallet: &Address, mint: &Address) -> Address {
        let payer = self.payer.pubkey();
        let ix = create_ata_idempotent(&payer, wallet, mint);
        expect_ok(self.send(&[ix], &[]));
        associated_token_address(wallet, mint)
    }

    /// Creates the canonical ATA of `wallet` for the environment's mint.
    pub fn create_ata(&mut self, wallet: &Address) -> Address {
        let mint = self.mint;
        self.create_ata_for(wallet, &mint)
    }

    /// Creates another classic mint with `decimals`, under the same mint and
    /// freeze authority.
    pub fn new_mint(&mut self, decimals: u8) -> Address {
        let mint = random_address();
        let authority = self.mint_authority.pubkey();
        put_mint(&mut self.svm, mint, decimals, authority);
        mint
    }

    /// Writes a classic token account at `address`.
    pub fn put_token_account(&mut self, address: Address, state: &TokenAccountState) {
        put_token_account(&mut self.svm, address, state);
    }

    /// Freezes a token account of the environment's mint (Circle freeze).
    pub fn freeze(&mut self, token_account: &Address) {
        let authority = self.mint_authority.pubkey();
        let ix = freeze_account_ix(token_account, &self.mint, &authority);
        expect_ok(self.send(&[ix], &[]));
    }

    /// Thaws a token account of the environment's mint.
    pub fn thaw(&mut self, token_account: &Address) {
        let authority = self.mint_authority.pubkey();
        let ix = thaw_account_ix(token_account, &self.mint, &authority);
        expect_ok(self.send(&[ix], &[]));
    }

    /// Overwrites vault bytes in place (state tampering for checks that the
    /// account constraints make unreachable otherwise).
    pub fn patch_vault(&mut self, offset: usize, bytes: &[u8]) {
        let Some(mut account) = self.svm.get_account(&self.vault) else {
            panic!("no vault account at {}", self.vault);
        };
        account.data[offset..offset + bytes.len()].copy_from_slice(bytes);
        if let Err(err) = self.svm.set_account(self.vault, account) {
            panic!("cannot patch the vault: {err}");
        }
    }

    /// Overwrites a public-key vault field.
    pub fn patch_vault_address(&mut self, offset: usize, key: &Address) {
        self.patch_vault(offset, key.as_ref());
    }

    /// Overwrites a `u64` vault field.
    pub fn patch_vault_u64(&mut self, offset: usize, value: u64) {
        self.patch_vault(offset, &value.to_le_bytes());
    }
}

// ---------------------------------------------------------------------------
// Compute-unit report (#2980: `cu-report.json`)
// ---------------------------------------------------------------------------

/// Compute units per instruction (or per transaction shape), written as JSON.
#[derive(Clone, Debug, Default)]
pub struct CuReport {
    pub units: BTreeMap<String, u64>,
}

impl CuReport {
    /// Records `compute_units` under `name`.
    pub fn record(&mut self, name: &str, compute_units: u64) {
        self.units.insert(name.to_string(), compute_units);
    }

    /// The JSON document, tied to the binary by its SHA-256.
    pub fn to_json(&self, so_sha256: &str) -> String {
        let mut out = String::from("{\n");
        writeln!(out, "  \"program\": \"gogocash_cashback\",").expect("String write");
        writeln!(out, "  \"contract\": \"v0\",").expect("String write");
        writeln!(out, "  \"so_sha256\": \"{so_sha256}\",").expect("String write");
        writeln!(out, "  \"claim_budget\": {CLAIM_CU_BUDGET},").expect("String write");
        writeln!(out, "  \"compute_units\": {{").expect("String write");
        let count = self.units.len();
        for (position, (name, units)) in self.units.iter().enumerate() {
            let comma = if position + 1 < count { "," } else { "" };
            writeln!(out, "    \"{name}\": {units}{comma}").expect("String write");
        }
        out.push_str("  }\n}\n");
        out
    }

    /// Writes the report to `$GOGOCASH_CU_REPORT` when it is set and returns
    /// the path; does nothing otherwise.
    pub fn write_if_requested(&self, so_sha256: &str) -> Option<PathBuf> {
        let path = PathBuf::from(std::env::var_os(CU_REPORT_ENV)?);
        if let Err(err) = std::fs::write(&path, self.to_json(so_sha256)) {
            panic!("cannot write {}: {err}", path.display());
        }
        Some(path)
    }
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

fn hex_nibble(digit: u8) -> u8 {
    match digit {
        b'0'..=b'9' => digit - b'0',
        b'a'..=b'f' => digit - b'a' + 10,
        b'A'..=b'F' => digit - b'A' + 10,
        _ => panic!("invalid hex digit {digit}"),
    }
}

/// Decodes a hex string; panics on malformed input (test vectors only).
pub fn hex_decode(hex: &str) -> Vec<u8> {
    let digits = hex.as_bytes();
    assert!(digits.len().is_multiple_of(2), "odd hex length");
    let mut out = Vec::with_capacity(digits.len() / 2);
    for index in (0..digits.len()).step_by(2) {
        let high = hex_nibble(digits[index]);
        let low = hex_nibble(digits[index + 1]);
        out.push((high << 4) | low);
    }
    out
}

/// Lowercase hex encoding.
pub fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(out, "{byte:02x}").expect("String write");
    }
    out
}

fn base64_sextet(symbol: u8) -> Option<u32> {
    let value = match symbol {
        b'A'..=b'Z' => symbol - b'A',
        b'a'..=b'z' => symbol - b'a' + 26,
        b'0'..=b'9' => symbol - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        _ => return None,
    };
    Some(u32::from(value))
}

/// Decodes standard padded base64 (the `Program data:` log encoding).
pub fn base64_decode(input: &str) -> Option<Vec<u8>> {
    let symbols = input.as_bytes();
    if !symbols.len().is_multiple_of(4) {
        return None;
    }
    let mut out = Vec::with_capacity(symbols.len() / 4 * 3);
    for start in (0..symbols.len()).step_by(4) {
        let mut word = 0u32;
        let mut padding = 0usize;
        for &symbol in &symbols[start..start + 4] {
            let sextet = if symbol == b'=' {
                padding += 1;
                0
            } else if padding > 0 {
                return None;
            } else {
                base64_sextet(symbol)?
            };
            word = (word << 6) | sextet;
        }
        if padding > 2 || (padding > 0 && start + 4 != symbols.len()) {
            return None;
        }
        let bytes = word.to_be_bytes();
        out.extend_from_slice(&bytes[1..4 - padding]);
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// Contract vectors (placeholder program id; derivation and encoding only)
// ---------------------------------------------------------------------------

/// Reference vectors from docs/CONTRACT.md §2.4, §3.2, §3.3 and §3.4. They
/// use the placeholder program id and are not deployment addresses.
pub mod vectors {
    use solana_address::address;
    use solana_address::Address;

    pub const DEVNET_MINT: Address = address!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    pub const MAINNET_MINT: Address = address!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    pub const PROGRAM_DATA: Address = address!("5TKnZEGM435amgcnJX53LoPoiTsYA3yxUMFmd6UvLF7g");
    pub const PROGRAM_DATA_BUMP: u8 = 254;
    pub const DEVNET_VAULT: Address = address!("4CyfLznBBXqSvKhsLTXgRiqHX5NoxeAe7eaMjfKVsWNG");
    pub const DEVNET_VAULT_BUMP: u8 = 254;
    pub const MAINNET_VAULT: Address = address!("2eDusayXKM6xkoo86HM2iYjVuJtizTwAL9qvrFpZTinb");
    pub const MAINNET_VAULT_BUMP: u8 = 253;
    pub const DEVNET_VAULT_ATA: Address = address!("CgjjwVZpirGFVos8ugDeYXLVCbnbikEhTM2JUsD58wQZ");
    pub const MAINNET_VAULT_ATA: Address = address!("6zCWEQMokz27mauLBMsUU1Luw9yvf3zadojdM1pqAsrX");
    pub const DEVNET_RECEIPT: Address = address!("3abi6WfgCceNoMX3Gq5HcqhBePA6T6oNuy7ahhWUQNJR");
    pub const DEVNET_RECEIPT_BUMP: u8 = 251;
    pub const MAINNET_RECEIPT: Address = address!("Av2ptRUTGRweiHbZxmg82ixJRu5XZiixaGy7mZnQEFPZ");
    pub const MAINNET_RECEIPT_BUMP: u8 = 253;
    /// Fixture `test_key_1`; only its public key is used.
    pub const TEST_KEY_1: Address = address!("HupSGTuM8ra7TEsYhF4M2NuDt3iEPQVJv3WGnrtDg9D4");
    pub const DEVNET_RECIP_ATA: Address = address!("8ozizdVK9uxjW7HSYXVyquw3Yn2BfNLkPTPLByfieR62");
    pub const MAINNET_RECIP_ATA: Address = address!("59WLigKFPCo26D5NByV2nsdtTjbRvivTPi1gUJrLuDoN");
    /// Fixture roles of the Vault V1 vector, decoded from its bytes.
    pub const ADMIN: Address = address!("DbT4Ga79iuKxMZaZu4uXwkwijdtVjHXU9eHKHDuLvgth");
    pub const GUARDIAN: Address = address!("EMGzPrfWeBk7E8vyrorptmRVUHtSFMhVkQKQGNSz8fFk");
    pub const CLAIM_AUTHORITY: Address = address!("iKBifpskDNLCbcbVQgWiPYXToJGr4ou8gxsdU92W843");
    pub const PAYOUT_ID_HEX: &str =
        "c6a87a9e170995438a78874587cb95773a9fa752c5b1633c9e7ae23928c88021";
    pub const AMOUNT: u64 = 3_558_875;
    pub const CLAIMED_AT: i64 = 1_790_910_270;
    pub const EXPIRES_AT: i64 = 1_790_910_565;
    pub const DAY: i64 = 20_728;
    pub const CLAIM_DATA_HEX: &str = "3ec6d6c1d59f6cd2c6a87a9e170995438a78874587cb95773a9fa752c5b1633c9e7ae23928c88021db4d3600000000006520bf6a00000000";
    pub const RECEIPT_HEX: &str = "279a496a50669199fbc6a87a9e170995438a78874587cb95773a9fa752c5b1633c9e7ae23928c88021fb42d41abb4d2f1daf215c9c992f2b77bd5b28151dba1a4f6a9156690feabf53db4d3600000000003e1fbf6a00000000";
    pub const VAULT_V1_HEX: &str = "d308e82b0298757701fe01063b442cb3912157f13a933d0134282d032b5ffecd01a2dbf1b7790608df002ea7ad9e88ce36000f85568c63289a49ddb5ad5c2e62d1ef6ee076f8cf409e6538c6bb1f73e0018299d2baa571fb466bbc997d040e1dfcef3a49b10e363542b95c2a0000000000000000000000000000000000000000000000000000000000000000c659a02bdcd91d24d2608551c37a158ca8fe04fde0365b347de421756e22f2b70a955ff259cacd683426a5247f00cc6d836abe6e88a776cf86397852dbd90c04404b4c0000000000002d310100000000f850000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
    pub const PAYOUT_CLAIMED_BASE64: &str = "yCdpcHQ/OpUvpIRAZiyB8sbisxG+o+Rd4XcyW/Sq7bdpC7divXNZNSZSyR4+gTDyDOzyPXg1lEV8b3o70UKeY/qdK7VF4XBOxqh6nhcJlUOKeIdFh8uVdzqfp1LFsWM8nnriOSjIgCH7QtQau00vHa8hXJyZLyt3vVsoFR26Gk9qkVZpD+q/U9tNNgAAAAAAPh+/agAAAAD4UAAAAAAAANtNNgAAAAAAAQAAAAAAAADbTTYAAAAAAA==";

    /// The vector payout id as bytes.
    pub fn payout_id() -> [u8; 32] {
        let bytes = super::hex_decode(PAYOUT_ID_HEX);
        let mut out = [0u8; 32];
        out.copy_from_slice(&bytes);
        out
    }
}

// ---------------------------------------------------------------------------
// Unit tests (no program binary needed)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn program_id_is_the_documented_placeholder() {
        let digest = Sha256::digest(b"gogocash_cashback placeholder program id v0");
        assert_eq!(&PROGRAM_ID.to_bytes()[..], &digest[..]);
    }

    #[test]
    fn instruction_discriminators_are_anchor_sighashes() {
        for (index, name) in INSTRUCTION_NAMES.iter().enumerate() {
            let pinned = INSTRUCTION_DISCRIMINATORS[index];
            assert_eq!(instruction_discriminator(name), pinned, "{name}");
        }
        assert_eq!(instruction_discriminator("ping"), PING_DISCRIMINATOR);
    }

    #[test]
    fn account_and_event_discriminators_are_anchor_sighashes() {
        assert_eq!(discriminator("account:Vault"), VAULT_DISCRIMINATOR);
        assert_eq!(discriminator("account:Receipt"), RECEIPT_DISCRIMINATOR);
        let event = discriminator("event:PayoutClaimed");
        assert_eq!(event, PAYOUT_CLAIMED_DISCRIMINATOR);
    }

    #[test]
    fn layout_sizes_match_the_contract() {
        // 8 + 4 + 6 x 32 + 7 x 8 + 64 (§3.2).
        assert_eq!(VAULT_SIZE, 8 + 4 + 6 * 32 + 7 * 8 + 64);
        assert_eq!(vault_offset::RESERVED + 64, VAULT_SIZE);
        assert_eq!(RECEIPT_SIZE, 8 + 1 + 32 + 32 + 8 + 8);
        assert_eq!(PAYOUT_CLAIMED_SIZE, 8 + 4 * 32 + 6 * 8);
    }

    #[test]
    fn error_table_is_contiguous_from_6000() {
        for (index, spec) in PROGRAM_ERRORS.iter().enumerate() {
            let expected = FIRST_PROGRAM_ERROR + u32::try_from(index).unwrap_or(u32::MAX);
            assert_eq!(spec.code, expected);
            assert_eq!(program_error(spec.code), Some(spec));
            assert!(spec.message.is_ascii());
        }
        let last = program_error(code::MATH_OVERFLOW).map(|spec| spec.name);
        assert_eq!(last, Some("MathOverflow"));
        assert_eq!(program_error(5999), None);
        assert_eq!(program_error(6024), None);
    }

    #[test]
    fn pda_vectors_match_the_contract() {
        let (program_data, bump) = program_data_pda(&PROGRAM_ID);
        assert_eq!(program_data, vectors::PROGRAM_DATA);
        assert_eq!(bump, vectors::PROGRAM_DATA_BUMP);

        let (vault, bump) = vault_pda(&vectors::DEVNET_MINT);
        assert_eq!(vault, vectors::DEVNET_VAULT);
        assert_eq!(bump, vectors::DEVNET_VAULT_BUMP);
        let vault_ata = associated_token_address(&vault, &vectors::DEVNET_MINT);
        assert_eq!(vault_ata, vectors::DEVNET_VAULT_ATA);
        let (receipt, bump) = receipt_pda(&vault, &vectors::payout_id());
        assert_eq!(receipt, vectors::DEVNET_RECEIPT);
        assert_eq!(bump, vectors::DEVNET_RECEIPT_BUMP);
        let recipient_ata = associated_token_address(&vectors::TEST_KEY_1, &vectors::DEVNET_MINT);
        assert_eq!(recipient_ata, vectors::DEVNET_RECIP_ATA);

        let (vault, bump) = vault_pda(&vectors::MAINNET_MINT);
        assert_eq!(vault, vectors::MAINNET_VAULT);
        assert_eq!(bump, vectors::MAINNET_VAULT_BUMP);
        let vault_ata = associated_token_address(&vault, &vectors::MAINNET_MINT);
        assert_eq!(vault_ata, vectors::MAINNET_VAULT_ATA);
        let (receipt, bump) = receipt_pda(&vault, &vectors::payout_id());
        assert_eq!(receipt, vectors::MAINNET_RECEIPT);
        assert_eq!(bump, vectors::MAINNET_RECEIPT_BUMP);
        let recipient_ata = associated_token_address(&vectors::TEST_KEY_1, &vectors::MAINNET_MINT);
        assert_eq!(recipient_ata, vectors::MAINNET_RECIP_ATA);
    }

    #[test]
    fn claim_data_matches_the_contract_vector() {
        let args = ClaimArgs {
            payout_id: vectors::payout_id(),
            amount: vectors::AMOUNT,
            expires_at: vectors::EXPIRES_AT,
        };
        assert_eq!(claim_data(&args), hex_decode(vectors::CLAIM_DATA_HEX));
    }

    #[test]
    fn instruction_data_lengths_match_the_contract() {
        let key = random_address();
        let initialize = InitializeArgs {
            admin: key,
            guardian: key,
            claim_authority: key,
            max_per_claim: 1,
            max_per_day: 1,
        };
        let claim = ClaimArgs {
            payout_id: [7; 32],
            amount: 1,
            expires_at: 1,
        };
        let update = UpdateConfigArgs {
            guardian: key,
            claim_authority: key,
            max_per_claim: 1,
            max_per_day: 1,
        };
        let lens = [
            initialize_data(&initialize).len(),
            claim_data(&claim).len(),
            pause_ix(&key, &key).data.len(),
            unpause_ix(&key, &key).data.len(),
            update_config_data(&update).len(),
            propose_admin_data(&key).len(),
            accept_admin_ix(&key, &key).data.len(),
            withdraw_data(1).len(),
        ];
        assert_eq!(lens, INSTRUCTION_DATA_LENS);
    }

    #[test]
    fn vault_vector_decodes_to_the_documented_fields() {
        let data = hex_decode(vectors::VAULT_V1_HEX);
        let Some(vault) = VaultState::decode(&data) else {
            panic!("the Vault V1 vector does not decode");
        };
        assert_eq!(vault.version, 1);
        assert_eq!(vault.bump, vectors::DEVNET_VAULT_BUMP);
        assert!(vault.paused);
        assert_eq!(vault.decimals, USDC_DECIMALS);
        assert_eq!(vault.mint, vectors::DEVNET_MINT);
        assert_eq!(vault.vault_token_account, vectors::DEVNET_VAULT_ATA);
        assert_eq!(vault.admin, vectors::ADMIN);
        assert_eq!(vault.pending_admin, Address::default());
        assert_eq!(vault.guardian, vectors::GUARDIAN);
        assert_eq!(vault.claim_authority, vectors::CLAIM_AUTHORITY);
        assert_eq!(vault.max_per_claim, DEFAULT_MAX_PER_CLAIM);
        assert_eq!(vault.max_per_day, DEFAULT_MAX_PER_DAY);
        assert_eq!(vault.current_day, vectors::DAY);
        assert_eq!(vault.claimed_today, 0);
        assert_eq!(vault.total_claimed, 0);
        assert_eq!(vault.claim_count, 0);
        assert_eq!(vault.total_withdrawn, 0);
        assert_eq!(vault.reserved, [0u8; 64]);
    }

    #[test]
    fn vault_decoder_rejects_a_non_boolean_paused_byte() {
        let mut data = hex_decode(vectors::VAULT_V1_HEX);
        data[vault_offset::PAUSED] = 2;
        assert_eq!(VaultState::decode(&data), None);
    }

    #[test]
    fn receipt_and_event_vectors_decode_consistently() {
        let data = hex_decode(vectors::RECEIPT_HEX);
        let Some(receipt) = ReceiptState::decode(&data) else {
            panic!("the receipt vector does not decode");
        };
        assert_eq!(receipt.bump, vectors::DEVNET_RECEIPT_BUMP);
        assert_eq!(receipt.payout_id, vectors::payout_id());
        assert_eq!(receipt.recipient, vectors::TEST_KEY_1);
        assert_eq!(receipt.amount, vectors::AMOUNT);
        assert_eq!(receipt.claimed_at, vectors::CLAIMED_AT);

        let line = format!("Program data: {}", vectors::PAYOUT_CLAIMED_BASE64);
        let logs = [line];
        let expected = PayoutClaimed {
            vault: vectors::DEVNET_VAULT,
            receipt: vectors::DEVNET_RECEIPT,
            payout_id: vectors::payout_id(),
            recipient: vectors::TEST_KEY_1,
            amount: vectors::AMOUNT,
            claimed_at: vectors::CLAIMED_AT,
            day: vectors::DAY,
            claimed_today: vectors::AMOUNT,
            claim_count: 1,
            total_claimed: vectors::AMOUNT,
        };
        assert_eq!(payout_claimed_events(&logs), [expected]);
        assert_eq!(utc_day(vectors::CLAIMED_AT), vectors::DAY);
        assert_eq!(utc_day(NOW), vectors::DAY);
    }

    #[test]
    fn base64_decoder_handles_padding_and_rejects_garbage() {
        assert_eq!(base64_decode(""), Some(Vec::new()));
        assert_eq!(base64_decode("TWFu"), Some(b"Man".to_vec()));
        assert_eq!(base64_decode("TWE="), Some(b"Ma".to_vec()));
        assert_eq!(base64_decode("TQ=="), Some(b"M".to_vec()));
        assert_eq!(base64_decode("TQ="), None);
        assert_eq!(base64_decode("T==="), None);
        assert_eq!(base64_decode("TQ==TWFu"), None);
        assert_eq!(base64_decode("TW!u"), None);
        let event = base64_decode(vectors::PAYOUT_CLAIMED_BASE64).unwrap_or_default();
        assert_eq!(event.len(), PAYOUT_CLAIMED_SIZE);
    }

    #[test]
    fn hex_round_trips() {
        let bytes = hex_decode(vectors::PAYOUT_ID_HEX);
        assert_eq!(hex_encode(&bytes), vectors::PAYOUT_ID_HEX);
    }

    #[test]
    fn token_layouts_round_trip() {
        let mint = random_address();
        let owner = random_address();
        let mut state = TokenAccountState::initialized(mint, owner, 42);
        state.delegate = Some(random_address());
        state.delegated_amount = 7;
        state.close_authority = Some(random_address());
        state.state = TOKEN_STATE_FROZEN;
        let packed = state.pack();
        assert_eq!(packed.len(), TOKEN_ACCOUNT_SIZE);
        assert_eq!(TokenAccountState::unpack(&packed), Some(state));
        let mint_data = pack_mint(Some(owner), 0, USDC_DECIMALS, None);
        assert_eq!(mint_data.len(), MINT_SIZE);
        assert_eq!(mint_data[44], USDC_DECIMALS);
        assert_eq!(mint_data[45], 1);
    }

    #[test]
    fn program_data_metadata_is_the_loader_v3_layout() {
        let key = random_address();
        let header = program_data_metadata(9, Some(key));
        assert_eq!(header[..4], [3, 0, 0, 0]);
        assert_eq!(header[4..12], 9u64.to_le_bytes());
        assert_eq!(header[12], 1);
        assert_eq!(header[13..], key.to_bytes());
        let immutable = program_data_metadata(9, None);
        assert_eq!(immutable[12..], [0u8; 33]);
    }

    #[test]
    fn e_flags_are_read_from_offset_48() {
        let mut header = [0u8; 64];
        header[..4].copy_from_slice(b"\x7fELF");
        header[4] = 2;
        header[5] = 1;
        header[48..52].copy_from_slice(&3u32.to_le_bytes());
        assert_eq!(elf64_le_e_flags(&header), Some(3));
        header[5] = 2;
        assert_eq!(elf64_le_e_flags(&header), None);
    }

    #[test]
    fn contains_bytes_finds_the_marker() {
        let mut blob = b"prefix".to_vec();
        blob.extend_from_slice(SECURITY_TXT_BEGIN);
        assert!(contains_bytes(&blob, SECURITY_TXT_BEGIN));
        assert!(!contains_bytes(b"prefix", SECURITY_TXT_BEGIN));
        assert!(!contains_bytes(&blob, b""));
    }

    #[test]
    fn cu_report_is_valid_json_shape() {
        let mut report = CuReport::default();
        report.record("claim", 12_345);
        report.record("pause", 1_000);
        let json = report.to_json("ab");
        assert!(json.contains("\"claim\": 12345,\n"));
        assert!(json.contains("\"pause\": 1000\n"));
        assert!(json.contains("\"claim_budget\": 45000,"));
    }
}
