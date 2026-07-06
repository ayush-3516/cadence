import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import path from "node:path";
import { createDbClient, onchainSchema, type DbClient } from "@cadence/db";
import { findDueSubscriptions } from "../src/due-query.js";

describe("findDueSubscriptions", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16").withDatabase("cadence_test").start();
    const url = container.getConnectionUri();
    const dbCwd = path.resolve(__dirname, "../../../packages/db");
    execSync("npx drizzle-kit migrate", { cwd: dbCwd, env: { ...process.env, DATABASE_URL: url }, stdio: "inherit" });
    execSync("npx drizzle-kit migrate --config drizzle.onchain.config.ts", {
      cwd: dbCwd,
      env: { ...process.env, DATABASE_URL: url },
      stdio: "inherit",
    });
    db = createDbClient(url);
  }, 60_000);

  afterAll(async () => {
    await (db as DbClient & { $client: { end(): Promise<void> } }).$client.end();
    await container.stop();
  });

  async function seedPlanAndSub(overrides: { onchainSubId: string; status: string; currentPeriodEnd: Date; chainId?: number }) {
    await db.insert(onchainSchema.onchainPlan).values({
      onchainPlanId: "1",
      merchantAddress: "0xabc0000000000000000000000000000000000a",
      payoutSplit: "0xdef0000000000000000000000000000000000b",
      token: "0x0000000000000000000000000000000000000c",
      amount: "20000000",
      periodSeconds: 2592000n,
      trialSeconds: 0n,
      active: true,
      chainId: overrides.chainId ?? 84532,
    }).onConflictDoNothing();

    await db.insert(onchainSchema.onchainSubscription).values({
      onchainSubId: overrides.onchainSubId,
      onchainPlanId: "1",
      subscriberAddress: "0x1110000000000000000000000000000000000d",
      status: overrides.status,
      currentPeriodEnd: overrides.currentPeriodEnd,
      pausedRemaining: 0n,
      pendingCancel: false,
      chainId: overrides.chainId ?? 84532,
    });
  }

  it("returns an active subscription whose period has ended", async () => {
    await seedPlanAndSub({ onchainSubId: "1", status: "active", currentPeriodEnd: new Date(Date.now() - 60_000) });

    const due = await findDueSubscriptions(db, { chainId: 84532, batchSize: 100 });
    expect(due.map((d) => d.onchainSubId)).toContain("1");
  });

  it("excludes a subscription whose period has not ended yet", async () => {
    await seedPlanAndSub({ onchainSubId: "2", status: "active", currentPeriodEnd: new Date(Date.now() + 60_000) });

    const due = await findDueSubscriptions(db, { chainId: 84532, batchSize: 100 });
    expect(due.map((d) => d.onchainSubId)).not.toContain("2");
  });

  it("excludes a canceled subscription even if its period has ended", async () => {
    await seedPlanAndSub({ onchainSubId: "3", status: "canceled", currentPeriodEnd: new Date(Date.now() - 60_000) });

    const due = await findDueSubscriptions(db, { chainId: 84532, batchSize: 100 });
    expect(due.map((d) => d.onchainSubId)).not.toContain("3");
  });

  it("includes a past_due subscription unconditionally (no dunning gate exists yet)", async () => {
    await seedPlanAndSub({ onchainSubId: "4", status: "past_due", currentPeriodEnd: new Date(Date.now() - 60_000) });

    const due = await findDueSubscriptions(db, { chainId: 84532, batchSize: 100 });
    expect(due.map((d) => d.onchainSubId)).toContain("4");
  });

  it("respects the chainId filter", async () => {
    await seedPlanAndSub({ onchainSubId: "5", status: "active", currentPeriodEnd: new Date(Date.now() - 60_000), chainId: 999 });

    const due = await findDueSubscriptions(db, { chainId: 84532, batchSize: 100 });
    expect(due.map((d) => d.onchainSubId)).not.toContain("5");
  });

  it("respects batchSize and orders by current_period_end ascending", async () => {
    await seedPlanAndSub({ onchainSubId: "6", status: "active", currentPeriodEnd: new Date(Date.now() - 120_000) });
    await seedPlanAndSub({ onchainSubId: "7", status: "active", currentPeriodEnd: new Date(Date.now() - 30_000) });

    const due = await findDueSubscriptions(db, { chainId: 84532, batchSize: 1 });
    expect(due).toHaveLength(1);
    expect(due[0].onchainSubId).toBe("6");
  });
});
