/**
 * PDAs and account decoders for the `gogocash_cashback` program,
 * docs/CONTRACT.md sections 2.4 and 3.2.
 *
 * Every function takes `programAddress` explicitly. There is no default
 * program id anywhere in this SDK: callers pass
 * `release/manifest.json.programIds[cluster]` (section 2.4).
 */
import {
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
} from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import { BPF_LOADER_UPGRADEABLE_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "./clusters.ts";

export const VAULT_ACCOUNT_SIZE = 324;
export const RECEIPT_ACCOUNT_SIZE = 89;

/** `sha256("account:Vault")[0..8]` = `d308e82b02987577`. */
export const VAULT_DISCRIMINATOR: Uint8Array = Uint8Array.of(211, 8, 232, 43, 2, 152, 117, 119);
/** `sha256("account:Receipt")[0..8]` = `279a496a50669199`. */
export const RECEIPT_DISCRIMINATOR: Uint8Array = Uint8Array.of(39, 154, 73, 106, 80, 102, 145, 153);

/** Layout version the v0 decoder understands (Vault offset 8). */
export const VAULT_LAYOUT_VERSION = 1;

export type Pda = { address: Address; bump: number };

const addressEncoder = getAddressEncoder();
const addressDecoder = getAddressDecoder();

const PAYOUT_ID_HEX = /^[0-9a-f]{64}$/;

/**
 * Parses a payout id from its API / DB form: exactly 64 lowercase hex
 * characters (section 5.1). Uppercase or mixed case is rejected, never
 * normalized.
 */
export function payoutIdFromHex(hex: string): Uint8Array {
  if (typeof hex !== "string" || !PAYOUT_ID_HEX.test(hex)) {
    throw new TypeError("payout_id must be exactly 64 lowercase hex characters.");
  }
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

/** Renders 32 payout id bytes as 64 lowercase hex characters. */
export function payoutIdToHex(payoutId: Uint8Array): string {
  if (payoutId.length !== 32) {
    throw new TypeError("payout_id must be exactly 32 bytes.");
  }
  return Buffer.from(payoutId).toString("hex");
}

function toPda([pdaAddress, bump]: readonly [Address, number]): Pda {
  return { address: pdaAddress, bump };
}

/** The program's ProgramData account: `find_program_address([program_id], loader-v3)`. */
export async function findProgramDataAddress(programAddress: Address): Promise<Pda> {
  return toPda(
    await getProgramDerivedAddress({
      programAddress: BPF_LOADER_UPGRADEABLE_ADDRESS,
      seeds: [addressEncoder.encode(programAddress)],
    }),
  );
}

/** Vault PDA `["vault", mint]` under `programAddress`. */
export async function findVaultPda(input: {
  programAddress: Address;
  mint: Address;
}): Promise<Pda> {
  return toPda(
    await getProgramDerivedAddress({
      programAddress: input.programAddress,
      seeds: ["vault", addressEncoder.encode(input.mint)],
    }),
  );
}

/**
 * Receipt PDA `["receipt", vault, payout_id]` under `programAddress`. The
 * seed is the raw 32 payout id bytes, in order (section 5.1).
 */
export async function findReceiptPda(input: {
  programAddress: Address;
  vault: Address;
  payoutId: Uint8Array;
}): Promise<Pda> {
  if (input.payoutId.length !== 32) {
    throw new TypeError("payout_id must be exactly 32 bytes.");
  }
  return toPda(
    await getProgramDerivedAddress({
      programAddress: input.programAddress,
      seeds: ["receipt", addressEncoder.encode(input.vault), input.payoutId],
    }),
  );
}

/**
 * Canonical associated token account of `owner` for `mint` under classic SPL
 * Token. Token-2022 is refused by the contract, so there is no token program
 * parameter. Used for the vault token account and the recipient ATA.
 */
export async function findClassicAta(input: { owner: Address; mint: Address }): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({
    owner: input.owner,
    mint: input.mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return ata;
}

export type Vault = {
  version: number;
  bump: number;
  paused: boolean;
  decimals: number;
  mint: Address;
  vaultTokenAccount: Address;
  admin: Address;
  /** The default key (`11111111111111111111111111111111`) means none. */
  pendingAdmin: Address;
  guardian: Address;
  claimAuthority: Address;
  maxPerClaim: bigint;
  maxPerDay: bigint;
  currentDay: bigint;
  claimedToday: bigint;
  totalClaimed: bigint;
  claimCount: bigint;
  totalWithdrawn: bigint;
  /** 64 bytes, zero at initialize, not interpreted in v0. */
  reserved: Uint8Array;
};

export type Receipt = {
  bump: number;
  payoutId: Uint8Array;
  /** `payoutId` as 64 lowercase hex characters. */
  payoutIdHex: string;
  recipient: Address;
  amount: bigint;
  claimedAt: bigint;
};

export class AccountDecodeError extends Error {
  override name = "AccountDecodeError";
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function readBool(data: Uint8Array, offset: number, field: string): boolean {
  const value = data[offset];
  if (value === 0) return false;
  if (value === 1) return true;
  throw new AccountDecodeError(`${field} must be 0 or 1, got ${String(value)}.`);
}

function readU8(data: Uint8Array, offset: number): number {
  const value = data[offset];
  if (value === undefined) throw new AccountDecodeError(`offset ${offset} is out of range.`);
  return value;
}

function readAddress(data: Uint8Array, offset: number): Address {
  return addressDecoder.decode(data.subarray(offset, offset + 32));
}

/** True if `data` starts with the Vault discriminator. */
export function isVaultAccount(data: Uint8Array): boolean {
  return data.length >= 8 && bytesEqual(data.subarray(0, 8), VAULT_DISCRIMINATOR);
}

/** True if `data` starts with the Receipt discriminator. */
export function isReceiptAccount(data: Uint8Array): boolean {
  return data.length >= 8 && bytesEqual(data.subarray(0, 8), RECEIPT_DISCRIMINATOR);
}

/**
 * Decodes a Vault account (section 3.2). Requires exactly 324 bytes, the
 * Vault discriminator, layout version 1 and a 0/1 `paused` byte.
 */
export function decodeVault(data: Uint8Array): Vault {
  if (data.length !== VAULT_ACCOUNT_SIZE) {
    throw new AccountDecodeError(`Vault must be ${VAULT_ACCOUNT_SIZE} bytes, got ${data.length}.`);
  }
  if (!isVaultAccount(data)) {
    throw new AccountDecodeError("Vault discriminator mismatch.");
  }
  const version = readU8(data, 8);
  if (version !== VAULT_LAYOUT_VERSION) {
    throw new AccountDecodeError(`Unknown Vault layout version ${version}.`);
  }
  const dv = view(data);
  return {
    version,
    bump: readU8(data, 9),
    paused: readBool(data, 10, "paused"),
    decimals: readU8(data, 11),
    mint: readAddress(data, 12),
    vaultTokenAccount: readAddress(data, 44),
    admin: readAddress(data, 76),
    pendingAdmin: readAddress(data, 108),
    guardian: readAddress(data, 140),
    claimAuthority: readAddress(data, 172),
    maxPerClaim: dv.getBigUint64(204, true),
    maxPerDay: dv.getBigUint64(212, true),
    currentDay: dv.getBigInt64(220, true),
    claimedToday: dv.getBigUint64(228, true),
    totalClaimed: dv.getBigUint64(236, true),
    claimCount: dv.getBigUint64(244, true),
    totalWithdrawn: dv.getBigUint64(252, true),
    reserved: data.slice(260, 324),
  };
}

/**
 * Decodes a Receipt account (section 3.2). Requires exactly 89 bytes and the
 * Receipt discriminator. Owner and bump checks belong to the receipt
 * verification of section 3.8 (see verify-receipt.ts).
 */
export function decodeReceipt(data: Uint8Array): Receipt {
  if (data.length !== RECEIPT_ACCOUNT_SIZE) {
    throw new AccountDecodeError(
      `Receipt must be ${RECEIPT_ACCOUNT_SIZE} bytes, got ${data.length}.`,
    );
  }
  if (!isReceiptAccount(data)) {
    throw new AccountDecodeError("Receipt discriminator mismatch.");
  }
  const dv = view(data);
  const payoutId = data.slice(9, 41);
  return {
    bump: readU8(data, 8),
    payoutId,
    payoutIdHex: payoutIdToHex(payoutId),
    recipient: readAddress(data, 41),
    amount: dv.getBigUint64(73, true),
    claimedAt: dv.getBigInt64(81, true),
  };
}
