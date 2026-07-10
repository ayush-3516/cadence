import { useQuery } from "@tanstack/react-query";
import { cadence } from "../cadence-client.js";

export function usePortalPlan(onchainPlanId: string | undefined) {
  return useQuery({
    queryKey: ["portal", "plan", onchainPlanId],
    queryFn: () => cadence.plans.get(onchainPlanId!),
    enabled: onchainPlanId !== undefined,
  });
}
