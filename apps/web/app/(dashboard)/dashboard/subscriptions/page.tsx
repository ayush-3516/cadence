"use client";

import Link from "next/link";
import { useSubscriptions } from "../../../../lib/hooks/useSubscriptions.js";
import { StatusBadge, CadencePulse } from "@cadence/ui";

export default function SubscriptionsPage() {
  const { data, isLoading, error } = useSubscriptions();

  if (isLoading) return <p className="font-body text-slate">Loading…</p>;
  if (error) return <p className="font-body text-signal">Could not load subscriptions.</p>;

  return (
    <div>
      <h1 className="font-display text-2xl mb-6">Subscriptions</h1>
      <table className="w-full text-sm font-body">
        <thead>
          <tr className="text-left text-slate border-b border-slate/15">
            <th className="py-2">Subscriber</th>
            <th className="py-2">Status</th>
            <th className="py-2">Cadence</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((sub) => (
            <tr key={sub.onchain_sub_id} className="border-b border-slate/10">
              <td className="py-2">
                <Link href={`/dashboard/subscriptions/${sub.onchain_sub_id}`} className="text-sapphire hover:underline font-data">
                  {sub.subscriber}
                </Link>
              </td>
              <td className="py-2"><StatusBadge status={sub.status} /></td>
              <td className="py-2 w-40">
                <CadencePulse periodSeconds={30 * 86400} currentPeriodEnd={sub.current_period_end} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
