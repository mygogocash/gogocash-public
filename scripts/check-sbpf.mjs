// Asserts that a Solana program artifact is an SBPFv3 ELF.
//
// Usage:
//   node scripts/check-sbpf.mjs [--expect-security-txt] <path-to-.so>
//   node scripts/check-sbpf.mjs --self-test
//
// Checks, in order:
//   1. the ELF magic bytes (0x7f 'E' 'L' 'F');
//   2. EI_CLASS == ELFCLASS64 (2) and EI_DATA == ELFDATA2LSB (1, little-endian);
//   3. e_flags, the u32 at byte offset 0x30 of an ELF64 header, equals 3.
//      The SBF loader reads the SBPF version from that field
//      (solana-sbpf 0.21.1 src/elf.rs get_sbpf_version: 3 => SBPFVersion::V3).
//   4. With --expect-security-txt: the solana-security-txt BEGIN marker is
//      present in the file.
//
// Exit codes: 0 pass, 1 a check failed, 2 bad usage. No dependencies.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import process from "node:process";

const EXPECTED_SBPF_VERSION = 3;
const ELF64_HEADER_SIZE = 64;
const E_MACHINE_OFFSET = 0x12;
const E_FLAGS_OFFSET = 0x30;
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;
// The exact bytes solana-security-txt 1.1.3 writes first (SECURITY_TXT_BEGIN).
const SECURITY_TXT_BEGIN = Buffer.from("=======BEGIN SECURITY.TXT V1=======\0", "latin1");

class CheckError extends Error {}

/** Parses the ELF64 little-endian header fields this check needs. */
function readElfHeader(bytes) {
  if (bytes.length < ELF64_HEADER_SIZE) {
    throw new CheckError(
      `file is ${bytes.length} bytes, shorter than an ELF64 header (${ELF64_HEADER_SIZE} bytes)`,
    );
  }
  if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
    throw new CheckError("missing ELF magic (expected 7f 45 4c 46)");
  }
  if (bytes[4] !== ELFCLASS64) {
    throw new CheckError(`EI_CLASS is ${bytes[4]}, expected ${ELFCLASS64} (ELFCLASS64)`);
  }
  if (bytes[5] !== ELFDATA2LSB) {
    throw new CheckError(`EI_DATA is ${bytes[5]}, expected ${ELFDATA2LSB} (little-endian)`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    eMachine: view.getUint16(E_MACHINE_OFFSET, true),
    eFlags: view.getUint32(E_FLAGS_OFFSET, true),
  };
}

function hasSecurityTxt(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).indexOf(SECURITY_TXT_BEGIN) !== -1;
}

/** Runs every check on `bytes`; returns the header, throws CheckError on failure. */
function check(bytes, { expectSecurityTxt }) {
  const header = readElfHeader(bytes);
  if (header.eFlags !== EXPECTED_SBPF_VERSION) {
    throw new CheckError(
      `e_flags is ${header.eFlags}, expected ${EXPECTED_SBPF_VERSION} (SBPFv3). Build with --arch v3.`,
    );
  }
  if (expectSecurityTxt && !hasSecurityTxt(bytes)) {
    throw new CheckError("security.txt BEGIN marker not found (=======BEGIN SECURITY.TXT V1=======)");
  }
  return header;
}

/** Proves the checker can fail: synthetic headers that must pass and must not. */
function selfTest() {
  const elf = ({ eiClass = ELFCLASS64, eiData = ELFDATA2LSB, eFlags = 3, size = 64 } = {}) => {
    const bytes = Buffer.alloc(size);
    bytes.set([0x7f, 0x45, 0x4c, 0x46, eiClass, eiData, 1], 0);
    if (size >= ELF64_HEADER_SIZE) {
      bytes.writeUInt16LE(263, E_MACHINE_OFFSET);
      bytes.writeUInt32LE(eFlags, E_FLAGS_OFFSET);
    }
    return bytes;
  };
  const rejects = (bytes, options, pattern) =>
    assert.throws(() => check(bytes, options), (err) => err instanceof CheckError && pattern.test(err.message));

  assert.equal(check(elf(), { expectSecurityTxt: false }).eFlags, 3);
  for (const eFlags of [0, 1, 2, 4, 0x20, 0x03000000]) {
    rejects(elf({ eFlags }), { expectSecurityTxt: false }, /^e_flags is /);
  }
  rejects(elf({ eiClass: 1 }), { expectSecurityTxt: false }, /^EI_CLASS/);
  rejects(elf({ eiData: 2 }), { expectSecurityTxt: false }, /^EI_DATA/);
  rejects(elf({ size: 63 }), { expectSecurityTxt: false }, /shorter than an ELF64 header/);
  rejects(Buffer.alloc(64), { expectSecurityTxt: false }, /missing ELF magic/);

  const withMarker = Buffer.concat([elf(), Buffer.from("prefix"), SECURITY_TXT_BEGIN, Buffer.from("name\0")]);
  assert.equal(check(withMarker, { expectSecurityTxt: true }).eFlags, 3);
  rejects(elf(), { expectSecurityTxt: true }, /security\.txt BEGIN marker not found/);
  // The marker must match exactly, including its trailing NUL.
  const truncated = Buffer.concat([elf(), SECURITY_TXT_BEGIN.subarray(0, SECURITY_TXT_BEGIN.length - 1)]);
  rejects(truncated, { expectSecurityTxt: true }, /security\.txt BEGIN marker not found/);
  console.log("check-sbpf: self-test passed");
}

function usage(message) {
  console.error(`check-sbpf: ${message}`);
  console.error("usage: node scripts/check-sbpf.mjs [--expect-security-txt] <path-to-.so>");
  console.error("       node scripts/check-sbpf.mjs --self-test");
  process.exit(2);
}

function main(argv) {
  let expectSecurityTxt = false;
  let runSelfTest = false;
  const paths = [];
  for (const arg of argv) {
    if (arg === "--expect-security-txt") expectSecurityTxt = true;
    else if (arg === "--self-test") runSelfTest = true;
    else if (arg.startsWith("--")) usage(`unknown flag ${arg}`);
    else paths.push(arg);
  }
  if (runSelfTest) {
    if (paths.length !== 0 || expectSecurityTxt) usage("--self-test takes no other arguments");
    selfTest();
    return;
  }
  if (paths.length !== 1) usage("expected exactly one path");

  const [path] = paths;
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    console.error(`::error file=${path}::check-sbpf: cannot read ${path}: ${err.message}`);
    process.exit(1);
  }
  try {
    const { eMachine, eFlags } = check(bytes, { expectSecurityTxt });
    const hex = `0x${eFlags.toString(16).padStart(8, "0")}`;
    console.log(`${path}: ${bytes.length} bytes, ELF64 little-endian, e_machine=${eMachine}`);
    console.log(`${path}: e_flags=${eFlags} (${hex}), SBPFv${EXPECTED_SBPF_VERSION}: OK`);
    if (expectSecurityTxt) console.log(`${path}: security.txt BEGIN marker present: OK`);
  } catch (err) {
    if (!(err instanceof CheckError)) throw err;
    console.error(`::error file=${path}::check-sbpf: ${err.message}`);
    process.exit(1);
  }
}

main(process.argv.slice(2));
