import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../apiFetch.js";

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  status: "pending" | "succeeded" | "failed" | "dead";
  attempts: number;
  nextAttemptAt: string | null;
  responseCode: number | null;
  responseBody: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PageEnvelope<T> {
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export function useWebhookDeliveries() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["webhook-deliveries"],
    queryFn: () => apiFetch("/v1/webhook-deliveries") as Promise<PageEnvelope<WebhookDelivery>>,
  });

  async function replay(id: string): Promise<void> {
    await apiFetch(`/v1/webhook-deliveries/${id}/replay`, { method: "POST" });
    await queryClient.invalidateQueries({ queryKey: ["webhook-deliveries"] });
  }

  return { ...query, data: query.data?.data, replay };
}
