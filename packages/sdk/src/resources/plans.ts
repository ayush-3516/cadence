import type { RequestFn } from "../request.js";
import type { PageEnvelope, Plan } from "../types.js";

export interface ListPlansFilter {
  active?: boolean;
  limit?: number;
  startingAfter?: string;
}

export interface AttachPlanMetadataBody {
  name: string;
  description?: string;
  imageUrl?: string;
  dunningLadder?: string[];
}

export class PlansResource {
  constructor(private readonly request: RequestFn) {}

  async list(filter: ListPlansFilter = {}): Promise<PageEnvelope<Plan>> {
    const query: Record<string, string | undefined> = {};
    if (filter.active !== undefined) query.active = String(filter.active);
    if (filter.limit !== undefined) query.limit = String(filter.limit);
    if (filter.startingAfter !== undefined) query.starting_after = filter.startingAfter;
    return this.request("GET", "/v1/plans", { query }) as Promise<PageEnvelope<Plan>>;
  }

  async get(onchainId: string): Promise<Plan> {
    return this.request("GET", `/v1/plans/${onchainId}`) as Promise<Plan>;
  }

  async attachMetadata(onchainId: string, body: AttachPlanMetadataBody): Promise<Plan> {
    return this.request("POST", `/v1/plans/${onchainId}/metadata`, { body }) as Promise<Plan>;
  }
}
