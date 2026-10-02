//! `withdraw` (contract §3.3.8): admin only, allowed while paused, into an
//! unfrozen vault-mint account owned by the admin, with checked accounting.

use gogocash_cashback_litesvm_tests as fx;
use solana_address::Address;
use solana_signer::Signer;

/// The admin's canonical ATA for the vault mint.
fn admin_destination(env: &mut fx::Env) -> Address {
    let admin = env.admin.pubkey();
    env.create_ata(&admin)
}

#[test]
fn the_admin_withdraws_while_paused() {
    let mut env = fx::Env::initialized();
    env.fund_vault(10_000_000);
    let destination = admin_destination(&mut env);
    let accounts = env.withdraw_accounts(&destination);
    let meta = fx::expect_ok(env.send(&[fx::withdraw_ix(&accounts, 4_000_000)], &[]));
    assert!(fx::payout_claimed_events(&meta.logs).is_empty());
    assert_eq!(env.token_balance(&destination), 4_000_000);
    assert_eq!(env.token_balance(&env.vault_token_account), 6_000_000);
    let vault = env.vault_state();
    assert!(vault.paused);
    assert_eq!(vault.total_withdrawn, 4_000_000);
}

#[test]
fn the_conservation_identity_holds_after_claims_and_withdrawals() {
    // vault balance == deposits - total_claimed - total_withdrawn (§3.3.8).
    let mut env = fx::Env::live();
    let (_, result) = env.claim(&fx::random_address(), 1_500_000);
    fx::expect_ok(result);
    let destination = admin_destination(&mut env);
    let accounts = env.withdraw_accounts(&destination);
    fx::expect_ok(env.send(&[fx::withdraw_ix(&accounts, 2_000_000)], &[]));
    fx::expect_ok(env.send(&[fx::withdraw_ix(&accounts, 3_000_000)], &[]));
    let vault = env.vault_state();
    assert_eq!(vault.total_claimed, 1_500_000);
    assert_eq!(vault.total_withdrawn, 5_000_000);
    let spent = vault.total_claimed + vault.total_withdrawn;
    let balance = env.token_balance(&env.vault_token_account);
    assert_eq!(balance, fx::VAULT_FUNDING - spent);
}

#[test]
fn any_unfrozen_admin_owned_account_of_the_mint_is_a_valid_destination() {
    let mut env = fx::Env::live();
    let destination = fx::random_address();
    let state = fx::TokenAccountState::initialized(env.mint, env.admin.pubkey(), 0);
    env.put_token_account(destination, &state);
    let accounts = env.withdraw_accounts(&destination);
    fx::expect_ok(env.send(&[fx::withdraw_ix(&accounts, 1_000_000)], &[]));
    assert_eq!(env.token_balance(&destination), 1_000_000);
}

#[test]
fn w1_only_the_admin_can_withdraw() {
    let mut env = fx::Env::live();
    let destination = admin_destination(&mut env);
    let not_admins = [env.guardian.pubkey(), env.claim_authority.pubkey()];
    for signer in not_admins {
        let mut accounts = env.withdraw_accounts(&destination);
        accounts.admin = signer;
        let result = env.send(&[fx::withdraw_ix(&accounts, 1)], &[]);
        fx::expect_program_error(result, 0, fx::code::NOT_ADMIN);
    }
}

#[test]
fn a_different_mint_cannot_address_the_vault() {
    let mut env = fx::Env::live();
    let other_mint = env.new_mint(fx::USDC_DECIMALS);
    let admin = env.admin.pubkey();
    let destination = env.create_ata_for(&admin, &other_mint);
    let mut accounts = env.withdraw_accounts(&destination);
    accounts.mint = other_mint;
    let result = env.send(&[fx::withdraw_ix(&accounts, 1)], &[]);
    let code = fx::anchor_code::CONSTRAINT_SEEDS;
    fx::expect_account_error(result, 0, code, "vault");
}

#[test]
fn w2_a_vault_whose_stored_mint_differs_is_rejected() {
    let mut env = fx::Env::live();
    let other_mint = env.new_mint(fx::USDC_DECIMALS);
    env.patch_vault_address(fx::vault_offset::MINT, &other_mint);
    let destination = admin_destination(&mut env);
    let accounts = env.withdraw_accounts(&destination);
    let result = env.send(&[fx::withdraw_ix(&accounts, 1)], &[]);
    fx::expect_program_error(result, 0, fx::code::INVALID_MINT);
}

#[test]
fn w3_a_non_canonical_vault_token_account_is_rejected() {
    let mut env = fx::Env::live();
    let decoy = fx::random_address();
    let state = fx::TokenAccountState::initialized(env.mint, env.vault, fx::VAULT_FUNDING);
    env.put_token_account(decoy, &state);
    let destination = admin_destination(&mut env);
    let mut accounts = env.withdraw_accounts(&destination);
    accounts.vault_token_account = decoy;
    let result = env.send(&[fx::withdraw_ix(&accounts, 1)], &[]);
    fx::expect_program_error(result, 0, fx::code::INVALID_VAULT_TOKEN_ACCOUNT);
}

#[test]
fn w4_a_zero_amount_is_rejected() {
    let mut env = fx::Env::live();
    let destination = admin_destination(&mut env);
    let accounts = env.withdraw_accounts(&destination);
    let result = env.send(&[fx::withdraw_ix(&accounts, 0)], &[]);
    fx::expect_program_error(result, 0, fx::code::ZERO_AMOUNT);
}

#[test]
fn w5_a_destination_not_owned_by_the_admin_is_rejected() {
    let mut env = fx::Env::live();
    let stranger = fx::random_address();
    let destination = env.create_ata(&stranger);
    let accounts = env.withdraw_accounts(&destination);
    let result = env.send(&[fx::withdraw_ix(&accounts, 1)], &[]);
    fx::expect_program_error(result, 0, fx::code::INVALID_WITHDRAW_DESTINATION);
}

#[test]
fn w5_a_destination_of_another_mint_is_rejected() {
    let mut env = fx::Env::live();
    let other_mint = env.new_mint(fx::USDC_DECIMALS);
    let admin = env.admin.pubkey();
    let destination = env.create_ata_for(&admin, &other_mint);
    let accounts = env.withdraw_accounts(&destination);
    let result = env.send(&[fx::withdraw_ix(&accounts, 1)], &[]);
    fx::expect_program_error(result, 0, fx::code::INVALID_WITHDRAW_DESTINATION);
}

#[test]
fn w5_a_frozen_destination_is_rejected() {
    let mut env = fx::Env::live();
    let destination = admin_destination(&mut env);
    env.freeze(&destination);
    let accounts = env.withdraw_accounts(&destination);
    let result = env.send(&[fx::withdraw_ix(&accounts, 1)], &[]);
    fx::expect_program_error(result, 0, fx::code::INVALID_WITHDRAW_DESTINATION);
}

#[test]
fn w6_a_frozen_vault_token_account_holds_withdrawals() {
    let mut env = fx::Env::live();
    let destination = admin_destination(&mut env);
    let vault_ata = env.vault_token_account;
    env.freeze(&vault_ata);
    let accounts = env.withdraw_accounts(&destination);
    let result = env.send(&[fx::withdraw_ix(&accounts, 1)], &[]);
    fx::expect_program_error(result, 0, fx::code::VAULT_TOKEN_ACCOUNT_FROZEN);
}

#[test]
fn w7_the_vault_balance_bounds_the_withdrawal() {
    let mut env = fx::Env::live();
    let destination = admin_destination(&mut env);
    let accounts = env.withdraw_accounts(&destination);
    let too_much = fx::withdraw_ix(&accounts, fx::VAULT_FUNDING + 1);
    let result = env.send(&[too_much], &[]);
    fx::expect_program_error(result, 0, fx::code::INSUFFICIENT_VAULT_BALANCE);
    let everything = fx::withdraw_ix(&accounts, fx::VAULT_FUNDING);
    fx::expect_ok(env.send(&[everything], &[]));
    assert_eq!(env.token_balance(&env.vault_token_account), 0);
}

#[test]
fn w8_total_withdrawn_overflow_is_math_overflow() {
    let mut env = fx::Env::live();
    env.patch_vault_u64(fx::vault_offset::TOTAL_WITHDRAWN, u64::MAX);
    let destination = admin_destination(&mut env);
    let accounts = env.withdraw_accounts(&destination);
    let result = env.send(&[fx::withdraw_ix(&accounts, 1)], &[]);
    fx::expect_program_error(result, 0, fx::code::MATH_OVERFLOW);
}

#[test]
fn a_token_program_other_than_classic_token_is_refused() {
    let mut env = fx::Env::live();
    let destination = admin_destination(&mut env);
    let mut accounts = env.withdraw_accounts(&destination);
    accounts.token_program = fx::TOKEN_2022_PROGRAM_ID;
    let result = env.send(&[fx::withdraw_ix(&accounts, 1)], &[]);
    let code = fx::anchor_code::INVALID_PROGRAM_ID;
    fx::expect_account_error(result, 0, code, "token_program");
}

#[test]
fn the_admin_signature_is_required() {
    let mut env = fx::Env::live();
    let destination = admin_destination(&mut env);
    let accounts = env.withdraw_accounts(&destination);
    let mut ix = fx::withdraw_ix(&accounts, 1);
    ix.accounts[1].is_signer = false;
    let result = env.send(&[ix], &[]);
    let code = fx::anchor_code::NOT_SIGNER;
    fx::expect_account_error(result, 0, code, "admin");
}

#[test]
fn token_2022_accounts_are_refused() {
    // Token-2022 accounts fail the classic-Token owner check in S1 (3007)
    // in whichever field they are passed.
    for field in ["mint", "vault_token_account", "destination"] {
        let mut env = fx::Env::live();
        let destination = admin_destination(&mut env);
        let address = match field {
            "mint" => env.mint,
            "vault_token_account" => env.vault_token_account,
            _ => destination,
        };
        let Some(mut account) = env.svm.get_account(&address) else {
            panic!("no {field} account at {address}");
        };
        account.owner = fx::TOKEN_2022_PROGRAM_ID;
        if let Err(err) = env.svm.set_account(address, account) {
            panic!("cannot rewrite {field}: {err}");
        }
        let accounts = env.withdraw_accounts(&destination);
        let result = env.send(&[fx::withdraw_ix(&accounts, 1)], &[]);
        let code = fx::anchor_code::OWNED_BY_WRONG_PROGRAM;
        fx::expect_account_error(result, 0, code, field);
    }
}

#[test]
fn w1_to_w8_run_in_contract_order() {
    // Each case breaks two adjacent checks at once; the earlier one is the
    // error (§3.3.0 S5).
    let mut env = fx::Env::live();
    let mint = env.mint;
    let other_mint = env.new_mint(fx::USDC_DECIMALS);
    let destination = admin_destination(&mut env);
    let stranger_ata = env.create_ata(&fx::random_address());
    let decoy = fx::random_address();
    let decoy_state = fx::TokenAccountState::initialized(env.mint, env.vault, fx::VAULT_FUNDING);
    env.put_token_account(decoy, &decoy_state);
    let accounts = env.withdraw_accounts(&destination);

    // W1 before W2: the guardian signs and the stored mint differs.
    env.patch_vault_address(fx::vault_offset::MINT, &other_mint);
    let mut by_guardian = accounts;
    by_guardian.admin = env.guardian.pubkey();
    let result = env.send(&[fx::withdraw_ix(&by_guardian, 1)], &[]);
    fx::expect_program_error(result, 0, fx::code::NOT_ADMIN);

    // W2 before W3: the stored mint differs and the vault ATA is a decoy.
    let mut with_decoy = accounts;
    with_decoy.vault_token_account = decoy;
    let result = env.send(&[fx::withdraw_ix(&with_decoy, 1)], &[]);
    fx::expect_program_error(result, 0, fx::code::INVALID_MINT);
    env.patch_vault_address(fx::vault_offset::MINT, &mint);

    // W3 before W4: the vault ATA is a decoy and the amount is zero.
    let result = env.send(&[fx::withdraw_ix(&with_decoy, 0)], &[]);
    fx::expect_program_error(result, 0, fx::code::INVALID_VAULT_TOKEN_ACCOUNT);

    // W4 before W5: the amount is zero and the destination is a stranger's.
    let mut to_stranger = accounts;
    to_stranger.destination = stranger_ata;
    let result = env.send(&[fx::withdraw_ix(&to_stranger, 0)], &[]);
    fx::expect_program_error(result, 0, fx::code::ZERO_AMOUNT);

    // W5 before W6: the destination is a stranger's and the vault ATA is
    // frozen.
    let vault_ata = env.vault_token_account;
    env.freeze(&vault_ata);
    let result = env.send(&[fx::withdraw_ix(&to_stranger, 1)], &[]);
    fx::expect_program_error(result, 0, fx::code::INVALID_WITHDRAW_DESTINATION);

    // W6 before W7: the vault ATA is frozen and the amount exceeds it.
    let too_much = fx::VAULT_FUNDING + 1;
    let result = env.send(&[fx::withdraw_ix(&accounts, too_much)], &[]);
    fx::expect_program_error(result, 0, fx::code::VAULT_TOKEN_ACCOUNT_FROZEN);
    env.thaw(&vault_ata);

    // W7 before W8: the amount exceeds the balance and the counter would
    // overflow.
    let total_withdrawn = fx::vault_offset::TOTAL_WITHDRAWN;
    env.patch_vault_u64(total_withdrawn, u64::MAX);
    let result = env.send(&[fx::withdraw_ix(&accounts, too_much)], &[]);
    fx::expect_program_error(result, 0, fx::code::INSUFFICIENT_VAULT_BALANCE);
    env.patch_vault_u64(total_withdrawn, 0);

    fx::expect_ok(env.send(&[fx::withdraw_ix(&accounts, 1)], &[]));
    assert_eq!(env.token_balance(&destination), 1);
}

#[test]
fn the_vault_token_account_as_destination_is_a_duplicate() {
    let mut env = fx::Env::live();
    let vault_ata = env.vault_token_account;
    let accounts = env.withdraw_accounts(&vault_ata);
    let result = env.send(&[fx::withdraw_ix(&accounts, 1)], &[]);
    let code = fx::anchor_code::DUPLICATE_MUTABLE_ACCOUNT;
    fx::expect_account_error(result, 0, code, "destination");
}
