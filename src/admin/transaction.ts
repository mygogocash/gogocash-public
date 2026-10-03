/**
 * Admin transaction assembly, pure: a v0 message with no address lookup
 * table, a recent-blockhash lifetime and no compute-budget instructions, so
 * the instruction list is exactly what the builders returned (the initialize
 * transaction of section 3.3.1 has exactly two instructions).
 *
 * `--export-squads` prints the compiled message as base58 instead of signing
 * it. The authority is then a Squads v4 vault (an off-curve PDA), carried by
 * a noop signer, and it is also the message's fee payer.
 */
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  compileTransactionMessage,
  createTransactionMessage,
  getBase58Decoder,
  getBase58Encoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  isTransactionWithinSizeLimit,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { isStrictBase58 } from "../base58.ts";

export type AdminLifetime = { readonly blockhash: string; readonly lastValidBlockHeight: bigint };

/** Builds the transaction message: fee payer, blockhash lifetime, instructions in order. */
export function buildAdminTransactionMessage(input: {
  readonly feePayer: TransactionSigner;
  readonly instructions: readonly Instruction[];
  readonly lifetime: AdminLifetime;
}) {
  if (input.instructions.length === 0) throw new TypeError("an admin transaction needs at least one instruction.");
  if (!isStrictBase58(input.lifetime.blockhash, 32)) throw new TypeError("blockhash must be a strict base58 value.");
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(input.feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: input.lifetime.blockhash as Blockhash,
          lastValidBlockHeight: input.lifetime.lastValidBlockHeight,
        },
        m,
      ),
    (m) => appendTransactionMessageInstructions(input.instructions, m),
  );
  if (!isTransactionWithinSizeLimit(compileTransaction(message))) {
    throw new TypeError("the admin transaction exceeds the transaction size limit.");
  }
  return message;
}

export type AdminTransactionMessage = ReturnType<typeof buildAdminTransactionMessage>;

/** The compiled message bytes (what every signer signs). */
export function compiledMessageBytes(message: AdminTransactionMessage): Uint8Array {
  return Uint8Array.from(getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(message)));
}

/**
 * `--export-squads`: the compiled v0 message as base58, for a Squads v4
 * proposal (the Ledger signs inside the Squads UI). Nothing is signed or sent.
 */
export function exportSquadsMessage(message: AdminTransactionMessage): string {
  return getBase58Decoder().decode(compiledMessageBytes(message));
}

/** Decodes an exported message back into its compiled form (for review and tests). */
export function decodeExportedMessage(base58Message: string) {
  if (typeof base58Message !== "string" || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(base58Message)) {
    throw new TypeError("the exported message must be base58.");
  }
  const bytes = Uint8Array.from(getBase58Encoder().encode(base58Message));
  return getCompiledTransactionMessageDecoder().decode(bytes);
}
