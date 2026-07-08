import { describe, expect, it, vi } from "vitest";
import { PlansResource } from "../src/resources/plans.js";
import type { RequestFn } from "../src/request.js";

describe("PlansResource", () => {
  it("list() calls GET /v1/plans with the filter as query params", async () => {
    const request = vi.fn().mockResolvedValue({ data: [], has_more: false, next_cursor: null }) as unknown as RequestFn;
    const plans = new PlansResource(request);

    await plans.list({ active: true, limit: 10, startingAfter: "7" });

    expect(request).toHaveBeenCalledWith("GET", "/v1/plans", {
      query: { active: "true", limit: "10", starting_after: "7" },
    });
  });

  it("list() with no filter sends no query params", async () => {
    const request = vi.fn().mockResolvedValue({ data: [], has_more: false, next_cursor: null }) as unknown as RequestFn;
    const plans = new PlansResource(request);

    await plans.list();

    expect(request).toHaveBeenCalledWith("GET", "/v1/plans", { query: {} });
  });

  it("get() calls GET /v1/plans/:onchainId", async () => {
    const request = vi.fn().mockResolvedValue({ onchain_plan_id: "7", name: "Pro" }) as unknown as RequestFn;
    const plans = new PlansResource(request);

    const result = await plans.get("7");

    expect(request).toHaveBeenCalledWith("GET", "/v1/plans/7");
    expect(result).toEqual({ onchain_plan_id: "7", name: "Pro" });
  });

  it("attachMetadata() calls POST /v1/plans/:onchainId/metadata with the body", async () => {
    const request = vi.fn().mockResolvedValue({ onchain_plan_id: "7", name: "Pro API" }) as unknown as RequestFn;
    const plans = new PlansResource(request);

    await plans.attachMetadata("7", { name: "Pro API", description: "desc" });

    expect(request).toHaveBeenCalledWith("POST", "/v1/plans/7/metadata", { body: { name: "Pro API", description: "desc" } });
  });
});
