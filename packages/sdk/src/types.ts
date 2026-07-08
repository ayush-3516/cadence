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

export interface Customer {
  id: string;
  address: string;
  email: string | null;
  subscription_count: number;
}

export interface Invoice {
  id: string;
  number: number;
  pdf_url: string | null;
  tx_hash: string;
  amount: string;
  platform_fee: string;
  net: string;
  onchain_sub_id: string;
  onchain_plan_id: string;
  issued_at: string;
}

export interface AnalyticsSummary {
  mrr_usd: string;
  arr_usd: string;
  active_subscriptions: number;
  arpu_usd: string;
  gross_volume_30d_usd: string;
  fee_revenue_30d_usd: string;
  churn_rate_30d: number;
}

export interface MrrPoint {
  date: string;
  mrr_usd: string;
  arr_usd: string;
}

export interface CohortOffset {
  month: number;
  retention_pct: number;
}

export interface CohortRow {
  cohort: string;
  cohort_size: number;
  offsets: CohortOffset[];
}
