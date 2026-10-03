/**
 * Shared fakes for the operator CLI tests: an in-memory chain behind the
 * `AdminRpc` / `VerifierRpc` interfaces (no network), account encoders, and
 * throwaway key files written only to temp directories.
 *
 * Every key here is derived at runtime from a public label; none is a secret.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  address,
  getAddressEncoder,
  getBase58Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Address,
} from "@solana/kit";
import { AccountState, getMintEncoder, getTokenEncoder } from "@solana-program/token";
import { BPF_LOADER_UPGRADEABLE_ADDRESS, GENESIS_HASH, SYSTEM_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "../src/clusters.ts";
import { getVaultEncoder } from "../src/generated/accounts/vault.ts";
import type { AdminAccount, AdminCommitment, AdminRpc, SignatureStatusView } from "../src/admin/rpc.ts";
import type { TransactionView, VerifierRpc } from "../src/admin/verify.ts";
import type { AdminIo } from "../scripts/lib/admin-run.ts";
import { readKeypairSigner } from "../scripts/lib/keyfile.ts";
import { privateKeyFromSeed, rawPublicKey } from "./vectors.ts";

export const TEST_BLOCKHASH = GENESIS_HASH.devnet;

function seedFor(label: string): Buffer {
  return createHash("sha256").update(`gogocash-public throwaway test key: ${label}`).digest();
}

/** The address of the throwaway key with this label. */
export function labelAddress(label: string): Address {
  return getBase58Decoder().decode(rawPublicKey(privateKeyFromSeed(seedFor(label)))) as Address;
}

export function tempDir(prefix = "gogocash-admin-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Writes a throwaway solana-keygen file (mode 0600) into `dir`. */
export function writeKeyFile(dir: string, label: string, mode = 0o600): { path: string; address: Address } {
  const seed = seedFor(label);
  const publicKey = rawPublicKey(privateKeyFromSeed(seed));
  const filePath = join(dir, `${label.replace(/[^a-z0-9]+/gi, "-")}.json`);
  writeFileSync(filePath, JSON.stringify([...seed, ...publicKey]), { mode: 0o600 });
  chmodSync(filePath, mode);
  return { path: filePath, address: getBase58Decoder().decode(publicKey) as Address };
}

// ---------------------------------------------------------------------------
// Account encoders
// ---------------------------------------------------------------------------

const addressEncoder = getAddressEncoder();

export function programAccount(programDataAddress: Address): AdminAccount {
  const data = new Uint8Array(36);
  new DataView(data.buffer).setUint32(0, 2, true);
  data.set(addressEncoder.encode(programDataAddress), 4);
  return { owner: BPF_LOADER_UPGRADEABLE_ADDRESS, executable: true, lamports: 1_141_440n, data };
}

export function programDataAccount(slot: bigint, upgradeAuthority: Address | null): AdminAccount {
  const data = new Uint8Array(45 + 16);
  const view = new DataView(data.buffer);
  view.setUint32(0, 3, true);
  view.setBigUint64(4, slot, true);
  if (upgradeAuthority !== null) {
    data[12] = 1;
    data.set(addressEncoder.encode(upgradeAuthority), 13);
  }
  data.set([0x7f, 0x45, 0x4c, 0x46], 45);
  return { owner: BPF_LOADER_UPGRADEABLE_ADDRESS, executable: false, lamports: 1n, data };
}

export function mintAccount(decimals = 6): AdminAccount {
  const data = Uint8Array.from(
    getMintEncoder().encode({
      mintAuthority: null,
      supply: 1_000_000_000n,
      decimals,
      isInitialized: true,
      freezeAuthority: null,
    }),
  );
  return { owner: TOKEN_PROGRAM_ADDRESS, executable: false, lamports: 1n, data };
}

export function tokenAccount(input: {
  mint: Address;
  owner: Address;
  amount: bigint;
  frozen?: boolean;
  delegate?: Address;
}): AdminAccount {
  const data = Uint8Array.from(
    getTokenEncoder().encode({
      mint: input.mint,
      owner: input.owner,
      amount: input.amount,
      delegate: input.delegate ?? null,
      state: input.frozen === true ? AccountState.Frozen : AccountState.Initialized,
      isNative: null,
      delegatedAmount: 0n,
      closeAuthority: null,
    }),
  );
  return { owner: TOKEN_PROGRAM_ADDRESS, executable: false, lamports: 1n, data };
}

export type VaultFields = {
  bump: number;
  paused: boolean;
  mint: Address;
  vaultTokenAccount: Address;
  admin: Address;
  pendingAdmin?: Address;
  guardian: Address;
  claimAuthority: Address;
  maxPerClaim: bigint;
  maxPerDay: bigint;
};

export function vaultAccount(programId: Address, fields: VaultFields): AdminAccount {
  const data = Uint8Array.from(
    getVaultEncoder().encode({
      version: 1,
      bump: fields.bump,
      paused: fields.paused,
      decimals: 6,
      mint: fields.mint,
      vaultTokenAccount: fields.vaultTokenAccount,
      admin: fields.admin,
      pendingAdmin: fields.pendingAdmin ?? SYSTEM_PROGRAM_ADDRESS,
      guardian: fields.guardian,
      claimAuthority: fields.claimAuthority,
      maxPerClaim: fields.maxPerClaim,
      maxPerDay: fields.maxPerDay,
      currentDay: 20728n,
      claimedToday: 0n,
      totalClaimed: 0n,
      claimCount: 0n,
      totalWithdrawn: 0n,
      reserved: new Uint8Array(64),
    }),
  );
  return { owner: programId, executable: false, lamports: 2_296_160n, data };
}

// ---------------------------------------------------------------------------
// The fake chain
// ---------------------------------------------------------------------------

export type SentTransaction = {
  readonly wireBase64: string;
  readonly signature: string;
  readonly signatures: ReturnType<ReturnType<typeof getTransactionDecoder>["decode"]>["signatures"];
  readonly messageBytes: Uint8Array;
  readonly message: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>;
};

export class FakeChain implements AdminRpc, VerifierRpc {
  genesisHash: string = GENESIS_HASH.devnet;
  readonly accounts = new Map<string, AdminAccount>();
  readonly transactions = new Map<string, TransactionView>();
  readonly sent: SentTransaction[] = [];
  readonly reads: { address: string; commitment: string }[] = [];
  onSend: ((tx: SentTransaction) => void) | null = null;
  status: SignatureStatusView = { confirmationStatus: "finalized", err: null };
  contextSlot = 500n;

  setAccount(accountAddress: string, account: AdminAccount | null): void {
    if (account === null) this.accounts.delete(accountAddress);
    else this.accounts.set(accountAddress, account);
  }

  async getGenesisHash(): Promise<string> {
    return this.genesisHash;
  }

  async getAccount(accountAddress: Address, commitment: AdminCommitment) {
    this.reads.push({ address: accountAddress, commitment });
    return { contextSlot: this.contextSlot, account: this.accounts.get(accountAddress) ?? null };
  }

  async getLatestBlockhash() {
    return { blockhash: TEST_BLOCKHASH, lastValidBlockHeight: 1_000n };
  }

  async getBlockHeight(): Promise<bigint> {
    return 10n;
  }

  async sendTransaction(wireBase64: string): Promise<string> {
    const bytes = Uint8Array.from(getBase64Encoder().encode(wireBase64));
    const transaction = getTransactionDecoder().decode(bytes);
    const messageBytes = Uint8Array.from(transaction.messageBytes);
    const message = getCompiledTransactionMessageDecoder().decode(messageBytes);
    const first = Object.values(transaction.signatures)[0];
    if (first === null || first === undefined) throw new Error("unsigned transaction sent");
    const signature = getBase58Decoder().decode(first);
    const sent: SentTransaction = { wireBase64, signature, signatures: transaction.signatures, messageBytes, message };
    this.sent.push(sent);
    this.onSend?.(sent);
    return signature;
  }

  async getSignatureStatus(): Promise<SignatureStatusView | null> {
    return this.status;
  }

  async getFinalizedAccount(accountAddress: Address, options: { minContextSlot?: bigint }) {
    this.reads.push({ address: accountAddress, commitment: "finalized" });
    void options;
    const account = this.accounts.get(accountAddress);
    return { contextSlot: this.contextSlot, account: account === undefined ? null : { owner: account.owner, data: account.data } };
  }

  async getFinalizedTransaction(signature: string): Promise<TransactionView | null> {
    return this.transactions.get(signature) ?? null;
  }
}

/** Instruction view of a sent transaction: program address, account addresses, data. */
export function sentInstructions(tx: SentTransaction) {
  const message = tx.message;
  if (message.version !== 0) throw new Error(`expected a v0 message, got ${String(message.version)}`);
  if (message.addressTableLookups !== undefined && message.addressTableLookups.length > 0) {
    throw new Error("admin transactions use no address lookup table");
  }
  const keys = message.staticAccounts;
  return message.instructions.map((instruction) => ({
    programAddress: keys[instruction.programAddressIndex] as string,
    accounts: (instruction.accountIndices ?? []).map((index) => keys[index] as string),
    data: Uint8Array.from(instruction.data ?? new Uint8Array()),
  }));
}

export type CapturedIo = AdminIo & { readonly out: string[]; readonly err: string[]; readonly files: Map<string, string> };

/** An AdminIo over in-memory files, the fake chain and the real key-file loader. */
export function fakeIo(input: {
  chain: FakeChain;
  files: Record<string, string>;
  env?: Record<string, string>;
  createRpc?: (url: string) => AdminRpc;
}): CapturedIo {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map(Object.entries(input.files));
  return {
    env: input.env ?? { SOLANA_RPC_URL: "https://rpc.example.invalid/v1/test-api-key-0123456789" },
    cwd: "/repo",
    createRpc: input.createRpc ?? (() => input.chain),
    loadSigner: (filePath, flag) => readKeypairSigner(filePath, flag),
    readText: (filePath) => files.get(filePath) ?? null,
    writeText: (filePath, text) => {
      files.set(filePath, text);
    },
    stdout: (text) => {
      out.push(text);
    },
    stderr: (text) => {
      err.push(text);
    },
    sleep: async () => {},
    out,
    err,
    files,
  };
}

export const asAddress = (value: string): Address => address(value);
