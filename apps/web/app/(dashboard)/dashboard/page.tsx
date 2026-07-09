"use client";

import { useAnalyticsSummary } from "../../../lib/hooks/useAnalyticsSummary.js";

export default function DashboardOverviewPage() {
  const { data, isLoading, error } = useAnalyticsSummary();

  if (isLoading) return <p className="font-body text-slate">Loading…</p>;
  if (error) return <p className="font-body text-signal">Could not load analytics summary.</p>;
  if (!data) return null;

  return (
    <div>
      <h1 className="font-display text-2xl mb-6">Overview</h1>
      <div className="grid grid-cols-4 gap-4">
        <div className="rounded-lg border border-slate/15 p-4">
          <div className="text-xs text-slate font-body">MRR</div>
          <div className="font-data text-xl tabular-nums">${data.mrr_usd}</div>
        </div>
        <div className="rounded-lg border border-slate/15 p-4">
          <div className="text-xs text-slate font-body">ARR</div>
          <div className="font-data text-xl tabular-nums">${data.arr_usd}</div>
        </div>
        <div className="rounded-lg border border-slate/15 p-4">
          <div className="text-xs text-slate font-body">Active subscriptions</div>
          <div className="font-data text-xl tabular-nums">{data.active_subscriptions}</div>
        </div>
        <div className="rounded-lg border border-slate/15 p-4">
          <div className="text-xs text-slate font-body">ARPU</div>
          <div className="font-data text-xl tabular-nums">${data.arpu_usd}</div>
        </div>
      </div>
    </div>
  );
}
