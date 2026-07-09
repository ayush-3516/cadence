import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMrr } from "../lib/hooks/useMrr.js";

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useMrr", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches GET /v1/analytics/mrr and returns the time series", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ date: "2026-06-01", mrr_usd: "1000.000000", arr_usd: "12000.000000" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useMrr(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual([{ date: "2026-06-01", mrr_usd: "1000.000000", arr_usd: "12000.000000" }]);
  });
});
