# GoGoCash: cashback paid onchain, in USDC, on Solana Mobile

GoGoCash tracks shopping cashback across 10,000 brands globally. This hackathon build pays that cashback out as a USDC stablecoin transfer to the member's own wallet on a Solana Mobile phone, instead of a bank transfer.

Built for the **Superteam Thailand AI × Solana** track at Colosseum. Product: **https://gogocash.co**

> This repository is a small public slice written for judges. It contains only the Solana payout path, rewritten from scratch as standalone code. The GoGoCash app, API, data and infrastructure stay private.

## The problem

Cashback is money people have already earned, but getting it out is slow and expensive. In Southeast Asia, withdrawals go through bank transfers or local rails. They carry minimum amounts and fees, take days, and don't work at all for people without a local bank account. A member who earned THB 125 on a purchase may wait days and lose part of it to fees.

## The user

Online shoppers in Southeast Asia, starting in Thailand, who buy from marketplaces and brands they already use. Most are mobile-first. Solana Mobile phones such as the Seeker come with a built-in wallet (Seed Vault), so the wallet is already in their pocket.

## The product

1. **Shop:** the member opens a brand through GoGoCash and shops as usual.
2. **Track:** GoGoCash tracks the purchase with its affiliate network partners and records the cashback once the brand approves it.
3. **Get paid onchain:** the member connects their Solana Mobile wallet and withdraws. The approved cashback converts to USDC and lands in their wallet in seconds, and they can see the transaction on the explorer.

## What AI does

GoGoCash runs AI agent tools (an MCP server called GoGoTrack) that let an AI assistant do the cashback work for the member:

- **Find the brand:** `search_merchants` and `match_merchant` turn "I want to buy sneakers on Shopee" into the right cashback offer.
- **Activate tracking before checkout:** `activate_cashback` returns a tracked link, so the purchase counts toward cashback.
- **See status:** `get_timeline` shows where each purchase is, from tracked to approved to paid.

The assistant handles the earning side. This repo shows the paying side: once cashback is approved, Solana carries the money to the member.

## What Solana does

Solana is the payout rail:

- **USDC on Solana** is the payout currency: a stable, dollar-denominated amount with a sub-cent network fee, settled in seconds.
- **Solana Mobile Wallet Adapter** connects the member's wallet on a Seeker or Saga phone. The app only learns the receiving address. Keys stay in the member's wallet.
- **Onchain proof before "paid":** the ledger marks a payout paid only after a finalized onchain receipt for that payout id shows exactly the approved recipient and USDC amount ([docs/CONTRACT.md](docs/CONTRACT.md) section 3.8).

## How the payout works

The rail is specified in [docs/CONTRACT.md](docs/CONTRACT.md) (contract v0). The member signs a message, never a transaction; an Anchor program pays each payout id at most once and leaves a receipt account behind.

```
approved cashback (THB, integer satang)
   │  src/amount.ts          exact bigint THB → USDC conversion, u64 bound, no floats
   ▼
consent message (exact bytes)
   │  src/siws.ts            render the SIWS message; the member signs it in their wallet;
   │                         strict Ed25519 verify (small-order, non-canonical, S >= L checks)
   ▼
claim on the gogocash_cashback program (Anchor program in progress)
   │  src/program.ts         vault and receipt PDAs, account decoders
   │  src/claim-tx.ts        the v0 claim transaction: CU limit and price, ATA, claim
   │  src/errors.ts          classify program, Anchor and instruction errors by number
   ▼
finalized receipt account
   │  src/verify-receipt.ts  deployment binding, owner, discriminator, bump and
   │                         (payout id, recipient, amount) tuple must all match
   ▼
ledger marks the payout paid
```

| File | What it does |
|---|---|
| [`src/amount.ts`](src/amount.ts) | Integer-only conversion from cashback minor units to USDC base units, decimal-string grammar, u64 bound |
| [`src/clusters.ts`](src/clusters.ts) | Genesis hashes, chain ids, USDC mints and program ids per cluster |
| [`src/base58.ts`](src/base58.ts) | Strict base58 validator for addresses and signatures |
| [`src/siws.ts`](src/siws.ts) | Consent message renderer and strict Ed25519 signature verification |
| [`src/program.ts`](src/program.ts) | Vault and receipt PDAs (program id always passed in) and account decoders |
| [`src/claim-tx.ts`](src/claim-tx.ts) | The claim transaction (v0, no lookup table, capped compute-unit limit and price, ATA then claim) |
| [`src/wire.ts`](src/wire.ts) | Decodes a stored signed claim transaction and checks the release-proof preconditions |
| [`src/events.ts`](src/events.ts) | `PayoutClaimed` event decoder (informational only) |
| [`src/generated/`](src/generated) | Codama client generated from [`idl/gogocash_cashback.devnet.json`](idl/gogocash_cashback.devnet.json) (`npm run codama`) |
| [`src/errors.ts`](src/errors.ts) | Error classification: retry, hold, needs review, already claimed, bug, config |
| [`src/verify-receipt.ts`](src/verify-receipt.ts) | Receipt verification before a payout is marked paid |
| [`src/release.ts`](src/release.ts) | The five-condition proof that a stuck payout can never land |
| [`src/admin/`](src/admin) | Pure builders and checks behind the operator CLI (`npm run admin`) and the keyless verifier (`npm run verify:devnet`) |
| [`src/demo/`](src/demo) | Pure steps behind the devnet demo: THB to USDC working, consent signing and verify, the funding and state precheck, simulation verdicts, settling the pause drill's transactions before it unpauses, and the evidence file with its no-key-material guard |
| [`scripts/demo.ts`](scripts/demo.ts) | The devnet demo on the demo-mint vault (`npm run demo`): claim to a finalized `paid` receipt, replay, verifier mismatch, over-cap and pause drills; writes `evidence/devnet-demo-<date>.md` |
| [`scripts/keygen.ts`](scripts/keygen.ts) | Generates one operator key file (mode 0600, outside git) and prints only its public key |
| [`.github/workflows/deploy-devnet.yml`](.github/workflows/deploy-devnet.yml) | Deploys the verified build to devnet and opens the vaults ([docs/RUNBOOK-DEVNET.md](docs/RUNBOOK-DEVNET.md)) |
| [`examples/seeker-wallet.ts`](examples/seeker-wallet.ts) | Example of connecting the member's wallet with Mobile Wallet Adapter (not compiled) |
| [`test/`](test) | Offline unit tests built from the contract's vectors |

## Run the tests

Requires Node.js 22.18 or newer (the source runs through Node's built-in TypeScript type stripping).

```bash
git clone https://github.com/mygogocash/gogocash-public.git
cd gogocash-public
npm install
npm test               # offline unit tests
npm run typecheck
node -e "import('./src/index.ts')"   # loads the SDK with no build step
```

The end-to-end devnet demo runs on the program against a separate demo-mint vault, never the USDC vault the API pays from. It needs a deployed program and a funded, unpaused demo vault ([docs/RUNBOOK-DEVNET.md](docs/RUNBOOK-DEVNET.md), section 10):

```bash
SOLANA_RPC_URL=https://api.devnet.solana.com npm run demo -- --cluster devnet --vault demo \
  --claim-keypair <demo-claim-authority.json> --guardian-keypair <guardian.json> --admin-keypair <admin.json>
```

It converts THB 125.00 to USDC with integer math, has a throwaway in-memory wallet sign the consent message, pays one claim and verifies its finalized receipt (`paid`), then shows that a replay, a wrong amount, an over-cap claim and a claim while paused are each refused. It writes the signatures and Explorer links to `evidence/devnet-demo-<date>.md`.

## Status and scope

- **Devnet hackathon build.** Contract v0 uses a placeholder devnet program id with no key, so this build cannot move money; the real devnet id arrives in contract v0.1. There is no mainnet program id. Circle runs a devnet USDC faucet (https://faucet.circle.com) for its official devnet USDC mint.
- **What exists today:** the GoGoCash withdrawal system supports bank and PromptPay payouts. EVM stablecoin payouts are sent by an admin: before settlement the system checks that the attached transaction succeeded onchain, but not yet the token transfer's amount or recipient, and the automatic EVM lane is switched off. This build goes further on Solana: `src/verify-receipt.ts` requires a finalized receipt whose payout id, recipient and amount match before a payout counts as paid.
- **Security:** see [SECURITY.md](SECURITY.md). The code is unaudited.
- **Not in this repo:** the GoGoCash app, the ledger, affiliate network integrations, customer data, and any keys or infrastructure.

## Links

- Product: https://gogocash.co
