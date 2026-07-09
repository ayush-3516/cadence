"use client";

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { useMrr } from "../../../../lib/hooks/useMrr.js";
import { useChurn } from "../../../../lib/hooks/useChurn.js";
import { useCohorts } from "../../../../lib/hooks/useCohorts.js";

export default function AnalyticsPage() {
  const mrr = useMrr();
  const churn = useChurn();
  const cohorts = useCohorts();

  return (
    <div>
      <h1 className="font-display text-2xl mb-6">Analytics</h1>

      <section className="mb-8">
        <h2 className="font-display text-lg mb-3">MRR</h2>
        {mrr.isLoading && <p className="font-body text-slate">Loading…</p>}
        {mrr.error && <p className="font-body text-signal">Could not load MRR.</p>}
        {mrr.data && (
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={mrr.data}>
              <XAxis dataKey="date" tick={{ fontFamily: "var(--font-data)", fontSize: 11 }} />
              <YAxis tick={{ fontFamily: "var(--font-data)", fontSize: 11 }} />
              <Tooltip contentStyle={{ fontFamily: "var(--font-data)" }} />
              <Line type="monotone" dataKey="mrr_usd" stroke="#2F5BFF" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </section>

      <section className="mb-8">
        <h2 className="font-display text-lg mb-3">Churn (30d)</h2>
        {churn.isLoading && <p className="font-body text-slate">Loading…</p>}
        {churn.error && <p className="font-body text-signal">Could not load churn.</p>}
        {churn.data && (
          <div className="flex gap-6">
            <div className="font-data text-xl tabular-nums">{(churn.data.churn_rate * 100).toFixed(1)}% subscriber churn</div>
            <div className="font-data text-xl tabular-nums">{(churn.data.revenue_churn * 100).toFixed(1)}% revenue churn</div>
          </div>
        )}
      </section>

      <section>
        <h2 className="font-display text-lg mb-3">Cohort retention</h2>
        {cohorts.isLoading && <p className="font-body text-slate">Loading…</p>}
        {cohorts.error && <p className="font-body text-signal">Could not load cohorts.</p>}
        {cohorts.data && (
          <table className="text-sm font-data tabular-nums">
            <thead>
              <tr className="text-left text-slate">
                <th className="pr-4 py-1">Cohort</th>
                <th className="pr-4 py-1">Size</th>
                {cohorts.data[0]?.offsets.map((o) => (
                  <th key={o.month} className="pr-4 py-1">M{o.month}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cohorts.data.map((row) => (
                <tr key={row.cohort}>
                  <td className="pr-4 py-1">{row.cohort}</td>
                  <td className="pr-4 py-1">{row.cohort_size}</td>
                  {row.offsets.map((o) => (
                    <td key={o.month} className="pr-4 py-1">{(o.retention_pct * 100).toFixed(0)}%</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
