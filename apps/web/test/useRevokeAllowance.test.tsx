import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";

const mockWriteContract = vi.fn();
const mockUseWriteContract = vi.fn();
const mockUseWaitForTransactionReceipt = vi.fn();

vi.mock("wagmi", () => ({
  useWriteContract: () => mockUseWriteContract(),
  useWaitForTransactionReceipt: (args: unknown) => mockUseWaitForTransactionReceipt(args),
}));

const SUBSCRIPTION_MANAGER_ADDRESS = "0x0000000000000000000000000000000000000000";
const TOKEN_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

describe("useRevokeAllowance", () => {
  beforeEach(() => {
    mockWriteContract.mockReset();
    mockUseWriteContract.mockReturnValue({ writeContract: mockWriteContract, data: undefined, error: null, isPending: false });
    mockUseWaitForTransactionReceipt.mockReturnValue({ isLoading: false, isSuccess: false, error: null });
  });

  afterEach(() => {
    cleanup();
  });

  it("calls writeContract with approve(spender, 0) against the given token address", async () => {
    const { useRevokeAllowance } = await import("../lib/hooks/useRevokeAllowance.js");
    const { result } = renderHook(() => useRevokeAllowance());

    act(() => {
      result.current.write(TOKEN_ADDRESS);
    });

    expect(mockWriteContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: TOKEN_ADDRESS,
        functionName: "approve",
        args: [SUBSCRIPTION_MANAGER_ADDRESS, 0n],
      }),
    );
  });

  it("transitions through confirming to done on success", async () => {
    mockUseWriteContract.mockReturnValue({ writeContract: mockWriteContract, data: "0xTxHash", error: null, isPending: false });
    mockUseWaitForTransactionReceipt.mockReturnValue({ isLoading: false, isSuccess: true, error: null });
    const { useRevokeAllowance } = await import("../lib/hooks/useRevokeAllowance.js");
    const { result } = renderHook(() => useRevokeAllowance());

    act(() => {
      result.current.write(TOKEN_ADDRESS);
    });

    await waitFor(() => expect(result.current.status).toBe("processing"));
  });

  it("sets status to error when the write fails", async () => {
    mockUseWriteContract.mockReturnValue({ writeContract: mockWriteContract, data: undefined, error: new Error("user rejected"), isPending: false });
    const { useRevokeAllowance } = await import("../lib/hooks/useRevokeAllowance.js");
    const { result } = renderHook(() => useRevokeAllowance());

    act(() => {
      result.current.write(TOKEN_ADDRESS);
    });

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error?.message).toBe("user rejected");
  });
});
