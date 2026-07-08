import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { schema } from "@cadence/db";
import type { DbClient } from "@cadence/db";
import { DB_CLIENT } from "../db/db.module.js";

export type AnalyticsDailyRow = typeof schema.analyticsDaily.$inferSelect;

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
}
