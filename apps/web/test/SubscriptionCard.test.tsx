import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SubscriptionCard } from "../components/SubscriptionCard.js";

const mockUsePortalPlan = vi.fn();
const mockUseTokenBalance = vi.fn();

vi.mock("../lib/hooks/usePortalPlan.js", () => ({
  usePortalPlan: (id: string | undefined) => mockUsePortalPlan(id),
}));
vi.mock("../lib/hooks/useTokenBalance.js", () => ({
  useTokenBalance: (token: string | undefined, account: string | undefined) => mockUseTokenBalance(token, account),
}));

const SUBSCRIPTION = {
  id: "1",
  onchain_sub_id: "1",
  onchain_plan_id: "7",
  subscriber: "0xabc",
  status: "active",
  current_period_end: "2026-08-01T00:00:00Z",
  created_at: null,
};

describe("SubscriptionCard", () => {
  beforeEach(() => {
    mockUsePortalPlan.mockReset();
    mockUseTokenBalance.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("passes the subscription's onchain_plan_id to usePortalPlan", () => {
    mockUsePortalPlan.mockReturnValue({ data: undefined, isLoading: true });
    mockUseTokenBalance.mockReturnValue({ balance: undefined, isLoading: true });

    render(<SubscriptionCard subscription={SUBSCRIPTION} account="0xdef" />);

    expect(mockUsePortalPlan).toHaveBeenCalledWith("7");
  });

  it("fetches the balance for the plan's token once the plan loads", () => {
    mockUsePortalPlan.mockReturnValue({
      data: { onchain_plan_id: "7", name: "Pro", amount: "20000000", token: "0xusdc", period_seconds: 2_592_000, trial_seconds: 0, active: true, payout_split: "0x0", dunning_ladder: [], created_at: null, livemode: false, description: null, image_url: null },
      isLoading: false,
    });
    mockUseTokenBalance.mockReturnValue({ balance: 5_000_000n, isLoading: false });

    render(<SubscriptionCard subscription={SUBSCRIPTION} account="0xdef" />);

    expect(mockUseTokenBalance).toHaveBeenCalledWith("0xusdc", "0xdef");
  });

  it("renders a balance warning when the plan is loaded and balance is insufficient", () => {
    mockUsePortalPlan.mockReturnValue({
      data: { onchain_plan_id: "7", name: "Pro", amount: "20000000", token: "0xusdc", period_seconds: 2_592_000, trial_seconds: 0, active: true, payout_split: "0x0", dunning_ladder: [], created_at: null, livemode: false, description: null, image_url: null },
      isLoading: false,
    });
    mockUseTokenBalance.mockReturnValue({ balance: 5_000_000n, isLoading: false });

    render(<SubscriptionCard subscription={SUBSCRIPTION} account="0xdef" />);

    expect(screen.getByText(/insufficient/i)).toBeDefined();
  });

  it("renders no warning while the plan is still loading", () => {
    mockUsePortalPlan.mockReturnValue({ data: undefined, isLoading: true });
    mockUseTokenBalance.mockReturnValue({ balance: undefined, isLoading: true });

    render(<SubscriptionCard subscription={SUBSCRIPTION} account="0xdef" />);

    expect(screen.queryByText(/insufficient/i)).toBeNull();
  });
});
