/**
 * Shared inputs for the claim transaction tests. Keys are throwaway: derived
 * at runtime from public labels, they hold nothing and are not secrets.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  address,
  createKeyPairFromPrivateKeyBytes,
  getAddressFromPublicKey,
  type Address,
} from "@solana/kit";
import type { ClaimTransactionInput } from "../src/claim-tx.ts";
import { GENESIS_HASH, USDC_MINT, V0_PLACEHOLDER_PROGRAM_ID } from "../src/clusters.ts";
import { payoutIdFromHex } from "../src/program.ts";
import { CLAIM_DATA_VECTOR, PDA_VECTORS, TEST_SIGNER_1 } from "./vectors.ts";

export type TestKey = { readonly keyPair: CryptoKeyPair; readonly address: Address };

/** A throwaway Ed25519 key: seed = sha256("gogocash-public throwaway test key: <label>"). */
export async function throwawayKey(label: string): Promise<TestKey> {
  const seed = createHash("sha256").update(`gogocash-public throwaway test key: ${label}`).digest();
  const keyPair = await createKeyPairFromPrivateKeyBytes(Uint8Array.from(seed));
  return { keyPair, address: await getAddressFromPublicKey(keyPair.publicKey) };
}

/** A fixed public 32-byte base58 value used as the recent blockhash. */
export const TEST_BLOCKHASH = GENESIS_HASH.devnet;
export const TEST_LAST_VALID_BLOCK_HEIGHT = 400_000_150n;

/** Claim inputs for the section 3.3 vector on the placeholder program (devnet mint). */
export function vectorClaimInput(keys: {
  readonly payer: Address;
  readonly claimAuthority: Address;
}): ClaimTransactionInput {
  return {
    programAddress: V0_PLACEHOLDER_PROGRAM_ID,
    vault: address(PDA_VECTORS.devnet.vault.address),
    mint: USDC_MINT.devnet,
    recipient: address(TEST_SIGNER_1),
    payer: keys.payer,
    claimAuthority: keys.claimAuthority,
    payoutId: payoutIdFromHex(CLAIM_DATA_VECTOR.payoutIdHex),
    amount: CLAIM_DATA_VECTOR.amount,
    expiresAt: CLAIM_DATA_VECTOR.expiresAt,
    blockhash: TEST_BLOCKHASH,
    lastValidBlockHeight: TEST_LAST_VALID_BLOCK_HEIGHT,
    recipientAtaExists: true,
    priorityPriceMicroLamports: 5_000n,
    priorityPriceCapMicroLamports: 100_000n,
  };
}

type IdlAccount = { name: string; signer?: boolean; writable?: boolean; address?: string };
type Idl = {
  address: string;
  instructions: { name: string; discriminator: number[]; accounts: IdlAccount[] }[];
};

/** idl/gogocash_cashback.devnet.json, parsed. */
export const IDL: Idl = JSON.parse(
  readFileSync(new URL("../idl/gogocash_cashback.devnet.json", import.meta.url), "utf8"),
) as Idl;
