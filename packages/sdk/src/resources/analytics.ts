import type { RequestFn } from "../request.js";
import type { AnalyticsSummary, CohortRow, MrrPoint } from "../types.js";

export interface AnalyticsRange {
  from?: string;
  to?: string;
}

export class AnalyticsResource {
  constructor(private readonly request: RequestFn) {}

  async summary(): Promise<AnalyticsSummary> {
    return this.request("GET", "/v1/analytics/summary") as Promise<AnalyticsSummary>;
  }

  async mrr(range: AnalyticsRange = {}): Promise<{ data: MrrPoint[] }> {
    const query: Record<string, string | undefined> = {};
    if (range.from !== undefined) query.from = range.from;
    if (range.to !== undefined) query.to = range.to;
    return this.request("GET", "/v1/analytics/mrr", { query }) as Promise<{ data: MrrPoint[] }>;
  }

  async churn(range: AnalyticsRange = {}): Promise<{ churn_rate: number; revenue_churn: number }> {
    const query: Record<string, string | undefined> = {};
    if (range.from !== undefined) query.from = range.from;
    if (range.to !== undefined) query.to = range.to;
    return this.request("GET", "/v1/analytics/churn", { query }) as Promise<{ churn_rate: number; revenue_churn: number }>;
  }

  async cohorts(): Promise<{ data: CohortRow[] }> {
    return this.request("GET", "/v1/analytics/cohorts") as Promise<{ data: CohortRow[] }>;
  }
}
