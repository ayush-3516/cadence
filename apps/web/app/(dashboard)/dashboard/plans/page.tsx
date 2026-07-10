"use client";

import Link from "next/link";
import { usePlans } from "../../../../lib/hooks/usePlans.js";
import { StatusBadge } from "@cadence/ui";

export default function PlansPage() {
  const { data, isLoading, error } = usePlans();

  if (isLoading) return <p className="font-body text-slate">Loading…</p>;
  if (error) return <p className="font-body text-signal">Could not load plans.</p>;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-2xl">Plans</h1>
        <Link href="/dashboard/plans/new" className="rounded-md bg-sapphire text-paper px-4 py-2 font-body text-sm font-semibold">
          New Plan
        </Link>
      </div>
      <table className="w-full text-sm font-body">
        <thead>
          <tr className="text-left text-slate border-b border-slate/15">
            <th className="py-2">Name</th>
            <th className="py-2">Price</th>
            <th className="py-2">Period</th>
            <th className="py-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((plan) => (
            <tr key={plan.onchain_plan_id} className="border-b border-slate/10">
              <td className="py-2">{plan.name ?? "Untitled plan"}</td>
              <td className="py-2 font-data tabular-nums">{plan.amount} {plan.token}</td>
              <td className="py-2 font-data tabular-nums">{Math.round(plan.period_seconds / 86400)}d</td>
              <td className="py-2"><StatusBadge status={plan.active ? "active" : "canceled"} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
