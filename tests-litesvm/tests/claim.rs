//! `claim` (contract §3.3.2): pay once, receipt and event layout, replay,
//! caps and the UTC day roll, expiry, pause, claim-authority auth, mint,
//! ATA and vault substitution, frozen accounts, balance, pre-funded receipt
//! (test C9), duplicate accounts and overflow. Also writes the compute-unit
//! report (#2980).
//!
//! Test names prefixed `c1_`..`c15_` exercise the handler step of that
//! number; `c9_a_pre_funded_receipt_address_is_claimed` is #2980's test C9.

use gogocash_cashback_litesvm_tests as fx;
use solana_keypair::Keypair;
use solana_signer::Signer;

const AMOUNT: u64 = 1_234_567;

#[test]
fn claim_pays_once_writes_the_receipt_and_emits_payout_claimed() {
    let mut env = fx::Env::live();
    let recipient = fx::random_address();
    let payout_id = fx::random_payout_id();
    let accounts = env.claim_accounts(&recipient, &payout_id);
    let args = env.claim_args(payout_id, AMOUNT);
    let meta = fx::expect_ok(env.send_claim(&accounts, &args, &[]));

    let recipient_ata = accounts.recipient_token_account;
    assert_eq!(env.token_balance(&recipient_ata), AMOUNT);
    let vault_balance = env.token_balance(&env.vault_token_account);
    assert_eq!(vault_balance, fx::VAULT_FUNDING - AMOUNT);

    let Some(account) = env.svm.get_account(&accounts.receipt) else {
        panic!("the receipt was not created");
    };
    assert_eq!(account.owner, fx::PROGRAM_ID);
    assert_eq!(account.lamports, env.rent(fx::RECEIPT_SIZE));
    let bump = fx::receipt_pda(&env.vault, &payout_id).1;
    let receipt = fx::ReceiptState {
        discriminator: fx::RECEIPT_DISCRIMINATOR,
        bump,
        payout_id,
        recipient,
        amount: AMOUNT,
        claimed_at: fx::NOW,
    };
    assert_eq!(env.receipt_state(&payout_id), Some(receipt));

    let vault = env.vault_state();
    assert!(!vault.paused);
    assert_eq!(vault.current_day, fx::utc_day(fx::NOW));
    assert_eq!(vault.claimed_today, AMOUNT);
    assert_eq!(vault.total_claimed, AMOUNT);
    assert_eq!(vault.claim_count, 1);
    assert_eq!(vault.total_withdrawn, 0);

    let event = fx::PayoutClaimed {
        vault: env.vault,
        receipt: accounts.receipt,
        payout_id,
        recipient,
        amount: AMOUNT,
        claimed_at: fx::NOW,
        day: fx::utc_day(fx::NOW),
        claimed_today: AMOUNT,
        claim_count: 1,
        total_claimed: AMOUNT,
    };
    assert_eq!(fx::payout_claimed_events(&meta.logs), [event]);
}

#[test]
fn claim_reproduces_the_contract_receipt_and_event_vectors() {
    let mut env = fx::Env::deployed_with_mint(fx::vectors::DEVNET_MINT);
    let accounts = env.initialize_accounts();
    let args = fx::InitializeArgs {
        admin: fx::vectors::ADMIN,
        guardian: fx::vectors::GUARDIAN,
        claim_authority: fx::vectors::CLAIM_AUTHORITY,
        max_per_claim: fx::DEFAULT_MAX_PER_CLAIM,
        max_per_day: fx::DEFAULT_MAX_PER_DAY,
    };
    fx::expect_ok(env.send_initialize(&accounts, &args, &[]));
    // No secret exists for the fixture claim key, so point the vault at an
    // ephemeral one and unpause by writing both fields directly. Neither
    // field appears in the receipt or the event.
    let claim_authority = env.claim_authority.pubkey();
    env.patch_vault_address(fx::vault_offset::CLAIM_AUTHORITY, &claim_authority);
    env.patch_vault(fx::vault_offset::PAUSED, &[0]);
    env.fund_vault(fx::VAULT_FUNDING);

    let payout_id = fx::vectors::payout_id();
    let accounts = env.claim_accounts(&fx::vectors::TEST_KEY_1, &payout_id);
    assert_eq!(accounts.receipt, fx::vectors::DEVNET_RECEIPT);
    let recipient_ata = accounts.recipient_token_account;
    assert_eq!(recipient_ata, fx::vectors::DEVNET_RECIP_ATA);
    let args = fx::ClaimArgs {
        payout_id,
        amount: fx::vectors::AMOUNT,
        expires_at: fx::vectors::EXPIRES_AT,
    };
    let data = fx::claim_ix(&accounts, &args).data;
    assert_eq!(data, fx::hex_decode(fx::vectors::CLAIM_DATA_HEX));

    let meta = fx::expect_ok(env.send_claim(&accounts, &args, &[]));
    let Some(receipt) = fx::account_data(&env.svm, &accounts.receipt) else {
        panic!("the receipt was not created");
    };
    assert_eq!(receipt, fx::hex_decode(fx::vectors::RECEIPT_HEX));
    let line = format!("Program data: {}", fx::vectors::PAYOUT_CLAIMED_BASE64);
    assert!(meta.logs.contains(&line), "{}", meta.pretty_logs());
}

#[test]
fn a_replayed_payout_id_fails_with_already_in_use() {
    let mut env = fx::Env::live();
    let recipient = fx::random_address();
    let (payout_id, result) = env.claim(&recipient, AMOUNT);
    fx::expect_ok(result);
    let receipt = env.receipt_state(&payout_id);

    // Same payout id, another recipient and amount (a front-running replay).
    let other = fx::random_address();
    let accounts = env.claim_accounts(&other, &payout_id);
    let args = env.claim_args(payout_id, AMOUNT + 1);
    let result = env.send_claim(&accounts, &args, &[]);
    fx::expect_already_in_use(result, fx::CLAIM_INDEX);

    // The exact same claim again.
    let accounts = env.claim_accounts(&recipient, &payout_id);
    let args = env.claim_args(payout_id, AMOUNT);
    let result = env.send_claim(&accounts, &args, &[]);
    fx::expect_already_in_use(result, fx::CLAIM_INDEX);

    assert_eq!(env.receipt_state(&payout_id), receipt);
    let vault = env.vault_state();
    assert_eq!(vault.claim_count, 1);
    assert_eq!(vault.total_claimed, AMOUNT);
}

#[test]
fn a_replay_while_paused_still_reports_already_in_use() {
    // S2 (the receipt `init`) runs before any handler check (§3.3.0).
    let mut env = fx::Env::live();
    let recipient = fx::random_address();
    let (payout_id, result) = env.claim(&recipient, AMOUNT);
    fx::expect_ok(result);
    let pause = fx::pause_ix(&env.vault, &env.guardian.pubkey());
    fx::expect_ok(env.send(&[pause], &[]));
    let accounts = env.claim_accounts(&recipient, &payout_id);
    let args = env.claim_args(payout_id, AMOUNT);
    let result = env.send_claim(&accounts, &args, &[]);
    fx::expect_already_in_use(result, fx::CLAIM_INDEX);
}

#[test]
fn c9_a_pre_funded_receipt_address_is_claimed() {
    // Anyone can send lamports to a known receipt address before the claim.
    // A system transfer to a new, empty account must leave it rent-exempt,
    // so the smallest pre-fund a stranger can land is the rent-exempt
    // minimum for 0 bytes. The cases cover that minimum (the program tops up
    // the rest), exactly the receipt's rent (no top-up) and far more than
    // the rent. Anchor's `init` then takes the transfer + allocate + assign
    // path instead of `create_account` (§3.3.2 CPIs).
    for case in 0..3 {
        let mut env = fx::Env::live();
        let prefund = match case {
            0 => env.rent(0),
            1 => env.rent(fx::RECEIPT_SIZE),
            _ => 10 * fx::LAMPORTS_PER_SOL,
        };
        let recipient = fx::random_address();
        let payout_id = fx::random_payout_id();
        let accounts = env.claim_accounts(&recipient, &payout_id);
        fx::fund_lamports(&mut env.svm, &accounts.receipt, prefund);
        let args = env.claim_args(payout_id, AMOUNT);
        fx::expect_ok(env.send_claim(&accounts, &args, &[]));
        let Some(receipt) = env.receipt_state(&payout_id) else {
            panic!("the pre-funded receipt does not decode (prefund {prefund})");
        };
        assert_eq!(receipt.amount, AMOUNT);
        assert_eq!(receipt.recipient, recipient);
        let Some(account) = env.svm.get_account(&accounts.receipt) else {
            panic!("the receipt was not created (prefund {prefund})");
        };
        assert_eq!(account.owner, fx::PROGRAM_ID);
        assert!(account.lamports >= env.rent(fx::RECEIPT_SIZE));
        assert!(account.lamports >= prefund);
        let recipient_ata = accounts.recipient_token_account;
        assert_eq!(env.token_balance(&recipient_ata), AMOUNT);
        assert_eq!(env.vault_state().claim_count, 1);
    }
}

#[test]
fn the_payer_may_be_the_claim_authority() {
    let mut env = fx::Env::live();
    let claim_authority = env.claim_authority.pubkey();
    fx::fund_lamports(&mut env.svm, &claim_authority, fx::LAMPORTS_PER_SOL);
    let recipient = fx::random_address();
    let payout_id = fx::random_payout_id();
    let mut accounts = env.claim_accounts(&recipient, &payout_id);
    accounts.payer = claim_authority;
    let args = env.claim_args(payout_id, AMOUNT);
    fx::expect_ok(env.send_claim(&accounts, &args, &[]));
    let recipient_ata = accounts.recipient_token_account;
    assert_eq!(env.token_balance(&recipient_ata), AMOUNT);
}

#[test]
fn c1_a_paused_vault_refuses_claims() {
    // A freshly initialized vault starts paused (SEC-5 ceremony).
    let mut env = fx::Env::initialized();
    env.fund_vault(fx::VAULT_FUNDING);
    let (_, result) = env.claim(&fx::random_address(), AMOUNT);
    fx::expect_claim_error(result, fx::code::PAUSED);
}

#[test]
fn c2_a_signer_that_is_not_the_claim_authority_is_rejected() {
    let mut env = fx::Env::live();
    let stranger = Keypair::new();
    let payout_id = fx::random_payout_id();
    let mut accounts = env.claim_accounts(&fx::random_address(), &payout_id);
    accounts.claim_authority = stranger.pubkey();
    let args = env.claim_args(payout_id, AMOUNT);
    let result = env.send_claim(&accounts, &args, &[&stranger]);
    fx::expect_claim_error(result, fx::code::INVALID_CLAIM_AUTHORITY);
}

#[test]
fn the_claim_authority_must_sign() {
    let mut env = fx::Env::live();
    let payout_id = fx::random_payout_id();
    let accounts = env.claim_accounts(&fx::random_address(), &payout_id);
    let args = env.claim_args(payout_id, AMOUNT);
    let mut claim = fx::claim_ix(&accounts, &args);
    claim.accounts[fx::CLAIM_AUTHORITY_ACCOUNT_INDEX].is_signer = false;
    let payer = env.payer.pubkey();
    let ata = fx::create_ata_idempotent(&payer, &accounts.recipient, &accounts.mint);
    let result = env.send(&[ata, claim], &[]);
    let code = fx::anchor_code::NOT_SIGNER;
    fx::expect_code(result, fx::CLAIM_INDEX, code);
}

#[test]
fn the_vault_must_be_writable() {
    let mut env = fx::Env::live();
    let payout_id = fx::random_payout_id();
    let accounts = env.claim_accounts(&fx::random_address(), &payout_id);
    let args = env.claim_args(payout_id, AMOUNT);
    let mut claim = fx::claim_ix(&accounts, &args);
    claim.accounts[0].is_writable = false;
    let payer = env.payer.pubkey();
    let ata = fx::create_ata_idempotent(&payer, &accounts.recipient, &accounts.mint);
    let result = env.send(&[ata, claim], &[]);
    let code = fx::anchor_code::CONSTRAINT_MUT;
    fx::expect_code(result, fx::CLAIM_INDEX, code);
    assert_eq!(env.vault_state().claim_count, 0);
}

#[test]
fn handler_checks_run_in_contract_order() {
    let mut env = fx::Env::live_with_balance(1_000_000);
    let recipient = fx::random_address();

    // C1 before C2: paused and signed by a stranger.
    let pause = fx::pause_ix(&env.vault, &env.guardian.pubkey());
    fx::expect_ok(env.send(&[pause], &[]));
    let stranger = Keypair::new();
    let payout_id = fx::random_payout_id();
    let mut accounts = env.claim_accounts(&recipient, &payout_id);
    accounts.claim_authority = stranger.pubkey();
    let args = env.claim_args(payout_id, AMOUNT);
    let result = env.send_claim(&accounts, &args, &[&stranger]);
    fx::expect_claim_error(result, fx::code::PAUSED);
    let unpause = fx::unpause_ix(&env.vault, &env.admin.pubkey());
    fx::expect_ok(env.send(&[unpause], &[]));

    // C6 before C7: zero payout id and zero amount.
    let zero_id = [0u8; 32];
    let accounts = env.claim_accounts(&recipient, &zero_id);
    let args = env.claim_args(zero_id, 0);
    let result = env.send_claim(&accounts, &args, &[]);
    fx::expect_claim_error(result, fx::code::ZERO_PAYOUT_ID);

    // C8 before C11: above the per-claim cap and already expired.
    let payout_id = fx::random_payout_id();
    let accounts = env.claim_accounts(&recipient, &payout_id);
    let mut args = env.claim_args(payout_id, fx::DEFAULT_MAX_PER_CLAIM + 1);
    args.expires_at = env.now() - 1;
    let result = env.send_claim(&accounts, &args, &[]);
    fx::expect_claim_error(result, fx::code::EXCEEDS_MAX_PER_CLAIM);

    // C11 before C13: expired while the vault ATA is frozen.
    let vault_ata = env.vault_token_account;
    env.freeze(&vault_ata);
    args.amount = 1;
    let result = env.send_claim(&accounts, &args, &[]);
    fx::expect_claim_error(result, fx::code::EXPIRED);

    // C13 before C14 before C15: both ATAs frozen, amount above the balance.
    let recipient_ata = env.create_ata(&recipient);
    env.freeze(&recipient_ata);
    let args = env.claim_args(payout_id, 2_000_000);
    let result = env.send_claim_only(&accounts, &args, &[]);
    fx::expect_program_error(result, 0, fx::code::VAULT_TOKEN_ACCOUNT_FROZEN);
    env.thaw(&vault_ata);
    let result = env.send_claim_only(&accounts, &args, &[]);
    fx::expect_program_error(result, 0, fx::code::RECIPIENT_TOKEN_ACCOUNT_FROZEN);
    env.thaw(&recipient_ata);
    let result = env.send_claim_only(&accounts, &args, &[]);
    fx::expect_program_error(result, 0, fx::code::INSUFFICIENT_VAULT_BALANCE);
}

#[test]
fn a_different_mint_cannot_address_the_vault() {
    // S4: the vault seeds bind it to its mint.
    let mut env = fx::Env::live();
    let other_mint = env.new_mint(fx::USDC_DECIMALS);
    let recipient = fx::random_address();
    let payout_id = fx::random_payout_id();
    let mut accounts = env.claim_accounts(&recipient, &payout_id);
    accounts.mint = other_mint;
    accounts.recipient_token_account = fx::associated_token_address(&recipient, &other_mint);
    let args = env.claim_args(payout_id, AMOUNT);
    let result = env.send_claim(&accounts, &args, &[]);
    let code = fx::anchor_code::CONSTRAINT_SEEDS;
    fx::expect_code(result, fx::CLAIM_INDEX, code);
}

#[test]
fn c3_a_vault_whose_stored_mint_differs_is_rejected() {
    // Defense in depth: reachable only by tampering with the stored mint,
    // because the seeds already bind the vault address to the mint account.
    let mut env = fx::Env::live();
    let other_mint = env.new_mint(fx::USDC_DECIMALS);
    env.patch_vault_address(fx::vault_offset::MINT, &other_mint);
    let (_, result) = env.claim(&fx::random_address(), AMOUNT);
    fx::expect_claim_error(result, fx::code::INVALID_MINT);
}

#[test]
fn c4_a_non_canonical_vault_token_account_is_rejected() {
    let mut env = fx::Env::live();
    let decoy = fx::random_address();
    let state = fx::TokenAccountState::initialized(env.mint, env.vault, fx::VAULT_FUNDING);
    env.put_token_account(decoy, &state);
    let payout_id = fx::random_payout_id();
    let mut accounts = env.claim_accounts(&fx::random_address(), &payout_id);
    accounts.vault_token_account = decoy;
    let args = env.claim_args(payout_id, AMOUNT);
    let result = env.send_claim(&accounts, &args, &[]);
    fx::expect_claim_error(result, fx::code::INVALID_VAULT_TOKEN_ACCOUNT);
}

#[test]
fn a_second_vault_cannot_spend_the_first_vaults_token_account() {
    // Vault substitution: a second, live vault (another mint, same roles)
    // names the first vault's funded token account. The seeds pass for the
    // second vault, so C4 is what stops it.
    let mut env = fx::Env::live();
    let first_vault_ata = env.vault_token_account;
    let other_mint = env.new_mint(fx::USDC_DECIMALS);
    let (other_vault, _) = fx::vault_pda(&other_mint);
    let mut init = env.initialize_accounts();
    init.vault = other_vault;
    init.mint = other_mint;
    init.vault_token_account = fx::associated_token_address(&other_vault, &other_mint);
    let args = env.initialize_args();
    fx::expect_ok(env.send_initialize(&init, &args, &[]));
    let unpause = fx::unpause_ix(&other_vault, &env.admin.pubkey());
    fx::expect_ok(env.send(&[unpause], &[]));

    let recipient = fx::random_address();
    let payout_id = fx::random_payout_id();
    let mut accounts = env.claim_accounts(&recipient, &payout_id);
    accounts.vault = other_vault;
    accounts.receipt = fx::receipt_pda(&other_vault, &payout_id).0;
    accounts.mint = other_mint;
    accounts.vault_token_account = first_vault_ata;
    accounts.recipient_token_account = fx::associated_token_address(&recipient, &other_mint);
    let args = env.claim_args(payout_id, AMOUNT);
    let result = env.send_claim(&accounts, &args, &[]);
    fx::expect_claim_error(result, fx::code::INVALID_VAULT_TOKEN_ACCOUNT);
    assert_eq!(env.token_balance(&first_vault_ata), fx::VAULT_FUNDING);
}

#[test]
fn a_vault_owned_by_another_program_is_refused() {
    // A Vault-shaped account at the vault address that this program does
    // not own fails the owner check in S1 (3007).
    let mut env = fx::Env::deployed();
    let vault = env.vault;
    let data = fx::hex_decode(fx::vectors::VAULT_V1_HEX);
    fx::put_account(&mut env.svm, vault, fx::random_address(), data);
    let (_, result) = env.claim(&fx::random_address(), AMOUNT);
    let code = fx::anchor_code::OWNED_BY_WRONG_PROGRAM;
    fx::expect_code(result, fx::CLAIM_INDEX, code);
}

#[test]
fn a_token_program_other_than_classic_token_is_refused() {
    let mut env = fx::Env::live();
    let payout_id = fx::random_payout_id();
    let mut accounts = env.claim_accounts(&fx::random_address(), &payout_id);
    accounts.token_program = fx::TOKEN_2022_PROGRAM_ID;
    let args = env.claim_args(payout_id, AMOUNT);
    let result = env.send_claim(&accounts, &args, &[]);
    let code = fx::anchor_code::INVALID_PROGRAM_ID;
    fx::expect_code(result, fx::CLAIM_INDEX, code);
}

#[test]
fn a_token_2022_recipient_token_account_is_refused() {
    let mut env = fx::Env::live();
    let recipient = fx::random_address();
    let token_2022_account = fx::random_address();
    let state = fx::TokenAccountState::initialized(env.mint, recipient, 0);
    let data = state.pack();
    fx::put_account(
        &mut env.svm,
        token_2022_account,
        fx::TOKEN_2022_PROGRAM_ID,
        data,
    );
    let payout_id = fx::random_payout_id();
    let mut accounts = env.claim_accounts(&recipient, &payout_id);
    accounts.recipient_token_account = token_2022_account;
    let args = env.claim_args(payout_id, AMOUNT);
    let result = env.send_claim_only(&accounts, &args, &[]);
    let code = fx::anchor_code::OWNED_BY_WRONG_PROGRAM;
    fx::expect_code(result, 0, code);
}

#[test]
fn the_vault_as_recipient_fails_the_system_owner_check() {
    // C5 also lists the vault, but a program-owned recipient already fails
    // `SystemAccount` in S1 (3011) before any handler check runs.
    let mut env = fx::Env::live();
    let vault = env.vault;
    let payout_id = fx::random_payout_id();
    let accounts = env.claim_accounts(&vault, &payout_id);
    let args = env.claim_args(payout_id, AMOUNT);
    let result = env.send_claim(&accounts, &args, &[]);
    let code = fx::anchor_code::NOT_SYSTEM_OWNED;
    fx::expect_code(result, fx::CLAIM_INDEX, code);
}

#[test]
fn c5_the_claim_authority_or_the_payer_cannot_be_the_recipient() {
    let mut env = fx::Env::live();
    let signers = [env.claim_authority.pubkey(), env.payer.pubkey()];
    for recipient in signers {
        let payout_id = fx::random_payout_id();
        let accounts = env.claim_accounts(&recipient, &payout_id);
        let args = env.claim_args(payout_id, AMOUNT);
        let result = env.send_claim(&accounts, &args, &[]);
        fx::expect_claim_error(result, fx::code::INVALID_RECIPIENT);
    }
}

#[test]
fn c6_an_all_zero_payout_id_is_rejected() {
    let mut env = fx::Env::live();
    let zero_id = [0u8; 32];
    let accounts = env.claim_accounts(&fx::random_address(), &zero_id);
    let args = env.claim_args(zero_id, AMOUNT);
    let result = env.send_claim(&accounts, &args, &[]);
    fx::expect_claim_error(result, fx::code::ZERO_PAYOUT_ID);
}

#[test]
fn c7_a_zero_amount_is_rejected() {
    let mut env = fx::Env::live();
    let (_, result) = env.claim(&fx::random_address(), 0);
    fx::expect_claim_error(result, fx::code::ZERO_AMOUNT);
}

#[test]
fn c8_the_per_claim_cap_is_inclusive() {
    let mut env = fx::Env::live();
    let recipient = fx::random_address();
    let (_, result) = env.claim(&recipient, fx::DEFAULT_MAX_PER_CLAIM + 1);
    fx::expect_claim_error(result, fx::code::EXCEEDS_MAX_PER_CLAIM);
    let (_, result) = env.claim(&recipient, fx::DEFAULT_MAX_PER_CLAIM);
    fx::expect_ok(result);
}

#[test]
fn c10_the_daily_cap_holds_within_a_utc_day_and_resets_on_the_next() {
    let mut env = fx::Env::live();
    let recipient = fx::random_address();
    for _ in 0..4 {
        let (_, result) = env.claim(&recipient, fx::DEFAULT_MAX_PER_CLAIM);
        fx::expect_ok(result);
    }
    assert_eq!(env.vault_state().claimed_today, fx::DEFAULT_MAX_PER_DAY);
    let (_, result) = env.claim(&recipient, 1);
    fx::expect_claim_error(result, fx::code::DAY_CAP_EXCEEDED);

    // Last second of the same UTC day: still capped.
    let day = fx::utc_day(fx::NOW);
    env.set_now((day + 1) * fx::SECONDS_PER_DAY - 1);
    let (_, result) = env.claim(&recipient, 1);
    fx::expect_claim_error(result, fx::code::DAY_CAP_EXCEEDED);

    // First second of the next UTC day: the bucket resets.
    env.set_now((day + 1) * fx::SECONDS_PER_DAY);
    let (_, result) = env.claim(&recipient, fx::DEFAULT_MAX_PER_CLAIM);
    fx::expect_ok(result);
    let vault = env.vault_state();
    assert_eq!(vault.current_day, day + 1);
    assert_eq!(vault.claimed_today, fx::DEFAULT_MAX_PER_CLAIM);
    assert_eq!(vault.total_claimed, 5 * fx::DEFAULT_MAX_PER_CLAIM);
    assert_eq!(vault.claim_count, 5);
}

#[test]
fn a_clock_that_moves_back_keeps_counting_in_the_newer_day() {
    let mut env = fx::Env::live();
    let recipient = fx::random_address();
    let day = fx::utc_day(fx::NOW);
    env.set_now(fx::NOW + fx::SECONDS_PER_DAY);
    let (_, result) = env.claim(&recipient, 3_000_000);
    fx::expect_ok(result);

    // Back to the previous day: no reset, the newer bucket keeps counting.
    env.set_now(fx::NOW);
    let (_, result) = env.claim(&recipient, 2_000_000);
    fx::expect_ok(result);
    let vault = env.vault_state();
    assert_eq!(vault.current_day, day + 1);
    assert_eq!(vault.claimed_today, 5_000_000);

    for _ in 0..3 {
        let (_, result) = env.claim(&recipient, fx::DEFAULT_MAX_PER_CLAIM);
        fx::expect_ok(result);
    }
    assert_eq!(env.vault_state().claimed_today, fx::DEFAULT_MAX_PER_DAY);
    let (_, result) = env.claim(&recipient, 1);
    fx::expect_claim_error(result, fx::code::DAY_CAP_EXCEEDED);
}

#[test]
fn lowering_the_daily_cap_below_claimed_today_blocks_further_claims() {
    let mut env = fx::Env::live();
    let recipient = fx::random_address();
    let (_, result) = env.claim(&recipient, fx::DEFAULT_MAX_PER_CLAIM);
    fx::expect_ok(result);
    let mut update = env.update_config_args();
    update.max_per_claim = 1_000_000;
    update.max_per_day = 1_000_000;
    let ix = fx::update_config_ix(&env.vault, &env.admin.pubkey(), &update);
    fx::expect_ok(env.send(&[ix], &[]));
    let (_, result) = env.claim(&recipient, 1);
    fx::expect_claim_error(result, fx::code::DAY_CAP_EXCEEDED);
}

#[test]
fn c11_c12_expiry_is_bounded_to_now_through_now_plus_900() {
    let mut env = fx::Env::live();
    let recipient = fx::random_address();
    let now = env.now();
    let cases = [
        (now - 1, Some(fx::code::EXPIRED)),
        (now, None),
        (now + fx::MAX_EXPIRY_AHEAD, None),
        (
            now + fx::MAX_EXPIRY_AHEAD + 1,
            Some(fx::code::EXPIRY_TOO_FAR),
        ),
    ];
    for (expires_at, expected) in cases {
        let payout_id = fx::random_payout_id();
        let accounts = env.claim_accounts(&recipient, &payout_id);
        let mut args = env.claim_args(payout_id, AMOUNT);
        args.expires_at = expires_at;
        let result = env.send_claim(&accounts, &args, &[]);
        match expected {
            Some(code) => {
                fx::expect_claim_error(result, code);
            }
            None => {
                fx::expect_ok(result);
            }
        }
    }
}

#[test]
fn c13_a_frozen_vault_token_account_holds_claims() {
    let mut env = fx::Env::live();
    let vault_ata = env.vault_token_account;
    let recipient = fx::random_address();
    env.freeze(&vault_ata);
    let (_, result) = env.claim(&recipient, AMOUNT);
    fx::expect_claim_error(result, fx::code::VAULT_TOKEN_ACCOUNT_FROZEN);
    env.thaw(&vault_ata);
    let (_, result) = env.claim(&recipient, AMOUNT);
    fx::expect_ok(result);
}

#[test]
fn c14_a_frozen_recipient_token_account_is_rejected() {
    let mut env = fx::Env::live();
    let recipient = fx::random_address();
    let recipient_ata = env.create_ata(&recipient);
    env.freeze(&recipient_ata);
    let payout_id = fx::random_payout_id();
    let accounts = env.claim_accounts(&recipient, &payout_id);
    let args = env.claim_args(payout_id, AMOUNT);
    let result = env.send_claim_only(&accounts, &args, &[]);
    fx::expect_program_error(result, 0, fx::code::RECIPIENT_TOKEN_ACCOUNT_FROZEN);
}

#[test]
fn c15_the_vault_balance_bounds_the_claim() {
    let mut env = fx::Env::live_with_balance(1_000_000);
    let (_, result) = env.claim(&fx::random_address(), 1_000_001);
    fx::expect_claim_error(result, fx::code::INSUFFICIENT_VAULT_BALANCE);
    let (_, result) = env.claim(&fx::random_address(), 1_000_000);
    fx::expect_ok(result);
    assert_eq!(env.token_balance(&env.vault_token_account), 0);
}

#[test]
fn a_missing_recipient_ata_is_not_initialized() {
    let mut env = fx::Env::live();
    let payout_id = fx::random_payout_id();
    let accounts = env.claim_accounts(&fx::random_address(), &payout_id);
    let args = env.claim_args(payout_id, AMOUNT);
    let result = env.send_claim_only(&accounts, &args, &[]);
    let code = fx::anchor_code::NOT_INITIALIZED;
    fx::expect_code(result, 0, code);
}

#[test]
fn a_non_canonical_recipient_token_account_is_rejected() {
    let mut env = fx::Env::live();
    let recipient = fx::random_address();
    let side_account = fx::random_address();
    let state = fx::TokenAccountState::initialized(env.mint, recipient, 0);
    env.put_token_account(side_account, &state);
    let payout_id = fx::random_payout_id();
    let mut accounts = env.claim_accounts(&recipient, &payout_id);
    accounts.recipient_token_account = side_account;
    let args = env.claim_args(payout_id, AMOUNT);
    let result = env.send_claim_only(&accounts, &args, &[]);
    let code = fx::anchor_code::CONSTRAINT_ASSOCIATED;
    fx::expect_code(result, 0, code);
}

#[test]
fn a_re_owned_recipient_ata_fails_at_the_ata_instruction() {
    // §3.3.0 / §3.7: the rail's createAssociatedTokenIdempotent fails first
    // (Custom(0) at index 0, needs_review); without it Anchor reports 2015.
    let mut env = fx::Env::live();
    let recipient = fx::random_address();
    let payout_id = fx::random_payout_id();
    let accounts = env.claim_accounts(&recipient, &payout_id);
    let state = fx::TokenAccountState::initialized(env.mint, fx::random_address(), 0);
    env.put_token_account(accounts.recipient_token_account, &state);
    let args = env.claim_args(payout_id, AMOUNT);
    let result = env.send_claim(&accounts, &args, &[]);
    fx::expect_code(result, 0, fx::ATA_INVALID_OWNER);
    let result = env.send_claim_only(&accounts, &args, &[]);
    let code = fx::anchor_code::CONSTRAINT_TOKEN_OWNER;
    fx::expect_code(result, 0, code);
}

#[test]
fn the_vault_token_account_as_recipient_account_is_a_duplicate() {
    let mut env = fx::Env::live();
    let payout_id = fx::random_payout_id();
    let mut accounts = env.claim_accounts(&fx::random_address(), &payout_id);
    accounts.recipient_token_account = env.vault_token_account;
    let args = env.claim_args(payout_id, AMOUNT);
    let result = env.send_claim(&accounts, &args, &[]);
    let code = fx::anchor_code::DUPLICATE_MUTABLE_ACCOUNT;
    fx::expect_code(result, fx::CLAIM_INDEX, code);
}

#[test]
fn a_non_canonical_receipt_address_is_rejected() {
    let mut env = fx::Env::live();
    let payout_id = fx::random_payout_id();
    let mut accounts = env.claim_accounts(&fx::random_address(), &payout_id);
    accounts.receipt = fx::random_address();
    let args = env.claim_args(payout_id, AMOUNT);
    let result = env.send_claim(&accounts, &args, &[]);
    let code = fx::anchor_code::CONSTRAINT_SEEDS;
    fx::expect_code(result, fx::CLAIM_INDEX, code);
}

#[test]
fn claimed_today_overflow_is_math_overflow() {
    let mut env = fx::Env::live();
    env.patch_vault_u64(fx::vault_offset::CLAIMED_TODAY, u64::MAX);
    let (_, result) = env.claim(&fx::random_address(), 1);
    fx::expect_claim_error(result, fx::code::MATH_OVERFLOW);
}

#[test]
fn c12_expiry_overflow_is_math_overflow() {
    let mut env = fx::Env::live();
    env.set_now(i64::MAX - 10);
    let payout_id = fx::random_payout_id();
    let accounts = env.claim_accounts(&fx::random_address(), &payout_id);
    let args = fx::ClaimArgs {
        payout_id,
        amount: AMOUNT,
        expires_at: i64::MAX,
    };
    let result = env.send_claim(&accounts, &args, &[]);
    fx::expect_claim_error(result, fx::code::MATH_OVERFLOW);
}

#[test]
fn counter_overflow_in_the_effects_is_math_overflow() {
    let total_claimed = fx::vault_offset::TOTAL_CLAIMED;
    let claim_count = fx::vault_offset::CLAIM_COUNT;
    for offset in [total_claimed, claim_count] {
        let mut env = fx::Env::live();
        env.patch_vault_u64(offset, u64::MAX);
        let (payout_id, result) = env.claim(&fx::random_address(), 1);
        fx::expect_claim_error(result, fx::code::MATH_OVERFLOW);
        assert_eq!(env.receipt_state(&payout_id), None);
    }
}

#[test]
fn compute_units_are_reported_and_claim_fits_the_budget() {
    let mut report = fx::CuReport::default();
    let mut env = fx::Env::deployed();
    let payer = env.payer.pubkey();
    let admin = env.admin.pubkey();
    let vault = env.vault;

    let create_vault_ata = fx::create_ata_idempotent(&payer, &vault, &env.mint);
    fx::expect_ok(env.send(&[create_vault_ata], &[]));
    let ix = fx::initialize_ix(&env.initialize_accounts(), &env.initialize_args());
    report.record("initialize", fx::compute_units(env.send(&[ix], &[])));
    env.fund_vault(fx::VAULT_FUNDING);
    let ix = fx::unpause_ix(&vault, &admin);
    report.record("unpause", fx::compute_units(env.send(&[ix], &[])));

    // `claim` alone, with the recipient ATA already present.
    let recipient = fx::random_address();
    env.create_ata(&recipient);
    let payout_id = fx::random_payout_id();
    let accounts = env.claim_accounts(&recipient, &payout_id);
    let args = env.claim_args(payout_id, AMOUNT);
    let claim_units = fx::compute_units(env.send_claim_only(&accounts, &args, &[]));
    report.record("claim", claim_units);

    // The rail's transaction without compute-budget instructions (O15):
    // recipient ATA present, then recipient ATA created in the transaction.
    let payout_id = fx::random_payout_id();
    let accounts = env.claim_accounts(&recipient, &payout_id);
    let args = env.claim_args(payout_id, AMOUNT);
    let units = fx::compute_units(env.send_claim(&accounts, &args, &[]));
    report.record("tx_claim_ata_present", units);
    let payout_id = fx::random_payout_id();
    let accounts = env.claim_accounts(&fx::random_address(), &payout_id);
    let args = env.claim_args(payout_id, AMOUNT);
    let units = fx::compute_units(env.send_claim(&accounts, &args, &[]));
    report.record("tx_claim_ata_created", units);

    let ix = fx::pause_ix(&vault, &admin);
    report.record("pause", fx::compute_units(env.send(&[ix], &[])));
    let update = env.update_config_args();
    let ix = fx::update_config_ix(&vault, &admin, &update);
    report.record("update_config", fx::compute_units(env.send(&[ix], &[])));
    let destination = env.create_ata(&admin);
    let ix = fx::withdraw_ix(&env.withdraw_accounts(&destination), 1_000_000);
    report.record("withdraw", fx::compute_units(env.send(&[ix], &[])));
    let new_admin = Keypair::new();
    let ix = fx::propose_admin_ix(&vault, &admin, &new_admin.pubkey());
    report.record("propose_admin", fx::compute_units(env.send(&[ix], &[])));
    let ix = fx::accept_admin_ix(&vault, &new_admin.pubkey());
    let units = fx::compute_units(env.send(&[ix], &[&new_admin]));
    report.record("accept_admin", units);

    for name in fx::INSTRUCTION_NAMES {
        assert!(report.units.contains_key(name), "{name} not measured");
    }
    let so_sha256 = fx::sha256_hex(fx::program_bytes());
    if let Some(path) = report.write_if_requested(&so_sha256) {
        println!("wrote {}", path.display());
    }
    println!("{}", report.to_json(&so_sha256));
    let budget = fx::CLAIM_CU_BUDGET;
    assert!(claim_units <= budget, "claim used {claim_units} CU");
}
