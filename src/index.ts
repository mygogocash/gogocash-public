/**
 * Public API of the GoGoCash Solana payout SDK (docs/CONTRACT.md v0).
 *
 * Loadable as TypeScript source by Node's type stripping with no flags and no
 * build step: `node -e "import('./src/index.ts')"`.
 */
export * from "./amount.ts";
export * from "./base58.ts";
export * from "./base64.ts";
export * from "./claim-tx.ts";
export * from "./clusters.ts";
export * from "./errors.ts";
export * from "./events.ts";
export * from "./program.ts";
export * from "./release.ts";
export * from "./siws.ts";
export * from "./verify-receipt.ts";
export * from "./wire.ts";

/**
 * The Codama client generated from idl/gogocash_cashback.devnet.json
 * (`npm run codama`). Its instruction builders (`get*Instruction`,
 * `get*InstructionAsync`), PDA helpers (`find*Pda`), `isGogocashCashbackError`,
 * `gogocashCashbackProgram` and `GOGOCASH_CASHBACK_PROGRAM_ADDRESS` fall back
 * to or embed the IDL's address. Section 2.4 forbids that default: callers
 * pass `programAddress` from `release/manifest.json.programIds[cluster]`
 * every time. Prefer the program-explicit top-level helpers (`findVaultPda`,
 * `findReceiptPda`, `buildClaimTransaction`, `decodeClaimWire`); the codecs,
 * decoders and types here carry no address and are safe as they are.
 */
export * as generated from "./generated/index.ts";
