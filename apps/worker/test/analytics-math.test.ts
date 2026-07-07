import { describe, expect, it } from "vitest";
import { monthlyNormalizedAmount, computeMrrArrArpu, computeChurn } from "../src/analytics-math.js";

describe("monthlyNormalizedAmount", () => {
  it("returns the amount unchanged for an exact 30-day period", () => {
    const result = monthlyNormalizedAmount("20000000", 2_592_000n); // 20 USDC, 30 days
    expect(result).toBeCloseTo(20, 6);
  });

  it("divides roughly by 12 for an annual period", () => {
    const result = monthlyNormalizedAmount("120000000", 31_536_000n); // 120 USDC, 365 days
    expect(result).toBeCloseTo(120 * (30 / 365), 6); // ≈9.86, matches PRD's "annual→/12" shorthand closely
  });

  it("multiplies roughly by 30/7 for a weekly period", () => {
    const result = monthlyNormalizedAmount("7000000", 604_800n); // 7 USDC, 7 days
    expect(result).toBeCloseTo(7 * (30 / 7), 6); // = 30
  });

  it("handles an arbitrary custom period (45 days) with the same continuous formula", () => {
    const result = monthlyNormalizedAmount("45000000", 3_888_000n); // 45 USDC, 45 days
    expect(result).toBeCloseTo(45 * (30 / 45), 6); // = 30
  });
});

describe("computeMrrArrArpu", () => {
  it("sums active-subscription MRR, excludes trialing, computes ARR and ARPU", () => {
    const result = computeMrrArrArpu([
      { status: "active", amountRaw: "20000000", periodSeconds: 2_592_000n },
      { status: "active", amountRaw: "10000000", periodSeconds: 2_592_000n },
      { status: "trialing", amountRaw: "50000000", periodSeconds: 2_592_000n },
      { status: "past_due", amountRaw: "20000000", periodSeconds: 2_592_000n },
    ]);
    expect(result.mrrUsd).toBeCloseTo(30, 6); // only the two "active" rows: 20 + 10
    expect(result.arrUsd).toBeCloseTo(360, 6); // 30 * 12
    expect(result.activeSubs).toBe(2);
    expect(result.trialingSubs).toBe(1);
    expect(result.arpuUsd).toBeCloseTo(15, 6); // 30 / 2
  });

  it("guards ARPU against division by zero when there are no active subs", () => {
    const result = computeMrrArrArpu([{ status: "trialing", amountRaw: "50000000", periodSeconds: 2_592_000n }]);
    expect(result.mrrUsd).toBe(0);
    expect(result.activeSubs).toBe(0);
    expect(result.arpuUsd).toBe(0); // not NaN, not a throw
  });

  it("returns all zeros for an empty subscription list", () => {
    const result = computeMrrArrArpu([]);
    expect(result).toEqual({ mrrUsd: 0, arrUsd: 0, arpuUsd: 0, activeSubs: 0, trialingSubs: 0 });
  });
});

describe("computeChurn", () => {
  it("computes subscriber churn rate and revenue churn over a window", () => {
    const result = computeChurn({ activeSubs: 100, mrrUsd: 5000 }, 5, { mrrUsd: 4900 });
    expect(result.churnRate).toBeCloseTo(0.05, 6); // 5/100
    expect(result.revenueChurn).toBeCloseTo(100 / 5000, 6); // (5000-4900)/5000
  });

  it("guards churn rate against division by zero when starting actives is 0", () => {
    const result = computeChurn({ activeSubs: 0, mrrUsd: 0 }, 0, { mrrUsd: 0 });
    expect(result.churnRate).toBe(0);
    expect(result.revenueChurn).toBe(0);
  });

  it("clamps revenue churn to zero when MRR grew net-positive despite some churn", () => {
    const result = computeChurn({ activeSubs: 100, mrrUsd: 5000 }, 3, { mrrUsd: 5500 });
    expect(result.revenueChurn).toBe(0); // mrr grew — "MRR lost" cannot be negative
  });
});
