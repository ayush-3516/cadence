import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { onchainSchema, schema } from "@cadence/db";
import type { DbClient } from "@cadence/db";
import { DB_CLIENT } from "../db/db.module.js";
import { AppException } from "../common/errors.js";

export interface SubscriptionSummary {
  id: string; // = onchain_sub_id, used by buildPageEnvelope's cursor slicing
  onchain_sub_id: string;
  onchain_plan_id: string;
  subscriber: string;
  status: string;
  current_period_end: string;
  created_at: string | null;
}

export interface ChargeSummary {
  id: string;
  status: string;
  amount: string | null;
  platform_fee: string | null;
  net: string | null;
  tx_hash: string;
  charged_at: string;
}

export interface PlanSummary {
  onchain_plan_id: string;
  name: string | null;
  amount: string;
  token: string;
  period_seconds: number;
}

export interface SubscriptionDetail extends SubscriptionSummary {
  plan: PlanSummary;
  charges: ChargeSummary[];
}

function toSummary(row: typeof onchainSchema.onchainSubscription.$inferSelect): SubscriptionSummary {
  return {
    id: row.onchainSubId,
    onchain_sub_id: row.onchainSubId,
    onchain_plan_id: row.onchainPlanId,
    subscriber: row.subscriberAddress,
    status: row.status,
    current_period_end: row.currentPeriodEnd.toISOString(),
    created_at: row.createdAt ? row.createdAt.toISOString() : null,
  };
}

function toChargeSummary(row: typeof onchainSchema.onchainCharge.$inferSelect): ChargeSummary {
  return {
    id: row.id,
    status: row.status,
    amount: row.amount,
    platform_fee: row.platformFee,
    net: row.net,
    tx_hash: row.txHash,
    charged_at: row.chargedAt.toISOString(),
  };
}

@Injectable()
export class SubscriptionsService {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async list(
    callerOwnerAddress: string,
    params: { limit: number; startingAfter: string | null; status?: string; planId?: string; subscriber?: string },
  ): Promise<SubscriptionSummary[]> {
    // Ownership is scoped via a SQL JOIN against onchain_plan (rather than fetching
    // owned plan ids and filtering `LIMIT`-ed rows in application code) so that LIMIT
    // is applied *after* ownership filtering. The brief's original draft filtered
    // post-LIMIT in JS, which under-fills (or empties) a page whenever a merchant's
    // subscriptions are sparse among other merchants' rows in the same id range —
    // this was caught by "paginates subscription list" failing once earlier tests in
    // the same file had already created lower-numbered subscriptions for other
    // merchants: LIMIT 3 (globally ordered by onchain_sub_id) picked up only those
    // earlier, unrelated rows, filtered to zero.
    const conditions = [eq(onchainSchema.onchainPlan.merchantAddress, callerOwnerAddress)];
    if (params.startingAfter !== null) conditions.push(gt(onchainSchema.onchainSubscription.onchainSubId, params.startingAfter));
    if (params.status !== undefined) conditions.push(eq(onchainSchema.onchainSubscription.status, params.status));
    if (params.planId !== undefined) conditions.push(eq(onchainSchema.onchainSubscription.onchainPlanId, params.planId));
    if (params.subscriber !== undefined) conditions.push(eq(onchainSchema.onchainSubscription.subscriberAddress, params.subscriber));

    const rows = await this.db
      .select()
      .from(onchainSchema.onchainSubscription)
      .innerJoin(onchainSchema.onchainPlan, eq(onchainSchema.onchainSubscription.onchainPlanId, onchainSchema.onchainPlan.onchainPlanId))
      .where(and(...conditions))
      .orderBy(asc(onchainSchema.onchainSubscription.onchainSubId))
      .limit(params.limit + 1);

    return rows.map((row) => toSummary(row.onchain_subscription));
  }

  async getByOnchainId(callerOwnerAddress: string, onchainSubId: string): Promise<SubscriptionDetail> {
    const [sub] = await this.db
      .select()
      .from(onchainSchema.onchainSubscription)
      .where(eq(onchainSchema.onchainSubscription.onchainSubId, onchainSubId));

    if (!sub) {
      throw new AppException({
        type: "invalid_request_error",
        code: "subscription_not_found",
        message: `No subscription with id ${onchainSubId}`,
        param: "onchainId",
        status: 404,
      });
    }

    const [plan] = await this.db
      .select()
      .from(onchainSchema.onchainPlan)
      .where(eq(onchainSchema.onchainPlan.onchainPlanId, sub.onchainPlanId));

    // Collapse "no such subscription" and "subscription exists but its plan belongs to
    // another merchant" into the same 404 — mirrors PlansService.requireOwnedPlan's
    // discloseOwnership: false path (Task 4), so existence of another merchant's
    // subscription is never disclosed via a differing status/code on this read-only route.
    if (!plan || plan.merchantAddress.toLowerCase() !== callerOwnerAddress.toLowerCase()) {
      throw new AppException({
        type: "invalid_request_error",
        code: "subscription_not_found",
        message: `No subscription with id ${onchainSubId}`,
        param: "onchainId",
        status: 404,
      });
    }

    // plan.onchainPlanId is numeric(78,0) but plan_meta.onchain_plan_id is text — a plain
    // eq() across the two fails at the DB level ("operator does not exist: numeric = text").
    // Cast to text, same pattern as PlansService.list's leftJoin (Task 4).
    const [meta] = await this.db
      .select()
      .from(schema.planMeta)
      .where(eq(sql`${plan.onchainPlanId}::text`, schema.planMeta.onchainPlanId));

    const charges = await this.db
      .select()
      .from(onchainSchema.onchainCharge)
      .where(eq(onchainSchema.onchainCharge.onchainSubId, onchainSubId))
      .orderBy(desc(onchainSchema.onchainCharge.chargedAt));

    return {
      ...toSummary(sub),
      plan: {
        onchain_plan_id: plan.onchainPlanId,
        name: meta?.name ?? null,
        amount: plan.amount,
        token: plan.token,
        period_seconds: Number(plan.periodSeconds),
      },
      charges: charges.map(toChargeSummary),
    };
  }
}
