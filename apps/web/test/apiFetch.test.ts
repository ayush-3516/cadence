import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, ApiError } from "../lib/apiFetch.js";

describe("apiFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends credentials: 'include' and the configured base URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await apiFetch("/v1/merchants/me");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/v1/merchants/me");
    expect(init.credentials).toBe("include");
    expect(result).toEqual({ ok: true });
  });

  it("throws an ApiError with the parsed envelope on a non-2xx response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "merchant_not_found", message: "No merchant account exists for this session yet." } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiFetch("/v1/merchants/me")).rejects.toMatchObject({ code: "merchant_not_found", status: 400 });
    await expect(apiFetch("/v1/merchants/me")).rejects.toBeInstanceOf(ApiError);
  });
});
