import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useApiKeys } from "../lib/hooks/useApiKeys.js";

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useApiKeys", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches GET /v1/api-keys and returns the list", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ id: "k1", type: "secret", prefix: "ck_test_sec_abc" }]), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useApiKeys(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual([{ id: "k1", type: "secret", prefix: "ck_test_sec_abc" }]);
  });

  it("createKey() POSTs to /v1/api-keys with the given type", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "k2", key: "ck_test_sec_new", prefix: "ck_test_sec_new" }), { status: 201, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useApiKeys(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let createdKey: string | undefined;
    await act(async () => {
      createdKey = (await result.current.createKey("secret")).key;
    });

    expect(createdKey).toBe("ck_test_sec_new");
    const [, secondCallInit] = fetchMock.mock.calls[1];
    expect(secondCallInit.method).toBe("POST");
    expect(JSON.parse(secondCallInit.body)).toEqual({ type: "secret" });
  });
});
