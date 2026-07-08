import { describe, expect, it, vi } from "vitest";
import { InvoicesResource } from "../src/resources/invoices.js";
import type { RequestFn } from "../src/request.js";

describe("InvoicesResource", () => {
  it("list() calls GET /v1/invoices with the subscriber filter and pagination", async () => {
    const request = vi.fn().mockResolvedValue({ data: [], has_more: false, next_cursor: null }) as unknown as RequestFn;
    const invoices = new InvoicesResource(request);

    await invoices.list({ subscriber: "0xabc", limit: 10 });

    expect(request).toHaveBeenCalledWith("GET", "/v1/invoices", { query: { subscriber: "0xabc", limit: "10" } });
  });

  it("list() with no filter sends no query params", async () => {
    const request = vi.fn().mockResolvedValue({ data: [], has_more: false, next_cursor: null }) as unknown as RequestFn;
    const invoices = new InvoicesResource(request);

    await invoices.list();

    expect(request).toHaveBeenCalledWith("GET", "/v1/invoices", { query: {} });
  });

  it("get() calls GET /v1/invoices/:id", async () => {
    const request = vi.fn().mockResolvedValue({ id: "inv_1", number: 1 }) as unknown as RequestFn;
    const invoices = new InvoicesResource(request);

    const result = await invoices.get("inv_1");

    expect(request).toHaveBeenCalledWith("GET", "/v1/invoices/inv_1");
    expect(result).toEqual({ id: "inv_1", number: 1 });
  });
});
