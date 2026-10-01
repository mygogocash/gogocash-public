# Security policy

## Status

This repository holds the public GoGoCash Solana payout code. Today that is a
TypeScript slice; the `gogocash_cashback` onchain program and its SDK are
being added.

- **Devnet only.** No program from this repository is deployed to Solana
  mainnet.
- **Unaudited.** No external security audit has been done. Don't use this code
  to hold or move real funds.

## Reporting a vulnerability

Email **support@gogocash.co** with "Security" in the subject line. Please
include:

- what is affected: a file and commit, or a program id or transaction
  signature;
- how to reproduce it, or a proof of concept;
- the impact you expect.

Please don't open a public issue for a vulnerability. Never include a real
private key, seed phrase or member data in a report.

## Scope

In scope:

- the code in this repository;
- any program deployed from it, once its address is published in this
  repository.

Out of scope:

- the GoGoCash app, API and infrastructure, which are not in this repository;
- third-party wallets, RPC providers and Solana itself.

## Keys

This repository must never contain a private key, keypair file, keystore or
credentials file. `.gitignore` excludes the paths Solana, Anchor and signing
tools write to, and CI scans every commit with gitleaks (`.gitleaks.toml`). If
you find a key in this repository or its history, treat it as compromised and
report it as above.
