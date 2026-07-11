import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../apiFetch.js";

export interface Payout {
  id: string;
  split_address: string;
  recipient: string;
  token: string;
  amount: string;
  usd_value: string | null;
  tx_hash: string | null;
  distributed_at: string;
}

interface PageEnvelope<T> {
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export function usePayouts() {
  const query = useQuery({
    queryKey: ["payouts"],
    queryFn: () => apiFetch("/v1/payouts") as Promise<PageEnvelope<Payout>>,
  });
  return { ...query, data: query.data?.data };
}
