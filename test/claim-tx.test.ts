import {
  address,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  isSignerRole,
  isWritableRole,
  signTransaction,
  type Address,
} from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildClaimSimulationTransaction,
  buildClaimTransaction,
  capPriorityPrice,
  claimComputeUnitCap,
  claimComputeUnitLimitFromSimulation,
  ClaimTransactionError,
  computeClaimComputeUnitLimit,
  DEFAULT_PRIORITY_FEE_CAP_MICROLAMPORTS,
  priorityPriceFromRecentFees,
  type ClaimTransactionInput,
} from "../src/claim-tx.ts";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  USDC_MINT,
  V0_PLACEHOLDER_PROGRAM_ID,
} from "../src/clusters.ts";
import {
  CLAIM_DISCRIMINATOR,
  getClaimInstructionDataEncoder,
} from "../src/generated/instructions/claim.ts";
import { GOGOCASH_CASHBACK_PROGRAM_ADDRESS } from "../src/generated/programs/gogocashCashback.ts";
import { findVaultPda, payoutIdFromHex } from "../src/program.ts";
import { checkClaimWireForRelease } from "../src/wire.ts";
import { IDL, TEST_BLOCKHASH, TEST_LAST_VALID_BLOCK_HEIGHT, throwawayKey, vectorClaimInput, type TestKey } from "./tx-helpers.ts";
import { CLAIM_DATA_VECTOR, fromHex, hex, PDA_VECTORS, TEST_SIGNER_1 } from "./vectors.ts";

let payer: TestKey;
let claimAuthority: TestKey;
let input: ClaimTransactionInput;

beforeAll(async () => {
  payer = await throwawayKey("fee payer");
  claimAuthority = await throwawayKey("claim authority");
  input = vectorClaimInput({ payer: payer.address, claimAuthority: claimAuthority.address });
});

function decodeMessage(messageBytes: Uint8Array) {
  const message = getCompiledTransactionMessageDecoder().decode(messageBytes);
  if (message.version !== 0) throw new Error(`expected a v0 message, got ${String(message.version)}`);
  return message;
}

function expectClaimError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ClaimTransactionError);
    expect((error as ClaimTransactionError).code).toBe(code);
    return;
  }
  throw new Error(`expected ClaimTransactionError ${code}`);
}

async function expectClaimErrorAsync(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(ClaimTransactionError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe("claim instruction data (section 3.3)", () => {
  it("the generated encoder reproduces the claim data vector byte for byte", () => {
    const data = getClaimInstructionDataEncoder().encode({
      payoutId: payoutIdFromHex(CLAIM_DATA_VECTOR.payoutIdHex),
      amount: CLAIM_DATA_VECTOR.amount,
      expiresAt: CLAIM_DATA_VECTOR.expiresAt,
    });
    expect(hex(Uint8Array.from(data))).toBe(CLAIM_DATA_VECTOR.hex);
    expect(data.length).toBe(56);
    expect(hex(Uint8Array.from(CLAIM_DISCRIMINATOR))).toBe("3ec6d6c1d59f6cd2");
  });

  it("the built transaction's claim instruction carries the vector data", async () => {
    const built = await buildClaimTransaction({ ...input, simulatedUnits: 40_000 });
    const claim = built.instructions[3];
    expect(hex(Uint8Array.from(claim?.data ?? []))).toBe(CLAIM_DATA_VECTOR.hex);
  });
});

describe("claim accounts (section 3.3.2 and the IDL)", () => {
  it("account order, signer and writable flags match the IDL exactly", async () => {
    const built = await buildClaimTransaction({ ...input, simulatedUnits: 40_000 });
    const claim = built.instructions[3];
    const idlClaim = IDL.instructions.find((ix) => ix.name === "claim");
    expect(idlClaim).toBeDefined();
    const metas = claim?.accounts ?? [];
    expect(metas.map((meta) => meta.address)).toEqual([
      PDA_VECTORS.devnet.vault.address,
      PDA_VECTORS.devnet.receipt.address,
      USDC_MINT.devnet,
      PDA_VECTORS.devnet.vaultAta,
      TEST_SIGNER_1,
      PDA_VECTORS.devnet.recipientAta,
      claimAuthority.address,
      payer.address,
      TOKEN_PROGRAM_ADDRESS,
      SYSTEM_PROGRAM_ADDRESS,
    ]);
    expect(idlClaim?.accounts.map((account) => account.name)).toEqual([
      "vault",
      "receipt",
      "mint",
      "vault_token_account",
      "recipient",
      "recipient_token_account",
      "claim_authority",
      "payer",
      "token_program",
      "system_program",
    ]);
    expect(metas.length).toBe(idlClaim?.accounts.length);
    idlClaim?.accounts.forEach((account, index) => {
      const meta = metas[index];
      expect({ name: account.name, signer: isSignerRole(meta!.role), writable: isWritableRole(meta!.role) }).toEqual({
        name: account.name,
        signer: account.signer === true,
        writable: account.writable === true,
      });
      if (account.address !== undefined) expect(meta?.address).toBe(account.address);
    });
    expect(built.accounts).toEqual({
      vault: PDA_VECTORS.devnet.vault.address,
      receipt: PDA_VECTORS.devnet.receipt.address,
      vaultTokenAccount: PDA_VECTORS.devnet.vaultAta,
      recipientTokenAccount: PDA_VECTORS.devnet.recipientAta,
    });
  });

  it("the IDL discriminators equal the section 3.3 table", () => {
    const byName = Object.fromEntries(IDL.instructions.map((ix) => [ix.name, hex(Uint8Array.from(ix.discriminator))]));
    expect(byName).toEqual({
      initialize: "afaf6d1f0d989bed",
      claim: "3ec6d6c1d59f6cd2",
      pause: "d316ddfb4a79c12f",
      unpause: "a99004260a8dbcff",
      update_config: "1d9efcbf0a53db63",
      propose_admin: "79d6c7d4572775ea",
      accept_admin: "702a2d5a74b50daa",
      withdraw: "b712469c946da122",
    });
  });

  it("uses the programAddress it is given, never the generated default", async () => {
    const other = (await throwawayKey("another program id")).address;
    const otherVault = (await findVaultPda({ programAddress: other, mint: USDC_MINT.devnet })).address;
    const built = await buildClaimTransaction({
      ...input,
      programAddress: other,
      vault: otherVault,
      simulatedUnits: 40_000,
    });
    expect(built.instructions[3]?.programAddress).toBe(other);
    expect(built.instructions[3]?.programAddress).not.toBe(GOGOCASH_CASHBACK_PROGRAM_ADDRESS);
    const message = decodeMessage(Uint8Array.from(built.transaction.messageBytes));
    expect(message.staticAccounts).toContain(other);
    expect(message.staticAccounts).not.toContain(V0_PLACEHOLDER_PROGRAM_ID);
  });

  it("refuses a vault that is not the PDA of the mint under programAddress", async () => {
    const other = (await throwawayKey("another program id")).address;
    await expectClaimErrorAsync(
      buildClaimTransaction({ ...input, programAddress: other, simulatedUnits: 40_000 }),
      "vault_mismatch",
    );
    await expectClaimErrorAsync(
      buildClaimTransaction({ ...input, mint: USDC_MINT.mainnet, simulatedUnits: 40_000 }),
      "vault_mismatch",
    );
  });
});

describe("transaction shape (section 9.1 step 5)", () => {
  it("is a v0 message with no address lookup table and the blockhash lifetime", async () => {
    const built = await buildClaimTransaction({ ...input, simulatedUnits: 40_000 });
    const messageBytes = Uint8Array.from(built.transaction.messageBytes);
    expect(messageBytes[0]).toBe(0x80); // version prefix: v0
    const message = decodeMessage(messageBytes);
    expect(message.version).toBe(0);
    expect(message.addressTableLookups ?? []).toEqual([]);
    expect(message.lifetimeToken).toBe(TEST_BLOCKHASH);
    expect(built.lifetime).toEqual({ blockhash: TEST_BLOCKHASH, lastValidBlockHeight: TEST_LAST_VALID_BLOCK_HEIGHT });
    expect(built.transaction.lifetimeConstraint).toEqual({
      blockhash: TEST_BLOCKHASH,
      lastValidBlockHeight: TEST_LAST_VALID_BLOCK_HEIGHT,
    });
  });

  it("orders the instructions: CU limit, CU price, ATA idempotent, then claim", async () => {
    const built = await buildClaimTransaction({ ...input, simulatedUnits: 40_000 });
    const message = decodeMessage(Uint8Array.from(built.transaction.messageBytes));
    const programs = message.instructions.map((ix) => message.staticAccounts[ix.programAddressIndex]);
    expect(programs).toEqual([
      COMPUTE_BUDGET_PROGRAM_ADDRESS,
      COMPUTE_BUDGET_PROGRAM_ADDRESS,
      ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
      V0_PLACEHOLDER_PROGRAM_ID,
    ]);
    const [limit, price, ata, claim] = message.instructions;
    // SetComputeUnitLimit = 2 + u32 LE; 40,000 x 1.15 = 46,000.
    expect(hex(Uint8Array.from(limit?.data ?? []))).toBe("02" + "b0b30000");
    // SetComputeUnitPrice = 3 + u64 LE.
    expect(hex(Uint8Array.from(price?.data ?? []))).toBe("03" + "8813000000000000");
    // CreateIdempotent = 1; accounts payer, ata, owner, mint, system, token.
    expect(hex(Uint8Array.from(ata?.data ?? []))).toBe("01");
    expect(ata?.accountIndices?.map((i) => message.staticAccounts[i])).toEqual([
      payer.address,
      PDA_VECTORS.devnet.recipientAta,
      TEST_SIGNER_1,
      USDC_MINT.devnet,
      SYSTEM_PROGRAM_ADDRESS,
      TOKEN_PROGRAM_ADDRESS,
    ]);
    expect(hex(Uint8Array.from(claim?.data ?? []))).toBe(CLAIM_DATA_VECTOR.hex);
    expect(built.computeUnitLimit).toBe(46_000);
    expect(built.computeUnitPriceMicroLamports).toBe(5_000n);
  });

  it("has the fee payer first and the claim authority as the only other signer", async () => {
    const built = await buildClaimTransaction({ ...input, simulatedUnits: 40_000 });
    const message = decodeMessage(Uint8Array.from(built.transaction.messageBytes));
    expect(message.header.numSignerAccounts).toBe(2);
    expect(message.header.numReadonlySignerAccounts).toBe(1);
    expect(message.staticAccounts.slice(0, 2)).toEqual([payer.address, claimAuthority.address]);
    expect(Object.keys(built.transaction.signatures)).toEqual([payer.address, claimAuthority.address]);
    expect(Object.values(built.transaction.signatures)).toEqual([null, null]);
    expect(built.signers).toEqual([payer.address, claimAuthority.address]);
    // The unsigned wire carries all-zero signatures (the simulation form).
    expect(built.unsignedWire[0]).toBe(2);
    expect(built.unsignedWire.subarray(1, 129).every((byte) => byte === 0)).toBe(true);
  });

  it("allows payer = claim authority as a single signer", async () => {
    const built = await buildClaimTransaction({
      ...input,
      claimAuthority: payer.address,
      simulatedUnits: 40_000,
    });
    const message = decodeMessage(Uint8Array.from(built.transaction.messageBytes));
    expect(message.header.numSignerAccounts).toBe(1);
    expect(message.staticAccounts[0]).toBe(payer.address);
    expect(built.signers).toEqual([payer.address]);
  });

  it("the simulation transaction uses the cap as its limit and the same instruction list", async () => {
    const exists = await buildClaimSimulationTransaction(input);
    expect(exists.computeUnitLimit).toBe(60_000);
    const missing = await buildClaimSimulationTransaction({ ...input, recipientAtaExists: false });
    expect(missing.computeUnitLimit).toBe(90_000);
    const final = await buildClaimTransaction({ ...input, simulatedUnits: 40_000 });
    expect(exists.instructions.slice(1).map((ix) => hex(Uint8Array.from(ix.data ?? [])))).toEqual(
      final.instructions.slice(1).map((ix) => hex(Uint8Array.from(ix.data ?? []))),
    );
  });

  it("caps the priority price in the built transaction", async () => {
    const built = await buildClaimTransaction({
      ...input,
      priorityPriceMicroLamports: 250_000n,
      priorityPriceCapMicroLamports: 100_000n,
      simulatedUnits: 40_000,
    });
    expect(built.computeUnitPriceMicroLamports).toBe(100_000n);
    expect(hex(Uint8Array.from(built.instructions[1]?.data ?? []))).toBe("03" + "a086010000000000");
  });

  it("refuses invalid inputs before building", async () => {
    const cases: [Partial<ClaimTransactionInput>, string][] = [
      [{ payoutId: new Uint8Array(32) }, "invalid_input"],
      [{ payoutId: new Uint8Array(31).fill(1) }, "invalid_input"],
      [{ amount: 0n }, "invalid_input"],
      [{ amount: 1n << 64n }, "invalid_input"],
      [{ expiresAt: 1n << 63n }, "invalid_input"],
      [{ blockhash: "not-a-blockhash" }, "invalid_input"],
      [{ lastValidBlockHeight: -1n }, "invalid_input"],
      [{ programAddress: "not an address" as Address }, "invalid_input"],
      [{ priorityPriceMicroLamports: -1n }, "invalid_input"],
      [{ recipient: payer.address }, "recipient_conflict"],
      [{ recipient: claimAuthority.address }, "recipient_conflict"],
      [{ recipient: address(PDA_VECTORS.devnet.vault.address) }, "recipient_conflict"],
    ];
    for (const [patch, code] of cases) {
      await expectClaimErrorAsync(buildClaimTransaction({ ...input, ...patch, simulatedUnits: 40_000 }), code);
    }
    await expectClaimErrorAsync(buildClaimTransaction({ ...input, simulatedUnits: 0 }), "invalid_input");
    await expectClaimErrorAsync(buildClaimTransaction({ ...input, simulatedUnits: 60_001 }), "compute_units_exceed_cap");
  });
});

describe("compute-unit limit (section 9.1 step 5.1)", () => {
  it("is ceil(units x 115 / 100) below the cap", () => {
    const limit = (simulatedUnits: bigint | number, recipientAtaExists = true) =>
      computeClaimComputeUnitLimit({ simulatedUnits, recipientAtaExists });
    expect(limit(1)).toBe(2);
    expect(limit(20)).toBe(23);
    expect(limit(40_000)).toBe(46_000);
    expect(limit(40_001)).toBe(46_002);
    expect(limit(52_173)).toBe(59_999);
    expect(limit(52_173n)).toBe(59_999);
    expect(limit(70_000, false)).toBe(80_500);
  });

  it("caps at 60,000 when the recipient ATA exists", () => {
    expect(claimComputeUnitCap(true)).toBe(60_000);
    expect(computeClaimComputeUnitLimit({ simulatedUnits: 52_174, recipientAtaExists: true })).toBe(60_000);
    expect(computeClaimComputeUnitLimit({ simulatedUnits: 60_000, recipientAtaExists: true })).toBe(60_000);
    expectClaimError(
      () => computeClaimComputeUnitLimit({ simulatedUnits: 60_001, recipientAtaExists: true }),
      "compute_units_exceed_cap",
    );
  });

  it("caps at 90,000 when the ATA is created in the same transaction", () => {
    expect(claimComputeUnitCap(false)).toBe(90_000);
    expect(computeClaimComputeUnitLimit({ simulatedUnits: 78_261, recipientAtaExists: false })).toBe(90_000);
    expect(computeClaimComputeUnitLimit({ simulatedUnits: 90_000, recipientAtaExists: false })).toBe(90_000);
    expectClaimError(
      () => computeClaimComputeUnitLimit({ simulatedUnits: 90_001, recipientAtaExists: false }),
      "compute_units_exceed_cap",
    );
  });

  it("refuses non-positive, fractional or non-numeric units", () => {
    for (const simulatedUnits of [0, -1, 1.5, Number.NaN, 0n, -5n, "40000"] as unknown[]) {
      expectClaimError(
        () => computeClaimComputeUnitLimit({ simulatedUnits: simulatedUnits as number, recipientAtaExists: true }),
        "invalid_input",
      );
    }
    expectClaimError(() => claimComputeUnitCap("yes" as unknown as boolean), "invalid_input");
  });

  it("reads the limit from a simulation result", () => {
    expect(claimComputeUnitLimitFromSimulation({ err: null, unitsConsumed: 40_000n }, { recipientAtaExists: true })).toEqual({
      ok: true,
      simulatedUnits: 40_000n,
      computeUnitLimit: 46_000,
    });
    const err = { InstructionError: [3, { Custom: 6012 }] };
    expect(claimComputeUnitLimitFromSimulation({ err, unitsConsumed: 12_000n }, { recipientAtaExists: true })).toEqual({
      ok: false,
      reason: "simulation_error",
      err,
    });
    expect(claimComputeUnitLimitFromSimulation({ err: null }, { recipientAtaExists: true })).toEqual({
      ok: false,
      reason: "units_missing",
    });
    expect(claimComputeUnitLimitFromSimulation({ err: null, unitsConsumed: 0n }, { recipientAtaExists: true })).toEqual({
      ok: false,
      reason: "units_missing",
    });
    expect(claimComputeUnitLimitFromSimulation({ err: null, unitsConsumed: 61_000n }, { recipientAtaExists: true })).toEqual({
      ok: false,
      reason: "exceeds_cap",
      simulatedUnits: 61_000n,
      cap: 60_000,
    });
    expect(claimComputeUnitLimitFromSimulation({ err: null, unitsConsumed: 61_000 }, { recipientAtaExists: false })).toEqual({
      ok: true,
      simulatedUnits: 61_000n,
      computeUnitLimit: 70_150,
    });
  });
});

describe("compute-unit price (section 9.1 step 5.2)", () => {
  it("caps the price", () => {
    expect(capPriorityPrice({ priceMicroLamports: 5_000n, capMicroLamports: 100_000n })).toBe(5_000n);
    expect(capPriorityPrice({ priceMicroLamports: 100_000n, capMicroLamports: 100_000n })).toBe(100_000n);
    expect(capPriorityPrice({ priceMicroLamports: 100_001n, capMicroLamports: 100_000n })).toBe(100_000n);
    expect(capPriorityPrice({ priceMicroLamports: 7n, capMicroLamports: 0n })).toBe(0n);
    expectClaimError(() => capPriorityPrice({ priceMicroLamports: -1n, capMicroLamports: 1n }), "invalid_input");
    expectClaimError(
      () => capPriorityPrice({ priceMicroLamports: 1n, capMicroLamports: 5 as unknown as bigint }),
      "invalid_input",
    );
    expect(DEFAULT_PRIORITY_FEE_CAP_MICROLAMPORTS).toBe(100_000n);
  });

  it("takes the nearest-rank 75th percentile of recent fees, capped", () => {
    const fees = (values: (bigint | number)[]) => values.map((prioritizationFee) => ({ prioritizationFee }));
    expect(priorityPriceFromRecentFees([])).toBe(0n);
    expect(priorityPriceFromRecentFees(fees([42n]))).toBe(42n);
    expect(priorityPriceFromRecentFees(fees([8n, 1n, 7n, 2n, 6n, 3n, 5n, 4n]))).toBe(6n);
    expect(priorityPriceFromRecentFees(fees([1, 2, 3, 4, 5]))).toBe(4n);
    expect(priorityPriceFromRecentFees(fees([0n, 0n, 0n, 500_000n]))).toBe(0n);
    expect(priorityPriceFromRecentFees(fees([200_000n, 300_000n, 400_000n, 500_000n]))).toBe(100_000n);
    expect(priorityPriceFromRecentFees(fees([200_000n, 300_000n]), 250_000n)).toBe(250_000n);
    expectClaimError(() => priorityPriceFromRecentFees(fees([1.5])), "invalid_input");
  });
});

describe("round trip: build, sign with throwaway keys, decode the wire", () => {
  it("returns the same tuple from the signed wire", async () => {
    const built = await buildClaimTransaction({ ...input, simulatedUnits: 40_000 });
    const signed = await signTransaction([payer.keyPair, claimAuthority.keyPair], built.transaction);
    const wireBase64 = getBase64EncodedWireTransaction(signed);
    const signature = getSignatureFromTransaction(signed);
    const result = checkClaimWireForRelease(wireBase64, {
      programAddress: V0_PLACEHOLDER_PROGRAM_ID,
      signature,
      blockhash: TEST_BLOCKHASH,
      payoutIdHex: CLAIM_DATA_VECTOR.payoutIdHex,
      amount: CLAIM_DATA_VECTOR.amount,
      vault: address(PDA_VECTORS.devnet.vault.address),
    });
    expect(result).toEqual({
      ok: true,
      tuple: {
        signature,
        blockhash: TEST_BLOCKHASH,
        feePayer: payer.address,
        claimAuthority: claimAuthority.address,
        vault: PDA_VECTORS.devnet.vault.address,
        recipient: TEST_SIGNER_1,
        payoutId: fromHex(CLAIM_DATA_VECTOR.payoutIdHex),
        payoutIdHex: CLAIM_DATA_VECTOR.payoutIdHex,
        amount: CLAIM_DATA_VECTOR.amount,
        expiresAt: CLAIM_DATA_VECTOR.expiresAt,
      },
    });
  });
});
