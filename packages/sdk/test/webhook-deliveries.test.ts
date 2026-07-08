import { describe, expect, it, vi } from "vitest";
import { WebhookDeliveriesResource } from "../src/resources/webhook-deliveries.js";
import type { RequestFn } from "../src/request.js";

describe("WebhookDeliveriesResource", () => {
  it("list() calls GET /v1/webhook-deliveries with the status filter and pagination", async () => {
    const request = vi.fn().mockResolvedValue({ data: [], has_more: false, next_cursor: null }) as unknown as RequestFn;
    const deliveries = new WebhookDeliveriesResource(request);

    await deliveries.list({ status: "failed", limit: 25 });

    expect(request).toHaveBeenCalledWith("GET", "/v1/webhook-deliveries", { query: { status: "failed", limit: "25" } });
  });

  it("replay() calls POST /v1/webhook-deliveries/:id/replay", async () => {
    const request = vi.fn().mockResolvedValue({ id: "wd_1", status: "pending" }) as unknown as RequestFn;
    const deliveries = new WebhookDeliveriesResource(request);

    const result = await deliveries.replay("wd_1");

    expect(request).toHaveBeenCalledWith("POST", "/v1/webhook-deliveries/wd_1/replay");
    expect(result).toEqual({ id: "wd_1", status: "pending" });
  });
});
