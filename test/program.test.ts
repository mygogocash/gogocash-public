import { createHash } from "node:crypto";
import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { SYSTEM_PROGRAM_ADDRESS } from "../src/clusters.ts";
import {
  AccountDecodeError,
  decodeReceipt,
  decodeVault,
  findClassicAta,
  findProgramDataAddress,
  findReceiptPda,
  findVaultPda,
  payoutIdFromHex,
  payoutIdToHex,
  RECEIPT_DISCRIMINATOR,
  VAULT_DISCRIMINATOR,
} from "../src/program.ts";
import {
  PAYOUT_ID_HEX,
  PDA_VECTORS,
  PLACEHOLDER_PROGRAM_ID,
  PROGRAM_DATA,
  RECEIPT_HEX,
  TEST_SIGNER_1,
  VAULT_V1_HEX,
  contractTestKey,
  fromHex,
  hex,
  rawPublicKey,
} from "./vectors.ts";
import { encodeBase58 } from "../src/base58.ts";

const programAddress = address(PLACEHOLDER_PROGRAM_ID);

function discriminator(preimage: string): string {
  return createHash("sha256").update(preimage).digest().subarray(0, 8).toString("hex");
}

describe("discriminators (contract section 3.1 / 3.2)", () => {
  it("are sha256(account:<Name>)[0..8]", () => {
    expect(hex(VAULT_DISCRIMINATOR)).toBe(discriminator("account:Vault"));
    expect(hex(VAULT_DISCRIMINATOR)).toBe("d308e82b02987577");
    expect(hex(RECEIPT_DISCRIMINATOR)).toBe(discriminator("account:Receipt"));
    expect(hex(RECEIPT_DISCRIMINATOR)).toBe("279a496a50669199");
  });
});

describe("PDAs (contract section 2.4, placeholder program id)", () => {
  it("derives ProgramData under loader-v3", async () => {
    expect(await findProgramDataAddress(programAddress)).toEqual(PROGRAM_DATA);
  });

  for (const cluster of ["devnet", "mainnet"] as const) {
    const v = PDA_VECTORS[cluster];
    it(`derives the ${cluster} vault, vault ATA, receipt and recipient ATA`, async () => {
      const mint = address(v.mint);
      const vault = await findVaultPda({ programAddress, mint });
      expect(vault).toEqual(v.vault);
      expect(await findClassicAta({ owner: vault.address, mint })).toBe(v.vaultAta);
      const receipt = await findReceiptPda({
        programAddress,
        vault: vault.address,
        payoutId: payoutIdFromHex(PAYOUT_ID_HEX),
      });
      expect(receipt).toEqual(v.receipt);
      expect(await findClassicAta({ owner: address(TEST_SIGNER_1), mint })).toBe(v.recipientAta);
    });
  }

  it("every PDA depends on the program id passed in (never a default)", async () => {
    const mint = address(PDA_VECTORS.devnet.mint);
    const other = await findVaultPda({ programAddress: SYSTEM_PROGRAM_ADDRESS, mint });
    expect(other.address).not.toBe(PDA_VECTORS.devnet.vault.address);
  });

  it("refuses a payout id that is not 32 bytes", async () => {
    await expect(
      findReceiptPda({ programAddress, vault: address(PDA_VECTORS.devnet.vault.address), payoutId: new Uint8Array(31) }),
    ).rejects.toThrow(TypeError);
  });

  it("test key 1 is the public key of seed sha256('gogocash contract v0 test key 1')", () => {
    expect(encodeBase58(rawPublicKey(contractTestKey(1)))).toBe(TEST_SIGNER_1);
  });
});

describe("payout id encoding (contract section 5.1)", () => {
  it("accepts 64 lowercase hex and round-trips", () => {
    const bytes = payoutIdFromHex(PAYOUT_ID_HEX);
    expect(bytes.length).toBe(32);
    expect(bytes[0]).toBe(0xc6);
    expect(payoutIdToHex(bytes)).toBe(PAYOUT_ID_HEX);
  });

  it("rejects upper or mixed case, wrong length and non-hex", () => {
    for (const bad of [
      PAYOUT_ID_HEX.toUpperCase(),
      `C${PAYOUT_ID_HEX.slice(1)}`,
      PAYOUT_ID_HEX.slice(2),
      `${PAYOUT_ID_HEX}00`,
      `${PAYOUT_ID_HEX.slice(1)}g`,
      ` ${PAYOUT_ID_HEX.slice(1)}`,
    ]) {
      expect(() => payoutIdFromHex(bad)).toThrow(TypeError);
    }
    expect(() => payoutIdToHex(new Uint8Array(33))).toThrow(TypeError);
  });
});

describe("Receipt decoder (contract section 3.2 decode vector)", () => {
  it("decodes the reference receipt", () => {
    const receipt = decodeReceipt(fromHex(RECEIPT_HEX));
    expect(receipt.bump).toBe(251);
    expect(receipt.payoutIdHex).toBe(PAYOUT_ID_HEX);
    expect(receipt.recipient).toBe(TEST_SIGNER_1);
    expect(receipt.amount).toBe(3558875n);
    expect(receipt.claimedAt).toBe(1790910270n);
    expect(new Date(Number(receipt.claimedAt) * 1000).toISOString()).toBe("2026-10-02T03:04:30.000Z");
  });

  it("refuses a wrong length or discriminator", () => {
    const bytes = fromHex(RECEIPT_HEX);
    expect(() => decodeReceipt(bytes.subarray(0, 88))).toThrow(AccountDecodeError);
    expect(() => decodeReceipt(Uint8Array.of(...bytes, 0))).toThrow(AccountDecodeError);
    const wrong = Uint8Array.from(bytes);
    wrong[0] = (wrong[0] ?? 0) ^ 1;
    expect(() => decodeReceipt(wrong)).toThrow(/discriminator/);
  });
});

describe("Vault decoder (contract section 3.2 decode vector V1)", () => {
  const bytes = fromHex(VAULT_V1_HEX);

  it("is 324 bytes", () => {
    expect(bytes.length).toBe(324);
  });

  it("decodes the just-initialized vault", () => {
    const vault = decodeVault(bytes);
    expect(vault.version).toBe(1);
    expect(vault.bump).toBe(254);
    expect(vault.paused).toBe(true);
    expect(vault.decimals).toBe(6);
    expect(vault.mint).toBe(PDA_VECTORS.devnet.mint);
    expect(vault.vaultTokenAccount).toBe(PDA_VECTORS.devnet.vaultAta);
    expect(vault.pendingAdmin).toBe("11111111111111111111111111111111");
    expect(vault.maxPerClaim).toBe(5_000_000n);
    expect(vault.maxPerDay).toBe(20_000_000n);
    expect(vault.currentDay).toBe(20728n);
    expect(vault.claimedToday).toBe(0n);
    expect(vault.totalClaimed).toBe(0n);
    expect(vault.claimCount).toBe(0n);
    expect(vault.totalWithdrawn).toBe(0n);
    expect(vault.reserved).toEqual(new Uint8Array(64));
    // Fixture roles: distinct, non-default, and the claim authority differs from admin and guardian.
    const roles = [vault.admin, vault.guardian, vault.claimAuthority];
    expect(new Set(roles).size).toBe(3);
    for (const role of roles) expect(role).not.toBe("11111111111111111111111111111111");
  });

  it("2026-10-02 is UTC day 20728", () => {
    expect(Math.floor(Date.parse("2026-10-02T00:00:00Z") / 86_400_000)).toBe(20728);
  });

  it("refuses a bool byte other than 0 or 1, an unknown version, a wrong size or discriminator", () => {
    const badBool = Uint8Array.from(bytes);
    badBool[10] = 2;
    expect(() => decodeVault(badBool)).toThrow(/paused must be 0 or 1/);
    const badVersion = Uint8Array.from(bytes);
    badVersion[8] = 2;
    expect(() => decodeVault(badVersion)).toThrow(/version/);
    expect(() => decodeVault(bytes.subarray(0, 323))).toThrow(AccountDecodeError);
    expect(() => decodeVault(fromHex(RECEIPT_HEX))).toThrow(AccountDecodeError);
    const badDisc = Uint8Array.from(bytes);
    badDisc[7] = 0;
    expect(() => decodeVault(badDisc)).toThrow(/discriminator/);
  });

  it("decodes from a subarray with a non-zero byte offset", () => {
    const padded = new Uint8Array(400);
    padded.set(bytes, 50);
    expect(decodeVault(padded.subarray(50, 374))).toEqual(decodeVault(bytes));
  });
});
