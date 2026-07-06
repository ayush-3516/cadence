import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { onchainSchema, schema } from "@cadence/db";
import type { DbClient } from "@cadence/db";

export interface DueSubscription {
  onchainSubId: string;
  currentPeriodEnd: Date;
}

export async function findDueSubscriptions(
  db: DbClient,
  params: { chainId: number; batchSize: number },
): Promise<DueSubscription[]> {
  const rows = await db
    .select({
      onchainSubId: onchainSchema.onchainSubscription.onchainSubId,
      currentPeriodEnd: onchainSchema.onchainSubscription.currentPeriodEnd,
    })
    .from(onchainSchema.onchainSubscription)
    .leftJoin(schema.dunningState, eq(onchainSchema.onchainSubscription.onchainSubId, schema.dunningState.onchainSubId))
    .where(
      and(
        lte(onchainSchema.onchainSubscription.currentPeriodEnd, new Date()),
        eq(onchainSchema.onchainSubscription.chainId, params.chainId),
        or(
          inArray(onchainSchema.onchainSubscription.status, ["active", "trialing"]),
          and(
            eq(onchainSchema.onchainSubscription.status, "past_due"),
            or(
              isNull(schema.dunningState.onchainSubId),
              and(lte(schema.dunningState.nextRetryAt, new Date()), eq(schema.dunningState.exhausted, false)),
            ),
          ),
        ),
      ),
    )
    .orderBy(asc(onchainSchema.onchainSubscription.currentPeriodEnd))
    .limit(params.batchSize);

  return rows;
}
