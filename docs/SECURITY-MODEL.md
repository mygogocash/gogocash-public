# gogocash_cashback security model (contract v0)

This document maps every vulnerability class the `gogocash_cashback` program
defends against to the check that stops it and the LiteSVM test that proves
the check. `docs/CONTRACT.md` section 3 is normative; this file only explains
how the code meets it.

**Status:** unaudited. Contract v0, devnet only, under a placeholder program
id that nobody holds a key for (`HWNF2cvXybfAjLbw2pydi7sNFmTfYBjpEWNtY3BJfCje`,
CONTRACT.md §2.4), so a v0 build cannot hold or move real funds.

Test IDs are `<file>::<test>` in `tests-litesvm/tests/`. CI runs the whole
suite against the exact `.so` that `anchor build --arch v3` produced
(`.github/workflows/program.yml`, job `litesvm`) and, for releases, against
the `solana-verify` artifact (`.github/workflows/verifiable-build.yml`).

## Roles and what each key can do

| Role | Who | Can | Cannot |
|---|---|---|---|
| Upgrade authority | loader-v3 upgrade authority of the program | `initialize` a vault for a mint (once per mint); upgrade the program | claim, configure or withdraw from an existing vault (it is not a vault role) |
| Admin | `vault.admin` (later a Squads vault) | `unpause`, `update_config`, `propose_admin`, `withdraw` to an admin-owned token account, `pause` | claim; withdraw to anyone else; become the claim authority |
| Guardian | `vault.guardian` | `pause` only | unpause, configure, withdraw, claim |
| Claim authority | `vault.claim_authority`, the rail's hot key | co-sign `claim` within the caps, the expiry window and the vault balance | anything administrative; pay itself or the payer (C5) |
| Payer | any key | fund the receipt rent and the fee | anything else; receive the payout (C5) |

A leaked claim key is bounded by `max_per_claim`, `max_per_day`, the vault
float and the guardian's pause. Every payout it lands still needs a receipt
whose `(payout_id, recipient, amount)` matches a ledger row before the row is
paid (CONTRACT.md §3.8), so a front-run of a known `payout_id` is detected and
never paid twice.

## Vulnerability classes, checks and tests

| # | Class | Program check | Tests |
|---:|---|---|---|
| 1 | Double payment / replay of a `payout_id` | Receipt PDA `["receipt", vault, payout_id]` created with `init` (never `init_if_needed`, no close instruction), so a second claim fails in S2 with system `Custom(0)` "already in use", before any handler check and even while paused | `claim::a_replayed_payout_id_fails_with_already_in_use`, `claim::a_replay_while_paused_still_reports_already_in_use` |
| 2 | Missing signer check | `Signer` on `claim_authority`, `payer`, `admin`, `authority`, `new_admin`, `upgrade_authority` (3010) | `claim::the_claim_authority_must_sign`, `claim::the_payer_must_sign`, `withdraw::the_admin_signature_is_required`, `initialize::the_upgrade_authority_and_the_payer_must_sign`, `admin::every_admin_instruction_requires_its_signature` |
| 3 | Wrong signer (authorization) | Key equality in the handler: C2 (6001), U1/G1/A1/W1 (6002), P1 (6003), B1 (6004), I2 (6005) | `claim::c2_a_signer_that_is_not_the_claim_authority_is_rejected`, `admin::u1_the_guardian_cannot_unpause_and_the_admin_can`, `admin::g1_only_the_admin_can_update_the_config`, `admin::a1_only_the_admin_can_propose`, `withdraw::w1_only_the_admin_can_withdraw`, `admin::p1_nobody_else_can_pause`, `admin::b1_only_the_pending_admin_can_accept`, `initialize::i2_a_signer_that_is_not_the_upgrade_authority_is_rejected` |
| 4 | Initialization front-running (anyone initializes a vault with their own roles) | I1: `program_data` must be this program's own ProgramData address (6006); I2: its `upgrade_authority_address == Some(signer)`, so an immutable program is refused (6005); `Account<ProgramData>` owner and state checks (3007, 3013) | `initialize::i1_a_foreign_program_data_account_is_rejected`, `initialize::a_program_data_lookalike_not_owned_by_loader_v3_is_refused`, `initialize::the_program_account_is_not_accepted_as_program_data`, `initialize::i2_an_immutable_program_cannot_be_initialized` |
| 5 | Re-initialization | Vault created with `init`; a second `initialize` for the mint fails in S2 "already in use" | `initialize::a_second_initialize_fails_with_already_in_use` |
| 6 | Initialization denial of service | The vault ATA is taken as an existing account (not `init`), so a stranger who creates it first cannot block `initialize` (I8); a pre-funded vault PDA or receipt address takes Anchor's transfer + allocate + assign path (I9, C9) | `initialize::i8_a_stranger_pre_creating_the_vault_ata_does_not_block_initialize`, `initialize::i9_a_pre_funded_vault_pda_is_initialized`, `claim::c9_a_pre_funded_receipt_address_is_claimed` |
| 7 | Fake accounts / owner confusion | `Account<Vault>` requires program ownership; `Account<Mint>` / `Account<TokenAccount>` require classic SPL Token ownership (3007) | `claim::a_vault_owned_by_another_program_is_refused`, `claim::an_uninitialized_vault_is_refused` (3012), `claim::a_token_2022_recipient_token_account_is_refused`, `claim::token_2022_mint_or_vault_token_account_is_refused`, `withdraw::token_2022_accounts_are_refused`, `initialize::a_token_2022_mint_is_refused`, `initialize::a_token_2022_vault_token_account_is_refused` |
| 8 | Type confusion between the program's own accounts | Account discriminators (3002) | `admin::a_receipt_is_not_accepted_as_a_vault` |
| 9 | PDA substitution | `seeds = ["vault", mint], bump = vault.bump` on `claim` and `withdraw`; canonical receipt seeds (2006) | `claim::a_different_mint_cannot_address_the_vault`, `withdraw::a_different_mint_cannot_address_the_vault`, `claim::a_non_canonical_receipt_address_is_rejected`, `initialize::a_non_canonical_vault_address_is_rejected` |
| 10 | Mint substitution | Seeds bind the vault to its mint; C3/W2 compare `mint` with `vault.mint` (6019); I3 requires 6 decimals (6019); W5 requires the destination to hold the vault mint (6022); `transfer_checked` uses the configured mint and `mint.decimals` | `claim::c3_a_vault_whose_stored_mint_differs_is_rejected`, `withdraw::w2_a_vault_whose_stored_mint_differs_is_rejected`, `initialize::i3_a_mint_without_6_decimals_is_rejected`, `withdraw::w5_a_destination_of_another_mint_is_rejected` |
| 11 | Vault token account substitution | `initialize` takes the canonical ATA via `associated_token::{mint, authority = vault, token_program}` (2015, 2009) and stores it; C4/W3 require `vault_token_account == vault.vault_token_account` (6018) | `initialize::a_vault_token_account_not_owned_by_the_vault_is_rejected`, `initialize::a_non_canonical_vault_token_account_is_rejected`, `claim::c4_a_non_canonical_vault_token_account_is_rejected`, `claim::a_second_vault_cannot_spend_the_first_vaults_token_account`, `withdraw::w3_a_non_canonical_vault_token_account_is_rejected` |
| 12 | Recipient token account substitution | `associated_token::{mint, authority = recipient, token_program}` on the recipient ATA (2015, 2009); a missing ATA is 3012; the rail's `createAssociatedTokenIdempotent` fails first on a re-owned ATA (`Custom(0)` at index 0) | `claim::a_non_canonical_recipient_token_account_is_rejected`, `claim::a_re_owned_recipient_ata_fails_at_the_ata_instruction`, `claim::a_missing_recipient_ata_is_not_initialized` |
| 13 | Arbitrary CPI / program substitution | `Program<Token>` and `Program<System>` (3008); the only CPIs are the system program inside `init` and classic Token `transfer_checked` | `initialize::a_token_program_other_than_classic_token_is_refused`, `claim::a_token_program_other_than_classic_token_is_refused`, `withdraw::a_token_program_other_than_classic_token_is_refused` |
| 14 | Token-2022 extensions (transfer hooks, fees, permanent delegate) | Classic SPL Token types only (`anchor_spl::token`), so Token-2022 mints and accounts fail the owner check (3007) | `initialize::a_token_2022_mint_is_refused`, `initialize::a_token_2022_vault_token_account_is_refused`, `claim::a_token_2022_recipient_token_account_is_refused`, `claim::token_2022_mint_or_vault_token_account_is_refused`, `withdraw::token_2022_accounts_are_refused` |
| 15 | Duplicate mutable accounts | Anchor's duplicate-mutable check (2040): recipient ATA = vault ATA, withdraw destination = vault ATA | `claim::the_vault_token_account_as_recipient_account_is_a_duplicate`, `withdraw::the_vault_token_account_as_destination_is_a_duplicate` |
| 16 | Missing writable check | `mut` on the vault (2000) | `claim::the_vault_must_be_writable` |
| 17 | Paying the vault, the hot key or the payer | `recipient: SystemAccount` (3011) and C5 (6017) | `claim::the_vault_as_recipient_fails_the_system_owner_check`, `claim::c5_the_claim_authority_or_the_payer_cannot_be_the_recipient` |
| 18 | Role collapse (hot key holds admin power) | I6/G3: claim authority differs from admin and guardian; A2/B2: the claim authority can never be proposed or accept the admin role (6020) | `initialize::i6_the_claim_authority_must_not_be_the_admin_or_the_guardian`, `admin::g3_the_claim_authority_must_not_be_the_admin_or_the_new_guardian`, `admin::a2_the_claim_authority_cannot_be_proposed`, `admin::b2_accept_rechecks_the_role_conflict` |
| 19 | Default-key roles (lost control) | I5/G2: admin, guardian and claim authority are never `Pubkey::default()` (6007) | `initialize::i5_default_roles_are_rejected`, `admin::g2_default_roles_are_rejected` |
| 20 | Cap bypass | C8 per-claim cap, inclusive (6010); C9/C10 fixed UTC-day bucket `unix_timestamp.div_euclid(86_400)`, reset only forward, never from slots (6011); I7/G4 caps non-zero and `max_per_claim <= max_per_day` (6021); a lowered daily cap blocks the rest of the day | `claim::c8_the_per_claim_cap_is_inclusive`, `claim::c10_the_daily_cap_holds_within_a_utc_day_and_resets_on_the_next`, `claim::a_clock_that_moves_back_keeps_counting_in_the_newer_day`, `claim::lowering_the_daily_cap_below_claimed_today_blocks_further_claims`, `initialize::i7_caps_must_be_non_zero_and_ordered`, `admin::g4_caps_must_be_non_zero_and_ordered` |
| 21 | Stale or long-lived authorizations | C11 `now <= expires_at` (6012); C12 `expires_at <= now + 900` (6013) | `claim::c11_c12_expiry_is_bounded_to_now_through_now_plus_900` |
| 22 | Integer overflow | `checked_add` on `claimed_today`, `now + 900`, `total_claimed`, `claim_count`, `total_withdrawn` (6023); release profile has `overflow-checks = true` | `claim::claimed_today_overflow_is_math_overflow`, `claim::c12_expiry_overflow_is_math_overflow`, `claim::counter_overflow_in_the_effects_is_math_overflow`, `withdraw::w8_total_withdrawn_overflow_is_math_overflow` |
| 23 | Frozen accounts (USDC freeze authority) | C13/W6 vault ATA not frozen (6014); C14 recipient ATA not frozen (6015); W5 destination not frozen (6022) | `claim::c13_a_frozen_vault_token_account_holds_claims`, `claim::c14_a_frozen_recipient_token_account_is_rejected`, `withdraw::w6_a_frozen_vault_token_account_holds_withdrawals`, `withdraw::w5_a_frozen_destination_is_rejected` |
| 24 | Overdraft | C15/W7 `vault_token_account.amount >= amount` (6016) | `claim::c15_the_vault_balance_bounds_the_claim`, `withdraw::w7_the_vault_balance_bounds_the_withdrawal` |
| 25 | No emergency stop | `pause` by admin or guardian, idempotent; `unpause` admin only; a new vault starts paused; pause blocks `claim` only, so admin recovery still works (C1, 6000) | `claim::c1_a_paused_vault_refuses_claims`, `admin::p1_admin_and_guardian_can_pause_and_pause_is_idempotent`, `admin::pause_blocks_claim_only`, `admin::u1_the_guardian_cannot_unpause_and_the_admin_can` |
| 26 | Admin takeover or a typo in the new admin | Two-step transfer: `propose_admin` then `accept_admin` by the proposed key; the default key cancels (6004) | `admin::the_admin_transfer_takes_two_steps`, `admin::b1_only_the_pending_admin_can_accept`, `admin::a_default_proposal_cancels_the_pending_admin` |
| 27 | Draining the float to an attacker | `withdraw` is admin only and W5 requires an unfrozen, vault-mint token account owned by the admin (6022) | `withdraw::w5_a_destination_not_owned_by_the_admin_is_rejected`, `withdraw::any_unfrozen_admin_owned_account_of_the_mint_is_a_valid_destination`, `withdraw::the_admin_withdraws_while_paused` |
| 28 | Third-party control of the vault ATA | I4: no delegate and no close authority at `initialize` (6018); the vault PDA is the only owner and never approves or closes | `initialize::i4_a_vault_ata_with_a_delegate_is_rejected`, `initialize::i4_a_vault_ata_with_a_close_authority_is_rejected` |
| 29 | Wrong PDA signer in the transfer | `transfer_checked` authority is the vault PDA, signed with `["vault", vault.mint, [vault.bump]]`; the receipt and counters are written before the CPI and the event after it (the test checks the event's log line follows the Token program's success line) | `claim::claim_pays_once_writes_the_receipt_and_emits_payout_claimed`, `withdraw::the_conservation_identity_holds_after_claims_and_withdrawals` |
| 30 | Layout drift between program and clients | Compile-time assertions on the discriminators and on 324 / 89 bytes; decode vectors from CONTRACT.md §3.2 and §3.4 reproduced byte for byte | `initialize::initialize_reproduces_the_contract_vault_vector`, `claim::claim_reproduces_the_contract_receipt_and_event_vectors`, `initialize::initialize_creates_a_paused_vault_with_the_contract_layout` |
| 31 | Wrong binary at the address, malformed input | Anchor's program-id check (4100), dispatch (101; data shorter than 8 bytes also gives 101 on Anchor 1.2.0, see the note below) and Borsh decode (102); exactly the 8 v0 instructions; no legacy IDL or event-CPI entrypoint | `artifact::the_binary_refuses_to_run_under_another_program_id`, `artifact::unknown_discriminator_is_rejected`, `artifact::the_r1_ping_stub_is_gone`, `artifact::data_shorter_than_a_discriminator_never_dispatches`, `artifact::malformed_claim_arguments_are_rejected`, `artifact::every_v0_instruction_is_dispatched` |
| 32 | Non-deterministic error reporting | Handler checks run in the fixed §3.3 order, one code each; each test breaks two adjacent checks at once and expects the earlier code | `claim::handler_checks_run_in_contract_order`, `claim::c2_to_c13_run_in_contract_order`, `initialize::i1_to_i7_run_in_contract_order`, `admin::g1_to_g4_run_in_contract_order`, `admin::a1_before_a2_and_b1_before_b2`, `withdraw::w1_to_w8_run_in_contract_order` |
| 33 | Compute exhaustion | `claim` at most 45,000 CU: 24,616 with the contract payout-id vector, and the worst of 32 random payout ids is held to the same budget (26,116 to 35,116 observed in CI); every instruction is written to `cu-report.json` | `claim::compute_units_are_reported_and_claim_fits_the_budget` |
| 36 | Under-funded payer | The receipt rent comes from `payer` through `init`; a payer that cannot fund it fails with system `Custom(1)` "insufficient lamports" at the claim index (§3.7, class hold) and nothing is written | `claim::a_payer_that_cannot_fund_the_receipt_rent_is_refused` |
| 34 | Unverifiable or mis-built artifact | SBPFv3 (`e_flags == 3`), embedded `security.txt`, upgradeable deployment with its ProgramData; `--features mainnet` is a `compile_error!` (CI step) | `artifact::artifact_is_sbpf_v3_and_embeds_security_txt`, `artifact::program_is_deployed_upgradeable_with_its_program_data` |
| 35 | Supply chain | Committed lockfiles checked with `--locked`; every crates.io package at least 7 days old (`crate-age`); Trivy on both lockfiles; SHA-pinned actions and checksummed toolchains; reproducible build with `solana-verify --arch v3` in a digest-pinned image | CI jobs `crate-age`, `trivy`, `lockfiles`, `build`, and the verifiable-build workflow |

Every program error code 6000-6023 is raised by at least one test at the step
CONTRACT.md §3.5 lists for it, and each such test asserts the transaction
error `InstructionError(index, Custom(code))` and Anchor's log line with the
exact error name and message. Tests that expect an Anchor account error (2000,
2006, 2009, 2015, 2040, 3002, 3007, 3008, 3010, 3011, 3012, 3013) also assert
Anchor's `AnchorError caused by account: <field>` log line, so they prove
which account tripped the check.

Anchor codes that cannot be reached with these account types: 2023 (an
`Account<TokenAccount>` is always owned by classic Token, which
`Program<Token>` also forces), 3009 (the program-id check fires first), 3014
and 4101 (no such constraints). Contract §3.6 lists 100 for instruction data
shorter than 8 bytes; Anchor 1.2.0 has no length check and returns 101
(`artifact::data_shorter_than_a_discriminator_never_dispatches` pins this).
Both halt the rail; the §3.6 row should be corrected in the next contract
version.

## Not enforced onchain in v0 (residual risk)

- **O4, hardcoded mint:** `initialize` checks only `decimals == 6`. The mint is
  pinned by the release manifest and the rail config, and only the upgrade
  authority can initialize (CONTRACT.md D-P6).
- **O18, claim authority versus upgrade authority:** enforced offchain only
  (admin CLI, rail §7.7). `initialize::o18_claim_authority_equal_to_the_upgrade_authority_is_not_checked_onchain`
  pins the v0 behavior so a change is deliberate.
- **Payer not pinned (SEC-9):** any key may pay the receipt rent. The payer
  cannot receive the payout (C5) and gains nothing else.
- **Upgrade authority is a trust root:** it can replace the program. Moving it
  to a multisig and, later, making the program immutable are deployment
  decisions outside this program.
- **Receipt verification is offchain:** settlement depends on the §3.8
  procedure in the SDK and the rail; the `PayoutClaimed` event is
  informational only, because logs can be truncated.
- **Compute units vary with the receipt bump:** `init` searches for the
  canonical receipt bump, about 1,500 CU per extra attempt, so `claim` costs
  more for payout ids whose bump is low. With the first candidate bump
  (255) `claim` costs about 18,600 CU; exceeding the 45,000 target needs 18
  more attempts (a canonical bump of 237 or lower), which happens for about
  one payout id in 260,000. The rail's compute-unit limit (60,000, §9.1)
  leaves more room still.
- **No audit yet:** the program must be audited before it holds mainnet funds.
