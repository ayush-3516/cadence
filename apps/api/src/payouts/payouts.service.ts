import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { onchainSchema } from "@cadence/db";
import type { DbClient } from "@cadence/db";
import { DB_CLIENT } from "../db/db.module.js";
import type { PayoutResponse } from "./payouts.dto.js";

function toPayoutResponse(payout: typeof onchainSchema.onchainPayout.$inferSelect): PayoutResponse & { id: string } {
  return {
    id: payout.id,
    split_address: payout.splitAddress,
    recipient: payout.recipient,
    token: payout.token,
    amount: payout.amount,
    usd_value: payout.usdValue,
    tx_hash: payout.txHash,
    distributed_at: payout.distributedAt.toISOString(),
  };
}

@Injectable()
export class PayoutsService {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async list(
    callerOwnerAddress: string,
    params: { limit: number; startingAfter: string | null },
  ): Promise<(PayoutResponse & { id: string })[]> {
    const plans = await this.db
      .select({ payoutSplit: onchainSchema.onchainPlan.payoutSplit })
      .from(onchainSchema.onchainPlan)
      .where(eq(onchainSchema.onchainPlan.merchantAddress, callerOwnerAddress));
    const splitAddresses = plans.map((p) => p.payoutSplit);
    if (splitAddresses.length === 0) return [];

    const conditions = [inArray(onchainSchema.onchainPayout.splitAddress, splitAddresses)];
    if (params.startingAfter !== null) {
      conditions.push(gt(onchainSchema.onchainPayout.id, params.startingAfter));
    }

    const rows = await this.db
      .select()
      .from(onchainSchema.onchainPayout)
      .where(and(...conditions))
      .orderBy(asc(onchainSchema.onchainPayout.id))
      .limit(params.limit + 1);

    return rows.map(toPayoutResponse);
  }
}
