//! LiteSVM integration tests for the gogocash_cashback stub.
//!
//! Every test loads the artifact named by `program_so_path()`, so CI can point
//! `GOGOCASH_CASHBACK_SO` at the exact .so it built and checked.

use gogocash_cashback_litesvm_tests as fixtures;
use litesvm::types::TransactionResult;
use litesvm::LiteSVM;
use solana_instruction::error::InstructionError;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;

fn svm_with_program() -> LiteSVM {
    let program = fixtures::read_program();
    let mut svm = LiteSVM::new();
    if let Err(err) = svm.add_program(fixtures::PROGRAM_ID, &program) {
        panic!("LiteSVM refused the program: {err}");
    }
    svm
}

fn funded_payer(svm: &mut LiteSVM) -> Keypair {
    let payer = Keypair::new();
    if let Err(failed) = svm.airdrop(&payer.pubkey(), 1_000_000_000) {
        panic!("airdrop failed: {:?}", failed.err);
    }
    payer
}

// LiteSVM's TransactionResult carries a ~200-byte FailedTransactionMetadata
// by value. That is LiteSVM's API, not ours; litesvm v0.16.0 allows this lint
// workspace-wide for the same reason.
#[allow(clippy::result_large_err)]
fn send(svm: &mut LiteSVM, payer: &Keypair, data: Vec<u8>) -> TransactionResult {
    let ix = Instruction {
        program_id: fixtures::PROGRAM_ID,
        accounts: vec![],
        data,
    };
    let message = Message::new(&[ix], Some(&payer.pubkey()));
    let tx = Transaction::new(&[payer], message, svm.latest_blockhash());
    svm.send_transaction(tx)
}

#[test]
fn ping_succeeds_and_logs_the_fixed_message() {
    let mut svm = svm_with_program();
    let payer = funded_payer(&mut svm);
    let data = fixtures::PING_DISCRIMINATOR.to_vec();
    let meta = match send(&mut svm, &payer, data) {
        Ok(meta) => meta,
        Err(failed) => panic!("ping failed: {failed:?}"),
    };
    let logged = meta.logs.iter().any(|l| l.contains(fixtures::PING_LOG));
    assert!(logged, "missing ping log line:\n{}", meta.pretty_logs());
}

#[test]
fn unknown_discriminator_is_rejected() {
    let mut svm = svm_with_program();
    let payer = funded_payer(&mut svm);
    let Err(failed) = send(&mut svm, &payer, vec![0; 8]) else {
        panic!("an unknown discriminator must fail");
    };
    // The program defines no fallback, so Anchor's dispatcher returns
    // ErrorCode::InstructionFallbackNotFound, error number 101.
    let expected = TransactionError::InstructionError(0, InstructionError::Custom(101));
    assert_eq!(failed.err, expected);
}

#[test]
fn artifact_is_sbpf_v3_and_embeds_security_txt() {
    let program = fixtures::read_program();
    let e_flags = fixtures::elf64_le_e_flags(&program);
    assert_eq!(e_flags, Some(fixtures::EXPECTED_SBPF_VERSION));
    let has_marker = fixtures::contains_bytes(&program, fixtures::SECURITY_TXT_BEGIN);
    assert!(has_marker, "security.txt marker missing");
}
