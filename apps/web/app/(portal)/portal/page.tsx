"use client";

import { useAccount } from "wagmi";
import { ConnectKitButton } from "connectkit";
import { usePortalSubscriptions } from "../../../lib/hooks/usePortalSubscriptions.js";
import { SubscriptionCard } from "../../../components/SubscriptionCard.js";

export default function PortalPage() {
  const { address, isConnected } = useAccount();
  const { data, isLoading, error } = usePortalSubscriptions(address);

  if (!isConnected) {
    return (
      <div className="flex flex-col items-center mt-24 gap-4">
        <h1 className="font-display text-2xl">Your subscriptions</h1>
        <p className="font-body text-slate">Connect your wallet to view your subscriptions.</p>
        <ConnectKitButton />
      </div>
    );
  }

  if (isLoading) return <p className="font-body text-slate">Loading…</p>;
  if (error) return <p className="font-body text-signal">Could not load subscriptions.</p>;

  return (
    <div>
      <h1 className="font-display text-2xl mb-6">Your subscriptions</h1>
      {data?.length === 0 && <p className="font-body text-slate">No subscriptions yet.</p>}
      <div className="flex flex-col gap-3">
        {data?.map((sub) => (
          <SubscriptionCard key={sub.onchain_sub_id} subscription={sub} account={address} />
        ))}
      </div>
    </div>
  );
}
