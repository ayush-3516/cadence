import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { createDbClient, schema, onchainSchema, type DbClient } from "@cadence/db";
import { runAnalyticsRollup } from "../src/analytics-rollup.js";

describe("runAnalyticsRollup", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16").withDatabase("cadence_test").start();
    const url = container.getConnectionUri();
    const dbCwd = path.resolve(__dirname, "../../../packages/db");
    execSync("npx drizzle-kit migrate", { cwd: dbCwd, env: { ...process.env, DATABASE_URL: url }, stdio: "inherit" });
    execSync("npx drizzle-kit migrate --config drizzle.onchain.config.ts", { cwd: dbCwd, env: { ...process.env, DATABASE_URL: url }, stdio: "inherit" });
    db = createDbClient(url);
  }, 60_000);

  afterAll(async () => {
    await (db as DbClient & { $client: { end(): Promise<void> } }).$client.end();
    await container.stop();
  });

  async function seedMerchant(ownerAddress: string) {
    const [row] = await db.insert(schema.merchant).values({ name: "Rollup Test Co", ownerAddress, livemode: false }).returning();
    return row;
  }

  it("computes and upserts a full analytics_daily row for a merchant with active/trialing/canceled subs", async () => {
    const merchantAddress = `0x${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.padEnd(42, "0").slice(0, 42);
    const merchant = await seedMerchant(merchantAddress);

    await db.insert(onchainSchema.onchainPlan).values({
      onchainPlanId: "1001",
      merchantAddress,
      payoutSplit: merchantAddress,
      token: "0xusdc",
      amount: "20000000", // 20 USDC
      periodSeconds: 2_592_000n, // 30 days
      trialSeconds: 0n,
      active: true,
      chainId: 84532,
    });

    const rollupDate = new Date("2026-07-10T00:00:00Z");
    const yesterday = new Date("2026-07-09T12:00:00Z");

    // Two active subs (contribute to MRR), one trialing (excluded from MRR, counted separately),
    // one past_due, one canceled today (counts into canceledSubs for this rollup date), one
    // created today (counts into newSubs).
    await db.insert(onchainSchema.onchainSubscription).values([
      { onchainSubId: "2001", onchainPlanId: "1001", subscriberAddress: "0xaaa", status: "active", currentPeriodEnd: new Date(), pausedRemaining: 0n, pendingCancel: false, chainId: 84532, createdAt: yesterday },
      { onchainSubId: "2002", onchainPlanId: "1001", subscriberAddress: "0xbbb", status: "active", currentPeriodEnd: new Date(), pausedRemaining: 0n, pendingCancel: false, chainId: 84532, createdAt: yesterday },
      { onchainSubId: "2003", onchainPlanId: "1001", subscriberAddress: "0xccc", status: "trialing", currentPeriodEnd: new Date(), pausedRemaining: 0n, pendingCancel: false, chainId: 84532, createdAt: yesterday },
      { onchainSubId: "2004", onchainPlanId: "1001", subscriberAddress: "0xddd", status: "past_due", currentPeriodEnd: new Date(), pausedRemaining: 0n, pendingCancel: false, chainId: 84532, createdAt: yesterday },
      { onchainSubId: "2005", onchainPlanId: "1001", subscriberAddress: "0xeee", status: "canceled", currentPeriodEnd: new Date(), pausedRemaining: 0n, pendingCancel: false, chainId: 84532, createdAt: yesterday, canceledAt: new Date("2026-07-10T08:00:00Z") },
      { onchainSubId: "2006", onchainPlanId: "1001", subscriberAddress: "0xfff", status: "active", currentPeriodEnd: new Date(), pausedRemaining: 0n, pendingCancel: false, chainId: 84532, createdAt: new Date("2026-07-10T02:00:00Z") },
    ]);

    await db.insert(onchainSchema.onchainCharge).values({
      id: "0xtxhash:0",
      onchainSubId: "2001",
      onchainPlanId: "1001",
      status: "success",
      amount: "20000000",
      platformFee: "150000",
      net: "19850000",
      token: "USDC",
      usdValue: "20.000000",
      txHash: "0xtxhash",
      chainId: 84532,
      chargedAt: new Date("2026-07-10T18:00:00Z"), // within [rollupDate, rollupDate + 1 day), the calendar-day window runAnalyticsRollup actually queries
    });

    await runAnalyticsRollup(db, rollupDate);

    const [row] = await db
      .select()
      .from(schema.analyticsDaily)
      .where(and(eq(schema.analyticsDaily.merchantId, merchant.id), eq(schema.analyticsDaily.date, "2026-07-10")));

    expect(row).toBeDefined();
    expect(Number(row.mrrUsd)).toBeCloseTo(60, 6); // 3 active subs (2001, 2002, 2006) × 20 USDC each
    expect(Number(row.arrUsd)).toBeCloseTo(720, 6);
    expect(row.activeSubs).toBe(3);
    expect(row.trialingSubs).toBe(1);
    expect(row.pastDueSubs).toBe(1);
    expect(row.newSubs).toBe(1); // 2006, created within [rollupDate, rollupDate+1day)
    expect(row.canceledSubs).toBe(1); // 2005, canceled within that same window
    expect(Number(row.grossVolumeUsd)).toBeCloseTo(20, 6);
    expect(Number(row.feeRevenueUsd)).toBeCloseTo(0.15, 6); // 150000 / 1e6
  });

  it("upserts (does not duplicate) when run twice for the same merchant and date", async () => {
    const merchantAddress = `0x${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.padEnd(42, "0").slice(0, 42);
    const merchant = await seedMerchant(merchantAddress);
    await db.insert(onchainSchema.onchainPlan).values({
      onchainPlanId: "1002",
      merchantAddress,
      payoutSplit: merchantAddress,
      token: "0xusdc",
      amount: "10000000",
      periodSeconds: 2_592_000n,
      trialSeconds: 0n,
      active: true,
      chainId: 84532,
    });

    const rollupDate = new Date("2026-07-11T00:00:00Z");
    await runAnalyticsRollup(db, rollupDate);
    await runAnalyticsRollup(db, rollupDate);

    // Scoped to this test's own merchant: runAnalyticsRollup loops over every merchant with an
    // on-chain plan (by design, a single daily job for all merchants), so other tests' merchants
    // may also land rows on this same date — an unscoped date-only query would over-count those
    // as if they were duplicates of this merchant's own row.
    const rows = await db
      .select()
      .from(schema.analyticsDaily)
      .where(and(eq(schema.analyticsDaily.merchantId, merchant.id), eq(schema.analyticsDaily.date, "2026-07-11")));
    expect(rows).toHaveLength(1);
  });

  it("skips merchants with no on-chain plans (nothing to roll up)", async () => {
    const merchant = await seedMerchant(`0x${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.padEnd(42, "0").slice(0, 42));
    const rollupDate = new Date("2026-07-12T00:00:00Z");

    await runAnalyticsRollup(db, rollupDate);

    const rows = await db.select().from(schema.analyticsDaily).where(and(eq(schema.analyticsDaily.merchantId, merchant.id), eq(schema.analyticsDaily.date, "2026-07-12")));
    expect(rows).toHaveLength(0); // no plan → not iterated at all, not a zero-row insert
  });
});
