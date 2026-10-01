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
- **Onchain proof before "paid":** the ledger marks a payout paid only after reading the confirmed transaction. It must show exactly the approved USDC amount, sent from the treasury to the member, with the payout id attached as a memo.

## How the payout works

```
approved cashback (THB, integer satang)
   │  src/amount.ts        exact bigint FX conversion, rounds down, no floats
   ▼
USDC base units (6 decimals)
   │  src/payout.ts        1. create member USDC account if needed (treasury pays)
   │                       2. transferChecked exact amount, treasury → member
   │                       3. memo "gogocash:cashback:<payoutId>"
   ▼
signed + sent by the treasury
   │  src/verify.ts        read the confirmed tx; require one transfer of the right
   │                       mint, amount, source, signer, destination and memo
   ▼
ledger marks the payout paid
```

| File | What it does |
|---|---|
| [`src/amount.ts`](src/amount.ts) | Integer-only conversion from cashback minor units to USDC base units |
| [`src/payout.ts`](src/payout.ts) | Builds the payout transaction: token account, `transferChecked`, payout-id memo |
| [`src/verify.ts`](src/verify.ts) | Checks the confirmed transaction before the payout is marked paid |
| [`src/seeker-wallet.ts`](src/seeker-wallet.ts) | Connects the member's wallet on Solana Mobile via Mobile Wallet Adapter |
| [`scripts/demo.ts`](scripts/demo.ts) | End-to-end devnet demo |
| [`test/`](test) | Offline unit tests, including 10 ways a wrong payout is rejected |

## Run the demo

Requires Node.js 20 or newer.

```bash
git clone https://github.com/mygogocash/gogocash-public.git
cd gogocash-public
npm install
npm test          # offline unit tests
npm run demo      # live payout on Solana devnet
```

`npm run demo`:

1. Creates throwaway devnet keypairs in `.demo/`, which is gitignored. One is a treasury; the other stands in for the member's Seeker wallet.
2. Creates a 6-decimal demo USDC mint and stocks the treasury with it.
3. Converts an approved cashback of THB 125.00 to USDC.
4. Sends one payout transaction and prints its Solana Explorer link.
5. Verifies the payout from the chain, then shows the same transaction being rejected when the expected amount is wrong.

The public devnet faucet is rate limited. If the airdrop is refused, the demo prints the treasury address. Fund it at https://faucet.solana.com and run `npm run demo` again. To use a different RPC, set `SOLANA_RPC_URL`.

## Status and scope

- **Devnet only.** The demo creates its own 6-decimal demo USDC mint, so it runs without waiting on a faucet. Circle also runs a devnet USDC faucet (https://faucet.circle.com) for its official devnet USDC mint. On mainnet, `usdcMint` is Circle's USDC mint and the treasury is a managed, funded wallet.
- **What exists today:** the GoGoCash withdrawal system supports bank and PromptPay payouts. EVM stablecoin payouts are sent by an admin: before settlement the system checks that the attached transaction succeeded onchain, but not yet the token transfer's amount or recipient, and the automatic EVM lane is switched off. This build goes further on Solana: `src/verify.ts` checks the mint, amount, source, signer, destination and memo before a payout counts as paid.
- **Security:** see [SECURITY.md](SECURITY.md). The code is unaudited.
- **Not in this repo:** the GoGoCash app, the ledger, affiliate network integrations, customer data, and any keys or infrastructure.

## Links

- Product: https://gogocash.co
