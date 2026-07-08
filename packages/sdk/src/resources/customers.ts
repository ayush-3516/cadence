import type { RequestFn } from "../request.js";
import type { Customer, PageEnvelope, Subscription } from "../types.js";

export interface ListCustomersFilter {
  limit?: number;
  startingAfter?: string;
}

export class CustomersResource {
  constructor(private readonly request: RequestFn) {}

  async list(filter: ListCustomersFilter = {}): Promise<PageEnvelope<Customer>> {
    const query: Record<string, string | undefined> = {};
    if (filter.limit !== undefined) query.limit = String(filter.limit);
    if (filter.startingAfter !== undefined) query.starting_after = filter.startingAfter;
    return this.request("GET", "/v1/customers", { query }) as Promise<PageEnvelope<Customer>>;
  }

  async subscriptions(address: string, filter: ListCustomersFilter = {}): Promise<PageEnvelope<Subscription>> {
    const query: Record<string, string | undefined> = {};
    if (filter.limit !== undefined) query.limit = String(filter.limit);
    if (filter.startingAfter !== undefined) query.starting_after = filter.startingAfter;
    return this.request("GET", `/v1/customers/${address}/subscriptions`, { query }) as Promise<PageEnvelope<Subscription>>;
  }

  async setEmail(address: string, email: string): Promise<{ address: string; email: string }> {
    return this.request("POST", `/v1/customers/${address}/email`, { body: { email } }) as Promise<{ address: string; email: string }>;
  }
}
