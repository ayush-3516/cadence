import { describe, expect, it, vi } from "vitest";
import { AnalyticsResource } from "../src/resources/analytics.js";
import type { RequestFn } from "../src/request.js";

describe("AnalyticsResource", () => {
  it("summary() calls GET /v1/analytics/summary with no params", async () => {
    const request = vi.fn().mockResolvedValue({ mrr_usd: "1000.000000", active_subscriptions: 5 }) as unknown as RequestFn;
    const analytics = new AnalyticsResource(request);

    const result = await analytics.summary();

    expect(request).toHaveBeenCalledWith("GET", "/v1/analytics/summary");
    expect(result).toEqual({ mrr_usd: "1000.000000", active_subscriptions: 5 });
  });

  it("mrr() calls GET /v1/analytics/mrr with from/to query params", async () => {
    const request = vi.fn().mockResolvedValue({ data: [] }) as unknown as RequestFn;
    const analytics = new AnalyticsResource(request);

    await analytics.mrr({ from: "2026-06-01", to: "2026-06-30" });

    expect(request).toHaveBeenCalledWith("GET", "/v1/analytics/mrr", { query: { from: "2026-06-01", to: "2026-06-30" } });
  });

  it("mrr() with no range sends no query params", async () => {
    const request = vi.fn().mockResolvedValue({ data: [] }) as unknown as RequestFn;
    const analytics = new AnalyticsResource(request);

    await analytics.mrr();

    expect(request).toHaveBeenCalledWith("GET", "/v1/analytics/mrr", { query: {} });
  });

  it("churn() calls GET /v1/analytics/churn with from/to query params", async () => {
    const request = vi.fn().mockResolvedValue({ churn_rate: 0.05, revenue_churn: 0.02 }) as unknown as RequestFn;
    const analytics = new AnalyticsResource(request);

    const result = await analytics.churn({ from: "2026-06-01", to: "2026-06-30" });

    expect(request).toHaveBeenCalledWith("GET", "/v1/analytics/churn", { query: { from: "2026-06-01", to: "2026-06-30" } });
    expect(result).toEqual({ churn_rate: 0.05, revenue_churn: 0.02 });
  });

  it("cohorts() calls GET /v1/analytics/cohorts with no params", async () => {
    const request = vi.fn().mockResolvedValue({ data: [] }) as unknown as RequestFn;
    const analytics = new AnalyticsResource(request);

    await analytics.cohorts();

    expect(request).toHaveBeenCalledWith("GET", "/v1/analytics/cohorts");
  });
});
