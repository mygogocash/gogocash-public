/**
 * Generates one Solana keypair file for an operator (plan step R4, #2982).
 *
 *   node scripts/keygen.ts --out ~/.config/gogocash/devnet/deployer.json
 *   npm run keygen -- --out ~/.config/gogocash/devnet/deployer.json
 *
 * - node:crypto Ed25519; the file is the solana-keygen format (a JSON array
 *   of 64 bytes: seed, then public key), so the Solana CLI, Anchor and
 *   `gh secret set ... < file` read it as is;
 * - written under umask 077 with mode 0600; never over an existing file;
 * - the path must be outside every git worktree, or git-ignored;
 * - stdout is ONLY the base58 public key and a newline. The secret is never
 *   printed, and no option takes key material.
 */
import { UsageError, parseArgs, pathOption } from "./lib/args.ts";
import { KeyFileError, writeNewKeypairFile } from "./lib/keyfile.ts";

const USAGE = "Usage: node scripts/keygen.ts --out <path outside the repository>";

function main(argv: readonly string[]): number {
  try {
    const args = parseArgs(argv, { values: ["--out"], flags: ["--help"] });
    if (args.flags.has("--help")) {
      process.stderr.write(`${USAGE}\n`);
      return 0;
    }
    const out = pathOption(args, "--out");
    if (out === undefined) throw new UsageError("--out is required.");
    const { publicKey } = writeNewKeypairFile(out);
    process.stdout.write(`${publicKey}\n`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError || error instanceof KeyFileError) {
      process.stderr.write(`keygen: ${error.message}\n${USAGE}\n`);
      return 2;
    }
    // Unexpected: print only the error class, never a message that could
    // carry key material.
    process.stderr.write(`keygen: unexpected ${(error as Error)?.name ?? "error"}; no key was written.\n`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
