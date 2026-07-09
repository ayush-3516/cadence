import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../apiFetch.js";

export interface ApiKey {
  id: string;
  type: "secret" | "publishable";
  prefix: string;
  livemode: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

export function useApiKeys() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["api-keys"],
    queryFn: () => apiFetch("/v1/api-keys") as Promise<ApiKey[]>,
  });

  async function createKey(type: "secret" | "publishable"): Promise<{ id: string; key: string; prefix: string }> {
    const result = (await apiFetch("/v1/api-keys", { method: "POST", body: JSON.stringify({ type }) })) as { id: string; key: string; prefix: string };
    await queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    return result;
  }

  async function revokeKey(id: string): Promise<void> {
    await apiFetch(`/v1/api-keys/${id}`, { method: "DELETE" });
    await queryClient.invalidateQueries({ queryKey: ["api-keys"] });
  }

  return { ...query, createKey, revokeKey };
}
