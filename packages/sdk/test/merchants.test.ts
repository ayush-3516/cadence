import { describe, expect, it, vi } from "vitest";
import { MerchantsResource } from "../src/resources/merchants.js";
import type { RequestFn } from "../src/request.js";

describe("MerchantsResource", () => {
  it("me() calls GET /v1/merchants/me", async () => {
    const request = vi.fn().mockResolvedValue({ id: "m_1", name: "Acme Co", ownerAddress: "0xabc" }) as unknown as RequestFn;
    const merchants = new MerchantsResource(request);

    const result = await merchants.me();

    expect(request).toHaveBeenCalledWith("GET", "/v1/merchants/me");
    expect(result).toEqual({ id: "m_1", name: "Acme Co", ownerAddress: "0xabc" });
  });
});
