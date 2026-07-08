import type { RequestFn } from "../request.js";
import type { Invoice, PageEnvelope } from "../types.js";

export interface ListInvoicesFilter {
  subscriber?: string;
  limit?: number;
  startingAfter?: string;
}

export class InvoicesResource {
  constructor(private readonly request: RequestFn) {}

  async list(filter: ListInvoicesFilter = {}): Promise<PageEnvelope<Invoice>> {
    const query: Record<string, string | undefined> = {};
    if (filter.subscriber !== undefined) query.subscriber = filter.subscriber;
    if (filter.limit !== undefined) query.limit = String(filter.limit);
    if (filter.startingAfter !== undefined) query.starting_after = filter.startingAfter;
    return this.request("GET", "/v1/invoices", { query }) as Promise<PageEnvelope<Invoice>>;
  }

  async get(id: string): Promise<Invoice> {
    return this.request("GET", `/v1/invoices/${id}`) as Promise<Invoice>;
  }
}
