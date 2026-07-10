"use client";

import { useParams } from "next/navigation";
import { useAccount } from "wagmi";
import { usePortalSubscriptions } from "../../../../../lib/hooks/usePortalSubscriptions.js";
import { SubscriptionActions } from "../../../../../components/SubscriptionActions.js";
import { StatusBadge } from "@cadence/ui";

export default function PortalSubscriptionDetailPage() {
  const params = useParams<{ id: string }>();
  const { address } = useAccount();
  const { data, isLoading, error } = usePortalSubscriptions(address);

  if (isLoading) return <p className="font-body text-slate">Loading…</p>;
  if (error) return <p className="font-body text-signal">Could not load subscription.</p>;

  const subscription = data?.find((sub) => sub.onchain_sub_id === params.id);
  if (!subscription) return <p className="font-body text-signal">Subscription not found.</p>;

  return (
    <div>
      <h1 className="font-display text-2xl mb-2">Subscription #{subscription.onchain_sub_id}</h1>
      <div className="flex items-center gap-3 mb-4">
        <StatusBadge status={subscription.status} />
        <span className="font-data text-sm text-slate">{subscription.subscriber}</span>
      </div>
      <SubscriptionActions subId={subscription.onchain_sub_id} status={subscription.status} />
    </div>
  );
}
