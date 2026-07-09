import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../apiFetch.js";

export interface Plan {
  onchain_plan_id: string;
  name: string | null;
  description: string | null;
  image_url: string | null;
  amount: string;
  token: string;
  period_seconds: number;
  trial_seconds: number;
  active: boolean;
  payout_split: string;
  dunning_ladder: string[];
  created_at: string | null;
  livemode: boolean;
}

interface PageEnvelope<T> {
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export function usePlans() {
  const query = useQuery({
    queryKey: ["plans"],
    queryFn: () => apiFetch("/v1/plans") as Promise<PageEnvelope<Plan>>,
  });
  return { ...query, data: query.data?.data };
}
