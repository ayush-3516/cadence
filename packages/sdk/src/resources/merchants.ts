import type { RequestFn } from "../request.js";
import type { Merchant } from "../types.js";

export class MerchantsResource {
  constructor(private readonly request: RequestFn) {}

  async me(): Promise<Merchant> {
    return this.request("GET", "/v1/merchants/me") as Promise<Merchant>;
  }
}
