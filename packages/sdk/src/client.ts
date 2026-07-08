import { createRequest, type RequestFn } from "./request.js";
import { PlansResource } from "./resources/plans.js";
import { SubscriptionsResource } from "./resources/subscriptions.js";
import { CustomersResource } from "./resources/customers.js";
import { InvoicesResource } from "./resources/invoices.js";
import { AnalyticsResource } from "./resources/analytics.js";

export interface CadenceConfig {
  apiKey: string;
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "http://localhost:3000";

export class Cadence {
  /** @internal exposed for resource classes constructed in later tasks */
  readonly _request: RequestFn;
  readonly plans: PlansResource;
  readonly subscriptions: SubscriptionsResource;
  readonly customers: CustomersResource;
  readonly invoices: InvoicesResource;
  readonly analytics: AnalyticsResource;

  constructor(config: CadenceConfig) {
    this._request = createRequest(config.apiKey, config.baseUrl ?? DEFAULT_BASE_URL);
    this.plans = new PlansResource(this._request);
    this.subscriptions = new SubscriptionsResource(this._request);
    this.customers = new CustomersResource(this._request);
    this.invoices = new InvoicesResource(this._request);
    this.analytics = new AnalyticsResource(this._request);
  }
}
