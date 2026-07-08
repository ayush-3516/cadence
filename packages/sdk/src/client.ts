import { createRequest, type RequestFn } from "./request.js";
import { PlansResource } from "./resources/plans.js";
import { SubscriptionsResource } from "./resources/subscriptions.js";

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

  constructor(config: CadenceConfig) {
    this._request = createRequest(config.apiKey, config.baseUrl ?? DEFAULT_BASE_URL);
    this.plans = new PlansResource(this._request);
    this.subscriptions = new SubscriptionsResource(this._request);
  }
}
