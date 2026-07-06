import { describe, expect, it, vi } from "vitest";
import { createNonceManager } from "../src/nonce-manager.js";

describe("createNonceManager", () => {
  it("starts from the chain's current transaction count", async () => {
    const publicClient = { getTransactionCount: vi.fn().mockResolvedValue(5) } as any;
    const manager = await createNonceManager(publicClient, "0x0000000000000000000000000000000000dead");

    expect(manager.next()).toBe(5);
  });

  it("increments on every call, never reusing a nonce", async () => {
    const publicClient = { getTransactionCount: vi.fn().mockResolvedValue(10) } as any;
    const manager = await createNonceManager(publicClient, "0x0000000000000000000000000000000000dead");

    expect(manager.next()).toBe(10);
    expect(manager.next()).toBe(11);
    expect(manager.next()).toBe(12);
  });

  it("queries getTransactionCount with the pending block tag", async () => {
    const getTransactionCount = vi.fn().mockResolvedValue(0);
    const publicClient = { getTransactionCount } as any;
    await createNonceManager(publicClient, "0x0000000000000000000000000000000000dead");

    expect(getTransactionCount).toHaveBeenCalledWith({
      address: "0x0000000000000000000000000000000000dead",
      blockTag: "pending",
    });
  });
});
