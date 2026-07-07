import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import path from "node:path";
import { eq, and } from "drizzle-orm";
import { createDbClient, schema, type DbClient } from "../src/client.js";

describe("analytics_daily schema", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16").withDatabase("cadence_test").start();
    const url = container.getConnectionUri();
    const cwd = path.resolve(__dirname, "..");
    execSync("npx drizzle-kit migrate", { cwd, env: { ...process.env, DATABASE_URL: url }, stdio: "inherit" });
    db = createDbClient(url);
  }, 60_000);

  afterAll(async () => {
    await (db as DbClient & { $client: { end(): Promise<void> } }).$client.end();
    await container.stop();
  });

  async function seedMerchant() {
    const [row] = await db
      .insert(schema.merchant)
      .values({ name: "Analytics Test Co", ownerAddress: `0x${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.padEnd(42, "0").slice(0, 42), livemode: false })
      .returning();
    return row;
  }

  it("inserts a full analytics_daily row with all required fields", async () => {
    const merchant = await seedMerchant();
    const [row] = await db
      .insert(schema.analyticsDaily)
      .values({
        merchantId: merchant.id,
        date: "2026-07-07",
        mrrUsd: "1000.000000",
        arrUsd: "12000.000000",
        activeSubs: 10,
        trialingSubs: 2,
        pastDueSubs: 1,
        newSubs: 3,
        canceledSubs: 1,
        grossVolumeUsd: "500.000000",
        feeRevenueUsd: "12.500000",
      })
      .returning();

    expect(row.mrrUsd).toBe("1000.000000");
    expect(row.activeSubs).toBe(10);
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("enforces a compound PRIMARY KEY on (merchant_id, date)", async () => {
    const merchant = await seedMerchant();
    const values = {
      merchantId: merchant.id,
      date: "2026-07-07",
      mrrUsd: "1000.000000",
      arrUsd: "12000.000000",
      activeSubs: 10,
      trialingSubs: 0,
      pastDueSubs: 0,
      newSubs: 0,
      canceledSubs: 0,
      grossVolumeUsd: "0.000000",
      feeRevenueUsd: "0.000000",
    };
    await db.insert(schema.analyticsDaily).values(values);

    await expect(db.insert(schema.analyticsDaily).values(values)).rejects.toThrow();
  });

  it("allows the same date for different merchants", async () => {
    const merchantA = await seedMerchant();
    const merchantB = await seedMerchant();
    const base = {
      date: "2026-07-08",
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
    await db.insert(schema.analyticsDaily).values({ ...base, merchantId: merchantA.id });
    const [row] = await db.insert(schema.analyticsDaily).values({ ...base, merchantId: merchantB.id }).returning();
    expect(row.merchantId).toBe(merchantB.id);
  });

  it("supports upsert via ON CONFLICT on (merchant_id, date)", async () => {
    const merchant = await seedMerchant();
    await db.insert(schema.analyticsDaily).values({
      merchantId: merchant.id,
      date: "2026-07-09",
      mrrUsd: "100.000000",
      arrUsd: "1200.000000",
      activeSubs: 1,
      trialingSubs: 0,
      pastDueSubs: 0,
      newSubs: 1,
      canceledSubs: 0,
      grossVolumeUsd: "0.000000",
      feeRevenueUsd: "0.000000",
    });

    await db
      .insert(schema.analyticsDaily)
      .values({
        merchantId: merchant.id,
        date: "2026-07-09",
        mrrUsd: "200.000000",
        arrUsd: "2400.000000",
        activeSubs: 2,
        trialingSubs: 0,
        pastDueSubs: 0,
        newSubs: 0,
        canceledSubs: 0,
        grossVolumeUsd: "0.000000",
        feeRevenueUsd: "0.000000",
      })
      .onConflictDoUpdate({
        target: [schema.analyticsDaily.merchantId, schema.analyticsDaily.date],
        set: { mrrUsd: "200.000000", arrUsd: "2400.000000", activeSubs: 2 },
      });

    const [row] = await db
      .select()
      .from(schema.analyticsDaily)
      .where(and(eq(schema.analyticsDaily.merchantId, merchant.id), eq(schema.analyticsDaily.date, "2026-07-09")));
    expect(row.mrrUsd).toBe("200.000000");
    expect(row.activeSubs).toBe(2);
  });
});
