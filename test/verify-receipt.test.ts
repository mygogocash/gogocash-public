import { address, type Address } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { GENESIS_HASH, TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "../src/clusters.ts";
import { payoutIdFromHex } from "../src/program.ts";
import {
  checkDeploymentBinding,
  crossCheckTokenBalances,
  evaluateReceiptAccount,
  receiptRpcFromKit,
  verifyReceipt,
  verifyRowReceipt,
  type DeploymentFields,
  type ReceiptRow,
  type ReceiptRpc,
  type TokenBalanceEntry,
} from "../src/verify-receipt.ts";
import { PAYOUT_ID_HEX, PDA_VECTORS, PLACEHOLDER_PROGRAM_ID, RECEIPT_HEX, TEST_SIGNER_1, fromHex } from "./vectors.ts";

const devnet = PDA_VECTORS.devnet;
const running: DeploymentFields = {
  cluster: "devnet",
  genesisHash: GENESIS_HASH.devnet,
  programId: PLACEHOLDER_PROGRAM_ID,
  mint: devnet.mint,
  vault: devnet.vault.address,
  vaultTokenAccount: devnet.vaultAta,
};
const row: ReceiptRow = {
  ...running,
  payoutIdHex: PAYOUT_ID_HEX,
  recipient: TEST_SIGNER_1,
  amountAtomic: 3558875n,
  receiptAddress: devnet.receipt.address,
};
const receiptBytes = fromHex(RECEIPT_HEX);
const payoutId = payoutIdFromHex(PAYOUT_ID_HEX);

function fakeRpc(account: { owner: string; data: Uint8Array } | null, genesis = GENESIS_HASH.devnet, contextSlot = 777n) {
  const getGenesisHash = vi.fn(async () => genesis);
  const getFinalizedAccount = vi.fn(async (_address: Address, _options: { minContextSlot?: bigint }) => ({
    contextSlot,
    account,
  }));
  const rpc: ReceiptRpc = { getGenesisHash, getFinalizedAccount };
  return { rpc, getGenesisHash, getFinalizedAccount };
}

describe("deployment binding (contract section 3.8 step 1)", () => {
  it("passes when every deployment field matches and the receipt re-derives", async () => {
    expect(await checkDeploymentBinding(row, running)).toEqual({ ok: true, receipt: devnet.receipt });
  });

  for (const field of ["cluster", "genesisHash", "programId", "mint", "vault", "vaultTokenAccount"] as const) {
    it(`fails on a ${field} difference`, async () => {
      const other = { ...running, [field]: field === "cluster" ? "mainnet" : `${running[field]}x` } as DeploymentFields;
      expect(await checkDeploymentBinding(row, other)).toEqual({
        ok: false,
        reason: "deployment_mismatch",
        mismatched: [field],
      });
    });
  }

  it("fails when the stored receipt address is not the re-derived one", async () => {
    const result = await checkDeploymentBinding({ ...row, receiptAddress: PDA_VECTORS.mainnet.receipt.address }, running);
    expect(result).toEqual({ ok: false, reason: "deployment_mismatch", mismatched: ["receiptAddress"] });
  });

  it("fails on a non-canonical payout id instead of normalizing it", async () => {
    const result = await checkDeploymentBinding({ ...row, payoutIdHex: PAYOUT_ID_HEX.toUpperCase() }, running);
    expect(result).toEqual({ ok: false, reason: "deployment_mismatch", mismatched: ["payoutIdHex"] });
  });

  it("fails on an unknown cluster even when row and running config agree", async () => {
    // A plain-JS caller can bypass the Cluster type, e.g. 'testnet' read from the DB on both sides.
    const testnet = { ...running, cluster: "testnet" } as unknown as DeploymentFields;
    const result = await checkDeploymentBinding({ ...row, cluster: testnet.cluster }, testnet);
    expect(result).toEqual({ ok: false, reason: "deployment_mismatch", mismatched: ["cluster"] });
  });

  it("compares case-sensitively", async () => {
    const lower = { ...running, vault: running.vault.toLowerCase() };
    const result = await checkDeploymentBinding({ ...row, vault: lower.vault }, lower);
    expect(result).toEqual({ ok: false, reason: "deployment_mismatch", mismatched: ["vault"] });
  });
});

describe("receipt account evaluation (contract section 3.8 steps 3-5)", () => {
  const expected = {
    programId: PLACEHOLDER_PROGRAM_ID,
    bump: devnet.receipt.bump,
    payoutId,
    recipient: TEST_SIGNER_1,
    amountAtomic: 3558875n,
  };

  it("null is absent", () => {
    expect(evaluateReceiptAccount({ ...expected, account: null })).toEqual({ outcome: "absent" });
  });

  it("the decode vector matches its tuple", () => {
    const result = evaluateReceiptAccount({ ...expected, account: { owner: PLACEHOLDER_PROGRAM_ID, data: receiptBytes } });
    expect(result.outcome).toBe("match");
  });

  it("owner, length, discriminator and bump failures are mismatch", () => {
    const at = (data: Uint8Array, owner = PLACEHOLDER_PROGRAM_ID) => evaluateReceiptAccount({ ...expected, account: { owner, data } });
    expect(at(receiptBytes, TOKEN_PROGRAM_ADDRESS)).toEqual({ outcome: "mismatch", reasons: ["owner"] });
    expect(at(receiptBytes.subarray(0, 88))).toEqual({ outcome: "mismatch", reasons: ["length"] });
    expect(at(Uint8Array.of(...receiptBytes, 0))).toEqual({ outcome: "mismatch", reasons: ["length"] });
    const badDisc = Uint8Array.from(receiptBytes);
    badDisc[3] = 0;
    expect(at(badDisc)).toEqual({ outcome: "mismatch", reasons: ["discriminator"] });
    const badBump = Uint8Array.from(receiptBytes);
    badBump[8] = 250;
    expect(at(badBump)).toEqual({ outcome: "mismatch", reasons: ["bump"] });
  });

  it("a tuple difference is mismatch (the front-run shape), never match", () => {
    const account = { owner: PLACEHOLDER_PROGRAM_ID, data: receiptBytes };
    const otherId = Uint8Array.from(payoutId);
    otherId[31] = (otherId[31] ?? 0) ^ 1;
    expect(evaluateReceiptAccount({ ...expected, account, payoutId: otherId })).toMatchObject({ outcome: "mismatch", reasons: ["payout_id"] });
    expect(evaluateReceiptAccount({ ...expected, account, recipient: PLACEHOLDER_PROGRAM_ID })).toMatchObject({
      outcome: "mismatch",
      reasons: ["recipient"],
    });
    expect(evaluateReceiptAccount({ ...expected, account, amountAtomic: 3558876n })).toMatchObject({ outcome: "mismatch", reasons: ["amount"] });
  });
});

describe("verifyReceipt / verifyRowReceipt over an injected RPC", () => {
  it("returns match with the derived address, bump and context slot", async () => {
    const { rpc, getFinalizedAccount } = fakeRpc({ owner: PLACEHOLDER_PROGRAM_ID, data: receiptBytes });
    const result = await verifyRowReceipt({ rpc, row, running, minContextSlot: 700n });
    expect(result).toMatchObject({ outcome: "match", receiptAddress: devnet.receipt.address, bump: 251, contextSlot: 777n });
    expect(getFinalizedAccount).toHaveBeenCalledWith(devnet.receipt.address, { minContextSlot: 700n });
  });

  it("returns absent when the receipt does not exist", async () => {
    const { rpc } = fakeRpc(null);
    const result = await verifyReceipt({
      rpc,
      cluster: "devnet",
      programId: address(PLACEHOLDER_PROGRAM_ID),
      vault: address(devnet.vault.address),
      payoutId,
      recipient: TEST_SIGNER_1,
      amountAtomic: 3558875n,
    });
    expect(result).toMatchObject({ outcome: "absent", receiptAddress: devnet.receipt.address });
  });

  describe("minContextSlot is enforced on the response, not only requested (section 9.2 step 2)", () => {
    const sdkInput = {
      cluster: "devnet" as const,
      programId: address(PLACEHOLDER_PROGRAM_ID),
      vault: address(devnet.vault.address),
      payoutId,
      recipient: TEST_SIGNER_1,
      amountAtomic: 3558875n,
    };

    it("an absent read older than minContextSlot is stale_read, never absent", async () => {
      const { rpc } = fakeRpc(null, GENESIS_HASH.devnet, 950n);
      const result = await verifyReceipt({ ...sdkInput, rpc, minContextSlot: 1000n });
      expect(result).toEqual({
        outcome: "stale_read",
        receiptAddress: devnet.receipt.address,
        bump: devnet.receipt.bump,
        contextSlot: 950n,
        minContextSlot: 1000n,
      });
    });

    it("a matching read older than minContextSlot is stale_read, never match", async () => {
      const { rpc } = fakeRpc({ owner: PLACEHOLDER_PROGRAM_ID, data: receiptBytes }, GENESIS_HASH.devnet, 950n);
      const result = await verifyRowReceipt({ rpc, row, running, minContextSlot: 1000n });
      expect(result.outcome).toBe("stale_read");
    });

    it("a read without a bigint context slot is stale_read when a floor was asked for", async () => {
      const rpc: ReceiptRpc = {
        getGenesisHash: async () => GENESIS_HASH.devnet,
        getFinalizedAccount: async () => ({ contextSlot: undefined as unknown as bigint, account: null }),
      };
      expect((await verifyReceipt({ ...sdkInput, rpc, minContextSlot: 1n })).outcome).toBe("stale_read");
    });

    it("a read at exactly minContextSlot is evaluated", async () => {
      const { rpc } = fakeRpc(null, GENESIS_HASH.devnet, 1000n);
      const result = await verifyReceipt({ ...sdkInput, rpc, minContextSlot: 1000n });
      expect(result).toMatchObject({ outcome: "absent", contextSlot: 1000n });
    });

    it("no floor requested means no staleness check", async () => {
      const { rpc } = fakeRpc(null, GENESIS_HASH.devnet, 1n);
      expect((await verifyReceipt({ ...sdkInput, rpc })).outcome).toBe("absent");
    });
  });

  it("stops before the account read on a genesis mismatch", async () => {
    const { rpc, getFinalizedAccount } = fakeRpc({ owner: PLACEHOLDER_PROGRAM_ID, data: receiptBytes }, GENESIS_HASH.mainnet);
    const result = await verifyRowReceipt({ rpc, row, running });
    expect(result).toEqual({ outcome: "genesis_mismatch", observedGenesisHash: GENESIS_HASH.mainnet });
    expect(getFinalizedAccount).not.toHaveBeenCalled();
  });

  it("makes no chain read at all on a deployment mismatch", async () => {
    const { rpc, getGenesisHash, getFinalizedAccount } = fakeRpc({ owner: PLACEHOLDER_PROGRAM_ID, data: receiptBytes });
    const result = await verifyRowReceipt({ rpc, row: { ...row, mint: PDA_VECTORS.mainnet.mint }, running });
    expect(result).toEqual({ outcome: "deployment_mismatch", mismatched: ["mint"] });
    expect(getGenesisHash).not.toHaveBeenCalled();
    expect(getFinalizedAccount).not.toHaveBeenCalled();
  });
});

describe("receiptRpcFromKit", () => {
  it("reads at finalized with base64 encoding and decodes the data", async () => {
    const getAccountInfo = vi.fn((_address: Address, _config: unknown) => ({
      send: async () => ({
        context: { slot: 42n },
        value: { owner: PLACEHOLDER_PROGRAM_ID, data: [Buffer.from(receiptBytes).toString("base64"), "base64"] },
      }),
    }));
    const kitRpc = {
      getGenesisHash: () => ({ send: async () => GENESIS_HASH.devnet }),
      getAccountInfo,
    } as unknown as Parameters<typeof receiptRpcFromKit>[0];
    const rpc = receiptRpcFromKit(kitRpc);
    expect(await rpc.getGenesisHash()).toBe(GENESIS_HASH.devnet);
    const read = await rpc.getFinalizedAccount(address(devnet.receipt.address), { minContextSlot: 9n });
    expect(read.contextSlot).toBe(42n);
    expect(read.account?.owner).toBe(PLACEHOLDER_PROGRAM_ID);
    expect(read.account?.data).toEqual(receiptBytes);
    expect(getAccountInfo).toHaveBeenCalledWith(devnet.receipt.address, {
      commitment: "finalized",
      encoding: "base64",
      minContextSlot: 9n,
    });
  });

  it("maps a null account value to null", async () => {
    const kitRpc = {
      getGenesisHash: () => ({ send: async () => GENESIS_HASH.devnet }),
      getAccountInfo: () => ({ send: async () => ({ context: { slot: 1n }, value: null }) }),
    } as unknown as Parameters<typeof receiptRpcFromKit>[0];
    expect((await receiptRpcFromKit(kitRpc).getFinalizedAccount(address(devnet.receipt.address), {})).account).toBeNull();
  });
});

describe("token-balance cross-check over transaction meta", () => {
  const recipientAta = devnet.recipientAta;
  // Static keys of a claim transaction: payer, claim authority, vault, receipt,
  // vault ATA, recipient ATA, mint, recipient, programs.
  const staticAccountKeys = [
    "Fee1payer1111111111111111111111111111111111",
    "C1aimAuthority11111111111111111111111111111",
    devnet.vault.address,
    devnet.receipt.address,
    devnet.vaultAta,
    recipientAta,
    devnet.mint,
    TEST_SIGNER_1,
    TOKEN_PROGRAM_ADDRESS,
  ];
  const balance = (accountIndex: number, owner: string, amount: string, extra: Partial<TokenBalanceEntry> = {}): TokenBalanceEntry => ({
    accountIndex,
    mint: devnet.mint,
    owner,
    programId: TOKEN_PROGRAM_ADDRESS,
    uiTokenAmount: { amount },
    ...extra,
  });
  const base = {
    staticAccountKeys,
    mint: devnet.mint,
    vault: devnet.vault.address,
    vaultTokenAccount: devnet.vaultAta,
    recipient: TEST_SIGNER_1,
    recipientTokenAccount: recipientAta,
    amountAtomic: 3558875n,
  };
  const goodMeta = {
    err: null,
    preTokenBalances: [balance(4, devnet.vault.address, "10000000")],
    postTokenBalances: [balance(4, devnet.vault.address, "6441125"), balance(5, TEST_SIGNER_1, "3558875")],
  };

  it("passes when the vault loses and a new recipient ATA gains exactly the amount", () => {
    expect(crossCheckTokenBalances({ ...base, meta: goodMeta })).toEqual({ ok: true });
  });

  it("passes for an existing recipient ATA with a prior balance", () => {
    const meta = {
      err: null,
      preTokenBalances: [balance(4, devnet.vault.address, "10000000"), balance(5, TEST_SIGNER_1, "5")],
      postTokenBalances: [balance(4, devnet.vault.address, "6441125"), balance(5, TEST_SIGNER_1, "3558880")],
    };
    expect(crossCheckTokenBalances({ ...base, meta })).toEqual({ ok: true });
  });

  it("resolves account indexes through loaded addresses", () => {
    const keys = staticAccountKeys.filter((k) => k !== recipientAta);
    const meta = {
      err: null,
      loadedAddresses: { writable: [recipientAta], readonly: [] },
      preTokenBalances: [balance(4, devnet.vault.address, "10000000")],
      postTokenBalances: [balance(4, devnet.vault.address, "6441125"), balance(keys.length, TEST_SIGNER_1, "3558875")],
    };
    expect(crossCheckTokenBalances({ ...base, staticAccountKeys: keys, meta })).toEqual({ ok: true });
  });

  const failing: Array<[string, Parameters<typeof crossCheckTokenBalances>[0]["meta"], string]> = [
    ["a failed transaction", { ...goodMeta, err: { InstructionError: [3, { Custom: 6012 }] } }, "transaction_failed"],
    ["missing balances", { err: null, preTokenBalances: null, postTokenBalances: [] }, "balances_missing"],
    [
      "a short vault debit",
      { ...goodMeta, postTokenBalances: [balance(4, devnet.vault.address, "6441126"), balance(5, TEST_SIGNER_1, "3558875")] },
      "vault_delta",
    ],
    [
      "a recipient credit that differs",
      { ...goodMeta, postTokenBalances: [balance(4, devnet.vault.address, "6441125"), balance(5, TEST_SIGNER_1, "3558874")] },
      "recipient_delta",
    ],
    [
      "no recipient balance",
      { ...goodMeta, postTokenBalances: [balance(4, devnet.vault.address, "6441125")] },
      "recipient_token_account_not_in_transaction",
    ],
    [
      "another mint",
      {
        ...goodMeta,
        postTokenBalances: [balance(4, devnet.vault.address, "6441125"), balance(5, TEST_SIGNER_1, "3558875", { mint: PDA_VECTORS.mainnet.mint })],
      },
      "wrong_mint",
    ],
    [
      "another owner",
      { ...goodMeta, postTokenBalances: [balance(4, devnet.vault.address, "6441125"), balance(5, PLACEHOLDER_PROGRAM_ID, "3558875")] },
      "wrong_owner",
    ],
    [
      "a Token-2022 account",
      {
        ...goodMeta,
        postTokenBalances: [
          balance(4, devnet.vault.address, "6441125"),
          balance(5, TEST_SIGNER_1, "3558875", { programId: TOKEN_2022_PROGRAM_ADDRESS }),
        ],
      },
      "wrong_token_program",
    ],
    [
      "a third account of the mint changing",
      {
        ...goodMeta,
        postTokenBalances: [...goodMeta.postTokenBalances, balance(0, staticAccountKeys[0] as string, "1")],
      },
      "unexpected_balance_change",
    ],
  ];
  const without = (entry: TokenBalanceEntry, field: "owner" | "programId"): TokenBalanceEntry => {
    const { [field]: _dropped, ...rest } = entry;
    return rest;
  };
  for (const field of ["owner", "programId"] as const) {
    failing.push(
      [
        `a vault entry without ${field}`,
        { ...goodMeta, preTokenBalances: [without(balance(4, devnet.vault.address, "10000000"), field)] },
        "balance_fields_missing",
      ],
      [
        `a recipient entry without ${field}`,
        {
          ...goodMeta,
          postTokenBalances: [balance(4, devnet.vault.address, "6441125"), without(balance(5, TEST_SIGNER_1, "3558875"), field)],
        },
        "balance_fields_missing",
      ],
    );
  }
  for (const [name, meta, reason] of failing) {
    it(`fails on ${name}`, () => {
      const result = crossCheckTokenBalances({ ...base, meta });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasons).toContain(reason);
    });
  }
});
