import type { RequestFn } from "../request.js";
import type { PageEnvelope, WebhookDelivery } from "../types.js";

export interface ListWebhookDeliveriesFilter {
  status?: string;
  limit?: number;
  startingAfter?: string;
}

export class WebhookDeliveriesResource {
  constructor(private readonly request: RequestFn) {}

  async list(filter: ListWebhookDeliveriesFilter = {}): Promise<PageEnvelope<WebhookDelivery>> {
    const query: Record<string, string | undefined> = {};
    if (filter.status !== undefined) query.status = filter.status;
    if (filter.limit !== undefined) query.limit = String(filter.limit);
    if (filter.startingAfter !== undefined) query.starting_after = filter.startingAfter;
    return this.request("GET", "/v1/webhook-deliveries", { query }) as Promise<PageEnvelope<WebhookDelivery>>;
  }

  async replay(id: string): Promise<WebhookDelivery> {
    return this.request("POST", `/v1/webhook-deliveries/${id}/replay`) as Promise<WebhookDelivery>;
  }
}
