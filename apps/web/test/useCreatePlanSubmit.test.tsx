import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { cleanup } from "@testing-library/react";
import type { PlanDetailsFormValues } from "../components/plans/PlanDetailsForm.js";

const mockCreateSplit = vi.fn();
const mockSendTransaction = vi.fn();
const mockUsePublicClient = vi.fn();
const mockUseWalletClient = vi.fn();
const mockUseSendTransaction = vi.fn();
const mockUseWaitForTransactionReceipt = vi.fn();

vi.mock("@0xsplits/splits-sdk", () => ({
  SplitV2Client: vi.fn().mockImplementation(() => ({ createSplit: mockCreateSplit })),
  SplitV2Type: { Pull: "pull" },
}));

vi.mock("wagmi", () => ({
  usePublicClient: () => mockUsePublicClient(),
  useWalletClient: () => mockUseWalletClient(),
  useSendTransaction: () => mockUseSendTransaction(),
  useWaitForTransactionReceipt: (args: unknown) => mockUseWaitForTransactionReceipt(args),
}));

vi.mock("../lib/apiFetch.js", () => ({
  apiFetch: vi.fn().mockResolvedValue({ to: "0xManagerAddress", data: "0xCalldata", value: "0" }),
}));

const SINGLE_RECIPIENT_VALUES: PlanDetailsFormValues = {
  amount: "20.00",
  periodSeconds: 2592000,
  trialSeconds: 0,
  recipients: [{ address: "0xdef000000000000000000000000000000000000b", percentage: "100" }],
};

const TWO_RECIPIENT_VALUES: PlanDetailsFormValues = {
  amount: "20.00",
  periodSeconds: 2592000,
  trialSeconds: 0,
  recipients: [
    { address: "0xdef000000000000000000000000000000000000b", percentage: "60" },
    { address: "0x999900000000000000000000000000000000000f", percentage: "40" },
  ],
};

describe("useCreatePlanSubmit", () => {
  beforeEach(async () => {
    mockCreateSplit.mockReset();
    mockSendTransaction.mockReset();
    const { apiFetch } = await import("../lib/apiFetch.js");
    (apiFetch as ReturnType<typeof vi.fn>).mockClear();
    mockUsePublicClient.mockReturnValue({});
    mockUseWalletClient.mockReturnValue({ data: {} });
    mockUseSendTransaction.mockReturnValue({ sendTransaction: mockSendTransaction, data: undefined, error: null, isPending: false });
    mockUseWaitForTransactionReceipt.mockReturnValue({ isLoading: false, isSuccess: false, error: null });
  });

  afterEach(() => {
    cleanup();
  });

  it("skips Split deployment for a single recipient and uses their raw address", async () => {
    const { apiFetch } = await import("../lib/apiFetch.js");
    const { useCreatePlanSubmit } = await import("../lib/hooks/useCreatePlanSubmit.js");

    const { result } = renderHook(() => useCreatePlanSubmit());
    act(() => {
      result.current.submit(SINGLE_RECIPIENT_VALUES);
    });

    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(mockCreateSplit).not.toHaveBeenCalled();
    const [path] = (apiFetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toContain("payoutSplit=0xdef000000000000000000000000000000000000b");
  });

  it("deploys a Split for two recipients before preparing the plan", async () => {
    mockCreateSplit.mockResolvedValue({ splitAddress: "0xSplitAddress", event: {} });
    const { apiFetch } = await import("../lib/apiFetch.js");
    const { useCreatePlanSubmit } = await import("../lib/hooks/useCreatePlanSubmit.js");

    const { result } = renderHook(() => useCreatePlanSubmit());
    act(() => {
      result.current.submit(TWO_RECIPIENT_VALUES);
    });

    await waitFor(() => expect(mockCreateSplit).toHaveBeenCalledWith(
      expect.objectContaining({
        recipients: [
          { address: "0xdef000000000000000000000000000000000000b", percentAllocation: 60 },
          { address: "0x999900000000000000000000000000000000000f", percentAllocation: 40 },
        ],
      }),
    ));
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const [path] = (apiFetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toContain("payoutSplit=0xSplitAddress");
  });

  it("sets status to error and stops when Split deployment fails", async () => {
    mockCreateSplit.mockRejectedValue(new Error("split deploy failed"));
    const { useCreatePlanSubmit } = await import("../lib/hooks/useCreatePlanSubmit.js");

    const { result } = renderHook(() => useCreatePlanSubmit());
    act(() => {
      result.current.submit(TWO_RECIPIENT_VALUES);
    });

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error?.message).toBe("split deploy failed");
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it("calls sendTransaction with the calldata returned from /v1/prepare/plan", async () => {
    const { useCreatePlanSubmit } = await import("../lib/hooks/useCreatePlanSubmit.js");

    const { result } = renderHook(() => useCreatePlanSubmit());
    act(() => {
      result.current.submit(SINGLE_RECIPIENT_VALUES);
    });

    await waitFor(() =>
      expect(mockSendTransaction).toHaveBeenCalledWith({
        to: "0xManagerAddress",
        data: "0xCalldata",
        value: 0n,
      }),
    );
  });

  it("reaches done status once the createPlan transaction confirms", async () => {
    mockUseSendTransaction.mockReturnValue({ sendTransaction: mockSendTransaction, data: "0xTxHash", error: null, isPending: false });
    mockUseWaitForTransactionReceipt.mockReturnValue({ isLoading: false, isSuccess: true, error: null });
    const { useCreatePlanSubmit } = await import("../lib/hooks/useCreatePlanSubmit.js");

    const { result } = renderHook(() => useCreatePlanSubmit());
    act(() => {
      result.current.submit(SINGLE_RECIPIENT_VALUES);
    });

    await waitFor(() => expect(result.current.status).toBe("done"));
  });
});
