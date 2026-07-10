"use client";

import Link from "next/link";
import { StatusBadge, CadencePulse } from "@cadence/ui";
import { usePortalPlan } from "../lib/hooks/usePortalPlan.js";
import { useTokenBalance } from "../lib/hooks/useTokenBalance.js";
import { BalanceWarning } from "./BalanceWarning.js";
import type { Subscription } from "@cadence/sdk";

export interface SubscriptionCardProps {
  subscription: Subscription;
  account: `0x${string}` | undefined;
}

export function SubscriptionCard({ subscription, account }: SubscriptionCardProps) {
  const { data: plan } = usePortalPlan(subscription.onchain_plan_id);
  const { balance } = useTokenBalance(plan?.token as `0x${string}` | undefined, account);

  return (
    <Link
      href={`/portal/subscriptions/${subscription.onchain_sub_id}`}
      className="block rounded-lg border border-paper/15 p-4 hover:border-sapphire/40"
    >
      <div className="flex items-center justify-between mb-2">
        <span className="font-data text-sm">{plan?.name ?? `Subscription #${subscription.onchain_sub_id}`}</span>
        <StatusBadge status={subscription.status} />
      </div>
      {/* GET /v1/customers/:address/subscriptions has no per-plan period_seconds (only the
          secret-key-only detail endpoint does), so this hardcodes a 30-day period rather
          than trusting the fetched plan's real period_seconds for the pulse specifically —
          the plan fetch here is only for token/amount/name, and using its real
          period_seconds too would be a reasonable future improvement, but this task's own
          scope is just the balance-warning wiring, so the pulse keeps the pre-existing
          hardcoded-30-day convention from the dashboard phase unchanged. */}
      <CadencePulse periodSeconds={30 * 86400} currentPeriodEnd={subscription.current_period_end} />
      {plan && <BalanceWarning balance={balance} required={plan.amount} />}
    </Link>
  );
}
