import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type DbClient } from "@cadence/db";
import { emitEvent } from "../src/events.js";

describe("emitEvent", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16").withDatabase("cadence_test").start();
    const url = container.getConnectionUri();
    const dbCwd = path.resolve(__dirname, "../../../packages/db");
    execSync("npx drizzle-kit migrate", { cwd: dbCwd, env: { ...process.env, DATABASE_URL: url }, stdio: "inherit" });
    db = createDbClient(url);
  }, 60_000);

  afterAll(async () => {
    await (db as DbClient & { $client: { end(): Promise<void> } }).$client.end();
    await container.stop();
  });

  async function seedMerchant(overrides: Partial<typeof schema.merchant.$inferInsert> = {}) {
    const [row] = await db
      .insert(schema.merchant)
      .values({ name: "Events Test Co", ownerAddress: `0x${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.padEnd(42, "0").slice(0, 42), livemode: false, ...overrides })
      .returning();
    return row;
  }

  it("inserts an event row with the given type and data", async () => {
    const merchant = await seedMerchant();
    const enqueueDelivery = vi.fn();

    await emitEvent(db, { merchantId: merchant.id, type: "subscription.renewed", data: { onchain_sub_id: "1" } }, enqueueDelivery);

    const rows = await db.select().from(schema.event).where(eq(schema.event.merchantId, merchant.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("subscription.renewed");
    expect(rows[0].data).toEqual({ onchain_sub_id: "1" });
    expect(rows[0].livemode).toBe(merchant.livemode);
  });

  it("does not enqueue any delivery when the merchant has no webhook endpoints", async () => {
    const merchant = await seedMerchant();
    const enqueueDelivery = vi.fn();

    await emitEvent(db, { merchantId: merchant.id, type: "subscription.renewed", data: {} }, enqueueDelivery);

    expect(enqueueDelivery).not.toHaveBeenCalled();
  });

  it("enqueues a delivery for an enabled endpoint whose enabled_events includes the wildcard", async () => {
    const merchant = await seedMerchant();
    await db.insert(schema.webhookEndpoint).values({
      merchantId: merchant.id,
      url: "https://example.com/hook",
      signingSecret: "ciphertext",
      enabledEvents: ["*"],
      status: "enabled",
      livemode: false,
    });
    const enqueueDelivery = vi.fn();

    await emitEvent(db, { merchantId: merchant.id, type: "subscription.renewed", data: {} }, enqueueDelivery);

    expect(enqueueDelivery).toHaveBeenCalledTimes(1);
    const deliveries = await db.select().from(schema.webhookDelivery);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe("pending");
    expect(deliveries[0].attempts).toBe(0);
  });

  it("enqueues a delivery for an endpoint whose enabled_events includes the specific type", async () => {
    const merchant = await seedMerchant();
    await db.insert(schema.webhookEndpoint).values({
      merchantId: merchant.id,
      url: "https://example.com/hook",
      signingSecret: "ciphertext",
      enabledEvents: ["subscription.payment_failed"],
      status: "enabled",
      livemode: false,
    });
    const enqueueDelivery = vi.fn();

    await emitEvent(db, { merchantId: merchant.id, type: "subscription.payment_failed", data: {} }, enqueueDelivery);

    expect(enqueueDelivery).toHaveBeenCalledTimes(1);
  });

  it("does not enqueue a delivery for an endpoint whose enabled_events excludes the type", async () => {
    const merchant = await seedMerchant();
    await db.insert(schema.webhookEndpoint).values({
      merchantId: merchant.id,
      url: "https://example.com/hook",
      signingSecret: "ciphertext",
      enabledEvents: ["subscription.payment_failed"],
      status: "enabled",
      livemode: false,
    });
    const enqueueDelivery = vi.fn();

    await emitEvent(db, { merchantId: merchant.id, type: "subscription.renewed", data: {} }, enqueueDelivery);

    expect(enqueueDelivery).not.toHaveBeenCalled();
  });

  it("does not enqueue a delivery for a disabled endpoint even if enabled_events matches", async () => {
    const merchant = await seedMerchant();
    await db.insert(schema.webhookEndpoint).values({
      merchantId: merchant.id,
      url: "https://example.com/hook",
      signingSecret: "ciphertext",
      enabledEvents: ["*"],
      status: "disabled",
      livemode: false,
    });
    const enqueueDelivery = vi.fn();

    await emitEvent(db, { merchantId: merchant.id, type: "subscription.renewed", data: {} }, enqueueDelivery);

    expect(enqueueDelivery).not.toHaveBeenCalled();
  });

  it("enqueues one delivery per matching endpoint when a merchant has multiple", async () => {
    const merchant = await seedMerchant();
    await db.insert(schema.webhookEndpoint).values([
      { merchantId: merchant.id, url: "https://example.com/hook1", signingSecret: "a", enabledEvents: ["*"], status: "enabled", livemode: false },
      { merchantId: merchant.id, url: "https://example.com/hook2", signingSecret: "b", enabledEvents: ["*"], status: "enabled", livemode: false },
    ]);
    const enqueueDelivery = vi.fn();

    await emitEvent(db, { merchantId: merchant.id, type: "subscription.renewed", data: {} }, enqueueDelivery);

    expect(enqueueDelivery).toHaveBeenCalledTimes(2);
  });

  it("stores onchainTxHash on the event row when provided", async () => {
    const merchant = await seedMerchant();
    await emitEvent(db, { merchantId: merchant.id, type: "subscription.renewed", data: {}, onchainTxHash: "0xabc" }, vi.fn());

    const [row] = await db.select().from(schema.event).where(eq(schema.event.merchantId, merchant.id));
    expect(row.onchainTxHash).toBe("0xabc");
  });
});
