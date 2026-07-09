import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../apiFetch.js";
import type { Subscription } from "./useSubscriptions.js";

export interface ChargeSummary {
  id: string;
  status: string;
  amount: string | null;
  platform_fee: string | null;
  net: string | null;
  tx_hash: string;
  charged_at: string;
}

export interface PlanSummary {
  onchain_plan_id: string;
  name: string | null;
  amount: string;
  token: string;
  period_seconds: number;
}

export interface SubscriptionDetail extends Subscription {
  plan: PlanSummary;
  charges: ChargeSummary[];
}

export function useSubscription(onchainId: string) {
  return useQuery({
    queryKey: ["subscriptions", onchainId],
    queryFn: () => apiFetch(`/v1/subscriptions/${onchainId}`) as Promise<SubscriptionDetail>,
  });
}
