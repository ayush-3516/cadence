import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSubscription } from "../lib/hooks/useSubscription.js";

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useSubscription", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches GET /v1/subscriptions/:id and returns the detail shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ onchain_sub_id: "1", status: "active", plan: { name: "Pro" }, charges: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useSubscription("1"), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data?.plan).toEqual({ name: "Pro" });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("/v1/subscriptions/1");
  });
});
