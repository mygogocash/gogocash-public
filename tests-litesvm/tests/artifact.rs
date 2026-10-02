//! Artifact and dispatch checks (contract §3.3, §3.6): the binary under test
//! is SBPFv3, embeds security.txt, deploys as an upgradeable (loader-v3)
//! program with a ProgramData account, and dispatches exactly the 8 v0
//! instructions.
//!
//! Every test loads the artifact named by `program_so_path()`, so CI can point
//! `GOGOCASH_CASHBACK_SO` at the exact .so it built and checked.

use gogocash_cashback_litesvm_tests as fx;
use solana_instruction::error::InstructionError;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;

#[test]
fn artifact_is_sbpf_v3_and_embeds_security_txt() {
    let program = fx::program_bytes();
    let e_flags = fx::elf64_le_e_flags(program);
    assert_eq!(e_flags, Some(fx::EXPECTED_SBPF_VERSION));
    let has_marker = fx::contains_bytes(program, fx::SECURITY_TXT_BEGIN);
    assert!(has_marker, "security.txt marker missing");
}

#[test]
fn program_is_deployed_upgradeable_with_its_program_data() {
    let env = fx::Env::deployed();
    let Some(program) = env.svm.get_account(&fx::PROGRAM_ID) else {
        panic!("the program account is missing");
    };
    assert!(program.executable);
    assert_eq!(program.owner, fx::LOADER_V3_ID);

    let (program_data, bump) = fx::program_data_pda(&fx::PROGRAM_ID);
    assert_eq!(program_data, fx::vectors::PROGRAM_DATA);
    assert_eq!(bump, fx::vectors::PROGRAM_DATA_BUMP);
    let Some(data) = fx::account_data(&env.svm, &program_data) else {
        panic!("the ProgramData account is missing");
    };
    let metadata_len = fx::PROGRAM_DATA_METADATA_LEN;
    let slot = fx::read_u64(&data, 4).unwrap_or_default();
    let authority = Some(env.upgrade_authority.pubkey());
    let header = fx::program_data_metadata(slot, authority);
    assert_eq!(data[..metadata_len], header);
    assert_eq!(&data[metadata_len..], fx::program_bytes());
}

#[test]
fn every_v0_instruction_is_dispatched() {
    // Each discriminator with zeroed arguments of the right length and no
    // accounts gets past dispatch and argument decoding (S0) and fails on
    // the first missing account (S1, 3005), never with 101.
    let mut env = fx::Env::deployed();
    for (index, name) in fx::INSTRUCTION_NAMES.iter().enumerate() {
        let mut data = fx::instruction_discriminator(name).to_vec();
        data.resize(fx::INSTRUCTION_DATA_LENS[index], 0);
        let result = env.send(&[fx::raw_ix(data)], &[]);
        let code = fx::anchor_code::NOT_ENOUGH_KEYS;
        fx::expect_code(result, 0, code);
    }
}

#[test]
fn unknown_discriminator_is_rejected() {
    let mut env = fx::Env::deployed();
    let result = env.send(&[fx::raw_ix(vec![0; 8])], &[]);
    let code = fx::anchor_code::FALLBACK_NOT_FOUND;
    fx::expect_code(result, 0, code);
}

#[test]
fn the_r1_ping_stub_is_gone() {
    // §3.3: the R1 `ping` stub is removed; its discriminator names nothing.
    let mut env = fx::Env::deployed();
    let data = fx::PING_DISCRIMINATOR.to_vec();
    let result = env.send(&[fx::raw_ix(data)], &[]);
    let code = fx::anchor_code::FALLBACK_NOT_FOUND;
    fx::expect_code(result, 0, code);
}

#[test]
fn data_shorter_than_a_discriminator_never_dispatches() {
    // §3.6 lists 100 (InstructionMissing) for this case. The Anchor 1.2.0
    // dispatcher (lang/syn/src/codegen/program/dispatch.rs) has no length
    // check and falls through to 101 (InstructionFallbackNotFound), so both
    // are accepted here. §3.6 classifies both, and neither reaches a handler.
    let mut env = fx::Env::deployed();
    let result = env.send(&[fx::raw_ix(vec![1, 2, 3, 4])], &[]);
    let Err(failed) = result else {
        panic!("4 bytes of instruction data must not dispatch");
    };
    let code = match failed.err {
        TransactionError::InstructionError(0, InstructionError::Custom(code)) => code,
        other => panic!("unexpected error {other:?}"),
    };
    let missing = fx::anchor_code::INSTRUCTION_MISSING;
    let fallback = fx::anchor_code::FALLBACK_NOT_FOUND;
    assert!(code == missing || code == fallback, "code {code}");
}

#[test]
fn malformed_claim_arguments_are_rejected() {
    let mut env = fx::Env::live();
    let recipient = fx::random_address();
    let payout_id = fx::random_payout_id();
    let accounts = env.claim_accounts(&recipient, &payout_id);
    let args = env.claim_args(payout_id, 1_000_000);
    let mut ix = fx::claim_ix(&accounts, &args);
    ix.data.truncate(20);
    let result = env.send(&[ix], &[]);
    let code = fx::anchor_code::DID_NOT_DESERIALIZE;
    fx::expect_code(result, 0, code);
}
