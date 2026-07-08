import { and, eq, gte, lt, inArray } from "drizzle-orm";
import { schema, onchainSchema } from "@cadence/db";
import type { DbClient } from "@cadence/db";
import { computeMrrArrArpu } from "./analytics-math.js";

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function runAnalyticsRollup(db: DbClient, rollupDate: Date): Promise<void> {
  const windowStart = new Date(rollupDate);
  windowStart.setUTCHours(0, 0, 0, 0);
  const windowEnd = new Date(windowStart);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + 1);

  const merchantAddresses = await db
    .selectDistinct({ merchantAddress: onchainSchema.onchainPlan.merchantAddress })
    .from(onchainSchema.onchainPlan);

  for (const { merchantAddress } of merchantAddresses) {
    const [merchant] = await db
      .select()
      .from(schema.merchant)
      .where(and(eq(schema.merchant.ownerAddress, merchantAddress), eq(schema.merchant.livemode, false)));
    if (!merchant) continue; // no matching off-chain merchant record — nothing to roll up under

    const plans = await db.select().from(onchainSchema.onchainPlan).where(eq(onchainSchema.onchainPlan.merchantAddress, merchantAddress));
    const planIds = plans.map((p) => p.onchainPlanId);
    if (planIds.length === 0) continue;
    const planById = new Map(plans.map((p) => [p.onchainPlanId, p]));

    const subs = await db.select().from(onchainSchema.onchainSubscription).where(inArray(onchainSchema.onchainSubscription.onchainPlanId, planIds));

    const mrrInputs = subs
      .filter((s) => s.status === "active" || s.status === "trialing")
      .map((s) => {
        const plan = planById.get(s.onchainPlanId)!;
        return { status: s.status, amountRaw: plan.amount, periodSeconds: plan.periodSeconds };
      });
    const { mrrUsd, arrUsd, activeSubs, trialingSubs } = computeMrrArrArpu(mrrInputs);

    const pastDueSubs = subs.filter((s) => s.status === "past_due").length;
    const newSubs = subs.filter((s) => s.createdAt && s.createdAt >= windowStart && s.createdAt < windowEnd).length;
    const canceledSubs = subs.filter((s) => s.canceledAt && s.canceledAt >= windowStart && s.canceledAt < windowEnd).length;

    const charges = await db
      .select()
      .from(onchainSchema.onchainCharge)
      .where(
        and(
          inArray(onchainSchema.onchainCharge.onchainPlanId, planIds),
          eq(onchainSchema.onchainCharge.status, "success"),
          gte(onchainSchema.onchainCharge.chargedAt, windowStart),
          lt(onchainSchema.onchainCharge.chargedAt, windowEnd),
        ),
      );
    const grossVolumeUsd = charges.reduce((sum, c) => sum + Number(c.usdValue ?? 0), 0);
    const feeRevenueUsd = charges.reduce((sum, c) => sum + Number(c.platformFee ?? 0) / 1e6, 0);

    await db
      .insert(schema.analyticsDaily)
      .values({
        merchantId: merchant.id,
        date: toDateOnly(windowStart),
        mrrUsd: mrrUsd.toFixed(6),
        arrUsd: arrUsd.toFixed(6),
        activeSubs,
        trialingSubs,
        pastDueSubs,
        newSubs,
        canceledSubs,
        grossVolumeUsd: grossVolumeUsd.toFixed(6),
        feeRevenueUsd: feeRevenueUsd.toFixed(6),
      })
      .onConflictDoUpdate({
        target: [schema.analyticsDaily.merchantId, schema.analyticsDaily.date],
        set: {
          mrrUsd: mrrUsd.toFixed(6),
          arrUsd: arrUsd.toFixed(6),
          activeSubs,
          trialingSubs,
          pastDueSubs,
          newSubs,
          canceledSubs,
          grossVolumeUsd: grossVolumeUsd.toFixed(6),
          feeRevenueUsd: feeRevenueUsd.toFixed(6),
        },
      });
  }
}
