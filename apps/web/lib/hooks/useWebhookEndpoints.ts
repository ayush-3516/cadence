import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../apiFetch.js";

export interface WebhookEndpoint {
  id: string;
  merchantId: string;
  url: string;
  enabledEvents: string[];
  status: "enabled" | "disabled";
  livemode: boolean;
  createdAt: string;
  updatedAt: string;
}

interface PageEnvelope<T> {
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export function useWebhookEndpoints() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["webhook-endpoints"],
    queryFn: () => apiFetch("/v1/webhook-endpoints") as Promise<PageEnvelope<WebhookEndpoint>>,
  });

  async function createEndpoint(url: string, enabledEvents?: string[]): Promise<WebhookEndpoint & { signingSecret: string }> {
    const result = (await apiFetch("/v1/webhook-endpoints", { method: "POST", body: JSON.stringify({ url, enabledEvents }) })) as WebhookEndpoint & {
      signingSecret: string;
    };
    await queryClient.invalidateQueries({ queryKey: ["webhook-endpoints"] });
    return result;
  }

  return { ...query, data: query.data?.data, createEndpoint };
}
