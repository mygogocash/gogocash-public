import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionEncoder,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLifetimeUsingDurableNonce,
  signTransaction,
  type Address,
  type Blockhash,
  type Instruction,
  type Nonce,
} from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { buildClaimTransaction, type ClaimTransaction } from "../src/claim-tx.ts";
import { V0_PLACEHOLDER_PROGRAM_ID } from "../src/clusters.ts";
import { CLAIM_DISCRIMINATOR } from "../src/generated/instructions/claim.ts";
import { checkClaimWireForRelease, decodeClaimWire, type ClaimWireExpectation } from "../src/wire.ts";
import { TEST_BLOCKHASH, TEST_LAST_VALID_BLOCK_HEIGHT, throwawayKey, vectorClaimInput, type TestKey } from "./tx-helpers.ts";
import { CLAIM_DATA_VECTOR, PDA_VECTORS, TEST_SIGNER_1 } from "./vectors.ts";

let payer: TestKey;
let claimAuthority: TestKey;
let built: ClaimTransaction;
let wire: Uint8Array;
let wireBase64: string;
let signature: string;
let expected: ClaimWireExpectation;

beforeAll(async () => {
  payer = await throwawayKey("fee payer");
  claimAuthority = await throwawayKey("claim authority");
  built = await buildClaimTransaction({
    ...vectorClaimInput({ payer: payer.address, claimAuthority: claimAuthority.address }),
    simulatedUnits: 40_000,
  });
  const signed = await signTransaction([payer.keyPair, claimAuthority.keyPair], built.transaction);
  wire = Uint8Array.from(getTransactionEncoder().encode(signed));
  wireBase64 = getBase64EncodedWireTransaction(signed);
  signature = getSignatureFromTransaction(signed);
  expected = {
    programAddress: V0_PLACEHOLDER_PROGRAM_ID,
    signature,
    blockhash: TEST_BLOCKHASH,
    payoutIdHex: CLAIM_DATA_VECTOR.payoutIdHex,
    amount: CLAIM_DATA_VECTOR.amount,
    vault: address(PDA_VECTORS.devnet.vault.address),
  };
});

const lifetime = { blockhash: TEST_BLOCKHASH as Blockhash, lastValidBlockHeight: TEST_LAST_VALID_BLOCK_HEIGHT };

/** Compiles and signs `message` with the test fee payer and claim authority. */
async function signMessage(message: Parameters<typeof compileTransaction>[0]): Promise<string> {
  const signed = await signTransaction([payer.keyPair, claimAuthority.keyPair], compileTransaction(message));
  return getBase64EncodedWireTransaction(signed);
}

function v0Message(instructions: readonly Instruction[]) {
  return pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(payer.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
}

/** A v0 claim wire built from `instructions`, signed by the test keys. */
function signedWire(instructions: readonly Instruction[]): Promise<string> {
  return signMessage(v0Message(instructions));
}

describe("decodeClaimWire (section 9.5)", () => {
  it("decodes the signed wire from base64 or raw bytes to the same tuple", () => {
    const fromBase64 = decodeClaimWire(wireBase64, V0_PLACEHOLDER_PROGRAM_ID);
    const fromBytes = decodeClaimWire(wire, V0_PLACEHOLDER_PROGRAM_ID);
    expect(fromBase64).toEqual(fromBytes);
    expect(fromBase64.ok).toBe(true);
    if (!fromBase64.ok) return;
    expect(fromBase64.tuple.signature).toBe(signature);
    expect(fromBase64.tuple.blockhash).toBe(TEST_BLOCKHASH);
    expect(fromBase64.tuple.payoutIdHex).toBe(CLAIM_DATA_VECTOR.payoutIdHex);
    expect(fromBase64.tuple.amount).toBe(CLAIM_DATA_VECTOR.amount);
    expect(fromBase64.tuple.expiresAt).toBe(CLAIM_DATA_VECTOR.expiresAt);
    expect(fromBase64.tuple.vault).toBe(PDA_VECTORS.devnet.vault.address);
  });

  it("refuses malformed input", () => {
    const truncated = wire.subarray(0, wire.length - 10);
    const trailing = Uint8Array.from([...wire, 0]);
    const cases: unknown[] = [
      "",
      "not base64!",
      wireBase64.slice(0, -1), // not a whole number of base64 groups
      `${wireBase64}====`,
      ` ${wireBase64}`,
      new Uint8Array(),
      truncated,
      trailing,
      new Uint8Array(1233),
      Uint8Array.from([1, 2, 3, 4, 5]),
      42,
      null,
    ];
    for (const input of cases) {
      const result = decodeClaimWire(input as string, V0_PLACEHOLDER_PROGRAM_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal).toBe("malformed");
    }
  });

  it("refuses the unsigned wire", () => {
    expect(decodeClaimWire(built.unsignedWire, V0_PLACEHOLDER_PROGRAM_ID)).toMatchObject({
      ok: false,
      refusal: "unsigned",
    });
  });

  it("refuses a wire that only the fee payer signed", async () => {
    const partial = await partiallySignTransaction([payer.keyPair], built.transaction);
    expect(decodeClaimWire(getBase64EncodedWireTransaction(partial), V0_PLACEHOLDER_PROGRAM_ID)).toMatchObject({
      ok: false,
      refusal: "unsigned",
      detail: "the signature slot of signer 1 is empty",
    });
  });

  it("refuses a wire whose claim-authority signature does not verify", () => {
    // Wire layout: compact-u16 signature count (1 byte), then 64 bytes per signer.
    expect(wire[0]).toBe(2);
    const tampered = Uint8Array.from(wire);
    tampered[1 + 64 + 10] = (tampered[1 + 64 + 10] ?? 0) ^ 0x01;
    expect(decodeClaimWire(tampered, V0_PLACEHOLDER_PROGRAM_ID)).toMatchObject({
      ok: false,
      refusal: "signature_invalid",
      detail: "the signature of signer 1 does not verify",
    });
  });

  it("decodes a single-signer wire (payer = claim authority, section 3.3.2)", async () => {
    const single = await buildClaimTransaction({
      ...vectorClaimInput({ payer: payer.address, claimAuthority: payer.address }),
      simulatedUnits: 40_000,
    });
    const signed = await signTransaction([payer.keyPair], single.transaction);
    const singleWire = Uint8Array.from(getTransactionEncoder().encode(signed));
    expect(singleWire[0]).toBe(1); // one signature slot
    const result = checkClaimWireForRelease(singleWire, {
      ...expected,
      signature: getSignatureFromTransaction(signed),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tuple.feePayer).toBe(payer.address);
    expect(result.tuple.claimAuthority).toBe(result.tuple.feePayer);
    expect(result.tuple.recipient).toBe(TEST_SIGNER_1);
    expect(result.tuple.payoutIdHex).toBe(CLAIM_DATA_VECTOR.payoutIdHex);
    expect(result.tuple.amount).toBe(CLAIM_DATA_VECTOR.amount);
    expect(result.tuple.expiresAt).toBe(CLAIM_DATA_VECTOR.expiresAt);
  });

  it("refuses a wire whose bytes no longer match the first signature", () => {
    const tampered = Uint8Array.from(wire);
    const discriminator = Uint8Array.from(CLAIM_DISCRIMINATOR);
    const at = Buffer.from(tampered).indexOf(Buffer.from(discriminator));
    expect(at).toBeGreaterThan(0);
    tampered[at + 8 + 32] = (tampered[at + 8 + 32] ?? 0) ^ 0x01; // amount low byte
    expect(decodeClaimWire(tampered, V0_PLACEHOLDER_PROGRAM_ID)).toMatchObject({
      ok: false,
      refusal: "signature_invalid",
    });
  });

  it("refuses a wire for another program (no claim for the expected program)", async () => {
    const other = (await throwawayKey("another program id")).address;
    expect(decodeClaimWire(wireBase64, other)).toMatchObject({ ok: false, refusal: "claim_not_found" });
  });

  it("refuses a durable-nonce wire", async () => {
    const nonceAccountAddress = (await throwawayKey("nonce account")).address;
    const nonceWire = await signMessage(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(payer.address, m),
        (m) =>
          setTransactionMessageLifetimeUsingDurableNonce(
            { nonce: TEST_BLOCKHASH as Nonce, nonceAccountAddress, nonceAuthorityAddress: payer.address },
            m,
          ),
        (m) => appendTransactionMessageInstructions(built.instructions, m),
      ),
    );
    expect(decodeClaimWire(nonceWire, V0_PLACEHOLDER_PROGRAM_ID)).toMatchObject({
      ok: false,
      refusal: "durable_nonce",
    });
  });

  it("refuses a legacy message", async () => {
    const legacy = await signMessage(
      pipe(
        createTransactionMessage({ version: "legacy" }),
        (m) => setTransactionMessageFeePayer(payer.address, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
        (m) => appendTransactionMessageInstructions(built.instructions, m),
      ),
    );
    expect(decodeClaimWire(legacy, V0_PLACEHOLDER_PROGRAM_ID)).toMatchObject({
      ok: false,
      refusal: "unsupported_version",
    });
  });

  it("refuses a message that uses an address lookup table", async () => {
    const table = (await throwawayKey("lookup table")).address;
    const lookupTable = {
      [table]: [address(PDA_VECTORS.devnet.vault.address), address(PDA_VECTORS.devnet.receipt.address)],
    } as Record<Address, Address[]>;
    const compressed = await signMessage(
      compressTransactionMessageUsingAddressLookupTables(v0Message(built.instructions), lookupTable),
    );
    expect(decodeClaimWire(compressed, V0_PLACEHOLDER_PROGRAM_ID)).toMatchObject({
      ok: false,
      refusal: "address_lookup_tables",
    });
  });

  it("refuses two claim instructions and a malformed claim", async () => {
    const claim = built.instructions[3] as Instruction;
    const twice = await signedWire([...built.instructions, claim]);
    expect(decodeClaimWire(twice, V0_PLACEHOLDER_PROGRAM_ID)).toMatchObject({
      ok: false,
      refusal: "claim_ambiguous",
    });
    const short = await signedWire([
      ...built.instructions.slice(0, 3),
      { ...claim, data: Uint8Array.from(claim.data ?? []).subarray(0, 48) },
    ]);
    expect(decodeClaimWire(short, V0_PLACEHOLDER_PROGRAM_ID)).toMatchObject({
      ok: false,
      refusal: "claim_malformed",
    });
    const wrongDiscriminator = Uint8Array.from(claim.data ?? []);
    wrongDiscriminator[0] = (wrongDiscriminator[0] ?? 0) ^ 0xff;
    const other = await signedWire([...built.instructions.slice(0, 3), { ...claim, data: wrongDiscriminator }]);
    expect(decodeClaimWire(other, V0_PLACEHOLDER_PROGRAM_ID)).toMatchObject({
      ok: false,
      refusal: "claim_malformed",
    });
    const fewerAccounts = await signedWire([
      ...built.instructions.slice(0, 3),
      { ...claim, accounts: (claim.accounts ?? []).slice(0, 9) },
    ]);
    expect(decodeClaimWire(fewerAccounts, V0_PLACEHOLDER_PROGRAM_ID)).toMatchObject({
      ok: false,
      refusal: "claim_malformed",
    });
  });

  it("rejects a programAddress that is not an address", () => {
    expect(() => decodeClaimWire(wireBase64, "nope" as Address)).toThrow(TypeError);
  });
});

describe("checkClaimWireForRelease (section 9.5 preconditions)", () => {
  it("accepts the wire when every precondition holds", () => {
    const result = checkClaimWireForRelease(wireBase64, expected);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tuple.expiresAt).toBe(CLAIM_DATA_VECTOR.expiresAt);
  });

  it("refuses each mismatch with its own reason", async () => {
    const otherSignature = getSignatureFromTransaction(
      await signTransaction(
        [payer.keyPair, claimAuthority.keyPair],
        (await buildClaimTransaction({
          ...vectorClaimInput({ payer: payer.address, claimAuthority: claimAuthority.address }),
          simulatedUnits: 41_000,
        })).transaction,
      ),
    );
    expect(otherSignature).not.toBe(signature);
    expect(checkClaimWireForRelease(wireBase64, { ...expected, signature: otherSignature })).toMatchObject({
      ok: false,
      refusal: "signature_mismatch",
    });
    expect(
      checkClaimWireForRelease(wireBase64, { ...expected, blockhash: PDA_VECTORS.devnet.vault.address }),
    ).toMatchObject({ ok: false, refusal: "blockhash_mismatch" });
    expect(
      checkClaimWireForRelease(wireBase64, {
        ...expected,
        payoutIdHex: "c6a87a9e170995438a78874587cb95773a9fa752c5b1633c9e7ae23928c88022",
      }),
    ).toMatchObject({ ok: false, refusal: "payout_id_mismatch" });
    expect(checkClaimWireForRelease(wireBase64, { ...expected, amount: expected.amount + 1n })).toMatchObject({
      ok: false,
      refusal: "amount_mismatch",
    });
    // A claim against another vault under the same program (section 9.3 demo
    // mint): P5 would read a receipt this wire can never create.
    expect(
      checkClaimWireForRelease(wireBase64, { ...expected, vault: address(PDA_VECTORS.mainnet.vault.address) }),
    ).toMatchObject({ ok: false, refusal: "vault_mismatch" });
    // Structural refusals come first.
    expect(checkClaimWireForRelease(built.unsignedWire, expected)).toMatchObject({ ok: false, refusal: "unsigned" });
  });

  it("throws on a malformed expectation (caller bug or corrupt row, not a wire mismatch)", () => {
    expect(() =>
      checkClaimWireForRelease(wireBase64, { ...expected, payoutIdHex: expected.payoutIdHex.toUpperCase() }),
    ).toThrow(TypeError);
    expect(() =>
      checkClaimWireForRelease(wireBase64, { ...expected, amount: Number(expected.amount) as unknown as bigint }),
    ).toThrow(TypeError);
    expect(() => checkClaimWireForRelease(wireBase64, { ...expected, vault: "nope" as Address })).toThrow(TypeError);
  });
});
