import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { usePortalInvoices } from "../lib/hooks/usePortalInvoices.js";
import { cadence } from "../lib/cadence-client.js";
import type { Invoice } from "@cadence/sdk";

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("usePortalInvoices", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches cadence.invoices.list({subscriber: address}) and returns the unwrapped array", async () => {
    const mockInvoice: Invoice = { id: "inv_1", number: "1", pdf_url: "https://example.com/inv1.pdf", tx_hash: "0xabc", amount: "20000000", platform_fee: "150000", net: "19850000", onchain_sub_id: "1", onchain_plan_id: "7", issued_at: "2026-07-01T00:00:00Z" };
    vi.spyOn(cadence.invoices, "list").mockResolvedValue({
      data: [mockInvoice],
      has_more: false,
      next_cursor: null,
    });

    const { result } = renderHook(() => usePortalInvoices("0xabc"), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toHaveLength(1);
    expect(cadence.invoices.list).toHaveBeenCalledWith({ subscriber: "0xabc" });
  });

  it("does not fetch when address is undefined", async () => {
    const spy = vi.spyOn(cadence.invoices, "list");

    const { result } = renderHook(() => usePortalInvoices(undefined), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(spy).not.toHaveBeenCalled();
  });
});
