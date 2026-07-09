import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../apiFetch.js";

export interface ChurnResult {
  churn_rate: number;
  revenue_churn: number;
}

export function useChurn() {
  return useQuery({
    queryKey: ["analytics", "churn"],
    queryFn: () => apiFetch("/v1/analytics/churn") as Promise<ChurnResult>,
  });
}
