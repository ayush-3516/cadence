import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const mockUsePortalPlan = vi.fn();
const mockUseAccount = vi.fn();
const mockUseSubscribeSubmit = vi.fn();

vi.mock("../lib/hooks/usePortalPlan.js", () => ({
  usePortalPlan: (id: string | undefined) => mockUsePortalPlan(id),
}));

vi.mock("wagmi", () => ({
  useAccount: () => mockUseAccount(),
}));

vi.mock("connectkit", () => ({
  ConnectKitButton: () => <button type="button">Connect Wallet</button>,
}));

vi.mock("../lib/hooks/useSubscribeSubmit.js", () => ({
  useSubscribeSubmit: () => mockUseSubscribeSubmit(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ planId: "1" }),
  useRouter: () => ({ push: vi.fn() }),
}));

const PLAN = {
  onchain_plan_id: "1",
  name: "Pro Plan",
  amount: "20000000",
  token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  period_seconds: 2592000,
};

describe("SubscribePage", () => {
  beforeEach(() => {
    mockUsePortalPlan.mockReset();
    mockUseAccount.mockReset();
    mockUseSubscribeSubmit.mockReset();
    mockUsePortalPlan.mockReturnValue({ data: PLAN, isLoading: false, error: null });
    mockUseAccount.mockReturnValue({ address: undefined, isConnected: false });
    mockUseSubscribeSubmit.mockReturnValue({ status: "idle", error: null, submit: vi.fn() });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the plan's name and price before the wallet is connected, with no ConnectKitButton visible yet", async () => {
    const { default: SubscribePage } = await import("../app/(portal)/portal/subscribe/[planId]/page.js");
    render(<SubscribePage />);

    expect(screen.getByText(/pro plan/i)).toBeDefined();
    expect(screen.getByText(/20000000/)).toBeDefined();
    expect(screen.queryByText(/connect wallet/i)).toBeNull();
  });

  it("shows ConnectKitButton instead of a submit action when Subscribe is clicked while disconnected", async () => {
    const { default: SubscribePage } = await import("../app/(portal)/portal/subscribe/[planId]/page.js");
    render(<SubscribePage />);

    fireEvent.click(screen.getByRole("button", { name: /subscribe/i }));
    expect(screen.getByText(/connect wallet/i)).toBeDefined();
  });

  it("calls submit with planId and the connected address when Subscribe is clicked while connected", async () => {
    const submit = vi.fn();
    mockUseAccount.mockReturnValue({ address: "0x999900000000000000000000000000000000000f", isConnected: true });
    mockUseSubscribeSubmit.mockReturnValue({ status: "idle", error: null, submit });
    const { default: SubscribePage } = await import("../app/(portal)/portal/subscribe/[planId]/page.js");
    render(<SubscribePage />);

    fireEvent.click(screen.getByRole("button", { name: /subscribe/i }));
    expect(submit).toHaveBeenCalledWith("1", "0x999900000000000000000000000000000000000f");
  });

  it("shows a status message and disables Subscribe while signing", async () => {
    mockUseAccount.mockReturnValue({ address: "0x999900000000000000000000000000000000000f", isConnected: true });
    mockUseSubscribeSubmit.mockReturnValue({ status: "signing", error: null, submit: vi.fn() });
    const { default: SubscribePage } = await import("../app/(portal)/portal/subscribe/[planId]/page.js");
    render(<SubscribePage />);

    expect(screen.getByText(/sign in your wallet/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /subscribe/i })).toHaveProperty("disabled", true);
  });

  it("shows the error message and a Retry button on error", async () => {
    mockUseAccount.mockReturnValue({ address: "0x999900000000000000000000000000000000000f", isConnected: true });
    mockUseSubscribeSubmit.mockReturnValue({ status: "error", error: new Error("boom"), submit: vi.fn() });
    const { default: SubscribePage } = await import("../app/(portal)/portal/subscribe/[planId]/page.js");
    render(<SubscribePage />);

    expect(screen.getByText(/boom/)).toBeDefined();
    expect(screen.getByRole("button", { name: /retry/i })).toBeDefined();
  });

  it("shows a not-found message when the plan fails to load", async () => {
    mockUsePortalPlan.mockReturnValue({ data: undefined, isLoading: false, error: new Error("not found") });
    const { default: SubscribePage } = await import("../app/(portal)/portal/subscribe/[planId]/page.js");
    render(<SubscribePage />);

    expect(screen.getByText(/could not load|not found/i)).toBeDefined();
  });
});
