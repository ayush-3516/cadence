import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { onchainSchema } from "@cadence/db";
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
    .where(
      and(
        inArray(onchainSchema.onchainSubscription.status, ["active", "trialing", "past_due"]),
        lte(onchainSchema.onchainSubscription.currentPeriodEnd, new Date()),
        eq(onchainSchema.onchainSubscription.chainId, params.chainId),
      ),
    )
    .orderBy(asc(onchainSchema.onchainSubscription.currentPeriodEnd))
    .limit(params.batchSize);

  return rows;
}
