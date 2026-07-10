import { describe, expect, it } from "vitest";
import { PreparePlanQuerySchema, PrepareSubscribeQuerySchema } from "../src/prepare/prepare.dto.js";

describe("PreparePlanQuerySchema", () => {
  const validParams = {
    payoutSplit: "0xdef000000000000000000000000000000000000b",
    token: "0x000000000000000000000000000000000000000c",
    amount: "20000000",
    period: "2592000",
    trial: "0",
  };

  it("accepts a fully valid query", () => {
    expect(PreparePlanQuerySchema.safeParse(validParams).success).toBe(true);
  });

  it("rejects a malformed address", () => {
    const result = PreparePlanQuerySchema.safeParse({ ...validParams, payoutSplit: "not-an-address" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-numeric amount", () => {
    const result = PreparePlanQuerySchema.safeParse({ ...validParams, amount: "abc" });
    expect(result.success).toBe(false);
  });

  it("rejects a negative period", () => {
    const result = PreparePlanQuerySchema.safeParse({ ...validParams, period: "-5" });
    expect(result.success).toBe(false);
  });
});

describe("PrepareSubscribeQuerySchema", () => {
  it("accepts a valid query", () => {
    const result = PrepareSubscribeQuerySchema.safeParse({ planId: "1", owner: "0xdef000000000000000000000000000000000000b" });
    expect(result.success).toBe(true);
  });

  it("rejects a malformed owner address", () => {
    const result = PrepareSubscribeQuerySchema.safeParse({ planId: "1", owner: "not-an-address" });
    expect(result.success).toBe(false);
  });
});
