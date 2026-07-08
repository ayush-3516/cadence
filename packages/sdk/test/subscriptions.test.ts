import { describe, expect, it, vi } from "vitest";
import { SubscriptionsResource } from "../src/resources/subscriptions.js";
import type { RequestFn } from "../src/request.js";

describe("SubscriptionsResource", () => {
  it("list() calls GET /v1/subscriptions with the filter mapped to snake_case query params", async () => {
    const request = vi.fn().mockResolvedValue({ data: [], has_more: false, next_cursor: null }) as unknown as RequestFn;
    const subscriptions = new SubscriptionsResource(request);

    await subscriptions.list({ status: "active", planId: "7", subscriber: "0xabc", limit: 5 });

    expect(request).toHaveBeenCalledWith("GET", "/v1/subscriptions", {
      query: { status: "active", plan_id: "7", subscriber: "0xabc", limit: "5" },
    });
  });

  it("get() calls GET /v1/subscriptions/:onchainId", async () => {
    const request = vi.fn().mockResolvedValue({ onchain_sub_id: "123", status: "active" }) as unknown as RequestFn;
    const subscriptions = new SubscriptionsResource(request);

    const result = await subscriptions.get("123");

    expect(request).toHaveBeenCalledWith("GET", "/v1/subscriptions/123");
    expect(result).toEqual({ onchain_sub_id: "123", status: "active" });
  });
});
