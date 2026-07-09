import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { usePortalSubscriptions } from "../lib/hooks/usePortalSubscriptions.js";
import { cadence } from "../lib/cadence-client.js";

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("usePortalSubscriptions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches cadence.customers.subscriptions(address) and returns the unwrapped array", async () => {
    vi.spyOn(cadence.customers, "subscriptions").mockResolvedValue({
      data: [{ id: "1", onchain_sub_id: "1", onchain_plan_id: "7", subscriber: "0xabc", status: "active", current_period_end: "2026-08-01T00:00:00Z", created_at: null }],
      has_more: false,
      next_cursor: null,
    });

    const { result } = renderHook(() => usePortalSubscriptions("0xabc"), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0].onchain_sub_id).toBe("1");
    expect(cadence.customers.subscriptions).toHaveBeenCalledWith("0xabc");
  });

  it("does not fetch when address is undefined (wallet not connected)", async () => {
    const spy = vi.spyOn(cadence.customers, "subscriptions");

    const { result } = renderHook(() => usePortalSubscriptions(undefined), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(spy).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });
});
