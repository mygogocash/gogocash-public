import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ANCHOR_ERRORS,
  classifyInstructionError,
  classifyProgramErrorCode,
  classifyTransactionError,
  classifyTransactionLevelError,
  PROGRAM_ERRORS,
  type ErrorClass,
  type InstructionKind,
} from "../src/errors.ts";

const contract = readFileSync(new URL("../docs/CONTRACT.md", import.meta.url), "utf8");

/** Section 3.5, one row per code: [code, name, class]. */
const SECTION_3_5: Array<[number, string, ErrorClass]> = [
  [6000, "Paused", "hold"],
  [6001, "InvalidClaimAuthority", "config"],
  [6002, "NotAdmin", "bug"],
  [6003, "NotAdminOrGuardian", "bug"],
  [6004, "NotPendingAdmin", "bug"],
  [6005, "NotUpgradeAuthority", "config"],
  [6006, "InvalidProgramData", "bug"],
  [6007, "InvalidRole", "bug"],
  [6008, "ZeroPayoutId", "bug"],
  [6009, "ZeroAmount", "bug"],
  [6010, "ExceedsMaxPerClaim", "needs_review"],
  [6011, "DayCapExceeded", "hold"],
  [6012, "Expired", "retry"],
  [6013, "ExpiryTooFar", "bug"],
  [6014, "VaultTokenAccountFrozen", "hold"],
  [6015, "RecipientTokenAccountFrozen", "needs_review"],
  [6016, "InsufficientVaultBalance", "hold"],
  [6017, "InvalidRecipient", "needs_review"],
  [6018, "InvalidVaultTokenAccount", "config"],
  [6019, "InvalidMint", "config"],
  [6020, "RoleConflict", "bug"],
  [6021, "InvalidCaps", "bug"],
  [6022, "InvalidWithdrawDestination", "bug"],
  [6023, "MathOverflow", "bug"],
];

const claimIx: InstructionKind[] = ["compute_budget", "compute_budget", "create_associated_token_idempotent", "claim"];

describe("program error table (contract section 3.5)", () => {
  it("has exactly the 24 codes 6000-6023 in order", () => {
    expect(PROGRAM_ERRORS.map((e) => e.code)).toEqual(SECTION_3_5.map(([code]) => code));
  });

  for (const [code, name, errorClass] of SECTION_3_5) {
    it(`${code} ${name} is ${errorClass}`, () => {
      const c = classifyProgramErrorCode(code);
      expect(c).toMatchObject({ class: errorClass, code, name, source: "program" });
      const latch = errorClass === "bug" || errorClass === "config" || code === 6014;
      expect(c.haltLatch).toBe(latch);
      expect(c.critical).toBe(latch);
    });
  }

  it("each row's name and exact message appear in the contract table", () => {
    for (const entry of PROGRAM_ERRORS) {
      expect(contract).toContain(`| ${entry.code} | ${entry.name} | ${entry.message} |`);
    }
  });

  it("names the hold reasons of section 9.1", () => {
    expect(classifyProgramErrorCode(6000).holdReason).toBe("program_paused");
    expect(classifyProgramErrorCode(6011).holdReason).toBe("day_cap");
    expect(classifyProgramErrorCode(6016).holdReason).toBe("vault_low");
    expect(classifyProgramErrorCode(6014).holdReason).toBeUndefined();
  });

  it("an unknown program code (appended after v0) is bug", () => {
    expect(classifyProgramErrorCode(6024)).toMatchObject({ class: "bug", haltLatch: true, critical: true });
  });
});

describe("Anchor built-in errors (contract section 3.6)", () => {
  const expected: Array<[number, ErrorClass]> = [
    [100, "bug"], [101, "config"], [102, "bug"], [2000, "bug"], [2006, "bug"], [2009, "bug"], [2015, "bug"],
    [2023, "bug"], [2040, "bug"], [3001, "config"], [3002, "config"], [3003, "config"], [3005, "bug"],
    [3007, "config"], [3008, "bug"], [3009, "bug"], [3010, "bug"], [3011, "needs_review"], [3012, "config"],
    [3013, "bug"], [3014, "bug"], [4100, "config"], [4101, "bug"],
    [2500, "bug"], [2501, "bug"], [2502, "bug"], [2503, "bug"], [2504, "bug"], [2505, "bug"], [2506, "bug"],
  ];
  for (const [code, errorClass] of expected) {
    it(`${code} is ${errorClass}`, () => {
      expect(classifyProgramErrorCode(code)).toMatchObject({ class: errorClass, code, source: "anchor" });
      expect(classifyInstructionError({ instruction: "claim", error: { custom: code } }).class).toBe(errorClass);
    });
  }

  it("lists every documented Anchor code exactly once", () => {
    expect(ANCHOR_ERRORS.map((e) => e.code).sort((a, b) => a - b)).toEqual(expected.map(([c]) => c).sort((a, b) => a - b));
    for (const entry of ANCHOR_ERRORS) {
      if (entry.code >= 2500 && entry.code <= 2506) continue; // documented as the range "2500-2506 | Require*"
      if (entry.code >= 3001 && entry.code <= 3003) continue; // documented on one combined row
      expect(contract).toContain(`| ${entry.code} | ${entry.name} |`);
    }
    expect(contract).toContain("| 2500-2506 | Require* |");
    expect(contract).toContain(
      "| 3001 / 3002 / 3003 | AccountDiscriminatorNotFound / AccountDiscriminatorMismatch / AccountDidNotDeserialize |",
    );
  });

  it("any other Anchor code is bug", () => {
    for (const code of [1000, 2001, 2003, 3000, 3004, 3006, 3015, 4102, 5000]) {
      expect(classifyProgramErrorCode(code)).toMatchObject({ class: "bug", haltLatch: true });
    }
  });
});

describe("non-Anchor instruction errors by failing index (contract section 3.7)", () => {
  it("claim Custom(0) is already_claimed, with or without the log", () => {
    const withLog = classifyInstructionError({
      instruction: "claim",
      error: { custom: 0 },
      logs: ["Allocate: account Address { address: X, base: None } already in use"],
    });
    expect(withLog).toMatchObject({ class: "already_claimed", haltLatch: false, critical: false });
    expect(classifyInstructionError({ instruction: "claim", error: { custom: 0 } }).class).toBe("already_claimed");
  });

  it("claim Custom(1) with 'insufficient lamports' is hold (fee_payer_low)", () => {
    const c = classifyInstructionError({
      instruction: "claim",
      error: { custom: 1 },
      logs: ["Transfer: insufficient lamports 100, need 1102360"],
    });
    expect(c).toMatchObject({ class: "hold", holdReason: "fee_payer_low", haltLatch: false });
  });

  it("claim Custom(1) without that log, and any other Custom(n < 6000) not in 3.6, is bug", () => {
    expect(classifyInstructionError({ instruction: "claim", error: { custom: 1 } }).class).toBe("bug");
    expect(classifyInstructionError({ instruction: "claim", error: { custom: 1 }, logs: ["Program log: Error: insufficient funds"] }).class).toBe("bug");
    for (const code of [2, 3, 4, 17, 99, 5999]) {
      expect(classifyInstructionError({ instruction: "claim", error: { custom: code } })).toMatchObject({ class: "bug", haltLatch: true });
    }
  });

  it("initialize Custom(0) is bug", () => {
    expect(classifyInstructionError({ instruction: "initialize", error: { custom: 0 } }).class).toBe("bug");
  });

  it("Custom(0) at the ATA index is needs_review, not already_claimed", () => {
    expect(classifyInstructionError({ instruction: "create_associated_token_idempotent", error: { custom: 0 } })).toMatchObject({
      class: "needs_review",
      haltLatch: false,
    });
    expect(classifyInstructionError({ instruction: "create_associated_token_idempotent", error: { name: "IllegalOwner" } }).class).toBe(
      "needs_review",
    );
    expect(classifyInstructionError({ instruction: "create_associated_token_idempotent", error: { custom: 1 } })).toMatchObject({
      class: "hold",
      holdReason: "fee_payer_low",
    });
    expect(classifyInstructionError({ instruction: "create_associated_token_idempotent", error: { custom: 7 } }).class).toBe("bug");
  });

  it("any compute-budget instruction error is bug", () => {
    expect(classifyInstructionError({ instruction: "compute_budget", error: { name: "InvalidInstructionData" } }).class).toBe("bug");
    expect(classifyInstructionError({ instruction: "compute_budget", error: { custom: 6000 } }).class).toBe("bug");
  });

  it("a named error at a program index is bug", () => {
    expect(classifyInstructionError({ instruction: "claim", error: { name: "ComputationalBudgetExceeded" } }).class).toBe("bug");
  });
});

describe("transaction-level errors (contract section 9.1, D-X6)", () => {
  it("classifies the four named errors and defaults to bug", () => {
    expect(classifyTransactionLevelError("BlockhashNotFound").class).toBe("retry");
    expect(classifyTransactionLevelError("AccountInUse").class).toBe("retry");
    expect(classifyTransactionLevelError("InsufficientFundsForFee")).toMatchObject({ class: "hold", holdReason: "fee_payer_low" });
    expect(classifyTransactionLevelError("InsufficientFundsForRent")).toMatchObject({ class: "hold", holdReason: "fee_payer_low" });
    expect(classifyTransactionLevelError("AlreadyProcessed")).toMatchObject({ class: "bug", haltLatch: true });
  });
});

describe("classifyTransactionError over JSON-RPC err values", () => {
  it("maps an InstructionError index to the instruction kind", () => {
    expect(classifyTransactionError({ err: { InstructionError: [3, { Custom: 6012 }] }, instructions: claimIx }).class).toBe("retry");
    expect(classifyTransactionError({ err: { InstructionError: [3, { Custom: 0 }] }, instructions: claimIx }).class).toBe(
      "already_claimed",
    );
    expect(classifyTransactionError({ err: { InstructionError: [2, { Custom: 0 }] }, instructions: claimIx }).class).toBe(
      "needs_review",
    );
    expect(classifyTransactionError({ err: { InstructionError: [2, "IllegalOwner"] }, instructions: claimIx }).class).toBe(
      "needs_review",
    );
    expect(classifyTransactionError({ err: { InstructionError: [0, "InvalidInstructionData"] }, instructions: claimIx }).class).toBe(
      "bug",
    );
    expect(
      classifyTransactionError({
        err: { InstructionError: [3n, { Custom: 1n }] },
        instructions: claimIx,
        logs: ["Transfer: insufficient lamports 0, need 1102360"],
      }).class,
    ).toBe("hold");
    expect(classifyTransactionError({ err: { InstructionError: [3, { BorshIoError: "x" }] }, instructions: claimIx }).class).toBe(
      "bug",
    );
  });

  it("an unknown index or malformed value is bug", () => {
    expect(classifyTransactionError({ err: { InstructionError: [9, { Custom: 6000 }] }, instructions: claimIx }).class).toBe("bug");
    expect(classifyTransactionError({ err: { InstructionError: [3] }, instructions: claimIx }).class).toBe("bug");
    expect(classifyTransactionError({ err: 42, instructions: claimIx }).class).toBe("bug");
    expect(classifyTransactionError({ err: null, instructions: claimIx }).class).toBe("bug");
  });

  it("handles transaction-level errors in string and object form", () => {
    expect(classifyTransactionError({ err: "BlockhashNotFound", instructions: claimIx }).class).toBe("retry");
    expect(classifyTransactionError({ err: { InsufficientFundsForRent: { account_index: 2 } }, instructions: claimIx }).class).toBe(
      "hold",
    );
    expect(classifyTransactionError({ err: { DuplicateInstruction: 1 }, instructions: claimIx }).class).toBe("bug");
  });
});
