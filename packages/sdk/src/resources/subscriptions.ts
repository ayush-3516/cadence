import type { RequestFn } from "../request.js";
import type { PageEnvelope, Subscription, SubscriptionDetail } from "../types.js";

export interface ListSubscriptionsFilter {
  status?: string;
  planId?: string;
  subscriber?: string;
  limit?: number;
  startingAfter?: string;
}

export class SubscriptionsResource {
  constructor(private readonly request: RequestFn) {}

  async list(filter: ListSubscriptionsFilter = {}): Promise<PageEnvelope<Subscription>> {
    const query: Record<string, string | undefined> = {};
    if (filter.status !== undefined) query.status = filter.status;
    if (filter.planId !== undefined) query.plan_id = filter.planId;
    if (filter.subscriber !== undefined) query.subscriber = filter.subscriber;
    if (filter.limit !== undefined) query.limit = String(filter.limit);
    if (filter.startingAfter !== undefined) query.starting_after = filter.startingAfter;
    return this.request("GET", "/v1/subscriptions", { query }) as Promise<PageEnvelope<Subscription>>;
  }

  async get(onchainId: string): Promise<SubscriptionDetail> {
    return this.request("GET", `/v1/subscriptions/${onchainId}`) as Promise<SubscriptionDetail>;
  }
}
