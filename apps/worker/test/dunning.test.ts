import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createDbClient, schema, onchainSchema, type DbClient } from "@cadence/db";
import { parseDuration, reconcileDunningState } from "../src/dunning.js";

describe("parseDuration", () => {
  it("parses days", () => {
    expect(parseDuration("1d")).toBe(24 * 60 * 60 * 1000);
    expect(parseDuration("7d")).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("parses hours", () => {
    expect(parseDuration("6h")).toBe(6 * 60 * 60 * 1000);
  });

  it("throws on an unrecognized format", () => {
    expect(() => parseDuration("3w")).toThrow();
    expect(() => parseDuration("abc")).toThrow();
  });
});

describe("reconcileDunningState", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbClient;
  let planCounter = 0;
  let subCounter = 0;

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

  async function seedPlan(overrides: Partial<typeof onchainSchema.onchainPlan.$inferInsert> = {}) {
    planCounter += 1;
    const onchainPlanId = String(planCounter);
    await db.insert(onchainSchema.onchainPlan).values({
      onchainPlanId,
      merchantAddress: "0xabc0000000000000000000000000000000000a",
      payoutSplit: "0xdef0000000000000000000000000000000000b",
      token: "0x0000000000000000000000000000000000000c",
      amount: "20000000",
      periodSeconds: 2592000n,
      trialSeconds: 0n,
      active: true,
      chainId: 84532,
      ...overrides,
    });
    return onchainPlanId;
  }

  async function seedSub(onchainPlanId: string, overrides: Partial<typeof onchainSchema.onchainSubscription.$inferInsert> = {}) {
    subCounter += 1;
    const onchainSubId = String(subCounter);
    await db.insert(onchainSchema.onchainSubscription).values({
      onchainSubId,
      onchainPlanId,
      subscriberAddress: "0x1110000000000000000000000000000000000d",
      status: "past_due",
      currentPeriodEnd: new Date(Date.now() - 60_000),
      pausedRemaining: 0n,
      pendingCancel: false,
      chainId: 84532,
      ...overrides,
    });
    return onchainSubId;
  }

  it("creates a dunning_state row for a newly past_due subscription using the plan's ladder", async () => {
    const planId = await seedPlan();
    await db.insert(schema.merchant).values({ name: "Test Co", ownerAddress: "0xabc0000000000000000000000000000000000a" }).onConflictDoNothing();
    const [merchantRow] = await db.select().from(schema.merchant).where(eq(schema.merchant.ownerAddress, "0xabc0000000000000000000000000000000000a"));
    await db.insert(schema.planMeta).values({ onchainPlanId: planId, merchantId: merchantRow.id, name: "Test Plan", dunningLadder: ["2d", "4d"] });
    const subId = await seedSub(planId);

    await reconcileDunningState(db, 84532);

    const [row] = await db.select().from(schema.dunningState).where(eq(schema.dunningState.onchainSubId, subId));
    expect(row).toBeDefined();
    expect(row.attempt).toBe(1);
    expect(row.exhausted).toBe(false);
    expect(row.ladder).toEqual(["2d", "4d"]);
    const expectedRetryAt = Date.now() + parseDuration("2d");
    expect(Math.abs(row.nextRetryAt.getTime() - expectedRetryAt)).toBeLessThan(5000);
  });

  it("uses the default ladder when the plan has no plan_meta row", async () => {
    const planId = await seedPlan();
    const subId = await seedSub(planId);

    await reconcileDunningState(db, 84532);

    const [row] = await db.select().from(schema.dunningState).where(eq(schema.dunningState.onchainSubId, subId));
    expect(row.ladder).toEqual(["1d", "3d", "5d", "7d"]);
  });

  it("deletes the dunning_state row once the subscription is no longer past_due", async () => {
    const planId = await seedPlan();
    const subId = await seedSub(planId);
    await reconcileDunningState(db, 84532);

    await db.update(onchainSchema.onchainSubscription).set({ status: "active" }).where(eq(onchainSchema.onchainSubscription.onchainSubId, subId));
    await reconcileDunningState(db, 84532);

    const rows = await db.select().from(schema.dunningState).where(eq(schema.dunningState.onchainSubId, subId));
    expect(rows).toHaveLength(0);
  });

  it("advances attempt and next_retry_at for a subscription still past_due past its retry window", async () => {
    const planId = await seedPlan();
    const subId = await seedSub(planId);
    await db.insert(schema.dunningState).values({
      onchainSubId: subId,
      attempt: 1,
      nextRetryAt: new Date(Date.now() - 1000),
      exhausted: false,
      ladder: ["1d", "3d", "5d", "7d"],
    });

    await reconcileDunningState(db, 84532);

    const [row] = await db.select().from(schema.dunningState).where(eq(schema.dunningState.onchainSubId, subId));
    expect(row.attempt).toBe(2);
    expect(row.exhausted).toBe(false);
    const expectedRetryAt = Date.now() + parseDuration("3d");
    expect(Math.abs(row.nextRetryAt.getTime() - expectedRetryAt)).toBeLessThan(5000);
  });

  it("marks a row exhausted once attempt reaches the ladder's length, and does not advance further", async () => {
    const planId = await seedPlan();
    const subId = await seedSub(planId);
    await db.insert(schema.dunningState).values({
      onchainSubId: subId,
      attempt: 4,
      nextRetryAt: new Date(Date.now() - 1000),
      exhausted: false,
      ladder: ["1d", "3d", "5d", "7d"],
    });

    await reconcileDunningState(db, 84532);

    const [row] = await db.select().from(schema.dunningState).where(eq(schema.dunningState.onchainSubId, subId));
    expect(row.exhausted).toBe(true);
    expect(row.attempt).toBe(4);

    const nextRetryAtBefore = row.nextRetryAt.getTime();
    await reconcileDunningState(db, 84532);
    const [rowAfter] = await db.select().from(schema.dunningState).where(eq(schema.dunningState.onchainSubId, subId));
    expect(rowAfter.exhausted).toBe(true);
    expect(rowAfter.nextRetryAt.getTime()).toBe(nextRetryAtBefore);
  });

  it("does not touch a dunning_state row whose next_retry_at is still in the future", async () => {
    const planId = await seedPlan();
    const subId = await seedSub(planId);
    const futureRetry = new Date(Date.now() + 86_400_000);
    await db.insert(schema.dunningState).values({
      onchainSubId: subId,
      attempt: 1,
      nextRetryAt: futureRetry,
      exhausted: false,
      ladder: ["1d", "3d", "5d", "7d"],
    });

    await reconcileDunningState(db, 84532);

    const [row] = await db.select().from(schema.dunningState).where(eq(schema.dunningState.onchainSubId, subId));
    expect(row.attempt).toBe(1);
    expect(row.nextRetryAt.getTime()).toBe(futureRetry.getTime());
  });

  it("respects the chainId filter when creating new dunning_state rows", async () => {
    const planId = await seedPlan({ chainId: 999 });
    const subId = await seedSub(planId, { chainId: 999 });

    await reconcileDunningState(db, 84532);

    const rows = await db.select().from(schema.dunningState).where(eq(schema.dunningState.onchainSubId, subId));
    expect(rows).toHaveLength(0);
  });

  it("proves the ladder-indexing arithmetic across a full 4-element ladder walk (1->2->3->4->exhausted)", async () => {
    const ladder = ["1d", "3d", "5d", "7d"];
    const planId = await seedPlan();
    const subId = await seedSub(planId);
    await db.insert(schema.dunningState).values({
      onchainSubId: subId,
      attempt: 1,
      nextRetryAt: new Date(Date.now() - 1000),
      exhausted: false,
      ladder,
    });

    // attempt 1 -> 2, delay should be ladder[1] = "3d"
    await reconcileDunningState(db, 84532);
    let [row] = await db.select().from(schema.dunningState).where(eq(schema.dunningState.onchainSubId, subId));
    expect(row.attempt).toBe(2);
    expect(Math.abs(row.nextRetryAt.getTime() - (Date.now() + parseDuration(ladder[1])))).toBeLessThan(5000);

    // attempt 2 -> 3, delay should be ladder[2] = "5d"
    await db.update(schema.dunningState).set({ nextRetryAt: new Date(Date.now() - 1000) }).where(eq(schema.dunningState.onchainSubId, subId));
    await reconcileDunningState(db, 84532);
    [row] = await db.select().from(schema.dunningState).where(eq(schema.dunningState.onchainSubId, subId));
    expect(row.attempt).toBe(3);
    expect(Math.abs(row.nextRetryAt.getTime() - (Date.now() + parseDuration(ladder[2])))).toBeLessThan(5000);

    // attempt 3 -> 4, delay should be ladder[3] = "7d"
    await db.update(schema.dunningState).set({ nextRetryAt: new Date(Date.now() - 1000) }).where(eq(schema.dunningState.onchainSubId, subId));
    await reconcileDunningState(db, 84532);
    [row] = await db.select().from(schema.dunningState).where(eq(schema.dunningState.onchainSubId, subId));
    expect(row.attempt).toBe(4);
    expect(Math.abs(row.nextRetryAt.getTime() - (Date.now() + parseDuration(ladder[3])))).toBeLessThan(5000);

    // attempt 4, ladder.length is 4, so 4 < 4 is false -> exhausted, no ladder[4] access (which would be undefined)
    await db.update(schema.dunningState).set({ nextRetryAt: new Date(Date.now() - 1000) }).where(eq(schema.dunningState.onchainSubId, subId));
    await reconcileDunningState(db, 84532);
    [row] = await db.select().from(schema.dunningState).where(eq(schema.dunningState.onchainSubId, subId));
    expect(row.exhausted).toBe(true);
    expect(row.attempt).toBe(4);
  });
});
