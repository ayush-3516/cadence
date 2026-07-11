"use client";

import { usePayouts } from "../../../../lib/hooks/usePayouts.js";

export default function PayoutsPage() {
  const { data, isLoading, error } = usePayouts();

  if (isLoading) return <p className="font-body text-slate">Loading…</p>;
  if (error) return <p className="font-body text-signal">Could not load payouts.</p>;

  return (
    <div>
      <h1 className="font-display text-2xl mb-6">Payouts</h1>
      {data?.length === 0 && <p className="font-body text-slate">No payouts yet.</p>}
      <table className="w-full text-sm font-body">
        <thead>
          <tr className="text-left text-slate border-b border-slate/15">
            <th className="py-2">Recipient</th>
            <th className="py-2">Token</th>
            <th className="py-2">Amount</th>
            <th className="py-2">Distributed</th>
            <th className="py-2">Tx</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((payout) => (
            <tr key={payout.id} className="border-b border-slate/10">
              <td className="py-2 font-data">{payout.recipient}</td>
              <td className="py-2 font-data">{payout.token}</td>
              <td className="py-2 font-data tabular-nums">{payout.amount}</td>
              <td className="py-2 font-data tabular-nums">{new Date(payout.distributed_at).toLocaleDateString()}</td>
              <td className="py-2 font-data">
                {payout.tx_hash ? (
                  <a href={`https://sepolia.basescan.org/tx/${payout.tx_hash}`} target="_blank" rel="noreferrer" className="text-sapphire hover:underline">
                    View
                  </a>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
