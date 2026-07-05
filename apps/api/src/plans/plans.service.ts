import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { schema, onchainSchema } from "@cadence/db";
import type { DbClient } from "@cadence/db";
import { DB_CLIENT } from "../db/db.module.js";
import { AppException } from "../common/errors.js";
import type { AuthContext } from "../auth/auth-context.service.js";
import type { AttachPlanMetaDto } from "./plan-meta.dto.js";

export interface PlanResponse {
  onchain_plan_id: string;
  name: string | null;
  description: string | null;
  image_url: string | null;
  amount: string;
  token: string;
  period_seconds: number;
  trial_seconds: number;
  active: boolean;
  payout_split: string;
  dunning_ladder: string[];
  created_at: string | null;
  livemode: boolean;
}

const LIVE_CHAIN_IDS = new Set<number>([8453]); // Base mainnet; testnets (e.g. 84532 Base Sepolia) are not livemode

function toPlanResponse(
  plan: typeof onchainSchema.onchainPlan.$inferSelect,
  meta: typeof schema.planMeta.$inferSelect | undefined,
): PlanResponse {
  return {
    onchain_plan_id: plan.onchainPlanId,
    name: meta?.name ?? null,
    description: meta?.description ?? null,
    image_url: meta?.imageUrl ?? null,
    amount: plan.amount,
    token: plan.token,
    period_seconds: Number(plan.periodSeconds),
    trial_seconds: Number(plan.trialSeconds),
    active: plan.active,
    payout_split: plan.payoutSplit,
    dunning_ladder: (meta?.dunningLadder as string[] | undefined) ?? ["1d", "3d", "5d", "7d"],
    created_at: plan.createdAt ? plan.createdAt.toISOString() : null,
    livemode: LIVE_CHAIN_IDS.has(plan.chainId),
  };
}

@Injectable()
export class PlansService {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  // `discloseOwnership: true` (attach/write path) distinguishes "no such plan" from "plan exists
  // but belongs to someone else" (403 plan_not_owned) — useful for merchants debugging their own
  // integration. `discloseOwnership: false` (read/detail path) collapses the "belongs to someone
  // else" case into the same 404 plan_not_found used for "no such plan", so a caller cannot probe
  // for the existence of another merchant's plan id via the response's status/type.
  private async requireOwnedPlan(callerOwnerAddress: string, onchainPlanId: string, discloseOwnership: boolean) {
    const [plan] = await this.db
      .select()
      .from(onchainSchema.onchainPlan)
      .where(eq(onchainSchema.onchainPlan.onchainPlanId, onchainPlanId));

    if (!plan) {
      throw new AppException({
        type: "invalid_request_error",
        code: "plan_not_found",
        message: `No plan with id ${onchainPlanId}`,
        param: "onchainId",
        status: 404,
      });
    }
    if (plan.merchantAddress.toLowerCase() !== callerOwnerAddress.toLowerCase()) {
      if (discloseOwnership) {
        throw new AppException({ type: "permission_error", code: "plan_not_owned", message: "This plan does not belong to you." });
      }
      throw new AppException({
        type: "invalid_request_error",
        code: "plan_not_found",
        message: `No plan with id ${onchainPlanId}`,
        param: "onchainId",
        status: 404,
      });
    }
    return plan;
  }

  async attachMetadata(callerOwnerAddress: string, merchantId: string, onchainPlanId: string, body: AttachPlanMetaDto): Promise<PlanResponse> {
    const plan = await this.requireOwnedPlan(callerOwnerAddress, onchainPlanId, true);

    await this.db
      .insert(schema.planMeta)
      .values({
        onchainPlanId,
        merchantId,
        name: body.name,
        description: body.description,
        imageUrl: body.imageUrl,
        ...(body.dunningLadder ? { dunningLadder: body.dunningLadder } : {}),
      })
      .onConflictDoUpdate({
        target: schema.planMeta.onchainPlanId,
        set: {
          name: body.name,
          description: body.description,
          imageUrl: body.imageUrl,
          ...(body.dunningLadder ? { dunningLadder: body.dunningLadder } : {}),
          updatedAt: sql`now()`,
        },
      });

    const [meta] = await this.db.select().from(schema.planMeta).where(eq(schema.planMeta.onchainPlanId, onchainPlanId));
    return toPlanResponse(plan, meta);
  }

  async list(
    callerOwnerAddress: string,
    params: { limit: number; startingAfter: string | null; active?: boolean },
  ): Promise<(typeof onchainSchema.onchainPlan.$inferSelect & { meta: typeof schema.planMeta.$inferSelect | undefined })[]> {
    const conditions = [eq(onchainSchema.onchainPlan.merchantAddress, callerOwnerAddress)];
    if (params.startingAfter !== null) {
      conditions.push(gt(onchainSchema.onchainPlan.onchainPlanId, params.startingAfter));
    }
    if (params.active !== undefined) {
      conditions.push(eq(onchainSchema.onchainPlan.active, params.active));
    }

    const rows = await this.db
      .select()
      .from(onchainSchema.onchainPlan)
      .leftJoin(
        schema.planMeta,
        eq(sql`${onchainSchema.onchainPlan.onchainPlanId}::text`, schema.planMeta.onchainPlanId),
      )
      .where(and(...conditions))
      .orderBy(asc(onchainSchema.onchainPlan.onchainPlanId))
      .limit(params.limit + 1);

    return rows.map((row) => ({ ...row.onchain_plan, meta: row.plan_meta ?? undefined }));
  }

  async getByOnchainId(callerOwnerAddress: string, onchainPlanId: string): Promise<PlanResponse> {
    const plan = await this.requireOwnedPlan(callerOwnerAddress, onchainPlanId, false);
    const [meta] = await this.db.select().from(schema.planMeta).where(eq(schema.planMeta.onchainPlanId, onchainPlanId));
    return toPlanResponse(plan, meta);
  }

  toPlanResponse = toPlanResponse;
}
