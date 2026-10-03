/**
 * Loader-v3 (BPF Loader Upgradeable) account decoders, pure.
 *
 * `UpgradeableLoaderState` is bincode: a little-endian u32 variant tag, then
 * the variant's fields. Only the two variants an operator reads are decoded:
 *
 * - `Program { programdata_address: Pubkey }` (tag 2), 36 bytes;
 * - `ProgramData { slot: u64, upgrade_authority_address: Option<Pubkey> }`
 *   (tag 3), a 45-byte header (`Option` = one 0/1 byte plus 32 bytes, always
 *   reserved) followed by the ELF.
 */
import { getAddressDecoder, type Address } from "@solana/kit";
import { BPF_LOADER_UPGRADEABLE_ADDRESS } from "../clusters.ts";

export const LOADER_V3_PROGRAM_TAG = 2;
export const LOADER_V3_PROGRAM_DATA_TAG = 3;
export const LOADER_V3_PROGRAM_SIZE = 36;
export const LOADER_V3_PROGRAM_DATA_HEADER_SIZE = 45;

export class LoaderDecodeError extends Error {
  override name = "LoaderDecodeError";
}

const addressDecoder = getAddressDecoder();

function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

/** Decodes a loader-v3 `Program` account and returns its ProgramData address. */
export function decodeUpgradeableProgram(data: Uint8Array): { programDataAddress: Address } {
  if (data.length !== LOADER_V3_PROGRAM_SIZE) {
    throw new LoaderDecodeError(`a loader-v3 Program account is ${LOADER_V3_PROGRAM_SIZE} bytes, got ${data.length}.`);
  }
  const tag = view(data).getUint32(0, true);
  if (tag !== LOADER_V3_PROGRAM_TAG) throw new LoaderDecodeError(`expected the Program variant (2), got ${tag}.`);
  return { programDataAddress: addressDecoder.decode(data.subarray(4, 36)) };
}

/** Decodes the header of a loader-v3 `ProgramData` account. */
export function decodeProgramData(data: Uint8Array): { slot: bigint; upgradeAuthority: Address | null } {
  if (data.length < LOADER_V3_PROGRAM_DATA_HEADER_SIZE) {
    throw new LoaderDecodeError("a loader-v3 ProgramData account is shorter than its 45-byte header.");
  }
  const dv = view(data);
  const tag = dv.getUint32(0, true);
  if (tag !== LOADER_V3_PROGRAM_DATA_TAG) throw new LoaderDecodeError(`expected the ProgramData variant (3), got ${tag}.`);
  const slot = dv.getBigUint64(4, true);
  const option = data[12];
  if (option === 0) return { slot, upgradeAuthority: null };
  if (option !== 1) throw new LoaderDecodeError("the upgrade authority Option tag must be 0 or 1.");
  return { slot, upgradeAuthority: addressDecoder.decode(data.subarray(13, 45)) };
}

export type DeployedProgram = {
  readonly programDataAddress: Address;
  readonly deploySlot: bigint;
  readonly upgradeAuthority: Address | null;
};

export type ProgramAccountView = {
  readonly owner: string;
  readonly executable: boolean;
  readonly data: Uint8Array;
};

/**
 * Section 2.4: a cluster is usable only if the program account exists, is
 * executable and is owned by loader-v3. Returns the problem, or `null`.
 */
export function programAccountProblem(account: ProgramAccountView | null): string | null {
  if (account === null) return "the program account does not exist on this cluster.";
  if (account.owner !== BPF_LOADER_UPGRADEABLE_ADDRESS) return "the program account is not owned by loader-v3.";
  if (account.executable !== true) return "the program account is not executable.";
  return null;
}
