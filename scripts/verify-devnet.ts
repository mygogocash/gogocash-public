/**
 * Keyless devnet payout verifier (plan step R5, #2983):
 *
 *   npm run verify:devnet -- --receipt <address> | --signature <signature>
 *
 * Re-derives the receipt against each vault in release/manifest.json, reads
 * it at finalized through the contract section 3.8 procedure, and reports the
 * mint and the (recipient, amount, payout_id) tuple. See scripts/lib/verify-run.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSolanaRpc } from "@solana/kit";
import { verifierRpcFromKit } from "../src/admin/verify.ts";
import { runVerifyDevnet } from "./lib/verify-run.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

process.exitCode = await runVerifyDevnet(process.argv.slice(2), {
  env: process.env,
  cwd: repoRoot,
  createRpc: (rpcUrl) => verifierRpcFromKit(createSolanaRpc(rpcUrl)),
  readText: (filePath) => {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
