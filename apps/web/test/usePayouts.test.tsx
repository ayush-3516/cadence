import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../lib/apiFetch.js", () => ({
  apiFetch: vi.fn().mockResolvedValue({
    data: [
      {
        id: "0xpayout1:0",
        split_address: "0xdef0000000000000000000000000000000000b",
        recipient: "0x2220000000000000000000000000000000000e",
        token: "0x0000000000000000000000000000000000000c",
        amount: "5000000",
        usd_value: null,
        tx_hash: "0xtxhash1",
        distributed_at: "2026-07-01T00:00:00.000Z",
      },
    ],
    has_more: false,
    next_cursor: null,
  }),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
});

describe("usePayouts", () => {
  it("fetches /v1/payouts and unwraps the data array", async () => {
    const { apiFetch } = await import("../lib/apiFetch.js");
    const { usePayouts } = await import("../lib/hooks/usePayouts.js");

    const { result } = renderHook(() => usePayouts(), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(apiFetch).toHaveBeenCalledWith("/v1/payouts");
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0].recipient).toBe("0x2220000000000000000000000000000000000e");
  });
});
