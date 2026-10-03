/**
 * `npm run demo` (plan step R5, #2983) end to end over a fake devnet (no
 * network): the seven steps in order, each transaction's shape, the funding
 * precheck exiting before any send, the replay classification, the
 * verifier's mismatch, the pause drill's ordering, mainnet refusal, the RPC
 * URL never printed, and an evidence file with no key material. Key files
 * are throwaway keys written to a temp directory.
 */
import { createPublicKey, verify } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { getAddressEncoder, getBase58Encoder, type Address } from "@solana/kit";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { encodeBase58 } from "../src/base58.ts";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from "../src/clusters.ts";
import { getClaimInstructionDataDecoder } from "../src/generated/instructions/claim.ts";
import { findClassicAta, findReceiptPda } from "../src/program.ts";
import { verifyConsentSignature } from "../src/siws.ts";
import { evidenceProblems } from "../src/demo/evidence.ts";
import { runDemo } from "../scripts/lib/demo-run.ts";
import { sentInstructions, tempDir, writeKeyFile, type SentTransaction } from "./admin-helpers.ts";
import {
  CLOCK_UNIX,
  demoArgs,
  demoIo,
  demoKeys,
  demoWorld,
  EVIDENCE_PATH,
  PROGRAM,
  RPC_URL,
  throwawaySigner,
  type DemoWorld,
} from "./demo-helpers.ts";
import { INSTRUCTION_DISCRIMINATORS_HEX } from "./vectors.ts";

const dir = tempDir("gogocash-demo-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const keys = demoKeys(dir);
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

let world: DemoWorld;
let recipient: Address;

beforeEach(async () => {
  world = await demoWorld(keys);
  recipient = (await throwawaySigner("stand-in wallet")).address;
});

function signatureVerifies(tx: SentTransaction, signer: Address, index: number): boolean {
  const signature = Object.values(tx.signatures)[index];
  if (signature === null || signature === undefined) return false;
  const publicKey = createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, Buffer.from(getAddressEncoder().encode(signer))]),
    format: "der",
    type: "spki",
  });
  return Object.keys(tx.signatures)[index] === signer && verify(null, tx.messageBytes, publicKey, signature);
}

function claimData(tx: SentTransaction) {
  const claim = sentInstructions(tx)[3];
  if (claim === undefined) throw new Error("no claim instruction");
  return { claim, data: getClaimInstructionDataDecoder().decode(claim.data) };
}

function evidence(): string {
  const text = world.files.get(EVIDENCE_PATH);
  if (text === undefined) throw new Error("no evidence file");
  return text;
}

function allOutput(io: { out: string[]; err: string[] }): string {
  return [...io.out, ...io.err].join("");
}

describe("npm run demo: the seven steps", () => {
  it("runs every step in order, passes, and writes evidence/devnet-demo-<date>.md", async () => {
    const io = demoIo(world);
    expect(await runDemo(demoArgs(keys), io)).toBe(0);
    expect(world.chain.events).toEqual([
      "simulate:claim:3558875", // step 3: unsigned simulation of the claim
      "send:claim", // step 3: the one real payout
      "simulate:claim:3558875", // step 4: replay
      "simulate:claim:5000001", // step 6: over the cap
      "send:pause", // step 7
      "simulate:claim:3558875", // step 7: claim while paused
      "send:unpause", // step 7
    ]);
    const text = evidence();
    expect(text).toMatch(/^# Devnet demo evidence \(2026-10-03\)\n\nResult: \*\*PASS\*\* \(7 of 7 steps passed\)\./);
    for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(text).toMatch(new RegExp(`\\n## ${n}\\. .* \\(PASS\\)\\n`));
    expect(io.out.join("")).toContain("demo: PASS. Evidence: evidence/devnet-demo-2026-10-03.md");
    expect(world.chain.vaultFields.paused).toBe(false);
  });

  it("step 1 converts THB 125.00 to 3558875 atomic with the integer working printed", async () => {
    const io = demoIo(world);
    await runDemo(demoArgs(keys), io);
    const out = io.out.join("");
    expect(out).toContain("THB 125.00 = requested_minor 12500 satang");
    expect(out).toContain("usdc_atomic = floor(12500 x 10^12 / 3512345678) = 3558875 (3.558875 USDC)");
    expect(out).toContain("value_minor = ceil(3558875 x 3512345678 / 10^12) = 12500");
    expect(out).toContain("step 1 PASS: 3558875 atomic (3.558875 USDC)");
  });

  it("step 2: the stand-in wallet's consent signature verifies over the exact bytes in the evidence", async () => {
    await runDemo(demoArgs(keys), demoIo(world));
    const text = evidence();
    const message = /```text\n([\s\S]*?)\n```/.exec(text)?.[1];
    const signature = /Ed25519 signature \(base58\) `([1-9A-HJ-NP-Za-km-z]+)`/.exec(text)?.[1];
    expect(message?.split("\n")).toHaveLength(16);
    expect(message).toContain(`\n${recipient}\n`);
    expect(message).toContain("- gogocash:amount:3558875");
    expect(message).toContain(`- solana:devnet:${PROGRAM}`);
    expect(message).toContain("Withdraw 3.558875 USDC to this wallet on Solana devnet (test network, no real value). GoGoCash deducts THB 125.00");
    const verdict = verifyConsentSignature(
      Uint8Array.from(getAddressEncoder().encode(recipient)),
      new TextEncoder().encode(message as string),
      Uint8Array.from(getBase58Encoder().encode(signature as string)),
    );
    expect(verdict).toBe("ok");
    expect(text).toContain("verify ok; amount + 1 gives signature_invalid");
  });

  it("step 3: simulates unsigned, then sends [CU limit, CU price, ATA idempotent, claim] signed by the fee payer and the claim key", async () => {
    await runDemo(demoArgs(keys), demoIo(world));
    const simulation = world.chain.simulations[0];
    expect(simulation?.unsigned).toBe(true);
    const tx = world.chain.sent[0] as SentTransaction;
    expect(tx.message.version).toBe(0);
    const instructions = sentInstructions(tx);
    expect(instructions.map((ix) => ix.programAddress)).toEqual([
      COMPUTE_BUDGET_PROGRAM_ADDRESS,
      COMPUTE_BUDGET_PROGRAM_ADDRESS,
      ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
      PROGRAM,
    ]);
    // SetComputeUnitLimit(ceil(52000 x 115 / 100) = 59800), SetComputeUnitPrice(p75 of 1000..4000 = 3000).
    expect(hex(instructions[0]!.data)).toBe("02" + "98e9" + "0000");
    expect(hex(instructions[1]!.data)).toBe("03" + "b80b000000000000");
    expect(hex(instructions[2]!.data)).toBe("01");
    const recipientAta = await findClassicAta({ owner: recipient, mint: world.chain.mint });
    const { claim, data } = claimData(tx);
    const receipt = await findReceiptPda({ programAddress: PROGRAM, vault: world.chain.vault, payoutId: Uint8Array.from(data.payoutId) });
    expect(claim.accounts).toEqual([
      world.chain.vault,
      receipt.address,
      world.chain.mint,
      world.chain.vaultAta,
      recipient,
      recipientAta,
      keys.claim.address,
      keys.payer.address,
      TOKEN_PROGRAM_ADDRESS,
      SYSTEM_PROGRAM_ADDRESS,
    ]);
    expect(hex(claim.data.subarray(0, 8))).toBe(INSTRUCTION_DISCRIMINATORS_HEX.claim);
    expect(data.amount).toBe(3_558_875n);
    expect(data.expiresAt).toBe(CLOCK_UNIX + 300n);
    expect(hex(Uint8Array.from(data.payoutId))).toBe(simulation?.payoutIdHex);
    expect(signatureVerifies(tx, keys.payer.address, 0)).toBe(true);
    expect(signatureVerifies(tx, keys.claim.address, 1)).toBe(true);
    expect(evidence()).toContain("finalized; receipt match, so paid");
  });

  it("every simulation is the unsigned four-instruction claim with the cap as its compute-unit limit", async () => {
    await runDemo(demoArgs(keys), demoIo(world));
    const sims = world.chain.simulations;
    expect(sims).toHaveLength(4);
    // 90,000 while the stand-in wallet has no ATA (step 3), 60,000 once the claim created it.
    const caps = ["905f0100", "60ea0000", "60ea0000", "60ea0000"];
    sims.forEach((sim, index) => {
      expect(sim.unsigned).toBe(true);
      const instructions = sentInstructions(sim.sent);
      expect(instructions.map((ix) => ix.programAddress)).toEqual([
        COMPUTE_BUDGET_PROGRAM_ADDRESS,
        COMPUTE_BUDGET_PROGRAM_ADDRESS,
        ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
        PROGRAM,
      ]);
      expect(hex(instructions[0]!.data)).toBe(`02${caps[index]}`);
      expect(hex(instructions[3]!.data.subarray(0, 8))).toBe(INSTRUCTION_DISCRIMINATORS_HEX.claim);
      expect(sim.expiresAt).toBe(CLOCK_UNIX + 300n);
    });
    expect(sims.map((sim) => sim.amount)).toEqual([3_558_875n, 3_558_875n, 5_000_001n, 3_558_875n]);
    // Steps 3 and 4 share the payout_id; steps 6 and 7 each use a fresh one.
    expect(new Set(sims.map((sim) => sim.payoutIdHex)).size).toBe(3);
  });

  it("step 4: the replay simulates the same payout_id and amount, is refused with already in use, and is classified already_claimed", async () => {
    await runDemo(demoArgs(keys), demoIo(world));
    const [first, replay] = world.chain.simulations;
    expect(replay?.unsigned).toBe(true);
    expect(replay?.payoutIdHex).toBe(first?.payoutIdHex);
    expect(replay?.amount).toBe(first?.amount);
    expect(world.chain.events.slice(0, 3)).toEqual(["simulate:claim:3558875", "send:claim", "simulate:claim:3558875"]);
    const text = evidence();
    expect(text).toContain("| 4 | Replay of the same payout_id |");
    expect(text).toContain("refused: Custom(0) AccountAlreadyInUse at instruction 3, class already_claimed");
    expect(text).toContain('The logs carry the system program\'s "already in use" line');
    expect(text).toContain("already_claimed routes to receipt verification (section 3.8): match");
  });

  it("step 5: the keyless verifier gives paid for the claim and mismatch (amount) with amount + 1", async () => {
    await runDemo(demoArgs(keys), demoIo(world));
    const text = evidence();
    expect(text).toContain("exact: paid; amount + 1: mismatch (amount)");
    expect(text).toContain("--amount 3558876` gives mismatch with reasons amount");
    expect(text).toContain("token balances cross-check ok");
  });

  it("step 6: a claim of max_per_claim + 1 is simulated unsigned and refused with 6010, class needs_review", async () => {
    await runDemo(demoArgs(keys), demoIo(world));
    const overCap = world.chain.simulations[2];
    expect(overCap?.amount).toBe(5_000_001n);
    expect(overCap?.unsigned).toBe(true);
    expect(overCap?.payoutIdHex).not.toBe(world.chain.simulations[0]?.payoutIdHex);
    expect(evidence()).toContain("refused: 6010 ExceedsMaxPerClaim at instruction 3, class needs_review");
  });

  it("step 7: the guardian pauses, a claim is refused with 6000 Paused, then the admin unpauses, in that order", async () => {
    await runDemo(demoArgs(keys), demoIo(world));
    expect(world.chain.events.slice(4)).toEqual(["send:pause", "simulate:claim:3558875", "send:unpause"]);
    const [, pause, unpause] = world.chain.sent as SentTransaction[];
    const pauseIx = sentInstructions(pause!);
    expect(pauseIx).toHaveLength(1);
    expect(pauseIx[0]?.programAddress).toBe(PROGRAM);
    expect(hex(pauseIx[0]!.data)).toBe(INSTRUCTION_DISCRIMINATORS_HEX.pause);
    expect(pauseIx[0]?.accounts).toEqual([world.chain.vault, keys.guardian.address]);
    expect(signatureVerifies(pause!, keys.payer.address, 0)).toBe(true);
    expect(signatureVerifies(pause!, keys.guardian.address, 1)).toBe(true);
    const unpauseIx = sentInstructions(unpause!);
    expect(hex(unpauseIx[0]!.data)).toBe(INSTRUCTION_DISCRIMINATORS_HEX.unpause);
    expect(unpauseIx[0]?.accounts).toEqual([world.chain.vault, keys.admin.address]);
    expect(signatureVerifies(unpause!, keys.admin.address, 1)).toBe(true);
    expect(evidence()).toContain("claim refused: 6000 Paused at instruction 3, class hold (program_paused)");
  });

  it("step 7 still unpauses when the paused claim is not refused, and the run fails", async () => {
    world.chain.simulateIgnoresPause = true;
    const io = demoIo(world);
    expect(await runDemo(demoArgs(keys), io)).toBe(1);
    expect(world.chain.events.slice(4)).toEqual(["send:pause", "simulate:claim:3558875", "send:unpause"]);
    expect(world.chain.vaultFields.paused).toBe(false);
    expect(evidence()).toContain("| 7 | Pause drill |");
    expect(evidence()).toMatch(/## 7\. Pause drill \(FAIL\)/);
    expect(evidence()).toContain("NOT refused");
  });

  it("step 7 rides out a status poll that throws while the pause sits at confirmed, then completes the drill", async () => {
    // The pause lands at confirmed at once and reaches finalized only after
    // three more polls; the first poll is a 429. Reading the vault at
    // finalized right after that error would see paused = false.
    world.chain.adminScenarios.pause = { statusErrors: 1, confirmedPolls: 3 };
    const io = demoIo(world);
    expect(await runDemo(demoArgs(keys), io)).toBe(0);
    expect(world.chain.events.slice(4)).toEqual(["send:pause", "simulate:claim:3558875", "send:unpause"]);
    const pauseSignature = world.chain.sent[1]?.signature as string;
    expect(world.chain.statusPolls.filter((s) => s === pauseSignature)).toHaveLength(5);
    expect(world.chain.vaultFields.paused).toBe(false);
    expect(evidence()).toMatch(/## 7\. Pause drill \(PASS\)/);
  });

  it("step 7 settles a pause whose send reply was lost, and still restores the vault", async () => {
    world.chain.adminScenarios.pause = { sendThrows: "after_accept", confirmedPolls: 2 };
    const io = demoIo(world);
    expect(await runDemo(demoArgs(keys), io)).toBe(0);
    expect(world.chain.events.slice(4)).toEqual(["send:pause", "simulate:claim:3558875", "send:unpause"]);
    expect(world.chain.vaultFields.paused).toBe(false);
    expect(evidence()).toContain("The pause's send reported Error: fetch failed; its fate was settled from its signature status.");
  });

  it("step 7 unpauses from the confirmed read when the pause never reports a status and never reaches finalized", async () => {
    world.chain.adminScenarios.pause = { lostStatus: true };
    const io = demoIo(world);
    expect(await runDemo(demoArgs(keys), io)).toBe(1);
    expect(world.chain.events.slice(4)).toEqual(["send:pause", "send:unpause"]);
    expect(world.chain.vaultFields.paused).toBe(false);
    const text = evidence();
    expect(text).toMatch(/## 7\. Pause drill \(FAIL\)/);
    expect(text).toContain("the guardian's pause did not settle");
    expect(text).toContain("The admin's unpause finalized; the vault reads paused = false at finalized.");
  });

  it("step 7 reports never paused only when the pause's blockhash expired with no status, and sends no unpause", async () => {
    world.chain.adminScenarios.pause = { sendThrows: "before_accept" };
    const io = demoIo(world);
    expect(await runDemo(demoArgs(keys), io)).toBe(1);
    expect(world.chain.events.slice(4)).toEqual(["drop:pause"]);
    expect(world.chain.vaultFields.paused).toBe(false);
    const text = evidence();
    expect(text).toMatch(/## 7\. Pause drill \(FAIL\)/);
    expect(text).toContain("The pause never landed (no status before its blockhash expired), so no unpause was sent");
  });

  it("step 7 rebuilds the unpause when it never landed, and the vault ends unpaused", async () => {
    world.chain.adminScenarios.unpause = { sendThrows: "before_accept" };
    const io = demoIo(world);
    expect(await runDemo(demoArgs(keys), io)).toBe(0);
    expect(world.chain.events.slice(4)).toEqual(["send:pause", "simulate:claim:3558875", "drop:unpause", "send:unpause"]);
    expect(world.chain.vaultFields.paused).toBe(false);
    expect(evidence()).toContain("never landed (its blockhash expired); rebuilt and sent again");
  });

  it("step 7 tells the operator to unpause by hand when the unpause fails onchain", async () => {
    world.chain.adminScenarios.unpause = { failsOnchain: true };
    const io = demoIo(world);
    expect(await runDemo(demoArgs(keys), io)).toBe(1);
    expect(world.chain.events.slice(4)).toEqual(["send:pause", "simulate:claim:3558875", "fail:unpause"]);
    expect(world.chain.vaultFields.paused).toBe(true);
    const handFix = "npm run admin -- unpause --cluster devnet --vault demo --keypair <admin.json>";
    expect(io.out.join("")).toContain(`step 7: the demo vault may still be paused. Check it: npm run admin -- show --cluster devnet --vault demo`);
    expect(io.out.join("")).toContain(handFix);
    const text = evidence();
    expect(text).toMatch(/## 7\. Pause drill \(FAIL\)/);
    expect(text).toContain('Restoring the vault did not complete: the admin\'s unpause failed onchain ({"InstructionError":[0,{"Custom":6002}]})');
    expect(text).toContain(handFix);
  });

  it("step 7 holds Ctrl-C from before the pause is sent until the vault is restored", async () => {
    const io = demoIo(world);
    expect(await runDemo(demoArgs(keys), io)).toBe(0);
    // events[4] is send:pause, events[6] is send:unpause.
    expect(io.interrupts).toEqual([{ heldAt: 4, releasedAt: 7 }]);
    expect(io.interruptNotices[0]?.onFirst).toContain("finishing the pause drill");
    expect(io.interruptNotices[0]?.onSecond).toContain("npm run admin -- unpause --cluster devnet --vault demo");
  });

  it("a failed step stops the run: later steps are SKIPPED, nothing more is sent, and the evidence says FAIL", async () => {
    world.chain.simulateIgnoresReceipts = true;
    const io = demoIo(world);
    expect(await runDemo(demoArgs(keys), io)).toBe(1);
    expect(world.chain.events).toEqual(["simulate:claim:3558875", "send:claim", "simulate:claim:3558875"]);
    const text = evidence();
    expect(text).toContain("Result: **FAIL** (3 of 7 steps passed).");
    expect(text).toMatch(/## 4\. Replay of the same payout_id \(FAIL\)/);
    for (const n of [5, 6, 7]) expect(text).toMatch(new RegExp(`\\| ${n} \\| .* \\| not run \\(an earlier step failed\\) \\| SKIPPED \\|`));
  });

  it("a second run the same day writes devnet-demo-<date>-2.md and never overwrites", async () => {
    world.files.set(EVIDENCE_PATH, "earlier run\n");
    expect(await runDemo(demoArgs(keys), demoIo(world))).toBe(0);
    expect(world.files.get(EVIDENCE_PATH)).toBe("earlier run\n");
    expect(world.files.get("/repo/evidence/devnet-demo-2026-10-03-2.md")).toMatch(/Result: \*\*PASS\*\*/);
  });
});

describe("npm run demo: refusals before anything is sent", () => {
  it("exits 3 when the fee payer lacks SOL, before any simulation or send, naming only the address to fund", async () => {
    world.chain.setAccount(keys.payer.address, null);
    const io = demoIo(world);
    expect(await runDemo(demoArgs(keys), io)).toBe(3);
    expect(world.chain.sent).toEqual([]);
    expect(world.chain.simulations).toEqual([]);
    const output = allOutput(io);
    // rent(0) 650240 + receipt 1102360 + token account 1488440 + fee budget 50000.
    expect(output).toContain(`fund ${keys.payer.address} with devnet SOL: it holds 0 lamports and the demo needs 3291040.`);
    expect(output).toContain("nothing was sent");
    expect(output).not.toContain(RPC_URL);
    expect(output).not.toContain("demo-rpc.example.invalid");
    expect([...world.files.keys()].some((name) => name.startsWith("/repo/evidence/"))).toBe(false);
  });

  it("exits 3 when the vault cannot cover the payout, naming the vault and the deposit command", async () => {
    world.chain.setVaultBalance(1_000n);
    const io = demoIo(world);
    expect(await runDemo(demoArgs(keys), io)).toBe(3);
    expect(world.chain.sent).toEqual([]);
    expect(allOutput(io)).toContain(`fund vault ${world.chain.vault}: it holds 1000 atomic and the demo pays 3558875.`);
    expect(allOutput(io)).toContain("npm run admin -- deposit --cluster devnet --vault demo");
  });

  it("refuses mainnet before reading any key file or creating an RPC client", async () => {
    const io = demoIo(world);
    const args = demoArgs(keys).map((value) => (value === "devnet" ? "mainnet" : value));
    expect(await runDemo(args, io)).toBe(2);
    expect(io.err.join("")).toContain("mainnet is refused");
    expect(io.calls).toEqual({ createRpc: 0, loadSigner: 0 });
    // --i-understand-mainnet unlocks nothing here.
    expect(await runDemo([...args, "--i-understand-mainnet"], demoIo(world))).toBe(2);
  });

  it("refuses the usdc vault the API claims from", async () => {
    const io = demoIo(world);
    const args = demoArgs(keys).map((value) => (value === "demo" ? "usdc" : value));
    expect(await runDemo(args, io)).toBe(2);
    expect(io.err.join("")).toContain('never runs against the "usdc" vault');
    expect(io.calls.createRpc).toBe(0);
  });

  it("refuses a paused vault with the unpause command, and sends nothing", async () => {
    world.chain.setVault({ paused: true });
    const io = demoIo(world);
    expect(await runDemo(demoArgs(keys), io)).toBe(2);
    expect(world.chain.sent).toEqual([]);
    expect(io.err.join("")).toContain("npm run admin -- unpause --cluster devnet --vault demo");
  });

  it("refuses a claim key file that is not the demo vault's claim authority", async () => {
    const stranger = writeKeyFile(dir, "not the claim key");
    const io = demoIo(world);
    const args = demoArgs(keys).map((value) => (value === keys.claim.path ? stranger.path : value));
    expect(await runDemo(args, io)).toBe(2);
    expect(io.err.join("")).toContain("--claim-keypair is not the claim authority");
    expect(io.calls.createRpc).toBe(0);
  });

  it("refuses an RPC that is not devnet (genesis hash)", async () => {
    world.chain.genesisHash = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
    const io = demoIo(world);
    expect(await runDemo(demoArgs(keys), io)).toBe(2);
    expect(io.err.join("")).toContain("the RPC is not devnet");
    expect(world.chain.sent).toEqual([]);
  });

  it("refuses when the payout is above the vault's max_per_claim (step 1 bounds), and sends nothing", async () => {
    world.chain.setVault({ maxPerDay: 3_000_000n, maxPerClaim: 3_000_000n });
    const io = demoIo(world);
    expect(await runDemo(demoArgs(keys), io)).toBe(2);
    expect(io.err.join("")).toContain("above_maximum");
    expect(world.chain.sent).toEqual([]);
  });

  it("exits 2 with no evidence file when an RPC read fails before anything is sent", async () => {
    world.chain.getMinimumBalanceForRentExemption = async () => {
      throw new Error(`HTTP error (429) from ${RPC_URL}`);
    };
    const io = demoIo(world);
    expect(await runDemo(demoArgs(keys), io)).toBe(2);
    expect(world.chain.sent).toEqual([]);
    expect(world.chain.simulations).toEqual([]);
    const output = allOutput(io);
    expect(output).toContain("HTTP error (429)");
    expect(output).toContain("nothing was sent");
    expect(output).not.toContain(RPC_URL);
    expect([...world.files.keys()].some((name) => name.startsWith("/repo/evidence/"))).toBe(false);
  });

  it("asks for an RPC URL without printing anything that looks like one", async () => {
    const io = demoIo(world, { env: {} });
    expect(await runDemo(demoArgs(keys), io)).toBe(2);
    expect(io.err.join("")).toContain("set SOLANA_RPC_URL or pass --rpc-url");
  });
});

describe("npm run demo: secrets stay out of output and evidence", () => {
  it("never prints or writes the RPC URL, given by environment or by flag", async () => {
    const io = demoIo(world, { env: {} });
    expect(await runDemo(demoArgs(keys, ["--rpc-url", RPC_URL]), io)).toBe(0);
    for (const text of [allOutput(io), evidence()]) {
      expect(text).not.toContain(RPC_URL);
      expect(text).not.toContain("demo-rpc.example.invalid");
      expect(text).not.toContain("secret-key-QwErTy0123456789");
    }
  });

  it("the evidence holds signatures and explorer links, no key material, and no 64-number arrays", async () => {
    await runDemo(demoArgs(keys), demoIo(world));
    const text = evidence();
    const signatures = world.chain.sent.map((tx) => encodeBase58(Object.values(tx.signatures)[0] as Uint8Array));
    expect(signatures).toHaveLength(3);
    for (const signature of signatures) {
      expect(text).toContain(`[\`${signature}\`](https://explorer.solana.com/tx/${signature}?cluster=devnet)`);
    }
    expect(text).not.toMatch(/\[\s*(?:\d{1,3}\s*,\s*){31,}\d{1,3}\s*\]/);
    for (const key of Object.values(keys)) {
      const fileText = readFileSync(key.path, "utf8");
      const secret = Uint8Array.from(JSON.parse(fileText) as number[]);
      expect(text).not.toContain(fileText);
      expect(text).not.toContain(encodeBase58(secret));
      expect(text).not.toContain(hex(secret.subarray(0, 32)));
      expect(text).not.toContain(Buffer.from(secret.subarray(0, 32)).toString("base64"));
    }
    const consentSignature = /Ed25519 signature \(base58\) `([1-9A-HJ-NP-Za-km-z]+)`/.exec(text)?.[1] as string;
    expect(evidenceProblems(text, { allowedLongValues: [...signatures, consentSignature], forbidden: [RPC_URL] })).toEqual([]);
    // Without the allow-list, the guard would refuse those 64-byte values.
    expect(evidenceProblems(text, { allowedLongValues: [], forbidden: [] })).not.toEqual([]);
  });
});
