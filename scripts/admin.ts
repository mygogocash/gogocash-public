/**
 * Operator CLI for the gogocash_cashback vaults (plan step R5, #2983):
 *
 *   npm run admin -- <initialize|show|deposit|pause|unpause|update_config|propose_admin|accept_admin|withdraw> \
 *     --cluster devnet [options]
 *
 * Built on @solana/kit and the generated client; no Solana CLI is needed.
 * Keys are read only from the files named by --keypair / --fee-payer (mode
 * 0600); no option or environment variable carries key material. The RPC URL
 * comes from SOLANA_RPC_URL (preferred: a flag value is visible in the
 * process list) or --rpc-url, and is never printed. See
 * `npm run admin -- --help` and docs/RUNBOOK-DEVNET.md.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSolanaRpc } from "@solana/kit";
import { adminRpcFromKit } from "../src/admin/rpc.ts";
import { runAdmin } from "./lib/admin-run.ts";
import { readKeypairSigner } from "./lib/keyfile.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

process.exitCode = await runAdmin(process.argv.slice(2), {
  env: process.env,
  cwd: repoRoot,
  createRpc: (rpcUrl) => adminRpcFromKit(createSolanaRpc(rpcUrl)),
  loadSigner: (filePath, flag) => readKeypairSigner(filePath, flag),
  readText: (filePath) => {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  writeText: (filePath, text) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, text);
  },
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});
