import { and, eq, lte, ne, notInArray, sql } from "drizzle-orm";
import { schema, onchainSchema } from "@cadence/db";
import type { DbClient } from "@cadence/db";

const DEFAULT_LADDER = ["1d", "3d", "5d", "7d"];

const DURATION_PATTERN = /^(\d+)(d|h)$/;

export function parseDuration(value: string): number {
  const match = DURATION_PATTERN.exec(value);
  if (!match) {
    throw new Error(`Unrecognized dunning ladder duration: "${value}" (expected e.g. "1d" or "6h")`);
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const msPerUnit = unit === "d" ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  return amount * msPerUnit;
}

export async function reconcileDunningState(db: DbClient, chainId: number): Promise<void> {
  await createRowsForNewFailures(db, chainId);
  await deleteRowsForRecoveredSubscriptions(db, chainId);
  await advanceOrExhaustRepeatFailures(db, chainId);
}

async function createRowsForNewFailures(db: DbClient, chainId: number): Promise<void> {
  const existingIds = await db.select({ id: schema.dunningState.onchainSubId }).from(schema.dunningState);
  const existingIdSet = existingIds.map((r) => r.id);

  const newlyFailed = await db
    .select()
    .from(onchainSchema.onchainSubscription)
    .where(
      and(
        eq(onchainSchema.onchainSubscription.status, "past_due"),
        eq(onchainSchema.onchainSubscription.chainId, chainId),
        existingIdSet.length > 0 ? notInArray(onchainSchema.onchainSubscription.onchainSubId, existingIdSet) : undefined,
      ),
    );

  for (const sub of newlyFailed) {
    const [plan] = await db
      .select()
      .from(onchainSchema.onchainPlan)
      .where(eq(onchainSchema.onchainPlan.onchainPlanId, sub.onchainPlanId));

    let ladder: string[] = DEFAULT_LADDER;
    if (plan) {
      const [meta] = await db
        .select()
        .from(schema.planMeta)
        .where(eq(schema.planMeta.onchainPlanId, sql`${plan.onchainPlanId}::text`));
      if (meta?.dunningLadder) {
        ladder = meta.dunningLadder as string[];
      }
    }

    await db.insert(schema.dunningState).values({
      onchainSubId: sub.onchainSubId,
      attempt: 1,
      nextRetryAt: new Date(Date.now() + parseDuration(ladder[0])),
      exhausted: false,
      ladder,
    });

    console.log(`dunning: payment_failed subId=${sub.onchainSubId} attempt=1 next_retry_at=${new Date(Date.now() + parseDuration(ladder[0])).toISOString()}`);
  }
}

async function deleteRowsForRecoveredSubscriptions(db: DbClient, chainId: number): Promise<void> {
  const recovered = await db
    .select({ onchainSubId: schema.dunningState.onchainSubId })
    .from(schema.dunningState)
    .innerJoin(onchainSchema.onchainSubscription, eq(schema.dunningState.onchainSubId, onchainSchema.onchainSubscription.onchainSubId))
    .where(and(ne(onchainSchema.onchainSubscription.status, "past_due"), eq(onchainSchema.onchainSubscription.chainId, chainId)));

  for (const row of recovered) {
    await db.delete(schema.dunningState).where(eq(schema.dunningState.onchainSubId, row.onchainSubId));
    console.log(`dunning: subscription_renewed subId=${row.onchainSubId}`);
  }
}

async function advanceOrExhaustRepeatFailures(db: DbClient, chainId: number): Promise<void> {
  const dueForRetryCheck = await db
    .select({ dunning: schema.dunningState, sub: onchainSchema.onchainSubscription })
    .from(schema.dunningState)
    .innerJoin(onchainSchema.onchainSubscription, eq(schema.dunningState.onchainSubId, onchainSchema.onchainSubscription.onchainSubId))
    .where(
      and(
        eq(schema.dunningState.exhausted, false),
        lte(schema.dunningState.nextRetryAt, new Date()),
        eq(onchainSchema.onchainSubscription.status, "past_due"),
        eq(onchainSchema.onchainSubscription.chainId, chainId),
      ),
    );

  for (const { dunning } of dueForRetryCheck) {
    const ladder = dunning.ladder as string[];
    if (dunning.attempt < ladder.length) {
      const nextAttempt = dunning.attempt + 1;
      const nextRetryAt = new Date(Date.now() + parseDuration(ladder[nextAttempt - 1]));
      await db
        .update(schema.dunningState)
        .set({ attempt: nextAttempt, nextRetryAt, updatedAt: new Date() })
        .where(eq(schema.dunningState.onchainSubId, dunning.onchainSubId));
      console.log(`dunning: payment_failed (retry ${nextAttempt}) subId=${dunning.onchainSubId} next_retry_at=${nextRetryAt.toISOString()}`);
    } else {
      await db
        .update(schema.dunningState)
        .set({ exhausted: true, updatedAt: new Date() })
        .where(eq(schema.dunningState.onchainSubId, dunning.onchainSubId));
      console.log(`dunning: exhausted subId=${dunning.onchainSubId} — on-chain status remains past_due pending subscriber cancellation`);
    }
  }
}
