import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../apiFetch.js";

export interface MrrPoint {
  date: string;
  mrr_usd: string;
  arr_usd: string;
}

export function useMrr() {
  const query = useQuery({
    queryKey: ["analytics", "mrr"],
    queryFn: () => apiFetch("/v1/analytics/mrr") as Promise<{ data: MrrPoint[] }>,
  });
  return { ...query, data: query.data?.data };
}
