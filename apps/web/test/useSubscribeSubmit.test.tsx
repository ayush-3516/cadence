import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import { decodeFunctionData } from "viem";
import { subscriptionManagerAbi } from "@cadence/shared";

const mockSignTypedDataAsync = vi.fn();
const mockSendTransaction = vi.fn();
const mockUseSignTypedData = vi.fn();
const mockUseSendTransaction = vi.fn();
const mockUseWaitForTransactionReceipt = vi.fn();

vi.mock("wagmi", () => ({
  useSignTypedData: () => mockUseSignTypedData(),
  useSendTransaction: () => mockUseSendTransaction(),
  useWaitForTransactionReceipt: (args: unknown) => mockUseWaitForTransactionReceipt(args),
}));

vi.mock("../lib/apiFetch.js", () => ({
  apiFetch: vi.fn().mockResolvedValue({
    permit: {
      domain: { name: "Test USD Coin", version: "2", chainId: 84532, verifyingContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
      types: {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      message: {
        owner: "0x999900000000000000000000000000000000000f",
        spender: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
        value: "20000000",
        nonce: "7",
        deadline: "1234567890",
      },
    },
    subscribe: { to: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9", fn: "subscribeWithPermit", planId: "1", deadline: "1234567890" },
  }),
}));

// A real, valid secp256k1 signature (65 bytes hex) with v=27 (yParityOrV byte 0x1b),
// used so viem's parseSignature can genuinely parse it rather than needing a mock.
const FAKE_SIGNATURE =
  "0x6e100a352ec6ad1b70802290e18aeed190704973570f3b8ed42cb9808e2ea6bf4a90a229a244495b41890987806fcbd2d5d23fc0dbe5f5256c2613c039d76db81b";

describe("useSubscribeSubmit", () => {
  beforeEach(async () => {
    mockSignTypedDataAsync.mockReset();
    mockSignTypedDataAsync.mockResolvedValue(FAKE_SIGNATURE);
    mockSendTransaction.mockReset();
    const { apiFetch } = await import("../lib/apiFetch.js");
    (apiFetch as ReturnType<typeof vi.fn>).mockClear();
    mockUseSignTypedData.mockReturnValue({ signTypedDataAsync: mockSignTypedDataAsync });
    mockUseSendTransaction.mockReturnValue({ sendTransaction: mockSendTransaction, data: undefined, error: null, isPending: false });
    mockUseWaitForTransactionReceipt.mockReturnValue({ isLoading: false, isSuccess: false, error: null });
  });

  afterEach(() => {
    cleanup();
  });

  it("prepares, signs, and submits subscribeWithPermit calldata that decodes back to the expected args", async () => {
    const { useSubscribeSubmit } = await import("../lib/hooks/useSubscribeSubmit.js");
    const { result } = renderHook(() => useSubscribeSubmit());

    act(() => {
      result.current.submit("1", "0x999900000000000000000000000000000000000f");
    });

    await waitFor(() => expect(mockSendTransaction).toHaveBeenCalled());

    const [sentTx] = mockSendTransaction.mock.calls[0];
    expect(sentTx.to).toBe("0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9");

    const decoded = decodeFunctionData({ abi: subscriptionManagerAbi, data: sentTx.data });
    expect(decoded.functionName).toBe("subscribeWithPermit");
    expect(decoded.args[0]).toBe(1n); // planId
    expect(decoded.args[1]).toBe(20000000n); // value
    expect(decoded.args[2]).toBe(1234567890n); // deadline
    expect(typeof decoded.args[3]).toBe("number"); // v, uint8
    expect(decoded.args[3]).toBe(27);
  });

  it("calls signTypedDataAsync with exactly the permit domain/types/message from the prepare response", async () => {
    const { useSubscribeSubmit } = await import("../lib/hooks/useSubscribeSubmit.js");
    const { result } = renderHook(() => useSubscribeSubmit());

    act(() => {
      result.current.submit("1", "0x999900000000000000000000000000000000000f");
    });

    await waitFor(() =>
      expect(mockSignTypedDataAsync).toHaveBeenCalledWith({
        domain: { name: "Test USD Coin", version: "2", chainId: 84532, verifyingContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
        types: {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        primaryType: "Permit",
        message: {
          owner: "0x999900000000000000000000000000000000000f",
          spender: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
          value: "20000000",
          nonce: "7",
          deadline: "1234567890",
        },
      }),
    );
  });

  it("sets status to error and does not sign or submit when the prepare call fails", async () => {
    const { apiFetch } = await import("../lib/apiFetch.js");
    (apiFetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("plan not found"));
    const { useSubscribeSubmit } = await import("../lib/hooks/useSubscribeSubmit.js");
    const { result } = renderHook(() => useSubscribeSubmit());

    act(() => {
      result.current.submit("999", "0x999900000000000000000000000000000000000f");
    });

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error?.message).toBe("plan not found");
    expect(mockSignTypedDataAsync).not.toHaveBeenCalled();
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it("sets status to error and does not submit when signing fails", async () => {
    mockSignTypedDataAsync.mockRejectedValue(new Error("user rejected signature"));
    const { useSubscribeSubmit } = await import("../lib/hooks/useSubscribeSubmit.js");
    const { result } = renderHook(() => useSubscribeSubmit());

    act(() => {
      result.current.submit("1", "0x999900000000000000000000000000000000000f");
    });

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error?.message).toBe("user rejected signature");
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it("reaches done status once the subscribeWithPermit transaction confirms", async () => {
    mockUseSendTransaction.mockReturnValue({ sendTransaction: mockSendTransaction, data: "0xTxHash", error: null, isPending: false });
    mockUseWaitForTransactionReceipt.mockReturnValue({ isLoading: false, isSuccess: true, error: null });
    const { useSubscribeSubmit } = await import("../lib/hooks/useSubscribeSubmit.js");
    const { result } = renderHook(() => useSubscribeSubmit());

    act(() => {
      result.current.submit("1", "0x999900000000000000000000000000000000000f");
    });

    await waitFor(() => expect(result.current.status).toBe("done"));
  });
});
