//! Shared fixtures for the gogocash_cashback LiteSVM suite.
//!
//! The suite never builds the program. It loads a prebuilt SBF artifact so CI
//! tests exactly the bytes it built and checked (`anchor build` output or the
//! `solana-verify build` output).

use std::path::PathBuf;

use solana_address::{address, Address};

/// Environment variable that names the program artifact under test.
pub const SO_PATH_ENV: &str = "GOGOCASH_CASHBACK_SO";

/// Placeholder program id with no known private key:
/// base58(sha256("gogocash_cashback placeholder program id v0")).
/// Must equal `declare_id!` in programs/gogocash-cashback/src/lib.rs.
pub const PROGRAM_ID: Address = address!("HWNF2cvXybfAjLbw2pydi7sNFmTfYBjpEWNtY3BJfCje");

/// Anchor discriminator of `ping`: the first 8 bytes of sha256("global:ping").
/// Pinned here and recomputed by `ping_discriminator_is_anchor_sighash`.
pub const PING_DISCRIMINATOR: [u8; 8] = [173, 0, 94, 236, 73, 133, 225, 153];

/// Message the `ping` instruction logs.
pub const PING_LOG: &str = "gogocash_cashback: ping v0";

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

#[cfg(test)]
mod tests {
    use sha2::{Digest, Sha256};

    use super::*;

    #[test]
    fn ping_discriminator_is_anchor_sighash() {
        let digest = Sha256::digest(b"global:ping");
        assert_eq!(&digest[..8], &PING_DISCRIMINATOR[..]);
    }

    #[test]
    fn program_id_is_the_documented_placeholder() {
        let digest = Sha256::digest(b"gogocash_cashback placeholder program id v0");
        assert_eq!(&PROGRAM_ID.to_bytes()[..], &digest[..]);
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
}
