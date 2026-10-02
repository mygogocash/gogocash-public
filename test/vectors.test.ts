import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AMOUNT_EXAMPLES,
  CONSENT_EXAMPLE,
  PAYOUT_ID_HEX,
  PDA_VECTORS,
  PLACEHOLDER_PROGRAM_ID,
  PROGRAM_DATA,
  RECEIPT_HEX,
  TEST_SIGNER_1,
  VAULT_V1_HEX,
} from "./vectors.ts";

const contract = readFileSync(new URL("../docs/CONTRACT.md", import.meta.url), "utf8");

describe("test vectors are verbatim copies of docs/CONTRACT.md", () => {
  it("PDA, key and decode vectors appear in the contract", () => {
    const strings = [
      PLACEHOLDER_PROGRAM_ID,
      PROGRAM_DATA.address,
      PAYOUT_ID_HEX,
      TEST_SIGNER_1,
      RECEIPT_HEX,
      VAULT_V1_HEX,
      ...Object.values(PDA_VECTORS).flatMap((v) => [
        v.mint,
        v.vault.address,
        v.vaultAta,
        v.receipt.address,
        v.recipientAta,
      ]),
    ];
    for (const value of strings) expect(contract).toContain(value);
  });

  it("the worked consent example appears in the contract byte for byte", () => {
    expect(contract).toContain(`\`\`\`\n${CONSENT_EXAMPLE.text}\n\`\`\``);
    expect(contract).toContain(CONSENT_EXAMPLE.sha256);
    expect(contract).toContain(CONSENT_EXAMPLE.signatureBase58);
    expect(contract).toContain(CONSENT_EXAMPLE.signatureHex);
    expect(contract).toContain(`**${CONSENT_EXAMPLE.byteLength}**`);
  });

  it("the amount examples appear as rows of the section 6.3 table", () => {
    for (const v of AMOUNT_EXAMPLES) {
      const row = `| ${v.requested} | ${v.fee} | ${v.net} | ${v.rate} | ${v.usdc} | ${v.value} | ${v.defaultDeducted} / ${v.defaultRemainder} | ${v.altDeducted} / ${v.altDust} |`;
      expect(contract).toContain(row);
    }
  });
});
