import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequest } from "../src/request.js";
import { CadenceError } from "../src/errors.js";

describe("createRequest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the Authorization header, base URL, and method for a GET request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = createRequest("ck_test_sec_abc123", "http://localhost:3000");
    const result = await request("GET", "/v1/plans");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3000/v1/plans");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer ck_test_sec_abc123");
    expect(result).toEqual({ ok: true });
  });

  it("serializes query params, omitting undefined values", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = createRequest("ck_test_sec_abc123", "http://localhost:3000");
    await request("GET", "/v1/subscriptions", { query: { status: "active", plan_id: undefined, limit: "10" } });

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3000/v1/subscriptions?status=active&limit=10");
  });

  it("JSON-encodes the request body and sets Content-Type for POST", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "1" }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = createRequest("ck_test_sec_abc123", "http://localhost:3000");
    await request("POST", "/v1/webhook-endpoints", { body: { url: "https://example.com/hook", enabledEvents: ["*"] } });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ url: "https://example.com/hook", enabledEvents: ["*"] });
  });

  it("throws a CadenceError with the parsed envelope fields on a non-2xx response", async () => {
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Response(
          JSON.stringify({ error: { type: "invalid_request_error", code: "plan_not_found", message: "No plan with id 42", param: "plan_id" } }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = createRequest("ck_test_sec_abc123", "http://localhost:3000");
    await expect(request("GET", "/v1/plans/42")).rejects.toMatchObject({
      type: "invalid_request_error",
      code: "plan_not_found",
      message: "No plan with id 42",
      param: "plan_id",
      status: 404,
    });
    await expect(request("GET", "/v1/plans/42")).rejects.toBeInstanceOf(CadenceError);
  });

  it("throws a CadenceError with type api_error and the raw status when the body isn't the expected envelope", async () => {
    const fetchMock = vi.fn().mockImplementation(() => new Response("Internal Server Error", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const request = createRequest("ck_test_sec_abc123", "http://localhost:3000");
    await expect(request("GET", "/v1/plans")).rejects.toMatchObject({ type: "api_error", status: 500 });
  });
});
