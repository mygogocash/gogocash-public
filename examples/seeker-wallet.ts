// Example only. Not part of the SDK, not exported from src/index.ts, and not
// typechecked or tested: tsconfig.json excludes examples/.
//
// It still imports @solana-mobile/mobile-wallet-adapter-protocol-web3js and
// @solana/web3.js v1, which the SDK dropped (web3.js v1 pulls in bigint-buffer,
// CVE-2025-3194). Neither package is installed in this repository any more, so
// this file no longer compiles here. It is kept to show the Mobile Wallet
// Adapter authorize step. The app's real wallet code follows docs/CONTRACT.md
// section 10 (the plain @solana-mobile/mobile-wallet-adapter-protocol package,
// signMessages only, no transaction signing).

import { transact } from "@solana-mobile/mobile-wallet-adapter-protocol-web3js";
import { PublicKey } from "@solana/web3.js";

/**
 * Runs inside the GoGoCash React Native app on a Solana Mobile phone (Seeker
 * or Saga). Mobile Wallet Adapter opens the wallet the member already uses
 * (Seed Vault, Phantom, Solflare...), the member approves, and the app gets
 * the public address to receive cashback. No private key ever touches
 * GoGoCash: the app only learns where to send the USDC.
 */

const APP_IDENTITY = {
  name: "GoGoCash",
  uri: "https://gogocash.co",
  icon: "favicon.ico",
} as const;

export type SolanaChain = "solana:devnet" | "solana:mainnet";

export type ConnectedPayoutWallet = {
  address: PublicKey;
  /** Label the wallet app shows for the account, if any. */
  label?: string;
  /** Reuse with `reauthorize` so the member is not asked again. */
  authToken: string;
};

/** MWA returns addresses base64-encoded; payouts need a PublicKey. */
export function walletAddressFromBase64(base64Address: string): PublicKey {
  return new PublicKey(Buffer.from(base64Address, "base64"));
}

export async function connectPayoutWallet(
  chain: SolanaChain = "solana:devnet",
): Promise<ConnectedPayoutWallet> {
  return transact(async (wallet) => {
    const auth = await wallet.authorize({ chain, identity: APP_IDENTITY });
    const account = auth.accounts[0];
    if (!account) {
      throw new Error("The wallet did not share an account.");
    }
    return {
      address: walletAddressFromBase64(account.address),
      label: account.label,
      authToken: auth.auth_token,
    };
  });
}
