/**
 * The devnet demo behind `npm run demo -- --cluster devnet --vault demo`
 * (plan step R5, #2983). scripts/demo.ts wires the real key files, RPC
 * client, clock, randomness and file system; tests call `runDemo` with a fake
 * chain. The pure parts live in src/demo/.
 *
 * It runs only against the demo-mint vault (never the USDC vault the API
 * claims from), in this order:
 *
 *   1. THB 125.00 to USDC atomic with bigint math (src/amount.ts);
 *   2. a stand-in wallet made in memory signs the section 4 consent bytes,
 *      verified with src/siws.ts;
 *   3. the claim from src/claim-tx.ts (ATA idempotent + claim): unsigned
 *      simulation, signed by the fee payer and the claim key, sent, waited
 *      for `finalized`, then the receipt verified with src/verify-receipt.ts
 *      (tuple match) gives `paid`;
 *   4. a replay of the same payout_id is refused with "already in use",
 *      classified `already_claimed` by src/errors.ts (simulation);
 *   5. the keyless verifier gives `paid`, and `mismatch` with amount + 1;
 *   6. a claim over `max_per_claim` is refused with 6010 (simulation);
 *   7. pause drill: the guardian pauses (admin CLI builder), a claim is
 *      refused with 6000 Paused (simulation), the admin unpauses.
 *
 * Every read and check runs before the first transaction: a wrong key, a
 * paused or drifted vault, mainnet, or a missing fund refuses with nothing
 * sent. A funding shortfall prints only the address to fund (exit 3). The
 * RPC URL is never printed or written. The evidence file holds public data
 * only and passes the src/demo/evidence.ts guard before it is written.
 *
 * Exit codes: 0 every step passed; 1 a step failed after the run started
 * (the evidence file records it; if the file cannot be written, the demo
 * prints why); 2 refused or stopped by an RPC or setup error before anything
 * was sent (no evidence file); 3 funds needed, nothing sent.
 *
 * The pause drill settles the pause's fate from its signature status
 * (src/demo/settle.ts) before deciding whether to unpause, and holds Ctrl-C
 * until the vault is restored.
 */
import path from "node:path";
import {
  getAddressEncoder,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  signBytes,
  signTransaction,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { formatUsdcAtomicFixed6 } from "../../src/amount.ts";
import {
  buildClaimSimulationTransaction,
  buildClaimTransaction,
  claimComputeUnitLimitFromSimulation,
  DEFAULT_PRIORITY_FEE_CAP_MICROLAMPORTS,
  priorityPriceFromRecentFees,
  type ClaimTransaction,
  type ClaimTransactionInput,
} from "../../src/claim-tx.ts";
import { genesisHashMatches, USDC_MINT } from "../../src/clusters.ts";
import { classifyTransactionError } from "../../src/errors.ts";
import { decodeVault, findClassicAta, findVaultPda, RECEIPT_ACCOUNT_SIZE, type Vault } from "../../src/program.ts";
import { verifyReceipt, type VerifyReceiptResult } from "../../src/verify-receipt.ts";
import {
  AdminConfigError,
  parseDeploymentRecord,
  parseReleaseManifest,
  resolveProgramId,
  type ManifestVault,
} from "../../src/admin/config.ts";
import { AdminInstructionError, buildPauseInstruction, buildUnpauseInstruction } from "../../src/admin/instructions.ts";
import { programAccountProblem } from "../../src/admin/loader.ts";
import { sendAndConfirm, TransactionExpiredError, TransactionFailedError } from "../../src/admin/rpc.ts";
import {
  decodeMintDecimals,
  decodeTokenAccount,
  pauseProblem,
  StateDecodeError,
  TOKEN_ACCOUNT_SIZE,
  unpauseProblem,
} from "../../src/admin/state.ts";
import { buildAdminTransactionMessage } from "../../src/admin/transaction.ts";
import { verifyDevnetSignature, type Expectation as VerifierExpectation, type VerifyDevnetResult } from "../../src/admin/verify.ts";
import { demoConsentInput, newDemoIds, newPayoutId, signAndVerifyConsent } from "../../src/demo/consent.ts";
import { DEMO_EXPECTED_USDC_ATOMIC, DEMO_FEE_MINOR, DEMO_THB_AMOUNT, demoConversion } from "../../src/demo/conversion.ts";
import {
  evidenceDate,
  evidenceFileName,
  evidenceProblems,
  overallOutcome,
  renderEvidence,
  type DemoEvidence,
  type EvidenceSignature,
  type EvidenceStep,
} from "../../src/demo/evidence.ts";
import { describeVerdict, expectAlreadyClaimed, expectProgramError, judgeClaimSimulation, CLAIM_TRANSACTION_KINDS } from "../../src/demo/outcomes.ts";
import { describeShortfall, demoStateProblems, fundingShortfalls } from "../../src/demo/precheck.ts";
import { ClockDecodeError, readClockUnixTimestamp, type DemoRpc } from "../../src/demo/rpc.ts";
import { describeFate, settleSignature, type SignatureFate } from "../../src/demo/settle.ts";
import { parseArgs, pathOption, UsageError, type ArgSpec } from "./args.ts";
import { KeyFileError } from "./keyfile.ts";
import { redactRpcUrl } from "./redact.ts";

export const DEMO_USAGE = `Usage: npm run demo -- --cluster devnet --vault demo \\
         --claim-keypair <demo-claim-authority.json> \\
         --guardian-keypair <guardian.json> --admin-keypair <admin.json> \\
         [--fee-payer <file>] [--rpc-url <url>] [--manifest <file>] \\
         [--deployment <file>] [--evidence-dir <dir>]

Runs the R5 demo on the demo-mint vault (never the USDC vault the API claims from):
  1. THB 125.00 to USDC with bigint math
  2. a stand-in wallet made in memory signs the consent bytes
  3. claim, finalized, receipt verified: paid
  4. replay of the same payout_id: already_claimed
  5. keyless verifier: paid, and mismatch with amount + 1
  6. over-cap claim simulation: refused (6010)
  7. pause drill: guardian pauses, a claim is refused (6000), admin unpauses
then writes evidence/devnet-demo-<date>.md (public data only).

Key files are read by path only (mode 0600). The fee payer defaults to the claim key and pays
every fee and rent. If the fee payer or the vault lacks funds, the demo exits before any
transaction and prints only the address to fund. Mainnet is refused. The RPC URL defaults to
the SOLANA_RPC_URL environment variable and is never printed.
Exit codes: 0 all steps passed (evidence written); 1 a step failed after the run started (the evidence
file records it); 2 refused, or an RPC or setup error, before anything was sent (no evidence file);
3 funds needed (nothing sent).
`;

export const DEMO_EXIT = { passed: 0, failed: 1, refused: 2, needsFunds: 3 } as const;

/** `expires_at = clock.unix_timestamp + 300` (contract section 9.1 step 4). */
export const CLAIM_EXPIRY_SECONDS = 300n;

export type DemoIo = {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The repository root; default file paths resolve against it. */
  readonly cwd: string;
  readonly createRpc: (rpcUrl: string) => DemoRpc;
  /** Loads a key file (mode 0600) into a non-extractable signer. */
  readonly loadSigner: (filePath: string, flag: string) => Promise<KeyPairSigner>;
  /** The stand-in member wallet: a throwaway key made in memory for this run, never written. */
  readonly generateRecipient: () => Promise<KeyPairSigner>;
  readonly randomBytes: (length: number) => Uint8Array;
  /** Epoch milliseconds. */
  readonly now: () => number;
  /** File text, or `null` when the file does not exist. */
  readonly readText: (filePath: string) => string | null;
  /** Creates the file and its directory; returns `false`, writing nothing, if the file exists. */
  readonly writeNewText: (filePath: string, text: string) => boolean;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
  /**
   * Holds Ctrl-C during the pause drill: while held, the first Ctrl-C prints
   * `onFirst` and lets the run finish restoring the vault; a second prints
   * `onSecond` and stops the process. Returns the release.
   */
  readonly holdInterrupts: (notice: InterruptNotice) => () => void;
};

export type InterruptNotice = { readonly onFirst: string; readonly onSecond: string };

/** `DemoIo.holdInterrupts` over a process-like SIGINT source (scripts/demo.ts passes `process`). */
export function interruptHolder(
  target: {
    on(event: "SIGINT", listener: () => void): unknown;
    off(event: "SIGINT", listener: () => void): unknown;
    exit(code: number): void;
  },
  stderr: (text: string) => void,
): DemoIo["holdInterrupts"] {
  return (notice) => {
    let received = 0;
    const listener = (): void => {
      received += 1;
      if (received === 1) {
        stderr(`${notice.onFirst}\n`);
        return;
      }
      stderr(`${notice.onSecond}\n`);
      target.exit(130);
    };
    target.on("SIGINT", listener);
    return () => {
      target.off("SIGINT", listener);
    };
  };
}

/** A refusal before anything was sent; safe to print. */
class Refusal extends Error {
  override name = "Refusal";
}

/** A pause-drill failure whose message is already a full sentence fragment. */
class DrillError extends Error {
  override name = "DrillError";
}

/** A signed admin transaction, not yet sent. */
type SignedAdmin = {
  readonly label: string;
  readonly signature: string;
  readonly wireBase64: string;
  readonly lastValidBlockHeight: bigint;
};

/** Reads of the vault in the pause drill's restore, before giving up. */
const VAULT_READ_ATTEMPTS = 5;
/** Unpause transactions sent while each one expires without landing. */
const UNPAUSE_ATTEMPTS = 3;

const SPEC: ArgSpec = {
  values: [
    "--cluster",
    "--vault",
    "--claim-keypair",
    "--fee-payer",
    "--guardian-keypair",
    "--admin-keypair",
    "--rpc-url",
    "--manifest",
    "--deployment",
    "--evidence-dir",
  ],
  flags: ["--help"],
};

type Ready = {
  readonly rpc: DemoRpc;
  readonly programId: Address;
  readonly genesisHash: string;
  readonly vaultName: string;
  readonly vault: Address;
  readonly mint: Address;
  readonly vaultTokenAccount: Address;
  readonly manifestVaults: readonly ManifestVault[];
  readonly claim: KeyPairSigner;
  readonly guardian: KeyPairSigner;
  readonly admin: KeyPairSigner;
  readonly payer: KeyPairSigner;
  readonly recipient: KeyPairSigner;
  readonly recipientAta: Address;
  readonly amountAtomic: bigint;
  readonly deductedMinor: bigint;
  readonly conversionLines: readonly string[];
  readonly evidenceDir: string;
};

type Prepared = { readonly kind: "help" } | { readonly kind: "fund"; readonly lines: readonly string[] } | { readonly kind: "ready"; readonly ready: Ready };

/** Runs the demo. Returns the process exit code (see `DEMO_EXIT`). */
export async function runDemo(argv: readonly string[], io: DemoIo): Promise<number> {
  const rpcUrl = (() => {
    const index = argv.indexOf("--rpc-url");
    return (index === -1 ? undefined : argv[index + 1]) ?? io.env.SOLANA_RPC_URL;
  })();
  const say = (line: string): void => io.stdout(redactRpcUrl(`${line}\n`, rpcUrl));
  const warn = (line: string): void => io.stderr(redactRpcUrl(`${line}\n`, rpcUrl));

  let prepared: Prepared;
  try {
    prepared = await prepare(argv, io, rpcUrl);
  } catch (error) {
    if (
      error instanceof UsageError ||
      error instanceof Refusal ||
      error instanceof AdminConfigError ||
      error instanceof KeyFileError ||
      error instanceof StateDecodeError ||
      error instanceof ClockDecodeError
    ) {
      warn(`demo: ${error.message}`);
      warn("demo: nothing was sent.");
      return DEMO_EXIT.refused;
    }
    // An RPC or setup error before the first transaction: nothing was sent
    // and no evidence is written, so it shares the refusal's exit code.
    warn(`demo: ${describeError(error)}`);
    warn("demo: nothing was sent.");
    return DEMO_EXIT.refused;
  }
  if (prepared.kind === "help") {
    warn(DEMO_USAGE);
    return DEMO_EXIT.passed;
  }
  if (prepared.kind === "fund") {
    warn("demo: not enough funds; nothing was sent.");
    for (const line of prepared.lines) warn(line);
    return DEMO_EXIT.needsFunds;
  }

  const ready = prepared.ready;
  const startedAt = io.now();
  try {
    return await finish(ready, io, startedAt, rpcUrl, say, warn);
  } catch (error) {
    // Steps catch their own errors; this is a last resort, still redacted.
    warn(`demo: ${describeError(error)}`);
    return DEMO_EXIT.failed;
  }
}

/** Runs the steps, then renders, checks and writes the evidence file. */
async function finish(
  ready: Ready,
  io: DemoIo,
  startedAt: number,
  rpcUrl: string | undefined,
  say: (line: string) => void,
  warn: (line: string) => void,
): Promise<number> {
  const produced = new Set<string>();
  const steps = await runSteps(ready, io, say, (error) => redactRpcUrl(describeError(error), rpcUrl), produced);
  const evidence: DemoEvidence = {
    date: evidenceDate(startedAt),
    generatedAt: new Date(startedAt).toISOString(),
    command: `npm run demo -- --cluster devnet --vault ${ready.vaultName}`,
    genesisHash: ready.genesisHash,
    programId: ready.programId,
    vault: { name: ready.vaultName, address: ready.vault, mint: ready.mint, tokenAccount: ready.vaultTokenAccount },
    roles: {
      claimAuthority: ready.claim.address,
      guardian: ready.guardian.address,
      admin: ready.admin.address,
      payer: ready.payer.address,
      recipient: ready.recipient.address,
    },
    steps,
  };
  const outcome = overallOutcome(steps);
  const text = renderEvidence(evidence);
  const problems = evidenceProblems(text, {
    allowedLongValues: [...produced],
    forbidden: rpcUrlNeedles(rpcUrl),
  });
  if (problems.length > 0) {
    warn(`demo: the evidence file was not written: ${problems.join(" ")}`);
    return DEMO_EXIT.failed;
  }
  const written = writeEvidence(io, ready.evidenceDir, evidence.date, text);
  say(`demo: ${outcome}. Evidence: ${path.relative(io.cwd, written) || written}`);
  return outcome === "PASS" ? DEMO_EXIT.passed : DEMO_EXIT.failed;
}

/** The RPC URL and its host: neither may appear in the evidence file. */
function rpcUrlNeedles(rpcUrl: string | undefined): string[] {
  if (rpcUrl === undefined || rpcUrl === "") return [];
  const needles = [rpcUrl];
  try {
    const url = new URL(rpcUrl);
    needles.push(url.host, url.origin);
  } catch {
    // Not a parseable URL: the literal value is still forbidden.
  }
  return needles;
}

function writeEvidence(io: DemoIo, dir: string, date: string, text: string): string {
  for (let attempt = 1; attempt <= 99; attempt += 1) {
    const filePath = path.join(dir, evidenceFileName(date, attempt));
    if (io.writeNewText(filePath, text)) return filePath;
  }
  throw new Error("no free evidence file name for today (99 runs).");
}

function describeError(error: unknown): string {
  if (error instanceof TransactionFailedError || error instanceof TransactionExpiredError || error instanceof DrillError) return error.message;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return "unexpected error";
}

function readJson(io: DemoIo, filePath: string, label: string): unknown {
  const text = io.readText(filePath);
  if (text === null) throw new AdminConfigError(`${label} was not found.`);
  try {
    return JSON.parse(text);
  } catch {
    throw new AdminConfigError(`${label} is not valid JSON.`);
  }
}

function requiredPath(args: ReturnType<typeof parseArgs>, name: string): string {
  const value = pathOption(args, name);
  if (value === undefined) throw new UsageError(`${name} <file> is required.`);
  return value;
}

async function readVaultAt(rpc: DemoRpc, programId: Address, vault: Address, commitment: "confirmed" | "finalized"): Promise<Vault> {
  const account = (await rpc.getAccount(vault, commitment)).account;
  if (account === null) throw new Refusal(`vault ${vault} does not exist on devnet.`);
  if (account.owner !== programId) throw new Refusal(`vault ${vault} is not owned by the program.`);
  return decodeVault(account.data);
}

// ---------------------------------------------------------------------------
// Before anything is sent
// ---------------------------------------------------------------------------

async function prepare(argv: readonly string[], io: DemoIo, rpcUrl: string | undefined): Promise<Prepared> {
  const args = parseArgs(argv, SPEC);
  if (args.flags.has("--help")) return { kind: "help" };

  // Mainnet is refused before any file, key or RPC is touched.
  const cluster = args.values.get("--cluster");
  if (cluster === undefined) throw new UsageError("--cluster devnet is required.");
  if (cluster === "mainnet") {
    throw new Refusal("mainnet is refused: the demo runs on devnet only, and contract v0 has no mainnet program id.");
  }
  if (cluster !== "devnet") throw new UsageError('--cluster must be "devnet".');
  const vaultName = args.values.get("--vault");
  if (vaultName === undefined) throw new UsageError("--vault <name> is required (the demo-mint vault, normally demo).");
  if (vaultName === "usdc") {
    throw new Refusal('the demo never runs against the "usdc" vault the API claims from; pass --vault demo.');
  }

  const manifestPath = pathOption(args, "--manifest") ?? path.join(io.cwd, "release", "manifest.json");
  const manifest = parseReleaseManifest(readJson(io, manifestPath, "release/manifest.json"));
  const resolution = resolveProgramId(manifest, "devnet", { iUnderstandMainnet: false });
  if (resolution.ok === false) throw new Refusal(resolution.message);
  const programId = resolution.programId;
  const deployment = manifest.deployments.devnet;
  if (deployment === null) {
    throw new AdminConfigError("release/manifest.json has no devnet deployment; commit the deploy workflow's record first.");
  }

  const deploymentPath = pathOption(args, "--deployment") ?? path.join(io.cwd, "deployments", "devnet.json");
  const record = parseDeploymentRecord(readJson(io, deploymentPath, "deployments/devnet.json"), "devnet");
  if (record.programId !== programId) throw new AdminConfigError("deployments/devnet.json names another program than the manifest.");
  const entry = record.vaults.find((v) => v.name === vaultName);
  if (entry === undefined) {
    throw new AdminConfigError(`deployments/devnet.json has no vault "${vaultName}"; open the demo vault first (docs/RUNBOOK-DEVNET.md).`);
  }
  if (entry.mint === USDC_MINT.devnet) {
    throw new Refusal(`vault "${vaultName}" is on the USDC mint; the demo runs only on the demo-mint vault.`);
  }
  if (record.vaults.some((v) => v.name !== vaultName && v.claimAuthority === entry.claimAuthority)) {
    throw new Refusal("the demo vault shares its claim key with another vault (one claim key per vault, contract section 7.7).");
  }
  const pda = await findVaultPda({ programAddress: programId, mint: entry.mint });
  if (pda.address !== entry.vault || pda.bump !== entry.vaultBump) {
    throw new AdminConfigError(`vault "${vaultName}" in deployments/devnet.json is not ["vault", mint] under the program.`);
  }
  if ((await findClassicAta({ owner: entry.vault, mint: entry.mint })) !== entry.vaultTokenAccount) {
    throw new AdminConfigError(`vault "${vaultName}" in deployments/devnet.json has a non-canonical vault token account.`);
  }
  const listed = deployment.vaults.find((v) => v.vault === entry.vault);
  if (listed === undefined || listed.mint !== entry.mint || listed.vaultTokenAccount !== entry.vaultTokenAccount) {
    throw new AdminConfigError(
      `release/manifest.json does not list vault "${vaultName}", so the keyless verifier (step 5) could not bind its receipts.`,
    );
  }

  // Key files, by path only. One signer object per address.
  const pool = new Map<string, KeyPairSigner>();
  const load = async (filePath: string, flag: string): Promise<KeyPairSigner> => {
    const signer = await io.loadSigner(filePath, flag);
    const existing = pool.get(signer.address);
    if (existing !== undefined) return existing;
    pool.set(signer.address, signer);
    return signer;
  };
  const claim = await load(requiredPath(args, "--claim-keypair"), "--claim-keypair");
  const guardian = await load(requiredPath(args, "--guardian-keypair"), "--guardian-keypair");
  const admin = await load(requiredPath(args, "--admin-keypair"), "--admin-keypair");
  const feePayerPath = pathOption(args, "--fee-payer");
  const payer = feePayerPath === undefined ? claim : await load(feePayerPath, "--fee-payer");
  if (claim.address !== entry.claimAuthority) {
    throw new Refusal(`--claim-keypair is not the claim authority of vault "${vaultName}" in deployments/devnet.json.`);
  }
  if (guardian.address !== entry.guardian) throw new Refusal(`--guardian-keypair is not the guardian of vault "${vaultName}".`);
  if (admin.address !== entry.admin) throw new Refusal(`--admin-keypair is not the admin of vault "${vaultName}".`);

  // Chain reads (no transaction yet).
  if (rpcUrl === undefined || rpcUrl === "") throw new UsageError("set SOLANA_RPC_URL or pass --rpc-url (the value is never printed).");
  const rpc = io.createRpc(rpcUrl);
  const genesisHash = await rpc.getGenesisHash();
  if (!genesisHashMatches("devnet", genesisHash)) {
    throw new Refusal("the RPC is not devnet: its genesis hash does not match the pinned one.");
  }
  const problem = programAccountProblem((await rpc.getAccount(programId, "finalized")).account);
  if (problem !== null) throw new Refusal(`program ${programId}: ${problem}`);
  const vault = await readVaultAt(rpc, programId, entry.vault, "finalized");
  const mintAccount = (await rpc.getAccount(entry.mint, "finalized")).account;
  if (mintAccount === null) throw new Refusal(`mint ${entry.mint} does not exist.`);
  if (decodeMintDecimals(mintAccount) !== 6) throw new Refusal("the demo mint must have 6 decimals (6019 InvalidMint).");
  const tokenRead = (await rpc.getAccount(entry.vaultTokenAccount, "confirmed")).account;
  const vaultToken = tokenRead === null ? null : decodeTokenAccount(tokenRead);
  const unixTimestamp = await readClockUnixTimestamp(rpc, "confirmed");

  const conversion = demoConversion({ vaultMaxPerClaim: vault.maxPerClaim });
  if (conversion.ok === false) {
    throw new Refusal(`THB ${DEMO_THB_AMOUNT} does not fit the bounds: ${conversion.reason} (${conversion.lines.join("; ")}).`);
  }
  const amountAtomic = conversion.conversion.usdcAtomic;
  const problems = demoStateProblems({
    vault,
    expected: entry,
    vaultTokenAccount: vaultToken,
    vaultAddress: entry.vault,
    signers: { claimAuthority: claim.address, guardian: guardian.address, admin: admin.address, payer: payer.address },
    amountAtomic,
    unixTimestamp,
    vaultName,
  });
  if (problems.length > 0) throw new Refusal(`the demo vault is not ready:\n  ${problems.join("\n  ")}`);

  const recipient = await io.generateRecipient();
  if ([payer.address, claim.address, guardian.address, admin.address, entry.vault].includes(recipient.address)) {
    throw new Refusal("the generated stand-in wallet collides with a role key; run again.");
  }
  const recipientAta = await findClassicAta({ owner: recipient.address, mint: entry.mint });
  const [rentExemptEmptyAccount, receiptRent, tokenAccountRent] = await Promise.all([
    rpc.getMinimumBalanceForRentExemption(0n),
    rpc.getMinimumBalanceForRentExemption(BigInt(RECEIPT_ACCOUNT_SIZE)),
    rpc.getMinimumBalanceForRentExemption(BigInt(TOKEN_ACCOUNT_SIZE)),
  ]);
  const payerAccount = (await rpc.getAccount(payer.address, "confirmed")).account;
  const recipientAtaExists = (await rpc.getAccount(recipientAta, "confirmed")).account !== null;
  const shortfalls = fundingShortfalls({
    payer: payer.address,
    payerLamports: payerAccount?.lamports ?? 0n,
    rentExemptEmptyAccount,
    receiptRent,
    tokenAccountRent,
    recipientAtaExists,
    vault: entry.vault,
    vaultBalanceAtomic: vaultToken?.amount ?? 0n,
    amountAtomic,
  });
  if (shortfalls.length > 0) return { kind: "fund", lines: shortfalls.map((s) => describeShortfall(s, vaultName)) };

  return {
    kind: "ready",
    ready: {
      rpc,
      programId,
      genesisHash,
      vaultName,
      vault: entry.vault,
      mint: entry.mint,
      vaultTokenAccount: entry.vaultTokenAccount,
      manifestVaults: deployment.vaults,
      claim,
      guardian,
      admin,
      payer,
      recipient,
      recipientAta,
      amountAtomic,
      deductedMinor: conversion.conversion.deductedMinor,
      conversionLines: conversion.lines,
      evidenceDir: pathOption(args, "--evidence-dir") ?? path.join(io.cwd, "evidence"),
    },
  };
}

// ---------------------------------------------------------------------------
// The seven steps
// ---------------------------------------------------------------------------

type StepDefinition = {
  readonly number: number;
  readonly title: string;
  readonly expected: string;
  readonly run: () => Promise<Omit<EvidenceStep, "number" | "title" | "expected">>;
};

async function runSteps(
  ready: Ready,
  io: DemoIo,
  say: (line: string) => void,
  describe: (error: unknown) => string,
  /** Every signature the run produces (transactions and the consent), added as soon as it exists. */
  produced: Set<string>,
): Promise<EvidenceStep[]> {
  const { rpc, programId, vault, mint, vaultTokenAccount, claim, payer, guardian, admin, recipient, amountAtomic } = ready;
  const signerByAddress = new Map<string, KeyPairSigner>([
    [claim.address, claim],
    [payer.address, payer],
  ]);

  // State shared between steps.
  const ids = newDemoIds(io.randomBytes);
  let claimSignature: string | null = null;

  async function claimInputs(payoutId: Uint8Array, amount: bigint): Promise<ClaimTransactionInput> {
    const unixTimestamp = await readClockUnixTimestamp(rpc, "confirmed");
    const lifetime = await rpc.getLatestBlockhash("confirmed");
    const fees = await rpc.getRecentPrioritizationFees([vault, vaultTokenAccount]);
    const recipientAtaExists = (await rpc.getAccount(ready.recipientAta, "confirmed")).account !== null;
    return {
      programAddress: programId,
      vault,
      mint,
      recipient: recipient.address,
      payer: payer.address,
      claimAuthority: claim.address,
      payoutId,
      amount,
      expiresAt: unixTimestamp + CLAIM_EXPIRY_SECONDS,
      blockhash: lifetime.blockhash,
      lastValidBlockHeight: lifetime.lastValidBlockHeight,
      recipientAtaExists,
      priorityPriceMicroLamports: priorityPriceFromRecentFees(fees, DEFAULT_PRIORITY_FEE_CAP_MICROLAMPORTS),
      priorityPriceCapMicroLamports: DEFAULT_PRIORITY_FEE_CAP_MICROLAMPORTS,
    };
  }

  /** Builds the claim with the cap as its limit and simulates it unsigned (section 9.1 step 5). */
  async function simulateClaim(input: ClaimTransactionInput) {
    const tx = await buildClaimSimulationTransaction(input);
    const simulation = await rpc.simulateUnsigned(getBase64Decoder().decode(tx.unsignedWire));
    return { tx, simulation, verdict: judgeClaimSimulation(simulation) };
  }

  async function readVault(): Promise<Vault> {
    return readVaultAt(rpc, programId, vault, "finalized");
  }

  async function verifyPaidReceipt(payoutId: Uint8Array): Promise<VerifyReceiptResult> {
    let result = await verifyReceipt({ rpc, cluster: "devnet", programId, vault, payoutId, recipient: recipient.address, amountAtomic });
    for (let attempt = 1; attempt < 5 && (result.outcome === "absent" || result.outcome === "stale_read"); attempt += 1) {
      await io.sleep(2000);
      result = await verifyReceipt({ rpc, cluster: "devnet", programId, vault, payoutId, recipient: recipient.address, amountAtomic });
    }
    return result;
  }

  async function verifier(signature: string, expect?: VerifierExpectation): Promise<VerifyDevnetResult> {
    const call = () =>
      verifyDevnetSignature({ rpc, programId, vaults: ready.manifestVaults, signature, ...(expect === undefined ? {} : { expect }) });
    let result = await call();
    for (let attempt = 1; attempt < 5 && result.status === "transaction_not_found"; attempt += 1) {
      await io.sleep(2000);
      result = await call();
    }
    return result;
  }

  /** Reads the vault, retrying RPC errors: the pause drill's restore must not give up on one 429. */
  async function readVaultRetrying(commitment: "confirmed" | "finalized"): Promise<Vault> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await readVaultAt(rpc, programId, vault, commitment);
      } catch (error) {
        if (attempt >= VAULT_READ_ATTEMPTS) throw error;
        await io.sleep(2000 * attempt);
      }
    }
  }

  /**
   * Signs (fee payer first) with the admin CLI's builders and records the
   * signature in `record` before anything is sent. The fee payer pays.
   */
  async function signAdmin(instructions: Instruction[], label: string, record: EvidenceSignature[]): Promise<SignedAdmin> {
    const lifetime = await rpc.getLatestBlockhash("confirmed");
    const message = buildAdminTransactionMessage({ feePayer: payer, instructions, lifetime });
    const signed = await signTransactionMessageWithSigners(message);
    const signature = getSignatureFromTransaction(signed);
    produced.add(signature);
    record.push({ label, signature });
    return { label, signature, wireBase64: getBase64EncodedWireTransaction(signed), lastValidBlockHeight: lifetime.lastValidBlockHeight };
  }

  /**
   * Sends, then settles the transaction's fate from its signature status
   * even when the send itself threw: the node may have taken it and lost
   * only the reply.
   */
  async function sendAndSettle(tx: SignedAdmin): Promise<{ readonly fate: SignatureFate; readonly sendError: string | null }> {
    say(`step 7: sending ${tx.label} ${tx.signature}`);
    let sendError: string | null = null;
    try {
      if ((await rpc.sendTransaction(tx.wireBase64)) !== tx.signature) {
        sendError = "a different signature than the signed transaction's";
      }
    } catch (error) {
      sendError = describe(error);
    }
    const fate = await settleSignature({ rpc, signature: tx.signature, lastValidBlockHeight: tx.lastValidBlockHeight, sleep: io.sleep, describe });
    return { fate, sendError };
  }

  /** The claim transaction's instruction list; a simulation carries the cap as its limit. */
  function shape(tx: ClaimTransaction, input: ClaimTransactionInput, simulated: boolean): string {
    return (
      `${simulated ? "simulated (the cap as the limit)" : "sent"}: SetComputeUnitLimit(${tx.computeUnitLimit}), SetComputeUnitPrice(${tx.computeUnitPriceMicroLamports}), ` +
      `createAssociatedTokenIdempotent(recipient ATA \`${tx.accounts.recipientTokenAccount}\`), ` +
      `claim(payout_id, amount ${input.amount}, expires_at ${input.expiresAt}); receipt PDA \`${tx.accounts.receipt}\``
    );
  }

  const definitions: StepDefinition[] = [
    {
      number: 1,
      title: `THB ${DEMO_THB_AMOUNT} to USDC`,
      expected: `${DEMO_EXPECTED_USDC_ATOMIC} atomic (${formatUsdcAtomicFixed6(DEMO_EXPECTED_USDC_ATOMIC)} USDC)`,
      run: async () => ({
        observed: `${amountAtomic} atomic (${formatUsdcAtomicFixed6(amountAtomic)} USDC)`,
        outcome: amountAtomic === DEMO_EXPECTED_USDC_ATOMIC ? "PASS" : "FAIL",
        details: [...ready.conversionLines],
        signatures: [],
      }),
    },
    {
      number: 2,
      title: "Consent signed by a stand-in wallet",
      expected: "verify ok; the same signature over amount + 1 is signature_invalid",
      run: async () => {
        const consent = demoConsentInput({
          programId,
          recipient: recipient.address,
          amountAtomic,
          deductedMinor: ready.deductedMinor,
          feeMinor: DEMO_FEE_MINOR,
          ids,
          issuedAtMs: io.now(),
        });
        const result = await signAndVerifyConsent({
          consent,
          signerPublicKey: Uint8Array.from(getAddressEncoder().encode(recipient.address)),
          sign: (message) => signBytes(recipient.keyPair.privateKey, message),
        });
        produced.add(result.signatureBase58);
        return {
          observed: `verify ${result.verify}; amount + 1 gives ${result.tamperedVerify}`,
          outcome: result.pass ? "PASS" : "FAIL",
          details: [
            `The stand-in wallet \`${recipient.address}\` is a throwaway key made in memory for this run; it is never written to disk.`,
            `Consent bytes: ${result.byteLength} bytes, sha256 \`${result.sha256Hex}\`, 16 ASCII lines, no trailing newline (contract section 4).`,
            `Ed25519 signature (base58) \`${result.signatureBase58}\`, verified with verifyConsentSignature (section 4.7) over the exact bytes.`,
            `payout_id \`${ids.payoutIdHex}\`, nonce \`${ids.nonce}\`, request id \`${ids.withdrawalId}\`.`,
          ],
          signatures: [],
          verbatim: result.text,
        };
      },
    },
    {
      number: 3,
      title: "Claim, finalized, receipt verified",
      expected: "finalized; receipt (payout_id, recipient, amount) match, so paid",
      run: async () => {
        const input = await claimInputs(ids.payoutId, amountAtomic);
        const { simulation, verdict } = await simulateClaim(input);
        const limit = claimComputeUnitLimitFromSimulation(simulation, { recipientAtaExists: input.recipientAtaExists });
        if (limit.ok === false) {
          return {
            observed: limit.reason === "simulation_error" ? `simulation ${describeVerdict(verdict)}` : `simulation gave no limit (${limit.reason})`,
            outcome: "FAIL",
            details: ["Nothing was sent."],
            signatures: [],
          };
        }
        const tx = await buildClaimTransaction({ ...input, simulatedUnits: limit.simulatedUnits });
        const keyPairs = tx.signers.map((signerAddress) => {
          const signer = signerByAddress.get(signerAddress);
          if (signer === undefined) throw new Error("the claim needs a signer the demo did not load.");
          return signer.keyPair;
        });
        const signed = await signTransaction(keyPairs, tx.transaction);
        const signature = getSignatureFromTransaction(signed);
        produced.add(signature);
        say(`step 3: sending claim ${signature}`);
        const details = [
          `Unsigned simulation (sigVerify false, replaceRecentBlockhash true): ${limit.simulatedUnits} compute units; limit ceil(units x 115 / 100) = ${limit.computeUnitLimit}.`,
          `${shape(tx, input, false)}.`,
          `expires_at = cluster Clock + ${CLAIM_EXPIRY_SECONDS} s; signed by the fee payer and the vault's claim key.`,
        ];
        try {
          await sendAndConfirm({
            rpc,
            wireBase64: getBase64EncodedWireTransaction(signed),
            signature,
            lastValidBlockHeight: input.lastValidBlockHeight,
            commitment: "finalized",
            sleep: io.sleep,
          });
        } catch (error) {
          if (error instanceof TransactionFailedError) {
            const classification = classifyTransactionError({ err: error.err, instructions: CLAIM_TRANSACTION_KINDS });
            details.push(`The claim failed onchain: class ${classification.class}${classification.code === undefined ? "" : `, code ${classification.code}`}.`);
          }
          return { observed: describe(error), outcome: "FAIL", details, signatures: [{ label: "claim", signature }] };
        }
        claimSignature = signature;
        const receipt = await verifyPaidReceipt(ids.payoutId);
        const paid = receipt.outcome === "match";
        details.push(
          paid
            ? `Receipt \`${receipt.receiptAddress}\` read at finalized: owner, 89 bytes, discriminator, bump and (payout_id, recipient, amount ${amountAtomic}) all match (contract section 3.8). Status: paid.`
            : `Receipt verification (contract section 3.8) returned ${receipt.outcome}.`,
        );
        return {
          observed: paid ? "finalized; receipt match, so paid" : `finalized; receipt ${receipt.outcome}`,
          outcome: paid ? "PASS" : "FAIL",
          details,
          signatures: [{ label: "claim", signature }],
        };
      },
    },
    {
      number: 4,
      title: "Replay of the same payout_id",
      expected: "refused: Custom(0) already in use at the claim index, class already_claimed",
      run: async () => {
        const input = await claimInputs(ids.payoutId, amountAtomic);
        const { tx, verdict } = await simulateClaim(input);
        const judged = expectAlreadyClaimed(verdict);
        const receipt = await verifyPaidReceipt(ids.payoutId);
        const pass = judged.pass && receipt.outcome === "match";
        return {
          observed: judged.observed,
          outcome: pass ? "PASS" : "FAIL",
          details: [
            `Same payout_id \`${ids.payoutIdHex}\`, same amount ${amountAtomic}, a newly read blockhash; unsigned simulation only, nothing was sent.`,
            `${shape(tx, input, true)}.`,
            `The logs ${judged.alreadyInUseLogged ? "carry" : "do not carry"} the system program's "already in use" line (classification is by number and index, contract section 3.7).`,
            `already_claimed routes to receipt verification (section 3.8): ${receipt.outcome}${receipt.outcome === "match" ? ", the receipt is this run's own payout" : ""}.`,
          ],
          signatures: [],
        };
      },
    },
    {
      number: 5,
      title: "Keyless verifier with amount + 1",
      expected: "exact tuple: paid; amount + 1: mismatch (amount)",
      run: async () => {
        if (claimSignature === null) throw new Error("step 3 left no claim signature.");
        const exact = await verifier(claimSignature);
        const plusOne = await verifier(claimSignature, { amountAtomic: amountAtomic + 1n });
        const reasons = plusOne.status === "mismatch" ? plusOne.reasons : [];
        const pass = exact.status === "paid" && plusOne.status === "mismatch" && reasons.length === 1 && reasons[0] === "amount";
        const balances = exact.status === "paid" ? exact.transaction?.tokenBalances ?? null : null;
        return {
          observed: `exact: ${exact.status}; amount + 1: ${plusOne.status}${reasons.length > 0 ? ` (${reasons.join(", ")})` : ""}`,
          outcome: pass ? "PASS" : "FAIL",
          details: [
            `\`npm run verify:devnet -- --signature <claim>\` gives ${exact.status}${balances === null ? "" : `; token balances cross-check ${balances.ok ? "ok" : "failed"}`}.`,
            `\`npm run verify:devnet -- --signature <claim> --amount ${amountAtomic + 1n}\` gives ${plusOne.status}${reasons.length > 0 ? ` with reasons ${reasons.join(", ")}` : ""}.`,
            "Both read at finalized with no key, re-deriving the receipt against every vault of release/manifest.json.",
          ],
          signatures: [],
        };
      },
    },
    {
      number: 6,
      title: "Over-cap claim simulation",
      expected: "refused: 6010 ExceedsMaxPerClaim at the claim index, class needs_review",
      run: async () => {
        const current = await readVault();
        const overCap = current.maxPerClaim + 1n;
        const input = await claimInputs(newPayoutId(io.randomBytes).payoutId, overCap);
        const { tx, verdict } = await simulateClaim(input);
        const judged = expectProgramError(verdict, { code: 6010, errorClass: "needs_review" });
        return {
          observed: judged.observed,
          outcome: judged.pass ? "PASS" : "FAIL",
          details: [
            `amount = max_per_claim ${current.maxPerClaim} + 1 = ${overCap}, fresh payout_id; unsigned simulation only, nothing was sent.`,
            `${shape(tx, input, true)}.`,
          ],
          signatures: [],
        };
      },
    },
    {
      number: 7,
      title: "Pause drill",
      expected: "guardian pause finalized; claim refused with 6000 Paused (hold, program_paused); admin unpause finalized",
      run: async () => {
        const details: string[] = [];
        const signatures: EvidenceSignature[] = [];
        const before = await readVault();
        const problem = pauseProblem(before, guardian.address);
        if (problem !== null || before.paused) {
          return { observed: problem ?? "the vault was already paused", outcome: "FAIL", details: ["Nothing was sent."], signatures };
        }
        const unpauseByHand =
          `npm run admin -- show --cluster devnet --vault ${ready.vaultName}, and if it reads paused: ` +
          `npm run admin -- unpause --cluster devnet --vault ${ready.vaultName} --keypair <admin.json>`;
        let pauseTx: SignedAdmin | null = null;
        let pauseFate: SignatureFate | null = null;
        let paused = false;
        let refusal: { pass: boolean; observed: string } | null = null;
        let unpauseSignature: string | null = null;
        let unpaused = false;
        let failure: string | null = null;
        // From before the pause is signed until the vault is restored, the
        // first Ctrl-C lets the restore finish instead of killing the run.
        const releaseInterrupts = io.holdInterrupts({
          onFirst: "demo: Ctrl-C received; finishing the pause drill so the demo vault is not left paused. Press Ctrl-C again to stop now.",
          onSecond: `demo: stopped during the pause drill; the demo vault may be paused. Check it: ${unpauseByHand}`,
        });
        try {
          try {
            pauseTx = await signAdmin(
              [buildPauseInstruction({ programAddress: programId, vault, authority: guardian })],
              "pause (guardian)",
              signatures,
            );
            const sent = await sendAndSettle(pauseTx);
            pauseFate = sent.fate;
            if (sent.sendError !== null) {
              details.push(`The pause's send reported ${sent.sendError}; its fate was settled from its signature status.`);
            }
            if (pauseFate.kind === "finalized") {
              paused = (await readVault()).paused;
              details.push(`The guardian's pause finalized; the vault reads paused = ${paused} at finalized.`);
              const input = await claimInputs(newPayoutId(io.randomBytes).payoutId, amountAtomic);
              const { verdict } = await simulateClaim(input);
              refusal = expectProgramError(verdict, { code: 6000, errorClass: "hold", holdReason: "program_paused" });
              details.push(`A claim of ${amountAtomic} with a fresh payout_id while paused (unsigned simulation): ${refusal.observed}.`);
            } else {
              failure = `the guardian's pause ${describeFate(pauseFate)}`;
              details.push(`The drill stopped: ${failure}.`);
            }
          } catch (error) {
            failure = describe(error);
            details.push(`The drill stopped: ${failure}.`);
          } finally {
            // Once a pause is signed, settle its fate before deciding: a send
            // error, a failed poll or a pause still at confirmed does not mean
            // it did not land. Unpause if it finalized or the vault reads
            // paused at confirmed (unpause is idempotent); report "never
            // paused" only when it failed or expired with no status.
            if (pauseTx !== null) {
              try {
                pauseFate =
                  pauseFate ??
                  (await settleSignature({ rpc, signature: pauseTx.signature, lastValidBlockHeight: pauseTx.lastValidBlockHeight, sleep: io.sleep, describe }));
                const current = await readVaultRetrying("confirmed");
                if (pauseFate.kind === "finalized" || current.paused) {
                  const blocked = unpauseProblem(current, admin.address);
                  if (blocked !== null) throw new AdminInstructionError(blocked);
                  for (let attempt = 1; attempt <= UNPAUSE_ATTEMPTS && unpauseSignature === null; attempt += 1) {
                    const unpauseTx = await signAdmin(
                      [buildUnpauseInstruction({ programAddress: programId, vault, admin })],
                      attempt === 1 ? "unpause (admin)" : `unpause (admin, attempt ${attempt})`,
                      signatures,
                    );
                    const sent = await sendAndSettle(unpauseTx);
                    if (sent.fate.kind === "finalized") {
                      unpauseSignature = unpauseTx.signature;
                    } else if (sent.fate.kind === "expired" && attempt < UNPAUSE_ATTEMPTS) {
                      details.push(`The admin's unpause \`${unpauseTx.signature}\` never landed (its blockhash expired); rebuilt and sent again.`);
                    } else {
                      throw new DrillError(`the admin's unpause ${describeFate(sent.fate)}`);
                    }
                  }
                  unpaused = !(await readVaultRetrying("finalized")).paused;
                  details.push(`The admin's unpause finalized; the vault reads paused = ${!unpaused} at finalized.`);
                } else if (pauseFate.kind === "expired" || pauseFate.kind === "failed") {
                  unpaused = true;
                  details.push(
                    `The pause ${pauseFate.kind === "expired" ? "never landed (no status before its blockhash expired)" : "failed onchain and changed nothing"}, ` +
                      "so no unpause was sent; the vault reads paused = false at confirmed.",
                  );
                } else {
                  // Not settled, and not paused yet at confirmed: it may still land.
                  failure = failure ?? `the guardian's pause ${describeFate(pauseFate)}`;
                  details.push(
                    `The pause's fate is unknown and the vault reads paused = false at confirmed, so no unpause was sent. It may still land: ${unpauseByHand}.`,
                  );
                  say(`step 7: the pause's fate is unknown; the demo vault may become paused. Check it: ${unpauseByHand}`);
                }
              } catch (error) {
                const message = describe(error);
                failure = failure ?? message;
                details.push(`Restoring the vault did not complete: ${message}. The vault may still be paused: ${unpauseByHand}.`);
                say(`step 7: the demo vault may still be paused. Check it: ${unpauseByHand}`);
              }
            }
          }
        } finally {
          releaseInterrupts();
        }
        details.push("Pause and unpause are built with the admin CLI's builders; the fee payer pays both fees.");
        const pass = paused && refusal !== null && refusal.pass && unpauseSignature !== null && unpaused && failure === null;
        return {
          observed:
            `pause ${pauseFate === null ? "not sent" : pauseFate.kind === "finalized" ? "finalized" : pauseFate.kind}; ` +
            `claim ${refusal === null ? "not tried" : refusal.observed}; ` +
            `unpause ${unpauseSignature !== null && unpaused ? "finalized" : unpauseSignature === null && unpaused ? "not needed" : "not seen"}`,
          outcome: pass ? "PASS" : "FAIL",
          details,
          signatures,
        };
      },
    },
  ];

  const results: EvidenceStep[] = [];
  let stopped = false;
  for (const definition of definitions) {
    const head = { number: definition.number, title: definition.title, expected: definition.expected };
    if (stopped) {
      results.push({ ...head, observed: "not run (an earlier step failed)", outcome: "SKIPPED", details: [], signatures: [] });
      continue;
    }
    say(`step ${definition.number}: ${definition.title}`);
    let record: EvidenceStep;
    try {
      record = { ...head, ...(await definition.run()) };
    } catch (error) {
      record = { ...head, observed: describe(error), outcome: "FAIL", details: [], signatures: [] };
    }
    if (definition.number === 1) for (const line of record.details) say(`  ${line}`);
    say(`step ${definition.number} ${record.outcome}: ${record.observed}`);
    results.push(record);
    if (record.outcome !== "PASS") stopped = true;
  }
  return results;
}
