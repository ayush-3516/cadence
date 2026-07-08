import { createRequest, type RequestFn } from "./request.js";

export interface CadenceConfig {
  apiKey: string;
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "http://localhost:3000";

export class Cadence {
  /** @internal exposed for resource classes constructed in later tasks */
  readonly _request: RequestFn;

  constructor(config: CadenceConfig) {
    this._request = createRequest(config.apiKey, config.baseUrl ?? DEFAULT_BASE_URL);
  }
}
