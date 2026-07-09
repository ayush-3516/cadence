import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../apiFetch.js";

export interface Subscription {
  id: string;
  onchain_sub_id: string;
  onchain_plan_id: string;
  subscriber: string;
  status: string;
  current_period_end: string;
  created_at: string | null;
}

interface PageEnvelope<T> {
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export function useSubscriptions() {
  const query = useQuery({
    queryKey: ["subscriptions"],
    queryFn: () => apiFetch("/v1/subscriptions") as Promise<PageEnvelope<Subscription>>,
  });
  return { ...query, data: query.data?.data };
}
