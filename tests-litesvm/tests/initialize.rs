//! `initialize` (contract §3.3.1): the loader-v3 upgrade-authority gate, the
//! vault ATA taken as existing (I8), a pre-funded vault PDA (I9), and every
//! handler check I1-I7.

use gogocash_cashback_litesvm_tests as fx;
use solana_address::Address;
use solana_keypair::Keypair;
use solana_signer::Signer;

/// The vault `initialize` must write for `args` in `env` (§3.3.1 effects).
fn expected_vault(env: &fx::Env, args: &fx::InitializeArgs) -> fx::VaultState {
    fx::VaultState {
        discriminator: fx::VAULT_DISCRIMINATOR,
        version: 1,
        bump: env.vault_bump,
        paused: true,
        decimals: fx::USDC_DECIMALS,
        mint: env.mint,
        vault_token_account: env.vault_token_account,
        admin: args.admin,
        pending_admin: Address::default(),
        guardian: args.guardian,
        claim_authority: args.claim_authority,
        max_per_claim: args.max_per_claim,
        max_per_day: args.max_per_day,
        current_day: fx::utc_day(fx::NOW),
        claimed_today: 0,
        total_claimed: 0,
        claim_count: 0,
        total_withdrawn: 0,
        reserved: [0; 64],
    }
}

#[test]
fn initialize_creates_a_paused_vault_with_the_contract_layout() {
    let mut env = fx::Env::deployed();
    let accounts = env.initialize_accounts();
    let args = env.initialize_args();
    let meta = fx::expect_ok(env.send_initialize(&accounts, &args, &[]));
    assert!(fx::payout_claimed_events(&meta.logs).is_empty());

    let Some(account) = env.svm.get_account(&env.vault) else {
        panic!("the vault was not created");
    };
    assert_eq!(account.owner, fx::PROGRAM_ID);
    assert_eq!(account.data.len(), fx::VAULT_SIZE);
    assert_eq!(account.lamports, env.rent(fx::VAULT_SIZE));

    let expected = fx::VaultState {
        discriminator: fx::VAULT_DISCRIMINATOR,
        version: 1,
        bump: env.vault_bump,
        paused: true,
        decimals: fx::USDC_DECIMALS,
        mint: env.mint,
        vault_token_account: env.vault_token_account,
        admin: env.admin.pubkey(),
        pending_admin: Address::default(),
        guardian: env.guardian.pubkey(),
        claim_authority: env.claim_authority.pubkey(),
        max_per_claim: fx::DEFAULT_MAX_PER_CLAIM,
        max_per_day: fx::DEFAULT_MAX_PER_DAY,
        current_day: fx::utc_day(fx::NOW),
        claimed_today: 0,
        total_claimed: 0,
        claim_count: 0,
        total_withdrawn: 0,
        reserved: [0; 64],
    };
    assert_eq!(env.vault_state(), expected);

    let vault_ata = env.token_account(&env.vault_token_account);
    assert_eq!(vault_ata.owner, env.vault);
    assert_eq!(vault_ata.mint, env.mint);
    assert_eq!(vault_ata.amount, 0);
}

#[test]
fn initialize_reproduces_the_contract_vault_vector() {
    let mut env = fx::Env::deployed_with_mint(fx::vectors::DEVNET_MINT);
    assert_eq!(env.vault, fx::vectors::DEVNET_VAULT);
    assert_eq!(env.vault_bump, fx::vectors::DEVNET_VAULT_BUMP);
    assert_eq!(env.vault_token_account, fx::vectors::DEVNET_VAULT_ATA);
    let accounts = env.initialize_accounts();
    let args = fx::InitializeArgs {
        admin: fx::vectors::ADMIN,
        guardian: fx::vectors::GUARDIAN,
        claim_authority: fx::vectors::CLAIM_AUTHORITY,
        max_per_claim: fx::DEFAULT_MAX_PER_CLAIM,
        max_per_day: fx::DEFAULT_MAX_PER_DAY,
    };
    fx::expect_ok(env.send_initialize(&accounts, &args, &[]));
    let Some(data) = fx::account_data(&env.svm, &env.vault) else {
        panic!("the vault was not created");
    };
    assert_eq!(data, fx::hex_decode(fx::vectors::VAULT_V1_HEX));
}

#[test]
fn a_second_initialize_fails_with_already_in_use() {
    let mut env = fx::Env::initialized();
    let accounts = env.initialize_accounts();
    let args = env.initialize_args();
    let result = env.send_initialize(&accounts, &args, &[]);
    fx::expect_already_in_use(result, fx::INITIALIZE_INDEX);
}

#[test]
fn i8_a_stranger_pre_creating_the_vault_ata_does_not_block_initialize() {
    let mut env = fx::Env::deployed();
    let stranger = Keypair::new();
    fx::fund_lamports(&mut env.svm, &stranger.pubkey(), fx::LAMPORTS_PER_SOL);
    let ix = fx::create_ata_idempotent(&stranger.pubkey(), &env.vault, &env.mint);
    fx::expect_ok(env.send(&[ix], &[&stranger]));
    let vault_ata = env.token_account(&env.vault_token_account);
    assert_eq!(vault_ata.owner, env.vault);

    let accounts = env.initialize_accounts();
    let args = env.initialize_args();
    fx::expect_ok(env.send_initialize(&accounts, &args, &[]));
    assert_eq!(env.vault_state(), expected_vault(&env, &args));
}

#[test]
fn i9_a_pre_funded_vault_pda_is_initialized() {
    for prefund in [1_000_000, 10 * fx::LAMPORTS_PER_SOL] {
        let mut env = fx::Env::deployed();
        let vault = env.vault;
        fx::fund_lamports(&mut env.svm, &vault, prefund);
        let accounts = env.initialize_accounts();
        let args = env.initialize_args();
        fx::expect_ok(env.send_initialize(&accounts, &args, &[]));
        let Some(account) = env.svm.get_account(&vault) else {
            panic!("the vault was not created");
        };
        assert_eq!(account.owner, fx::PROGRAM_ID);
        assert_eq!(account.data.len(), fx::VAULT_SIZE);
        assert!(account.lamports >= env.rent(fx::VAULT_SIZE));
        assert!(account.lamports >= prefund);
        assert_eq!(env.vault_state(), expected_vault(&env, &args));
    }
}

#[test]
fn i2_a_signer_that_is_not_the_upgrade_authority_is_rejected() {
    let mut env = fx::Env::deployed();
    let stranger = Keypair::new();
    let mut accounts = env.initialize_accounts();
    accounts.upgrade_authority = stranger.pubkey();
    let args = env.initialize_args();
    let result = env.send_initialize(&accounts, &args, &[&stranger]);
    fx::expect_init_error(result, fx::code::NOT_UPGRADE_AUTHORITY);
}

#[test]
fn i2_an_immutable_program_cannot_be_initialized() {
    let mut env = fx::Env::deployed();
    fx::set_upgrade_authority(&mut env.svm, &fx::PROGRAM_ID, None);
    let accounts = env.initialize_accounts();
    let args = env.initialize_args();
    let result = env.send_initialize(&accounts, &args, &[]);
    fx::expect_init_error(result, fx::code::NOT_UPGRADE_AUTHORITY);
}

#[test]
fn i1_a_foreign_program_data_account_is_rejected() {
    // A well-formed ProgramData that names the right upgrade authority but
    // is not this program's own ProgramData address (SEC-5).
    let mut env = fx::Env::deployed();
    let foreign = fx::random_address();
    let authority = Some(env.upgrade_authority.pubkey());
    let header = fx::program_data_metadata(0, authority).to_vec();
    fx::put_account(&mut env.svm, foreign, fx::LOADER_V3_ID, header);
    let mut accounts = env.initialize_accounts();
    accounts.program_data = foreign;
    let args = env.initialize_args();
    let result = env.send_initialize(&accounts, &args, &[]);
    fx::expect_init_error(result, fx::code::INVALID_PROGRAM_DATA);
}

#[test]
fn a_program_data_lookalike_not_owned_by_loader_v3_is_refused() {
    // ProgramData spoofing: the right bytes (tag 3, our upgrade authority)
    // in an account another program owns fail the owner check in S1.
    let mut env = fx::Env::deployed();
    let spoof = fx::random_address();
    let authority = Some(env.upgrade_authority.pubkey());
    let header = fx::program_data_metadata(0, authority).to_vec();
    fx::put_account(&mut env.svm, spoof, fx::random_address(), header);
    let mut accounts = env.initialize_accounts();
    accounts.program_data = spoof;
    let args = env.initialize_args();
    let result = env.send_initialize(&accounts, &args, &[]);
    let code = fx::anchor_code::OWNED_BY_WRONG_PROGRAM;
    fx::expect_account_error(result, fx::INITIALIZE_INDEX, code, "program_data");
}

#[test]
fn the_program_account_is_not_accepted_as_program_data() {
    let mut env = fx::Env::deployed();
    let mut accounts = env.initialize_accounts();
    accounts.program_data = fx::PROGRAM_ID;
    let args = env.initialize_args();
    let result = env.send_initialize(&accounts, &args, &[]);
    let code = fx::anchor_code::NOT_PROGRAM_DATA;
    fx::expect_account_error(result, fx::INITIALIZE_INDEX, code, "program_data");
}

#[test]
fn i3_a_mint_without_6_decimals_is_rejected() {
    let mut env = fx::Env::deployed();
    let mint = env.new_mint(9);
    let vault = fx::vault_pda(&mint).0;
    let mut accounts = env.initialize_accounts();
    accounts.vault = vault;
    accounts.mint = mint;
    accounts.vault_token_account = fx::associated_token_address(&vault, &mint);
    let args = env.initialize_args();
    let result = env.send_initialize(&accounts, &args, &[]);
    fx::expect_init_error(result, fx::code::INVALID_MINT);
}

#[test]
fn a_token_2022_mint_is_refused() {
    let mut env = fx::Env::deployed();
    let mint = fx::random_address();
    let authority = Some(env.mint_authority.pubkey());
    let data = fx::pack_mint(authority, 0, fx::USDC_DECIMALS, authority);
    fx::put_account(&mut env.svm, mint, fx::TOKEN_2022_PROGRAM_ID, data);
    let vault = fx::vault_pda(&mint).0;
    let mut accounts = env.initialize_accounts();
    accounts.vault = vault;
    accounts.mint = mint;
    accounts.vault_token_account = fx::associated_token_address(&vault, &mint);
    let ix = fx::initialize_ix(&accounts, &env.initialize_args());
    let result = env.send(&[ix], &[]);
    let code = fx::anchor_code::OWNED_BY_WRONG_PROGRAM;
    fx::expect_account_error(result, 0, code, "mint");
}

#[test]
fn a_token_program_other_than_classic_token_is_refused() {
    let mut env = fx::Env::deployed();
    let mut accounts = env.initialize_accounts();
    accounts.token_program = fx::TOKEN_2022_PROGRAM_ID;
    let args = env.initialize_args();
    let result = env.send_initialize(&accounts, &args, &[]);
    let code = fx::anchor_code::INVALID_PROGRAM_ID;
    fx::expect_account_error(result, fx::INITIALIZE_INDEX, code, "token_program");
}

#[test]
fn i4_a_vault_ata_with_a_delegate_is_rejected() {
    let mut env = fx::Env::deployed();
    let mut vault_ata = fx::TokenAccountState::initialized(env.mint, env.vault, 0);
    vault_ata.delegate = Some(fx::random_address());
    vault_ata.delegated_amount = 1;
    env.put_token_account(env.vault_token_account, &vault_ata);
    let accounts = env.initialize_accounts();
    let args = env.initialize_args();
    let result = env.send_initialize(&accounts, &args, &[]);
    fx::expect_init_error(result, fx::code::INVALID_VAULT_TOKEN_ACCOUNT);
}

#[test]
fn i4_a_vault_ata_with_a_close_authority_is_rejected() {
    let mut env = fx::Env::deployed();
    let mut vault_ata = fx::TokenAccountState::initialized(env.mint, env.vault, 0);
    vault_ata.close_authority = Some(fx::random_address());
    env.put_token_account(env.vault_token_account, &vault_ata);
    let accounts = env.initialize_accounts();
    let args = env.initialize_args();
    let result = env.send_initialize(&accounts, &args, &[]);
    fx::expect_init_error(result, fx::code::INVALID_VAULT_TOKEN_ACCOUNT);
}

#[test]
fn a_vault_token_account_not_owned_by_the_vault_is_rejected() {
    let mut env = fx::Env::deployed();
    let other = fx::random_address();
    let other_ata = env.create_ata(&other);
    let mut accounts = env.initialize_accounts();
    accounts.vault_token_account = other_ata;
    let args = env.initialize_args();
    let result = env.send_initialize(&accounts, &args, &[]);
    let code = fx::anchor_code::CONSTRAINT_TOKEN_OWNER;
    fx::expect_account_error(result, fx::INITIALIZE_INDEX, code, "vault_token_account");
}

#[test]
fn a_non_canonical_vault_token_account_is_rejected() {
    // Vault ATA substitution: a classic token account of the right mint,
    // owned by the vault, at an address that is not the canonical ATA.
    let mut env = fx::Env::deployed();
    let decoy = fx::random_address();
    let state = fx::TokenAccountState::initialized(env.mint, env.vault, 0);
    env.put_token_account(decoy, &state);
    let mut accounts = env.initialize_accounts();
    accounts.vault_token_account = decoy;
    let args = env.initialize_args();
    let result = env.send_initialize(&accounts, &args, &[]);
    let code = fx::anchor_code::CONSTRAINT_ASSOCIATED;
    fx::expect_account_error(result, fx::INITIALIZE_INDEX, code, "vault_token_account");
}

#[test]
fn a_token_2022_vault_token_account_is_refused() {
    // A Token-2022 account at the canonical vault ATA address fails the
    // classic-Token owner check in S1. Sent without the ATA instruction,
    // which would itself refuse the foreign owner first.
    let mut env = fx::Env::deployed();
    let state = fx::TokenAccountState::initialized(env.mint, env.vault, 0);
    let vault_ata = env.vault_token_account;
    fx::put_account(
        &mut env.svm,
        vault_ata,
        fx::TOKEN_2022_PROGRAM_ID,
        state.pack(),
    );
    let ix = fx::initialize_ix(&env.initialize_accounts(), &env.initialize_args());
    let result = env.send(&[ix], &[]);
    let code = fx::anchor_code::OWNED_BY_WRONG_PROGRAM;
    fx::expect_account_error(result, 0, code, "vault_token_account");
}

#[test]
fn a_non_canonical_vault_address_is_rejected() {
    // S2: the `init` seeds check refuses a vault that is not the PDA
    // `["vault", mint]` (2006), before any handler check.
    let mut env = fx::Env::deployed();
    let not_the_pda = fx::random_address();
    let mut accounts = env.initialize_accounts();
    accounts.vault = not_the_pda;
    accounts.vault_token_account = fx::associated_token_address(&not_the_pda, &env.mint);
    let args = env.initialize_args();
    let result = env.send_initialize(&accounts, &args, &[]);
    let code = fx::anchor_code::CONSTRAINT_SEEDS;
    fx::expect_account_error(result, fx::INITIALIZE_INDEX, code, "vault");
}

#[test]
fn the_upgrade_authority_and_the_payer_must_sign() {
    let mut env = fx::Env::deployed();
    let (vault, mint) = (env.vault, env.mint);
    env.create_ata_for(&vault, &mint);
    let args = env.initialize_args();

    let accounts = env.initialize_accounts();
    let mut ix = fx::initialize_ix(&accounts, &args);
    ix.accounts[4].is_signer = false;
    let result = env.send(&[ix], &[]);
    let code = fx::anchor_code::NOT_SIGNER;
    fx::expect_account_error(result, 0, code, "upgrade_authority");

    // A payer account other than the fee payer, writable but not signing.
    let mut accounts = env.initialize_accounts();
    accounts.payer = fx::random_address();
    let mut ix = fx::initialize_ix(&accounts, &args);
    ix.accounts[5].is_signer = false;
    let result = env.send(&[ix], &[]);
    fx::expect_account_error(result, 0, code, "payer");
}

#[test]
fn i1_to_i7_run_in_contract_order() {
    // Each case breaks two adjacent checks at once; the earlier one is the
    // error, so the code is deterministic for a given state (§3.3.0 S5).
    let mut env = fx::Env::deployed();
    let stranger = Keypair::new();

    // I1 before I2: a foreign ProgramData that also names another authority.
    let foreign = fx::random_address();
    let header = fx::program_data_metadata(0, Some(stranger.pubkey())).to_vec();
    fx::put_account(&mut env.svm, foreign, fx::LOADER_V3_ID, header);
    let mut accounts = env.initialize_accounts();
    accounts.program_data = foreign;
    accounts.upgrade_authority = stranger.pubkey();
    let args = env.initialize_args();
    let result = env.send_initialize(&accounts, &args, &[&stranger]);
    fx::expect_init_error(result, fx::code::INVALID_PROGRAM_DATA);

    // I2 before I3: a stranger signs for a 9-decimal mint.
    let mint9 = env.new_mint(9);
    let vault9 = fx::vault_pda(&mint9).0;
    let vault9_ata = fx::associated_token_address(&vault9, &mint9);
    let mut accounts = env.initialize_accounts();
    accounts.vault = vault9;
    accounts.mint = mint9;
    accounts.vault_token_account = vault9_ata;
    let mut by_stranger = accounts;
    by_stranger.upgrade_authority = stranger.pubkey();
    let result = env.send_initialize(&by_stranger, &args, &[&stranger]);
    fx::expect_init_error(result, fx::code::NOT_UPGRADE_AUTHORITY);

    // I3 before I4: the 9-decimal mint, and its vault ATA has a delegate.
    let mut delegated = fx::TokenAccountState::initialized(mint9, vault9, 0);
    delegated.delegate = Some(fx::random_address());
    env.put_token_account(vault9_ata, &delegated);
    let result = env.send_initialize(&accounts, &args, &[]);
    fx::expect_init_error(result, fx::code::INVALID_MINT);

    // I4 before I5: the vault ATA has a delegate and the admin is default.
    let mut delegated = fx::TokenAccountState::initialized(env.mint, env.vault, 0);
    delegated.delegate = Some(fx::random_address());
    let vault_ata = env.vault_token_account;
    env.put_token_account(vault_ata, &delegated);
    let accounts = env.initialize_accounts();
    let mut bad = env.initialize_args();
    bad.admin = Address::default();
    let result = env.send_initialize(&accounts, &bad, &[]);
    fx::expect_init_error(result, fx::code::INVALID_VAULT_TOKEN_ACCOUNT);
    let clean = fx::TokenAccountState::initialized(env.mint, env.vault, 0);
    env.put_token_account(vault_ata, &clean);

    // I5 before I6: the admin is default and the claim authority is the
    // guardian.
    let mut bad = env.initialize_args();
    bad.admin = Address::default();
    bad.claim_authority = bad.guardian;
    let result = env.send_initialize(&accounts, &bad, &[]);
    fx::expect_init_error(result, fx::code::INVALID_ROLE);

    // I6 before I7: the claim authority is the admin and both caps are 0.
    let mut bad = env.initialize_args();
    bad.claim_authority = bad.admin;
    bad.max_per_claim = 0;
    bad.max_per_day = 0;
    let result = env.send_initialize(&accounts, &bad, &[]);
    fx::expect_init_error(result, fx::code::ROLE_CONFLICT);

    // Nothing was created along the way; the clean call still works.
    fx::expect_ok(env.send_initialize(&accounts, &args, &[]));
    assert_eq!(env.vault_state(), expected_vault(&env, &args));
}

#[test]
fn i5_default_roles_are_rejected() {
    let mut env = fx::Env::deployed();
    let accounts = env.initialize_accounts();

    let mut args = env.initialize_args();
    args.admin = Address::default();
    let result = env.send_initialize(&accounts, &args, &[]);
    fx::expect_init_error(result, fx::code::INVALID_ROLE);

    let mut args = env.initialize_args();
    args.guardian = Address::default();
    let result = env.send_initialize(&accounts, &args, &[]);
    fx::expect_init_error(result, fx::code::INVALID_ROLE);

    let mut args = env.initialize_args();
    args.claim_authority = Address::default();
    let result = env.send_initialize(&accounts, &args, &[]);
    fx::expect_init_error(result, fx::code::INVALID_ROLE);
}

#[test]
fn i6_the_claim_authority_must_not_be_the_admin_or_the_guardian() {
    let mut env = fx::Env::deployed();
    let accounts = env.initialize_accounts();

    let mut args = env.initialize_args();
    args.claim_authority = args.admin;
    let result = env.send_initialize(&accounts, &args, &[]);
    fx::expect_init_error(result, fx::code::ROLE_CONFLICT);

    let mut args = env.initialize_args();
    args.claim_authority = args.guardian;
    let result = env.send_initialize(&accounts, &args, &[]);
    fx::expect_init_error(result, fx::code::ROLE_CONFLICT);
}

#[test]
fn i7_caps_must_be_non_zero_and_ordered() {
    let mut env = fx::Env::deployed();
    let accounts = env.initialize_accounts();
    let caps: [(u64, u64); 3] = [(0, 20_000_000), (5_000_000, 0), (6_000_000, 5_000_000)];
    for (max_per_claim, max_per_day) in caps {
        let mut args = env.initialize_args();
        args.max_per_claim = max_per_claim;
        args.max_per_day = max_per_day;
        let result = env.send_initialize(&accounts, &args, &[]);
        fx::expect_init_error(result, fx::code::INVALID_CAPS);
    }

    // Equal caps are allowed.
    let mut args = env.initialize_args();
    args.max_per_claim = 7_000_000;
    args.max_per_day = 7_000_000;
    fx::expect_ok(env.send_initialize(&accounts, &args, &[]));
    let vault = env.vault_state();
    assert_eq!(vault.max_per_claim, 7_000_000);
    assert_eq!(vault.max_per_day, 7_000_000);
}

#[test]
fn o18_claim_authority_equal_to_the_upgrade_authority_is_not_checked_onchain() {
    // Open item O18: v0 enforces this key separation off-chain only (admin
    // CLI §3.3.1, rail §7.7). An on-chain check would change the "Raised by"
    // column of 6020 and needs a new contract version, so this test pins the
    // v0 behavior.
    let mut env = fx::Env::deployed();
    let accounts = env.initialize_accounts();
    let mut args = env.initialize_args();
    args.claim_authority = env.upgrade_authority.pubkey();
    fx::expect_ok(env.send_initialize(&accounts, &args, &[]));
    assert_eq!(env.vault_state().claim_authority, args.claim_authority);
}
