import { useQuery } from "@tanstack/react-query";
import { cadence } from "../cadence-client.js";

export function usePortalSubscriptions(address: string | undefined) {
  const query = useQuery({
    queryKey: ["portal", "subscriptions", address],
    queryFn: () => cadence.customers.subscriptions(address!),
    enabled: address !== undefined,
  });
  return { ...query, data: query.data?.data };
}
