//! `initialize` (contract §3.3.1): the loader-v3 upgrade-authority gate, the
//! vault ATA taken as existing (I8), a pre-funded vault PDA (I9), and every
//! handler check I1-I7.

use gogocash_cashback_litesvm_tests as fx;
use solana_address::Address;
use solana_keypair::Keypair;
use solana_signer::Signer;

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
    let stored = env.vault_state().vault_token_account;
    assert_eq!(stored, env.vault_token_account);
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
        assert!(account.lamports >= env.rent(fx::VAULT_SIZE));
        assert!(account.lamports >= prefund);
        assert_eq!(env.vault_state().version, 1);
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
fn the_program_account_is_not_accepted_as_program_data() {
    let mut env = fx::Env::deployed();
    let mut accounts = env.initialize_accounts();
    accounts.program_data = fx::PROGRAM_ID;
    let args = env.initialize_args();
    let result = env.send_initialize(&accounts, &args, &[]);
    let code = fx::anchor_code::NOT_PROGRAM_DATA;
    fx::expect_code(result, fx::INITIALIZE_INDEX, code);
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
    fx::expect_code(result, 0, code);
}

#[test]
fn a_token_program_other_than_classic_token_is_refused() {
    let mut env = fx::Env::deployed();
    let mut accounts = env.initialize_accounts();
    accounts.token_program = fx::TOKEN_2022_PROGRAM_ID;
    let args = env.initialize_args();
    let result = env.send_initialize(&accounts, &args, &[]);
    let code = fx::anchor_code::INVALID_PROGRAM_ID;
    fx::expect_code(result, fx::INITIALIZE_INDEX, code);
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
    fx::expect_code(result, fx::INITIALIZE_INDEX, code);
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
