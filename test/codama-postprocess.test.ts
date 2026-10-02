import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { addTsSpecifiers, findErasabilityProblems, rewriteNumericEnums } from "../scripts/codama.ts";

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
