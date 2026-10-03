/**
 * The operator CLI behind `npm run admin -- <command>` (plan step R5, #2983).
 * scripts/admin.ts wires the real file system, key files and RPC client;
 * tests call `runAdmin` with fakes.
 *
 * Rules every command follows:
 * - the program id comes from `release/manifest.json.programIds[cluster]`
 *   and is passed to every builder explicitly (contract section 2.4);
 * - mainnet is refused unless `--i-understand-mainnet` is given AND the
 *   manifest has a mainnet program id (contract v0 has none);
 * - the RPC's genesis hash must be the cluster's, and the program must be an
 *   executable loader-v3 account, before anything else is read or sent;
 * - every onchain check the program would fail is run first (state.ts), so a
 *   refused transaction is never signed;
 * - keys come only from files named by `--keypair` / `--fee-payer`; with
 *   `--export-squads`, nothing is signed: the authority is an address and the
 *   base58 message is printed instead;
 * - the RPC URL (`--rpc-url` or `SOLANA_RPC_URL`) is never printed.
 *
 * Output: progress goes to stderr; stdout carries one JSON result, or only
 * the base58 message(s) with `--export-squads`.
 */
import {
  address,
  createNoopSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import path from "node:path";
import { parsePayoutAtomicAmount } from "../../src/amount.ts";
import { genesisHashMatches, SYSTEM_PROGRAM_ADDRESS, type Cluster } from "../../src/clusters.ts";
import { decodeVault, findClassicAta, findVaultPda, type Vault } from "../../src/program.ts";
import {
  AdminConfigError,
  deploymentVaultToJson,
  parseDeploymentRecord,
  parseReleaseManifest,
  parseVaultConfig,
  resolveProgramId,
  selectReadyVaults,
  toJsonText,
  type DeploymentRecord,
  type DeploymentVault,
  type ReadyVault,
} from "../../src/admin/config.ts";
import {
  AdminInstructionError,
  buildAcceptAdminInstruction,
  buildDepositInstruction,
  buildInitializeInstructions,
  buildPauseInstruction,
  buildProposeAdminInstruction,
  buildUnpauseInstruction,
  buildUpdateConfigInstruction,
  buildWithdrawInstructions,
} from "../../src/admin/instructions.ts";
import { decodeProgramData, decodeUpgradeableProgram, programAccountProblem, type DeployedProgram } from "../../src/admin/loader.ts";
import { sendAndConfirm, TransactionExpiredError, TransactionFailedError, type AdminRpc } from "../../src/admin/rpc.ts";
import {
  acceptAdminProblem,
  compareVault,
  decodeMintDecimals,
  decodeTokenAccount,
  depositProblem,
  pauseProblem,
  proposeAdminProblem,
  StateDecodeError,
  unpauseProblem,
  updateConfigProblem,
  withdrawProblem,
  type Drift,
  type TokenAccountView,
} from "../../src/admin/state.ts";
import { buildAdminTransactionMessage, exportSquadsMessage } from "../../src/admin/transaction.ts";
import { PROGRAM_ERRORS } from "../../src/errors.ts";
import { addressValue, parseArgs, pathOption, UsageError, type ArgSpec, type ParsedArgs } from "./args.ts";
import { KeyFileError } from "./keyfile.ts";
import { redactRpcUrl } from "./redact.ts";

export const ADMIN_COMMANDS = [
  "initialize",
  "show",
  "deposit",
  "pause",
  "unpause",
  "update_config",
  "propose_admin",
  "accept_admin",
  "withdraw",
] as const;
export type AdminCommand = (typeof ADMIN_COMMANDS)[number];

export const ADMIN_USAGE = `Usage: npm run admin -- <command> --cluster devnet [options]

Commands:
  initialize     create vault(s) from deploy/vaults.<cluster>.json: one transaction each,
                 [createAssociatedTokenIdempotent(ata(vault, mint)), initialize]
                 --keypair <upgrade-authority.json> [--fee-payer <file>] [--vault <name>]...
                 [--config <file>] [--skip-existing] [--record <file>] [--check-only]
  show           compare the onchain vault(s) with deployments/<cluster>.json
                 [--vault <name> | --mint <address>]
  deposit        transfer_checked into vault.vault_token_account read from chain
                 --vault <name> --amount <atomic> --keypair <depositor.json> [--source <address>]
  pause          --vault <name> --keypair <admin-or-guardian.json>
  unpause        --vault <name> --keypair <admin.json>  (deployment verified and vault funded)
  update_config  --vault <name> --keypair <admin.json> [--guardian <address>]
                 [--claim-authority <address>] [--max-per-claim <atomic>] [--max-per-day <atomic>]
  propose_admin  --vault <name> --keypair <admin.json> (--new-admin <address> | --cancel)
  accept_admin   --vault <name> --keypair <pending-admin.json>
  withdraw       --vault <name> --keypair <admin.json> --amount <atomic> [--destination <address>]

Common options:
  --cluster devnet|mainnet   mainnet also needs --i-understand-mainnet and a mainnet
                             program id in release/manifest.json (contract v0 has none)
  --rpc-url <url>            default: the SOLANA_RPC_URL environment variable (never printed)
  --manifest <file>          default: release/manifest.json
  --deployment <file>        default: deployments/<cluster>.json
  --export-squads --authority <address>
                             print the base58 v0 message for a Squads v4 proposal instead of
                             signing; the authority (the Squads vault) is also the fee payer
`;

export type AdminIo = {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The repository root; default file paths resolve against it. */
  readonly cwd: string;
  readonly createRpc: (rpcUrl: string) => AdminRpc;
  readonly loadSigner: (filePath: string, flag: string) => Promise<TransactionSigner>;
  /** File text, or `null` when the file does not exist. */
  readonly readText: (filePath: string) => string | null;
  readonly writeText: (filePath: string, text: string) => void;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
};

/** A refusal before anything was signed; safe to print. */
class Refusal extends Error {
  override name = "Refusal";
}

const COMMON_VALUES = ["--cluster", "--rpc-url", "--manifest", "--deployment"];
const COMMON_FLAGS = ["--i-understand-mainnet", "--help"];
const SIGNER_VALUES = ["--keypair", "--fee-payer", "--authority"];
const SIGNER_FLAGS = ["--export-squads"];

const SPECS: Record<AdminCommand, ArgSpec> = {
  initialize: {
    values: [...COMMON_VALUES, ...SIGNER_VALUES, "--config", "--record"],
    repeatable: ["--vault"],
    flags: [...COMMON_FLAGS, ...SIGNER_FLAGS, "--skip-existing", "--check-only"],
  },
  show: { values: [...COMMON_VALUES, "--vault", "--mint"], flags: COMMON_FLAGS },
  deposit: {
    values: [...COMMON_VALUES, ...SIGNER_VALUES, "--vault", "--mint", "--amount", "--source"],
    flags: [...COMMON_FLAGS, ...SIGNER_FLAGS],
  },
  pause: { values: [...COMMON_VALUES, ...SIGNER_VALUES, "--vault", "--mint"], flags: [...COMMON_FLAGS, ...SIGNER_FLAGS] },
  unpause: { values: [...COMMON_VALUES, ...SIGNER_VALUES, "--vault", "--mint"], flags: [...COMMON_FLAGS, ...SIGNER_FLAGS] },
  update_config: {
    values: [
      ...COMMON_VALUES,
      ...SIGNER_VALUES,
      "--vault",
      "--mint",
      "--guardian",
      "--claim-authority",
      "--max-per-claim",
      "--max-per-day",
    ],
    flags: [...COMMON_FLAGS, ...SIGNER_FLAGS],
  },
  propose_admin: {
    values: [...COMMON_VALUES, ...SIGNER_VALUES, "--vault", "--mint", "--new-admin"],
    flags: [...COMMON_FLAGS, ...SIGNER_FLAGS, "--cancel"],
  },
  accept_admin: {
    values: [...COMMON_VALUES, ...SIGNER_VALUES, "--vault", "--mint"],
    flags: [...COMMON_FLAGS, ...SIGNER_FLAGS],
  },
  withdraw: {
    values: [...COMMON_VALUES, ...SIGNER_VALUES, "--vault", "--mint", "--amount", "--destination"],
    flags: [...COMMON_FLAGS, ...SIGNER_FLAGS],
  },
};

function jsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString(10) : v)));
}

type Context = {
  readonly command: AdminCommand;
  readonly args: ParsedArgs;
  readonly io: AdminIo;
  readonly cluster: Cluster;
  readonly programId: Address;
  readonly exportMode: boolean;
  readonly rpcUrl: string | undefined;
  readonly info: (line: string) => void;
  readonly result: (value: Record<string, unknown>) => void;
};

/** Runs one admin command. Returns the process exit code (0 ok, 1 failed or drift, 2 refused). */
export async function runAdmin(argv: readonly string[], io: AdminIo): Promise<number> {
  const rpcUrlFromArgs = (() => {
    const index = argv.indexOf("--rpc-url");
    return index === -1 ? undefined : argv[index + 1];
  })();
  const rpcUrl = rpcUrlFromArgs ?? io.env.SOLANA_RPC_URL;
  const printErr = (text: string): void => io.stderr(redactRpcUrl(text, rpcUrl));
  try {
    const [commandArg, ...rest] = argv;
    if (commandArg === undefined || commandArg === "--help" || commandArg === "-h") {
      printErr(ADMIN_USAGE);
      return commandArg === undefined ? 2 : 0;
    }
    if (!(ADMIN_COMMANDS as readonly string[]).includes(commandArg)) {
      throw new UsageError(
        /^[a-z_-]{1,32}$/.test(commandArg) ? `unknown command ${commandArg}.` : "unknown command (not printed).",
      );
    }
    const command = commandArg as AdminCommand;
    const args = parseArgs(rest, SPECS[command]);
    if (args.flags.has("--help")) {
      printErr(ADMIN_USAGE);
      return 0;
    }
    const manifestPath = pathOption(args, "--manifest") ?? path.join(io.cwd, "release", "manifest.json");
    const manifestText = io.readText(manifestPath);
    if (manifestText === null) throw new AdminConfigError("release/manifest.json was not found.");
    const manifest = parseReleaseManifest(parseJson(manifestText, "release/manifest.json"));
    const resolution = resolveProgramId(manifest, args.values.get("--cluster"), {
      iUnderstandMainnet: args.flags.has("--i-understand-mainnet"),
    });
    if (resolution.ok === false) throw new Refusal(resolution.message);
    const exportMode = SPECS[command].flags.includes("--export-squads") && args.flags.has("--export-squads");
    const ctx: Context = {
      command,
      args,
      io,
      cluster: resolution.cluster,
      programId: resolution.programId,
      exportMode,
      rpcUrl,
      info: (line) => printErr(`${line}\n`),
      result: (value) => {
        const text = toJsonText(jsonSafe({ command, cluster: resolution.cluster, programId: resolution.programId, ...value }));
        if (exportMode) printErr(text);
        else io.stdout(redactRpcUrl(text, rpcUrl));
      },
    };
    return await COMMANDS[command](ctx);
  } catch (error) {
    if (
      error instanceof UsageError ||
      error instanceof AdminConfigError ||
      error instanceof AdminInstructionError ||
      error instanceof KeyFileError ||
      error instanceof Refusal ||
      error instanceof StateDecodeError
    ) {
      printErr(`admin: ${error.message}\n`);
      return 2;
    }
    if (error instanceof TransactionFailedError) {
      printErr(`admin: ${describeFailure(error)}\n`);
      return 1;
    }
    if (error instanceof TransactionExpiredError) {
      printErr(`admin: ${error.message}\n`);
      return 1;
    }
    const message = error instanceof Error ? `${error.name}: ${error.message}` : "unexpected error";
    printErr(`admin: ${message}\n`);
    return 1;
  }
}

function parseJson(text: string, where: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new AdminConfigError(`${where} is not valid JSON.`);
  }
}

/** Names a program error code from the transaction error, when there is one. */
function describeFailure(error: TransactionFailedError): string {
  const err = error.err as { InstructionError?: [number, unknown] } | null;
  const detail = err?.InstructionError;
  if (Array.isArray(detail)) {
    const [index, inner] = detail;
    const custom = (inner as { Custom?: number } | null)?.Custom;
    if (typeof custom === "number") {
      const entry = PROGRAM_ERRORS.find((e) => e.code === custom);
      const label = entry === undefined ? `Custom(${custom})` : `${custom} ${entry.name}: ${entry.message}`;
      return `transaction ${error.signature} failed at instruction ${index}: ${label}`;
    }
  }
  return error.message;
}

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

function rpcFor(ctx: Context): AdminRpc {
  if (ctx.rpcUrl === undefined || ctx.rpcUrl === "") {
    throw new UsageError("set SOLANA_RPC_URL or pass --rpc-url (the value is never printed).");
  }
  return ctx.io.createRpc(ctx.rpcUrl);
}

/** Genesis hash, then the program account and its ProgramData (section 2.4). */
async function connect(ctx: Context): Promise<{ rpc: AdminRpc; program: DeployedProgram }> {
  const rpc = rpcFor(ctx);
  const genesis = await rpc.getGenesisHash();
  if (!genesisHashMatches(ctx.cluster, genesis)) {
    throw new Refusal(`the RPC is not ${ctx.cluster}: its genesis hash does not match the pinned one.`);
  }
  const programAccount = (await rpc.getAccount(ctx.programId, "finalized")).account;
  const problem = programAccountProblem(programAccount);
  if (problem !== null || programAccount === null) throw new Refusal(`program ${ctx.programId}: ${problem}`);
  const { programDataAddress } = decodeUpgradeableProgram(programAccount.data);
  const programData = (await rpc.getAccount(programDataAddress, "finalized")).account;
  if (programData === null || programData.owner !== programAccount.owner) {
    throw new Refusal(`program ${ctx.programId}: its ProgramData account is missing.`);
  }
  const { slot, upgradeAuthority } = decodeProgramData(programData.data);
  return { rpc, program: { programDataAddress, deploySlot: slot, upgradeAuthority } };
}

type Signers = { authority: TransactionSigner; feePayer: TransactionSigner };

async function resolveSigners(ctx: Context): Promise<Signers> {
  const { args } = ctx;
  if (ctx.exportMode) {
    if (args.values.has("--keypair") || args.values.has("--fee-payer")) {
      throw new UsageError("--export-squads signs nothing; pass --authority <address>, not --keypair or --fee-payer.");
    }
    const authorityValue = args.values.get("--authority");
    if (authorityValue === undefined) throw new UsageError("--export-squads needs --authority <address> (the Squads vault).");
    const authority = createNoopSigner(address(addressValue(authorityValue, "--authority")));
    return { authority, feePayer: authority };
  }
  if (args.values.has("--authority")) throw new UsageError("--authority is only used with --export-squads.");
  const keypairPath = pathOption(args, "--keypair");
  if (keypairPath === undefined) throw new UsageError("--keypair <file> is required (or --export-squads --authority <address>).");
  const authority = await ctx.io.loadSigner(keypairPath, "--keypair");
  const feePayerPath = pathOption(args, "--fee-payer");
  if (feePayerPath === undefined) return { authority, feePayer: authority };
  const feePayer = await ctx.io.loadSigner(feePayerPath, "--fee-payer");
  return { authority, feePayer: feePayer.address === authority.address ? authority : feePayer };
}

/** Builds the message, then either prints it for Squads or signs, sends and waits for `finalized`. */
async function execute(
  ctx: Context,
  rpc: AdminRpc,
  signers: Signers,
  instructions: readonly Instruction[],
  label: string,
): Promise<{ signature: string | null; exportedMessage: string | null }> {
  const lifetime = await rpc.getLatestBlockhash("confirmed");
  const message = buildAdminTransactionMessage({ feePayer: signers.feePayer, instructions, lifetime });
  if (ctx.exportMode) {
    const exported = exportSquadsMessage(message);
    ctx.info(`${label}: base58 v0 message for a Squads v4 proposal on stdout (nothing was signed or sent).`);
    ctx.io.stdout(`${exported}\n`);
    return { signature: null, exportedMessage: exported };
  }
  const signed = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signed);
  ctx.info(`${label}: sending ${signature}`);
  await sendAndConfirm({
    rpc,
    wireBase64: getBase64EncodedWireTransaction(signed),
    signature,
    lastValidBlockHeight: lifetime.lastValidBlockHeight,
    commitment: "finalized",
    sleep: ctx.io.sleep,
  });
  ctx.info(`${label}: finalized`);
  return { signature, exportedMessage: null };
}

function loadDeployment(ctx: Context, required: boolean): DeploymentRecord | null {
  const deploymentPath =
    pathOption(ctx.args, "--deployment") ?? path.join(ctx.io.cwd, "deployments", `${ctx.cluster}.json`);
  const text = ctx.io.readText(deploymentPath);
  if (text === null) {
    if (required) {
      throw new AdminConfigError(
        `deployments/${ctx.cluster}.json was not found; commit the deploy workflow's record first, or pass --mint.`,
      );
    }
    return null;
  }
  const record = parseDeploymentRecord(parseJson(text, `deployments/${ctx.cluster}.json`), ctx.cluster);
  if (record.programId !== ctx.programId) {
    throw new AdminConfigError(`deployments/${ctx.cluster}.json names program ${record.programId}, not the manifest's.`);
  }
  return record;
}

type VaultTarget = { name: string | null; vault: Address; mint: Address; expected: DeploymentVault | null };

async function resolveVaultTarget(ctx: Context): Promise<VaultTarget> {
  const name = ctx.args.values.get("--vault");
  const mintValue = ctx.args.values.get("--mint");
  if (name !== undefined && mintValue !== undefined) throw new UsageError("pass --vault or --mint, not both.");
  if (name === undefined && mintValue === undefined) throw new UsageError("--vault <name> (or --mint <address>) is required.");
  if (name !== undefined) {
    const record = loadDeployment(ctx, true) as DeploymentRecord;
    const expected = record.vaults.find((v) => v.name === name);
    if (expected === undefined) throw new AdminConfigError(`deployments/${ctx.cluster}.json has no vault "${name}".`);
    const derived = await findVaultPda({ programAddress: ctx.programId, mint: expected.mint });
    if (derived.address !== expected.vault) {
      throw new AdminConfigError(`vault "${name}" in deployments/${ctx.cluster}.json is not ["vault", mint] under the program.`);
    }
    return { name, vault: expected.vault, mint: expected.mint, expected };
  }
  const mint = address(addressValue(mintValue as string, "--mint"));
  const derived = await findVaultPda({ programAddress: ctx.programId, mint });
  const record = loadDeployment(ctx, false);
  const expected = record?.vaults.find((v) => v.mint === mint) ?? null;
  return { name: expected?.name ?? null, vault: derived.address, mint, expected };
}

async function readVault(ctx: Context, rpc: AdminRpc, vaultAddress: Address): Promise<Vault | null> {
  const account = (await rpc.getAccount(vaultAddress, "finalized")).account;
  if (account === null) return null;
  if (account.owner !== ctx.programId) throw new Refusal(`vault ${vaultAddress} is not owned by the program.`);
  return decodeVault(account.data);
}

async function requireVault(ctx: Context, rpc: AdminRpc, target: VaultTarget): Promise<Vault> {
  const vault = await readVault(ctx, rpc, target.vault);
  if (vault === null) throw new Refusal(`vault ${target.vault} does not exist on ${ctx.cluster}.`);
  if (vault.mint !== target.mint) throw new Refusal(`vault ${target.vault} holds mint ${vault.mint}, not ${target.mint}.`);
  return vault;
}

async function readTokenAccount(rpc: AdminRpc, account: Address): Promise<TokenAccountView | null> {
  const read = (await rpc.getAccount(account, "finalized")).account;
  return read === null ? null : decodeTokenAccount(read);
}

function amountOption(ctx: Context, name: string, required: true): bigint;
function amountOption(ctx: Context, name: string, required: false): bigint | undefined;
function amountOption(ctx: Context, name: string, required: boolean): bigint | undefined {
  const value = ctx.args.values.get(name);
  if (value === undefined) {
    if (required) throw new UsageError(`${name} <atomic units> is required.`);
    return undefined;
  }
  try {
    return parsePayoutAtomicAmount(value);
  } catch {
    throw new UsageError(`${name} must be a whole number of atomic units from 1 to 2^64 - 1 (1 USDC = 1000000).`);
  }
}

function addressOption(ctx: Context, name: string): Address | undefined {
  const value = ctx.args.values.get(name);
  return value === undefined ? undefined : address(addressValue(value, name));
}

function refuseIf(problem: string | null): void {
  if (problem !== null) throw new Refusal(problem);
}

function vaultSummary(vault: Vault): Record<string, unknown> {
  return {
    paused: vault.paused,
    mint: vault.mint,
    vaultTokenAccount: vault.vaultTokenAccount,
    admin: vault.admin,
    pendingAdmin: vault.pendingAdmin === SYSTEM_PROGRAM_ADDRESS ? null : vault.pendingAdmin,
    guardian: vault.guardian,
    claimAuthority: vault.claimAuthority,
    maxPerClaim: vault.maxPerClaim,
    maxPerDay: vault.maxPerDay,
    currentDay: vault.currentDay,
    claimedToday: vault.claimedToday,
    totalClaimed: vault.totalClaimed,
    claimCount: vault.claimCount,
    totalWithdrawn: vault.totalWithdrawn,
  };
}

/** Runs a vault instruction command: resolve, check, build, execute, re-read. */
async function vaultCommand(
  ctx: Context,
  build: (input: {
    rpc: AdminRpc;
    program: DeployedProgram;
    target: VaultTarget;
    vault: Vault;
    signers: Signers;
  }) => Promise<{ instructions: Instruction[]; details?: Record<string, unknown> }>,
): Promise<number> {
  const target = await resolveVaultTarget(ctx);
  const signers = await resolveSigners(ctx);
  const { rpc, program } = await connect(ctx);
  const vault = await requireVault(ctx, rpc, target);
  const { instructions, details } = await build({ rpc, program, target, vault, signers });
  const sent = await execute(ctx, rpc, signers, instructions, `${ctx.command} ${target.name ?? target.vault}`);
  const after = sent.signature === null ? null : await requireVault(ctx, rpc, target);
  ctx.result({
    vault: target.vault,
    name: target.name,
    signature: sent.signature,
    exportedMessage: sent.exportedMessage,
    ...(details ?? {}),
    ...(after === null ? {} : { after: vaultSummary(after) }),
  });
  return 0;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function initialize(ctx: Context): Promise<number> {
  const configPath =
    pathOption(ctx.args, "--config") ?? path.join(ctx.io.cwd, "deploy", `vaults.${ctx.cluster}.json`);
  const configText = ctx.io.readText(configPath);
  if (configText === null) throw new AdminConfigError(`the vault config deploy/vaults.${ctx.cluster}.json was not found.`);
  const config = parseVaultConfig(parseJson(configText, "the vault config"), ctx.cluster);
  const vaults = selectReadyVaults(config, ctx.args.repeated.get("--vault") ?? []);
  const recordPath = pathOption(ctx.args, "--record");

  const planned = await Promise.all(
    vaults.map(async (v) => {
      const pda = await findVaultPda({ programAddress: ctx.programId, mint: v.mint });
      const vaultTokenAccount = await findClassicAta({ owner: pda.address, mint: v.mint });
      return { config: v, vault: pda.address, vaultBump: pda.bump, vaultTokenAccount };
    }),
  );
  if (ctx.args.flags.has("--check-only")) {
    ctx.result({
      checkOnly: true,
      vaults: planned.map((p) => ({ name: p.config.name, mint: p.config.mint, vault: p.vault, vaultTokenAccount: p.vaultTokenAccount })),
    });
    return 0;
  }

  const signers = await resolveSigners(ctx);
  for (const p of planned) {
    if (p.config.claimAuthority === signers.authority.address) {
      throw new Refusal(`vault "${p.config.name}": claimAuthority must not be the upgrade authority (section 3.3.1).`);
    }
  }
  const { rpc, program } = await connect(ctx);
  if (program.upgradeAuthority === null) throw new Refusal("the program is immutable (no upgrade authority), so initialize would fail (6005).");
  if (program.upgradeAuthority !== signers.authority.address) {
    throw new Refusal("the signer is not the program's upgrade authority (6005 NotUpgradeAuthority).");
  }

  const records: DeploymentVault[] = [];
  const exported: { name: string; message: string }[] = [];
  for (const p of planned) {
    const expected = { ...p.config, vaultBump: p.vaultBump, vaultTokenAccount: p.vaultTokenAccount };
    const mintAccount = (await rpc.getAccount(p.config.mint, "finalized")).account;
    if (mintAccount === null) throw new Refusal(`vault "${p.config.name}": mint ${p.config.mint} does not exist.`);
    if (decodeMintDecimals(mintAccount) !== 6) throw new Refusal(`vault "${p.config.name}": the mint must have 6 decimals (6019).`);

    const existing = await readVault(ctx, rpc, p.vault);
    if (existing !== null) {
      if (!ctx.args.flags.has("--skip-existing")) {
        throw new Refusal(`vault "${p.config.name}" already exists at ${p.vault}; run show, or pass --skip-existing.`);
      }
      const drift = compareVault(existing, expected);
      if (drift.length > 0) {
        throw new Refusal(`vault "${p.config.name}" exists but differs from the config: ${formatDrift(drift)}`);
      }
      ctx.info(`initialize ${p.config.name}: already exists and matches the config; skipped.`);
      records.push(deploymentVault(p.config, p, null));
      continue;
    }

    const built = await buildInitializeInstructions({
      programAddress: ctx.programId,
      mint: p.config.mint,
      upgradeAuthority: signers.authority,
      payer: signers.feePayer,
      admin: p.config.admin,
      guardian: p.config.guardian,
      claimAuthority: p.config.claimAuthority,
      maxPerClaim: p.config.maxPerClaim,
      maxPerDay: p.config.maxPerDay,
    });
    if (built.programData !== program.programDataAddress) {
      throw new Refusal("the derived ProgramData address is not the program's (6006).");
    }
    const sent = await execute(ctx, rpc, signers, built.instructions, `initialize ${p.config.name}`);
    if (sent.exportedMessage !== null) {
      exported.push({ name: p.config.name, message: sent.exportedMessage });
      continue;
    }
    const after = await readVault(ctx, rpc, p.vault);
    if (after === null) throw new Error(`vault "${p.config.name}" is missing after a finalized initialize.`);
    const drift = compareVault(after, expected);
    if (drift.length > 0 || after.paused !== true) {
      throw new Error(`vault "${p.config.name}" after initialize differs from the config: ${formatDrift(drift)}`);
    }
    records.push(deploymentVault(p.config, p, sent.signature));
  }

  if (recordPath !== undefined && !ctx.exportMode) {
    ctx.io.writeText(recordPath, toJsonText(records.map(deploymentVaultToJson)));
  }
  ctx.result({
    vaults: ctx.exportMode
      ? exported.map((e) => ({ name: e.name, exportedMessage: e.message }))
      : records.map(deploymentVaultToJson),
  });
  return 0;
}

function deploymentVault(
  config: ReadyVault,
  planned: { vault: Address; vaultBump: number; vaultTokenAccount: Address },
  signature: string | null,
): DeploymentVault {
  return {
    ...config,
    vault: planned.vault,
    vaultBump: planned.vaultBump,
    vaultTokenAccount: planned.vaultTokenAccount,
    initializeSignature: signature,
  };
}

function formatDrift(drift: readonly Drift[]): string {
  return drift.map((d) => `${d.field} expected ${d.expected}, onchain ${d.actual}`).join("; ");
}

async function show(ctx: Context): Promise<number> {
  const mintValue = ctx.args.values.get("--mint");
  const record = loadDeployment(ctx, mintValue === undefined);
  const { rpc, program } = await connect(ctx);
  const programDrift: Drift[] = [];
  if (record !== null) {
    if (program.programDataAddress !== record.programDataAddress) {
      programDrift.push({ field: "programDataAddress", expected: record.programDataAddress, actual: program.programDataAddress });
    }
    if (program.upgradeAuthority !== record.upgradeAuthority) {
      programDrift.push({ field: "upgradeAuthority", expected: record.upgradeAuthority, actual: String(program.upgradeAuthority) });
    }
  }
  let targets: VaultTarget[];
  if (ctx.args.values.has("--vault") || mintValue !== undefined) {
    targets = [await resolveVaultTarget(ctx)];
  } else {
    targets = (record as DeploymentRecord).vaults.map((v) => ({ name: v.name, vault: v.vault, mint: v.mint, expected: v }));
  }
  const reports: Record<string, unknown>[] = [];
  let driftCount = programDrift.length;
  for (const target of targets) {
    const vault = await readVault(ctx, rpc, target.vault);
    if (vault === null) {
      driftCount += 1;
      reports.push({ name: target.name, vault: target.vault, exists: false, drift: [{ field: "exists", expected: "true", actual: "false" }] });
      continue;
    }
    const drift = target.expected === null ? null : compareVault(vault, target.expected);
    if (drift !== null) driftCount += drift.length;
    const balance = await readTokenAccount(rpc, vault.vaultTokenAccount);
    reports.push({
      name: target.name,
      vault: target.vault,
      exists: true,
      ...vaultSummary(vault),
      vaultBalanceAtomic: balance?.amount ?? null,
      vaultTokenAccountFrozen: balance?.frozen ?? null,
      drift,
    });
  }
  ctx.result({
    program: {
      programDataAddress: program.programDataAddress,
      upgradeAuthority: program.upgradeAuthority,
      deploySlot: program.deploySlot,
      drift: record === null ? null : programDrift,
    },
    vaults: reports,
    driftCount,
  });
  if (driftCount > 0) ctx.info(`show: ${driftCount} difference(s) from deployments/${ctx.cluster}.json.`);
  return driftCount > 0 ? 1 : 0;
}

async function deposit(ctx: Context): Promise<number> {
  const amount = amountOption(ctx, "--amount", true);
  const sourceOption = addressOption(ctx, "--source");
  return vaultCommand(ctx, async ({ rpc, target, vault, signers }) => {
    // The destination is the vault's own token account as read from chain.
    const destination = vault.vaultTokenAccount;
    const vaultTokenAccount = await readTokenAccount(rpc, destination);
    if (vaultTokenAccount === null) throw new Refusal("the vault token account read from chain does not exist.");
    const mintAccount = (await rpc.getAccount(vault.mint, "finalized")).account;
    if (mintAccount === null) throw new Refusal("the vault mint does not exist.");
    const decimals = decodeMintDecimals(mintAccount);
    const source = sourceOption ?? (await findClassicAta({ owner: signers.authority.address, mint: vault.mint }));
    const sourceAccount = await readTokenAccount(rpc, source);
    if (sourceAccount === null) throw new Refusal("the depositor has no token account for the vault mint (fund it from the faucet first).");
    refuseIf(
      depositProblem({
        vault,
        vaultAddress: target.vault,
        vaultTokenAccount,
        source: sourceAccount,
        depositor: signers.authority.address,
        amount,
      }),
    );
    return {
      instructions: [
        buildDepositInstruction({
          mint: vault.mint,
          source,
          vaultTokenAccount: destination,
          owner: signers.authority,
          amount,
          decimals,
        }),
      ],
      details: { amountAtomic: amount, source, destination, vaultBalanceBeforeAtomic: vaultTokenAccount.amount },
    };
  });
}

async function pause(ctx: Context): Promise<number> {
  return vaultCommand(ctx, async ({ target, vault, signers }) => {
    refuseIf(pauseProblem(vault, signers.authority.address));
    return {
      instructions: [buildPauseInstruction({ programAddress: ctx.programId, vault: target.vault, authority: signers.authority })],
    };
  });
}

async function unpause(ctx: Context): Promise<number> {
  return vaultCommand(ctx, async ({ rpc, target, vault, signers }) => {
    refuseIf(unpauseProblem(vault, signers.authority.address));
    // SEC-5 ceremony: only a verified deployment with a funded vault is unpaused.
    if (target.expected === null) {
      throw new Refusal(`unpause needs the vault in deployments/${ctx.cluster}.json to verify the deployment first.`);
    }
    const drift = compareVault(vault, target.expected);
    if (drift.length > 0) throw new Refusal(`the vault differs from deployments/${ctx.cluster}.json: ${formatDrift(drift)}`);
    const balance = await readTokenAccount(rpc, vault.vaultTokenAccount);
    if (balance === null || balance.amount === 0n) throw new Refusal("the vault holds no tokens; deposit before unpausing.");
    return {
      instructions: [buildUnpauseInstruction({ programAddress: ctx.programId, vault: target.vault, admin: signers.authority })],
    };
  });
}

async function updateConfig(ctx: Context): Promise<number> {
  const guardian = addressOption(ctx, "--guardian");
  const claimAuthority = addressOption(ctx, "--claim-authority");
  const maxPerClaim = amountOption(ctx, "--max-per-claim", false);
  const maxPerDay = amountOption(ctx, "--max-per-day", false);
  if ([guardian, claimAuthority, maxPerClaim, maxPerDay].every((v) => v === undefined)) {
    throw new UsageError("pass at least one of --guardian, --claim-authority, --max-per-claim, --max-per-day.");
  }
  return vaultCommand(ctx, async ({ program, target, vault, signers }) => {
    const next = {
      guardian: guardian ?? vault.guardian,
      claimAuthority: claimAuthority ?? vault.claimAuthority,
      maxPerClaim: maxPerClaim ?? vault.maxPerClaim,
      maxPerDay: maxPerDay ?? vault.maxPerDay,
    };
    refuseIf(updateConfigProblem(vault, signers.authority.address, next));
    if (next.claimAuthority === program.upgradeAuthority) {
      throw new Refusal("claimAuthority must not be the program's upgrade authority (section 3.3.1, 7.7).");
    }
    return {
      instructions: [
        buildUpdateConfigInstruction({ programAddress: ctx.programId, vault: target.vault, admin: signers.authority, ...next }),
      ],
      details: { next },
    };
  });
}

async function proposeAdmin(ctx: Context): Promise<number> {
  const cancel = ctx.args.flags.has("--cancel");
  const newAdminOption = addressOption(ctx, "--new-admin");
  if (cancel === (newAdminOption !== undefined)) throw new UsageError("pass exactly one of --new-admin <address> or --cancel.");
  const newAdmin = newAdminOption ?? SYSTEM_PROGRAM_ADDRESS;
  return vaultCommand(ctx, async ({ target, vault, signers }) => {
    refuseIf(proposeAdminProblem(vault, signers.authority.address, newAdmin));
    return {
      instructions: [
        buildProposeAdminInstruction({ programAddress: ctx.programId, vault: target.vault, admin: signers.authority, newAdmin }),
      ],
      details: { newAdmin: cancel ? null : newAdmin },
    };
  });
}

async function acceptAdmin(ctx: Context): Promise<number> {
  return vaultCommand(ctx, async ({ target, vault, signers }) => {
    refuseIf(acceptAdminProblem(vault, signers.authority.address));
    return {
      instructions: [buildAcceptAdminInstruction({ programAddress: ctx.programId, vault: target.vault, newAdmin: signers.authority })],
    };
  });
}

async function withdraw(ctx: Context): Promise<number> {
  const amount = amountOption(ctx, "--amount", true);
  const destinationOption = addressOption(ctx, "--destination");
  return vaultCommand(ctx, async ({ rpc, target, vault, signers }) => {
    const vaultTokenAccount = await readTokenAccount(rpc, vault.vaultTokenAccount);
    if (vaultTokenAccount === null) throw new Refusal("the vault token account does not exist.");
    const adminAta = await findClassicAta({ owner: vault.admin, mint: vault.mint });
    const destination = destinationOption ?? adminAta;
    const destinationAccount = await readTokenAccount(rpc, destination);
    if (destinationAccount === null && destination !== adminAta) throw new Refusal("the --destination token account does not exist.");
    refuseIf(withdrawProblem({ vault, signer: signers.authority.address, vaultTokenAccount, destination: destinationAccount, amount }));
    const instructions = await buildWithdrawInstructions({
      programAddress: ctx.programId,
      vault: target.vault,
      admin: signers.authority,
      mint: vault.mint,
      vaultTokenAccount: vault.vaultTokenAccount,
      destination,
      amount,
      ...(destinationAccount === null ? { createDestinationAtaPayer: signers.feePayer } : {}),
    });
    return { instructions, details: { amountAtomic: amount, destination } };
  });
}

const COMMANDS: Record<AdminCommand, (ctx: Context) => Promise<number>> = {
  initialize,
  show,
  deposit,
  pause,
  unpause,
  update_config: updateConfig,
  propose_admin: proposeAdmin,
  accept_admin: acceptAdmin,
  withdraw,
};
