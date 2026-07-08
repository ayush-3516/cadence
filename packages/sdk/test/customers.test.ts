import { describe, expect, it, vi } from "vitest";
import { CustomersResource } from "../src/resources/customers.js";
import type { RequestFn } from "../src/request.js";

describe("CustomersResource", () => {
  it("list() calls GET /v1/customers with pagination query params", async () => {
    const request = vi.fn().mockResolvedValue({ data: [], has_more: false, next_cursor: null }) as unknown as RequestFn;
    const customers = new CustomersResource(request);

    await customers.list({ limit: 20, startingAfter: "0xabc" });

    expect(request).toHaveBeenCalledWith("GET", "/v1/customers", { query: { limit: "20", starting_after: "0xabc" } });
  });

  it("subscriptions() calls GET /v1/customers/:address/subscriptions", async () => {
    const request = vi.fn().mockResolvedValue({ data: [], has_more: false, next_cursor: null }) as unknown as RequestFn;
    const customers = new CustomersResource(request);

    await customers.subscriptions("0xabc", { limit: 5 });

    expect(request).toHaveBeenCalledWith("GET", "/v1/customers/0xabc/subscriptions", { query: { limit: "5" } });
  });

  it("setEmail() calls POST /v1/customers/:address/email with the email body", async () => {
    const request = vi.fn().mockResolvedValue({ address: "0xabc", email: "a@b.com" }) as unknown as RequestFn;
    const customers = new CustomersResource(request);

    const result = await customers.setEmail("0xabc", "a@b.com");

    expect(request).toHaveBeenCalledWith("POST", "/v1/customers/0xabc/email", { body: { email: "a@b.com" } });
    expect(result).toEqual({ address: "0xabc", email: "a@b.com" });
  });
});
