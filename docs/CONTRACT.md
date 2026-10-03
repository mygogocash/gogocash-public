# GoGoCash Solana payout contract v0

Single source of truth for the Solana USDC payout rail (ticket #2979, epic #2974). The program (R2), the public SDK (R3), the monorepo API rail (A0-A7) and the app (B1-B3) build and test against this document and its fixtures. Where this document and any other plan, ticket or comment disagree, this document wins until a new contract version replaces it.

## TL;DR

- **What is frozen:** one Anchor program `gogocash_cashback` with exactly 8 instructions, a 324-byte Vault, an 89-byte Receipt, 24 error codes (6000-6023) and one event; one SIWS consent message (16 ASCII lines, exact bytes signed through MWA `signMessages`); four member routes and eight admin routes under `/withdraw/solana`; six claim states (`reserved`, `sending`, `submitted`, `needs_review`, `finalized`, `released`).
- **Safety model:** a member signs a message, never a transaction. A row is paid only when a finalized Receipt matches the row's `(payout_id, recipient, amount)` tuple (§3.8); any mismatch is `needs_review` plus CRITICAL plus the halt latch, never paid. A reservation is returned only by an admin release proof, and in v0 only on devnet (§9.5).
- **Money rules:** integers only (`bigint` / `u64`). v0 supports THB ledgers only. `usdc_atomic = floor(net_satang x 10^12 / thb_per_usd_e8)`; by default the member keeps the sub-satang remainder (founder decision D4, still open, switchable through `solana_dust_policy`).
- **v0 cannot move money:** the devnet program id is a placeholder with no key (`HWNF2cvXybfAjLbw2pydi7sNFmTfYBjpEWNtY3BJfCje`) and mainnet has no id. The rail config is incomplete until a real, executable program exists, so a v0 build can never send. Real ids and PDA vectors arrive in v0.1.
- **Still open:** D4 (dust owner), the MWA error table (provisional until the B0 device capture, #2993), the real devnet program id, and the fixture files with their generator, which land in v0.1 (§11, §12).

## 1. Status and versioning

| Item | Value |
|---|---|
| Version | v0 |
| Frozen | 2 Oct 2026, 18:00 ICT |
| Published as | signed git tag `contract-v0` in `mygogocash/gogocash-public` (this file is `docs/CONTRACT.md`) |
| Consumers | program R2, SDK R3 (public repo); API A0-A7 and app B1-B3 (monorepo, through the vendor script with `git verify-tag`) |
| Next version | v0.1, the next signed tag |

**What may change in v0.1, and nothing else:**

1. The real devnet program id (generated at R1 after G0a), replacing the placeholder, and the per-cluster PDA vectors derived from it (review SCHED-8). The mainnet id stays `null` until the mainnet pilot is re-planned.
2. The MWA error table (§10.8), corrected from the B0 raw-code device capture (#2993). Its fixture is renamed from `mwa-errors.provisional.json` to `mwa-errors.json` at that point.
3. Founder decision D4 (§6.3), if the founder flips the default dust policy. Both policies are already specified and switch on one value, so a flip changes a default and its fixtures, not a layout.
4. The fixture files of §11, their generator and its `--check` mode.

**Append-only rules** (detailed for the program in §3.9):

- **Errors:** codes 6000-6023 never change number, name, meaning or class. New codes are appended from 6024. A removed check leaves its code reserved.
- **Instructions:** the 8 instruction names (and so their discriminators), argument lists and account lists never change. New behavior gets a new instruction name (for example `claim_v2`).
- **Account layouts:** sizes and existing offsets never change. New Vault fields are carved from the front of `reserved[64]`, and their all-zero value must mean "v0 behavior". The Receipt has no reserved bytes, so any Receipt change needs a new contract major version.
- **Event:** `PayoutClaimed` fields are never reordered or removed; new fields are appended only, and decoders ignore trailing bytes.
- **API:** new response fields, new error codes and new routes may be added; existing fields, codes, reason strings and state names never change meaning.

**How a change is made:** a change ships as a new contract version (a new signed tag, `contract-v0.N` for append-only changes and `contract-v1` for anything else) that updates this document, the IDLs and the fixtures together. The parity specs in both repos (SDK R3 in the public repo; API A0/A3 and app B2 in the monorepo, against their vendored copy) regenerate or re-read the fixtures and fail on any drift. The monorepo picks up a version only through the vendor script with `git verify-tag`, and the founder reviews the vendored diff.

---

## 2. Clusters

All values in this section were read on 2 Oct 2026 (ICT) with read-only JSON-RPC calls against `https://api.devnet.solana.com` and `https://api.mainnet-beta.solana.com` (both reported `apiVersion` 4.3.0). Clients must not hardcode the RPC URL; they must pin and check the genesis hash.

### 2.1 Cluster identity

| Field | devnet | mainnet |
|---|---|---|
| Cluster key used in this contract, `release/manifest.json` and the API | `devnet` | `mainnet` |
| Genesis hash (`getGenesisHash`) | `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` | `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` |
| CAIP-2 chain id (`solana:` + first 32 chars of the genesis hash) | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` |
| Wallet-standard / MWA `chain` and SIWS `Chain ID` string | `solana:devnet` | `solana:mainnet` |
| Public read-only RPC (verification and docs only) | `https://api.devnet.solana.com` | `https://api.mainnet-beta.solana.com` |

Rules:
- Every server-side component that sends or verifies (rail worker, reconciler, release assessor, verifier tool) calls `getGenesisHash` at start and before every release proof. A mismatch with this table makes the rail config incomplete (intake 503, sender holds).
- The cluster key (`devnet` / `mainnet`) is the identifier used in this contract, `release/manifest.json`, the API and the DB; the genesis hash is the identity check. The CAIP-2 form is listed for interoperability only, and no v0 component uses it. The `solana:devnet` / `solana:mainnet` strings are used only where the wallet protocols require them (MWA `authorize`, SIWS `Chain ID`, and the stored `authorized_chain` of §10.6).

### 2.2 Token and system programs

| Program | Address | Verified state (both clusters) |
|---|---|---|
| Classic SPL Token | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | executable, owner `BPFLoaderUpgradeab1e11111111111111111111111` |
| Associated Token Account | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` | executable, owner `BPFLoader2111111111111111111111111111111111` |
| System | `11111111111111111111111111111111` | builtin |
| BPF Loader Upgradeable (loader-v3) | `BPFLoaderUpgradeab1e11111111111111111111111` | builtin |
| Compute Budget | `ComputeBudget111111111111111111111111111111` | builtin |
| Token-2022 (REFUSED by this contract) | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` | not accepted anywhere in v0 |

### 2.3 USDC mints

Read with `getAccountInfo(<mint>, {encoding: "jsonParsed"})`.

| Field | devnet | mainnet |
|---|---|---|
| Mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| Owner program | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| Decimals | 6 | 6 |
| Account space | 82 (classic mint, no extensions) | 82 (classic mint, no extensions) |
| Freeze authority (observed, informational) | `CJtyoKSLrktozQzjERTiK3btQtiTK3nN4QrqGHLidyCT` | `7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar` |

Both mints have a live freeze authority. The program's frozen-account checks (6014, 6015) are therefore reachable in production, not theoretical.

Amounts are always integer atomic units (1 USDC = 1,000,000 atomic). JSON carries them as decimal strings; code uses `bigint` (TS) or `u64` (Rust). Never binary floating point.

### 2.4 Program id per cluster

| Cluster | v0 program id | Status |
|---|---|---|
| devnet | `HWNF2cvXybfAjLbw2pydi7sNFmTfYBjpEWNtY3BJfCje` (placeholder) | Not deployable. It is `base58(sha256("gogocash_cashback placeholder program id v0"))`; no private key exists. `getAccountInfo` returns `null` on both clusters. |
| mainnet | none | Not assigned in v0. Building with `--features mainnet` must fail with `compile_error!` until v0.x assigns it. |

Rules:
- Contract v0 uses the placeholder only (SCHED-8). Contract v0.1 (the signed tag after `contract-v0`) replaces the devnet id with the key generated at R1 and publishes the per-cluster PDA vectors for it. The mainnet id is added only when the mainnet pilot is re-planned.
- `declare_id!` is selected by the cargo feature `mainnet` (absent = devnet). The IDL files are `idl/gogocash_cashback.devnet.json` and, from the version that assigns it, `idl/gogocash_cashback.mainnet.json`.
- Every client passes `programAddress` from `release/manifest.json.programIds[cluster]`. Clients never use the IDL's or the generated client's default address. In v0, `programIds.devnet` is the placeholder and `programIds.mainnet` is `null`. A `null` or missing id means the cluster is unavailable.
- Rail config is incomplete (intake 503, sender holds) unless `getAccountInfo(programId)` returns an account that is `executable` and owned by `BPFLoaderUpgradeab1e11111111111111111111111`. The placeholder always fails this check, so a v0 build cannot send by accident.
- All PDA vectors are parameterised by program id. The vectors below use the placeholder. They test derivation code only and are not deployment addresses.

| Derivation (placeholder program id) | devnet | mainnet USDC mint (derivation only) |
|---|---|---|
| ProgramData `find_program_address([program_id], BPFLoaderUpgradeable)` | `5TKnZEGM435amgcnJX53LoPoiTsYA3yxUMFmd6UvLF7g`, bump 254 | same (does not depend on the mint) |
| Vault `["vault", mint]` | `4CyfLznBBXqSvKhsLTXgRiqHX5NoxeAe7eaMjfKVsWNG`, bump 254 | `2eDusayXKM6xkoo86HM2iYjVuJtizTwAL9qvrFpZTinb`, bump 253 |
| Vault token account = ATA(owner = vault, mint, classic Token) | `CgjjwVZpirGFVos8ugDeYXLVCbnbikEhTM2JUsD58wQZ` | `6zCWEQMokz27mauLBMsUU1Luw9yvf3zadojdM1pqAsrX` |
| Receipt `["receipt", vault, payout_id]`, payout_id `c6a87a9e170995438a78874587cb95773a9fa752c5b1633c9e7ae23928c88021` | `3abi6WfgCceNoMX3Gq5HcqhBePA6T6oNuy7ahhWUQNJR`, bump 251 | `Av2ptRUTGRweiHbZxmg82ixJRu5XZiixaGy7mZnQEFPZ`, bump 253 |
| Recipient ATA = ATA(owner = test key 1 `HupSGTuM8ra7TEsYhF4M2NuDt3iEPQVJv3WGnrtDg9D4`, mint, classic Token); does not depend on the program id | `8ozizdVK9uxjW7HSYXVyquw3Yn2BfNLkPTPLByfieR62` | `59WLigKFPCo26D5NByV2nsdtTjbRvivTPi1gUJrLuDoN` |

### 2.5 Per-cluster policy that touches the program (summary; the API section is normative)

| Item | devnet | mainnet |
|---|---|---|
| SIWS `Expiration Time` after `Issued At` | exactly 300 s (§4.4) | exactly 180 s (§4.4) |
| Onchain `expires_at` window (program-enforced) | `now <= expires_at <= now + 900` | same |
| Release (cancel) proof | allowed, admin only | refused in v0 until two independent RPC providers agree (SEC-4) |
| Allowlist mode (GRAPH-3) | user-only allowlist; wallet bound at the first verified submit (§7.6) | pinned `(user_id, wallet)` pairs |
| Initial vault caps used by the admin CLI | `max_per_claim` 5,000,000, `max_per_day` 20,000,000 | same (5 / 20 USDC) |

---

## 3. Program

Program `gogocash_cashback`, Anchor `=1.2.0`, SBPFv3, classic SPL Token only, `init-if-needed` feature off. Everything in this section is append-only (see 3.9).

### 3.1 Conventions

- Integers are little-endian. Layouts are Borsh as produced by Anchor 1.2.0 `#[account]` / `#[event]` / instruction args.
- `Pubkey` is 32 raw bytes. "Default" means `Pubkey::default()` (32 zero bytes, base58 `11111111111111111111111111111111`); it encodes "none" for `pending_admin` and is rejected for every active role.
- `bool` is one byte, 0 or 1. Any other value is a decode error.
- Discriminators are the first 8 bytes of `sha256(preimage)`: `account:<Name>` for accounts, `global:<snake_name>` for instructions, `event:<Name>` for events (verified against the Anchor 1.2.0 `sighash` / `gen_discriminator` sources; the R1 stub's `ping` IDL discriminator `[173,0,94,236,73,133,225,153]` reproduces with the same method).
- `now` = `Clock::get()?.unix_timestamp` (i64, seconds). `day(t)` = `t.div_euclid(86_400)` (UTC day number; 2026-10-02 is day 20728).
- Errors are Anchor custom errors: transaction error `InstructionError(<index>, Custom(<code>))`. Clients classify by number and instruction index, never by message text, except where 3.7 says so.

### 3.2 Accounts

#### Vault (PDA `["vault", mint]`, 324 bytes)

Discriminator `account:Vault` = `d308e82b02987577` = `[211,8,232,43,2,152,117,119]`.

| Offset | Size | Field | Type | Meaning |
|---:|---:|---|---|---|
| 0 | 8 | discriminator | `[u8;8]` | `d308e82b02987577` |
| 8 | 1 | version | `u8` | Layout version. `1` in v0. |
| 9 | 1 | bump | `u8` | Canonical bump of `["vault", mint]`. |
| 10 | 1 | paused | `bool` | `true` blocks `claim` only. |
| 11 | 1 | decimals | `u8` | Mint decimals copied at `initialize`; always 6. |
| 12 | 32 | mint | `Pubkey` | Configured USDC mint. |
| 44 | 32 | vault_token_account | `Pubkey` | Canonical ATA of (vault, mint, classic Token). |
| 76 | 32 | admin | `Pubkey` | Admin (later the Squads vault). |
| 108 | 32 | pending_admin | `Pubkey` | Proposed admin; default = none. |
| 140 | 32 | guardian | `Pubkey` | May pause only. |
| 172 | 32 | claim_authority | `Pubkey` | Worker hot key that co-signs `claim`. |
| 204 | 8 | max_per_claim | `u64` | Atomic USDC cap per claim. |
| 212 | 8 | max_per_day | `u64` | Atomic USDC cap per UTC day. |
| 220 | 8 | current_day | `i64` | `day(now)` of the bucket `claimed_today` counts. |
| 228 | 8 | claimed_today | `u64` | Atomic USDC claimed in `current_day`. |
| 236 | 8 | total_claimed | `u64` | Lifetime atomic USDC claimed. |
| 244 | 8 | claim_count | `u64` | Lifetime number of successful claims (= receipts created). |
| 252 | 8 | total_withdrawn | `u64` | Lifetime atomic USDC moved out by `withdraw`. |
| 260 | 64 | reserved | `[u8;64]` | Zero at `initialize`. Not interpreted. |
| | **324** | | | 8 + 4 + 6 x 32 + 7 x 8 + 64 |

Size correction (recomputed with node): the field list in the plan and in #2979 totals **323** bytes, one short of the frozen 324. v0 adds `decimals: u8` at offset 11 (after `paused`) to reach 324 without changing `reserved[64]`. All later offsets are as in the table. The program asserts `8 + Vault::INIT_SPACE == 324` at compile time.

Rent-exempt minimum observed on 2 Oct for 324 bytes: 2,296,160 lamports (both clusters). Clients read the rent value at runtime.

#### Receipt (PDA `["receipt", vault, payout_id]`, 89 bytes)

Discriminator `account:Receipt` = `279a496a50669199` = `[39,154,73,106,80,102,145,153]`.

| Offset | Size | Field | Type | Meaning |
|---:|---:|---|---|---|
| 0 | 8 | discriminator | `[u8;8]` | `279a496a50669199` |
| 8 | 1 | bump | `u8` | Canonical bump of `["receipt", vault, payout_id]`. |
| 9 | 32 | payout_id | `[u8;32]` | The 32 random bytes issued by the API at challenge time. |
| 41 | 32 | recipient | `Pubkey` | Wallet (system account) that received the USDC. |
| 73 | 8 | amount | `u64` | Atomic USDC transferred. |
| 81 | 8 | claimed_at | `i64` | `now` at execution. |
| | **89** | | | 8 + 1 + 32 + 32 + 8 + 8 (matches the frozen size; no change) |

Rent-exempt minimum observed on 2 Oct for 89 bytes: 1,102,360 lamports, paid by the `claim` payer and never reclaimable (no close instruction).

Seeds use the raw 32 payout_id bytes. The vault address in the seeds binds a receipt to one vault (one mint, one program id).

#### Decode vectors (placeholder program id, devnet mint)

Receipt at `3abi6WfgCceNoMX3Gq5HcqhBePA6T6oNuy7ahhWUQNJR` (bump 251), payout_id `c6a87a9e...c88021`, recipient `HupSGTuM8ra7TEsYhF4M2NuDt3iEPQVJv3WGnrtDg9D4` (fixture test_key_1), amount 3558875, claimed_at 1790910270 (2026-10-02T03:04:30Z):

```
279a496a50669199fbc6a87a9e170995438a78874587cb95773a9fa752c5b1633c9e7ae23928c88021fb42d41abb4d2f1daf215c9c992f2b77bd5b28151dba1a4f6a9156690feabf53db4d3600000000003e1fbf6a00000000
```

Vault V1 (just initialized: version 1, bump 254, paused true, decimals 6, devnet mint, vault ATA `CgjjwV...`, fixture roles, pending_admin default, caps 5,000,000 / 20,000,000, current_day 20728, counters 0):

```
d308e82b0298757701fe01063b442cb3912157f13a933d0134282d032b5ffecd01a2dbf1b7790608df002ea7ad9e88ce36000f85568c63289a49ddb5ad5c2e62d1ef6ee076f8cf409e6538c6bb1f73e0018299d2baa571fb466bbc997d040e1dfcef3a49b10e363542b95c2a0000000000000000000000000000000000000000000000000000000000000000c659a02bdcd91d24d2608551c37a158ca8fe04fde0365b347de421756e22f2b70a955ff259cacd683426a5247f00cc6d836abe6e88a776cf86397852dbd90c04404b4c0000000000002d310100000000f850000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
```

The full vault, receipt, instruction and event vectors (with their inputs) are generated from fixed seeds and will live in `test/fixtures/accounts.json` (§11, from v0.1); the two above are the reference copies.

### 3.3 Instructions (fixed set and order)

Declared in `#[program]` in this order. No other instruction exists in v0: the R1 `ping` stub is removed, and there is no `void_payout`, memo, close or `emit_cpi` instruction.

| # | Instruction | Discriminator (hex) | Args (Borsh, in order) | Data length |
|---:|---|---|---|---:|
| 1 | `initialize` | `afaf6d1f0d989bed` | `admin: Pubkey, guardian: Pubkey, claim_authority: Pubkey, max_per_claim: u64, max_per_day: u64` | 120 |
| 2 | `claim` | `3ec6d6c1d59f6cd2` | `payout_id: [u8;32], amount: u64, expires_at: i64` | 56 |
| 3 | `pause` | `d316ddfb4a79c12f` | none | 8 |
| 4 | `unpause` | `a99004260a8dbcff` | none | 8 |
| 5 | `update_config` | `1d9efcbf0a53db63` | `guardian: Pubkey, claim_authority: Pubkey, max_per_claim: u64, max_per_day: u64` | 88 |
| 6 | `propose_admin` | `79d6c7d4572775ea` | `new_admin: Pubkey` | 40 |
| 7 | `accept_admin` | `702a2d5a74b50daa` | none | 8 |
| 8 | `withdraw` | `b712469c946da122` | `amount: u64` | 16 |

Byte arrays as JSON (for IDL parity checks): initialize `[175,175,109,31,13,152,155,237]`, claim `[62,198,214,193,213,159,108,210]`, pause `[211,22,221,251,74,121,193,47]`, unpause `[169,144,4,38,10,141,188,255]`, update_config `[29,158,252,191,10,83,219,99]`, propose_admin `[121,214,199,212,87,39,117,234]`, accept_admin `[112,42,45,90,116,181,13,170]`, withdraw `[183,18,70,156,148,109,161,34]`.

Claim data vector (payout_id `c6a87a9e...c88021`, amount 3558875, expires_at 1790910565):

```
3ec6d6c1d59f6cd2c6a87a9e170995438a78874587cb95773a9fa752c5b1633c9e7ae23928c88021db4d3600000000006520bf6a00000000
```

#### 3.3.0 Evaluation order (all instructions)

Anchor 1.2.0 evaluates in this order (verified in `lang/syn/src/codegen/accounts/try_accounts.rs` and `constraints.rs` at v1.2.0). Checks in a later stage are reached only if every earlier stage passed.

| Stage | What runs | Errors it can raise |
|---|---|---|
| S0 | Program id check, discriminator dispatch, Borsh decode of args | 4100, 100, 101, 102 |
| S1 | Deserialise each account in declaration order (type checks: `Signer`, `SystemAccount`, `Account<T>` owner/discriminator, `Program<T>`) | 3005, 3010, 3011, 3012, 3007, 3001, 3002, 3003, 3013, 3008, 3009 |
| S2 | `init` accounts (create, or fund + allocate + assign if the address already holds lamports) | 2006, 4101, system `Custom(0)` "already in use", system `Custom(1)` insufficient lamports |
| S3 | Duplicate-mutable check across mutable `Account<T>` fields (pure `init` fields excluded) | 2040 |
| S4 | Per-field constraints in declaration order (`mut`, `seeds`, `associated_token`) | 2000, 2006, 2023, 2015, 2009 |
| S5 | Handler checks, in the order listed per instruction below | 6000-6023 |
| S6 | Effects (state writes), then CPIs, then `emit!` | CPI errors (should be unreachable after S5), 6023 |

Consequences that clients rely on:
- A replayed `claim` (receipt already exists) fails in S2 with "already in use" before any handler check, even when the vault is paused. Classification: `already_claimed`, then verify the receipt (3.8).
- Handler checks (S5) carry all business codes and run in a fixed order, so for a given state the error is deterministic.
- Within one `associated_token` field in S4, Anchor 1.2.0 checks the token program (2023), then the token account owner (2015), then the canonical address (2009). Because the rail always runs `createAssociatedTokenIdempotent` for the canonical recipient ATA first (§9.1), and the SDK `claim-tx` builder always includes it, a re-owned ATA fails at the ATA index (`Custom(0)`, `needs_review`) before `claim` runs. 2015 at the `claim` index therefore means our transaction named a wrong account, and it is `bug`.

#### 3.3.1 `initialize(admin, guardian, claim_authority, max_per_claim, max_per_day)`

Purpose: create the vault for one mint. Only the loader-v3 upgrade authority of this program may call it.

The admin CLI sends exactly one transaction: `[createAssociatedTokenIdempotent(payer, ata(vault, mint), vault, mint, classic Token), initialize]`. Because the ATA is taken as existing (not `init`), a stranger who creates the vault ATA first cannot block initialization (test I8). A vault PDA pre-funded with lamports is handled by Anchor's fund + allocate + assign path (test I9).

The admin CLI refuses to send `initialize` when `claim_authority` equals the upgrade authority signer. The rail checks the same key separation at boot and on every config-pin check (§7.7).

| # | Account | Type | Signer | Writable | Seeds / constraints |
|---:|---|---|:-:|:-:|---|
| 1 | vault | `Account<Vault>` | | yes | `init`, `payer = payer`, `space = 324`, `seeds = ["vault", mint]`, `bump` (canonical) |
| 2 | mint | `Account<Mint>` (anchor-spl `token`, classic) | | | owner must be classic Token (S1, 3007) |
| 3 | vault_token_account | `Account<TokenAccount>` (classic) | | | `associated_token::mint = mint`, `associated_token::authority = vault`, `associated_token::token_program = token_program` |
| 4 | program_data | `Account<ProgramData>` | | | owner loader-v3, state must be `ProgramData` (S1, 3007 / 3013); address checked in S5 |
| 5 | upgrade_authority | `Signer` | yes | | checked in S5 |
| 6 | payer | `Signer` | yes | yes | pays vault rent |
| 7 | token_program | `Program<Token>` | | | must be `Tokenkeg...` (3008) |
| 8 | system_program | `Program<System>` | | | |

Handler checks, in order:

| Step | Check | Error |
|---|---|---|
| I1 | `program_data.key() == find_program_address(&[crate::ID.as_ref()], &bpf_loader_upgradeable::ID).0` (SEC-5: binds to this program's own ProgramData, not a foreign one) | 6006 InvalidProgramData |
| I2 | `program_data.upgrade_authority_address == Some(upgrade_authority.key())` (an immutable program, authority `None`, is refused) | 6005 NotUpgradeAuthority |
| I3 | `mint.decimals == 6` | 6019 InvalidMint |
| I4 | `vault_token_account.delegate.is_none() && vault_token_account.close_authority.is_none()` | 6018 InvalidVaultTokenAccount |
| I5 | `admin`, `guardian`, `claim_authority` are each not default | 6007 InvalidRole |
| I6 | `claim_authority != admin && claim_authority != guardian` | 6020 RoleConflict |
| I7 | `max_per_claim > 0 && max_per_day > 0 && max_per_claim <= max_per_day` | 6021 InvalidCaps |

Effects: `version = 1`, `bump` = canonical bump, `paused = true`, `decimals = mint.decimals`, `mint`, `vault_token_account`, `admin`, `pending_admin = default`, `guardian`, `claim_authority`, caps from args, `current_day = day(now)`, all counters 0, `reserved` zero. CPIs: system program only (via `init`). Events: none.

A second `initialize` for the same mint fails in S2 with system `Custom(0)` "already in use". The vault starts paused: nobody can claim until the admin has verified the deployment and funded the vault, then calls `unpause` (SEC-5 ceremony).

#### 3.3.2 `claim(payout_id: [u8;32], amount: u64, expires_at: i64)`

Purpose: pay one approved payout exactly once. Signers: `claim_authority` (must equal the vault's) and `payer` (any key, not pinned in v0 per SEC-9; funds the receipt rent and, as transaction fee payer, the fee). `payer` may be the same key as `claim_authority`.

| # | Account | Type | Signer | Writable | Seeds / constraints |
|---:|---|---|:-:|:-:|---|
| 1 | vault | `Account<Vault>` | | yes | `seeds = ["vault", mint]`, `bump = vault.bump` |
| 2 | receipt | `Account<Receipt>` | | yes | `init`, `payer = payer`, `space = 89`, `seeds = ["receipt", vault, payout_id]`, `bump` (canonical). No `init_if_needed`. |
| 3 | mint | `Account<Mint>` (classic) | | | checked in S5 |
| 4 | vault_token_account | `Account<TokenAccount>` (classic) | | yes | checked in S5 |
| 5 | recipient | `SystemAccount` | | | must be system-owned (3011); a never-funded wallet passes; checked in S5 |
| 6 | recipient_token_account | `Account<TokenAccount>` (classic) | | yes | must exist (3012); `associated_token::mint = mint`, `associated_token::authority = recipient`, `associated_token::token_program = token_program` |
| 7 | claim_authority | `Signer` | yes | | checked in S5 |
| 8 | payer | `Signer` | yes | yes | |
| 9 | token_program | `Program<Token>` | | | must be `Tokenkeg...` (3008) |
| 10 | system_program | `Program<System>` | | | |

`#[instruction(payout_id: [u8; 32])]` exposes `payout_id` to the receipt seeds.

Handler checks, in order (every check maps to exactly one code):

| Step | Check | Error |
|---|---|---|
| C1 | `!vault.paused` | 6000 Paused |
| C2 | `claim_authority.key() == vault.claim_authority` | 6001 InvalidClaimAuthority |
| C3 | `mint.key() == vault.mint` (defense in depth; S4 seeds already bind vault to mint) | 6019 InvalidMint |
| C4 | `vault_token_account.key() == vault.vault_token_account` | 6018 InvalidVaultTokenAccount |
| C5 | `recipient.key()` is not `vault.key()`, not `claim_authority.key()` and not `payer.key()` | 6017 InvalidRecipient |
| C6 | `payout_id != [0u8; 32]` | 6008 ZeroPayoutId |
| C7 | `amount > 0` | 6009 ZeroAmount |
| C8 | `amount <= vault.max_per_claim` | 6010 ExceedsMaxPerClaim |
| C9 | Day roll and cap: `today = day(now)`; if `today > vault.current_day` then the bucket resets (`current_day = today`, `claimed_today = 0`); if `today <= current_day` nothing resets (forward only; a clock that moved back keeps counting in the newer bucket). `new_today = claimed_today.checked_add(amount)` | 6023 MathOverflow |
| C10 | `new_today <= vault.max_per_day` | 6011 DayCapExceeded |
| C11 | `now <= expires_at` | 6012 Expired |
| C12 | `expires_at <= now.checked_add(900)` (overflow maps to 6023) | 6013 ExpiryTooFar |
| C13 | `vault_token_account.state != Frozen` | 6014 VaultTokenAccountFrozen |
| C14 | `recipient_token_account.state != Frozen` | 6015 RecipientTokenAccountFrozen |
| C15 | `vault_token_account.amount >= amount` | 6016 InsufficientVaultBalance |

Checks done before S5 by Anchor, with their codes:
- recipient_token_account equal to vault_token_account: 2040 (S3). No custom code; it is also impossible for a canonical recipient ATA because `recipient != vault`.
- recipient ATA not under classic Token: 2023; owned by someone other than `recipient`: 2015; not canonical: 2009 (S4, checked in this order; see 3.3.0 for why 2015 at the `claim` index is `bug`).
- recipient ATA missing: 3012 (S1).
- Token-2022 mint or token accounts: 3007 (S1). Wrong token program: 3008 (S1).
- receipt address not the canonical PDA: 2006 (S2). Receipt already exists: system `Custom(0)` (S2).

Effects (in order, after all checks): write the receipt (`bump`, `payout_id`, `recipient`, `amount`, `claimed_at = now`); `vault.current_day` / `claimed_today = new_today`; `total_claimed = total_claimed.checked_add(amount)` and `claim_count = claim_count.checked_add(1)` (overflow 6023).

CPIs:
1. System program (inside `init` in S2): `create_account`, or `transfer` + `allocate` + `assign` when the receipt address was pre-funded (test C9).
2. Classic SPL Token `transfer_checked(from = vault_token_account, mint, to = recipient_token_account, authority = vault, amount, decimals = mint.decimals)`, signed with seeds `["vault", vault.mint, [vault.bump]]`.

Event: `emit!(PayoutClaimed)` after the transfer (3.4).

Compute budget target: at most 45,000 CU for `claim` (recorded per instruction in `cu-report.json`).

Recommended transaction (normative for the rail in §9.1): `[SetComputeUnitLimit, SetComputeUnitPrice, createAssociatedTokenIdempotent(payer, ata(recipient, mint), recipient, mint, classic Token), claim]`, recent blockhash only (never a durable nonce), `expires_at` derived from the cluster Clock plus at most 300 s.

#### 3.3.3 `pause()`

| # | Account | Type | Signer | Writable |
|---:|---|---|:-:|:-:|
| 1 | vault | `Account<Vault>` | | yes |
| 2 | authority | `Signer` | yes | |

| Step | Check | Error |
|---|---|---|
| P1 | `authority.key() == vault.admin \|\| authority.key() == vault.guardian` | 6003 NotAdminOrGuardian |

Effect: `paused = true`. Idempotent: pausing a paused vault succeeds. Blocks `claim` only. No CPI, no event.

#### 3.3.4 `unpause()`

| # | Account | Type | Signer | Writable |
|---:|---|---|:-:|:-:|
| 1 | vault | `Account<Vault>` | | yes |
| 2 | admin | `Signer` | yes | |

| Step | Check | Error |
|---|---|---|
| U1 | `admin.key() == vault.admin` | 6002 NotAdmin |

Effect: `paused = false`. Idempotent. The guardian cannot unpause. No CPI, no event.

#### 3.3.5 `update_config(guardian, claim_authority, max_per_claim, max_per_day)`

Accounts as `unpause` (vault writable, admin signer). Allowed while paused. Does not change `admin`, `pending_admin`, `paused` or any counter.

| Step | Check | Error |
|---|---|---|
| G1 | `admin.key() == vault.admin` | 6002 NotAdmin |
| G2 | `guardian` and `claim_authority` are each not default (SEC-5) | 6007 InvalidRole |
| G3 | `claim_authority != vault.admin && claim_authority != guardian` | 6020 RoleConflict |
| G4 | `max_per_claim > 0 && max_per_day > 0 && max_per_claim <= max_per_day` (SEC-5) | 6021 InvalidCaps |

Effect: overwrite `guardian`, `claim_authority`, `max_per_claim`, `max_per_day`. Lowering `max_per_day` below `claimed_today` is allowed and blocks further claims that day.

#### 3.3.6 `propose_admin(new_admin)`

Accounts as `unpause`.

| Step | Check | Error |
|---|---|---|
| A1 | `admin.key() == vault.admin` | 6002 NotAdmin |
| A2 | if `new_admin` is not default: `new_admin != vault.claim_authority` | 6020 RoleConflict |

Effect: `pending_admin = new_admin`. Passing the default key cancels a pending proposal.

#### 3.3.7 `accept_admin()`

| # | Account | Type | Signer | Writable |
|---:|---|---|:-:|:-:|
| 1 | vault | `Account<Vault>` | | yes |
| 2 | new_admin | `Signer` | yes | |

| Step | Check | Error |
|---|---|---|
| B1 | `vault.pending_admin` is not default and `new_admin.key() == vault.pending_admin` | 6004 NotPendingAdmin |
| B2 | `new_admin.key() != vault.claim_authority` (re-checked because `update_config` may have run since the proposal) | 6020 RoleConflict |

Effect: `admin = new_admin`, `pending_admin = default`.

#### 3.3.8 `withdraw(amount)`

Purpose: move float out of the vault. Admin only; allowed while paused.

| # | Account | Type | Signer | Writable | Seeds / constraints |
|---:|---|---|:-:|:-:|---|
| 1 | vault | `Account<Vault>` | | yes | `seeds = ["vault", mint]`, `bump = vault.bump` |
| 2 | admin | `Signer` | yes | | |
| 3 | mint | `Account<Mint>` (classic) | | | |
| 4 | vault_token_account | `Account<TokenAccount>` (classic) | | yes | |
| 5 | destination | `Account<TokenAccount>` (classic) | | yes | equal to vault_token_account fails with 2040 (S3) |
| 6 | token_program | `Program<Token>` | | | |

| Step | Check | Error |
|---|---|---|
| W1 | `admin.key() == vault.admin` | 6002 NotAdmin |
| W2 | `mint.key() == vault.mint` | 6019 InvalidMint |
| W3 | `vault_token_account.key() == vault.vault_token_account` | 6018 InvalidVaultTokenAccount |
| W4 | `amount > 0` | 6009 ZeroAmount |
| W5 | `destination.owner == vault.admin && destination.mint == vault.mint && destination.state != Frozen` | 6022 InvalidWithdrawDestination |
| W6 | `vault_token_account.state != Frozen` | 6014 VaultTokenAccountFrozen |
| W7 | `vault_token_account.amount >= amount` | 6016 InsufficientVaultBalance |
| W8 | `total_withdrawn.checked_add(amount)` | 6023 MathOverflow |

Effects: `total_withdrawn += amount`, then CPI `transfer_checked(vault_token_account -> destination, decimals = mint.decimals)` signed by the vault PDA. No event.

Conservation identity for watchers: `vault_token_account.amount == deposits - total_claimed - total_withdrawn`, where deposits are inbound transfers observed off-chain.

### 3.4 Event `PayoutClaimed`

Discriminator `event:PayoutClaimed` = `c8276970743f3a95` = `[200,39,105,112,116,63,58,149]`. Emitted with `emit!` (one `Program data: <base64>` log line; payload = discriminator + Borsh fields). 184 bytes.

| Offset | Size | Field | Type |
|---:|---:|---|---|
| 0 | 8 | discriminator | `[u8;8]` |
| 8 | 32 | vault | `Pubkey` |
| 40 | 32 | receipt | `Pubkey` |
| 72 | 32 | payout_id | `[u8;32]` |
| 104 | 32 | recipient | `Pubkey` |
| 136 | 8 | amount | `u64` |
| 144 | 8 | claimed_at | `i64` |
| 152 | 8 | day | `i64` (`current_day` after the claim) |
| 160 | 8 | claimed_today | `u64` (after the claim) |
| 168 | 8 | claim_count | `u64` (after the claim) |
| 176 | 8 | total_claimed | `u64` (after the claim) |

Vector (vault `4Cyf...`, receipt `3abi...`, the claim above, claimed_at 1790910270, day 20728, first claim of the day):

```
yCdpcHQ/OpUvpIRAZiyB8sbisxG+o+Rd4XcyW/Sq7bdpC7divXNZNSZSyR4+gTDyDOzyPXg1lEV8b3o70UKeY/qdK7VF4XBOxqh6nhcJlUOKeIdFh8uVdzqfp1LFsWM8nnriOSjIgCH7QtQau00vHa8hXJyZLyt3vVsoFR26Gk9qkVZpD+q/U9tNNgAAAAAAPh+/agAAAAD4UAAAAAAAANtNNgAAAAAAAQAAAAAAAADbTTYAAAAAAA==
```

The event is informational (Explorer, demo, telemetry). Logs can be truncated, so settlement never depends on it: the finalized receipt account is the only proof of payment (3.8).

### 3.5 Program error table (6000-6023)

Anchor `#[error_code] pub enum CashbackError`, codes from 6000 in this order. Messages are exact and ASCII.

Off-chain classes (used by the SDK and the rail):
- `retry`: transient. Keep the same row and `payout_id`; rebuild with a fresh blockhash and a new `expires_at`; resend.
- `hold`: not this row's fault. Keep the reservation, stop sending (row or rail), resend with the same `payout_id` when the condition clears (unpause, next UTC day, top-up).
- `needs_review`: row-specific and will not clear by itself. Keep the reservation; a human decides. Never auto-resend.
- `already_claimed`: a receipt exists. Run the receipt verification in 3.8 before anything else.
- `bug`: our code built an invalid call. Set the halt latch, raise CRITICAL, keep the reservation, no auto-retry.
- `config`: deployment or configuration mismatch (program id, mint, claim key, vault). Rail config becomes incomplete: intake 503, sender holds, halt latch, CRITICAL.

| Code | Name | Message | Raised by | Class |
|---:|---|---|---|---|
| 6000 | Paused | Vault is paused | claim C1 | hold |
| 6001 | InvalidClaimAuthority | Signer is not the vault claim authority | claim C2 | config |
| 6002 | NotAdmin | Signer is not the vault admin | unpause U1, update_config G1, propose_admin A1, withdraw W1 | bug |
| 6003 | NotAdminOrGuardian | Signer is neither the vault admin nor the guardian | pause P1 | bug |
| 6004 | NotPendingAdmin | Signer is not the pending admin | accept_admin B1 | bug |
| 6005 | NotUpgradeAuthority | Signer is not the program upgrade authority | initialize I2 | config |
| 6006 | InvalidProgramData | Account is not this program's ProgramData account | initialize I1 | bug |
| 6007 | InvalidRole | Role must not be the default public key | initialize I5, update_config G2 | bug |
| 6008 | ZeroPayoutId | Payout id must not be all zero bytes | claim C6 | bug |
| 6009 | ZeroAmount | Amount must be greater than zero | claim C7, withdraw W4 | bug |
| 6010 | ExceedsMaxPerClaim | Amount exceeds the per-claim cap | claim C8 | needs_review |
| 6011 | DayCapExceeded | Claim would exceed the daily cap | claim C10 | hold |
| 6012 | Expired | Claim has expired | claim C11 | retry |
| 6013 | ExpiryTooFar | Claim expiry is more than 900 seconds ahead | claim C12 | bug |
| 6014 | VaultTokenAccountFrozen | Vault token account is frozen | claim C13, withdraw W6 | hold (+ CRITICAL + halt latch) |
| 6015 | RecipientTokenAccountFrozen | Recipient token account is frozen | claim C14 | needs_review |
| 6016 | InsufficientVaultBalance | Vault balance is below the amount | claim C15, withdraw W7 | hold |
| 6017 | InvalidRecipient | Recipient must not be the vault, the claim authority or the payer | claim C5 | needs_review |
| 6018 | InvalidVaultTokenAccount | Vault token account is not canonical or has a delegate or close authority | initialize I4, claim C4, withdraw W3 | config |
| 6019 | InvalidMint | Mint is not the vault mint or does not have 6 decimals | initialize I3, claim C3, withdraw W2 | config |
| 6020 | RoleConflict | Claim authority must not also be the admin or the guardian | initialize I6, update_config G3, propose_admin A2, accept_admin B2 | bug |
| 6021 | InvalidCaps | Caps must be non-zero and max_per_claim must not exceed max_per_day | initialize I7, update_config G4 | bug |
| 6022 | InvalidWithdrawDestination | Withdraw destination must be an unfrozen vault-mint token account owned by the admin | withdraw W5 | bug |
| 6023 | MathOverflow | Arithmetic overflow | claim C9, C12, effects; withdraw W8 | bug |

Admin-only codes (6002-6007, 6020-6022) never come from `claim`; the admin CLI shows them to the operator. Their class applies if the rail ever sees one.

### 3.6 Anchor built-in errors clients must map

Numbers verified against `lang/error/src/lib.rs` at Anchor v1.2.0 (otter-sec/anchor tag v1.2.0). Any Anchor code not in this table is `bug`.

| Code | Name | Where it arises here | Class |
|---:|---|---|---|
| 100 | InstructionMissing | data shorter than 8 bytes | bug |
| 101 | InstructionFallbackNotFound | unknown discriminator: wrong program at the address, stub or older build | config |
| 102 | InstructionDidNotDeserialize | args malformed | bug |
| 2000 | ConstraintMut | writable flag missing | bug |
| 2006 | ConstraintSeeds | vault or receipt address not the canonical PDA (wrong program id or mint in derivation) | bug |
| 2009 | ConstraintAssociated | recipient or vault token account is not the canonical ATA | bug |
| 2015 | ConstraintTokenOwner | `claim`: the recipient token account passed is not owned by `recipient`. A re-owned canonical ATA cannot reach this check, because `createAssociatedTokenIdempotent` runs first and fails with `Custom(0)` (3.7), so 2015 means our transaction named a wrong account; `initialize`: vault ATA not owned by the vault | bug |
| 2023 | ConstraintAssociatedTokenTokenProgram | ATA not under classic Token | bug |
| 2040 | ConstraintDuplicateMutableAccount | the same account passed twice as mutable (for example destination = vault token account) | bug |
| 3001 / 3002 / 3003 | AccountDiscriminatorNotFound / AccountDiscriminatorMismatch / AccountDidNotDeserialize | vault address holds something else; layout or program-id mismatch | config |
| 3005 | AccountNotEnoughKeys | account list too short | bug |
| 3007 | AccountOwnedByWrongProgram | Token-2022 mint or token account, or a vault from another program | config |
| 3008 | InvalidProgramId | wrong token or system program passed | bug |
| 3009 | InvalidProgramExecutable | program account not executable | bug |
| 3010 | AccountNotSigner | claim_authority, payer or admin did not sign | bug |
| 3011 | AccountNotSystemOwned | `recipient` is owned by a program (not a wallet) | needs_review |
| 3012 | AccountNotInitialized | recipient ATA missing (or vault not initialized) | `config` for the rail. The rail always sends `createAssociatedTokenIdempotent` in the same transaction, so 3012 means the vault or the vault ATA is missing. `retry` applies only to an SDK caller that built `claim` without the ATA instruction; the SDK `claim-tx` builder always includes it. |
| 3013 | AccountNotProgramData | `initialize` given a non-ProgramData account | bug |
| 3014 | AccountNotAssociatedTokenAccount | not expected with these constraints | bug |
| 4100 | DeclaredProgramIdMismatch | the deployed binary was built for another program id (wrong cargo feature) | config |
| 4101 | TryingToInitPayerAsProgramAccount | payer equals an `init` account | bug |
| 2500-2506 | Require* | not used (the program uses custom codes) | bug |

### 3.7 Non-Anchor instruction errors (classify by failing instruction index)

The transaction error names the failing top-level instruction index. A CPI failure surfaces at the index of the instruction that made the CPI, with the callee's code. Classify against this table using that index. Transaction-level errors without an index (blockhash, fee, account-in-use) are classified in §9.1.

| Failing instruction | Error | Meaning | Class |
|---|---|---|---|
| `claim` | `Custom(0)`, logs contain `already in use` (system `AccountAlreadyInUse`) | receipt for this `payout_id` already exists | already_claimed (verify receipt, 3.8). If logs are truncated, `Custom(0)` at the `claim` index alone still routes to receipt verification, which is read-only and safe. |
| `claim` | `Custom(1)`, logs contain `insufficient lamports` (system `ResultWithNegativeLamports`) | payer cannot fund the receipt rent | hold (top up the fee payer) |
| `claim` | any other `Custom(n)` with `n < 6000` and not in 3.6 (for example SPL Token codes from `transfer_checked`) | should be unreachable after C13-C15 | bug |
| `initialize` | `Custom(0)` "already in use" | vault for this mint already exists | bug (admin CLI: show the existing vault) |
| `createAssociatedTokenIdempotent` | `Custom(0)` (ATA `InvalidOwner`) or `IllegalOwner` | the recipient's ATA exists but was re-owned | needs_review |
| `createAssociatedTokenIdempotent` | `Custom(1)` system insufficient lamports | payer cannot fund ATA rent | hold |
| compute-budget instructions | any | malformed budget instruction | bug |

`Custom(0)` therefore means `already_claimed` only at the `claim` index. At the ATA index it means `needs_review`.

### 3.8 Receipt verification (normative for the SDK, reconciler and release assessor)

A row is paid only when this procedure returns `match` at `finalized` commitment:

1. **Deployment binding.** The rail first requires the row's `solana_cluster`, `solana_genesis_hash`, `solana_program_id`, `solana_mint`, `solana_vault` and `solana_vault_token_account` to equal the running config. It then derives `receipt = find_program_address(["receipt", row.solana_vault, payout_id], row.solana_program_id)` with the row's stored `payout_id`, and requires it to equal the stored `solana_receipt_address`. Any difference, with no chain read: `needs_review` (`deployment_mismatch`) plus CRITICAL plus the halt latch. An SDK caller passes `vault`, `payout_id` and `program_id` explicitly and derives the receipt from them.
2. `getAccountInfo(receipt, {commitment: "finalized", encoding: "base64"})`. If the RPC supports it, pass `minContextSlot` of at least the slot already observed for this row.
3. `null`: `absent` (not claimed as of that slot).
4. Otherwise require all of: owner == `program_id`; data length == 89; bytes 0..8 == `279a496a50669199`; byte 8 == the derived bump. Any failure: `mismatch`.
5. Require payout_id (bytes 9..41) == the row's payout_id, recipient (41..73) == the row's recipient, amount (73..81) == the row's `solana_amount_atomic`. All equal: `match`. Any difference: `mismatch`.

Outcomes:
- `match`: the reconciler may CAS the row to paid (finalized).
- `mismatch` (including "already in use" followed by a tuple mismatch, which is what a leaked claim key front-running a known `payout_id` looks like): `needs_review` + CRITICAL + halt latch. Never paid (SEC-9).
- `absent` after an `already_claimed` classification: `needs_review` (inconsistent RPC view), after a 60 s finalization grace (§9.2); never released on this evidence alone.

### 3.9 Append-only rules

1. Error codes 6000-6023 never change number, name, meaning or class. New codes are appended from 6024. Removed checks leave their code reserved.
2. Instruction names (hence discriminators), argument lists and account lists of the 8 instructions never change. New behavior gets a new instruction (for example `claim_v2`).
3. Seeds never change: `["vault", mint]`, `["receipt", vault, payout_id]`.
4. Vault stays 324 bytes and Receipt 89 bytes; no realloc, no close. Existing offsets never move. New Vault fields are carved from the front of `reserved`, and their all-zero value must mean "v0 behavior". `version` is bumped only when the meaning of existing bytes changes, which requires a new contract major version.
5. `PayoutClaimed` fields are never reordered or removed. New fields may only be appended at the end; decoders must ignore trailing bytes. New events are allowed.
6. No `init_if_needed`, no close instruction for receipts, ever. A receipt, once created, is permanent.
7. Classic SPL Token only. Supporting Token-2022 requires a new contract major version.
8. Every change to this section ships with updated fixtures, IDLs and parity specs in both repos under a new signed tag.

---

## 4. Consent message

The member never signs a transaction. They sign one ASCII text message in SIWS (Sign-In With Solana, EIP-4361 style) format through MWA `signMessages`. The API builds the message, stores its exact bytes, and verifies the signature only over those stored bytes. The program never sees the message. Its role is to bind, offchain, the member's wallet to one exact `(recipient, amount_atomic, payout_id, program_id)` tuple before any THB is reserved.

### 4.1 Encoding rules (frozen)

| Rule | Value |
|---|---|
| Character set | Printable ASCII only: every byte is `0x20`-`0x7E` or `0x0A`. No CR (`0x0D`), no TAB, no NUL, no byte `>= 0x80`, no BOM. |
| Line separator | `"\n"` (LF, `0x0A`) only. |
| Trailing newline | **None.** The last byte is the last character of the program-id resource line. |
| Leading/trailing spaces | No line starts or ends with a space. No double spaces. |
| Line count | Exactly 16 lines (15 LF bytes). Lines 3 and 5 are empty. |
| Optional SIWS fields | `Not Before` is never emitted. No field may be added, removed or reordered. |
| Byte encoding | The text is its own UTF-8 encoding (ASCII), so `byte_length == char_length`. |
| Maximum length | **1024 bytes**, hard cap, checked by the renderer and the verifier. The widest legal message (u64-max amounts, 44-char address and program id, devnet domain) is 813 bytes. |
| Statement language | Always the English text below, whatever the app locale. The app may show a localized explanation before Session B, but the signed bytes never change with locale. |

### 4.2 Template, line by line

`<cluster>` is `devnet` or `mainnet` (§2). Every placeholder below is filled by the API from its own state, never from client text.

| # | Line (exact) | Constraint |
|---|---|---|
| 1 | `<domain> wants you to sign in with your Solana account:` | `<domain>` from the table in 4.4. |
| 2 | `<address>` | The recipient = the signer. Strict base58, 32 bytes (§5.4). |
| 3 | *(empty)* | |
| 4 | `<statement>` | One line, see 4.3. |
| 5 | *(empty)* | |
| 6 | `URI: <uri>` | `<uri>` = `https://` + `<domain>`, no path, no trailing slash, no port. |
| 7 | `Version: 1` | Literal. |
| 8 | `Chain ID: solana:<cluster>` | `solana:devnet` or `solana:mainnet`. |
| 9 | `Nonce: <nonce>` | `^[0-9a-f]{32}$` (§5.3). |
| 10 | `Issued At: <issued_at>` | Timestamp format in 4.5. |
| 11 | `Expiration Time: <expiration_time>` | `issued_at + TTL` exactly (4.4). |
| 12 | `Request ID: <withdrawal_id>` | `^[0-9a-f]{24}$` (§5.2). |
| 13 | `Resources:` | Literal. |
| 14 | `- gogocash:payout:<payout_id_hex>` | `^[0-9a-f]{64}$` (§5.1). |
| 15 | `- gogocash:amount:<amount_atomic>` | USDC atomic units (6 decimals), decimal u64, `^[1-9][0-9]{0,19}$`, `<= 18446744073709551615`. |
| 16 | `- solana:<cluster>:<program_id>` | `<cluster>` equals the one on line 8. `<program_id>` = `release/manifest.json.programIds[cluster]`, strict base58, 32 bytes. |

The three Resources are RFC 3986 URIs (scheme `gogocash` or `solana`), always in this order.

### 4.3 Statement (line 4)

```
Withdraw <U> USDC to this wallet on Solana <cluster_label>. GoGoCash deducts THB <D> from your cashback balance, including a THB <F> fee. Sign only if you started this withdrawal in the GoGoCash app.
```

| Placeholder | Value | Format |
|---|---|---|
| `<U>` | `amount_atomic` (the same integer as line 15) | `floor(U/10^6)` in decimal, then `.`, then `U mod 10^6` zero-padded to **exactly 6** digits. No thousands separators, no sign. Example `3972030` → `3.972030`, `1000000` → `1.000000`. |
| `<D>` | THB deducted for this withdrawal, **including the fee**, in satang. This equals the ledger row's `amount_total` (§6). | `floor(D/100)`, `.`, `D mod 100` padded to **exactly 2** digits. Example `15000` → `150.00`. |
| `<F>` | Fee in satang (may be 0). | Same 2-decimal format. `0` → `0.00`. |
| `<cluster_label>` | devnet: `devnet (test network, no real value)`; mainnet: `mainnet` | Literal. |

The literal currency is `THB`. In v0 the only supported ledger currency is THB. A member whose ledger currency is not THB gets `GET config` `enabled: false` (reason owned by §7), so no other currency can ever be rendered. `<D>` comes from the §6 quote, so the template does not change if D4 is flipped. Under the v0 default, `D = ceil(U × thb_per_usd_e8 / 10^12) + F`. Under the alternative, `D` = the full requested amount.

### 4.4 Per-environment values

| API environment | Cluster | `<domain>` | `<uri>` | TTL (`expiration_time − issued_at`) |
|---|---|---|---|---|
| preview | devnet | `app-staging.gogocash.co` | `https://app-staging.gogocash.co` | **300 s** |
| production | mainnet | `app.gogocash.co` | `https://app.gogocash.co` | **180 s** |

`GET config` returns `siws_domain` and `siws_uri` with exactly these values. Section 10's MWA `identity.uri` is the same string as `<uri>`. A wallet that cross-checks the SIWS domain against the requesting app identity therefore always sees a match. Any other API environment (local or test) uses the preview row with cluster devnet.

### 4.5 Timestamps and the time window

- **Format:** ISO 8601 UTC with milliseconds and `Z`, exactly `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`. This is JavaScript `Date.prototype.toISOString()` output. No offsets, no other precision.
- **Issued At** is the API server clock (ms) when the challenge is created. **Expiration Time** = Issued At + TTL, exactly.
- The challenge record stores both instants as integer epoch milliseconds. They are the source of truth for the window check, and they render byte-identically into lines 10 and 11.
- **Intake window:** submit is accepted only if `issued_at_ms − 5000 <= now_ms <= expiration_ms`, both ends inclusive, where `now_ms` is the API server clock read once at the start of the request. The 5 s lower slack absorbs clock skew between API instances.
- The device clock is never used for any check. The app derives its own local "sign by" deadline from the challenge response's TTL and its monotonic clock, minus 10 s (§10.3).

### 4.6 Worked example (fixture `consent_devnet_thb_with_fee`)

Inputs, all deterministic:

| Input | Value |
|---|---|
| Signer | test key 1: seed = `sha256("gogocash contract v0 test key 1")` = `3b18aeea0800c3391609967bac2e46dbf311ff29a50ba8384079366dd89bbc61`; public key `HupSGTuM8ra7TEsYhF4M2NuDt3iEPQVJv3WGnrtDg9D4` |
| Cluster | devnet |
| Amounts | the `thb_with_fee` amount vector: requested 15000 satang, fee 1500, `thb_per_usd_e8 = 3398765432` → `amount_atomic = 3972030`, D = 15000, F = 1500 |
| nonce | `75443685f715416cc93848184b356559` (fixed id set 1) |
| withdrawal_id | `cddbbad6db231771bc0060be` (fixed id set 1) |
| payout_id | `c6a87a9e170995438a78874587cb95773a9fa752c5b1633c9e7ae23928c88021` (fixed id set 1) |
| program_id | `HWNF2cvXybfAjLbw2pydi7sNFmTfYBjpEWNtY3BJfCje` (v0 placeholder; SCHED-8) |
| issued_at | `2026-10-02T03:04:05.678Z` |

Rendered message (16 lines, no trailing newline):

```
app-staging.gogocash.co wants you to sign in with your Solana account:
HupSGTuM8ra7TEsYhF4M2NuDt3iEPQVJv3WGnrtDg9D4

Withdraw 3.972030 USDC to this wallet on Solana devnet (test network, no real value). GoGoCash deducts THB 150.00 from your cashback balance, including a THB 15.00 fee. Sign only if you started this withdrawal in the GoGoCash app.

URI: https://app-staging.gogocash.co
Version: 1
Chain ID: solana:devnet
Nonce: 75443685f715416cc93848184b356559
Issued At: 2026-10-02T03:04:05.678Z
Expiration Time: 2026-10-02T03:09:05.678Z
Request ID: cddbbad6db231771bc0060be
Resources:
- gogocash:payout:c6a87a9e170995438a78874587cb95773a9fa752c5b1633c9e7ae23928c88021
- gogocash:amount:3972030
- solana:devnet:HWNF2cvXybfAjLbw2pydi7sNFmTfYBjpEWNtY3BJfCje
```

| Property | Value |
|---|---|
| UTF-8 byte length | **756** |
| sha256 of the bytes | **`bfe513dd2f04a2b297170eaf366ef06710189d1a778e94230634979a4db7ac36`** |
| Ed25519 signature by test key 1 (base58) | `5EMWeLtCM3Bofpf5DHDq3fKbgWPk2C4SZYFq6vCkPd4kYXWJWeePWvJyvJ3yfrC1tSEGMNcPDiRdUHD4RVYfg5Ru` |
| Same signature (hex) | `d3956b1a12bf7219756157f7e32aea85bd2af06eeb825488bee7e3fed442872ec05bc374d28a46cbea4728a9884e39677e82bd7151159e8af16b116313ee430c` (from `node:crypto` `sign(null, bytes, key)`) |
| MWA shape A (`message ‖ signature`) | 820 bytes; the prefix equals the message, and the last 64 bytes equal the signature |
| MWA shape B (signature only) | 64 bytes; empty prefix |
| Strict verify (4.7) | `ok` |
| `@solana/wallet-standard-util` `parseSignInMessageText` → `createSignInMessageText` round trip | byte-identical |
| Negative: amount resource `3972030` → `3972031` | `signature_invalid` |
| Negative: one trailing `"\n"` appended | `signature_invalid` |
| Negative: LF replaced by CRLF | `signature_invalid` |

This vector is `siws.json` id `consent_devnet_thb_with_fee` (§11). The research generator that produced it is ported into the public repo's fixture generator, and both repos' parity specs must reproduce the length, the sha256 and the signature. Ed25519 (RFC 8032) is deterministic, so the signature is reproducible.

### 4.7 Signature verification (API; one shared implementation in the SDK)

`verifyConsentSignature(publicKey32, messageBytes, signature64) → ok | <reason>` runs these steps in order and stops at the first failure:

1. Lengths: public key exactly 32 bytes and signature exactly 64 bytes, else `bad_length`.
2. **Small-order A:** reject if the public key equals any of these 8 encodings (hex) → `A_small_order`:
   `0100000000000000000000000000000000000000000000000000000000000000`,
   `ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f`,
   `0000000000000000000000000000000000000000000000000000000000000000`,
   `0000000000000000000000000000000000000000000000000000000000000080`,
   `26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05`,
   `26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85`,
   `c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a`,
   `c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa`.
   This also rejects the all-zero address `11111111111111111111111111111111` as a signer.
3. **Non-canonical A:** clear bit 255 and read the 32 bytes as a little-endian integer y. If `y >= p` (p = 2^255 − 19) → `A_non_canonical`.
4. **Non-canonical R:** the same test on signature bytes 0..31 → `R_non_canonical`.
5. **S not reduced:** signature bytes 32..63 as little-endian. If `S >= L` (L = 2^252 + 27742317777372353535851937790883648493) → `S_not_reduced`.
6. `crypto.verify(null, messageBytes, createPublicKey({key: concat(SPKI_PREFIX, publicKey32), format: 'der', type: 'spki'}), signature64)` with `SPKI_PREFIX = 302a300506032b6570032100` (hex), from `node:crypto`. A `false` result or any throw → `signature_invalid`.

Rules:
- These are byte comparisons plus one `node:crypto` call. No custom curve arithmetic.
- **Never** use `@noble/curves` `ed25519.verify` unless `{ zip215: false }` is passed. Its default accepts non-canonical encodings. A lint rule or spec must forbid a bare call.
- Negative fixtures (the 8 small-order keys, non-canonical A, non-canonical R, S+L malleated, wrong message, wrong key, tampered SIWS, wrong signer) run in the API image's CI, because production Node/OpenSSL may differ from a laptop's.
- All 11 precheck negatives of the research vectors produce the expected reason with this procedure; they become part of `ed25519.json` (§11).

### 4.8 What the API stores and what the client sends (SEC-6)

At `POST /withdraw/solana/challenge` the API renders the message and stores, on the challenge record:
- the exact message bytes, as BSON binary;
- every render input (recipient, amount_atomic, D, F, nonce, `issued_at_ms`, `expiration_ms`, withdrawal_id, payout_id, cluster, program_id).

The response carries the bytes as standard base64 (RFC 4648 §4, padded). The app passes those decoded bytes to `signMessages` unchanged. It never decodes them to text and re-encodes.

`POST /withdraw/solana/withdrawals` body `{challenge_id, address, signed_message, signature}`:

| Field | Encoding | Rule |
|---|---|---|
| `challenge_id` | 24 lowercase hex | Must match the Idempotency-Key `solana-<challenge_id>`. |
| `address` | strict base58, 32 bytes | Must string-equal the challenge's recipient, else 400. |
| `signature` | strict base58, 64 bytes | The **last 64 bytes** of MWA `signed_payloads[0]`. Never the whole payload. |
| `signed_message` | standard base64, or `""` | The bytes of `signed_payloads[0]` before the last 64. MWA 2.3.0 returns either `message ‖ signature` (prefix = message) or the signature alone (prefix empty). If non-empty, it must **byte-equal** the stored message bytes, else **400**. It is never parsed, logged as text, or used for anything else. |

The server **never parses any field from client-supplied text**. Amount, recipient, payout id and program id come only from the challenge record.

### 4.9 Where each check runs (SEC-7)

**Intake (`POST withdrawals`), in this order:**
1. Idempotency replay lookup **first** (§7). A replay returns the existing row and performs none of the steps below.
2. Body shape validation (4.8) → 400.
3. Load the challenge by `_id` **and** the caller's `user_id`. If it is absent, purged or another user's → 404, the same response in all three cases.
4. `address == challenge.recipient` → else 400.
5. `signed_message` is empty or byte-equal → else 400.
6. `verifyConsentSignature(recipient, stored bytes, signature)` → else 400.
7. Time window (4.5) → else `410` (the app restarts from a new challenge).
8. The rail gates are re-checked (§7.1, submit step 8) → else `503`; a challenge whose cluster, program id, mint or vault no longer equals the running config → `410`.
9. **Nonce burn** inside `runSerializedWithdrawForRail`: a compare-and-set of the challenge from `issued` to `consumed` (with `withdrawal_id`), in the same transaction that inserts the pending row. If it matches 0 documents, the replay lookup runs once more; if it finds no row → `409` (or `410` if expired). The pending row keeps the exact message bytes and the 64-byte signature. The challenge collection is TTL-purged, so the row is the durable consent evidence.

The exact `code` for every step is in §7.1 (submit processing order) and §7.2. Error envelope and reason strings are owned by §7. The consent reasons are `consent_address_mismatch`, `consent_message_mismatch`, `consent_signature_invalid`, `consent_expired` and `consent_already_used`.

**Send time (sender, before the first broadcast and before every resend):**
1. Re-render the message from the row's own fields and stored render inputs. It must byte-equal the stored bytes.
2. `verifyConsentSignature(row.recipient, stored bytes, stored signature)` must be `ok`.
3. Tuple equality between consent and claim instruction: recipient, `amount_atomic`, `payout_id` and `program_id` in the message and on the row must equal the `claim` accounts and arguments being signed, and `program_id` must equal the currently configured program id for the cluster. The row's `solana_cluster`, `solana_genesis_hash`, `solana_mint`, `solana_vault` and `solana_vault_token_account` must equal the running config and the `claim` accounts (§3.8 step 1).
4. **No clock check.** The Expiration Time is never compared with now at send time. Freshness onchain is the per-attempt `expires_at` (§3, §9).

A send-time failure means stored data was corrupted or tampered with. The row goes to `needs_review` with a CRITICAL alert and the halt latch is set (§9). It is never sent. The review reason is `deployment_mismatch` for a deployment-field difference in step 3 and `consent_invalid` for every other failure.

Consequence: a row can only be paid by the program id it was signed for. Before any program id change (v0 placeholder → v0.1 real ids, SCHED-8), no row may be in flight on that cluster. The deployment binding of §3.8 step 1 enforces this: a row signed for another deployment is never sent, reconciled or released automatically.

## 5. payout_id and identifiers

### 5.1 `payout_id`

| Property | Rule |
|---|---|
| Source | 32 bytes from a CSPRNG (`crypto.randomBytes(32)` in `node:crypto`), drawn by the API **at challenge time**. There is no formula and no derivation from any other id. Receipts therefore cannot be linked to withdrawal ids (PDPA), and nothing can drift between repos. |
| Never zero | If all 32 bytes are zero, redraw. The program rejects zero with error 6008, and the API must never produce it. |
| Write-once | Set when the challenge record is created and copied onto the withdrawal row at submit. No code path may `$set`/`$unset` it afterwards; a spec asserts this. The value is never reused, even when a challenge expires unused. |
| Uniqueness | Unique index on the challenge collection's payout id, and `uniq_withdraw_solana_payout_id` on `withdraws` (keys and partial filter in §6.8). Both are on the SEC-11 required-index list, so a missing index makes rail config incomplete. |
| API / DB encoding | 64 **lowercase** hex characters, `^[0-9a-f]{64}$`, stored as a string. Uppercase or mixed case is **rejected with 400**, not normalized. |
| Onchain encoding | Raw `[u8; 32]`: the claim argument and the receipt PDA seed `["receipt", vault, payout_id]` are the hex-decoded bytes in order, with no reversal. `Receipt.payout_id` decodes back to the same 64-hex string. |
| In the consent message | `- gogocash:payout:<64 lowercase hex>` (§4.2, line 14). |

### 5.2 Withdrawal id and challenge id

| Id | Format | Origin | Where it appears |
|---|---|---|---|
| `withdrawal_id` | Mongo ObjectId, 24 lowercase hex `^[0-9a-f]{24}$` | `new Types.ObjectId()` at challenge time; becomes the withdraw row `_id` at submit | Consent `Request ID`, `GET withdrawals/:id`, `active_withdrawal_id`. **Never onchain.** |
| `challenge_id` | Mongo ObjectId, 24 lowercase hex | `_id` of the challenge record | `POST withdrawals` body. Idempotency-Key = `solana-` + `challenge_id` (31 ASCII chars). |

A path or body id that is not 24 lowercase hex → 400 before any DB query.

### 5.3 Nonce

- 16 CSPRNG bytes, rendered as 32 lowercase hex `^[0-9a-f]{32}$` (128 bits).
- This meets SIWS's minimum of 8 alphanumeric characters.
- One nonce per challenge. Unique index on the challenge collection (added to the SEC-11 list).
- It is burned by the intake compare-and-set (§4.9 step 9).

### 5.4 Base58 values and the strict validator

Every Solana public key (recipient, program id, mint, vault, vault token account, receipt, ATA, roles) and every Solana signature (consent signature, transaction signatures) is base58 (Bitcoin alphabet) on the API, in fixtures and in the DB.

**Strict validator** `isStrictBase58(s, n)`, where n = 32 for addresses and n = 64 for signatures. It returns true only if all of these hold:
1. `s` is a string matching `^[1-9A-HJ-NP-Za-km-z]+$`. No whitespace, no `0 O I l`, no prefix or suffix.
2. Its length is within the encodable range: 32-44 chars for n = 32, 64-88 chars for n = 64.
3. Decoding (each leading `1` = one zero byte) yields **exactly n bytes**.
4. Re-encoding those n bytes yields a string **identical** to `s`.

Inputs are never trimmed, case-folded or otherwise normalized before validation. Self-check results (research generator; they become part of `ed25519.json`, §11):
- test key 1 and its signature pass;
- the 31-byte value, the value with `0`, the lower-cased address and the address with an extra leading `1` all fail.

One implementation lives in the SDK and is used by API and fixtures. The app only encodes (§10.5) and never validates for security.

### 5.5 Case sensitivity and collation

| Value class | Canonical form | Comparison |
|---|---|---|
| Base58 addresses and signatures | As produced by the encoder | **Always case-sensitive**, exact byte match. Mongo default (binary) collation only. No index or query on a `solana_*` field may use a case-insensitive collation (`strength` 1 or 2). |
| `payout_id`, `withdrawal_id`, `challenge_id`, nonce | Lowercase hex | Exact match; non-lowercase input rejected. |
| Atomic amounts | Decimal string, no leading zeros, no sign, no exponent: `^(0\|[1-9][0-9]{0,19})$` and `<= 2^64 − 1`. Payout amounts (`amount_atomic`, `solana_amount_atomic`) are at least 1: `^[1-9][0-9]{0,19}$`. | Parsed with `BigInt`, never `Number`. |
| Consent message | Exact bytes | Byte equality only. |

Related rules:
- Solana values are stored only in `solana_*` fields. Legacy `tx_hash` and `address` never receive base58 (SEC-8, §6).
- E11000 duplicate-key errors on `solana_*` indexes carry the key value, which may be a wallet address. They map to 409 without logging `keyValue` (SEC-11).

---

## 6. Amounts and the ledger row

This section fixes how a member's cashback balance turns into an exact USDC amount, and what the monorepo writes to its ledger for a Solana payout. The program and the SDK never see THB; they see only `amount: u64` atomic USDC. The API owns everything in this section.

### 6.1 Integer rule

- Every amount between the member's request and the onchain transfer is a `bigint`. No `number`, no float, no `Math.round`, no `toFixed` on the money path. The only exception is the `toWithdrawMinorUnits` boundary of §6.5, where values that existing code authors as 2-decimal `Number`s (the policy fee and the `checkWithdraw` balance) enter the rail.
- On the wire (JSON) and in MongoDB `solana_*` fields, a `bigint` is a **decimal string** matching `^(0|[1-9][0-9]*)$`. No sign, no exponent, no leading zeros, no separators.
- Units:

| Name | Unit | Scale |
|---|---|---|
| `*_minor` | ledger-currency minor unit (THB satang) | 1 THB = 100 |
| `*_atomic` | USDC base unit | 1 USDC = 1,000,000 (6 decimals) |
| `thb_per_usd_e8` | THB per 1 USD, times 10^8 | 33.67 THB/USD = `3367000000` |

- **Rate orientation is THB per 1 USD**, never USD per THB. A larger number means a weaker baht. USDC is treated as exactly 1 USD; v0 has no depeg handling.
- The existing ledger fields (`amount_total`, `amount_net`, `withdraw_fee_*`) are Mongoose `Number` in major units. They are written once, from the `bigint` minor value, as `Number(minor) / 100`. They are never read back to compute a payout.

### 6.2 Ledger currency

- v0 supports exactly one ledger currency: **THB** (market TH). `GET config` reports `ledger_currency: "THB"`.
- The member's ledger currency is the `fee_lane` of the member's market in the live country registry (`CountryRecord.fee_lane`, `packages/contracts/src/country-registry.ts`).
- A request whose `currency` is not `THB` is refused with `400 SOLANA_CURRENCY_UNSUPPORTED`. A member whose market's `fee_lane` is not `THB` never reaches that check: `GET config` reports `disabled` and the challenge returns `503 SOLANA_RAIL_UNAVAILABLE` (`disabled`), as in §7.1 step 1.
- The formulas below are written for a 2-decimal ledger currency. A USD ledger (rate fixed at `100000000`) or a 0-decimal currency needs a contract revision, not a config change.

### 6.3 Conversion and the dust owner (founder decision D4, open)

Inputs, all `bigint`:

- `requested_minor`: the gross amount the member asks to withdraw, in satang. Same meaning as `amount` on the bank lane: the fee comes out of it.
- `fee_minor`: from section 6.5.
- `thb_per_usd_e8`: the effective rate from the quote (section 6.6).

```
net_minor      = requested_minor - fee_minor                       (must be > 0)
usdc_atomic    = floor(net_minor * 10^12 / thb_per_usd_e8)
value_minor    = ceil(usdc_atomic * thb_per_usd_e8 / 10^12)        (THB value of what is sent; value_minor <= net_minor)
```

`10^12` is `10^6` (USDC decimals) times `10^8` (rate scale) divided by `10^2` (satang). Integer `ceil(a / b)` is `(a + b - 1) / b` for positive `a`, `b`.

**v0 default (flippable by the founder before the v0 tag): the member keeps the remainder.**

```
deducted_minor  = value_minor + fee_minor          (<= requested_minor; never over-deducts)
remainder_minor = requested_minor - deducted_minor (stays in the member's ledger balance)
```

**Alternative: the treasury keeps the dust.**

```
deducted_minor  = requested_minor
remainder_minor = 0
treasury_dust   = net_minor - value_minor          (deducted from the member, not sent)
```

The choice is recorded on every row as `solana_dust_policy` (`member_keeps_remainder` or `treasury_keeps_remainder`). Both code bases switch on that one value, so the fixtures cover both.

**Why D4 is nearly moot for THB.** `floor` loses less than one atomic unit, which is worth `thb_per_usd_e8 / 10^12` satang. For any rate below 10,000 THB per USD that is less than one satang, so `ceil` gives back `value_minor = net_minor` exactly and both policies deduct the same satang. The two policies differ only when the rate is at or above `10^12` (row 5 below). A random check of 200,000 inputs with rates below `10^12` found no case where `value_minor != net_minor`. The sub-satang difference is real money onchain (the member receives slightly less than `net_minor` is worth), but it cannot be represented in the ledger, so under both policies that fraction stays with the treasury.

**Worked examples** (ids are the amount fixture vector ids; fee and rate as given):

| # | Fixture | requested_minor | fee_minor | net_minor | thb_per_usd_e8 | usdc_atomic | value_minor | Default: deducted / remainder | Alternative: deducted / dust |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `thb_basic` | 12500 | 0 | 12500 | 3512345678 | 3558875 | 12500 | 12500 / 0 | 12500 / 0 |
| 2 | `thb_with_fee` | 15000 | 1500 | 13500 | 3398765432 | 3972030 | 13500 | 15000 / 0 | 15000 / 0 |
| 3 | (today's provider rate, 2 Oct 2026) | 10000 | 1000 | 9000 | 3367000000 | 2673002 | 9000 | 10000 / 0 | 10000 / 0 |
| 4 | `thb_exact_minimum` | 4000 | 0 | 4000 | 4000000000 | 1000000 | 4000 | 4000 / 0 | 4000 / 0 |
| 5 | `edge_rate_policies_differ` (synthetic rate) | 12600 | 100 | 12500 | 2600000000000 | 4807 | 12499 | 12599 / 1 | 12600 / 1 |

Row 3 in words: the member asks for 100.00 THB, the fee is 10.00 THB, 90.00 THB converts at 33.67 to 2.673002 USDC, and the ledger deducts 100.00 THB.

### 6.4 Bounds

Checked in this order at challenge time. Inside the submit transaction the stored `payout_amount_atomic` is re-checked against `SOLANA_WITHDRAW_MIN_PAYOUT_ATOMIC` and `SOLANA_WITHDRAW_MAX_PAYOUT_ATOMIC` only. The onchain `max_per_claim` is not re-read, because the submit makes no RPC call; a cap lowered in between surfaces at send time as 6010, giving T6 `simulation_rejected`. The first failure wins.

| Check | Refusal (`400 SOLANA_AMOUNT_OUT_OF_RANGE`, `reason`) |
|---|---|
| `amount` matches the amount grammar below and `requested_minor > 0` | `invalid_amount` |
| `fee_minor < requested_minor` | `fee_exceeds_amount` |
| `usdc_atomic < 2^64` (checked before any `u64` encode) | `exceeds_u64` |
| `usdc_atomic >= min_payout_atomic` | `below_minimum` |
| `usdc_atomic <= max_payout_atomic` | `above_maximum` |

Amount grammar (THB, at most 2 decimals, at most 10 integer digits): `^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$`.

`requested_minor` is parsed from the matched string without floats: the integer part times 100, plus the fraction right-padded with `0` to 2 digits (`"100"` → 10000, `"100.5"` → 10050, `"0.01"` → 1).

- `min_payout_atomic` = `SOLANA_WITHDRAW_MIN_PAYOUT_ATOMIC`, default `1000000` (1 USDC).
- `max_payout_atomic` = min(`SOLANA_WITHDRAW_MAX_PAYOUT_ATOMIC`, the vault's onchain `max_per_claim` read at `confirmed` during the challenge). Default rail max `5000000` (5 USDC). If the vault cannot be read, the challenge fails with `503 SOLANA_RAIL_UNAVAILABLE`, never with a guessed maximum.
- The refusal body carries `min_payout_atomic` and `max_payout_atomic` as decimal strings so the app can show the range.
- The existing `FeeRate` minimum (`resolveWithdrawFeePreview` `below_minimum`) also applies and maps to the same code and reason.
- Per-member limits (section 7.6) are separate and return `409 SOLANA_DAILY_LIMIT`.

### 6.5 Fee

- The policy fee comes from the existing `resolveWithdrawFeePreview({ feeRate, amount, availableBalance, currency: 'THB', method: 'solana_usdc', market, countries })`. The inputs are: `feeRate` = the singleton `FeeRate` document (`feeRateModel.findOne()`, as on the bank lane); `amount = Number(requested_minor) / 100`; `availableBalance = Number(checkWithdraw(userId).netAmountTHB)`; `countries` = the live registry. No `coupon`, `userRedemptionCount` or `userId` is passed. `method` affects only coupons, so with no coupon the policy fee equals the THB bank-lane base fee. GoGoPass fee benefits do not apply. There is **no MyCashback companion** row: a Solana payout draws only on the GoGoCash balance (`mycashback_id: []`).
- Failure reasons map as follows: `below_minimum` → `400 SOLANA_AMOUNT_OUT_OF_RANGE` (`below_minimum`); `negative_receive` → `400 SOLANA_AMOUNT_OUT_OF_RANGE` (`fee_exceeds_amount`); `insufficient_balance` → `400 SOLANA_INSUFFICIENT_BALANCE`. Coupon reasons are unreachable and are a bug (500).
- `final_fee` (major units) is converted once: `policy_fee_minor = BigInt(toWithdrawMinorUnits(final_fee, 'THB'))`, after asserting `Number.isSafeInteger`. `toWithdrawMinorUnits` is module-private in `apps/api/src/withdraw/resolve-withdraw-fee.ts` and is exported for this call. Its `Math.round(value * 100)` is the only permitted float-to-integer conversion on the Solana money path, an explicit exception to §6.1, because these values are authored as 2-decimal `Number`s by existing code. It is used at exactly two boundaries: this policy fee, and the `checkWithdraw` balance (`netAmountTHB`) in challenge step 9 and submit step 9.
- **Fee floor.** The rail sponsors the member's SOL costs, so the fee may not be lower than what one payout costs GoGoCash:

```
floor_minor = SOLANA_WITHDRAW_FEE_FLOOR_MINOR
            + (recipient ATA absent AND member's ATA sponsorship already used ? SOLANA_WITHDRAW_ATA_FEE_MINOR : 0)
fee_minor   = max(policy_fee_minor, floor_minor)
```

- `SOLANA_WITHDRAW_FEE_FLOOR_MINOR` must cover receipt rent plus transaction fees. At the rent observed on 2 Oct 2026, `(data_len + 128) x 5,080` lamports on both clusters, the receipt (89 B) costs 1,102,360 lamports, the base fee is 2 signatures x 5,000 = 10,000 lamports, and the priority fee is at most 90,000 CU x the price cap (section 9.1). The runtime value of rent always comes from `getMinimumBalanceForRentExemption`; the numbers here are for sizing only.
- `SOLANA_WITHDRAW_ATA_FEE_MINOR` covers one USDC token account (165 B, 1,488,440 lamports on 2 Oct 2026).
- **One sponsored ATA per member.** If the recipient's USDC ATA does not exist and the member has no row in `solana_ata_sponsorships`, the ATA is sponsored (no ATA fee) and the submit inserts the sponsorship row. If the sponsorship is already used, the ATA fee is added. Because each member can bind only one wallet (section 6.8), the second case arises only after an admin removes and re-adds the member's allowlist entry with a different wallet (section 7.3).
- v0 has no SOL/THB price feed. Both floor values are operator-set THB constants, reviewed when SOL/THB moves by more than 25%. Missing or malformed values make the rail config incomplete.
- Ledger fields: `percent_fee: 0`, `withdraw_fee_base = withdraw_fee_final = Number(fee_minor) / 100`, `withdraw_fee_discount: 0`. The policy fee and floor are kept for audit in `solana_fee_policy_minor` and `solana_fee_floor_minor`.

### 6.6 FX quote

- The existing `WithdrawService.fetchRate` (`private`) is **not** used. It serves a stale cached rate on upstream failure and returns a float. The rail adds a new function, `quoteThbPerUsdForSolana()`, in `apps/api/src/withdraw/solana/`.
- **Source:** the same provider family as the ledger, `GET https://api.exchangerate-api.com/v4/latest/USD`, field `rates.THB` (already THB per 1 USD, matching the contract orientation) and `time_last_updated` (Unix seconds).
- **Rules:**
  - **No cache fallback and no stale serve.** Each challenge fetches. Failure of any kind returns `503 SOLANA_QUOTE_UNAVAILABLE` and creates no challenge.
  - **Timeout** 5 s (`AbortController`), the same as `FX_TIMEOUT_MS`.
  - **No float arithmetic:** `fx_raw = String(rates.THB)` (the shortest round-trip decimal, equal to the provider's token, for example `"33.67"`). It must match `^[0-9]{1,6}(\.[0-9]{1,8})?$`, otherwise the quote fails. `raw_e8` is that decimal string scaled to 10^8 as a `bigint`.
  - **Effective rate:** `thb_per_usd_e8 = ceil(raw_e8 * (10000 + SOLANA_WITHDRAW_FX_SPREAD_BPS) / 10000)`. The spread defaults to `0`. Rounding up means the treasury never sends more USDC than the raw rate implies.
  - **Bounded age:** `as_of = time_last_updated`; refuse if `now - as_of > SOLANA_WITHDRAW_FX_MAX_AGE_SECONDS` (default `93600`, 26 h, because this provider publishes once per UTC day), or if `as_of` is more than 300 s in the future.
  - **Sanity band:** refuse unless `SOLANA_WITHDRAW_FX_MIN_E8 <= thb_per_usd_e8 <= SOLANA_WITHDRAW_FX_MAX_E8` (defaults `2500000000` and `4500000000`).
- **Stored on both the challenge and the row:** `fx_source` (`"exchangerate-api.com/v4/latest/USD"`), `fx_raw`, `fx_thb_per_usd_e8` (effective), `fx_spread_bps`, `fx_as_of`, `fx_fetched_at`.
- The quote is locked at the challenge for its TTL (300 s devnet, 180 s mainnet). The submit **does not refetch FX**: no network call is added inside the serialized transaction.
- Two independent sources, at most 1 h old, is a P2 requirement and is out of v0.

### 6.7 The ledger row (`withdraws`)

A Solana payout is one `withdraws` document, created **through the Mongoose model** (`this.withdrawModel.create([...], { session })`) inside `runSerializedWithdrawForRail`, never by a raw driver insert. Its `_id` is the `withdrawal_id` pre-allocated at the challenge.

**Existing fields (binding, from review SEC-1, GRAPH-2 and SEC-8):**

| Field | Value | Why |
|---|---|---|
| `mycashback_id` | `[]`, set explicitly | `checkWithdraw` deducts only rows matching the literal `{mycashback_id: []}`; a missing field is not deducted, which would let the same THB be withdrawn again by bank. |
| `currency` | the ledger currency, `"THB"` | `checkWithdraw` sums `amount_total` per row currency. `USDC` would be bucketed as USD and re-priced at the current rate. |
| `amount_total` | `Number(deducted_minor) / 100` | THB deducted, **including the fee**. Never atomic USDC. |
| `amount_net` | `Number(deducted_minor - fee_minor) / 100` | THB value the member receives, as on the other lanes. |
| `status` | `"pending"` at creation | Reserved. See section 8.3 for the mapping. |
| `method` | `"solana_usdc"` | |
| `withdraw_mode` | `"solana_claim"` | Not `auto` (bank default) and not `manual` (collides with the one-pending-manual unique index and invites mark-paid). The enum becomes `['auto', 'manual', 'solana_claim']`, edited **in place on its existing single line** so no later line number moves. |
| `user_id`, `market` | as on other lanes (`market` denormalised from the user) | |
| `conversion_id` | `[]` | required field |
| `address`, `tx_hash`, `tx_hash_record`, `account_number`, `bank_name` | `""` | **Never base58.** `tx_hash` is lowercased with a case-insensitive unique index; some writers lowercase `address`. |
| `account_name` | the member's username | as the manual lane |
| `rate` | `0` | FX lives in `solana_fx_*`; no float rate on this row. |
| `percent_fee`, `withdraw_fee_*` | section 6.5 | |
| `idempotency_key` | `"solana-<challenge_id>"` | Reuses `uniq_withdraw_user_idempotency_key` as a second backstop. |
| `idempotency_effect_hash` | section 7.4 (64 lowercase hex) | The field lowercases; the value is already lowercase hex. |
| `chain`, `coupon_*`, `gogopass_*`, `authorization_*`, `chain_record_*`, `parent_withdraw_id` | not set | |

**New `solana_*` fields**, appended **at the end** of the `Withdraw` class (after `coupon_code`), because `MONEY_FIELD_INVENTORY` pins earlier line numbers. None has `lowercase`, `uppercase` or `trim`. All are optional at the schema level; the rail's own validation makes them required for `method: 'solana_usdc'`.

| Field | Mongoose type | Content |
|---|---|---|
| `solana_cluster` | String, enum `devnet`, `mainnet` | |
| `solana_genesis_hash` | String | base58 |
| `solana_program_id` | String | base58 |
| `solana_mint` | String | base58 |
| `solana_vault` | String | base58 vault PDA |
| `solana_vault_token_account` | String | base58 |
| `solana_recipient` | String | base58 wallet (case-sensitive) |
| `solana_recipient_token_account` | String | base58 canonical ATA |
| `solana_receipt_address` | String | base58 `findReceiptPda(vault, payout_id)`, written at creation |
| `solana_payout_id` | String, `match: /^[0-9a-f]{64}$/` | 32 random bytes, lowercase hex, write-once |
| `solana_amount_atomic` | String, `match: /^[1-9][0-9]{0,19}$/` | u64 decimal; also checked `< 2^64` |
| `solana_requested_minor`, `solana_fee_minor`, `solana_fee_policy_minor`, `solana_fee_floor_minor`, `solana_net_minor`, `solana_value_minor`, `solana_deducted_minor`, `solana_remainder_minor` | String (decimal) | section 6.3 to 6.5 |
| `solana_dust_policy` | String, enum `member_keeps_remainder`, `treasury_keeps_remainder` | |
| `solana_fx_source`, `solana_fx_raw`, `solana_fx_thb_per_usd_e8` | String | section 6.6 |
| `solana_fx_spread_bps` | Number (integer, 0 to 10000) | |
| `solana_fx_as_of`, `solana_fx_fetched_at` | Date | |
| `solana_challenge_id` | String (24 hex) | |
| `solana_consent_message` | Buffer (BSON binary) | the exact message bytes (§4.8); the durable consent evidence after the challenge is purged |
| `solana_consent_signature` | String | strict base58 of the 64-byte Ed25519 signature |
| `solana_consent_nonce` | String | 32 lowercase hex (§5.3) |
| `solana_consent_domain`, `solana_consent_uri` | String | the SIWS domain and URI the message was rendered with, so a later config change cannot break the send-time re-render |
| `solana_consent_issued_at_ms`, `solana_consent_expiration_ms` | Number (integer epoch ms) | render inputs, copied from the challenge (§4.5) |
| `solana_consented_at` | Date | server time of the verified submit |
| `solana_ata_sponsored` | Boolean | |
| `solana_claim_state` | String, enum `reserved`, `sending`, `submitted`, `finalized`, `needs_review`, `released` | section 8 |
| `solana_slot_active` | Boolean | `true` while non-terminal; **unset** (not `false`) when terminal |
| `solana_lease_owner` | String | sender instance id |
| `solana_lease_until` | Date | |
| `solana_next_attempt_at` | Date | |
| `solana_hold_reason` | String | e.g. `program_paused`, `day_cap`, `vault_low`, `fee_payer_low`, `settlements_paused`, `rpc_error`, `config_mismatch` |
| `solana_review_reason` | String | e.g. `receipt_mismatch`, `attempts_exhausted`, `consent_invalid`, `account_blocked`, `allowlist_removed`, `inconsistent_rpc`, `simulation_rejected`, `deployment_mismatch` |
| `solana_attempts` | Array of subdocuments (`_id: false`) | see below |
| `solana_attempt_limit` | Number, default `5` | attempts allowed; an admin retry adds 5 |
| `solana_sim_retries` | Number, default `0` | consecutive unsigned simulations classified `retry`; reset to 0 by T4 and T14. When it reaches 5, the sender applies T6 `simulation_rejected` instead of T3. |
| `solana_signature` | String | base58 signature of the attempt that created the receipt |
| `solana_landed_slot` | String (u64 decimal) | |
| `solana_finalized_at` | Date | |
| `solana_landed_by_foreign_tx` | Boolean | receipt created by a transaction that is not one of our attempts |
| `solana_receipt_seen_at` | Date | set by T5 when the sender saw the receipt at `confirmed` (or `already_claimed` in simulation) before pushing an attempt; starts the 60 s finalization grace of §9.2 |
| `solana_release_proof` | Subdocument | section 9.5 |
| `solana_released_at` | Date | |

`solana_attempts[]` element:

| Field | Type | Content |
|---|---|---|
| `n` | Number (>= 1) | attempt number, strictly increasing |
| `signature` | String | base58, first signature of the wire (fee payer) |
| `blockhash` | String | base58 |
| `last_valid_block_height` | String (u64 decimal) | from the same `getLatestBlockhash` response |
| `expires_at` | Number (i64 Unix seconds, safe integer) | the `claim` argument |
| `wire_base64` | String | the fully signed wire transaction |
| `created_at` | Date | persisted before broadcast |
| `broadcast_at` | Date or null | |
| `outcome` | String, enum `persisted`, `broadcast`, `send_unknown`, `preflight_rejected`, `dead`, `landed`, `failed` | |
| `error_code` | Number or null | program or Anchor error number |
| `error_name` | String or null | |

Also:

- Add `solana_amount_atomic` to `MONEY_FIELD_INVENTORY` in `apps/api/scripts/audit-money-precision.ts` with `assetScale: ONCHAIN`, like `authorization_amount_atomic`. The `*_minor` strings are also money (THB scale 2) and are added with the THB scale. FX fields stay out, as the inventory's own rule says for ratios.
- The five new collections and the new fields must be registered in the migration data contract (the Mongo to Postgres program's schema sweep; the database vendor became PlanetScale Postgres on 2 Oct 2026) in the same PR.

### 6.8 Indexes and collections

**Required unique indexes on `withdraws`** (binary collation: `collation: { locale: 'simple' }`):

| Name | Keys | Partial filter |
|---|---|---|
| `uniq_withdraw_solana_payout_id` | `{solana_payout_id: 1}` | `solana_payout_id: {$exists: true, $type: 'string', $gt: ''}` |
| `uniq_withdraw_solana_signature` | `{solana_signature: 1}` | `solana_signature: {$exists: true, $type: 'string', $gt: ''}` |
| `uniq_withdraw_solana_attempt_signature` | `{'solana_attempts.signature': 1}` (multikey) | `'solana_attempts.signature': {$exists: true}` |
| `uniq_withdraw_solana_active_slot_per_user` | `{user_id: 1, solana_slot_active: 1}` | `solana_slot_active: true` |

A unique multikey index does not stop a duplicate inside one document's array. The sender's attempt CAS (section 9.1) prevents that.

**Non-unique:** `{solana_recipient: 1}` (partial on `$type: 'string'`) and `{solana_claim_state: 1, solana_next_attempt_at: 1}`. `withdraw.schema.spec.ts` changes its unique-index count from 6 to 10. `autoIndex` stays on.

**New collections:**

| Collection | Document | Required indexes |
|---|---|---|
| `solana_withdraw_challenges` | `_id` (= `challenge_id`), `user_id`, `withdrawal_id`, `payout_id`, `cluster`, `genesis_hash`, `program_id`, `usdc_mint`, `vault`, `vault_token_account`, `recipient`, `recipient_token_account`, `ata_sponsored`, all `*_minor` and `payout_amount_atomic` strings, `dust_policy`, FX fields, `message` (BSON binary, exact bytes), every other render input of §4.8, `nonce`, `issued_at_ms`, `expiration_ms` (integer epoch ms), `state` (`issued`, `consumed`), `consumed_at`, `purge_at` | unique `payout_id`; unique `nonce`; `{user_id: 1, state: 1}`; TTL `{purge_at: 1}` with `expireAfterSeconds: 0`, `purge_at = issued_at_ms + 24 h` |
| `solana_wallet_bindings` | `recipient`, `user_id`, `cluster`, `source` (`consent` on devnet, `pinned` on mainnet), `bound_at`, `first_withdrawal_id` | unique `recipient` (binary collation); unique `user_id` |
| `solana_ata_sponsorships` | `user_id`, `recipient`, `recipient_token_account`, `withdrawal_id`, `created_at` | unique `user_id` |
| `solana_allowlist` | `user_id`, `wallet` (required on mainnet, absent on devnet), `added_by`, `added_at`, `reason` | unique `user_id` |
| `solana_rail_state` | `_id: 'halt'` (latch: `halted`, `reason`, `at`, `set_by`, `causes` (array of `{key, reason, at, evidence, set_by}`, §7.8), `version`, `cleared_by`, `cleared_at`, `clear_reason`, `last_cleared_causes`); `_id: 'deployment_identity'` (`cluster`, `genesis_hash`, `program_id`, `vault`, `written_by`, `written_at`); `_id: 'watcher'` (`vault`, `baseline_claim_count`, `baseline_total_claimed`, `baseline_at`, `checkpoint`, `expected_vault_config` (`admin`, `guardian`, `claim_authority`, `max_per_claim`, `max_per_day`; §9.3), and the last observation written every tick: `observed_at`, `observed_slot`, `paused`, `admin`, `guardian`, `claim_authority`, `max_per_claim`, `max_per_day`, `current_day`, `claimed_today`, `claim_count`, `total_claimed`, `vault_token_balance_atomic`, `fee_payer_lamports`; u64 values as decimal strings) | `_id` only |

**Config completeness (SEC-11).** At boot and every 60 s, the rail runs `listIndexes` on `withdraws` and on each `solana_*` collection. Unless every required unique index above exists with the stated keys, uniqueness and partial filter, the rail config is **incomplete**: intake returns `503 SOLANA_RAIL_UNAVAILABLE`, the sender holds, and no release proof is issued.

**E11000 handling.** A duplicate-key error is mapped by index name, never by message text, and its `keyValue` (which may be a wallet address) is never logged. `solana_wallet_bindings.recipient` maps to `409 SOLANA_RECIPIENT_IN_USE`; `uniq_withdraw_solana_active_slot_per_user` maps to `409 SOLANA_ACTIVE_CLAIM`; `solana_wallet_bindings.user_id` maps to `409 SOLANA_RECIPIENT_NOT_ALLOWED`; `solana_ata_sponsorships.user_id` maps to `409 SOLANA_QUOTE_CHANGED`; any other maps to `409 SOLANA_CONFLICT`.

## 7. API

All routes live in a new module `apps/api/src/withdraw/solana/`. JSON conventions for every route in this section:

- `bigint` values are decimal strings (section 6.1).
- Solana addresses, the program id, mints, transaction signatures **and the consent signature** are **base58 strings**, compared case-sensitively and validated with the strict validator of §5.4 (32 bytes for keys, 64 for signatures; the string must re-encode identically).
- `payout_id` is 64 lowercase hex characters.
- Message bytes are **standard base64 with padding** (`message` in the challenge response, `signed_message` in the submit).
- Ids (`challenge_id`, `withdrawal_id`) are 24-character lowercase hex MongoDB ObjectIds (§5.2). An id in a path or body that is not `^[0-9a-f]{24}$` is `400 SOLANA_INVALID_ID` before any DB query.
- Times are `Date.prototype.toISOString()` strings (UTC, milliseconds, `Z`), as in §4.5.
- Request bodies use a DTO allowlist (`whitelist` plus `forbidNonWhitelisted`): an unknown field is `400`.
- Every coded error body has the shape `{ "statusCode": <int>, "code": "<CODE>", "message": "<English text>", ...extra }`; the filter also adds `timestamp` and `path`, which clients ignore. The app branches on `code`, never on `message`.
- The API's global `SanitisedExceptionFilter` (`apps/api/src/common/sanitised-exception.filter.ts`, registered in `main.ts`) rebuilds every error body. It drops any `code` not in `ALLOWED_ERROR_CODES` and every extra field it does not pass explicitly. The rail therefore adds the following in the same PR as the routes. (a) A `SOLANA_WITHDRAW_ERROR_CODES` set, exported from `packages/contracts/src/solana-payout.ts` and spread into `ALLOWED_ERROR_CODES`, containing every code in §7.2 and §7.3 plus `IDEMPOTENCY_KEY_EFFECT_MISMATCH`. (b) A per-code extras passthrough that copies only these fields, each validated first: `reason` (one of the closed reason strings of §6.4 and §7.2); `min_payout_atomic` and `max_payout_atomic` (`^(0|[1-9][0-9]{0,19})$`); `active_withdrawal_id` and `withdrawal_id` (`^[0-9a-f]{24}$`); `unavailable_reason` (`disabled`, `paused`, `maintenance`); `claim_state` (a §8.1 state); `failed_conditions` (an array of the §7.3 names). An extra that fails validation is dropped, never passed raw. A filter spec asserts one round trip per §7.2 and §7.3 row. Code-less bodies `{statusCode, message}` occur only for the rows of §7.2 whose code is "none" or is stripped by the filter today.

### 7.1 Member routes

| Route | Guards, in order | Rate limit (`@RateLimit`) |
|---|---|---|
| `GET /withdraw/solana/config` | `FirebaseAuthGuard`, `TermsAcceptanceGuard`, `RateLimitGuard` | 30/min per member, 120/min per client |
| `POST /withdraw/solana/challenge` | `FirebaseAuthGuard`, `TermsAcceptanceGuard`, `RateLimitGuard` | 10/min per member, 40/min per client |
| `POST /withdraw/solana/withdrawals` | `FirebaseAuthGuard`, `TermsAcceptanceGuard`, `RateLimitGuard`, `PlayIntegrityGuard` (**last**) with `@PlayIntegrityAction('withdraw.solana_submit', { tokenOptional: true })` | 5/min per member, 20/min per client |
| `GET /withdraw/solana/withdrawals/:id` | `FirebaseAuthGuard`, `TermsAcceptanceGuard`, `RateLimitGuard` | 60/min per member, 240/min per client |

- Rate limits use `authenticatedPrincipal: { maxPerClient }` and a `key` of the form `withdraw:solana:<route>`.
- There is no separate cap on outstanding unconsumed challenges: the challenge rate limit bounds them, and an unconsumed challenge reserves nothing (D-X8).
- `withdraw.solana_submit` is appended to `PLAY_INTEGRITY_ACTIONS` (and its app mirror). `tokenOptional` is required because a dApp Store build can never be Play-recognised. A token that **is** presented is still verified, so dApp Store builds send none. `require` mode stays available to the bank and payout-method routes.

#### `GET /withdraw/solana/config`

Response `200`:

```json
{
  "enabled": true,
  "unavailable_reason": null,
  "cluster": "devnet",
  "program_id": "HWNF2cvXybfAjLbw2pydi7sNFmTfYBjpEWNtY3BJfCje",
  "usdc_mint": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  "siws_domain": "app-staging.gogocash.co",
  "siws_uri": "https://app-staging.gogocash.co",
  "ledger_currency": "THB",
  "min_payout_atomic": "1000000",
  "max_payout_atomic": "5000000",
  "active_withdrawal_id": null
}
```

The example shows the response shape. Under v0 the placeholder program id fails the executable check (§7.7), so a real v0 deployment always returns `enabled: false` with `unavailable_reason: "maintenance"`.

- `unavailable_reason` is `null` when `enabled` is `true`, otherwise one of:

| Value | Meaning to the member | Internal causes (logged, never returned) |
|---|---|---|
| `disabled` | Solana withdrawals are not offered to this account | `SOLANA_WITHDRAW_ENABLED` not `'true'`; member not on the allowlist; market or currency not supported; environment attestation blocked |
| `paused` | temporarily paused | a request brake; the global withdrawal switches; the market valve; the halt latch (or unreadable latch); the program's `paused` flag |
| `maintenance` | temporarily unavailable, retry later | config incomplete (env, indexes, pins, deployment marker); genesis mismatch; RPC unreachable; sender heartbeat stale; vault or fee payer below threshold |

- When the member is **not on the allowlist**, or the reason is `disabled`, every field except `enabled`, `unavailable_reason`, `ledger_currency` and `active_withdrawal_id` is `null`. This hides the rail's existence and closes the `SOLANA_RECIPIENT_IN_USE` membership oracle (review SEC-12).
- `active_withdrawal_id` is the member's row with `solana_slot_active: true`, if any. It is returned even when the rail is paused, so the app can resume polling.
- `max_payout_atomic` is the rail maximum already capped by the onchain `max_per_claim`.
- `GET config` makes **no RPC call**. Program state (`paused`, caps, balances) comes from the watcher's last observation, and the route reports `maintenance` if `observed_at` in that document is absent or older than 300 s. The challenge re-reads the chain.

#### `POST /withdraw/solana/challenge`

Request:

```json
{ "amount": "100.00", "currency": "THB", "recipient": "HupSGTuM8ra7TEsYhF4M2NuDt3iEPQVJv3WGnrtDg9D4" }
```

`amount` is the gross THB amount as a decimal string (section 6.4 grammar). `currency` must equal `ledger_currency`.

Checks, in this order (the first failure returns):

1. **Membership gates**, evaluated first so a non-member can never observe rail state (SEC-12): `SOLANA_WITHDRAW_ENABLED === 'true'`; the member is on the allowlist (7.6); the member's market has `fee_lane: 'THB'` in the live country registry (§6.2); `assertPayoutRailAllowedForMarket(market, 'crypto', await payoutRailCountries())`; environment attestation (7.7). Any failure: `503 SOLANA_RAIL_UNAVAILABLE` with `unavailable_reason: "disabled"`, identical to a rail that is off.
2. **Rail gates:** `SOLANA_WITHDRAW_REQUESTS_ENABLED !== 'false'`, `assertWithdrawalRequestsEnabledForMarket` (master, request switch, market valve) and the halt latch clear and readable (7.8); a failure is `503 SOLANA_RAIL_UNAVAILABLE` with `paused`. Config completeness (6.8, 7.7); a failure is `503 SOLANA_RAIL_UNAVAILABLE` with `maintenance`. The existing assert helpers throw code-less exceptions, so the rail calls them inside a wrapper that catches the exception and rethrows the coded 503; their bodies never reach the client. When several causes apply, the reported reason is the first in the order `disabled`, `paused`, `maintenance`; `GET config` uses the same precedence.
3. **Body:** `currency !== 'THB'`: `400 SOLANA_CURRENCY_UNSUPPORTED`; amount grammar: `400 SOLANA_AMOUNT_OUT_OF_RANGE` (`invalid_amount`); `recipient` not strict base58: `400 SOLANA_RECIPIENT_INVALID`.
4. **Active slot:** an existing row with `solana_slot_active: true` returns `409 SOLANA_ACTIVE_CLAIM` with `active_withdrawal_id`.
5. **Program and rail state** (RPC at `confirmed`, genesis checked): vault decodes; not paused; `claim_authority`, `mint` and `vault_token_account` equal the config; ProgramData pins match; vault token balance at least the payout; the `solana_sender` heartbeat is fresh (9.6). Failure: `503 SOLANA_RAIL_UNAVAILABLE` (`paused` or `maintenance`).
6. **Recipient:**
   - not one of the 8 small-order encodings, and not the program id, vault, vault token account, mint, claim authority, fee payer, System program, Token program or Associated Token program: `400 SOLANA_RECIPIENT_INVALID`;
   - the account is absent or owned by the System program: otherwise `400 SOLANA_RECIPIENT_INVALID`;
   - wallet binding (6.8) held by another account: `409 SOLANA_RECIPIENT_IN_USE`; this account is bound or pinned to a different wallet: `409 SOLANA_RECIPIENT_NOT_ALLOWED`;
   - the canonical USDC ATA either exists (owner Token program, mint USDC, owner = recipient, state not frozen) or is absent. A frozen or foreign-owned ATA: `400 SOLANA_RECIPIENT_INVALID`.
7. **Quote** (6.6): `503 SOLANA_QUOTE_UNAVAILABLE` on any FX failure.
8. **Amounts** (6.3 to 6.5): `400 SOLANA_AMOUNT_OUT_OF_RANGE`.
9. **Balance preview** with `checkWithdraw`: `deducted_minor` above the available THB returns `400 SOLANA_INSUFFICIENT_BALANCE`. This is advisory; the authoritative balance check runs inside the submit transaction.
10. **Per-member daily limits** (7.6): `409 SOLANA_DAILY_LIMIT`.
11. **Create:** `challenge_id` and `withdrawal_id` are new ObjectIds; `payout_id` is 32 bytes from `crypto.randomBytes` (redrawn if all zero); `nonce` is 16 random bytes as 32 lowercase hex; the message is rendered by the vendored `siws.ts` (§4) with Expiration Time = Issued At + 300 s on devnet, + 180 s on mainnet (§4.4). The challenge document is inserted with `state: 'issued'`, the exact message bytes and every render input (§4.8).

Response `201`:

```json
{
  "challenge_id": "bc01b9050c0f77c14430cea2",
  "withdrawal_id": "cddbbad6db231771bc0060be",
  "payout_id": "c6a87a9e170995438a78874587cb95773a9fa752c5b1633c9e7ae23928c88021",
  "cluster": "devnet",
  "program_id": "HWNF2cvXybfAjLbw2pydi7sNFmTfYBjpEWNtY3BJfCje",
  "usdc_mint": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  "recipient": "HupSGTuM8ra7TEsYhF4M2NuDt3iEPQVJv3WGnrtDg9D4",
  "recipient_token_account": "8ozizdVK9uxjW7HSYXVyquw3Yn2BfNLkPTPLByfieR62",
  "ata_sponsored": true,
  "quote": {
    "ledger_currency": "THB",
    "requested_minor": "10000",
    "fee_minor": "1000",
    "net_minor": "9000",
    "value_minor": "9000",
    "deducted_minor": "10000",
    "remainder_minor": "0",
    "dust_policy": "member_keeps_remainder",
    "payout_amount_atomic": "2673002",
    "fx": {
      "source": "exchangerate-api.com/v4/latest/USD",
      "raw": "33.67",
      "thb_per_usd_e8": "3367000000",
      "spread_bps": 0,
      "as_of": "2026-10-02T00:00:01.000Z"
    }
  },
  "message": "<standard base64 of the exact consent message bytes>",
  "ttl_seconds": 300,
  "issued_at": "2026-10-02T06:20:00.000Z",
  "expiration_time": "2026-10-02T06:25:00.000Z"
}
```

- `message` is authoritative. The app passes exactly these decoded bytes to MWA `signMessages` and never re-renders or re-encodes the text (§10.3). `ttl_seconds` drives the app's local sign-by deadline. `issued_at` and `expiration_time` are the same instants as consent lines 10 and 11; the server window uses only the stored `issued_at_ms` and `expiration_ms` (§4.5).
- A challenge is single-use. An abandoned challenge simply expires; it reserves nothing.
- The pre-allocated `withdrawal_id` lets the app poll `GET /withdraw/solana/withdrawals/:id` after a lost submit response. That route returns `404` until the submit has committed.

#### `POST /withdraw/solana/withdrawals`

Headers: `Idempotency-Key: solana-<challenge_id>` (required).

Request:

```json
{
  "challenge_id": "bc01b9050c0f77c14430cea2",
  "address": "HupSGTuM8ra7TEsYhF4M2NuDt3iEPQVJv3WGnrtDg9D4",
  "signed_message": "",
  "signature": "<strict base58 of the 64-byte Ed25519 signature>"
}
```

Wallet return shapes (review SEC-6, binding):

- MWA `signMessages` may return `message || signature` or the signature alone. The app always sends `signature` = **the last 64 bytes** of the returned payload, base58-encoded (§4.8, §10.3).
- `signed_message` is either `""` or the base64 of bytes that **byte-equal** the challenge's stored message. Anything else is `400 SOLANA_SIGNED_MESSAGE_MISMATCH`.
- The server verifies the Ed25519 signature over **its own stored message bytes** only. It never parses an amount, recipient, payout id or any other field out of client-supplied text.

Processing order (the same order as §4.9):

1. **Replay lookup first** (7.4), keyed by the header. The header must be present and match `^solana-[0-9a-f]{24}$`, otherwise `400 SOLANA_IDEMPOTENCY_KEY_INVALID`. A hit returns the existing row and stops here. No gate, signature or clock check runs on a replay.
2. Body shape (DTO allowlist, strict base58 `address` and `signature`, base64 or empty `signed_message`) and `header === "solana-" + body.challenge_id`: otherwise `400`: `SOLANA_INVALID_ID` for a malformed `challenge_id`, `SOLANA_IDEMPOTENCY_KEY_INVALID` for a header mismatch, `SOLANA_ADDRESS_MISMATCH` for a non-strict-base58 `address`, `SOLANA_SIGNATURE_INVALID` for a non-strict-base58 `signature`, `SOLANA_SIGNED_MESSAGE_MISMATCH` for a `signed_message` that is not standard padded base64 (checked in the service, not the DTO); any other shape error is the code-less `ValidationPipe` 400.
3. Load the challenge by `_id` **and** `user_id`. Missing, purged or another user's: `404 SOLANA_CHALLENGE_NOT_FOUND`, the same response in all three cases. `state: 'consumed'` with no row under this key: `409 SOLANA_CHALLENGE_CONSUMED`.
4. `address` equals the challenge `recipient` exactly: otherwise `400 SOLANA_ADDRESS_MISMATCH`.
5. `signed_message` rule above: otherwise `400 SOLANA_SIGNED_MESSAGE_MISMATCH`.
6. `verifyConsentSignature(recipient, stored bytes, signature)` (§4.7: length, small-order `A`, non-canonical `A` and `R`, `S >= L`, then `node:crypto`): otherwise `400 SOLANA_SIGNATURE_INVALID`.
7. **Time window** (§4.5): `issued_at_ms - 5000 <= now_ms <= expiration_ms` on the server clock read once per request, otherwise `410 SOLANA_CHALLENGE_EXPIRED`.
8. Gates of challenge steps 1 and 2 again (membership, brakes, environment, config, latch), with the same reason precedence: `503 SOLANA_RAIL_UNAVAILABLE`. The challenge's `cluster`, `program_id`, mint and vault must equal the running config, otherwise `410 SOLANA_CHALLENGE_EXPIRED`. No RPC call is made at submit.
9. Inside `runSerializedWithdrawForRail(userId, work)`, a thin public wrapper over the private `runSerializedWithdraw` (one Mongo transaction; a sweep spec limits its callers to `withdraw/solana/`):
   1. **Burn the challenge:** `findOneAndUpdate({_id, user_id, state: 'issued', expiration_ms: {$gte: now_ms}}, {$set: {state: 'consumed', consumed_at: now, withdrawal_id}})`. The nonce is single-use because the challenge is. If the CAS is lost, repeat the replay lookup once; a row found there replays (step 1), otherwise `409 SOLANA_CHALLENGE_CONSUMED` (or `410` if expired).
   2. **Allowlist:** re-read the member's `solana_allowlist` entry with the session. If it is absent: `503 SOLANA_RAIL_UNAVAILABLE` (`disabled`). On mainnet, `entry.wallet` must equal the challenge recipient, else `409 SOLANA_RECIPIENT_NOT_ALLOWED`.
   3. **Wallet binding:** insert `{recipient, user_id}`, or confirm an existing binding equals this pair. Another user: `409 SOLANA_RECIPIENT_IN_USE`. On mainnet the binding must also equal the allowlist pin.
   4. **Active slot:** none for this user, else `409 SOLANA_ACTIVE_CLAIM` (the unique index backs this).
   5. **Per-member daily count and amount** (7.6): `409 SOLANA_DAILY_LIMIT`.
   6. **Bounds:** the re-check of §6.4 on the stored quote: `400 SOLANA_AMOUNT_OUT_OF_RANGE`.
   7. **Balance:** `checkWithdraw(userId)`; `deducted_minor` above the available THB (`toWithdrawMinorUnits(netAmountTHB, 'THB')`, §6.5): `400 SOLANA_INSUFFICIENT_BALANCE`.
   8. **Fee re-check:** recompute `fee_minor` from the current `FeeRate` and sponsorship state with the stored quote. A different value: `409 SOLANA_QUOTE_CHANGED` (the member starts a new challenge).
   9. **Sponsorship:** if `ata_sponsored`, insert the `solana_ata_sponsorships` row (duplicate: `409 SOLANA_QUOTE_CHANGED`).
   10. **Insert** the row (6.7) with `_id = withdrawal_id`, `status: 'pending'`, `solana_claim_state: 'reserved'`, `solana_slot_active: true`, `solana_next_attempt_at: now`.
   11. `adminActivity.appendRequired` with action `withdraw.solana_requested`, actor type `customer`.
10. **Post-commit only:** telemetry (`captureWithdrawRequested` with `withdrawMethod: 'solana_usdc'`, no address), the ops alert, the member notification, and an in-process sender kick if this process is the CRON owner.

Response `201` (new) or `200` (replay): the status object of `GET /withdraw/solana/withdrawals/:id`, plus `"reused": false | true`.

#### `GET /withdraw/solana/withdrawals/:id`

IDOR-safe: the lookup is `{_id: id, user_id: req.user.sub, method: 'solana_usdc'}`. A malformed id is `400 SOLANA_INVALID_ID` (§5.2); anything else not found, including another member's row, is `404 SOLANA_WITHDRAWAL_NOT_FOUND`.

Response `200`:

```json
{
  "withdrawal_id": "cddbbad6db231771bc0060be",
  "status": "pending",
  "claim_state": "submitted",
  "display_state": "processing",
  "cluster": "devnet",
  "recipient": "HupSGTuM8ra7TEsYhF4M2NuDt3iEPQVJv3WGnrtDg9D4",
  "payout_amount_atomic": "2673002",
  "ledger_currency": "THB",
  "deducted_minor": "10000",
  "fee_minor": "1000",
  "receipt_address": null,
  "signature": null,
  "explorer_url": null,
  "created_at": "2026-10-02T06:21:10.000Z",
  "finalized_at": null,
  "next_poll_ms": 3000
}
```

- The submit response adds `"reused": true | false` to this object; `GET` never includes it.
- `receipt_address`, `signature` and `explorer_url` are `null` until `claim_state` is `finalized`. When the row is finalized, `receipt_address` is always set. `signature` is `solana_signature`, or `null` when `solana_landed_by_foreign_tx` is true. `explorer_url` is `https://explorer.solana.com/tx/<signature>` when `signature` is set, otherwise `https://explorer.solana.com/address/<receipt_address>`; on devnet both forms append `?cluster=devnet`.
- `next_poll_ms`: `5000` for `reserved` and `sending`, `3000` for `submitted`, `60000` for `needs_review`, `null` for terminal states.
- No hold or review reason is returned to the member.

### 7.2 Error codes

| HTTP | `code` | Extra fields | Retry guidance for the app |
|---|---|---|---|
| 400 | `SOLANA_CURRENCY_UNSUPPORTED` | | no |
| 400 | `SOLANA_AMOUNT_OUT_OF_RANGE` | `reason`, `min_payout_atomic`, `max_payout_atomic` | after the member edits the amount |
| 400 | `SOLANA_INSUFFICIENT_BALANCE` | | no |
| 400 | `SOLANA_RECIPIENT_INVALID` | | after the member picks another wallet |
| 400 | `SOLANA_IDEMPOTENCY_KEY_INVALID` | | bug; report |
| 400 | `SOLANA_INVALID_ID` | | bug; report |
| 400 | `SOLANA_ADDRESS_MISMATCH` | `reason: "consent_address_mismatch"` | new challenge |
| 400 | `SOLANA_SIGNED_MESSAGE_MISMATCH` | `reason: "consent_message_mismatch"` | bug; report |
| 400 | `SOLANA_SIGNATURE_INVALID` | `reason: "consent_signature_invalid"` | new challenge |
| 404 | `SOLANA_CHALLENGE_NOT_FOUND` | | new challenge |
| 404 | `SOLANA_WITHDRAWAL_NOT_FOUND` | | keep polling only within the challenge TTL plus 60 s |
| 409 | `SOLANA_ACTIVE_CLAIM` | `active_withdrawal_id` | show and poll that withdrawal |
| 409 | `SOLANA_RECIPIENT_IN_USE` | | no |
| 409 | `SOLANA_RECIPIENT_NOT_ALLOWED` | | no |
| 409 | `SOLANA_DAILY_LIMIT` | | tomorrow (UTC) |
| 409 | `SOLANA_QUOTE_CHANGED` | | new challenge |
| 409 | `SOLANA_CHALLENGE_CONSUMED` | `reason: "consent_already_used"` | poll the pre-allocated `withdrawal_id` |
| 409 | `IDEMPOTENCY_KEY_EFFECT_MISMATCH` | | bug; report (existing code constant reused) |
| 409 | `SOLANA_CONFLICT` | | retry once |
| 410 | `SOLANA_CHALLENGE_EXPIRED` | `reason: "consent_expired"` | new challenge (new wallet prompt) |
| 503 | `SOLANA_RAIL_UNAVAILABLE` | `unavailable_reason` | re-read config after 30 s |
| 503 | `SOLANA_QUOTE_UNAVAILABLE` | | retry after 10 s |
| 503 | `SOLANA_OUTCOME_UNKNOWN` | `withdrawal_id` | poll that withdrawal; **the balance stays reserved** |
| 503 | `SOLANA_RELEASE_NOT_PROVABLE` | `failed_conditions` | admin only; the balance stays reserved |
| 400 | none (global `ValidationPipe`: unknown, missing or mistyped field) | | bug; report. The app treats a code-less 400 from these routes as a bug. |
| 401 | none (`FirebaseAuthGuard`) | | the existing session refresh or sign-in flow |
| 403 | `SOLANA_WALLET_FROZEN` | | no; support copy. The rail catches `WithdrawBlockedError` with `blockCause === 'wallet_frozen'` from `runSerializedWithdraw`, whose body carries no code, and rethrows this code. |
| 403 | `PLAY_INTEGRITY_FAILED` (may carry `remediation`), `PLAY_INTEGRITY_REQUIRED` | | existing Play Integrity handling; submit only |
| 428 | `TERMS_REACCEPTANCE_REQUIRED` (the filter strips the code today; the app branches on status 428) | | existing terms re-acceptance flow |
| 429 | `RATE_LIMITED` with `retry_after_seconds`, `bucket` | | wait `retry_after_seconds` |
| 503 | `PLAY_INTEGRITY_UNAVAILABLE` | | retry later; submit only |

- **Unknown outcome.** The submit returns `503 SOLANA_OUTCOME_UNKNOWN` with `withdrawal_id` when the result of the Mongo transaction commit is unknown: the driver labels the error `UnknownTransactionCommitResult`, or a network error or timeout happens after `commitTransaction` was sent. The app then polls `GET withdrawals/:withdrawal_id` and, on `404`, repeats the submit with the same key and body; the replay lookup makes this safe. Admin reverify and cancel return the same code when an RPC read fails. A `503` never releases anything. Every other failure is a definitive refusal with its own code in this table; the rail defines no `502`.
- **Expired challenge is `410`**, not `409`: the resource is permanently gone and the only remedy is a new challenge, which the app must not confuse with the `409` conflicts that point at an existing withdrawal.

### 7.3 Admin routes

`@Controller('withdraw/solana/admin')` with `@UseGuards(AuthAdminGuard, RolesGuard)`, `@Roles('approver')` and `@RequirePermission('withdraw:approve')` on every route. Every row action runs `assertInScope(marketCodesOf({market}), access.countrySet)` for the row owner's market; rail-level actions require HQ access. Every mutating action writes an `adminActivity.appendRequired` audit row inside the same transaction as its state change, so a failed audit write aborts the action. Every mutating body carries `reason` (10 to 500 characters).

| Route | Body | Effect | Refusals (codes in "Admin refusals and responses" below) |
|---|---|---|---|
| `GET rail` | | the `GET rail` body below: flags, cluster, program id, onchain `paused`, vault and fee-payer balances, caps, day total, outstanding atomic amount, `needs_review` count, latch state with its causes and `version`, config completeness, heartbeat ages | |
| `GET withdrawals/:id` | | the admin row view below; in-scope check on the row owner's market | `400 SOLANA_INVALID_ID`; `404 SOLANA_WITHDRAWAL_NOT_FOUND` |
| `POST withdrawals/:id/reverify` | `{reason}` | runs the reconciler read path (9.2) once for this row (T13): `reserved`, `sending` (expired lease) or `submitted` to `finalized`, `reserved` or `needs_review`; `needs_review` only to `finalized`. **Never sends.** | `409 SOLANA_ADMIN_STATE_CONFLICT` if a lease is live or the row is terminal; `503 SOLANA_OUTCOME_UNKNOWN` on any RPC failure, state unchanged |
| `POST withdrawals/:id/retry` | `{acknowledged_payout_id, reason}` | `needs_review` to `reserved` (T14), `solana_next_attempt_at: now` | `409 SOLANA_ADMIN_STATE_CONFLICT` unless the state is `needs_review` with every attempt dead, or if `review_reason` is `receipt_mismatch`, `consent_invalid`, `inconsistent_rpc` or `deployment_mismatch`; `409 SOLANA_ADMIN_ACK_MISMATCH` if `acknowledged_payout_id` differs; `503 SOLANA_RAIL_UNAVAILABLE` if `SOLANA_WITHDRAW_ENABLED` is off, `WITHDRAWAL_SETTLEMENTS_ENABLED` is off, the latch is set, or the config is incomplete |
| `POST withdrawals/:id/cancel` | `{acknowledged: {payout_id, recipient, amount_atomic}, reason}` | to `released` (ledger `rejected`) only with the release proof (9.5, T15) | **v0: devnet only**; on mainnet `503 SOLANA_RELEASE_NOT_PROVABLE` with `failed_conditions: ["mainnet_release_disabled"]`. `409 SOLANA_ADMIN_STATE_CONFLICT` unless the state is `reserved`, `needs_review`, or `submitted` with every attempt dead, and no lease is live, or if the T15 compare-and-set is lost; `409 SOLANA_ADMIN_ACK_MISMATCH` if any acknowledged value differs (exact, case-sensitive); `503 SOLANA_RAIL_UNAVAILABLE` if `SOLANA_WITHDRAW_ENABLED` or settlements are off, the latch is set, or the config is incomplete; `503 SOLANA_RELEASE_NOT_PROVABLE` if a deployment, wire or chain condition fails; `503 SOLANA_OUTCOME_UNKNOWN` on any RPC failure |
| `POST rail/resume` | `{acknowledged_version, reason}` | clears the halt latch by CAS on `{_id: 'halt', halted: true, version: acknowledged_version}` (7.8) | `409 SOLANA_LATCH_NOT_SET` if the latch is not set; `409 SOLANA_ADMIN_ACK_MISMATCH` if `version` differs (a cause was added after the operator read it) |
| `POST allowlist` | `{user_id, wallet?, reason}` | adds one entry; `@Roles('superadmin')` instead of `approver`; raises an ops alert on every change | `400 SOLANA_ALLOWLIST_WALLET_INVALID` if `wallet` is missing on mainnet, present on devnet or invalid; `409 SOLANA_ALLOWLIST_ENTRY_EXISTS` |
| `DELETE allowlist/:user_id` | `{reason}` | removes one entry and the member's wallet binding inside `runSerializedWithdrawForRail(user_id, ...)`; `@Roles('superadmin')`; ops alert | `409 SOLANA_ACTIVE_CLAIM` while the member has an active slot; `404 SOLANA_ALLOWLIST_ENTRY_NOT_FOUND` |

Audit action names: `withdraw.solana_reverified`, `withdraw.solana_retried`, `withdraw.solana_released`, `withdraw.solana_rail_resumed`, `withdraw.solana_allowlist_added`, `withdraw.solana_allowlist_removed`. The system actions written by the workers are `withdraw.solana_paid`, `withdraw.solana_needs_review` and `withdraw.solana_rail_halted`.

Also: the Solana admin actions are added to `DENIED_ADMIN_MCP_TOOLS`, a case is added to `withdraw-money-path-rbac.integration.spec.ts`, and the new routes are added to the API route inventory spec.

#### Admin row view and `GET rail` body

Admin row view (`GET withdrawals/:id`, and the success body of the row actions):

```json
{
  "withdrawal_id": "cddbbad6db231771bc0060be",
  "user_id": "<24 hex>",
  "market": "TH",
  "cluster": "devnet",
  "status": "pending",
  "claim_state": "needs_review",
  "hold_reason": null,
  "review_reason": "attempts_exhausted",
  "payout_id": "<64 hex>",
  "recipient": "<base58>",
  "amount_atomic": "2673002",
  "deducted_minor": "10000",
  "fee_minor": "1000",
  "attempt_limit": 5,
  "sim_retries": 0,
  "lease_live": false,
  "attempts": [
    {
      "n": 1,
      "signature": "<base58>",
      "blockhash": "<base58>",
      "last_valid_block_height": "<u64>",
      "expires_at": 1790910565,
      "created_at": "<iso>",
      "broadcast_at": null,
      "outcome": "dead",
      "error_code": null,
      "error_name": null
    }
  ],
  "receipt_address": "<base58>",
  "signature": null,
  "landed_by_foreign_tx": false,
  "finalized_at": null,
  "released_at": null,
  "created_at": "<iso>"
}
```

It never contains `wire_base64`, the consent message bytes or the consent signature.

`GET rail` body:

```
{ "flags": { "enabled": bool, "requests": bool, "sender": bool, "reconciler": bool, "settlements": bool },
  "cluster", "program_id", "vault", "onchain_paused": bool|null, "vault_balance_atomic", "fee_payer_lamports",
  "max_per_claim", "max_per_day", "day": int, "claimed_today", "outstanding_atomic", "needs_review_count": int,
  "latch": { "halted": bool, "reason", "at", "version": int, "causes": [ { "reason", "at", "set_by", "evidence" } ] },
  "config": { "complete": bool, "missing": [string] },
  "heartbeat_age_seconds": { "solana_sender", "solana_reconciler", "solana_watcher" },
  "observed_at" }
```

u64 values are decimal strings and unknown values are `null`.

The existing `GET /admin/withdraw-all` (`@Roles('viewer')`, `@AdminMcpRead()`) must project out every `solana_*` field of `method: 'solana_usdc'` rows except `solana_claim_state` and `solana_cluster`, with a spec.

#### Admin refusals and responses

Every admin refusal uses the §7 envelope.

| HTTP | `code` | When |
|---|---|---|
| 400 | `SOLANA_ADMIN_REASON_INVALID` | `reason` missing or outside 10-500 characters |
| 400 | `SOLANA_ALLOWLIST_WALLET_INVALID` | `wallet` missing on mainnet, present on devnet, not strict base58, or refused by the §7.1 recipient rules |
| 400 | `SOLANA_INVALID_ID` | malformed path or body id |
| 403 | the existing `assertInScope` refusal | row owner's market outside the admin's scope; rail-level action without HQ access |
| 404 | `SOLANA_WITHDRAWAL_NOT_FOUND` | no `method: 'solana_usdc'` row with this id |
| 404 | `SOLANA_ALLOWLIST_ENTRY_NOT_FOUND` | `DELETE` for a user with no entry |
| 409 | `SOLANA_ALLOWLIST_ENTRY_EXISTS` | `POST allowlist` for a user who already has an entry |
| 409 | `SOLANA_ADMIN_STATE_CONFLICT` with `claim_state` | the row's state, review reason, live lease or live attempt does not allow reverify, retry or cancel, or the compare-and-set was lost |
| 409 | `SOLANA_ADMIN_ACK_MISMATCH` | any acknowledged value (`acknowledged_payout_id`, `acknowledged.*`, `acknowledged_version`) differs from the stored value (exact string comparison; integer equality for `acknowledged_version`) |
| 409 | `SOLANA_LATCH_NOT_SET` | `rail/resume` while the latch is clear |
| 409 | `SOLANA_ACTIVE_CLAIM` | `DELETE allowlist` while the member has an active slot |
| 503 | `SOLANA_RAIL_UNAVAILABLE` with `unavailable_reason` | retry or cancel while `SOLANA_WITHDRAW_ENABLED` is off (`disabled`), settlements are off or the latch is set (`paused`), or the config is incomplete (`maintenance`) |
| 503 | `SOLANA_OUTCOME_UNKNOWN` | any RPC read failed during reverify or the cancel proof; state unchanged |
| 503 | `SOLANA_RELEASE_NOT_PROVABLE` with `failed_conditions` | a §9.5 deployment, wire or chain condition failed, or mainnet |

`failed_conditions` is a non-empty array drawn only from these names, listed in this order: `mainnet_release_disabled`, `deployment_mismatch`, `wire_decode_mismatch` (a decoded wire field disagrees with the attempt record or the row, or the lifetime is a durable nonce), `P1_genesis_mismatch`, `P2_blockhash_still_valid`, `P3_expiry_not_passed`, `P4_signature_succeeded`, `P5_receipt_present`.

Success: `200` with the admin row view for reverify, retry and cancel; `200` with the `GET rail` body for `rail/resume`; `201` with the stored entry for `POST allowlist`; `204` for `DELETE allowlist`.

### 7.4 Idempotency

- The key is `solana-<challenge_id>` and is **single-use per challenge**. One challenge produces at most one row, ever. The backstops are the challenge burn CAS, `uniq_withdraw_solana_payout_id` (the payout id is per challenge) and `uniq_withdraw_user_idempotency_key`.
- **Effect hash:** `sha256` (lowercase hex) of the UTF-8 string `"gogocash-solana-withdraw-effect-v0\n" + challenge_id + "\n" + address + "\n" + signature`, where `address` and `signature` are the request's strict base58 strings (strict base58 has exactly one encoding per value, so a re-encoded retry cannot cause a false mismatch). Every money-relevant value (amount, payout id, quote, recipient) is fixed by the server-side challenge, so the client can vary only these inputs. Ed25519 is deterministic, so a wallet that signs the same bytes again yields the same signature.
- **Rule** (`decideSolanaCommandReplay`, new, beside `decideWithdrawCommandReplay`):
  - The lookup is `{user_id, idempotency_key}` and runs **first**, before the challenge load, the clock and the signature check.
  - Same key and same effect hash: return the row **in any status**, including `paid` and `rejected`, with `200` and `reused: true`. This is the opposite of the bank lane's `IDEMPOTENCY_KEY_ALREADY_SETTLED` rule, and it is safe only because the key can never describe a second payout.
  - Same key and a different effect hash: `409 IDEMPOTENCY_KEY_EFFECT_MISMATCH`.
  - Never a second row.
- `/challenge` refuses while an active slot exists and returns its id (`409 SOLANA_ACTIVE_CLAIM`).
- A response lost after commit and retried 11 minutes later (challenge expired) returns the same row with `reused: true`, with no second wallet prompt.

### 7.5 Brakes

| Switch | Idiom | Stops | Does not stop |
|---|---|---|---|
| `SOLANA_WITHDRAW_ENABLED` | **opt-in**: only the literal `'true'` enables | challenges, submits, the sender, rebroadcasts, admin retry and cancel | the reconciler's reads and `finalized` transitions, the watcher, alerts, `GET` routes, admin reverify and resume |
| `SOLANA_WITHDRAW_REQUESTS_ENABLED` | opt-out: only `'false'` disables | challenges and submits | everything else |
| `SOLANA_WITHDRAW_SENDER_ENABLED` | opt-out | new attempts **and rebroadcasts** | reads and `finalized` transitions |
| `SOLANA_WITHDRAW_RECONCILER_ENABLED` | opt-out | the reconciler and watcher ticks (observation-only brake); after 300 s the stale watcher heartbeat also holds the sender | intake (rows wait in `reserved`) |
| existing `WITHDRAWALS_ENABLED`, `WITHDRAWAL_REQUESTS_ENABLED`, market valve | as today | intake (layered above the Solana switches) | |
| existing `WITHDRAWAL_SETTLEMENTS_ENABLED` | as today | the sender, rebroadcasts, admin retry and cancel | the reconciler and watcher |
| DB halt latch (`solana_rail_state._id = 'halt'`) | set by CAS; **fails closed** if unreadable | the same as `SOLANA_WITHDRAW_ENABLED` | the same as `SOLANA_WITHDRAW_ENABLED` |
| program `pause` | onchain | `claim` (the sender holds with `program_paused`) | |

- All four `SOLANA_WITHDRAW_*_ENABLED` names are blank in `apps/api/.env.example`, commented in `.env.railway.production.example`, and listed in `knowledge/delivery/kill-switches.md` (the kill-switch inventory spec enforces it).
- The reconciler may record `finalized` while the rail is braked or halted: an onchain receipt is a fact, and `paid` is already inside the reserved set, so the balance does not change.

### 7.6 Allowlist and per-member limits

The allowlist is fail-closed and its mode is **derived from the cluster**, never from a variable (review GRAPH-3):

| Cluster | Mode | Entry | Wallet rule | Checked at |
|---|---|---|---|---|
| `devnet` | user-only | `{user_id}` | any wallet the first time; the binding is written at the first **verified** submit (the first challenge whose consent signature verified) and pins the member to that wallet afterwards | config, challenge, submit, send |
| `mainnet` | pinned | `{user_id, wallet}` | the recipient must equal the pinned wallet | config, challenge, submit, send |

- A binding is created only after a valid Ed25519 consent proves the member controls the wallet. A challenge alone never binds, so nobody can squat someone else's wallet without its key.
- Removing an entry is refused with `409 SOLANA_ACTIVE_CLAIM` while the member has an active slot (§7.3). The removal runs inside `runSerializedWithdrawForRail(user_id, ...)`, so it cannot interleave with a submit. To stop an in-flight payout, an admin sets `wallet_frozen` on the member (T6 `account_blocked`) or pauses the rail. The send-time allowlist check (T6 `allowlist_removed`) remains as a backstop and should never fire.
- Per-member limits per UTC day are counted over this member's `method: 'solana_usdc'` rows whose `solana_claim_state` is not `released` and whose `createdAt` is at or after 00:00:00.000Z of the current UTC day. Refuse with `409 SOLANA_DAILY_LIMIT` if `count >= SOLANA_WITHDRAW_MAX_CLAIMS_PER_DAY` (default `3`), or if `sum(solana_amount_atomic) + payout_amount_atomic > SOLANA_WITHDRAW_MAX_ATOMIC_PER_DAY` (default `20000000`), summed as `bigint`.
- A truth-table spec (`solana-allowlist-mode.spec.ts`) covers cluster {devnet, mainnet} × {not listed, listed and unbound, listed and bound to this wallet, listed and bound to another wallet, wallet bound to another user} × {config, challenge, submit, send}, and asserts the exact code or `unavailable_reason` for each cell (review GRAPH-3).

### 7.7 Environment attestation

The rail is usable only on a positive match; anything else is `env_guard=blocked` and the config is incomplete.

| `RAILWAY_ENVIRONMENT_NAME` | Allowed `SOLANA_CLUSTER` | Extra condition |
|---|---|---|
| `preview` | `devnet` only | |
| `production` | `mainnet` only | the `solana_rail_state._id = 'deployment_identity'` document exists and its `{cluster, genesis_hash, program_id, vault}` equals the running config exactly; plus pilot approval (`SOLANA_WITHDRAW_PILOT_APPROVED === 'true'`) |
| absent (local) | `devnet` only | `SOLANA_WITHDRAW_LOCAL_DEVNET === 'true'` and the Mongo host is loopback |
| any other value | none | |

- The RPC genesis hash must equal the pinned genesis of `SOLANA_CLUSTER`. It is checked when the RPC client is created, on every sender, reconciler and watcher tick, and before every admin proof, cached for at most 60 s.
- `SOLANA_PROGRAM_ID` and `SOLANA_USDC_MINT` must equal the vendored manifest for the cluster (`release/manifest.json.programIds[cluster]`, §2.4). **v0 uses the placeholder program id** `HWNF2cvXybfAjLbw2pydi7sNFmTfYBjpEWNtY3BJfCje` on devnet and `null` on mainnet (it has no private key, so nothing can be deployed there); real per-cluster ids and PDA vectors arrive in v0.1 (review SCHED-8). A `null` id makes the cluster unavailable.
- The config is also incomplete unless `getAccountInfo(program_id)` returns an executable account owned by `BPFLoaderUpgradeab1e11111111111111111111111` (§2.4). The placeholder always fails this, so a v0 build can never send.
- The onchain ProgramData upgrade authority and last-deploy slot must equal `SOLANA_PROGRAM_UPGRADE_AUTHORITY` and `SOLANA_PROGRAM_DEPLOY_SLOT`. A mismatch makes the config incomplete and raises `ops.solana.rail_halted`.
- **Key separation:** `SOLANA_CLAIM_AUTHORITY_PUBKEY` and `SOLANA_FEE_PAYER_PUBKEY` must each differ from the ProgramData upgrade authority, the vault `admin`, `guardian` and a non-default `pending_admin`. This is checked at boot and on every config-pin check; a match makes the config incomplete and sets the latch. (The fee payer may equal the claim authority, §3.3.2.)
- **One claim key per vault.** A payout id is single-use per vault only (the vault is in the receipt seeds). At boot and every 60 s, `getProgramAccounts(program_id, {filters: [{dataSize: 324}, {memcmp: {offset: 172, bytes: <claim authority>}}]})` must return exactly the configured vault. Any other result (for example the demo-mint vault sharing the key) makes the config incomplete and sets the latch. An RPC error counts as incomplete until the next successful check.
- `SOLANA_SIWS_DOMAIN` and `SOLANA_SIWS_URI` must string-equal the §4.4 row for the attested environment (`preview` and local: `app-staging.gogocash.co` / `https://app-staging.gogocash.co`; `production`: `app.gogocash.co` / `https://app.gogocash.co`). Any other value makes the config incomplete.
- Boot line on the web and worker processes, never printing values: `solana-withdraw rail=on|off cluster=<c> env_guard=ok|blocked config=complete|incomplete(<n>) signer=present|absent|mismatch sender=on|off`.

### 7.8 Halt latch

- Document `solana_rail_state {_id: 'halt', halted, reason, at, set_by, causes, version, cleared_by, cleared_at, clear_reason, last_cleared_causes}`. `reason`, `at` and `set_by` describe the first cause since the latch was last set. Each element of `causes` is `{key, reason, at, evidence, set_by}`. `key` is `reason` + `:` + a stable identifier of the event (for example the withdrawal id for a receipt mismatch, or the observed values for `vault_config_changed`), so a condition that persists across ticks is recorded once and a new event is always recorded. `evidence` holds ids, slots and observed onchain values only, never a secret or the RPC URL.
- **Set** by atomic updates that record every cause:
  1. First cause: `findOneAndUpdate({_id: 'halt', halted: {$ne: true}}, {$set: {halted: true, reason, at, set_by, causes: [cause]}, $inc: {version: 1}}, {upsert: true})`. A duplicate-key error on the upsert means the latch is already set; continue with step 2.
  2. Further cause: `updateOne({_id: 'halt', halted: true, 'causes.key': {$ne: cause.key}}, {$push: {causes: cause}, $inc: {version: 1}})`. A cause added while the latch is already set is still appended and still increments `version`. Zero matched documents means the same cause is already recorded; if a read then shows the latch clear, step 1 runs once more.
  - Setters: the sender (`bug` and `config` classes, 6014 `VaultTokenAccountFrozen`, consent invalid or deployment mismatch at send), the reconciler (receipt mismatch, foreign receipt, deployment mismatch, `bug` and `config` classes on a landed failure), the watcher, and the config-pin check.
  - Every setter whose cause is newly recorded raises its own CRITICAL `ops.solana.rail_halted` alert, whether or not the latch was already set (CRITICAL is wording in the subject; the catalog has no severity field), and signals the guardian runbook.
- **Read** on every member request, every tick and every admin mutation. A read error counts as halted.
- **Cleared** only by `POST /withdraw/solana/admin/rail/resume`, in one transaction: a CAS on `{_id: 'halt', halted: true, version: acknowledged_version}` with `$set: {halted: false, cleared_by, cleared_at, clear_reason, last_cleared_causes: <causes>, causes: []}` and `$inc: {version: 1}`. If a cleared cause is `vault_config_changed`, the same transaction replaces the watcher document's `expected_vault_config` with the observed values recorded in the newest such cause (§9.3). A condition that still holds re-latches on the next tick.

### 7.9 Legacy refusals

Every existing status-writing path refuses a `method: 'solana_usdc'` row explicitly, before any write, with a spec each:

| Path | File | Refusal |
|---|---|---|
| `approveWithdrawRequest` | `withdraw.service.ts` | `409`. Today it refuses only implicitly (`assertAutoPayoutEvidence`), and its update filter is `withdraw_mode: {$ne: 'manual'}`, which a `solana_claim` row would match. |
| `markWithdrawPaid` | `withdraw.service.ts` | `409`. Today it refuses through `withdraw_mode !== 'manual'` and the EVM hash check. |
| `updateRequestWithdraw` | `admin/admin.service.ts` | already refuses `method !== 'bank_transfer'`; add a regression spec for `solana_usdc`. |

A sweep spec asserts that no existing query that writes `status` can match `method: 'solana_usdc'` or `withdraw_mode: 'solana_claim'`. Only `apps/api/src/withdraw/solana/` may write `solana_*` fields or the status of a Solana row.

### 7.10 Configuration names used by sections 6 to 9

Non-secret unless marked. Every name is blank in `apps/api/.env.example` and commented in `.env.railway.production.example`; a missing or malformed required value makes the config incomplete.

| Name | Default | Section |
|---|---|---|
| `SOLANA_WITHDRAW_ENABLED`, `SOLANA_WITHDRAW_REQUESTS_ENABLED`, `SOLANA_WITHDRAW_SENDER_ENABLED`, `SOLANA_WITHDRAW_RECONCILER_ENABLED` | off, on, on, on | 7.5 |
| `SOLANA_CLUSTER`, `SOLANA_PROGRAM_ID`, `SOLANA_USDC_MINT`, `SOLANA_CLAIM_AUTHORITY_PUBKEY`, `SOLANA_FEE_PAYER_PUBKEY`, `SOLANA_SIWS_DOMAIN`, `SOLANA_SIWS_URI` | none (required) | 7.7 |
| `SOLANA_PROGRAM_UPGRADE_AUTHORITY`, `SOLANA_PROGRAM_DEPLOY_SLOT` | none (required) | 7.7 |
| `SOLANA_RPC_URL` (secret), `SOLANA_RPC_PROVIDER_LABEL` | none (required) | 7.7, 9.5 |
| `SOLANA_CLAIM_AUTHORITY_KEYPAIR`, `SOLANA_FEE_PAYER_KEYPAIR` (secrets, CRON owner only) | none | 9 |
| `SOLANA_WITHDRAW_PILOT_APPROVED`, `SOLANA_WITHDRAW_LOCAL_DEVNET` | unset | 7.7 |
| `SOLANA_WITHDRAW_MIN_PAYOUT_ATOMIC`, `SOLANA_WITHDRAW_MAX_PAYOUT_ATOMIC` | `1000000`, `5000000` | 6.4 |
| `SOLANA_WITHDRAW_MAX_CLAIMS_PER_DAY`, `SOLANA_WITHDRAW_MAX_ATOMIC_PER_DAY` | `3`, `20000000` | 7.6 |
| `SOLANA_WITHDRAW_FEE_FLOOR_MINOR`, `SOLANA_WITHDRAW_ATA_FEE_MINOR` | none (required) | 6.5 |
| `SOLANA_WITHDRAW_FX_SPREAD_BPS`, `SOLANA_WITHDRAW_FX_MAX_AGE_SECONDS`, `SOLANA_WITHDRAW_FX_MIN_E8`, `SOLANA_WITHDRAW_FX_MAX_E8` | `0`, `93600`, `2500000000`, `4500000000` | 6.6 |
| `SOLANA_WITHDRAW_PRIORITY_FEE_CAP_MICROLAMPORTS` | `100000` | 9.1 |
| `SOLANA_WITHDRAW_VAULT_LOW_ATOMIC`, `SOLANA_WITHDRAW_FEE_PAYER_MIN_LAMPORTS` | none (required) | 9.1, 9.3 |

## 8. Claim states

`solana_claim_state` is the rail's own state machine. The ledger `status` follows it (8.3). The transition function is pure (`solana-claim-state.ts`), and every transition in the table below is applied as a single compare-and-set on `{_id, solana_claim_state: <from>, ...condition fields}`. A transition not in the table is a bug and is refused.

### 8.1 States

| State | Meaning | Terminal | `solana_slot_active` | Persisted attempts |
|---|---|---|---|---|
| `reserved` | balance reserved; nothing that could land exists, or every attempt is proven dead | no | `true` | zero, or all `dead` |
| `sending` | a sender holds the lease and may be signing | no | `true` | as in `reserved`; a new attempt is pushed only together with the move to `submitted` |
| `submitted` | at least one persisted attempt is not yet proven dead, or the receipt was seen at `confirmed` (T5) | no | `true` | at least one live, or none after T5 |
| `needs_review` | automation stopped; a human must act | no | `true` | any |
| `finalized` | the receipt exists at `finalized` with the matching tuple | **yes** | unset | any |
| `released` | the release proof showed the payout can never land; the reservation is returned | **yes** | unset | all dead |

### 8.2 Transitions

| # | From | To | Actor | Condition |
|---|---|---|---|---|
| T1 | (none) | `reserved` | intake | verified submit commits (section 7.1); `status: 'pending'` |
| T2 | `reserved` | `sending` | sender | CAS: `solana_next_attempt_at <= now`, no live lease; sets `solana_lease_owner`, `solana_lease_until = now + 120 s`; all brakes open, latch clear, config complete |
| T3 | `sending` | `reserved` | sender | a send-time hold before any attempt is persisted in this lease (`program_paused`, `day_cap`, `vault_low`, `fee_payer_low`, `settlements_paused`, RPC error); sets `solana_hold_reason` and `solana_next_attempt_at`; clears the lease |
| T4 | `sending` | `submitted` | sender | the attempt is persisted (`$push` to `solana_attempts`) in the **same** CAS, with `{w: 'majority', j: true}`, filtered on the lease owner and an unexpired lease. Broadcast happens only after this succeeds. |
| T5 | `sending` | `submitted` | sender | receipt-exists shortcut: the receipt PDA already exists at `confirmed`, or the unsigned simulation reports `already_claimed`; no attempt is pushed; sets `solana_receipt_seen_at = now` and clears the lease; the reconciler decides |
| T6 | `sending` | `needs_review` | sender | a send-time check needs a human: `account_blocked` (frozen or disabled member), `allowlist_removed`, `consent_invalid` (also sets the latch), `attempts_exhausted` (`solana_attempt_limit` reached), `simulation_rejected` (a needs-review-class program error in the unsigned simulation, or `solana_sim_retries` reaching 5), `deployment_mismatch` (§3.8 step 1; also sets the latch) |
| T7 | `sending` (lease expired) | `submitted` | reconciler | the lease is past `solana_lease_until` and the row has a live attempt |
| T8 | `sending` (lease expired) | `reserved` | reconciler | the lease is past `solana_lease_until` and the row has no live attempt (nothing persisted, so nothing was broadcast) |
| T9 | `submitted` | `finalized` | reconciler | receipt at `finalized` whose address = `findReceiptPda(vault, payout_id)`, owned by the program, correct discriminator, and tuple `(payout_id, recipient, amount)` equal to the row. Ledger `pending` to `paid` in the same transaction. |
| T10 | `submitted` | `reserved` | reconciler | no receipt, `solana_receipt_seen_at` unset, at least one attempt, and every attempt proven dead (9.2), attempts used < `solana_attempt_limit`; `solana_next_attempt_at` set from the hold reason, or `now` |
| T11 | `submitted` | `needs_review` | reconciler | every attempt dead and attempts used = `solana_attempt_limit` (`attempts_exhausted`); or receipt tuple mismatch (`receipt_mismatch`, plus CRITICAL and the latch; **never paid**); or a finalized successful attempt with no receipt (`inconsistent_rpc`); or `solana_receipt_seen_at` set (T5) and the receipt still absent at `finalized` more than 60 s later (`inconsistent_rpc`, §3.8); or the row's deployment fields differ from the running config (`deployment_mismatch`, plus CRITICAL and the latch; no chain read) |
| T12 | `reserved`, `sending`, `needs_review` | `finalized` | reconciler or watcher | same proof as T9 (for example a receipt that landed while the row was held or in review) |
| T13 | `reserved`, `sending`, `submitted`, `needs_review` | `finalized`, `reserved` or `needs_review`; from `needs_review` only `finalized` | admin `reverify` | no live lease (otherwise `409`); the reconciler read path once, with the same conditions as T9 to T12; never sends; an RPC error changes nothing. Reverify never moves a row out of `needs_review` except to `finalized`; only `retry` (T14) returns it to `reserved`. |
| T14 | `needs_review` | `reserved` | admin `retry` | `review_reason` not in `receipt_mismatch`, `consent_invalid`, `inconsistent_rpc`, `deployment_mismatch`; acknowledged `payout_id` equal; settlements switch on; latch clear; every attempt dead. Adds 5 to `solana_attempt_limit` and resets `solana_sim_retries` to 0. |
| T15 | `reserved`, `needs_review`, `submitted` | `released` | admin `cancel` | **devnet only in v0**; no live lease; for `submitted`, every attempt dead; the release proof (9.5) passes; acknowledged tuple equal; latch clear; the compare-and-set is bound to the assessed attempt set (9.5). Ledger `pending` to `rejected`. |

Notes:

- There is no transition out of `finalized` or `released`, and no automatic transition into `released`. Only T15 can return a reservation.
- The watcher never changes a row's state except through T12. It sets the latch instead (9.3).
- `solana_attempts` is append-only. An attempt's `outcome` moves only forward: `persisted` to `broadcast` or `send_unknown` or `preflight_rejected`, then to `dead`, `landed` or `failed`.
- `reserved` rows waiting on a hold keep their reason in `solana_hold_reason`. `day_cap` first retries at the next UTC midnight plus 60 s (server clock); if 6011 recurs, it retries every 60 s until the program's day rolls, and never waits another full day. The other holds retry after 60 s.
- Every transition into `reserved` sets `solana_hold_reason` to the hold that caused it, or unsets it when there is none (T8, T13, T14). Every transition into `needs_review` sets `solana_review_reason`, and every transition out of `needs_review` unsets it. T2 leaves both unchanged. T9, T12 and T15 unset `solana_hold_reason`.
- Clearing a lease unsets both `solana_lease_owner` and `solana_lease_until`.

### 8.3 Display and ledger mapping

| `solana_claim_state` | `display_state` | Ledger `status` | Balance |
|---|---|---|---|
| `reserved` | `processing` | `pending` | reserved |
| `sending` | `processing` | `pending` | reserved |
| `submitted` | `processing` | `pending` | reserved |
| `needs_review` | `processing` | `pending` | reserved |
| `finalized` | `paid` | `paid` (with `paid_at` = `solana_finalized_at`, `paid_by: 'system:solana_reconciler'`) | deducted (settled) |
| `released` | `cancelled` | `rejected` (with `rejection_reason: 'solana_release_proven'`), **only with the release proof** | released |

- `pending` and `paid` are both in `WITHDRAW_RESERVED_STATUSES`, so the balance never moves between them. `rejected` is the only status that releases a reservation, which is why T15 is the only path to it.
- `display_state` is computed from `solana_claim_state` on read; it is never stored.
- On T9, T12 and T15 the same transaction also unsets `solana_slot_active` and the lease, and writes the `appendRequired` audit row. On T15 it also deletes this row's `solana_ata_sponsorships` entry, because the ATA creation in a never-landed transaction never happened.

## 9. Sender, reconciler and release proof

Three scheduled loops move and observe money. All three run **only on the CRON owner** (`gogocash-worker` in production, `gogocash-api-preview` on preview). Every `@Interval` handler starts with `if (!isLegacyCronEnabled()) return;` (the legacy-cron-gate sweep spec enforces it). The claim-authority and fee-payer keypairs are loaded only in the CRON owner; the boot line reports `signer=present` there and `signer=absent` elsewhere.

**No RPC call is ever made inside a Mongo transaction.** All chain reads happen first; the state change is then one CAS (sender) or one short transaction in `solana-ledger-transitions.ts`, the only new `withTransaction` site (added to `docs/migration/tx-sites.md` and its sweep count).

| Loop | Interval | Batch | Gates (all required) |
|---|---|---|---|
| sender | 5 s, plus a post-commit kick | at most **5 rows** per tick | `SOLANA_WITHDRAW_ENABLED === 'true'`, `SOLANA_WITHDRAW_SENDER_ENABLED`, `WITHDRAWAL_SETTLEMENTS_ENABLED` (and the master), latch clear and readable, config complete, environment attestation, genesis, `signer=present`, the watcher baseline exists, and the `solana_watcher` heartbeat is at most 300 s old (no money moves while nobody is watching) |
| reconciler | 10 s | at most 50 rows per tick | `SOLANA_WITHDRAW_RECONCILER_ENABLED`, config complete, environment attestation, genesis. Not stopped by the settlement switches, `SOLANA_WITHDRAW_ENABLED` or the latch. Its **rebroadcasts** need the sender gates as well. |
| watcher | 60 s | the whole vault | as the reconciler |

### 9.1 Sender

For each selected row (`solana_claim_state: 'reserved'`, `solana_next_attempt_at <= now`, this cluster and vault, oldest first), in order:

1. **Lease CAS** (T2): `reserved` to `sending`, `solana_lease_owner = <instance id>`, `solana_lease_until = now + 120 s`. A lost CAS skips the row.
2. **Send-time re-checks** (review SEC-7: signature plus tuple equality, **no clock check**):
   - the member is not `wallet_frozen` or disabled (T6 `account_blocked`);
   - the allowlist still holds the member, and on mainnet the pinned wallet equals `solana_recipient` (T6 `allowlist_removed`);
   - the market valve and `assertPayoutRailAllowedForMarket(…, 'crypto')` still pass (T3 hold);
   - **consent:** re-render the message with the vendored `siws.ts` from the row's stored render inputs (domain, URI, recipient, D, F, atomic amount, cluster, nonce, `issued_at_ms`, `expiration_ms`, withdrawal id, payout id, program id) and byte-compare it with `solana_consent_message`; verify `solana_consent_signature` over those stored bytes with the recipient key; and check tuple equality between the message inputs and the `claim` being built (recipient, amount, payout id, and the program id equal to the currently configured one), as §4.9 requires; the row's deployment fields must also equal the running config (§3.8 step 1), and a difference is T6 `deployment_mismatch` instead. The Expiration Time is **not** checked here; freshness onchain is the attempt's `expires_at`. Any failure is T6 `consent_invalid`, sets the latch and raises CRITICAL, because it means the stored row was altered;
   - program state at `confirmed`: not paused (T3 `program_paused`); `claim_authority` equals the loaded signer (otherwise config is `signer=mismatch`, the sender stops); vault balance at least the amount (T3 `vault_low` plus `ops.solana.vault_low`); fee payer balance above `SOLANA_WITHDRAW_FEE_PAYER_MIN_LAMPORTS` (T3 `fee_payer_low` plus `ops.solana.fee_payer_low`);
   - attempts used < `solana_attempt_limit` (T6 `attempts_exhausted`).
3. **Receipt-exists shortcut:** if the receipt PDA exists at `confirmed`, apply T5 and stop. The reconciler verifies the tuple at `finalized`.
4. **Blockhash** from `getLatestBlockhash({commitment: 'confirmed'})`: keep `blockhash`, `lastValidBlockHeight` and the context slot. Read the Clock sysvar at `confirmed` with `minContextSlot` = that slot, and set `expires_at = clock.unix_timestamp + 300`.
5. **Build** a v0 transaction with no address lookup table and a recent-blockhash lifetime. **Never a durable nonce.** Instructions, in order:
   1. `SetComputeUnitLimit(limit)`: `limit = ceil(simulated_units x 115 / 100)`, capped at **60,000** when the recipient ATA exists and **90,000** when it does not. `simulated_units` comes only from an **unsigned** simulation (all-zero signatures, `sigVerify: false`, `replaceRecentBlockhash: true`) through the SDK estimator. A signed transaction is never simulated (review SEC-13).
   2. `SetComputeUnitPrice(price)`: the 75th percentile of `getRecentPrioritizationFees([vault, vault_token_account])`, capped at `SOLANA_WITHDRAW_PRIORITY_FEE_CAP_MICROLAMPORTS` (default `100000`).
   3. `createAssociatedTokenIdempotent(payer = fee payer, ata = recipient_token_account, owner = recipient, mint)`.
   4. `claim(payout_id, amount = solana_amount_atomic, expires_at)` with signers claim authority and payer = fee payer.
   - If the simulation fails, no attempt is persisted. A transport error or timeout is a T3 `rpc_error` hold. A program, Anchor or instruction error is classified by number and failing instruction index with the vendored `errors.ts` (§3.5 to §3.7), and the class decides:

| Class (§3.5) | Sender action |
|---|---|
| `retry` (for example 6012 `Expired`) | T3 with `solana_next_attempt_at = now` and `solana_sim_retries` incremented; a fresh blockhash and `expires_at` next tick. When `solana_sim_retries` reaches 5, T6 `simulation_rejected` instead. |
| `hold` (6000 `Paused`, 6011 `DayCapExceeded`, 6016 `InsufficientVaultBalance`, payer insufficient lamports) | T3 with `program_paused`, `day_cap`, `vault_low` or `fee_payer_low`; 6014 `VaultTokenAccountFrozen` also sets the latch and raises CRITICAL |
| `already_claimed` (`Custom(0)` "already in use" at the `claim` index) | T5: the reconciler runs the §3.8 receipt verification |
| `needs_review` (for example 6010, 6015, 6017, 3011) | T6 `simulation_rejected` with `error_code` |
| `bug` | T6 `simulation_rejected`, plus the latch and CRITICAL |
| `config` | T3 hold `config_mismatch`; the rail config becomes incomplete, plus the latch and CRITICAL |

   Transaction-level errors that carry no instruction index (§3.7) are classified here: `BlockhashNotFound` and `AccountInUse` are `retry`; `InsufficientFundsForFee` and `InsufficientFundsForRent` are `hold` (`fee_payer_low`); any other is `bug`.

6. **Sign, then persist before broadcast** (T4): one `findOneAndUpdate` filtered on `{_id, solana_claim_state: 'sending', solana_lease_owner: me, solana_lease_until: {$gt: now}, 'solana_attempts.n': {$ne: n}}` that pushes `{n, signature, blockhash, last_valid_block_height, expires_at, wire_base64, created_at, outcome: 'persisted'}` and sets `solana_claim_state: 'submitted'`, with write concern `{w: 'majority', j: true}`. **If the CAS is lost or the write is not acknowledged, the transaction is never broadcast** and the signed bytes are dropped from memory.
7. **Broadcast** with `sendTransaction(wire, {encoding: 'base64', preflightCommitment: 'confirmed', minContextSlot, maxRetries: 0})`. Then record the attempt outcome: `broadcast` on success; `preflight_rejected` with `error_code` on a definitive preflight error; `send_unknown` on a network error or timeout. The row stays `submitted` in every case; only the reconciler decides what happens next.

A crash at any step leaves either `sending` with no live attempt (T8 after the lease expires) or `submitted` with a persisted attempt (reconciled normally). A resend is always safe, because the receipt PDA can be created only once per payout id.

### 9.2 Reconciler

Every 10 s, for rows in `submitted`, and rows in `sending` whose lease has expired. Reads, in this order, all with `commitment: 'finalized'`:

1. `getEpochInfo` gives the finalized block height `H` and slot `S`.
2. `getMultipleAccounts` on each row's receipt address, derived and checked as in §3.8 step 1, with `minContextSlot: S` (the receipt read is never older than the height read). A row whose deployment fields differ from the running config is not read: T11 `needs_review` (`deployment_mismatch`) plus CRITICAL and the latch.
3. `getSignatureStatuses` on every attempt signature with `searchTransactionHistory: true`.

Then, per row:

| Observation | Action |
|---|---|
| §3.8 receipt verification returns `match`: address = `findReceiptPda(row.solana_vault, payout_id)` under `row.solana_program_id` (§3.8 step 1); owner = program; length 89; discriminator and bump correct; decoded `(payout_id, recipient, amount)` equals the row | **T9/T12 finalized** in one transaction: `status: 'paid'`, `paid_at`, `solana_signature` (the attempt with a finalized success status), `solana_landed_slot`, `solana_finalized_at`, `appendRequired 'withdraw.solana_paid'`. Post-commit: telemetry and the member notification. |
| Same, but no attempt of ours shows a finalized success | finalized as above with `solana_landed_by_foreign_tx: true`, **plus** the latch and CRITICAL: someone else used the claim authority. `solana_signature` stays unset; `solana_landed_slot` is the context slot of the finalized receipt read. |
| §3.8 returns `mismatch` (owner, length, discriminator, bump or tuple differs; "already in use" with a mismatch) | **T11 `needs_review` (`receipt_mismatch`), CRITICAL `ops.solana.payout_needs_review` and `ops.solana.rail_halted`, the latch. Never paid**; the balance stays reserved (review SEC-9). |
| No receipt; an attempt reports finalized success | T11 `inconsistent_rpc`; no latch; the next tick re-reads |
| No receipt; `solana_receipt_seen_at` is set (the row reached `submitted` through T5); this row is checked before the two rows below | within 60 s of `solana_receipt_seen_at`: no change (finalization grace); after that: T11 `inconsistent_rpc` (§3.8), no latch |
| No receipt; `solana_receipt_seen_at` unset; at least one attempt, and every attempt is dead: `H > last_valid_block_height` and the status is `null` or a failure | T10 back to `reserved` (or T11 `attempts_exhausted` at `solana_attempt_limit`). A failed status sets the attempt's `error_code` and is classified as in 9.1: `retry` and `hold` give T10 with the matching hold; `needs_review` and `bug` give T11 (`bug` also latches); `config` latches and holds. |
| No receipt; some attempt is still live (`H <= last_valid_block_height`) | rebroadcast each live attempt's stored `wire_base64` with `{skipPreflight: true, maxRetries: 0}`, ignoring `AlreadyProcessed`, **only if the sender gates pass**. No state change. |
| `sending` with an expired lease | T7 (live attempt present) or T8 (none) |
| Any RPC error, timeout or genesis mismatch | **nothing changes**; the balance stays reserved; the row is retried next tick |

**Attempt outcomes.** Only the reconciler writes `dead`, `landed` and `failed`. It does so in the same write as the row transition, or, when the row state does not change, with a `$set` on `solana_attempts.$[a].outcome` filtered on the attempt's current `outcome`.

| Observation for one attempt | New `outcome` |
|---|---|
| `getSignatureStatuses` finalized with `err: null` | `landed` |
| finalized with an error | `failed` (sets `error_code`, `error_name`) |
| status `null` and `H > last_valid_block_height` | `dead` |

In T10, T11, T14, T15 and §9.5, "dead" means `outcome` is `dead` or `failed`. The sender writes only `persisted` (T4) and then `broadcast`, `send_unknown` or `preflight_rejected` (§9.1 step 7). A `preflight_rejected` attempt is live until the reconciler marks it `dead`.

The reconciler never creates a new attempt and never signs.

### 9.3 Watcher

Every 60 s (review SEC-15: counters, not a signature scan, in v0):

1. Read the vault account at `finalized`: `claim_count`, `total_claimed`, `paused`, `admin`, `guardian`, `claim_authority`, `max_per_claim`, `max_per_day`. The values are written to the watcher document's last observation (§6.8). Compare `admin`, `guardian`, `claim_authority`, `max_per_claim` and `max_per_day` with `expected_vault_config` in the watcher document. It is written together with the baseline (step 3) and replaced only inside the `rail/resume` transaction, where the operator acknowledges the observed values recorded in the latch cause (§7.8). Any difference sets the latch (`vault_config_changed`, evidence = the observed values) and raises `ops.solana.rail_halted` on every tick until it is acknowledged; because the cause key contains the observed values, a persisting difference is recorded once and a further change is recorded as a new cause. An intended change (for example the Tier B rotation) is confirmed this way.
2. Read from the DB, for `solana_vault` = the configured vault (the demo-mint vault is a different vault and is excluded):
   - `N_paid`, `Σpaid`: count and `bigint` sum of `solana_amount_atomic` over `finalized` rows;
   - `N_inflight`, `Σinflight`: the same over `sending`, `submitted` and `needs_review` rows.
3. **Baseline:** `solana_rail_state._id = 'watcher'` holds `baseline_claim_count` and `baseline_total_claimed`, written once by CAS on the first tick for the vault, and only while `N_paid = 0` and `N_inflight = 0`. The sender holds until the baseline exists, so no claim can land between the baseline read and the first payout. If no baseline exists while `N_paid > 0` or `N_inflight > 0`, the watcher sets the latch (it cannot prove conservation).
4. **Conservation**, as `bigint`:

```
Σpaid <= total_claimed - baseline_total_claimed <= Σpaid + Σinflight
N_paid <= claim_count - baseline_claim_count   <= N_paid + N_inflight
```

   Any violation means an unexplained onchain payout or a lost one: set the latch, raise CRITICAL `ops.solana.rail_halted`, and signal the guardian.
5. **Released rows:** for every `released` row of the last 30 days, read its receipt PDA; if it exists, the payout landed after release (a double payment): latch plus CRITICAL.
6. **Non-terminal rows whose receipt exists** at `finalized` are finalized through T12 with the reconciler's exact checks.
7. Balance alerts: vault token balance below `SOLANA_WITHDRAW_VAULT_LOW_ATOMIC` gives `ops.solana.vault_low`; fee payer below `SOLANA_WITHDRAW_FEE_PAYER_MIN_LAMPORTS` gives `ops.solana.fee_payer_low`.

Alerts carry no wallet address and no signature, only the withdrawal id and a masked member reference. The four `ops.solana.*` events (`vault_low`, `fee_payer_low`, `payout_needs_review`, `rail_halted`) plus `ops.solana.flow_stale` are added to `ops-alert-event.catalog.ts` and its spec.

### 9.4 What each loop may not do

| Loop | Never |
|---|---|
| sender | broadcast an attempt that is not persisted; simulate a signed transaction; use a durable nonce; call RPC inside a transaction; mark anything `finalized` or `released` |
| reconciler | sign or create an attempt; release; mark `finalized` without a finalized receipt with a matching tuple; change state on an RPC error |
| watcher | send, rebroadcast or release; clear the latch |
| admin `reverify` | send or release |

### 9.5 Release proof (admin `cancel` only)

A reservation is returned only when the chain proves the payout can never land. **In v0 the release proof is available on devnet only.** On mainnet, cancel is refused (`503 SOLANA_RELEASE_NOT_PROVABLE`, `mainnet_release_disabled`) until the proof is required to agree across **two independent RPC providers** (review SEC-4). Stuck mainnet rows stay reserved: they are resent, or they wait in `needs_review`. v0 has no other way to return a mainnet reservation. The SEC-4 fallback (an audited admin wallet adjustment after a manual Explorer review) is P1 scope. It may be specified only together with its own terminal claim state, reached only from `needs_review` with every attempt dead, refused by `retry` and `cancel`, and with any later receipt for the row treated by the watcher as a double payment. Until then, any wallet adjustment that credits back the THB of a non-terminal `solana_usdc` row is forbidden, because a later resend, `retry` or late landing would pay the member twice.

**Preconditions** (state, lease or acknowledged-tuple failure: `409` as in §7.3; latch set or config incomplete: `503 SOLANA_RAIL_UNAVAILABLE`; deployment mismatch: `503 SOLANA_RELEASE_NOT_PROVABLE` with `deployment_mismatch`; wire decode failure: `503 SOLANA_RELEASE_NOT_PROVABLE` with `wire_decode_mismatch`; RPC failure: `503 SOLANA_OUTCOME_UNKNOWN`; state unchanged in every case):

- the row is `reserved`, `needs_review`, or `submitted` with every attempt marked dead, and no lease is live;
- the acknowledged `(payout_id, recipient, amount_atomic)` equals the row exactly;
- the latch is clear and the config is complete;
- the row's deployment fields (§3.8 step 1) equal the running config (failed name `deployment_mismatch`); P5 reads the receipt PDA derived from the row's own `solana_vault` and `solana_program_id`;
- for every attempt, the release assessor **decodes `wire_base64`** and takes the values from the wire, not from side fields (review SEC-13): the first signature equals `attempt.signature`; the recent blockhash equals `attempt.blockhash`; the lifetime is a blockhash, not a durable nonce (the first instruction is not `AdvanceNonceAccount`); the `claim` instruction's `payout_id` and `amount` equal the row; `expires_at` is read from the `claim` data. `last_valid_block_height` is taken from the attempt record, which was persisted from the same `getLatestBlockhash` response as the wire's blockhash.

**The five conditions**, read in the reconciler's order, all at `finalized` except the P2 blockhash check:

| # | Condition |
|---|---|
| P1 | The RPC genesis hash equals the pinned genesis of the cluster. |
| P2 | The finalized block height `H` > max(`last_valid_block_height`) over all attempts, **and** `isBlockhashValid(blockhash, {commitment: "processed"})` is `false` for every attempt's wire blockhash. Height is the decisive condition. The blockhash check uses `processed` because a `finalized` bank also reports `false` for a blockhash newer than itself. |
| P3 | The finalized Clock `unix_timestamp` > max(`expires_at` decoded from each wire) + 120 s. This is the independent second stop: the program refuses `now > expires_at`. |
| P4 | `getSignatureStatuses` on every attempt signature with `searchTransactionHistory: true` shows no success. |
| P5 | The receipt PDA is absent at `finalized` with `minContextSlot` >= the slot observed with `H`. |

A row with zero attempts satisfies P2 to P4 trivially; nothing was ever persisted, so nothing was ever broadcast.

**Effect** (T15). The T15 compare-and-set filters on `{_id, solana_claim_state: <state the assessor read>, solana_lease_owner: {$exists: false}, "solana_attempts.<k>": {$exists: false}}`, where k is the number of attempts the assessor decoded. An attempt pushed after the assessment makes it fail with `409 SOLANA_ADMIN_STATE_CONFLICT`, and `signatures_checked` lists exactly those k signatures. In one transaction after all reads: `solana_claim_state: 'released'`, `status: 'rejected'`, `rejection_reason: 'solana_release_proven'`, `solana_released_at`, unset `solana_slot_active`, delete the sponsorship row, `appendRequired 'withdraw.solana_released'`, and store `solana_release_proof`:

```
{ assessed_at, genesis_hash, finalized_slot, finalized_block_height, finalized_unix_timestamp,
  max_last_valid_block_height, max_expires_at, signatures_checked: [base58...],
  receipt_absent_at_slot, rpc_provider_label, acknowledged_by, reason }
```

`rpc_provider_label` is a configured name, never the RPC URL (which is a secret).

### 9.6 Heartbeat (review GRAPH-8)

- No per-job heartbeat registration exists today. The rail adds three keys to `SCHEDULED_FLOW_KEYS`: `solana_sender`, `solana_reconciler` and `solana_watcher`, each wired to its loop in the same PR (a key without a writer reads as a permanent outage).
- Each tick that runs its work writes its `scheduled_flow_health` document (`last_run_at`, `last_outcome`, `last_ok_at`); a tick that throws records `failed`. A tick skipped by a brake or a gate writes **nothing**, so a braked flow reads as stale. That is intended: a stale watcher holds the sender (D-W6, §13), and a stale sender makes the challenge refuse with `maintenance`.
- **Stale reader:** the existing `SchedulerHeartbeatWatchdogCron` tick (exempt from the cron gate because it must run on the non-owner web service) also reads the three keys when `SOLANA_WITHDRAW_ENABLED === 'true'` in its own environment. Stale thresholds: sender 60 s, reconciler 60 s, watcher 300 s. A stale key raises `ops.solana.flow_stale`.
- The challenge gate (section 7.1, step 5) reads `solana_sender.last_ok_at` and refuses with `maintenance` if it is older than 60 s.
- `describeSchedulerOwnership` gains a `solana_sender` field, appended at the end as its header requires.

---

## 10. Mobile Wallet Adapter

Android only, `@solana-mobile/mobile-wallet-adapter-protocol` pinned `2.3.0`, lazily imported from `src/solana/mobileWallet.android.ts`. iOS, web and unsupported builds resolve to a stub that reports "unavailable", and the Solana UI is hidden by `resolveSolanaWalletMode`. The production-dappstore channel has the Solana UI off and never calls MWA.

### 10.1 App identity

| Build channel | API | Cluster | `identity` passed to `authorize` |
|---|---|---|---|
| `dappstore-devnet` (and development builds) | preview | devnet | `{ name: 'GoGoCash', uri: 'https://app-staging.gogocash.co', icon: 'android-chrome-192x192.png' }` |
| `dappstore-pilot` | production | mainnet | `{ name: 'GoGoCash', uri: 'https://app.gogocash.co', icon: 'android-chrome-192x192.png' }` |

- `icon` is relative and is resolved by the wallet against `uri`. Both hosts served `/android-chrome-192x192.png` (HTTP 200, `image/png`, 8588 bytes) on 2026-10-02. The source is `apps/app/public/android-chrome-192x192.png`.
- `identity.uri` must string-equal `GET config` `siws_uri` (§4.4). On mismatch the app treats Solana wallet mode as unavailable (fail closed) and makes no MWA call. A devnet build pointed at production, or the reverse, therefore cannot reach a wallet prompt.
- The Digital Asset Links for these hosts are the per-environment `assetlinks` files (plan §4, "assetlinks per environment"). This contract does not depend on any wallet enforcing them.

### 10.2 Chain ids

- `authorize` uses `chain: 'solana:devnet'` or `chain: 'solana:mainnet'` from `GET config` `cluster`. The deprecated `cluster` parameter is never passed. On a legacy-protocol wallet the library maps these values itself.
- **-7 (chain not supported) on `solana:devnet`:** retry `authorize` **once**, in the same session, with `chain: 'solana:mainnet'`. This is safe because the member signs only a message and never a transaction. The message still says `Chain ID: solana:devnet` and names devnet in the statement. The app records the chain actually authorized and uses it for Session B.
- -7 on mainnet → "wallet not supported" copy.

### 10.3 Flow: two sessions (default)

```
Session A  transact(wallet =>
             authorize({ identity, chain, auth_token?: cached }))
           -> copy out plain data { address_b64: accounts[0].address, auth_token, wallet_uri_base, authorized_chain }
           -> session ends
App        address_b58 = base64ToBase58(address_b64)
           POST /withdraw/solana/challenge { amount, currency, recipient: address_b58 }  (no wallet session open)
           -> { challenge_id, quote, message (base64 of exact bytes), ttl_seconds, ... }
           app checks: message is printable ASCII, <= 1024 bytes, line 2 == address_b58; else abort
           show full address_b58 and the response quote (payout_amount_atomic, deducted_minor, fee_minor); member taps Confirm
Session B  transact(wallet =>
             authorize({ identity, chain: authorized_chain, auth_token })   // silent re-authorize
             assert accounts[0].address == address_b64 (byte-equal), else abort before signing
             signMessages({ addresses: [address_b64], payloads: [message_bytes] }))
           -> copy out signed_payloads[0] -> session ends
App        P = base64decode(signed_payloads[0]); require len(P) >= 64
           signature = P[len-64 ..]; prefix = P[.. len-64]
           require prefix is empty or byte-equal message_bytes (else: wallet altered the message; do not submit)
           POST /withdraw/solana/withdrawals  Idempotency-Key: solana-<challenge_id>
             { challenge_id, address: address_b58, signed_message: base64(prefix), signature: base58(signature) }
           network failure -> retry with the same key and the same body (replay-safe, §7)
```

Rules:
- **No network call inside a wallet session** in the default flow.
- **New challenge per sign attempt.** After any failure in Session B (declined, timeout, cancel, wallet error), the app returns to the confirm screen. The next attempt requests a new challenge. Unused challenges expire.
- **Local deadline.** The app starts a monotonic timer when the challenge response arrives. If `ttl_seconds − 10 s` has elapsed before Session B starts, it requests a new challenge instead of signing.
- **Confirm screen.** The local deadline (`ttl_seconds − 10 s`, monotonic, started when the challenge response arrives) also runs while the confirm screen is shown. Leaving the confirm screen abandons the challenge, and the next Confirm requests a new one.
- **Address change.** If Session B's `authorize` returns a different first account, the app aborts without signing, clears the cached token (10.6) and restarts from Session A.

### 10.4 Single-session fallback

- **Trigger:** Session B's silent `authorize` fails with **-1**, using the token Session A minted moments earlier. This means the wallet does not honour silent re-authorization.
- The app marks that wallet (key: `wallet_uri_base`, or `unknown` if null) as single-session **for the app process only**, and asks the member to tap once more. There is no automatic retry.
- **Fallback session:** `transact(wallet => authorize → POST challenge (15 s HTTP timeout) → signMessages)`. Then `POST withdrawals` runs after the session ends, as above.
  - There is no in-app confirm step. The wallet's sign sheet shows the full message, including the address and amounts, and that sheet is the confirmation.
  - If the fallback `authorize` returns an address different from the one the member confirmed, the app aborts without creating a challenge and restarts from Session A.

### 10.5 Encodings in the app

- The app does not import `@solana/kit`. Base58 encoding of the address and signature uses the MWA package's own `@solana-mobile/mobile-wallet-adapter-protocol/encoding` helpers (`base64ToBase58`, `base58FromUint8Array`), which are lazily imported with the Android module.
- MWA payloads and addresses are standard base64.
- The app does not validate base58 for security; the server does (§5.4).

### 10.6 `auth_token` storage

| Property | Rule |
|---|---|
| Store | `expo-secure-store` (Android Keystore-backed). Never AsyncStorage, MMKV, logs or analytics. |
| Key | `gogocash.solana.mwa.v0.<user_id>.<cluster>`, with `<cluster>` ∈ {`devnet`, `mainnet`} from config. expo-secure-store keys allow only `[A-Za-z0-9._-]`, so no `:`. Exactly two possible keys per user, which makes deletion deterministic (SecureStore cannot list keys). |
| Value | JSON `{"v":0,"auth_token":"…","authorized_chain":"solana:devnet"\|"solana:mainnet","wallet_uri_base":"https://…"\|null,"stored_at_ms":<int>}`. **No wallet address**: the address lives only in memory and on the server row, never in a saved method (rule #951). `wallet_uri_base` is kept only if it starts with `https://`. |
| TTL | 30 days from `stored_at_ms`. An older entry is deleted on read and treated as absent. Every successful `authorize` overwrites the entry with the newly returned token and a new `stored_at_ms`. |
| Cleared on | (a) **-1** from any `authorize`. When the token was cached, one fresh Session A without a token follows. (b) The member taps **"Use a different wallet"**: delete, then run Session A with no token and no `baseUri`. v0 makes no `deauthorize` call. (c) **Logout or session teardown**: `clearMobileAppSession` deletes both keys for the signed-in user, including the 401 teardown path. (d) An address change in Session B (10.3). |
| `baseUri` | Session A and Session B pass `wallet_uri_base` as `baseUri` when one is stored. On `ERROR_WALLET_NOT_FOUND` with a `baseUri`, retry once without it. |

### 10.7 Never keep or serialize the wallet object

The `wallet` passed to the `transact` callback is a `Proxy`. Every property read except `then` creates a function that sends an RPC to the wallet. For example, `JSON.stringify(wallet)` reads `toJSON` and sends method `to_j_s_o_n`. After `transact` returns, the native session is gone, and any call throws.

Rules:
- Use `wallet` only inside the callback.
- Never store it in React state, refs, context, a module variable or a closure that outlives the callback.
- Never log it, spread it, pass it to Sentry, PostHog or any serializer, or return it from the callback.
- Return only plain values copied out of results. An import-boundary or lint test enforces this.

### 10.8 Error mapping (**PROVISIONAL**, GRAPH-17; frozen from the B0 raw-code capture, #2993)

- `transact` rejects with `SolanaMobileWalletAdapterProtocolError` when the native side rejects with `JSON_RPC_ERROR`. Its `code` is the raw JSON-RPC number taken from `userInfo.jsonRpcErrorCode`.
- Any other native rejection becomes `SolanaMobileWalletAdapterError`, whose `code` is the **native rejection string**.
- Classify on the **raw `code`** (number or exact string), never on `message` and never on the library's named constants. The 2.3.0 JS constant table names -5 `ERROR_TOO_MANY_PAYLOADS`, which contradicts the MWA spec.

| Raw `code` | Origin (MWA 2.3.0, RN Android) | Handling |
|---|---|---|
| `-1` | `ERROR_AUTHORIZATION_FAILED` (declined or identity failure) | Clear the token (10.6). If the token was cached: one fresh Session A. In Session B: single-session fallback (10.4). Otherwise "declined" copy. |
| `-2` | `ERROR_INVALID_PAYLOADS` | Bug: report; generic copy. |
| `-3` | `ERROR_NOT_SIGNED` (member declined) | Keep the token. No automatic retry. "You declined to sign" copy. |
| `-4` | `ERROR_NOT_SUBMITTED` (we never sign-and-send) | Report; generic copy. |
| `-5` | Spec: `ERROR_NOT_CLONED`. Unused, since we never clone. | Report; generic copy. |
| `-6` | Spec: `ERROR_TOO_MANY_PAYLOADS` | Bug: report; generic copy. |
| `-7` | Spec: `ERROR_CHAIN_NOT_SUPPORTED` | devnet: retry once on `solana:mainnet` (10.2). mainnet: "wallet not supported" copy. |
| `-100` | `ERROR_ATTEST_ORIGIN_ANDROID`: a **web-origin attestation** challenge, **not** a Digital Asset Links failure | Report; "wallet could not verify GoGoCash" copy. Never used as a DAL signal. |
| other number | Wallet-specific JSON-RPC error | `wallet_error`: report; generic copy. |
| `'ERROR_WALLET_NOT_FOUND'` | `ActivityNotFoundException`: no MWA wallet installed | With `baseUri`: retry once without it. Otherwise "install a Solana wallet" copy. |
| `'Session not established: Local association cancelled by user'` | Member backed out of the wallet chooser or association | "Cancelled" copy. Keep the token. |
| `'Timed out waiting for local association to be ready'` | Association not ready within 10 s | Timeout copy. |
| `'Timed out waiting for response'` | No wallet response within 90 s | Timeout copy. In Session B no signature exists, so the app requests a new challenge on retry. |
| `'Failed to end session'` | The native `endSession` rejected in `transact`'s `finally` | If the callback already produced its result (the app captures it in an outer variable before `transact` settles), use that result. Otherwise generic copy. |
| `'EUNSPECIFIED'` | React Native's default code for a bare-Throwable rejection | `wallet_error`: report; generic copy. |
| `'ERROR_SESSION_TIMEOUT'`, `'ERROR_SESSION_CLOSED'`, `'ERROR_ASSOCIATION_CANCELLED'` | Browser build only; not emitted on RN Android | Same handling as the timeout and cancel rows, kept for safety. |
| error without `code` | JS error, such as the non-Android Proxy or `LINKING_ERROR` | Bug: report; "unavailable" copy. |

- **Source evidence:** `node_modules/@solana-mobile/mobile-wallet-adapter-protocol` 2.3.0.
  - `lib/cjs/index.native.js`: `handleError` and `transact`;
  - `android/…/SolanaMobileWalletAdapterModule.kt`: `promise.reject` codes, `ASSOCIATION_TIMEOUT_MS = 10000` and `CLIENT_TIMEOUT_MS = 90000`;
  - React Native `PromiseImpl.kt`: `ERROR_DEFAULT_CODE = "EUNSPECIFIED"`.
- **Fixture:** `test/fixtures/mwa-errors.provisional.json`. It is renamed to `mwa-errors.json` only after the B0 device capture (#2993) confirms or corrects every row.

---

## 11. Fixtures

A follow-up PR adds these files under `test/fixtures/` in the public repo. They land in **v0.1**, together with the generator (`scripts/gen-fixtures.mjs`, run as `node scripts/gen-fixtures.mjs --check` in CI, which regenerates every file in memory and fails on any byte difference). The generator ports the research scripts used for this document; the earlier research vectors are not committed (D-C4). Every file is deterministic: keys come from seeds `sha256("gogocash contract v0 test key <n>")`, ids come from fixed id sets, and there is no clock or randomness at generation time.

Common format: UTF-8 JSON, two-space indent, LF line endings, keys in a fixed order, a top-level `{"contract": "v0", "file": "<name>", "vectors": [...]}`. Every `bigint` is a decimal string, every byte string is lowercase hex unless the field name ends in `_b58` or `_b64`, and every vector has a unique `id` (for example `thb_with_fee`) that specs reference by name.

| File | Content | Vector fields (summary) |
|---|---|---|
| `clusters.json` | §2.1 to §2.4: cluster keys, genesis hashes, wallet chain ids, token/system program ids, USDC mints and decimals, program ids (`devnet` placeholder, `mainnet` `null`) | `cluster`, `genesis_hash`, `chain_id`, `usdc_mint`, `usdc_decimals`, `program_id` |
| `accounts.json` | §3.2 and §3.4: Vault, Receipt and `PayoutClaimed` layouts with offsets, the discriminators of every account, instruction and event, the decode vectors, and the instruction data vectors of §3.3 | `kind`, `fields` (name, offset, size, type), `discriminator`, `inputs`, `bytes` |
| `errors.json` | §3.5 to §3.7: every program code, every mapped Anchor and system code, with name, exact message, raising step and class, plus the instruction-index rules | `code`, `name`, `message`, `raised_by`, `instruction`, `class` |
| `pda.json` | §2.4 PDA vectors (ProgramData, Vault, vault ATA, Receipt) per cluster and mint, parameterised by program id. In v0.1 the vectors under the real devnet id replace the placeholder vectors. | `program_id`, `cluster`, `seeds`, `address`, `bump` |
| `siws.json` | §4: rendered consent messages from fixed inputs, with byte length, sha256 and expected `verifyConsentSignature` result, including `consent_devnet_thb_with_fee`, a worst-case-length vector and the tamper negatives (amount +1, trailing LF, CRLF) | `inputs`, `message_b64`, `byte_length`, `sha256`, `signer_b58`, `signature_b58`, `expect` |
| `ed25519.json` | §4.7 and §5.4: positive vectors and the negatives (8 small-order keys, non-canonical A and R, S >= L, wrong message, wrong key, wrong signer), plus strict base58 positives and negatives | `public_key`, `message`, `signature`, `expect` (`ok` or the reason string) |
| `amounts.json` | §6.3 and §6.4: conversion vectors under both dust policies, including the five worked examples, bounds refusals and the satang and USDC display formats | `requested_minor`, `fee_minor`, `thb_per_usd_e8`, `usdc_atomic`, `value_minor`, `deducted_minor` per policy, `remainder_minor`, `expect` |
| `states.json` | §8: the claim states, the transition table T1 to T15 (from, to, actor, guard names), every refused transition, and the display and ledger mapping | `from`, `to`, `actor`, `guards`, `allowed`, `display_state`, `ledger_status` |
| `mwa-errors.json` | §10.8: raw MWA rejection `code` (number or exact string) to handling class and copy key. It lands as `mwa-errors.provisional.json` and is renamed only after the B0 capture (#2993) confirms or corrects every row. | `code`, `origin`, `handling`, `copy_key`, `provisional` |

**Who runs the parity checks against these files:**

| Consumer | Check |
|---|---|
| Program R2 (public repo) | LiteSVM tests decode `accounts.json`, raise every `errors.json` code at its listed step, and derive `pda.json` |
| SDK R3 (public repo) | the generated client, `verify-receipt`, `siws`, `errors` and `clusters` modules reproduce every vector byte for byte |
| API A0 and A3 (monorepo) | the vendored package and `packages/contracts/src/solana-payout.ts` parity spec read the vendored fixtures: strict base58, genesis hashes, mints, state list, amounts, consent render and verify, error classifier |
| App B2 (monorepo) | the MWA error mapper has one unit test per `mwa-errors` row, and the encoding helpers reproduce the `siws.json` base64 and base58 strings |

## 12. Open items

| # | Item | Owner | Blocks |
|---|---|---|---|
| O1 | **Founder decision D4 (dust owner).** v0 default: the member keeps the remainder (`member_keeps_remainder`). The alternative (`treasury_keeps_remainder`) is fully specified. For THB at any rate below 10,000 THB/USD both deduct identical satang, so the choice is about principle only (§6.3). | founder | the default in v0.1 if flipped |
| O2 | Real devnet program id and the per-cluster PDA vectors under it (SCHED-8). Needs R1 key generation after G0a. All vectors in this document use the placeholder. | R1 / R2 | v0.1; any devnet send |
| O3 | MWA error table is PROVISIONAL (§10.8). The B0 device capture (#2993) must confirm every row, in particular whether real wallets return -7 for `solana:devnet`, and which return shape (`message ‖ signature` or signature only) Phantom, Solflare and Seed Vault use. | B0 | v0.1 `mwa-errors.json` |
| O4 | Whether `initialize` should also check a hardcoded per-cluster USDC mint. v0 checks only `decimals == 6` and relies on upgrade-authority gating and the manifest pin (D-P6). | founder / security review | none in v0 |
| O5 | Whether admin instructions should emit events. Cut in v0 (D-P10); appending events later is allowed. | R2 | none |
| O6 | **Unverified:** the system program log text "already in use" was verified in Agave v3.0.0 `system_processor.rs`, while both clusters report `apiVersion` 4.3.0. Classification does not depend on the text (`Custom(0)` at the `claim` index routes to receipt verification), but the LiteSVM test must assert the log on the pinned version. | R2 | none |
| O7 | Add a consent fixture with a non-zero remainder. It needs a synthetic rate at or above `10^12`, which the production FX band refuses, so it tests the renderer only. | fixture generator | v0.1 fixtures |
| O8 | `SOLANA_WITHDRAW_FEE_FLOOR_MINOR` and `SOLANA_WITHDRAW_ATA_FEE_MINOR` must be set by founder or ops in satang (no SOL price feed in v0). The rail config is incomplete until they exist. | founder / ops | any devnet send |
| O9 | The FX provider publishes once per UTC day with 2-decimal THB. The 26 h maximum age is acceptable for devnet and P1; P2 needs two independent sources at most 1 h old. | API | P2 |
| O10 | **Unverified:** whether the devnet RPC provider supports `getSignatureStatuses` with `searchTransactionHistory: true`. Without history, a landed attempt can look foreign and trip the latch (safe, but noisy). | API / ops | devnet pilot quality |
| O11 | The five new collections and the `solana_*` fields must be registered in the Mongo to Postgres migration data contract (#3009 / #3044 sweep; vendor PlanetScale Postgres since 2 Oct 2026). No ticket owns this yet. | API | A-series PR that adds the schema |
| O12 | **Unverified:** preview sleep and CRON ownership (FEAS-4 / SCHED-10). With the watcher-heartbeat gate, the sender holds for up to one watcher tick after every wake. | ops | devnet demo latency |
| O13 | Allowlist write path: v0 specifies audited `superadmin` routes (§7.3). Confirm this against a one-off seeding script for the 5 judge accounts on preview. | founder | none |
| O14 | Mainnet release proof is disabled in v0 until the proof must agree across two independent RPC providers (SEC-4). Stuck mainnet rows stay reserved. The SEC-4 adjustment fallback needs that terminal state before P1; v0 forbids crediting back a non-terminal Solana row. | API | mainnet pilot |
| O15 | **Unverified:** the compute-unit caps (60,000 with the ATA present, 90,000 without, §9.1) against the program's 45,000 CU target for `claim`. They are confirmed only by `cu-report.json` after the R2 build. | R2 / API | first devnet send |
| O16 | Changes made while merging the sections (D-X1 to D-X10 in §13) and the review corrections (D-R1 to D-R29 in §13) should be acknowledged by the section owners before the tag. None changes a frozen account layout, instruction or program error code; the review corrections add API error codes, admin response shapes, one row field (`solana_sim_retries`) and offchain checks. | section owners | the `contract-v0` tag |
| O18 | Whether R2 should also enforce `claim_authority != upgrade authority` onchain in `initialize` (6020 `RoleConflict`, using the ProgramData account it already reads). v0 enforces it offchain only (admin CLI §3.3.1, rail §7.7). Adding it later changes the "Raised by" column of a frozen code, so it must be decided before the tag. | founder / security review | the `contract-v0` tag, if wanted |
| O17 | Values observed on 2 Oct 2026 (rent minimums, mint freeze authorities, icon hosts, today's FX rate) are informational. Runtime code must read them live; they are not pinned. | all | none |

## 13. Decisions made in v0

Where the plan left a choice open, the safest simple option was taken. Earlier statements that a decision supersedes are noted.

### Program and clusters

| # | Decision | Reason |
|---|---|---|
| D-P1 | Added `decimals: u8` at Vault offset 11. | The frozen field list totals 323 bytes; the frozen size is 324. This is the smallest change that keeps `reserved[64]`, and it lets clients display amounts without fetching the mint. |
| D-P2 | The vault is created paused; `unpause` is a separate admin step. | Nothing can be claimed before the SEC-5 ceremony check and funding. |
| D-P3 | All business checks run in the handler (S5) in a fixed order; account structs use only Anchor type, `mut`, `seeds`, `init` and `associated_token` constraints. | Deterministic, Anchor-independent ordering of custom codes; every check maps to one code. |
| D-P4 | `C1 Paused` is the first handler check. | Under pause every new claim reports one `hold` code; replays still report "already in use" (S2) and resolve through receipt verification. |
| D-P5 | `claim_authority` must differ from both `admin` and `guardian` (initialize, update_config, propose/accept admin). | The plan requires admin != claim_authority; extending it to the guardian costs nothing and keeps the hot key single-purpose. |
| D-P6 | `initialize` requires `mint.decimals == 6`; no mint address is hardcoded in the program. | Atomic-unit math assumes 6; the per-cluster mint is pinned by the manifest and the rail config, and only the upgrade authority can initialize (O4). |
| D-P7 | `pause` and `unpause` are idempotent. | The guardian's emergency pause must never fail because of state. |
| D-P8 | `propose_admin(default)` cancels a proposal. | No extra instruction needed. |
| D-P9 | `recipient_token_account != vault_token_account` has no custom code; it is enforced by Anchor 2040 (S3) and is also implied by `recipient != vault`. | Avoids an unreachable custom code. |
| D-P10 | Only one event (`PayoutClaimed`, 184 bytes); admin instructions emit none. | Admin actions are rare and attended; watchers read vault state. Events can be appended later (O5). |
| D-P11 | The R1 `ping` stub is removed in R2. | The v0 instruction set is exactly the 8 instructions in §3.3. |
| D-P12 | At the `claim` index, 3011 is `needs_review`; 2015 is `bug`, because a re-owned ATA already fails at the ATA index with `Custom(0)` (`needs_review`). `Custom(0)` is `already_claimed` only at the `claim` index. | 3011 can be caused by the member's own account (a program-owned address); 2015 at `claim` can only come from our transaction naming a wrong account (Anchor 1.2.0 order 2023, 2015, 2009). |
| D-P13 | v0 uses the placeholder program id on devnet only; building with `--features mainnet` is a `compile_error!`; `programIds.mainnet` is `null`; the rail config is incomplete unless the program account is executable and owned by the upgradeable loader. | SCHED-8: no real ids until v0.1, and no mainnet id until P1 is re-planned. A v0 build can never send. |
| D-P14 | `expires_at` is the cluster Clock sysvar read at `confirmed`, plus 300 s; the program accepts at most 900 s ahead. | Keeps C11/C12 independent of server clock skew; the 900 s upper bound leaves room for slow landing. |
| D-P15 | The error table has 24 codes (6000-6023) with 6008 = `ZeroPayoutId` and 6018 = `InvalidVaultTokenAccount` as the plan pinned. `DayCapExceeded` is `hold` (SEC-9); `VaultTokenAccountFrozen` is `hold` plus CRITICAL plus the latch; `Expired` is `retry`; `InvalidClaimAuthority`, `InvalidMint`, `InvalidVaultTokenAccount` and `NotUpgradeAuthority` are `config`. | One class per code, so the SDK and the rail cannot disagree. |

### Consent message

| # | Decision | Reason |
|---|---|---|
| D-C1 | `Chain ID` and the MWA `authorize` chain are `solana:devnet` / `solana:mainnet` (Wallet Standard ids, `@solana/wallet-standard-chains`). The genesis hash itself (§2.1) is the cluster identity check; the CAIP-2 genesis form is not used anywhere in v0. | SIWS accepts these ids and MWA `authorize` uses them. |
| D-C2 | No trailing newline. Exactly 16 lines with LF separators; CRLF or a trailing LF fails verification. | One byte form, testable with negatives. |
| D-C3 | Single-line English statement, whatever the app locale; it names the USDC amount, the THB deducted (including the fee), the fee and the cluster. | EIP-4361 forbids `\n` in the statement, and the wallet-standard parser treats a multi-line statement ambiguously. |
| D-C4 | Resources are, in order, `gogocash:payout:<64 hex>`, `gogocash:amount:<u64>` and `solana:<cluster>:<program id>`. This supersedes the earlier research vectors (`gogocash:payout_id:`, `gogocash:amount_atomic:`, `gogocash:program_id:`, statement variants with `(fee THB ...)`); those vectors are not committed and are regenerated by the §11 generator. | One frozen template. |
| D-C5 | Hard cap 1024 bytes, against a computed worst case of 813. | Checked by both renderer and verifier. |
| D-C6 | The address line is both signer and recipient. In v0 a member can withdraw only to the wallet that signs. | No third-party recipients. |
| D-C7 | Timestamps use the `toISOString()` form `YYYY-MM-DDTHH:MM:SS.sssZ`. The intake window is `[issued_at − 5 s, expiration]` on the server clock read once per request. `Not Before` is never emitted. Send time uses no clock (SEC-7). | One format; device clocks are never trusted. |
| D-C8 | Encodings: every Solana key and signature on the API, including the consent `signature`, is strict base58; `message` and `signed_message` are standard padded base64. | One encoding per value class. |
| D-C9 | A send-time consent failure (re-render, signature or tuple) is `needs_review` plus CRITICAL plus the halt latch. | It means the stored row was altered. |
| D-C10 | MWA `identity.uri` must equal `GET config` `siws_uri`, else Solana mode fails closed. | A build pointed at the wrong environment cannot reach a wallet prompt. |

### Identifiers

| # | Decision | Reason |
|---|---|---|
| D-I1 | `payout_id` is 32 CSPRNG bytes drawn at challenge time, stored as a 64-character lowercase-hex string, write-once, with unique indexes on the challenge collection and the withdraws collection. | Simplest exact-match form; identical in API, DB, fixtures and consent text; not linkable to withdrawal ids. |
| D-I2 | Non-canonical case is rejected (400), never normalized, for every hex and base58 field. | Normalization creates two encodings for one value. |
| D-I3 | The nonce gets its own unique index. | Costs nothing and turns any RNG fault into a hard error. |
| D-I4 | `withdrawal_id` is pre-allocated at challenge time. | So it can appear in the signed `Request ID` and be polled after a lost submit response. |

### Amounts and ledger

| # | Decision | Reason |
|---|---|---|
| D-L1 | **D4 default:** the member keeps the remainder (`deducted = ceil(usdc_atomic x rate / 10^12) + fee`, never more than requested). The alternative is selectable through `solana_dust_policy` and is fully specified. Supersedes #2987 / A3 "dust stays with the treasury". | Never over-deducts; numerically identical for THB below 10,000 THB/USD (O1). |
| D-L2 | The fee comes out of the gross requested amount, as on the bank lane. | Same member-facing meaning of `amount` on every lane. |
| D-L3 | v0 is THB-only: other ledger currencies get `400 SOLANA_CURRENCY_UNSUPPORTED` and `GET config` `unavailable_reason: "disabled"`; the statement renders the literal `THB`. USD and 0-decimal currencies need a contract revision. Supersedes the A3 "USD lane 1:1" and the earlier `devnet_usd_no_fee` vector. | One ledger formula to test. |
| D-L4 | FX: a new no-stale `quoteThbPerUsdForSolana()`; 5 s timeout; `String(rate)` parsed to a `bigint` e8 value (no float math); the effective rate rounds up, spread default 0; maximum age 93,600 s; band 25 to 45 THB/USD; never refetched inside the submit transaction. | The existing `fetchRate` serves stale floats. |
| D-L5 | The fee floor uses operator-set THB constants, because v0 has no SOL price feed (O8). | Simple and auditable. |
| D-L6 | One wallet per member (unique `user_id` on bindings), in addition to the required unique `recipient`. | No wallet sharing, no squatting. |
| D-L7 | `amount_total` is the THB deducted including the fee; `amount_net` is the THB value sent; `withdraw_fee_base` equals `withdraw_fee_final`. | Matches `checkWithdraw` and the other lanes. |
| D-L8 | Rent observed on 2 Oct 2026 is `(len + 128) x 5,080` lamports on both clusters: receipt (89 B) 1,102,360 (about 0.0011 SOL), ATA (165 B) 1,488,440 (about 0.0015 SOL), vault (324 B) 2,296,160. The plan's figures stand. | Read live with `getMinimumBalanceForRentExemption` on both clusters; runtime always reads it. |
| D-L9 | The pilot allowlist gets its own collection, `solana_allowlist`, with a unique `user_id`. | Separate from wallet bindings. |
| D-L10 | Account purge (PDPA, #3005) deletes the member's wallet binding and allowlist entry. | A deleted account never squats a wallet (SEC-12). |

### API

| # | Decision | Reason |
|---|---|---|
| D-A1 | An expired challenge is `410 SOLANA_CHALLENGE_EXPIRED` (reason `consent_expired`), not `400` or `409`. | The only remedy is a new challenge, which the app must not confuse with conflicts that point at an existing withdrawal. |
| D-A2 | Three member-facing `unavailable_reason` values (`disabled`, `paused`, `maintenance`); internal causes are logged only. A non-allowlisted member sees `disabled`, identical to a rail that is off. | Closes the membership oracle (SEC-12). |
| D-A3 | The effect hash is `sha256("gogocash-solana-withdraw-effect-v0\n" + challenge_id + "\n" + address + "\n" + signature)`; everything else is fixed by the server-side challenge. | Strict base58 has one encoding, so retries cannot cause false mismatches. |
| D-A4 | `SOLANA_WITHDRAW_ENABLED` is opt-in; the three sub-brakes are opt-out, layered under it. | Matches the `withdraw-gate.ts` split switches. |
| D-A5 | Allowlist writes are audited `superadmin` routes in the Solana admin controller; `DELETE` also removes the binding and is refused while an active slot exists (O13). | No ticket owned them. |
| D-A6 | No on-curve recipient check at challenge; the small-order and forbidden-address checks stay, and the recipient must be absent or System-owned. | An off-curve recipient can never produce a valid consent, so the submit refuses it (SEC-14). |
| D-A7 | Per-member limits use the UTC day. | Matches the program's day cap. |
| D-A8 | A receipt landed by a transaction that is not one of ours finalizes the row (the member got exactly the tuple) but sets the latch and raises CRITICAL. | Evidence that the claim key is used elsewhere. |

### Claim states and loops

| # | Decision | Reason |
|---|---|---|
| D-S1 | The attempt is pushed in the same CAS that moves `sending` to `submitted`. | `submitted` exactly means "a persisted attempt may land". |
| D-S2 | At most `solana_attempt_limit` attempts (default 5) before `needs_review`; an admin retry adds 5. | Bounded automation. |
| D-S3 | `needs_review` keeps the active slot. | A member with a stuck payout cannot open a second one. |
| D-S4 | Admin retry is refused for `receipt_mismatch`, `consent_invalid`, `inconsistent_rpc` and `deployment_mismatch`. | Those need investigation, not a resend. |
| D-W1 | Sender every 5 s with at most 5 rows; reconciler every 10 s with at most 50; watcher every 60 s. | Small, bounded batches. |
| D-W2 | Priority fee is the 75th percentile of `getRecentPrioritizationFees` on the vault accounts, capped at 100,000 micro-lamports per CU by default. | Bounded cost. |
| D-W3 | The release proof requires the finalized block height above every `last_valid_block_height` (decisive) and `isBlockhashValid(wire blockhash, processed) === false`, because `last_valid_block_height` is not encoded in the wire; the `expires_at` check (P3) is the independent second stop. Mainnet cancel is refused in v0 (SEC-4). | A `finalized` bank reports `false` for a blockhash newer than itself, so only `processed` adds information. |
| D-W4 | The watcher also checks released rows for late receipts and halts on any vault role or cap change. | Detects double payment and key misuse. |
| D-W5 | The stale reader is folded into the existing exempt watchdog instead of a new ungated `@Interval`. | Every new `@Interval` stays behind the cron gate (GRAPH-8). |
| D-W6 | The sender holds unless the watcher baseline exists and the watcher heartbeat is fresh. | Money never moves while observation is braked or stalled. |

### Mobile Wallet Adapter

| # | Decision | Reason |
|---|---|---|
| D-M1 | Two sessions by default. The single-session fallback triggers only on -1 at Session B's silent `authorize`, and is remembered per process, not persisted. | No network call inside a wallet session in the default flow. |
| D-M2 | A new challenge for every sign attempt; challenges are never re-signed after a failure. | Each signature binds one fresh window. |
| D-M3 | The `auth_token` cache is `expo-secure-store` key `gogocash.solana.mwa.v0.<user_id>.<cluster>`, 30-day TTL, holding no wallet address (rule #951). | Deterministic deletion; no saved wallet. |
| D-M4 | No `deauthorize` call in v0. "Use a different wallet" and logout clear the token locally only. | Fewer wallet round trips. |
| D-M5 | The app uses MWA's own `/encoding` helpers for base58; no `@solana/kit` or `bs58` in app code. | No extra crypto dependencies in the app. |
| D-M6 | The error table is classified on raw `code` and stays PROVISIONAL until B0 (O3). It includes `'Failed to end session'` (use the captured callback result) and `'EUNSPECIFIED'`. | Named constants in 2.3.0 contradict the MWA spec. |

### Merge decisions (cross-section consistency)

| # | Decision | Where |
|---|---|---|
| D-X1 | The cluster key (`devnet` / `mainnet`) is the identifier in this contract, the manifest, the API and the DB; the genesis hash is the identity check. The CAIP-2 genesis form is informational only. | §2.1 |
| D-X2 | The devnet wallet is bound at the first **verified submit** (the first challenge whose consent signature verified), not at challenge. | §2.5, §7.6 |
| D-X3 | The expired-challenge refusal in the intake order is `410` (D-A1), and the nonce burn runs inside `runSerializedWithdrawForRail`. | §4.9 |
| D-X4 | The challenge response fields are `message` (base64), `ttl_seconds`, `issued_at` and `expiration_time`. The previous draft name `expires_at` was renamed so it cannot be confused with the `claim` argument `expires_at`. | §7.1, §10.3 |
| D-X5 | T5 (receipt seen at `confirmed`, or `already_claimed` in simulation) sets a new field `solana_receipt_seen_at`. If the receipt is still absent at `finalized` 60 s later, the reconciler moves the row to `needs_review` (`inconsistent_rpc`), as §3.8 requires, instead of taking the vacuous "every attempt dead" path back to `reserved`. T10 requires the field unset and at least one attempt. | §3.8, §6.7, §8.2, §9.2 |
| D-X6 | Transaction-level errors without an instruction index are classified in §9.1: `BlockhashNotFound` and `AccountInUse` are `retry`; `InsufficientFundsForFee` and `InsufficientFundsForRent` are `hold` (`fee_payer_low`); any other is `bug`. | §3.7, §9.1 |
| D-X7 | The halt latch setters include the sender (`bug` and `config` classes, 6014, consent invalid at send). | §7.8 |
| D-X8 | No per-member cap on outstanding unconsumed challenges beyond the challenge rate limit (10 per minute per member). Challenges reserve nothing and expire after the TTL. | §7.1 |
| D-X9 | `contract-v0` is the first signed tag; v0.1 is the next one. | §1, §2.4 |
| D-X10 | Payout amounts (`amount_atomic`, `solana_amount_atomic`) are at least 1. Other atomic values (balances, caps, counters) may be 0. | §5.5 |

### Review corrections (2 Oct 2026, before the tag)

| # | Decision | Where |
|---|---|---|
| D-R1 | v0 has no way to return a mainnet reservation except a resend or `needs_review`; crediting back the THB of a non-terminal Solana row is forbidden. The SEC-4 adjustment fallback needs its own terminal state (P1). | §9.5, O14 |
| D-R2 | Deployment binding: every send, reconcile and release first requires the row's cluster, genesis, program id, mint, vault and vault ATA to equal the running config, and derives the receipt from the row's own vault and program id; a difference is `needs_review` (`deployment_mismatch`) plus CRITICAL and the latch. One claim key per vault, checked every 60 s. | §3.8, §4.9, §7.1, §7.7, §8.2, §9.1, §9.2, §9.5 |
| D-R3 | The halt latch records every cause (deduplicated by a cause key), every newly recorded cause raises CRITICAL, and `rail/resume` acknowledges the latch `version`. The watcher compares vault roles and caps with `expected_vault_config`, replaced only at resume. | §6.8, §7.3, §7.8, §9.3 |
| D-R4 | The claim authority and the fee payer must differ from the upgrade authority, admin, guardian and pending admin; enforced offchain (O18). | §3.3.1, §7.7 |
| D-R5 | Admin reverify moves a `needs_review` row only to `finalized`. | §7.3, §8.2 |
| D-R6 | The T15 compare-and-set is bound to the assessed state, lease and attempt count. | §8.2, §9.5 |
| D-R7 | P2's blockhash check uses `processed`; height at `finalized` is decisive. | §9.5, D-W3 |
| D-R8 | 2015 at the `claim` index is `bug` (supersedes the earlier D-P12 wording). | §3.3.0, §3.6, §9.1, D-P12 |
| D-R9 | Rent figures use the observed `(len + 128) x 5,080` (supersedes the earlier D-L8 correction). | §6.5, D-L8 |
| D-R10 | A `day_cap` hold retries every 60 s after the first midnight retry until the program's day rolls. | §8.2 |
| D-R11 | `SOLANA_SIWS_DOMAIN` and `SOLANA_SIWS_URI` are pinned to the §4.4 row. | §7.7 |
| D-R12 | Every rail error code is registered in the filter allowlist through `SOLANA_WITHDRAW_ERROR_CODES`, with a validated extras passthrough. | §7 |
| D-R13 | Refusals of the reused guards are listed; `wallet_frozen` is rethrown as `403 SOLANA_WALLET_FROZEN`. | §7.1, §7.2 |
| D-R14 | Membership gates run first and report `disabled`; reason precedence is `disabled`, `paused`, `maintenance`; the ledger currency is the market's `fee_lane`. | §6.2, §7.1 |
| D-R15 | The app calls the challenge before the confirm screen, and the local deadline covers that screen. | §10.3 |
| D-R16 | Admin refusals have codes; admin success responses are defined. | §7.3, §9.5 |
| D-R17 | Allowlist removal is refused while a slot is active; the submit re-reads the allowlist inside the transaction on both clusters. | §7.1, §7.6 |
| D-R18 | Admin row view, `GET rail` body and the `withdraw-all` projection are defined. | §7.3 |
| D-R19 | Fee wiring follows the real `resolveWithdrawFeePreview` signature; `toWithdrawMinorUnits` is the single float-to-integer conversion, used at two boundaries (policy fee and `checkWithdraw` balance). | §6.1, §6.5 |
| D-R20 | The submit re-checks the payout amount against the configured bounds only; a lowered onchain cap surfaces as 6010 at send time. | §6.4, §7.1 |
| D-R21 | Only the reconciler writes `dead`, `landed` and `failed`; "dead" means `dead` or `failed`. | §9.2 |
| D-R22 | 3012 is `config` for the rail; consecutive `retry` simulations are capped at 5 by `solana_sim_retries` (reset by T4 and T14). | §3.6, §6.7, §8.2, §9.1 |
| D-R23 | The watcher document carries a named last observation; `GET config` reads its `observed_at`. | §6.8, §7.1 |
| D-R24 | `SOLANA_OUTCOME_UNKNOWN` at submit means an unknown Mongo commit result; the rail defines no `502`. | §7.2 |
| D-R25 | The mainnet receipt vector carries its bump, and the recipient ATA vectors are listed. | §2.4 |
| D-R26 | A row finalized by a foreign transaction has no signature; its explorer link points at the receipt address. | §7.1, §9.2 |
| D-R27 | Per-member limits are inclusive of the current request and summed as `bigint`; `amount` is parsed without floats. | §6.4, §7.6 |
| D-R28 | Hold and review reasons are set and cleared on defined transitions. | §8.2 |
| D-R29 | The allowlist mode has a truth-table spec (GRAPH-3). | §7.6 |

## v0.1 changelog (proposed, needs founder approval)

**Status: proposed.** Nothing in this section changes the frozen v0 text above. No consumer may rely on a proposed wording until the founder approves it and it ships under the signed `contract-v0.1` tag. The founder approves, edits or rejects each entry by its number. Approved entries are folded into the sections they name in the PR that tags v0.1; rejected entries stay here, struck through, with the reason.

Each entry names the section, the problem found during implementation (the R2 program and its LiteSVM suite, the R3 SDK, the A-series API rail, or the v0.1 fixtures of §11), and the proposed wording. Unless an entry says otherwise, the fixtures in `test/fixtures/` encode the frozen v0 text.

### Errata found during implementation

**C1. §3.6, code 100 (short instruction data).**
- Problem: the Anchor 1.2.0 dispatcher (`lang/syn/src/codegen/program/dispatch.rs`) has no length check. Instruction data shorter than 8 bytes matches no discriminator and fails with 101 `InstructionFallbackNotFound`, not 100 `InstructionMissing`. `tests-litesvm/tests/artifact.rs` (`data_shorter_than_a_discriminator_never_dispatches`) pins this. Both codes halt the rail, but under the v0 table the class is `config` (101), not `bug` (100).
- Proposed wording: 100 row, "Where it arises here": "not raised by this program on Anchor 1.2.0 (short data is reported as 101); kept so that an unexpected 100 is still `bug`". 101 row: "unknown discriminator (wrong program at the address, stub or older build), or instruction data shorter than 8 bytes (Anchor 1.2.0 reports both as 101)". Classes unchanged.

**C2. §7.8, setting the latch, step 2.**
- Problem: "Zero matched documents means the same cause is already recorded" is true only when the latch is set **and** `cause.key` is in the live `causes`. Zero matches also occur when `rail/resume` cleared the latch, or emptied `causes`, between step 1 and step 2. A race test against a real MongoDB replica set lost a cause on that path: the setter reported "already recorded" for a cause that was never stored.
- Proposed wording: "2. Further cause: `updateOne({_id: 'halt', halted: true, 'causes.key': {$ne: cause.key}}, {$push: {causes: cause}, $inc: {version: 1}})`. One matched document means the cause is recorded. On zero matched documents, read the latch: if `halted` is `true` and `causes` contains `cause.key`, the cause is already recorded; otherwise run step 1 again. The setter retries a bounded number of times (proposed: 5 attempts in total) and then throws. A setter that throws fails its tick; readers still fail closed, because a read error counts as halted."

**C3. §4.1 and §4.7, message over 1024 bytes.**
- Problem: §4.1 says the 1024-byte cap is "checked by the renderer and the verifier", but §4.7 has no step and no refusal name for it.
- Proposed wording, §4.7 step 1: "Lengths: public key exactly 32 bytes, signature exactly 64 bytes, and message at most 1024 bytes (§4.1), else `bad_length`." The SDK already returns `bad_length`. The fixture `ed25519.json` `bad_length_message_1025_bytes` (a valid signature over 1025 bytes) encodes this proposal.

**C4. §4.2 and §4.3, bounds of `<D>` and `<F>`.**
- Problem: the template fixes the format of `<D>` and `<F>` but not their range, so renderers can disagree on what they refuse.
- Proposed wording, §4.3 table: "`<D>`: an integer from 0 to 2^64 − 1. `<F>`: an integer from 0 to 2^64 − 1, with `F <= D` (D includes the fee). The renderer refuses anything else." The SDK enforces this. The widest-message fixture (`siws.json` `consent_devnet_max_length`, 813 bytes) uses D = F = 2^64 − 1.

**C5. §3.7, unlisted errors at the `claim` and ATA indices.**
- Problem: (a) Clarification only: v0 already classifies `Custom(1)` at the `claim` index without the `insufficient lamports` log as `bug`, through the row "any other `Custom(n)` with `n < 6000` and not in 3.6". Naming it removes a possible misreading, by analogy with `Custom(0)`, that a missing log is a truncated-log `hold`. (b) Gap: the table lists only two errors at the `createAssociatedTokenIdempotent` index and does not classify any other error there. (c) Gap: every `claim` row is a `Custom(n)`, so a named (non-`Custom`) instruction error at the `claim` index, such as `InvalidAccountData`, is not classified either.
- Proposed rows: "`claim` | `Custom(1)` without the `insufficient lamports` log | not attributable to rent | bug (already covered by the any-other row; stated for clarity)", "`claim` | any named (non-`Custom`) error | unexpected | bug" and "`createAssociatedTokenIdempotent` | any other error | unexpected | bug". The SDK already does this. Fixtures: `errors.json` `claim_custom_1_without_log`, `claim_named_unlisted`, `ata_custom_2_unlisted`, `ata_named_unlisted`.

**C6. §6.7, money scale of the `*_minor` strings.**
- Problem: "The `*_minor` strings are also money (THB scale 2)" describes a 2-decimal THB value, but the strings hold integer satang. The implementation registers them as integer minor units (`MINOR_UNITS`).
- Proposed wording: "The `*_minor` strings are also money, in integer satang (minor units, `MINOR_UNITS`), and are added with that scale."

**C7. §6.8, the sender-queue index.**
- Problem: the non-unique index `{solana_claim_state: 1, solana_next_attempt_at: 1}` has no partial filter, so it indexes every `withdraws` row, including every bank-lane row with null keys.
- Proposed wording: "`{solana_claim_state: 1, solana_next_attempt_at: 1}` with partial filter `{solana_claim_state: {$type: 'string'}}`. The sender's query always names a state, so it can use the partial index." Adding the filter later replaces an index on a large collection, so the change should land before the index first ships.

**C8. §8.2 and §9.2, the review reason of a failed attempt, and lease effects.**
- Problem: §9.2 sends a landed attempt that failed with a `needs_review` or `bug` class to T11, but T11's reasons (`attempts_exhausted`, `receipt_mismatch`, `inconsistent_rpc`, `deployment_mismatch`) name none for this case. The implementation writes `simulation_rejected`. Separately, T3 and T5 say they clear the lease, but T4, T6, T7, T8, T10 and T11 do not say what happens to it.
- Proposed wording, T11: "...or an attempt finalized with a program, Anchor or instruction error classed `needs_review` or `bug` (`simulation_rejected`; `bug` also sets the latch)". If the founder wants simulated and landed failures told apart, use a new reason `attempt_failed` instead, retryable by T14. Proposed note under §8.2: "Every transition out of `sending` (T3 to T8, and T12 from `sending`) clears the lease. T10 and T11 start from `submitted`, which holds no lease, and leave it unset." If the implementation keeps the lease through T4 until the broadcast outcome is written, say that here instead; the admin "no live lease" checks then wait up to 120 s.

**C9. §9.1, sender gaps.**
- Problem: (a) the market-valve re-check gives "T3 hold" without a hold reason, and §6.7's list has none for it. (b) "the 75th percentile" of the prioritization fees does not name a method; the SDK uses nearest-rank. (c) "capped at 60,000 / 90,000" does not say what happens when the simulated units alone exceed the cap; then no allowed limit can succeed, and the SDK refuses to build (`compute_units_exceed_cap`).
- Proposed wording: (a) add hold reason `market_paused` to §6.7 and to T3. (b) "the 75th percentile by nearest rank: sort the samples ascending and take the value at 1-based rank `ceil(0.75 × n)`; no samples gives 0". (c) "If the simulated units exceed the cap, do not send: T6 `simulation_rejected` with `error_name: compute_units_exceed_cap`, because a resend cannot succeed and a human must compare the CU report."

**C10. §9.5, wire decoding is stricter than listed.**
- Problem: the SDK wire decoder (`src/wire.ts`) refuses more than §9.5 lists. It requires a version 0 message with no address lookup table, every signer slot filled with a signature that verifies over the message (the fee payer's first), exactly one instruction for the program, a well-formed `claim`, and a `claim` vault equal to the row's `solana_vault`. These checks only refuse more, never less, and every refusal is `wire_decode_mismatch`.
- Proposed wording, appended to the wire bullet: "The assessor also requires a version 0 message with no address lookup table, every signature present and valid over the message bytes, exactly one instruction for the program id, a well-formed `claim`, and a `claim` vault equal to the row's `solana_vault`. Any failure is `wire_decode_mismatch`."

**C11. §7.3, refusal precedence and a frozen member on `DELETE allowlist`.**
- Problem: when several refusals apply (for example a `retry` on a row in the wrong state while the latch is set and the acknowledgement differs), §7.3 does not say which code wins. Separately, `DELETE allowlist/:user_id` runs inside `runSerializedWithdrawForRail`, which throws `WithdrawBlockedError` for a `wallet_frozen` member. Through the mandated wrapper (§7.2) that becomes `403 SOLANA_WALLET_FROZEN`, which neither the `DELETE` row nor the admin refusal table lists.
- Proposed wording: "When more than one refusal applies, the first in this order is returned: state (`409 SOLANA_ADMIN_STATE_CONFLICT`), acknowledgement (`409 SOLANA_ADMIN_ACK_MISMATCH`), rail (`503 SOLANA_RAIL_UNAVAILABLE`), proof (`503 SOLANA_RELEASE_NOT_PROVABLE`, then `503 SOLANA_OUTCOME_UNKNOWN`). Body, id and scope refusals (400, 403) and 404 run before all of these." Add to the `DELETE allowlist` refusals and to the admin refusal table: "`403 SOLANA_WALLET_FROZEN`: the member is `wallet_frozen`; the removal runs inside `runSerializedWithdrawForRail`, whose block is rethrown with this code." If the founder wants an admin to be able to remove a frozen member, that is a separate change to the serialized wrapper.

**C12. §7.7, one claim key per vault before the vault exists.**
- Problem: the check requires `getProgramAccounts` to return exactly the configured vault, and "any other result" sets the latch. Before `initialize`, the result is `[]`, so a fresh deployment latches at boot under the literal rule.
- Proposed wording: "Initialize the vault (§3.3.1) before the rail is deployed with its config pins; an empty result before that point sets the latch like any other mismatch." Alternative, if the founder prefers: "An empty result makes the config incomplete without setting the latch; any result that names another account still sets it."

**C13. §7.1 and §7.7, which reason a deployment-marker failure reports.**
- Problem: §7.1 step 1 lists environment attestation as a membership gate (`disabled`), while the `maintenance` row of the `unavailable_reason` table lists the deployment marker. §7.7 makes the production `deployment_identity` marker part of the attestation, so a missing or mismatched marker matches both.
- Proposed wording: "A missing or mismatched `deployment_identity` document is reported as `maintenance` (config incomplete). Every other attestation block (environment name, cluster, pilot approval, the local-devnet conditions) is reported as `disabled`."

**C14. §9.3, conservation before T12.**
- Problem: the conservation check (step 4) counts in-flight rows in `sending`, `submitted` and `needs_review` only. A receipt that lands for a row in `reserved` raises `claim_count` above `N_paid + N_inflight` until step 6 finalizes the row through T12, so the watcher sets the latch for a payout that is about to be recorded correctly.
- Proposed wording: "Step 6 runs before step 4: non-terminal rows, `reserved` included, whose receipt exists at `finalized` are finalized through T12 first, and conservation is evaluated on the updated counts. A receipt that fails the §3.8 tuple check is never finalized; the watcher sets the latch for it (`receipt_mismatch`), as the reconciler does in T11."

**C15. §7.5, checks of the observation loops while the rail is off.**
- Problem: §7.5 says `SOLANA_WITHDRAW_ENABLED` does not stop the reconciler and the watcher, and §9 gates both on config completeness, environment attestation and genesis. Neither section says that those checks keep running while the switch is off. An implementation that computes them only for an enabled rail either runs the loops unchecked or never runs them.
- Proposed wording: "The reconciler and the watcher evaluate config completeness, environment attestation and the genesis hash on every tick whether or not `SOLANA_WITHDRAW_ENABLED` is `'true'`. A failed check skips the tick with no state change (§9.2)."

### Found while building the v0.1 fixtures

**C16. §11, generator location and commands.**
- Problem: §11 names `scripts/gen-fixtures.mjs`. Ticket #3120 places the generator at `scripts/contract/gen-fixtures.mjs`, which is where it now lives.
- Proposed wording: "...together with the generator (`scripts/contract/gen-fixtures.mjs`; `npm run gen:fixtures` writes the files, and CI runs `node scripts/contract/gen-fixtures.mjs --check`, also `npm run check:fixtures`, in the `typescript` job of `ci.yml`)...". Add: "The generator imports only `node:` built-ins and never the SDK, so it is an independent oracle; `test/fixtures.test.ts` checks the SDK against every vector and `tests-litesvm/tests/fixtures.rs` re-derives every PDA in Rust."

**C17. §11, encoding rule for byte strings.**
- Problem: "every byte string is lowercase hex unless the field name ends in `_b58` or `_b64`" conflicts with the table's own field names (`genesis_hash`, `usdc_mint`, `program_id`, `address`), which §5.4 requires to be base58.
- Proposed wording: "Every `bigint` is a decimal string. Solana addresses, program ids and hashes are base58 (§5.4) under the names in the table (`genesis_hash`, `usdc_mint`, `program_id`, `address`, `derive_program`) and under any name that ends in `_b58`. Every other byte string is lowercase hex, unless the name ends in `_b64`."

**C18. §11, the `contract` field.**
- Problem: the common format fixes `"contract": "v0"`, but the files ship in v0.1, so it is unclear whether the value tracks the tag.
- Proposed wording: "`contract` is `"v0"` for every v0.x version: append-only versions share the schema, and the signed tag identifies the exact version."

**C19. §1 item 1 and §2.4, which vectors move to the real devnet id.**
- Problem: v0.1 "replaces the placeholder vectors". The §3.2 decode vectors, the §3.4 event vector and the §4.6 worked example are frozen reference vectors computed under the placeholder. Moving them would break their printed values and the `siws.json` worked example the parity specs must reproduce.
- Proposed wording: "v0.1 replaces the placeholder in `clusters.json` and `pda.json` and in `release/manifest.json.programIds.devnet`. The reference vectors of §3.2, §3.4 and §4.6 (`accounts.json`, `siws.json`) stay on the placeholder; they test codecs and the renderer, not a deployment." The generator takes the real id as its one input (`--devnet-program-id`, or the single marked placeholder line), and `test/fixtures.test.ts` requires the manifest and `clusters.json` to agree.
- Shape of `pda.json` before and after G0a (proposed for approval): the §2.4 column "mainnet USDC mint (derivation only)" is keyed by the mint, not by a cluster. Every vector carries `cluster` (the cluster whose `clusters.json` program id derived it; `devnet` for every vector while the mainnet id is `null`) and `mint_cluster` (the cluster whose USDC mint is in the seeds; `null` for ProgramData, which has one vector because it does not depend on the mint). The mainnet-mint vectors are named `mainnet_usdc_*` and stay `derivation_only: true` under the real devnet id, because the mainnet USDC mint does not exist on devnet. `derivation_only` is `true` when `program_status` is `placeholder` or `mint_cluster` differs from `cluster`. No vector names a cluster whose program id is `null`, so a consumer that selects vectors by `cluster == "mainnet"` gets none until a mainnet id is assigned.

**C20. §3.5 and §9.1, the hold reason of 6014.**
- Problem: 6014 `VaultTokenAccountFrozen` is class `hold` (plus CRITICAL and the latch), but T3 and §6.7 name no hold reason for it. The SDK and `errors.json` leave it unset.
- Proposed wording: add hold reason `vault_frozen` to §6.7, T3 and the §9.1 class table, set on 6014.
- For comparison: the `config` class already names its reason in v0 (§9.1: "T3 hold `config_mismatch`"), so the SDK classifier (`holdReason`) and `errors.json` (`hold_reason`) set `config_mismatch` on every `config`-class code (6001, 6005, 6018, 6019, 101, 3001 to 3003, 3007, 3012, 4100). Only 6014 is left without a reason.

**C21. §8.2, T13 to the same state.**
- Problem: read literally, T13's from and to sets include `reserved → reserved`: a reverify that finds nothing. `states.json` lists that pair as allowed because the table does.
- Proposed wording: "A reverify that finds nothing new writes nothing; T13 never targets the row's current state." If approved, `states.json` lists `reserved → reserved` as refused.
