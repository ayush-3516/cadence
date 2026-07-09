import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { SignInButton } from "../components/SignInButton.js";

const mockSignMessageAsync = vi.fn();
const mockUseAccount = vi.fn();

// A real, EIP-55 checksummed test address (deterministically derived from a
// well-known test private key), required because siwe's SiweMessage
// constructor validates the address strictly and rejects malformed/
// non-checksummed fixtures before signMessageAsync is ever called.
const TEST_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";

vi.mock("wagmi", () => ({
  useAccount: () => mockUseAccount(),
  useSignMessage: () => ({ signMessageAsync: mockSignMessageAsync }),
}));

// SignInButton renders <ConnectKitButton /> when disconnected, which requires
// a ConnectKitProvider context. The component under test is rendered
// standalone (no providers) here, so connectkit is mocked too.
vi.mock("connectkit", () => ({
  ConnectKitButton: () => <button type="button">Connect Wallet</button>,
}));

describe("SignInButton", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mockSignMessageAsync.mockReset();
    mockUseAccount.mockReset();
  });

  // @testing-library/react's auto-cleanup relies on globalThis.afterEach,
  // which isn't registered here since this project's vitest config doesn't
  // set test.globals: true. Without explicit cleanup, the DOM from the first
  // test's render() leaks into the second test.
  afterEach(() => {
    cleanup();
  });

  it("fetches a nonce, signs the SIWE message, and calls verify on click", async () => {
    mockUseAccount.mockReturnValue({ address: TEST_ADDRESS, isConnected: true, chainId: 84532 });
    mockSignMessageAsync.mockResolvedValue("0xsignature");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ nonce: "abc12345" }), { status: 201, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ address: TEST_ADDRESS }), { status: 201, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const onSignedIn = vi.fn();
    render(<SignInButton onSignedIn={onSignedIn} />);

    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockSignMessageAsync).toHaveBeenCalledOnce();
  });

  it("shows a connect prompt instead of a sign-in button when no wallet is connected", () => {
    mockUseAccount.mockReturnValue({ address: undefined, isConnected: false, chainId: undefined });

    render(<SignInButton onSignedIn={vi.fn()} />);

    expect(screen.queryByRole("button", { name: /sign in/i })).toBeNull();
  });
});
