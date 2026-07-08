import { createRequest, type RequestFn } from "./request.js";
import { PlansResource } from "./resources/plans.js";
import { SubscriptionsResource } from "./resources/subscriptions.js";
import { CustomersResource } from "./resources/customers.js";
import { InvoicesResource } from "./resources/invoices.js";
import { AnalyticsResource } from "./resources/analytics.js";
import { WebhookEndpointsResource } from "./resources/webhook-endpoints.js";
import { WebhookDeliveriesResource } from "./resources/webhook-deliveries.js";
import { MerchantsResource } from "./resources/merchants.js";
import { verifySignature } from "./webhooks.js";

export interface CadenceConfig {
  apiKey: string;
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "http://localhost:3000";

export class Cadence {
  /** @internal exposed for resource classes constructed in this file */
  readonly _request: RequestFn;
  readonly plans: PlansResource;
  readonly subscriptions: SubscriptionsResource;
  readonly customers: CustomersResource;
  readonly invoices: InvoicesResource;
  readonly analytics: AnalyticsResource;
  readonly webhookEndpoints: WebhookEndpointsResource;
  readonly webhookDeliveries: WebhookDeliveriesResource;
  readonly merchants: MerchantsResource;
  readonly webhooks: { verifySignature: typeof verifySignature };

  constructor(config: CadenceConfig) {
    this._request = createRequest(config.apiKey, config.baseUrl ?? DEFAULT_BASE_URL);
    this.plans = new PlansResource(this._request);
    this.subscriptions = new SubscriptionsResource(this._request);
    this.customers = new CustomersResource(this._request);
    this.invoices = new InvoicesResource(this._request);
    this.analytics = new AnalyticsResource(this._request);
    this.webhookEndpoints = new WebhookEndpointsResource(this._request);
    this.webhookDeliveries = new WebhookDeliveriesResource(this._request);
    this.merchants = new MerchantsResource(this._request);
    this.webhooks = { verifySignature };
  }
}
