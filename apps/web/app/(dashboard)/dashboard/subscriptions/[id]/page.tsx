"use client";

import { useParams } from "next/navigation";
import { useSubscription } from "../../../../../lib/hooks/useSubscription.js";
import { StatusBadge, CadencePulse } from "@cadence/ui";

export default function SubscriptionDetailPage() {
  const params = useParams<{ id: string }>();
  const { data, isLoading, error } = useSubscription(params.id);

  if (isLoading) return <p className="font-body text-slate">Loading…</p>;
  if (error) return <p className="font-body text-signal">Could not load subscription.</p>;
  if (!data) return null;

  return (
    <div>
      <h1 className="font-display text-2xl mb-2">{data.plan.name ?? "Untitled plan"}</h1>
      <div className="flex items-center gap-3 mb-6">
        <StatusBadge status={data.status} />
        <span className="font-data text-sm text-slate">{data.subscriber}</span>
      </div>
      <div className="mb-6 max-w-md">
        <CadencePulse periodSeconds={data.plan.period_seconds} currentPeriodEnd={data.current_period_end} />
      </div>
      <h2 className="font-display text-lg mb-3">Charge history</h2>
      <table className="w-full text-sm font-body">
        <thead>
          <tr className="text-left text-slate border-b border-slate/15">
            <th className="py-2">Date</th>
            <th className="py-2">Amount</th>
            <th className="py-2">Status</th>
            <th className="py-2">Tx</th>
          </tr>
        </thead>
        <tbody>
          {data.charges.map((charge) => (
            <tr key={charge.id} className="border-b border-slate/10">
              <td className="py-2 font-data tabular-nums">{new Date(charge.charged_at).toLocaleDateString()}</td>
              <td className="py-2 font-data tabular-nums">{charge.amount}</td>
              <td className="py-2"><StatusBadge status={charge.status} /></td>
              <td className="py-2 font-data text-xs truncate max-w-32">{charge.tx_hash}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
