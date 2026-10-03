# Devnet runbook: keys, deploy, vaults, funding

The operator sequence for plan steps R4 (mygogocash/gogocash-monorepo#2982)
and R5 (#2983), to run once the founder has passed gate G0a. It deploys the
`gogocash_cashback` program to devnet from GitHub Actions, opens the USDC
vault, records the deployment and funds the vault.

## TL;DR

- Generate the keys locally with `npm run keygen` (each run prints only a
  public key), commit the public keys and the real program id, upload the two
  deploy keys to the `devnet` environment with `gh secret set ... < file`,
  then delete those two files.
- Push a signed `v*` tag. Approve the `devnet` environment once the
  verifiable build is green. The workflow deploys, checks the hash, opens the
  vault(s), runs `verify-from-repo` and uploads `deployments/devnet.json` and
  `release/manifest.json` as an artifact. Commit that artifact.
- Fund the vault with `npm run admin -- deposit` after the Circle faucet.
  Never send to the vault from a wallet UI.
- No key value ever appears in this document, a command argument, chat, an
  issue or a commit. Placeholders such as `<DEPLOYER_PUBKEY>` stand for
  public keys you read from `npm run keygen` output.

## Rules for every step

- Key files live under `~/.config/gogocash/devnet/`, mode 0600, in a mode
  0700 directory. `npm run keygen` refuses any path inside a git worktree that
  is not git-ignored, and never overwrites a file.
- Never print, `cat`, copy, paste or screenshot a key file. Never pass a key
  on a command line. `gh secret set` reads the value from stdin (`< file`),
  never `--body`.
- The RPC URL comes from `SOLANA_RPC_URL` (or `--rpc-url`). The public
  devnet endpoint `https://api.devnet.solana.com` is fine for every command
  here. A provider URL with an API key is a secret: the CLIs never print it.
- `--cluster mainnet` is refused. Contract v0 has no mainnet program id, and
  the CLI also requires `--i-understand-mainnet`.
- A key that ever shows up in a log, chat, issue, commit or screenshot is
  compromised. Stop and rotate it (see "If something goes wrong").

## 0. One-time setup (owner)

These are settings, not code. #2975 tracks them.

1. **Environment `devnet`** in `mygogocash/gogocash-public`
   (Settings, Environments):
   - Required reviewers: the founder only.
   - Deployment branches and tags: selected tags only, pattern `v*`.
2. **Tag ruleset** for `v*`: only the founder may create, update or delete a
   matching tag, and tags must be signed.
3. **Local tools**: Node.js 22.18 or newer and `gh` (logged in with
   permission to set environment secrets). No Solana CLI is needed on the
   operator's machine: the deploy runs in Actions and `npm run admin` signs
   with `@solana/kit`.

```sh
git clone https://github.com/mygogocash/gogocash-public.git
cd gogocash-public
npm ci --ignore-scripts --no-audit --no-fund
```

## 1. Generate the keys

One key per role. Each command prints only the base58 public key. Write the
public keys down (they are public); the files stay where they are.

```sh
mkdir -p ~/.config/gogocash/devnet
chmod 700 ~/.config/gogocash/devnet
for name in program deployer admin guardian demo-claim-authority api-claim-authority api-fee-payer; do
  printf '%s ' "${name}"
  npm run --silent keygen -- --out ~/.config/gogocash/devnet/${name}.json
done
```

| File | Role | Where it lives after setup |
| --- | --- | --- |
| `program.json` | The program id (`<PROGRAM_ID>`). Signs only the first deploy. | `DEVNET_PROGRAM_KEYPAIR` in the `devnet` environment; local file deleted in step 3 |
| `deployer.json` | Fee payer and loader-v3 upgrade authority (`<DEPLOYER_PUBKEY>`). Signs `initialize`. | `DEVNET_DEPLOYER_KEYPAIR` in the `devnet` environment; local file deleted in step 3 |
| `admin.json` | Vault admin (`<ADMIN_PUBKEY>`): unpause, update_config, withdraw, admin handover. Also the depositor in step 7. | Local, mode 0600 |
| `guardian.json` | Vault guardian (`<GUARDIAN_PUBKEY>`): pause only. | Local, mode 0600 |
| `demo-claim-authority.json` | Claim key of the demo vault (deferred, see the last section). | Local, mode 0600 |
| `api-claim-authority.json` | Claim authority of the USDC vault (`<API_CLAIM_PUBKEY>`), used only by the preview API. | Railway preview (step 8); local file deleted after |
| `api-fee-payer.json` | Fee payer of the preview API's claims (`<API_FEE_PAYER_PUBKEY>`). | Railway preview (step 8); local file deleted after |

Key separation the program and the CLI enforce: the claim authority is never
the admin, the guardian or the upgrade authority (contract v0 §3.3.1, §3.3.5).

## 2. Commit the real program id and the vault roles

The deploy workflow refuses the v0 placeholder id
(`HWNF2cvXybfAjLbw2pydi7sNFmTfYBjpEWNtY3BJfCje`), and the binary checks its
own id at runtime (Anchor error 4100), so the real id is committed before the
tag. This is the contract v0.1 change (docs/CONTRACT.md §1, §2.4). In one
pull request:

| File | Change |
| --- | --- |
| `programs/gogocash-cashback/src/lib.rs` | `declare_id!("<PROGRAM_ID>");` |
| `Anchor.toml` | `[programs.localnet] gogocash_cashback = "<PROGRAM_ID>"` |
| `tests-litesvm/src/lib.rs` | `PROGRAM_ID`, the address the suite loads the `.so` at, = `<PROGRAM_ID>`; the placeholder derivation vectors and their test keep their own constant |
| `idl/gogocash_cashback.devnet.json` | `"address": "<PROGRAM_ID>"`, taken from the `gogocash_cashback-idl` artifact of the pull request's program workflow run |
| `src/generated/` | `npm run codama` (CI fails if it differs from the IDL) |
| `release/manifest.json` | `programIds.devnet` = `<PROGRAM_ID>`; `mainnet` stays `null` |
| `deploy/vaults.devnet.json` | `usdc` vault: `admin` = `<ADMIN_PUBKEY>`, `guardian` = `<GUARDIAN_PUBKEY>`, `claimAuthority` = `<API_CLAIM_PUBKEY>`; keep the caps `5000000` / `20000000` |
| `docs/CONTRACT.md` | §2.4 real devnet id and its PDA vectors (contract v0.1) |

Check it locally before you push (no RPC, no key):

```sh
npm run typecheck && npm test
npm run admin -- initialize --cluster devnet --check-only
```

`--check-only` validates `deploy/vaults.devnet.json` (complete roles, key
separation, caps, the USDC mint) and prints the vault PDA and vault token
account for each enabled vault. Merge the pull request once `CI` and
`Program` are green, and sign the `contract-v0.1` tag as the contract
requires. (`contract-v0.1` does not start with `v`, so it deploys nothing.)

## 3. Upload the deploy keys, then delete them locally

```sh
gh secret set DEVNET_PROGRAM_KEYPAIR --env devnet --repo mygogocash/gogocash-public \
  < ~/.config/gogocash/devnet/program.json
gh secret set DEVNET_DEPLOYER_KEYPAIR --env devnet --repo mygogocash/gogocash-public \
  < ~/.config/gogocash/devnet/deployer.json
gh secret list --env devnet --repo mygogocash/gogocash-public   # names and dates only
rm ~/.config/gogocash/devnet/program.json ~/.config/gogocash/devnet/deployer.json
```

From now on only the `devnet` environment can deploy, upgrade or initialize.
That is deliberate: the upgrade authority never sits on a laptop.

## 4. Fund the deployer with devnet SOL

The first deploy needs about 3 SOL (the loader returns the buffer's lamports
to the payer once the program is written). Initialize costs about 0.005 SOL
per vault (vault rent 2,296,160 lamports, vault token account rent, fees).

- Request devnet SOL for `<DEPLOYER_PUBKEY>` at https://faucet.solana.com.
- Check the balance without any key:

```sh
curl -s https://api.devnet.solana.com -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getBalance","params":["<DEPLOYER_PUBKEY>"]}'
```

Also give `<ADMIN_PUBKEY>` about 0.05 SOL for its own transaction fees
(deposit, unpause, withdraw).

## 5. Push the signed tag and approve the environment

```sh
git switch main && git pull --ff-only
git tag -s v0.1.0 -m "gogocash_cashback v0.1.0: first devnet deploy"
git push origin v0.1.0
```

The tag starts two workflows. `Verifiable build` is the standalone release
build. `Deploy devnet` (`.github/workflows/deploy-devnet.yml`) first runs the
same verifiable build plus the LiteSVM suite as a called workflow, then waits
for the `devnet` approval.

Before you approve, open the called build's `solana-verify build (SBPFv3)`
job and note the `.so` sha256 and the solana-verify executable hash it
printed. Then approve (`Review deployments`, `devnet`). The deploy job:

1. checks the downloaded `.so` against both hashes, SBPFv3 and security.txt;
2. checks the RPC's genesis hash is devnet's;
3. writes the two keys to files under `umask 077` and checks the program key
   is `programIds.devnet`;
4. `solana program deploy` (loader-v3, upgradeable, upgrade authority = the
   deployer), skipped if the program already runs exactly these bytes. The
   run generates the intermediate buffer key itself and passes it with
   `--buffer`: without it the Agave CLI makes an ephemeral buffer key and
   prints its 12-word recovery phrase to the log, which is public;
5. requires `solana-verify get-program-hash` to equal the artifact's hash;
6. runs `npm run admin -- initialize --cluster devnet --skip-existing`: one
   transaction per enabled vault, `[createAssociatedTokenIdempotent(ata(vault,
   mint)), initialize]`, signed by the deployer. Each vault starts paused;
7. runs `solana-verify verify-from-repo --arch v3` against the tagged commit
   and requires both hashes to match. Devnet has no Explorer "verified" badge
   (remote verification is mainnet-only), so this log and the hash match are
   the evidence. It declines the on-chain verify-PDA upload;
8. writes `deployments/devnet.json` and `release/manifest.json`, checks them
   against the chain with `npm run admin -- show`, deletes the key files, and
   uploads the `devnet-deployment` artifact. The workflow never pushes. A
   vault that already existed (a later tag) keeps the initialize signature
   of the committed `deployments/devnet.json`.

## 6. Commit the deployment record

```sh
run_id="$(gh run list --workflow deploy-devnet.yml --repo mygogocash/gogocash-public --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run download "${run_id}" --name devnet-deployment --repo mygogocash/gogocash-public --dir /tmp/devnet-deployment
git switch -c chore/devnet-deployment-v0.1.0
mkdir -p deployments evidence/devnet-deploy-v0.1.0
cp /tmp/devnet-deployment/record/deployments/devnet.json deployments/devnet.json
cp /tmp/devnet-deployment/record/release/manifest.json release/manifest.json
cp /tmp/devnet-deployment/evidence/* evidence/devnet-deploy-v0.1.0/
git add deployments/devnet.json release/manifest.json evidence/devnet-deploy-v0.1.0
git commit -m "chore(deploy): record the devnet deployment of v0.1.0"
```

Open a pull request and merge it. Then confirm the chain matches the record
(exit code 0, `driftCount` 0):

```sh
SOLANA_RPC_URL=https://api.devnet.solana.com npm run admin -- show --cluster devnet
```

## 7. Fund the USDC vault

1. Request devnet USDC for `<ADMIN_PUBKEY>` at https://faucet.circle.com
   (network Solana Devnet). It sends 20 USDC per request, at most once every
   2 hours. `deposit` spends from the admin's associated token account for
   the vault mint (or `--source <TOKEN_ACCOUNT>` owned by the admin).
2. Deposit into the vault. `deposit` reads `vault.vault_token_account` from
   the chain and sends one `transfer_checked` there. The vault is an
   off-curve PDA, so never fund it from a wallet UI or by typing an address.

```sh
SOLANA_RPC_URL=https://api.devnet.solana.com npm run admin -- deposit --cluster devnet \
  --vault usdc --amount 20000000 --keypair ~/.config/gogocash/devnet/admin.json
SOLANA_RPC_URL=https://api.devnet.solana.com npm run admin -- show --cluster devnet --vault usdc
```

Amounts are atomic units (1 USDC = 1000000). `show` reports
`vaultBalanceAtomic`.

3. The vault stays paused until the founder opens the rail on preview. Then:

```sh
SOLANA_RPC_URL=https://api.devnet.solana.com npm run admin -- unpause --cluster devnet \
  --vault usdc --keypair ~/.config/gogocash/devnet/admin.json
```

`unpause` refuses unless the vault matches `deployments/devnet.json` and holds
tokens. The guardian pauses with `pause --keypair .../guardian.json`.

## 8. Hand the preview API its claim key and fee payer

In the monorepo (`mygogocash/gogocash-monorepo`), with the Railway CLI logged
in. `scripts/solana-keypair-to-env.mjs` converts each key file into the
`KEY=VALUE` line `scripts/railway-apply-secrets.sh` reads; it writes a
git-ignored file under `umask 077` and prints only the name and public key.
Use `--lane preview` only when it starts a new file; use `--append` when the
values file already exists.

```sh
node scripts/solana-keypair-to-env.mjs --name SOLANA_CLAIM_AUTHORITY_KEYPAIR \
  --in ~/.config/gogocash/devnet/api-claim-authority.json \
  --out .env.railway.preview --lane preview
node scripts/solana-keypair-to-env.mjs --name SOLANA_FEE_PAYER_KEYPAIR \
  --in ~/.config/gogocash/devnet/api-fee-payer.json \
  --out .env.railway.preview --append
ENV_FILE=.env.railway.preview RAILWAY_ENVIRONMENT=preview ./scripts/railway-apply-secrets.sh --dry-run
ENV_FILE=.env.railway.preview RAILWAY_ENVIRONMENT=preview ./scripts/railway-apply-secrets.sh
```

The public settings come from the committed `deployments/devnet.json`:
`SOLANA_PROGRAM_ID` (`programId`), `SOLANA_USDC_MINT` (the `usdc` vault's
`mint`), `SOLANA_CLAIM_AUTHORITY_PUBKEY` (`<API_CLAIM_PUBKEY>`),
`SOLANA_FEE_PAYER_PUBKEY` (`<API_FEE_PAYER_PUBKEY>`),
`SOLANA_PROGRAM_UPGRADE_AUTHORITY` (`upgradeAuthority`) and
`SOLANA_PROGRAM_DEPLOY_SLOT` (`deploySlot`). The rail stays off until
`SOLANA_WITHDRAW_ENABLED` is the literal `true`, which is the founder's call.

Give `<API_FEE_PAYER_PUBKEY>` devnet SOL: every claim pays receipt rent
(1,102,360 lamports, never reclaimed) plus fees, and the recipient ATA rent
when it is new.

Once the dry run and the apply both report the two names on the API
service, delete the local copies: the values file and
`~/.config/gogocash/devnet/api-claim-authority.json` and `api-fee-payer.json`.
Railway is now their only store. If they are ever lost, generate new keys and
rotate the vault's claim authority with `update_config` (step "If something
goes wrong").

## 9. Check a payout (no key needed)

```sh
SOLANA_RPC_URL=https://api.devnet.solana.com npm run verify:devnet -- --signature <CLAIM_TX_SIGNATURE>
SOLANA_RPC_URL=https://api.devnet.solana.com npm run verify:devnet -- --receipt <RECEIPT_ADDRESS> \
  --recipient <WALLET> --amount <ATOMIC> --payout-id <64 HEX>
```

It re-derives the receipt against each vault in `release/manifest.json`,
reads at `finalized` with the contract §3.8 procedure, and prints the vault,
mint, recipient, amount and payout id. Exit code 0 means `paid`; anything
else (`mismatch`, `absent`, `genesis_mismatch`, `transaction_not_found`,
`not_a_claim`, `stale_read`) exits non-zero.

## If something goes wrong

- **The deploy job failed before or during `solana program deploy`.** Fix the
  cause (usually the deployer's SOL) and use "Re-run failed jobs"; you
  approve the environment again. A half-written deploy leaves a buffer
  account holding the program's rent. The step "Close the buffer of a failed
  deploy" closes it with the deployer key (the buffer authority), so the SOL
  goes back to the deployer. If that step only warns (an RPC error, say),
  the buffer address is in the log; it can be closed later only with the
  deployer key (`solana program close <BUFFER>`), which now lives only in the
  environment secret, so on devnet it is usually simpler to leave it.
- **It failed after the deploy** (initialize, verify-from-repo, the record).
  "Re-run failed jobs". The deploy step sees the program already runs the
  verified bytes and skips it; initialize keeps any vault that already
  matches the config (`--skip-existing`) and refuses one that differs.
- **A failed run** uploads `devnet-deployment-failed-evidence` (logs only,
  never a record to commit).
- **A vault exists but differs from the config.** `initialize` refuses it.
  Correct it with `update_config` (admin) or change the config to match, then
  re-run.
- **The claim key leaked or was lost.** Generate a new one, then
  `npm run admin -- update_config --cluster devnet --vault usdc --keypair .../admin.json --claim-authority <NEW_PUBKEY>`,
  and hand it to Railway as in step 8.
- **The admin key must change.** `propose_admin --new-admin <PUBKEY>` (admin),
  then `accept_admin` signed by the new key. `propose_admin --cancel` cancels.
- **The deployer or program secret is lost.** On devnet, generate new keys
  and deploy under a new program id (a new contract version). Nothing on
  devnet holds real value.
- **`--export-squads --authority <PUBKEY>`** prints the base58 v0 message for
  a Squads v4 proposal instead of signing. It is the mainnet admin path and is
  not used on devnet.

## Deferred

- **`npm run demo`** (the devnet demo script of #2983: THB to USDC, consent,
  claim, replay, mismatch, over-cap and pause drills, evidence file) is not
  built yet.
- **Tier B fallback** of #2983 (with the API sender off, `update_config`
  rotates the claim authority to an operator key, the operator settles the
  same payout_id, then rotates back). `update_config` is ready; the operator
  claim sender comes with the demo script.
- **The demo-mint vault.** `deploy/vaults.devnet.json` keeps the `demo`
  entry `enabled: false` with no mint. It needs a classic SPL Token mint with
  6 decimals, created with the demo script, and its own claim key
  (`demo-claim-authority.json`), so drills never touch the API's vault or
  trip its receipt watcher. To open it later: fill in `mint`, `admin`,
  `guardian` and `claimAuthority`, set `enabled: true`, merge, and push a new
  `v*` tag. The workflow keeps the already-deployed program (same bytes),
  keeps the matching USDC vault, and initializes only the demo vault.
