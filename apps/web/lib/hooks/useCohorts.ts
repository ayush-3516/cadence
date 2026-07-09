import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../apiFetch.js";

export interface CohortOffset {
  month: number;
  retention_pct: number;
}

export interface CohortRow {
  cohort: string;
  cohort_size: number;
  offsets: CohortOffset[];
}

export function useCohorts() {
  const query = useQuery({
    queryKey: ["analytics", "cohorts"],
    queryFn: () => apiFetch("/v1/analytics/cohorts") as Promise<{ data: CohortRow[] }>,
  });
  return { ...query, data: query.data?.data };
}
