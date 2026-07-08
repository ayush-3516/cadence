import type { RequestFn } from "../request.js";
import type { PageEnvelope, WebhookEndpoint } from "../types.js";

export interface CreateWebhookEndpointBody {
  url: string;
  enabledEvents?: string[];
}

export interface UpdateWebhookEndpointBody {
  url?: string;
  enabledEvents?: string[];
  status?: "enabled" | "disabled";
}

export interface ListWebhookEndpointsFilter {
  limit?: number;
  startingAfter?: string;
}

export class WebhookEndpointsResource {
  constructor(private readonly request: RequestFn) {}

  async create(body: CreateWebhookEndpointBody): Promise<WebhookEndpoint & { signingSecret: string }> {
    return this.request("POST", "/v1/webhook-endpoints", { body }) as Promise<WebhookEndpoint & { signingSecret: string }>;
  }

  async list(filter: ListWebhookEndpointsFilter = {}): Promise<PageEnvelope<WebhookEndpoint>> {
    const query: Record<string, string | undefined> = {};
    if (filter.limit !== undefined) query.limit = String(filter.limit);
    if (filter.startingAfter !== undefined) query.starting_after = filter.startingAfter;
    return this.request("GET", "/v1/webhook-endpoints", { query }) as Promise<PageEnvelope<WebhookEndpoint>>;
  }

  async update(id: string, body: UpdateWebhookEndpointBody): Promise<WebhookEndpoint> {
    return this.request("PATCH", `/v1/webhook-endpoints/${id}`, { body }) as Promise<WebhookEndpoint>;
  }

  async delete(id: string): Promise<{ deleted: true }> {
    return this.request("DELETE", `/v1/webhook-endpoints/${id}`) as Promise<{ deleted: true }>;
  }
}
