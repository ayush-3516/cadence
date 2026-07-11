import { describe, expect, it } from "vitest";
import { splitV2FactoryAbi } from "../abis/SplitV2Factory.js";
import { splitsWarehouseAbi } from "../abis/SplitsWarehouse.js";

describe("splitV2FactoryAbi", () => {
  it("includes the SplitCreated event with a split address and a splitParams tuple", () => {
    const event = splitV2FactoryAbi.find((entry) => entry.type === "event" && entry.name === "SplitCreated");
    expect(event).toBeDefined();
    // @ts-expect-error -- narrowed by the find() above at runtime
    const splitInput = event.inputs.find((i: { name: string }) => i.name === "split");
    expect(splitInput).toEqual({ indexed: true, internalType: "address", name: "split", type: "address" });
  });
});

describe("splitsWarehouseAbi", () => {
  it("includes the ERC6909 Transfer event with sender/receiver/id/amount", () => {
    const event = splitsWarehouseAbi.find((entry) => entry.type === "event" && entry.name === "Transfer");
    expect(event).toBeDefined();
    // @ts-expect-error -- narrowed by the find() above at runtime
    const names = event.inputs.map((i: { name: string }) => i.name);
    expect(names).toEqual(["caller", "sender", "receiver", "id", "amount"]);
  });
});
