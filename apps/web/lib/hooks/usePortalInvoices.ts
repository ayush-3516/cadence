import { useQuery } from "@tanstack/react-query";
import { cadence } from "../cadence-client.js";

export function usePortalInvoices(address: string | undefined) {
  const query = useQuery({
    queryKey: ["portal", "invoices", address],
    queryFn: () => cadence.invoices.list({ subscriber: address! }),
    enabled: address !== undefined,
  });
  return { ...query, data: query.data?.data };
}
