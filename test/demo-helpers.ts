/**
 * A fake devnet for `npm run demo` tests (no network): the admin fake chain
 * plus rent, priority fees and unsigned claim simulation, with the program's
 * claim, pause and unpause effects applied when a transaction is sent.
 *
 * Every key is a throwaway key derived at runtime from a public label and
 * written only to a temp directory; none is a secret.
 */
import { createHash } from "node:crypto";
import {
  createKeyPairSignerFromPrivateKeyBytes,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, USDC_MINT } from "../src/clusters.ts";
import { getReceiptEncoder } from "../src/generated/accounts/receipt.ts";
import { getClaimInstructionDataDecoder } from "../src/generated/instructions/claim.ts";
import { findClassicAta, findProgramDataAddress, findReceiptPda, findVaultPda, payoutIdToHex } from "../src/program.ts";
import { buildDeploymentRecord, deploymentRecordToJson, toJsonText } from "../src/admin/config.ts";
import type { AdminAccount, AdminCommitment } from "../src/admin/rpc.ts";
import type { TransactionView } from "../src/admin/verify.ts";
import type { DemoRpc, DemoSimulation } from "../src/demo/rpc.ts";
import { CLOCK_SYSVAR_SIZE, SYSVAR_CLOCK_ADDRESS, SYSVAR_PROGRAM_ADDRESS } from "../src/demo/rpc.ts";
import type { DemoIo, InterruptNotice } from "../scripts/lib/demo-run.ts";
import { readKeypairSigner } from "../scripts/lib/keyfile.ts";
import {
  FakeChain,
  labelAddress,
  mintAccount,
  programAccount,
  programDataAccount,
  sentInstructions,
  tokenAccount,
  vaultAccount,
  writeKeyFile,
  type SentTransaction,
  type VaultFields,
} from "./admin-helpers.ts";
import { INSTRUCTION_DISCRIMINATORS_HEX } from "./vectors.ts";

export const PROGRAM = labelAddress("demo test program");
export const DEMO_MINT = labelAddress("demo test mint");
export const DEPLOYER = labelAddress("deployer");
export const API_CLAIM = labelAddress("api claim authority");
export const RPC_URL = "https://demo-rpc.example.invalid/v3/secret-key-QwErTy0123456789";
/** 2026-10-02T03:04:30Z, UTC day 20728 (the fake vault's current_day). */
export const CLOCK_UNIX = 1_790_910_270n;
/** 2026-10-03T03:04:05.678Z. */
export const NOW_MS = Date.UTC(2026, 9, 3, 3, 4, 5, 678);

const hexOf = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

function seedFor(label: string): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(`gogocash-public throwaway test key: ${label}`).digest());
}

/** The throwaway stand-in wallet a test run uses instead of a fresh random key. */
export function throwawaySigner(label: string): Promise<KeyPairSigner> {
  return createKeyPairSignerFromPrivateKeyBytes(seedFor(label));
}

export type SimulationRecord = {
  readonly wireBase64: string;
  readonly unsigned: boolean;
  readonly sent: SentTransaction;
  readonly payoutIdHex: string;
  readonly amount: bigint;
  readonly expiresAt: bigint;
  readonly result: DemoSimulation;
};

/**
 * How the next pause or unpause behaves on the fake chain, used once. The
 * default is the happy path: accepted, and `finalized` on the first poll.
 */
export type AdminSendScenario = {
  /**
   * The send throws. "after_accept": the node took the transaction and it
   * lands (the reply was lost). "before_accept": it never reached the
   * cluster, and its blockhash expires (block height jumps past it).
   */
  readonly sendThrows?: "after_accept" | "before_accept";
  /** Status polls that throw (an RPC 429) before any answer. */
  readonly statusErrors?: number;
  /**
   * Status polls answering `confirmed` before `finalized`. Until then the
   * vault reads the new state at `confirmed` and the old one at `finalized`.
   */
  readonly confirmedPolls?: number;
  /** The status is never reported (always null), and the change never reaches `finalized`. */
  readonly lostStatus?: boolean;
  /** It lands but fails onchain: the status carries an error and the vault is unchanged. */
  readonly failsOnchain?: boolean;
};

type PendingStatus = { statusErrors: number; confirmedPolls: number; lostStatus: boolean };

export class FakeDemoChain extends FakeChain implements DemoRpc {
  readonly events: string[] = [];
  readonly simulations: SimulationRecord[] = [];
  vaultFields!: VaultFields;
  vault!: Address;
  vaultAta!: Address;
  mint: Address = DEMO_MINT;
  vaultBalance = 20_000_000n;
  /** The confirmed block height (every fake blockhash is valid through 1,000). */
  blockHeight = 10n;
  /** Test knobs that break one rule of the program to prove the demo notices. */
  simulateIgnoresPause = false;
  simulateIgnoresReceipts = false;
  /** One-shot behaviour of the next pause and unpause sends. */
  readonly adminScenarios: { pause?: AdminSendScenario; unpause?: AdminSendScenario } = {};
  /** Status polls (by signature) per admin transaction, for ordering assertions. */
  readonly statusPolls: string[] = [];
  private readonly pending = new Map<string, PendingStatus>();
  /** Signatures that never reached the cluster: no status, ever. */
  private readonly dropped = new Set<string>();
  /** Signatures that landed and failed onchain (6002 NotAdmin at instruction 0). */
  private readonly failedOnchain = new Set<string>();
  /** Accounts whose `finalized` view lags the latest one. */
  private readonly finalizedView = new Map<string, AdminAccount | null>();

  override async getAccount(accountAddress: Address, commitment: AdminCommitment) {
    if (commitment === "finalized" && this.finalizedView.has(accountAddress)) {
      this.reads.push({ address: accountAddress, commitment });
      return { contextSlot: this.contextSlot, account: this.finalizedView.get(accountAddress) ?? null };
    }
    return super.getAccount(accountAddress, commitment);
  }

  override async getFinalizedAccount(accountAddress: Address, options: { minContextSlot?: bigint }) {
    if (this.finalizedView.has(accountAddress)) {
      this.reads.push({ address: accountAddress, commitment: "finalized" });
      const account = this.finalizedView.get(accountAddress) ?? null;
      return { contextSlot: this.contextSlot, account: account === null ? null : { owner: account.owner, data: account.data } };
    }
    return super.getFinalizedAccount(accountAddress, options);
  }

  override async getBlockHeight(): Promise<bigint> {
    return this.blockHeight;
  }

  /** A blockhash per block height, valid for 990 more blocks (1,000 at the start). */
  override async getLatestBlockhash() {
    const base = await super.getLatestBlockhash();
    if (this.blockHeight === 10n) return base;
    return { blockhash: labelAddress(`fake blockhash at ${this.blockHeight}`) as string, lastValidBlockHeight: this.blockHeight + 990n };
  }

  override async getSignatureStatus(signature?: string) {
    if (signature !== undefined && this.dropped.has(signature)) {
      this.statusPolls.push(signature);
      return null;
    }
    if (signature !== undefined && this.failedOnchain.has(signature)) {
      this.statusPolls.push(signature);
      return { confirmationStatus: "finalized" as const, err: { InstructionError: [0, { Custom: 6002 }] } };
    }
    const pending = signature === undefined ? undefined : this.pending.get(signature);
    if (pending === undefined) return super.getSignatureStatus();
    this.statusPolls.push(signature as string);
    if (pending.statusErrors > 0) {
      pending.statusErrors -= 1;
      throw new Error("HTTP error (429): Too Many Requests");
    }
    if (pending.lostStatus) return null;
    if (pending.confirmedPolls > 0) {
      pending.confirmedPolls -= 1;
      return { confirmationStatus: "confirmed" as const, err: null };
    }
    this.pending.delete(signature as string);
    this.finalizedView.delete(this.vault);
    return { confirmationStatus: "finalized" as const, err: null };
  }

  async getMinimumBalanceForRentExemption(size: bigint): Promise<bigint> {
    // The 2 Oct 2026 observation of the contract: (data_len + 128) x 5,080 lamports.
    return (size + 128n) * 5_080n;
  }

  async getRecentPrioritizationFees(): Promise<readonly { prioritizationFee: bigint }[]> {
    return [{ prioritizationFee: 1_000n }, { prioritizationFee: 4_000n }, { prioritizationFee: 2_000n }, { prioritizationFee: 3_000n }];
  }

  setVault(fields: Partial<VaultFields>): void {
    this.vaultFields = { ...this.vaultFields, ...fields };
    this.setAccount(this.vault, vaultAccount(PROGRAM, this.vaultFields));
  }

  setVaultBalance(amount: bigint): void {
    this.vaultBalance = amount;
    this.setAccount(this.vaultAta, tokenAccount({ mint: this.mint, owner: this.vault, amount }));
  }

  private decode(wireBase64: string): SentTransaction {
    const bytes = Uint8Array.from(getBase64Encoder().encode(wireBase64));
    const transaction = getTransactionDecoder().decode(bytes);
    const messageBytes = Uint8Array.from(transaction.messageBytes);
    const message = getCompiledTransactionMessageDecoder().decode(messageBytes);
    const first = Object.values(transaction.signatures)[0];
    const signature = first === null || first === undefined ? "" : Buffer.from(first).toString("hex");
    return { wireBase64, signature, signatures: transaction.signatures, messageBytes, message };
  }

  private claimOf(tx: SentTransaction) {
    const instructions = sentInstructions(tx);
    const claim = instructions.find((ix) => ix.programAddress === PROGRAM && hexOf(ix.data.subarray(0, 8)) === INSTRUCTION_DISCRIMINATORS_HEX.claim);
    if (claim === undefined) return null;
    const data = getClaimInstructionDataDecoder().decode(claim.data);
    return { claim, instructions, data };
  }

  async simulateUnsigned(wireBase64: string): Promise<DemoSimulation> {
    const tx = this.decode(wireBase64);
    const unsigned = Object.values(tx.signatures).every((s) => s === null || s.every((byte) => byte === 0));
    const found = this.claimOf(tx);
    if (found === null) throw new Error("the fake only simulates claim transactions");
    const { claim, data } = found;
    const receipt = claim.accounts[1] as string;
    const recipientAta = claim.accounts[5] as string;
    const ataExists = this.accounts.has(recipientAta);
    let result: DemoSimulation;
    if (this.accounts.has(receipt) && !this.simulateIgnoresReceipts) {
      result = {
        err: { InstructionError: [3n, { Custom: 0n }] },
        logs: [
          `Program ${PROGRAM} invoke [1]`,
          "Program 11111111111111111111111111111111 invoke [2]",
          `Allocate: account Address { address: ${receipt}, base: None } already in use`,
          "Program 11111111111111111111111111111111 failed: custom program error: 0x0",
        ],
        unitsConsumed: 9_000n,
      };
    } else if (this.vaultFields.paused && !this.simulateIgnoresPause) {
      result = {
        err: { InstructionError: [3n, { Custom: 6000n }] },
        logs: ["Program log: AnchorError occurred. Error Code: Paused. Error Number: 6000. Error Message: Vault is paused."],
        unitsConsumed: 14_000n,
      };
    } else if (data.amount > this.vaultFields.maxPerClaim) {
      result = {
        err: { InstructionError: [3n, { Custom: 6010n }] },
        logs: ["Program log: AnchorError occurred. Error Code: ExceedsMaxPerClaim. Error Number: 6010."],
        unitsConsumed: 15_000n,
      };
    } else if (data.amount > this.vaultBalance) {
      result = { err: { InstructionError: [3n, { Custom: 6016n }] }, logs: [], unitsConsumed: 16_000n };
    } else {
      result = { err: null, logs: [], unitsConsumed: ataExists ? 31_000n : 52_000n };
    }
    this.events.push(`simulate:claim:${data.amount}`);
    this.simulations.push({
      wireBase64,
      unsigned,
      sent: tx,
      payoutIdHex: payoutIdToHex(Uint8Array.from(data.payoutId)),
      amount: data.amount,
      expiresAt: data.expiresAt,
      result,
    });
    return result;
  }

  override async sendTransaction(wireBase64: string): Promise<string> {
    const signature = await super.sendTransaction(wireBase64);
    const tx = this.sent[this.sent.length - 1] as SentTransaction;
    const instructions = sentInstructions(tx);
    const found = this.claimOf(tx);
    if (found !== null) {
      await this.applyClaim(tx, signature, found);
      this.events.push("send:claim");
      return signature;
    }
    const programIx = instructions.find((ix) => ix.programAddress === PROGRAM);
    const discriminator = programIx === undefined ? "" : hexOf(programIx.data.subarray(0, 8));
    const kind =
      discriminator === INSTRUCTION_DISCRIMINATORS_HEX.pause ? "pause" : discriminator === INSTRUCTION_DISCRIMINATORS_HEX.unpause ? "unpause" : null;
    if (kind === null) {
      this.events.push("send:other");
      return signature;
    }
    const scenario = this.adminScenarios[kind] ?? {};
    delete this.adminScenarios[kind];
    if (scenario.sendThrows === "before_accept") {
      // Never reached the cluster: not sent, and its blockhash expires.
      this.sent.pop();
      this.dropped.add(signature);
      this.blockHeight = 2_000n;
      this.events.push(`drop:${kind}`);
      throw new Error("fetch failed");
    }
    if (scenario.failsOnchain === true) {
      this.events.push(`fail:${kind}`);
      this.failedOnchain.add(signature);
      return signature;
    }
    const finalizedBefore = this.accounts.get(this.vault) ?? null;
    this.setVault({ paused: kind === "pause" });
    this.events.push(`send:${kind}`);
    const lagging = scenario.lostStatus === true || (scenario.confirmedPolls ?? 0) > 0;
    if (!lagging) this.finalizedView.delete(this.vault);
    else if (!this.finalizedView.has(this.vault)) this.finalizedView.set(this.vault, finalizedBefore);
    this.pending.set(signature, {
      statusErrors: scenario.statusErrors ?? 0,
      confirmedPolls: scenario.confirmedPolls ?? 0,
      lostStatus: scenario.lostStatus === true,
    });
    if (scenario.sendThrows === "after_accept") throw new Error("fetch failed");
    return signature;
  }

  private async applyClaim(
    tx: SentTransaction,
    signature: string,
    found: NonNullable<ReturnType<FakeDemoChain["claimOf"]>>,
  ): Promise<void> {
    const { claim, data } = found;
    const [vault, receipt, mint, vaultAta, recipient, recipientAta] = claim.accounts as [string, string, string, string, string, string];
    if (this.accounts.has(receipt)) throw new Error("the fake refuses a second claim of the same payout_id");
    const payoutId = Uint8Array.from(data.payoutId);
    const pda = await findReceiptPda({ programAddress: PROGRAM, vault: vault as Address, payoutId });
    if (pda.address !== receipt) throw new Error("receipt is not the canonical PDA");
    this.setAccount(receipt, {
      owner: PROGRAM,
      executable: false,
      lamports: 1_102_360n,
      data: Uint8Array.from(
        getReceiptEncoder().encode({ bump: pda.bump, payoutId, recipient: recipient as Address, amount: data.amount, claimedAt: CLOCK_UNIX }),
      ),
    });
    const before = this.vaultBalance;
    this.setVaultBalance(before - data.amount);
    this.setAccount(recipientAta, tokenAccount({ mint: mint as Address, owner: recipient as Address, amount: data.amount }));
    const message = tx.message;
    if (message.version !== 0) throw new Error("the claim must be a v0 message");
    const keys = message.staticAccounts.map(String);
    const balance = (account: string, owner: string, amount: bigint) => ({
      accountIndex: keys.indexOf(account),
      mint,
      owner,
      programId: TOKEN_PROGRAM_ADDRESS,
      uiTokenAmount: { amount: amount.toString() },
    });
    const view: TransactionView = {
      slot: 412_400_000n,
      staticAccountKeys: keys,
      instructions: message.instructions.map((ix) => ({
        programIdIndex: ix.programAddressIndex,
        accounts: [...(ix.accountIndices ?? [])],
        data: Uint8Array.from(ix.data ?? new Uint8Array()),
      })),
      meta: {
        err: null,
        preTokenBalances: [balance(vaultAta, vault, before)],
        postTokenBalances: [balance(vaultAta, vault, before - data.amount), balance(recipientAta, recipient, data.amount)],
        loadedAddresses: { writable: [], readonly: [] },
      },
    };
    this.transactions.set(signature, view);
  }
}

export type DemoKeys = {
  claim: { path: string; address: Address };
  guardian: { path: string; address: Address };
  admin: { path: string; address: Address };
  payer: { path: string; address: Address };
};

export function demoKeys(dir: string): DemoKeys {
  return {
    claim: writeKeyFile(dir, "demo claim authority"),
    guardian: writeKeyFile(dir, "guardian"),
    admin: writeKeyFile(dir, "admin"),
    payer: writeKeyFile(dir, "demo fee payer"),
  };
}

export type DemoWorld = {
  chain: FakeDemoChain;
  files: Map<string, string>;
  keys: DemoKeys;
  usdcVault: Address;
};

/** A deployed program with an unpaused, funded demo vault (and the usdc vault beside it). */
export async function demoWorld(keys: DemoKeys, options: { demoClaimAuthority?: Address } = {}): Promise<DemoWorld> {
  const chain = new FakeDemoChain();
  const programData = (await findProgramDataAddress(PROGRAM)).address;
  const demo = await findVaultPda({ programAddress: PROGRAM, mint: DEMO_MINT });
  const demoAta = await findClassicAta({ owner: demo.address, mint: DEMO_MINT });
  const usdc = await findVaultPda({ programAddress: PROGRAM, mint: USDC_MINT.devnet });
  const usdcAta = await findClassicAta({ owner: usdc.address, mint: USDC_MINT.devnet });
  chain.vault = demo.address;
  chain.vaultAta = demoAta;
  chain.vaultFields = {
    bump: demo.bump,
    paused: false,
    mint: DEMO_MINT,
    vaultTokenAccount: demoAta,
    admin: keys.admin.address,
    guardian: keys.guardian.address,
    claimAuthority: options.demoClaimAuthority ?? keys.claim.address,
    maxPerClaim: 5_000_000n,
    maxPerDay: 20_000_000n,
  };
  chain.setAccount(PROGRAM, programAccount(programData));
  chain.setAccount(programData, programDataAccount(412_345_678n, DEPLOYER));
  chain.setVault({});
  chain.setVaultBalance(20_000_000n);
  chain.setAccount(DEMO_MINT, mintAccount(6));
  chain.setAccount(keys.payer.address, { owner: SYSTEM_PROGRAM_ADDRESS, executable: false, lamports: 1_000_000_000n, data: new Uint8Array() });
  const clock = new Uint8Array(CLOCK_SYSVAR_SIZE);
  new DataView(clock.buffer).setBigInt64(32, CLOCK_UNIX, true);
  chain.setAccount(SYSVAR_CLOCK_ADDRESS, { owner: SYSVAR_PROGRAM_ADDRESS, executable: false, lamports: 1n, data: clock });

  const vaultRecord = (name: string, pda: { address: Address; bump: number }, mint: Address, ata: Address, claimAuthority: Address) => ({
    name,
    mint,
    vault: pda.address,
    vaultBump: pda.bump,
    vaultTokenAccount: ata,
    admin: keys.admin.address,
    guardian: keys.guardian.address,
    claimAuthority,
    maxPerClaim: 5_000_000n,
    maxPerDay: 20_000_000n,
    initializeSignature: null,
  });
  const record = buildDeploymentRecord({
    cluster: "devnet",
    programId: PROGRAM,
    programDataAddress: programData,
    upgradeAuthority: DEPLOYER,
    deploySlot: 412_345_678n,
    programHash: "ab".repeat(32),
    soSha256: "cd".repeat(32),
    source: { repository: "mygogocash/gogocash-public", commit: "e".repeat(40), tag: "v0.1.0" },
    vaults: [
      vaultRecord("usdc", usdc, USDC_MINT.devnet, usdcAta, API_CLAIM),
      vaultRecord("demo", demo, DEMO_MINT, demoAta, keys.claim.address),
    ],
  });
  const manifest = {
    schema: 1,
    contract: "v0",
    programIds: { devnet: PROGRAM, mainnet: null },
    deployments: {
      devnet: {
        programHash: "ab".repeat(32),
        soSha256: "cd".repeat(32),
        deploySlot: "412345678",
        upgradeAuthority: DEPLOYER,
        commit: "e".repeat(40),
        tag: "v0.1.0",
        vaults: [
          { name: "usdc", mint: USDC_MINT.devnet, vault: usdc.address, vaultTokenAccount: usdcAta },
          { name: "demo", mint: DEMO_MINT, vault: demo.address, vaultTokenAccount: demoAta },
        ],
      },
      mainnet: null,
    },
  };
  const files = new Map<string, string>([
    ["/repo/release/manifest.json", toJsonText(manifest)],
    ["/repo/deployments/devnet.json", toJsonText(deploymentRecordToJson(record))],
  ]);
  return { chain, files, keys, usdcVault: usdc.address };
}

export type CapturedDemoIo = DemoIo & {
  readonly out: string[];
  readonly err: string[];
  readonly calls: { createRpc: number; loadSigner: number };
  /** Each Ctrl-C hold, as the number of chain events seen when it was taken and released. */
  readonly interrupts: { heldAt: number; releasedAt: number | null }[];
  readonly interruptNotices: InterruptNotice[];
};

/** A DemoIo over in-memory files and the fake chain, with the real key-file loader on temp files. */
export function demoIo(world: DemoWorld, options: { env?: Record<string, string> } = {}): CapturedDemoIo {
  const out: string[] = [];
  const err: string[] = [];
  const calls = { createRpc: 0, loadSigner: 0 };
  const interrupts: { heldAt: number; releasedAt: number | null }[] = [];
  const interruptNotices: InterruptNotice[] = [];
  let counter = 0;
  return {
    env: options.env ?? { SOLANA_RPC_URL: RPC_URL },
    cwd: "/repo",
    createRpc: () => {
      calls.createRpc += 1;
      return world.chain;
    },
    loadSigner: (filePath, flag) => {
      calls.loadSigner += 1;
      return readKeypairSigner(filePath, flag);
    },
    generateRecipient: () => throwawaySigner("stand-in wallet"),
    randomBytes: (length) => {
      counter += 1;
      return Uint8Array.from(createHash("sha256").update(`demo test random ${counter}`).digest().subarray(0, length));
    },
    now: () => NOW_MS,
    readText: (filePath) => world.files.get(filePath) ?? null,
    writeNewText: (filePath, text) => {
      if (world.files.has(filePath)) return false;
      world.files.set(filePath, text);
      return true;
    },
    stdout: (text) => {
      out.push(text);
    },
    stderr: (text) => {
      err.push(text);
    },
    sleep: async () => {},
    holdInterrupts: (notice) => {
      const hold = { heldAt: world.chain.events.length, releasedAt: null as number | null };
      interrupts.push(hold);
      interruptNotices.push(notice);
      return () => {
        hold.releasedAt = world.chain.events.length;
      };
    },
    out,
    err,
    calls,
    interrupts,
    interruptNotices,
  };
}

export function demoArgs(keys: DemoKeys, extra: string[] = []): string[] {
  return [
    "--cluster",
    "devnet",
    "--vault",
    "demo",
    "--claim-keypair",
    keys.claim.path,
    "--guardian-keypair",
    keys.guardian.path,
    "--admin-keypair",
    keys.admin.path,
    "--fee-payer",
    keys.payer.path,
    ...extra,
  ];
}

export const EVIDENCE_PATH = "/repo/evidence/devnet-demo-2026-10-03.md";
