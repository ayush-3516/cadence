import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type DbClient } from "../src/client.js";

describe("webhooks schema", () => {
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
      .values({ name: "Webhook Test Co", ownerAddress: `0x${Date.now().toString(16).padStart(40, "0")}` })
      .returning();
    return row;
  }

  it("inserts an event row", async () => {
    const merchant = await seedMerchant();
    const [row] = await db
      .insert(schema.event)
      .values({ merchantId: merchant.id, type: "subscription.renewed", data: { onchain_sub_id: "1" }, livemode: false })
      .returning();

    expect(row.type).toBe("subscription.renewed");
    expect(row.data).toEqual({ onchain_sub_id: "1" });
  });

  it("inserts a webhook_endpoint row with defaults applied", async () => {
    const merchant = await seedMerchant();
    const [row] = await db
      .insert(schema.webhookEndpoint)
      .values({ merchantId: merchant.id, url: "https://example.com/hook", signingSecret: "ciphertext", livemode: false })
      .returning();

    expect(row.enabledEvents).toEqual(["*"]);
    expect(row.status).toBe("enabled");
  });

  it("inserts a webhook_delivery row and enforces uniqueness on (endpoint_id, event_id)", async () => {
    const merchant = await seedMerchant();
    const [endpoint] = await db
      .insert(schema.webhookEndpoint)
      .values({ merchantId: merchant.id, url: "https://example.com/hook", signingSecret: "ciphertext", livemode: false })
      .returning();
    const [evt] = await db
      .insert(schema.event)
      .values({ merchantId: merchant.id, type: "subscription.renewed", data: {}, livemode: false })
      .returning();

    await db.insert(schema.webhookDelivery).values({
      endpointId: endpoint.id,
      eventId: evt.id,
      eventType: "subscription.renewed",
      payload: { id: "evt_1" },
    });

    await expect(
      db.insert(schema.webhookDelivery).values({
        endpointId: endpoint.id,
        eventId: evt.id,
        eventType: "subscription.renewed",
        payload: { id: "evt_1" },
      }),
    ).rejects.toThrow();
  });

  it("allows updating webhook_delivery status/attempts", async () => {
    const merchant = await seedMerchant();
    const [endpoint] = await db
      .insert(schema.webhookEndpoint)
      .values({ merchantId: merchant.id, url: "https://example.com/hook", signingSecret: "ciphertext", livemode: false })
      .returning();
    const [evt] = await db
      .insert(schema.event)
      .values({ merchantId: merchant.id, type: "subscription.payment_failed", data: {}, livemode: false })
      .returning();
    const [delivery] = await db
      .insert(schema.webhookDelivery)
      .values({ endpointId: endpoint.id, eventId: evt.id, eventType: "subscription.payment_failed", payload: {} })
      .returning();

    await db
      .update(schema.webhookDelivery)
      .set({ status: "succeeded", attempts: 1, responseCode: 200, updatedAt: new Date() })
      .where(eq(schema.webhookDelivery.id, delivery.id));

    const [row] = await db.select().from(schema.webhookDelivery).where(eq(schema.webhookDelivery.id, delivery.id));
    expect(row.status).toBe("succeeded");
    expect(row.attempts).toBe(1);
    expect(row.responseCode).toBe(200);
  });
});
