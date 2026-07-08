import { describe, expect, it, vi } from "vitest";
import { WebhookEndpointsResource } from "../src/resources/webhook-endpoints.js";
import type { RequestFn } from "../src/request.js";

describe("WebhookEndpointsResource", () => {
  it("create() calls POST /v1/webhook-endpoints with the body", async () => {
    const request = vi.fn().mockResolvedValue({ id: "we_1", url: "https://example.com/hook", signingSecret: "whsec_abc" }) as unknown as RequestFn;
    const endpoints = new WebhookEndpointsResource(request);

    const result = await endpoints.create({ url: "https://example.com/hook", enabledEvents: ["subscription.created"] });

    expect(request).toHaveBeenCalledWith("POST", "/v1/webhook-endpoints", { body: { url: "https://example.com/hook", enabledEvents: ["subscription.created"] } });
    expect(result.signingSecret).toBe("whsec_abc");
  });

  it("list() calls GET /v1/webhook-endpoints with pagination", async () => {
    const request = vi.fn().mockResolvedValue({ data: [], has_more: false, next_cursor: null }) as unknown as RequestFn;
    const endpoints = new WebhookEndpointsResource(request);

    await endpoints.list({ limit: 10 });

    expect(request).toHaveBeenCalledWith("GET", "/v1/webhook-endpoints", { query: { limit: "10" } });
  });

  it("update() calls PATCH /v1/webhook-endpoints/:id with the body", async () => {
    const request = vi.fn().mockResolvedValue({ id: "we_1", status: "disabled" }) as unknown as RequestFn;
    const endpoints = new WebhookEndpointsResource(request);

    await endpoints.update("we_1", { status: "disabled" });

    expect(request).toHaveBeenCalledWith("PATCH", "/v1/webhook-endpoints/we_1", { body: { status: "disabled" } });
  });

  it("delete() calls DELETE /v1/webhook-endpoints/:id", async () => {
    const request = vi.fn().mockResolvedValue({ deleted: true }) as unknown as RequestFn;
    const endpoints = new WebhookEndpointsResource(request);

    const result = await endpoints.delete("we_1");

    expect(request).toHaveBeenCalledWith("DELETE", "/v1/webhook-endpoints/we_1");
    expect(result).toEqual({ deleted: true });
  });
});
