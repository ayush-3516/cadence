import { describe, expect, it, vi } from "vitest";
import { handleSplitCreated, handleWarehouseTransfer } from "../src/SplitsWarehouse.js";

const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
// uint256 token ID for the above address, per ERC6909's uint256(uint160(tokenAddress)) convention.
const USDC_TOKEN_ID = BigInt(USDC_ADDRESS);

function makeMockContext() {
  const insertedSplits: unknown[] = [];
  const insertedPayouts: unknown[] = [];
  const knownSplits = new Set<string>();

  return {
    chain: { id: 84532 },
    db: {
      insert: (table: { name?: string }) => ({
        values: async (values: Record<string, unknown>) => {
          // Distinguish which table by checking a field only that table's rows have.
          if ("recipient" in values) {
            insertedPayouts.push(values);
          } else {
            insertedSplits.push(values);
            knownSplits.add(values.address as string);
          }
        },
      }),
      find: async (_table: unknown, where: { address: string }) => {
        return knownSplits.has(where.address) ? { address: where.address } : null;
      },
    },
    _insertedSplits: insertedSplits,
    _insertedPayouts: insertedPayouts,
    _knownSplits: knownSplits,
  };
}

describe("handleSplitCreated", () => {
  it("inserts a new onchain_split row for the discovered address", async () => {
    const context = makeMockContext() as any;
    await handleSplitCreated({
      event: {
        args: { split: "0xSplitAddress0000000000000000000000000a" },
        block: { timestamp: 1700000000n },
      } as any,
      context,
    });

    expect(context._insertedSplits).toEqual([
      { address: "0xSplitAddress0000000000000000000000000a", chainId: 84532, createdAt: new Date(1700000000 * 1000) },
    ]);
  });
});

describe("handleWarehouseTransfer", () => {
  it("records a payout when the Transfer's sender is a known Split", async () => {
    const context = makeMockContext() as any;
    context._knownSplits.add("0xSplitAddress0000000000000000000000000a");

    await handleWarehouseTransfer({
      event: {
        args: {
          sender: "0xSplitAddress0000000000000000000000000a",
          receiver: "0xRecipient000000000000000000000000000b",
          id: USDC_TOKEN_ID,
          amount: 5000000n,
        },
        transaction: { hash: "0xtxhash1" },
        block: { number: 100n, timestamp: 1700000100n },
        log: { logIndex: 3 },
      } as any,
      context,
    });

    expect(context._insertedPayouts).toEqual([
      {
        id: "0xtxhash1:3",
        splitAddress: "0xSplitAddress0000000000000000000000000a",
        recipient: "0xRecipient000000000000000000000000000b",
        token: USDC_ADDRESS,
        amount: "5000000",
        usdValue: null,
        txHash: "0xtxhash1",
        blockNumber: 100n,
        chainId: 84532,
        distributedAt: new Date(1700000100 * 1000),
      },
    ]);
  });

  it("ignores a Transfer whose sender is not a known Split", async () => {
    const context = makeMockContext() as any;
    // No Split registered as known.

    await handleWarehouseTransfer({
      event: {
        args: {
          sender: "0xNotASplit00000000000000000000000000000c",
          receiver: "0xRecipient000000000000000000000000000b",
          id: USDC_TOKEN_ID,
          amount: 5000000n,
        },
        transaction: { hash: "0xtxhash2" },
        block: { number: 101n, timestamp: 1700000200n },
        log: { logIndex: 0 },
      } as any,
      context,
    });

    expect(context._insertedPayouts).toEqual([]);
  });
});
