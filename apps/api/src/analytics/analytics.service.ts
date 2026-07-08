import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { schema, onchainSchema } from "@cadence/db";
import type { DbClient } from "@cadence/db";
import { DB_CLIENT } from "../db/db.module.js";

export type AnalyticsDailyRow = typeof schema.analyticsDaily.$inferSelect;

export interface CohortRow {
  cohort: string;
  cohort_size: number;
  offsets: { month: number; retention_pct: number }[];
}

const ZERO_ROW = {
  mrrUsd: "0.000000",
  arrUsd: "0.000000",
  activeSubs: 0,
  trialingSubs: 0,
  pastDueSubs: 0,
  newSubs: 0,
  canceledSubs: 0,
  grossVolumeUsd: "0.000000",
  feeRevenueUsd: "0.000000",
};

@Injectable()
export class AnalyticsService {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async getLatestRow(merchantId: string): Promise<AnalyticsDailyRow | typeof ZERO_ROW> {
    const [row] = await this.db
      .select()
      .from(schema.analyticsDaily)
      .where(eq(schema.analyticsDaily.merchantId, merchantId))
      .orderBy(desc(schema.analyticsDaily.date))
      .limit(1);
    return row ?? ZERO_ROW;
  }

  async getWindowSum(merchantId: string, from: string, to: string): Promise<{ grossVolumeUsd: number; feeRevenueUsd: number }> {
    const rows = await this.db
      .select()
      .from(schema.analyticsDaily)
      .where(and(eq(schema.analyticsDaily.merchantId, merchantId), gte(schema.analyticsDaily.date, from), lte(schema.analyticsDaily.date, to)));
    return {
      grossVolumeUsd: rows.reduce((sum, r) => sum + Number(r.grossVolumeUsd), 0),
      feeRevenueUsd: rows.reduce((sum, r) => sum + Number(r.feeRevenueUsd), 0),
    };
  }

  async getRowsInRange(merchantId: string, from: string, to: string): Promise<AnalyticsDailyRow[]> {
    return this.db
      .select()
      .from(schema.analyticsDaily)
      .where(and(eq(schema.analyticsDaily.merchantId, merchantId), gte(schema.analyticsDaily.date, from), lte(schema.analyticsDaily.date, to)))
      .orderBy(asc(schema.analyticsDaily.date));
  }

  private readonly cohortCache = new Map<string, { data: CohortRow[]; expiresAt: number }>();
  private readonly COHORT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour, per the design spec's documented default

  async getChurn(merchantId: string, from: string, to: string): Promise<{ churnRate: number; revenueChurn: number }> {
    const rows = await this.getRowsInRange(merchantId, from, to);
    if (rows.length === 0) return { churnRate: 0, revenueChurn: 0 };

    const startRow = rows[0];
    const endRow = rows[rows.length - 1];
    const canceledInWindow = rows.reduce((sum, r) => sum + r.canceledSubs, 0);

    const activeAtStart = startRow.activeSubs;
    const churnRate = activeAtStart > 0 ? canceledInWindow / activeAtStart : 0;

    const mrrAtStart = Number(startRow.mrrUsd);
    const mrrAtEnd = Number(endRow.mrrUsd);
    const mrrLost = Math.max(0, mrrAtStart - mrrAtEnd);
    const revenueChurn = mrrAtStart > 0 ? mrrLost / mrrAtStart : 0;

    return { churnRate, revenueChurn };
  }

  async getCohorts(merchantId: string, merchantOwnerAddress: string): Promise<CohortRow[]> {
    const cached = this.cohortCache.get(merchantId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    const plans = await this.db.select().from(onchainSchema.onchainPlan).where(eq(onchainSchema.onchainPlan.merchantAddress, merchantOwnerAddress));
    const planIds = plans.map((p) => p.onchainPlanId);
    if (planIds.length === 0) {
      this.cohortCache.set(merchantId, { data: [], expiresAt: Date.now() + this.COHORT_CACHE_TTL_MS });
      return [];
    }

    const subs = await this.db.select().from(onchainSchema.onchainSubscription).where(inArray(onchainSchema.onchainSubscription.onchainPlanId, planIds));

    const cohortMap = new Map<string, typeof subs>();
    for (const sub of subs) {
      if (!sub.createdAt) continue;
      const cohortKey = sub.createdAt.toISOString().slice(0, 7); // "YYYY-MM"
      if (!cohortMap.has(cohortKey)) cohortMap.set(cohortKey, []);
      cohortMap.get(cohortKey)!.push(sub);
    }

    const now = new Date();
    const result: CohortRow[] = [];
    for (const [cohortKey, cohortSubs] of [...cohortMap.entries()].sort()) {
      const cohortDate = new Date(`${cohortKey}-01T00:00:00Z`);
      const monthsSinceCohort = (now.getFullYear() - cohortDate.getFullYear()) * 12 + (now.getMonth() - cohortDate.getMonth());
      const maxOffset = Math.min(12, monthsSinceCohort);
      const offsets = [];
      for (let offset = 0; offset <= maxOffset; offset++) {
        const checkDate = new Date(cohortDate);
        checkDate.setUTCMonth(checkDate.getUTCMonth() + offset);
        const stillActive = cohortSubs.filter((s) => {
          const isRetainedStatus = s.status === "active" || s.status === "trialing";
          const existedAtOffset = checkDate <= now;
          return isRetainedStatus && existedAtOffset;
        }).length;
        offsets.push({ month: offset, retention_pct: cohortSubs.length > 0 ? stillActive / cohortSubs.length : 0 });
      }
      result.push({ cohort: cohortKey, cohort_size: cohortSubs.length, offsets });
    }

    this.cohortCache.set(merchantId, { data: result, expiresAt: Date.now() + this.COHORT_CACHE_TTL_MS });
    return result;
  }
}
