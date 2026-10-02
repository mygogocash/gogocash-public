//! Admin instructions (contract §3.3.3-§3.3.7): pause (admin or guardian),
//! unpause (admin only), update_config re-validation, and the two-step
//! admin transfer.

use gogocash_cashback_litesvm_tests as fx;
use solana_address::Address;
use solana_keypair::Keypair;
use solana_signer::Signer;

#[test]
fn p1_admin_and_guardian_can_pause_and_pause_is_idempotent() {
    let mut env = fx::Env::live();
    let vault = env.vault;
    let guardian = env.guardian.pubkey();
    let admin = env.admin.pubkey();
    let meta = fx::expect_ok(env.send(&[fx::pause_ix(&vault, &guardian)], &[]));
    assert!(fx::payout_claimed_events(&meta.logs).is_empty());
    assert!(env.vault_state().paused);
    fx::expect_ok(env.send(&[fx::pause_ix(&vault, &guardian)], &[]));
    fx::expect_ok(env.send(&[fx::pause_ix(&vault, &admin)], &[]));
    assert!(env.vault_state().paused);
}

#[test]
fn p1_nobody_else_can_pause() {
    let mut env = fx::Env::live();
    let vault = env.vault;
    let stranger = Keypair::new();
    let ix = fx::pause_ix(&vault, &stranger.pubkey());
    let result = env.send(&[ix], &[&stranger]);
    fx::expect_program_error(result, 0, fx::code::NOT_ADMIN_OR_GUARDIAN);
    let claim_authority = env.claim_authority.pubkey();
    let ix = fx::pause_ix(&vault, &claim_authority);
    let result = env.send(&[ix], &[]);
    fx::expect_program_error(result, 0, fx::code::NOT_ADMIN_OR_GUARDIAN);
    assert!(!env.vault_state().paused);
}

#[test]
fn u1_the_guardian_cannot_unpause_and_the_admin_can() {
    let mut env = fx::Env::initialized();
    let vault = env.vault;
    let stranger = Keypair::new();
    let not_admins = [
        env.guardian.pubkey(),
        env.claim_authority.pubkey(),
        stranger.pubkey(),
    ];
    for signer in not_admins {
        let ix = fx::unpause_ix(&vault, &signer);
        let result = env.send(&[ix], &[&stranger]);
        fx::expect_program_error(result, 0, fx::code::NOT_ADMIN);
    }
    assert!(env.vault_state().paused);

    let admin = env.admin.pubkey();
    fx::expect_ok(env.send(&[fx::unpause_ix(&vault, &admin)], &[]));
    assert!(!env.vault_state().paused);
    fx::expect_ok(env.send(&[fx::unpause_ix(&vault, &admin)], &[]));
    assert!(!env.vault_state().paused);
}

#[test]
fn pause_blocks_claim_only() {
    let mut env = fx::Env::live();
    let vault = env.vault;
    let admin = env.admin.pubkey();
    let guardian = env.guardian.pubkey();
    fx::expect_ok(env.send(&[fx::pause_ix(&vault, &guardian)], &[]));
    let (_, result) = env.claim(&fx::random_address(), 1_000_000);
    fx::expect_claim_error(result, fx::code::PAUSED);

    // Every admin instruction still works while paused.
    let update = env.update_config_args();
    let ix = fx::update_config_ix(&vault, &admin, &update);
    fx::expect_ok(env.send(&[ix], &[]));
    let destination = env.create_ata(&admin);
    let ix = fx::withdraw_ix(&env.withdraw_accounts(&destination), 1_000_000);
    fx::expect_ok(env.send(&[ix], &[]));
    let new_admin = Keypair::new();
    let ix = fx::propose_admin_ix(&vault, &admin, &new_admin.pubkey());
    fx::expect_ok(env.send(&[ix], &[]));
    let ix = fx::accept_admin_ix(&vault, &new_admin.pubkey());
    fx::expect_ok(env.send(&[ix], &[&new_admin]));
    assert!(env.vault_state().paused);
}

#[test]
fn update_config_rewrites_roles_and_caps_only() {
    let mut env = fx::Env::live();
    let vault = env.vault;
    let admin = env.admin.pubkey();
    let old_guardian = env.guardian.pubkey();
    let recipient = fx::random_address();
    let (_, result) = env.claim(&recipient, 1_000_000);
    fx::expect_ok(result);
    let before = env.vault_state();

    let new_guardian = Keypair::new();
    let new_claim_authority = Keypair::new();
    let update = fx::UpdateConfigArgs {
        guardian: new_guardian.pubkey(),
        claim_authority: new_claim_authority.pubkey(),
        max_per_claim: 2_000_000,
        max_per_day: 3_000_000,
    };
    let ix = fx::update_config_ix(&vault, &admin, &update);
    let meta = fx::expect_ok(env.send(&[ix], &[]));
    assert!(fx::payout_claimed_events(&meta.logs).is_empty());
    let expected = fx::VaultState {
        guardian: update.guardian,
        claim_authority: update.claim_authority,
        max_per_claim: update.max_per_claim,
        max_per_day: update.max_per_day,
        ..before
    };
    assert_eq!(env.vault_state(), expected);

    // The old claim authority is refused and the new one pays.
    let (_, result) = env.claim(&recipient, 1_000_000);
    fx::expect_claim_error(result, fx::code::INVALID_CLAIM_AUTHORITY);
    let payout_id = fx::random_payout_id();
    let mut accounts = env.claim_accounts(&recipient, &payout_id);
    accounts.claim_authority = new_claim_authority.pubkey();
    let args = env.claim_args(payout_id, 1_000_000);
    fx::expect_ok(env.send_claim(&accounts, &args, &[&new_claim_authority]));

    // The old guardian lost the pause right; the new one has it.
    let result = env.send(&[fx::pause_ix(&vault, &old_guardian)], &[]);
    fx::expect_program_error(result, 0, fx::code::NOT_ADMIN_OR_GUARDIAN);
    let ix = fx::pause_ix(&vault, &new_guardian.pubkey());
    fx::expect_ok(env.send(&[ix], &[&new_guardian]));
}

#[test]
fn update_config_is_allowed_while_paused() {
    let mut env = fx::Env::initialized();
    let vault = env.vault;
    let admin = env.admin.pubkey();
    let mut update = env.update_config_args();
    update.max_per_claim = 1_000_000;
    let ix = fx::update_config_ix(&vault, &admin, &update);
    fx::expect_ok(env.send(&[ix], &[]));
    let state = env.vault_state();
    assert!(state.paused);
    assert_eq!(state.max_per_claim, 1_000_000);
}

#[test]
fn g1_only_the_admin_can_update_the_config() {
    let mut env = fx::Env::initialized();
    let vault = env.vault;
    let update = env.update_config_args();
    let not_admins = [env.guardian.pubkey(), env.claim_authority.pubkey()];
    for signer in not_admins {
        let ix = fx::update_config_ix(&vault, &signer, &update);
        let result = env.send(&[ix], &[]);
        fx::expect_program_error(result, 0, fx::code::NOT_ADMIN);
    }
}

#[test]
fn g2_default_roles_are_rejected() {
    let mut env = fx::Env::initialized();
    let vault = env.vault;
    let admin = env.admin.pubkey();

    let mut update = env.update_config_args();
    update.guardian = Address::default();
    let result = env.send(&[fx::update_config_ix(&vault, &admin, &update)], &[]);
    fx::expect_program_error(result, 0, fx::code::INVALID_ROLE);

    let mut update = env.update_config_args();
    update.claim_authority = Address::default();
    let result = env.send(&[fx::update_config_ix(&vault, &admin, &update)], &[]);
    fx::expect_program_error(result, 0, fx::code::INVALID_ROLE);
}

#[test]
fn g3_the_claim_authority_must_not_be_the_admin_or_the_new_guardian() {
    let mut env = fx::Env::initialized();
    let vault = env.vault;
    let admin = env.admin.pubkey();

    let mut update = env.update_config_args();
    update.claim_authority = admin;
    let result = env.send(&[fx::update_config_ix(&vault, &admin, &update)], &[]);
    fx::expect_program_error(result, 0, fx::code::ROLE_CONFLICT);

    let shared = fx::random_address();
    let mut update = env.update_config_args();
    update.guardian = shared;
    update.claim_authority = shared;
    let result = env.send(&[fx::update_config_ix(&vault, &admin, &update)], &[]);
    fx::expect_program_error(result, 0, fx::code::ROLE_CONFLICT);
}

#[test]
fn g4_caps_must_be_non_zero_and_ordered() {
    let mut env = fx::Env::initialized();
    let vault = env.vault;
    let admin = env.admin.pubkey();
    let caps: [(u64, u64); 3] = [(0, 20_000_000), (5_000_000, 0), (6_000_000, 5_000_000)];
    for (max_per_claim, max_per_day) in caps {
        let mut update = env.update_config_args();
        update.max_per_claim = max_per_claim;
        update.max_per_day = max_per_day;
        let ix = fx::update_config_ix(&vault, &admin, &update);
        let result = env.send(&[ix], &[]);
        fx::expect_program_error(result, 0, fx::code::INVALID_CAPS);
    }
    let state = env.vault_state();
    assert_eq!(state.max_per_claim, fx::DEFAULT_MAX_PER_CLAIM);
    assert_eq!(state.max_per_day, fx::DEFAULT_MAX_PER_DAY);
}

#[test]
fn the_admin_transfer_takes_two_steps() {
    let mut env = fx::Env::live();
    let vault = env.vault;
    let old_admin = env.admin.pubkey();
    let new_admin = Keypair::new();
    let new_key = new_admin.pubkey();

    let ix = fx::propose_admin_ix(&vault, &old_admin, &new_key);
    fx::expect_ok(env.send(&[ix], &[]));
    let state = env.vault_state();
    assert_eq!(state.admin, old_admin);
    assert_eq!(state.pending_admin, new_key);

    // A proposed admin has no power until it accepts.
    let ix = fx::unpause_ix(&vault, &new_key);
    let result = env.send(&[ix], &[&new_admin]);
    fx::expect_program_error(result, 0, fx::code::NOT_ADMIN);

    let ix = fx::accept_admin_ix(&vault, &new_key);
    fx::expect_ok(env.send(&[ix], &[&new_admin]));
    let state = env.vault_state();
    assert_eq!(state.admin, new_key);
    assert_eq!(state.pending_admin, Address::default());

    // The old admin is refused everywhere; the new one is obeyed.
    let result = env.send(&[fx::unpause_ix(&vault, &old_admin)], &[]);
    fx::expect_program_error(result, 0, fx::code::NOT_ADMIN);
    let result = env.send(&[fx::pause_ix(&vault, &old_admin)], &[]);
    fx::expect_program_error(result, 0, fx::code::NOT_ADMIN_OR_GUARDIAN);
    let ix = fx::pause_ix(&vault, &new_key);
    fx::expect_ok(env.send(&[ix], &[&new_admin]));
    let ix = fx::unpause_ix(&vault, &new_key);
    fx::expect_ok(env.send(&[ix], &[&new_admin]));

    // Accepting again finds no pending admin.
    let ix = fx::accept_admin_ix(&vault, &new_key);
    let result = env.send(&[ix], &[&new_admin]);
    fx::expect_program_error(result, 0, fx::code::NOT_PENDING_ADMIN);
}

#[test]
fn b1_only_the_pending_admin_can_accept() {
    let mut env = fx::Env::initialized();
    let vault = env.vault;
    let admin = env.admin.pubkey();
    let stranger = Keypair::new();

    // Nothing pending: even the admin cannot accept.
    let result = env.send(&[fx::accept_admin_ix(&vault, &admin)], &[]);
    fx::expect_program_error(result, 0, fx::code::NOT_PENDING_ADMIN);

    let proposed = Keypair::new();
    let ix = fx::propose_admin_ix(&vault, &admin, &proposed.pubkey());
    fx::expect_ok(env.send(&[ix], &[]));
    let ix = fx::accept_admin_ix(&vault, &stranger.pubkey());
    let result = env.send(&[ix], &[&stranger]);
    fx::expect_program_error(result, 0, fx::code::NOT_PENDING_ADMIN);
    let result = env.send(&[fx::accept_admin_ix(&vault, &admin)], &[]);
    fx::expect_program_error(result, 0, fx::code::NOT_PENDING_ADMIN);
}

#[test]
fn a_default_proposal_cancels_the_pending_admin() {
    let mut env = fx::Env::initialized();
    let vault = env.vault;
    let admin = env.admin.pubkey();
    let proposed = Keypair::new();
    let ix = fx::propose_admin_ix(&vault, &admin, &proposed.pubkey());
    fx::expect_ok(env.send(&[ix], &[]));
    let ix = fx::propose_admin_ix(&vault, &admin, &Address::default());
    fx::expect_ok(env.send(&[ix], &[]));
    assert_eq!(env.vault_state().pending_admin, Address::default());
    let ix = fx::accept_admin_ix(&vault, &proposed.pubkey());
    let result = env.send(&[ix], &[&proposed]);
    fx::expect_program_error(result, 0, fx::code::NOT_PENDING_ADMIN);
    assert_eq!(env.vault_state().admin, admin);
}

#[test]
fn a1_only_the_admin_can_propose() {
    let mut env = fx::Env::initialized();
    let vault = env.vault;
    let guardian = env.guardian.pubkey();
    let ix = fx::propose_admin_ix(&vault, &guardian, &guardian);
    let result = env.send(&[ix], &[]);
    fx::expect_program_error(result, 0, fx::code::NOT_ADMIN);
}

#[test]
fn a2_the_claim_authority_cannot_be_proposed() {
    let mut env = fx::Env::initialized();
    let vault = env.vault;
    let admin = env.admin.pubkey();
    let claim_authority = env.claim_authority.pubkey();
    let ix = fx::propose_admin_ix(&vault, &admin, &claim_authority);
    let result = env.send(&[ix], &[]);
    fx::expect_program_error(result, 0, fx::code::ROLE_CONFLICT);
}

#[test]
fn b2_accept_rechecks_the_role_conflict() {
    // update_config may make the pending admin the claim authority after the
    // proposal; accept_admin must refuse it then.
    let mut env = fx::Env::initialized();
    let vault = env.vault;
    let admin = env.admin.pubkey();
    let proposed = Keypair::new();
    let ix = fx::propose_admin_ix(&vault, &admin, &proposed.pubkey());
    fx::expect_ok(env.send(&[ix], &[]));
    let mut update = env.update_config_args();
    update.claim_authority = proposed.pubkey();
    let ix = fx::update_config_ix(&vault, &admin, &update);
    fx::expect_ok(env.send(&[ix], &[]));
    let ix = fx::accept_admin_ix(&vault, &proposed.pubkey());
    let result = env.send(&[ix], &[&proposed]);
    fx::expect_program_error(result, 0, fx::code::ROLE_CONFLICT);
    assert_eq!(env.vault_state().admin, admin);
}
