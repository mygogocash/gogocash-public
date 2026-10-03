/**
 * The devnet demo of plan step R5 (#2983) on the demo-mint vault:
 *
 *   SOLANA_RPC_URL=https://api.devnet.solana.com npm run demo -- --cluster devnet --vault demo \
 *     --claim-keypair ~/.config/gogocash/devnet/demo-claim-authority.json \
 *     --guardian-keypair ~/.config/gogocash/devnet/guardian.json \
 *     --admin-keypair ~/.config/gogocash/devnet/admin.json
 *
 * THB to USDC, consent, claim to a finalized `paid` receipt, replay, the
 * keyless verifier's mismatch, the over-cap and pause drills, then
 * evidence/devnet-demo-<date>.md. Keys are read only from the files named on
 * the command line (mode 0600); the stand-in member wallet is a throwaway key
 * made in memory and never written. The RPC URL is never printed. See
 * scripts/lib/demo-run.ts and docs/RUNBOOK-DEVNET.md.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSolanaRpc, generateKeyPairSigner } from "@solana/kit";
import { demoRpcFromKit } from "../src/demo/rpc.ts";
import { interruptHolder, runDemo } from "./lib/demo-run.ts";
import { readKeypairSigner } from "./lib/keyfile.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

process.exitCode = await runDemo(process.argv.slice(2), {
  env: process.env,
  cwd: repoRoot,
  createRpc: (rpcUrl) => demoRpcFromKit(createSolanaRpc(rpcUrl)),
  loadSigner: (filePath, flag) => readKeypairSigner(filePath, flag),
  // Non-extractable: the stand-in wallet's secret never leaves WebCrypto.
  generateRecipient: () => generateKeyPairSigner(false),
  randomBytes: (length) => Uint8Array.from(randomBytes(length)),
  now: () => Date.now(),
  readText: (filePath) => {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  writeNewText: (filePath, text) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    try {
      fs.writeFileSync(filePath, text, { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  },
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // During the pause drill the first Ctrl-C lets the unpause finish.
  holdInterrupts: interruptHolder(process, (text) => process.stderr.write(text)),
});
