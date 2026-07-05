import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, eq, gt } from "drizzle-orm";
import { schema, onchainSchema } from "@cadence/db";
import type { DbClient } from "@cadence/db";
import { DB_CLIENT } from "../db/db.module.js";

export interface CustomerSummary {
  id: string; // = address, used by buildPageEnvelope's cursor slicing
  address: string;
  email: string | null;
  subscription_count: number;
}

@Injectable()
export class CustomersService {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async list(
    callerOwnerAddress: string,
    params: { limit: number; startingAfter: string | null },
  ): Promise<CustomerSummary[]> {
    const conditions = [eq(onchainSchema.onchainPlan.merchantAddress, callerOwnerAddress)];
    if (params.startingAfter !== null) {
      conditions.push(gt(onchainSchema.onchainSubscription.subscriberAddress, params.startingAfter));
    }

    // drizzle-orm's count() aggregates over Postgres bigint, which node-postgres
    // deserializes as a JS string (same reason plan.periodSeconds elsewhere in
    // this codebase needs Number(...) before use) — the Number() cast below on
    // row.subscriptionCount is required, not optional, or subscription_count
    // would serialize as a numeric-looking string instead of a JSON number.
    const rows = await this.db
      .select({
        address: onchainSchema.onchainSubscription.subscriberAddress,
        subscriptionCount: count(onchainSchema.onchainSubscription.onchainSubId),
      })
      .from(onchainSchema.onchainSubscription)
      .innerJoin(onchainSchema.onchainPlan, eq(onchainSchema.onchainSubscription.onchainPlanId, onchainSchema.onchainPlan.onchainPlanId))
      .where(and(...conditions))
      .groupBy(onchainSchema.onchainSubscription.subscriberAddress)
      .orderBy(asc(onchainSchema.onchainSubscription.subscriberAddress))
      .limit(params.limit + 1);

    if (rows.length === 0) return [];

    // customer.merchant_id is a UUID, not the raw owner address — resolve it once
    // via the merchant row so the email LEFT JOIN below can match on it.
    const [merchantRow] = await this.db.select().from(schema.merchant).where(eq(schema.merchant.ownerAddress, callerOwnerAddress));
    if (!merchantRow) return rows.map((row) => ({ id: row.address, address: row.address, email: null, subscription_count: Number(row.subscriptionCount) }));

    const customerRows = await this.db
      .select()
      .from(schema.customer)
      .where(eq(schema.customer.merchantId, merchantRow.id));
    const emailByAddress = new Map(customerRows.map((c) => [c.address, c.email]));

    return rows.map((row) => ({
      id: row.address,
      address: row.address,
      email: emailByAddress.get(row.address) ?? null,
      subscription_count: Number(row.subscriptionCount),
    }));
  }

  async setEmail(merchantId: string, address: string, email: string): Promise<{ address: string; email: string }> {
    await this.db
      .insert(schema.customer)
      .values({ merchantId, address, email })
      .onConflictDoUpdate({
        target: [schema.customer.merchantId, schema.customer.address],
        set: { email },
      });

    return { address, email };
  }
}
