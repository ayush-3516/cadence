import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SubscriptionActions } from "../components/SubscriptionActions.js";

const mockUseSubscriptionWrite = vi.fn();
const mockUseRevokeAllowance = vi.fn();

vi.mock("../lib/hooks/useSubscriptionWrite.js", () => ({
  useSubscriptionWrite: (fn: string) => mockUseSubscriptionWrite(fn),
}));

vi.mock("../lib/hooks/useRevokeAllowance.js", () => ({
  useRevokeAllowance: () => mockUseRevokeAllowance(),
}));

describe("SubscriptionActions", () => {
  beforeEach(() => {
    mockUseSubscriptionWrite.mockReset();
    mockUseSubscriptionWrite.mockReturnValue({ write: vi.fn(), status: "idle", error: null });
    mockUseRevokeAllowance.mockReset();
    mockUseRevokeAllowance.mockReturnValue({ write: vi.fn(), status: "idle", error: null });
  });

  afterEach(() => {
    cleanup();
  });

  it("shows a Pause button (not Resume) when status is active", () => {
    render(<SubscriptionActions subId="1" status="active" token="0x036CbD53842c5426634e7929541eC2318f3dCF7e" />);
    expect(screen.getByRole("button", { name: /pause/i })).toBeDefined();
    expect(screen.queryByRole("button", { name: /^resume$/i })).toBeNull();
  });

  it("shows a Resume button (not Pause) when status is paused", () => {
    render(<SubscriptionActions subId="1" status="paused" token="0x036CbD53842c5426634e7929541eC2318f3dCF7e" />);
    expect(screen.getByRole("button", { name: /resume/i })).toBeDefined();
    expect(screen.queryByRole("button", { name: /^pause$/i })).toBeNull();
  });

  it("always shows Cancel with immediate/at-period-end options", () => {
    render(<SubscriptionActions subId="1" status="active" token="0x036CbD53842c5426634e7929541eC2318f3dCF7e" />);
    expect(screen.getByRole("button", { name: /cancel immediately/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /cancel at period end/i })).toBeDefined();
  });

  it("calls write with the subId and immediate=true when 'Cancel immediately' is clicked", () => {
    const write = vi.fn();
    mockUseSubscriptionWrite.mockReturnValue({ write, status: "idle", error: null });

    render(<SubscriptionActions subId="42" status="active" token="0x036CbD53842c5426634e7929541eC2318f3dCF7e" />);
    fireEvent.click(screen.getByRole("button", { name: /cancel immediately/i }));

    expect(write).toHaveBeenCalledWith("42", [true]);
  });

  it("calls write with the subId and immediate=false when 'Cancel at period end' is clicked", () => {
    const write = vi.fn();
    mockUseSubscriptionWrite.mockReturnValue({ write, status: "idle", error: null });

    render(<SubscriptionActions subId="42" status="active" token="0x036CbD53842c5426634e7929541eC2318f3dCF7e" />);
    fireEvent.click(screen.getByRole("button", { name: /cancel at period end/i }));

    expect(write).toHaveBeenCalledWith("42", [false]);
  });

  it("disables all buttons and shows a status message while a write is in flight", () => {
    mockUseSubscriptionWrite.mockReturnValue({ write: vi.fn(), status: "confirming", error: null });

    render(<SubscriptionActions subId="1" status="active" token="0x036CbD53842c5426634e7929541eC2318f3dCF7e" />);
    expect(screen.getByRole("button", { name: /pause/i })).toHaveProperty("disabled", true);
    expect(screen.getByText(/confirm in your wallet/i)).toBeDefined();
  });

  it("shows a Revoke spending permission button", () => {
    render(<SubscriptionActions subId="1" status="active" token="0x036CbD53842c5426634e7929541eC2318f3dCF7e" />);
    expect(screen.getByRole("button", { name: /revoke spending permission/i })).toBeDefined();
  });

  it("calls revoke's write with the token address when clicked", () => {
    const write = vi.fn();
    mockUseRevokeAllowance.mockReturnValue({ write, status: "idle", error: null });

    render(<SubscriptionActions subId="1" status="active" token="0x036CbD53842c5426634e7929541eC2318f3dCF7e" />);
    fireEvent.click(screen.getByRole("button", { name: /revoke spending permission/i }));

    expect(write).toHaveBeenCalledWith("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
  });

  it("shows clarifying copy that revoke does not cancel the subscription", () => {
    render(<SubscriptionActions subId="1" status="active" token="0x036CbD53842c5426634e7929541eC2318f3dCF7e" />);
    expect(screen.getByText(/subscription itself is not canceled/i)).toBeDefined();
  });

  it("disables the revoke button while any write (including revoke) is in flight", () => {
    mockUseRevokeAllowance.mockReturnValue({ write: vi.fn(), status: "confirming", error: null });

    render(<SubscriptionActions subId="1" status="active" token="0x036CbD53842c5426634e7929541eC2318f3dCF7e" />);
    expect(screen.getByRole("button", { name: /revoke spending permission/i })).toHaveProperty("disabled", true);
  });
});
