/**
 * `npm run verify:devnet` (plan step R5, #2983) over a fake RPC (no network,
 * no key): it re-derives the receipt against each vault of
 * release/manifest.json, reads at `finalized`, and reports the vault, mint and
 * (recipient, amount, payout_id). Covers --receipt and --signature, every
 * non-paid outcome, the manifest gates and the RPC URL never being printed.
 */
import { getBase58Decoder, type Address } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { GENESIS_HASH, TOKEN_PROGRAM_ADDRESS, USDC_MINT, V0_PLACEHOLDER_PROGRAM_ID } from "../src/clusters.ts";
import { getReceiptEncoder } from "../src/generated/accounts/receipt.ts";
import { getClaimInstructionDataEncoder } from "../src/generated/instructions/claim.ts";
import { findClassicAta, findReceiptPda, findVaultPda, payoutIdFromHex } from "../src/program.ts";
import { toJsonText } from "../src/admin/config.ts";
import { extractClaims, type TransactionView } from "../src/admin/verify.ts";
import { runVerifyDevnet, type VerifyIo } from "../scripts/lib/verify-run.ts";
import { FakeChain, labelAddress } from "./admin-helpers.ts";

const PROGRAM = labelAddress("verifier test program");
const OTHER_PROGRAM = labelAddress("some other program");
const DEMO_MINT = labelAddress("demo mint");
const RECIPIENT = labelAddress("recipient wallet");
const CLAIM_KEY = labelAddress("claim authority");
const PAYER = labelAddress("fee payer");
const PAYOUT_ID_HEX = "c6a87a9e170995438a78874587cb95773a9fa752c5b1633c9e7ae23928c88021";
const OTHER_PAYOUT_ID_HEX = "11".repeat(32);
const AMOUNT = 3_558_875n;
const CLAIMED_AT = 1_790_910_270n;
const RPC_URL = "https://verifier-rpc.example.invalid/v1/key-ZyXw9876543210";
const SIGNATURE = getBase58Decoder().decode(Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256));

type VaultInfo = { name: string; mint: Address; vault: Address; vaultTokenAccount: Address };
let usdc: VaultInfo;
let demo: VaultInfo;
let chain: FakeChain;
let files: Map<string, string>;

async function vaultInfo(name: string, mint: Address): Promise<VaultInfo> {
  const vault = (await findVaultPda({ programAddress: PROGRAM, mint })).address;
  return { name, mint, vault, vaultTokenAccount: await findClassicAta({ owner: vault, mint }) };
}

function manifestText(input: { programId?: string | null; deployed?: boolean } = {}): string {
  const programId = input.programId === undefined ? PROGRAM : input.programId;
  return toJsonText({
    schema: 1,
    contract: "v0",
    programIds: { devnet: programId, mainnet: null },
    deployments: {
      devnet:
        input.deployed === false
          ? null
          : {
              programHash: "ab".repeat(32),
              soSha256: "cd".repeat(32),
              deploySlot: "412345678",
              upgradeAuthority: labelAddress("deployer"),
              commit: "e".repeat(40),
              tag: "v0.1.0",
              vaults: [usdc, demo].map((v) => ({ name: v.name, mint: v.mint, vault: v.vault, vaultTokenAccount: v.vaultTokenAccount })),
            },
      mainnet: null,
    },
  });
}

async function putReceipt(
  vault: VaultInfo,
  overrides: { owner?: Address; payoutIdHex?: string; recipient?: Address; amount?: bigint; bump?: number } = {},
): Promise<Address> {
  const payoutIdHex = overrides.payoutIdHex ?? PAYOUT_ID_HEX;
  const pda = await findReceiptPda({ programAddress: PROGRAM, vault: vault.vault, payoutId: payoutIdFromHex(payoutIdHex) });
  const data = Uint8Array.from(
    getReceiptEncoder().encode({
      bump: overrides.bump ?? pda.bump,
      payoutId: payoutIdFromHex(payoutIdHex),
      recipient: overrides.recipient ?? RECIPIENT,
      amount: overrides.amount ?? AMOUNT,
      claimedAt: CLAIMED_AT,
    }),
  );
  chain.setAccount(pda.address, { owner: overrides.owner ?? PROGRAM, executable: false, lamports: 1_102_360n, data });
  return pda.address;
}

/** A finalized claim transaction: [createAssociatedTokenIdempotent, claim], with token balances. */
async function putClaimTransaction(vault: VaultInfo, receipt: Address, amount = AMOUNT): Promise<void> {
  const recipientAta = await findClassicAta({ owner: RECIPIENT, mint: vault.mint });
  const keys = [
    PAYER, // 0 fee payer (signer, writable)
    CLAIM_KEY, // 1 claim authority (signer)
    vault.vault, // 2
    receipt, // 3
    vault.vaultTokenAccount, // 4
    recipientAta, // 5
    RECIPIENT, // 6
    vault.mint, // 7
    TOKEN_PROGRAM_ADDRESS, // 8
    "11111111111111111111111111111111", // 9
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // 10
    PROGRAM, // 11
  ];
  const claimData = Uint8Array.from(
    getClaimInstructionDataEncoder().encode({ payoutId: payoutIdFromHex(PAYOUT_ID_HEX), amount, expiresAt: CLAIMED_AT + 300n }),
  );
  const balance = (accountIndex: number, owner: string, value: bigint) => ({
    accountIndex,
    mint: vault.mint,
    owner,
    programId: TOKEN_PROGRAM_ADDRESS,
    uiTokenAmount: { amount: value.toString() },
  });
  const transaction: TransactionView = {
    slot: 412_400_000n,
    staticAccountKeys: keys,
    instructions: [
      { programIdIndex: 10, accounts: [0, 5, 6, 7, 9, 8], data: Uint8Array.of(1) },
      // claim accounts: vault, receipt, mint, vault ATA, recipient, recipient ATA, claim authority, payer, token, system
      { programIdIndex: 11, accounts: [2, 3, 7, 4, 6, 5, 1, 0, 8, 9], data: claimData },
    ],
    meta: {
      err: null,
      preTokenBalances: [balance(4, vault.vault, 10_000_000n)],
      postTokenBalances: [balance(4, vault.vault, 10_000_000n - amount), balance(5, RECIPIENT, amount)],
      loadedAddresses: { writable: [], readonly: [] },
    },
  };
  chain.transactions.set(SIGNATURE, transaction);
}

type Captured = VerifyIo & { out: string[]; err: string[] };

function io(env: Record<string, string> = { SOLANA_RPC_URL: RPC_URL }, createRpc?: VerifyIo["createRpc"]): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return {
    env,
    cwd: "/repo",
    createRpc: createRpc ?? (() => chain),
    readText: (filePath) => files.get(filePath) ?? null,
    stdout: (text) => {
      out.push(text);
    },
    stderr: (text) => {
      err.push(text);
    },
    out,
    err,
  };
}

async function verify(argv: string[], captured: Captured = io()) {
  const code = await runVerifyDevnet(argv, captured);
  const stdout = captured.out.join("");
  return { code, stdout, stderr: captured.err.join(""), json: stdout === "" ? null : (JSON.parse(stdout) as Record<string, unknown>) };
}

beforeEach(async () => {
  usdc = await vaultInfo("usdc", USDC_MINT.devnet);
  demo = await vaultInfo("demo", DEMO_MINT);
  chain = new FakeChain();
  files = new Map([["/repo/release/manifest.json", manifestText()]]);
});

describe("--receipt", () => {
  it("paid: finds the receipt's vault among the manifest's and reports mint, recipient, amount and payout_id", async () => {
    const receipt = await putReceipt(usdc);
    const result = await verify(["--receipt", receipt]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.json).toEqual({
      status: "paid",
      payout: {
        vault: { name: "usdc", mint: USDC_MINT.devnet, vault: usdc.vault, vaultTokenAccount: usdc.vaultTokenAccount },
        receipt,
        contextSlot: "500",
        payoutIdHex: PAYOUT_ID_HEX,
        recipient: RECIPIENT,
        amountAtomic: "3558875",
        claimedAt: CLAIMED_AT.toString(),
      },
    });
    // Every read is at finalized, and the receipt is read through the section 3.8 path.
    expect(chain.reads.length).toBeGreaterThan(0);
    expect(chain.reads.every((r) => r.commitment === "finalized")).toBe(true);
  });

  it("re-derives against EACH vault: a receipt under the second (demo) vault reports the demo mint", async () => {
    const receipt = await putReceipt(demo);
    const result = await verify(["--receipt", receipt]);
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ status: "paid", payout: { vault: { name: "demo", mint: DEMO_MINT } } });
  });

  it("the caller's expectations: a wrong amount, recipient or payout_id is a mismatch (exit 1), never paid", async () => {
    const receipt = await putReceipt(usdc);
    const amount = await verify(["--receipt", receipt, "--amount", (AMOUNT + 1n).toString()]);
    expect(amount.code).toBe(1);
    expect(amount.json).toMatchObject({ status: "mismatch", reasons: ["amount"] });
    expect(amount.stderr).toMatch(/verify:devnet: mismatch/);

    const recipient = await verify(["--receipt", receipt, "--recipient", labelAddress("someone else")]);
    expect(recipient.json).toMatchObject({ status: "mismatch", reasons: ["recipient"] });

    const payoutId = await verify(["--receipt", receipt, "--payout-id", OTHER_PAYOUT_ID_HEX]);
    expect(payoutId.json).toMatchObject({ status: "mismatch", reasons: ["payout_id"] });

    const allMatch = await verify([
      "--receipt", receipt,
      "--amount", AMOUNT.toString(),
      "--recipient", RECIPIENT,
      "--payout-id", PAYOUT_ID_HEX,
    ]);
    expect(allMatch.code).toBe(0);
  });

  it("absent, foreign owner, wrong bump and an address no manifest vault derives are not paid", async () => {
    const absent = await verify(["--receipt", labelAddress("nothing here")]);
    expect(absent.code).toBe(1);
    expect(absent.json).toMatchObject({ status: "absent", contextSlot: "500" });

    const foreign = await putReceipt(usdc, { owner: OTHER_PROGRAM });
    expect((await verify(["--receipt", foreign])).json).toMatchObject({ status: "mismatch", reasons: ["owner"] });

    const badBump = await putReceipt(usdc, { payoutIdHex: OTHER_PAYOUT_ID_HEX, bump: 7 });
    expect((await verify(["--receipt", badBump])).json).toMatchObject({ status: "mismatch", reasons: ["bump"] });

    // Valid receipt bytes stored at an address that is not ["receipt", vault, payout_id] for any manifest vault.
    const stray = labelAddress("stray receipt address");
    const real = await putReceipt(usdc);
    chain.setAccount(stray, chain.accounts.get(real)!);
    const unbound = await verify(["--receipt", stray]);
    expect(unbound.code).toBe(1);
    expect(unbound.json).toMatchObject({ status: "mismatch", reasons: ["unbound"] });
  });

  it("an RPC that is not devnet is refused before any account read", async () => {
    chain.genesisHash = GENESIS_HASH.mainnet;
    const receipt = await putReceipt(usdc);
    const result = await verify(["--receipt", receipt]);
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ status: "genesis_mismatch", observedGenesisHash: GENESIS_HASH.mainnet });
    expect(chain.reads).toEqual([]);
  });
});

describe("--signature", () => {
  it("paid: takes the claim's own (recipient, amount, payout_id) and cross-checks the token balances", async () => {
    const receipt = await putReceipt(usdc);
    await putClaimTransaction(usdc, receipt);
    const result = await verify(["--signature", SIGNATURE]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({
      status: "paid",
      payout: { receipt, recipient: RECIPIENT, amountAtomic: "3558875", payoutIdHex: PAYOUT_ID_HEX, vault: { name: "usdc" } },
      transaction: { signature: SIGNATURE, slot: "412400000", succeeded: true, tokenBalances: { ok: true } },
    });
  });

  it("a claim whose amount differs from the receipt is a mismatch", async () => {
    const receipt = await putReceipt(usdc);
    await putClaimTransaction(usdc, receipt, AMOUNT + 1n);
    const result = await verify(["--signature", SIGNATURE]);
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ status: "mismatch", reasons: ["amount"] });
  });

  it("unknown signatures, transactions without exactly one claim, and claims on a vault outside the manifest", async () => {
    const missing = await verify(["--signature", SIGNATURE]);
    expect(missing.code).toBe(1);
    expect(missing.json).toMatchObject({ status: "transaction_not_found", signature: SIGNATURE });

    const receipt = await putReceipt(usdc);
    await putClaimTransaction(usdc, receipt);
    const tx = chain.transactions.get(SIGNATURE)!;
    chain.transactions.set(SIGNATURE, { ...tx, instructions: tx.instructions.slice(0, 1) });
    expect((await verify(["--signature", SIGNATURE])).json).toMatchObject({ status: "not_a_claim", claims: 0 });

    const outsider = await vaultInfo("outsider", labelAddress("outsider mint"));
    await putClaimTransaction(outsider, receipt);
    expect((await verify(["--signature", SIGNATURE])).json).toMatchObject({ status: "mismatch", reasons: ["unbound"] });
  });

  it("extractClaims ignores instructions of another program and malformed claim data", async () => {
    const receipt = await putReceipt(usdc);
    await putClaimTransaction(usdc, receipt);
    const tx = chain.transactions.get(SIGNATURE)!;
    expect(extractClaims(tx, PROGRAM)).toHaveLength(1);
    expect(extractClaims(tx, OTHER_PROGRAM)).toHaveLength(0);
    const truncated = { ...tx, instructions: [tx.instructions[0]!, { ...tx.instructions[1]!, data: tx.instructions[1]!.data.subarray(0, 40) }] };
    expect(extractClaims(truncated, PROGRAM)).toHaveLength(0);
  });
});

describe("gates and output hygiene", () => {
  it("refuses the v0 placeholder manifest and a manifest with no devnet deployment, before opening the RPC", async () => {
    const noRpc = () => {
      throw new Error("the RPC must not be opened");
    };
    files.set("/repo/release/manifest.json", manifestText({ programId: V0_PLACEHOLDER_PROGRAM_ID, deployed: false }));
    const placeholder = await verify(["--receipt", labelAddress("x")], io(undefined, noRpc));
    expect(placeholder.code).toBe(2);
    expect(placeholder.stderr).toMatch(/v0 placeholder/);

    files.set("/repo/release/manifest.json", manifestText({ deployed: false }));
    const undeployed = await verify(["--receipt", labelAddress("x")], io(undefined, noRpc));
    expect(undeployed.code).toBe(2);
    expect(undeployed.stderr).toMatch(/no devnet deployment/);
  });

  it("needs exactly one of --receipt / --signature, validates them, and never takes a key", async () => {
    expect((await verify([])).code).toBe(2);
    expect((await verify(["--receipt", labelAddress("a"), "--signature", SIGNATURE])).code).toBe(2);
    const badSig = await verify(["--signature", "not-a-signature"]);
    expect(badSig.code).toBe(2);
    expect(badSig.stderr).toMatch(/strict base58 transaction signature/);
    const keyShaped = getBase58Decoder().decode(Uint8Array.from({ length: 64 }, (_, i) => (i * 3 + 5) % 256));
    const secretAsReceipt = await verify(["--receipt", keyShaped]);
    expect(secretAsReceipt.code).toBe(2);
    expect(secretAsReceipt.stderr.includes(keyShaped)).toBe(false);
    expect((await verify(["--keypair", "/tmp/k.json", "--receipt", labelAddress("a")])).stderr).toMatch(/unknown option --keypair/);
  });

  it("never prints the RPC URL, from the env or from --rpc-url, even when an error quotes it", async () => {
    const receipt = await putReceipt(usdc);
    const host = new URL(RPC_URL).hostname;
    const failing = io({ SOLANA_RPC_URL: RPC_URL }, () => {
      throw new Error(`fetch failed: getaddrinfo ENOTFOUND ${host} (${RPC_URL})`);
    });
    const failed = await verify(["--receipt", receipt], failing);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toMatch(/<rpc-url>/);
    for (const text of [failed.stdout, failed.stderr]) {
      expect(text.includes(host)).toBe(false);
      expect(text.includes("key-ZyXw9876543210")).toBe(false);
    }

    const flagUrl = "https://flag-rpc.example.invalid/v1/flagpath0042zz/";
    const viaFlag = await verify(["--receipt", receipt, "--rpc-url", flagUrl], io({}));
    expect(viaFlag.code).toBe(0);
    expect(`${viaFlag.stdout}${viaFlag.stderr}`.includes("flagpath0042zz")).toBe(false);

    const none = await verify(["--receipt", receipt], io({}));
    expect(none.code).toBe(2);
    expect(none.stderr).toMatch(/set SOLANA_RPC_URL or pass --rpc-url/);
  });
});
