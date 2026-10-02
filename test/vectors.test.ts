import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AMOUNT_EXAMPLES,
  CLAIM_DATA_VECTOR,
  CONSENT_EXAMPLE,
  INSTRUCTION_DISCRIMINATORS_HEX,
  PAYOUT_CLAIMED_VECTOR,
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

  it("instruction, claim data and event vectors appear in the contract", () => {
    for (const [name, discriminator] of Object.entries(INSTRUCTION_DISCRIMINATORS_HEX)) {
      expect(contract).toContain(`| \`${name}\` | \`${discriminator}\` |`);
    }
    expect(contract).toContain(`\`\`\`\n${CLAIM_DATA_VECTOR.hex}\n\`\`\``);
    expect(contract).toContain(`payout_id \`c6a87a9e...c88021\`, amount ${CLAIM_DATA_VECTOR.amount}, expires_at ${CLAIM_DATA_VECTOR.expiresAt}`);
    expect(contract).toContain(`\`\`\`\n${PAYOUT_CLAIMED_VECTOR.base64}\n\`\`\``);
    expect(contract).toContain(`\`event:PayoutClaimed\` = \`${PAYOUT_CLAIMED_VECTOR.discriminatorHex}\``);
    expect(contract).toContain(
      `claimed_at ${PAYOUT_CLAIMED_VECTOR.claimedAt}, day ${PAYOUT_CLAIMED_VECTOR.day}, first claim of the day`,
    );
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
