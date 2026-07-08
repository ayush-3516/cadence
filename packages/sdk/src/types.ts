export interface PageEnvelope<T> {
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

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

export interface Subscription {
  id: string;
  onchain_sub_id: string;
  onchain_plan_id: string;
  subscriber: string;
  status: string;
  current_period_end: string;
  created_at: string | null;
}

export interface SubscriptionDetail extends Subscription {
  plan: PlanSummary;
  charges: ChargeSummary[];
}
