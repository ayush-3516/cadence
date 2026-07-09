import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../apiFetch.js";

export interface AnalyticsSummary {
  mrr_usd: string;
  arr_usd: string;
  active_subscriptions: number;
  arpu_usd: string;
  gross_volume_30d_usd: string;
  fee_revenue_30d_usd: string;
  churn_rate_30d: number;
}

export function useAnalyticsSummary() {
  return useQuery({
    queryKey: ["analytics", "summary"],
    queryFn: () => apiFetch("/v1/analytics/summary") as Promise<AnalyticsSummary>,
  });
}
