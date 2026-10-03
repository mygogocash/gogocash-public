/**
 * The keyless devnet verifier behind `npm run verify:devnet` (plan step R5,
 * #2983). scripts/verify-devnet.ts wires the real file system and RPC client;
 * tests call `runVerifyDevnet` with a fake RPC.
 *
 *   npm run verify:devnet -- --receipt <address> [--recipient <address>] [--amount <atomic>] [--payout-id <hex>]
 *   npm run verify:devnet -- --signature <signature> [same expectations]
 *
 * It reads only at `finalized`, never needs a key, and never prints the RPC
 * URL. stdout is one JSON result; the exit code is 0 only for `paid`.
 */
import { address } from "@solana/kit";
import path from "node:path";
import { parsePayoutAtomicAmount } from "../../src/amount.ts";
import { isStrictBase58 } from "../../src/base58.ts";
import { AdminConfigError, parseReleaseManifest, resolveProgramId, toJsonText } from "../../src/admin/config.ts";
import {
  verifyDevnetReceipt,
  verifyDevnetSignature,
  verifyResultToJson,
  type Expectation,
  type VerifierRpc,
} from "../../src/admin/verify.ts";
import { addressValue, parseArgs, pathOption, UsageError } from "./args.ts";
import { redactRpcUrl } from "./redact.ts";

export const VERIFY_USAGE = `Usage: npm run verify:devnet -- (--receipt <address> | --signature <signature>)
         [--recipient <address>] [--amount <atomic>] [--payout-id <64 lowercase hex>]
         [--manifest <file>] [--rpc-url <url>]
The RPC URL defaults to the SOLANA_RPC_URL environment variable and is never printed.
`;

export type VerifyIo = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly createRpc: (rpcUrl: string) => VerifierRpc;
  readonly readText: (filePath: string) => string | null;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
};

export async function runVerifyDevnet(argv: readonly string[], io: VerifyIo): Promise<number> {
  const rpcIndex = argv.indexOf("--rpc-url");
  const rpcUrl = (rpcIndex === -1 ? undefined : argv[rpcIndex + 1]) ?? io.env.SOLANA_RPC_URL;
  const printErr = (text: string): void => io.stderr(redactRpcUrl(text, rpcUrl));
  try {
    const args = parseArgs(argv, {
      values: ["--receipt", "--signature", "--recipient", "--amount", "--payout-id", "--manifest", "--rpc-url"],
      flags: ["--help"],
    });
    if (args.flags.has("--help")) {
      printErr(VERIFY_USAGE);
      return 0;
    }
    const receiptValue = args.values.get("--receipt");
    const signatureValue = args.values.get("--signature");
    if ((receiptValue === undefined) === (signatureValue === undefined)) {
      throw new UsageError("pass exactly one of --receipt <address> or --signature <signature>.");
    }
    if (signatureValue !== undefined && !isStrictBase58(signatureValue, 64)) {
      throw new UsageError("--signature must be a strict base58 transaction signature.");
    }
    const expect: {
      recipient?: string;
      amountAtomic?: bigint;
      payoutIdHex?: string;
    } = {};
    const recipient = args.values.get("--recipient");
    if (recipient !== undefined) expect.recipient = addressValue(recipient, "--recipient");
    const amount = args.values.get("--amount");
    if (amount !== undefined) {
      try {
        expect.amountAtomic = parsePayoutAtomicAmount(amount);
      } catch {
        throw new UsageError("--amount must be a whole number of atomic units from 1 to 2^64 - 1.");
      }
    }
    const payoutId = args.values.get("--payout-id");
    if (payoutId !== undefined) {
      if (!/^[0-9a-f]{64}$/.test(payoutId)) throw new UsageError("--payout-id must be 64 lowercase hex characters.");
      expect.payoutIdHex = payoutId;
    }

    const manifestPath = pathOption(args, "--manifest") ?? path.join(io.cwd, "release", "manifest.json");
    const manifestText = io.readText(manifestPath);
    if (manifestText === null) throw new AdminConfigError("release/manifest.json was not found.");
    let manifestJson: unknown;
    try {
      manifestJson = JSON.parse(manifestText);
    } catch {
      throw new AdminConfigError("release/manifest.json is not valid JSON.");
    }
    const manifest = parseReleaseManifest(manifestJson);
    const resolution = resolveProgramId(manifest, "devnet", { iUnderstandMainnet: false });
    if (resolution.ok === false) throw new AdminConfigError(resolution.message);
    const deployment = manifest.deployments.devnet;
    if (deployment === null) throw new AdminConfigError("release/manifest.json has no devnet deployment (no vaults to check against).");
    if (rpcUrl === undefined || rpcUrl === "") throw new UsageError("set SOLANA_RPC_URL or pass --rpc-url (the value is never printed).");
    const rpc = io.createRpc(rpcUrl);
    const common = { rpc, programId: resolution.programId, vaults: deployment.vaults, expect: expect as Expectation };
    const result =
      receiptValue !== undefined
        ? await verifyDevnetReceipt({ ...common, receiptAddress: address(addressValue(receiptValue, "--receipt")) })
        : await verifyDevnetSignature({ ...common, signature: signatureValue as string });
    io.stdout(redactRpcUrl(toJsonText(verifyResultToJson(result)), rpcUrl));
    if (result.status !== "paid") printErr(`verify:devnet: ${result.status}\n`);
    return result.status === "paid" ? 0 : 1;
  } catch (error) {
    if (error instanceof UsageError || error instanceof AdminConfigError) {
      printErr(`verify:devnet: ${error.message}\n`);
      return 2;
    }
    const message = error instanceof Error ? `${error.name}: ${error.message}` : "unexpected error";
    printErr(`verify:devnet: ${message}\n`);
    return 1;
  }
}
