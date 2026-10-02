import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { addTsSpecifiers, findErasabilityProblems, rewriteNumericEnums } from "../scripts/codama.ts";
import * as sdk from "../src/index.ts";
import { PDA_VECTORS } from "./vectors.ts";

describe("scripts/codama.ts post-processing", () => {
  it("rewrites a numeric enum into the erasable const form", () => {
    const out = rewriteNumericEnums("export enum ClaimKind {\n  Standard,\n  Retry, // second\n}\n");
    expect(out).toBe(
      "export const ClaimKind = { 0: 'Standard', 1: 'Retry', Standard: 0, Retry: 1 } as const;\n" +
        "export type ClaimKind = (typeof ClaimKind)[Exclude<keyof typeof ClaimKind, number>];\n",
    );
    expect(findErasabilityProblems(out)).toEqual([]);
  });

  it("refuses an enum with initializers instead of guessing", () => {
    expect(() => rewriteNumericEnums("export enum Bad { A = 2, B }")).toThrow(/initializers/);
  });

  const root = mkdtempSync(join(tmpdir(), "codama-postprocess-"));
  mkdirSync(join(root, "accounts"));
  writeFileSync(join(root, "accounts", "index.ts"), "");
  writeFileSync(join(root, "receipt.ts"), "");
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("adds .ts and /index.ts specifiers to relative imports only", () => {
    const source = [
      "export * from './accounts';",
      "import { a } from \"./receipt\";",
      "import { b } from './receipt.js';",
      "import { c } from './receipt.ts';",
      "import { address } from '@solana/kit';",
    ].join("\n");
    expect(addTsSpecifiers(source, root)).toBe(
      [
        "export * from './accounts/index.ts';",
        "import { a } from \"./receipt.ts\";",
        "import { b } from './receipt.ts';",
        "import { c } from './receipt.ts';",
        "import { address } from '@solana/kit';",
      ].join("\n"),
    );
  });

  it("reports non-erasable syntax and extensionless relative imports", () => {
    expect(findErasabilityProblems("export enum A { X }")).toContain("enum declaration");
    expect(findErasabilityProblems("export const enum A { X }")).toContain("enum declaration");
    expect(findErasabilityProblems("export namespace N {}")).toContain("namespace or module declaration");
    expect(findErasabilityProblems("class K { constructor(private readonly x: number) {} }")).toContain(
      "constructor parameter property",
    );
    expect(findErasabilityProblems("export * from './x';")).toEqual(["relative import without .ts: ./x"]);
    expect(findErasabilityProblems("export * from './x.ts';\nimport { y } from '@solana/kit';")).toEqual([]);
  });
});

describe("committed src/generated client", () => {
  const generatedRoot = fileURLToPath(new URL("../src/generated", import.meta.url));
  const files = readdirSync(generatedRoot, { recursive: true, encoding: "utf8" }).filter((file) =>
    file.endsWith(".ts"),
  );

  it("is loadable by Node type stripping (erasable syntax, explicit .ts specifiers)", () => {
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      expect({ file, problems: findErasabilityProblems(readFileSync(join(generatedRoot, file), "utf8")) }).toEqual({
        file,
        problems: [],
      });
    }
  });

  it("is exported from src/index.ts as the `generated` namespace", () => {
    expect(typeof sdk.generated.getClaimInstruction).toBe("function");
    expect(typeof sdk.generated.getPayoutClaimedEventDecoder).toBe("function");
  });

  it("leaves the top-level PDA helpers program-explicit (section 2.4)", async () => {
    const mint = sdk.USDC_MINT.devnet;
    const otherProgram = sdk.SYSTEM_PROGRAM_ADDRESS;
    // The top-level helper is the SDK's: it never falls back to a default program id.
    await expect(sdk.findVaultPda({ mint } as unknown as Parameters<typeof sdk.findVaultPda>[0])).rejects.toThrow();
    const explicit = await sdk.findVaultPda({ programAddress: otherProgram, mint });
    const [generatedExplicit] = await sdk.generated.findVaultPda({ mint }, { programAddress: otherProgram });
    expect(explicit.address).toBe(generatedExplicit);
    // The namespaced generated helper silently uses the IDL address when programAddress
    // is omitted, which is why clients must not call it that way.
    const [defaulted] = await sdk.generated.findVaultPda({ mint });
    expect(defaulted).toBe(PDA_VECTORS.devnet.vault.address);
    expect(defaulted).not.toBe(explicit.address);
  });
});
