/**
 * End-to-end demo of the GoGoCash cashback payout path on Solana devnet.
 *
 *   npm install && npm run demo
 *
 * 1. A treasury wallet holds a 6-decimal demo USDC mint (devnet only).
 * 2. A member wallet stands in for the wallet the member connects on their
 *    Solana Mobile phone (see src/seeker-wallet.ts for the real connect flow).
 * 3. An approved cashback amount (THB, integer satang) converts to USDC.
 * 4. The treasury sends one USDC transfer tagged with the payout id.
 * 5. The payout is verified from the confirmed chain data before it would be
 *    marked paid, and a tampered expectation is shown to be rejected.
 *
 * Keys are throwaway devnet keypairs written to .demo/ (gitignored).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  clusterApiUrl,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  USDC_DECIMALS,
  formatUsdc,
  localMinorToUsdcBaseUnits,
} from "../src/amount.js";
import { buildCashbackPayoutTransaction } from "../src/payout.js";
import { fetchAndVerifyCashbackPayout } from "../src/verify.js";

const DEMO_DIR = ".demo";
const RPC_URL = process.env.SOLANA_RPC_URL ?? clusterApiUrl("devnet");

function loadOrCreateKeypair(name: string): Keypair {
  const path = `${DEMO_DIR}/${name}.json`;
  if (existsSync(path)) {
    return Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]),
    );
  }
  const keypair = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)), {
    mode: 0o600,
  });
  return keypair;
}

async function ensureSol(connection: Connection, wallet: PublicKey) {
  const balance = await connection.getBalance(wallet);
  if (balance >= 0.05 * LAMPORTS_PER_SOL) return;
  console.log("Requesting 1 devnet SOL for fees...");
  try {
    const sig = await connection.requestAirdrop(wallet, LAMPORTS_PER_SOL);
    const latest = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, ...latest });
  } catch {
    throw new Error(
      `Devnet airdrop was refused (rate limit). Fund ${wallet.toBase58()} ` +
        "at https://faucet.solana.com and run `npm run demo` again.",
    );
  }
}

async function loadOrCreateDemoUsdc(
  connection: Connection,
  treasury: Keypair,
): Promise<PublicKey> {
  const path = `${DEMO_DIR}/demo-usdc-mint.txt`;
  if (existsSync(path)) return new PublicKey(readFileSync(path, "utf8").trim());
  console.log("Creating a 6-decimal demo USDC mint on devnet...");
  const mint = await createMint(
    connection,
    treasury,
    treasury.publicKey,
    null,
    USDC_DECIMALS,
  );
  writeFileSync(path, mint.toBase58());
  return mint;
}

function explorer(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

async function main() {
  mkdirSync(DEMO_DIR, { recursive: true });
  const connection = new Connection(RPC_URL, "confirmed");
  const treasury = loadOrCreateKeypair("treasury");
  const member = loadOrCreateKeypair("member-wallet");

  console.log(`Treasury: ${treasury.publicKey.toBase58()}`);
  console.log(`Member wallet (stands in for a Seeker wallet): ${member.publicKey.toBase58()}`);

  await ensureSol(connection, treasury.publicKey);
  const usdcMint = await loadOrCreateDemoUsdc(connection, treasury);

  // Keep the treasury stocked with 1,000 demo USDC.
  const treasuryAta = await getOrCreateAssociatedTokenAccount(
    connection,
    treasury,
    usdcMint,
    treasury.publicKey,
  );
  const floor = 1_000n * 10n ** BigInt(USDC_DECIMALS);
  if (treasuryAta.amount < floor) {
    await mintTo(connection, treasury, usdcMint, treasuryAta.address, treasury, floor);
  }

  // Cashback the ledger approved for this member: THB 125.00 (12,500 satang).
  // FX: 1 THB = 0.02857 USD, as an exact fraction. Rounds down.
  const approvedThbSatang = 12_500n;
  const amountBaseUnits = localMinorToUsdcBaseUnits(approvedThbSatang, {
    numerator: 2857n,
    denominator: 100_000n,
  });
  const payout = {
    payoutId: `demo-${Date.now()}`,
    memberWallet: member.publicKey,
    amountBaseUnits,
  };
  const rails = { treasury: treasury.publicKey, usdcMint };
  console.log(
    `\nApproved cashback THB 125.00 -> ${formatUsdc(amountBaseUnits)} USDC (payout ${payout.payoutId})`,
  );

  const latest = await connection.getLatestBlockhash();
  const tx = buildCashbackPayoutTransaction(
    rails,
    payout,
    latest.blockhash,
    latest.lastValidBlockHeight,
  );
  const signature = await sendAndConfirmTransaction(connection, tx, [treasury], {
    commitment: "confirmed",
  });
  console.log(`Sent: ${explorer(signature)}`);

  const verified = await fetchAndVerifyCashbackPayout(connection, signature, rails, payout);
  console.log(
    verified.ok
      ? `Verified onchain at slot ${verified.slot}: safe to mark payout ${payout.payoutId} as paid.`
      : `Verification FAILED: ${verified.reason}`,
  );

  // The same transaction must not satisfy a different approved amount.
  const tampered = await fetchAndVerifyCashbackPayout(connection, signature, rails, {
    ...payout,
    amountBaseUnits: payout.amountBaseUnits + 1n,
  });
  console.log(
    `Check with a wrong amount is rejected: ${tampered.ok ? "NO (bug)" : `yes (${tampered.reason})`}`,
  );
  if (!verified.ok || tampered.ok) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
