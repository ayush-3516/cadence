import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type DbClient } from "@cadence/db";
import { encryptSecret } from "@cadence/shared";
import { deliverWebhook } from "../src/webhook-delivery.js";

const TEST_KEY = "0123456789abcdef0123456789abcdef";

describe("deliverWebhook", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbClient;
  let server: Server;
  let serverPort: number;
  let receivedRequests: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  let responseStatus = 200;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16").withDatabase("cadence_test").start();
    const url = container.getConnectionUri();
    const dbCwd = path.resolve(__dirname, "../../../packages/db");
    execSync("npx drizzle-kit migrate", { cwd: dbCwd, env: { ...process.env, DATABASE_URL: url }, stdio: "inherit" });
    db = createDbClient(url);

    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        receivedRequests.push({ headers: req.headers, body });
        res.writeHead(responseStatus);
        res.end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    serverPort = (server.address() as { port: number }).port;
  }, 60_000);

  afterEach(() => {
    receivedRequests = [];
    responseStatus = 200;
  });

  afterAll(async () => {
    await (db as DbClient & { $client: { end(): Promise<void> } }).$client.end();
    await container.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function seedDelivery(rawSecret: string) {
    const [merchant] = await db.insert(schema.merchant).values({ name: "WH Test", ownerAddress: `0x${Date.now()}${Math.random()}`.padEnd(42, "0").slice(0, 42), livemode: false }).returning();
    const [endpoint] = await db
      .insert(schema.webhookEndpoint)
      .values({ merchantId: merchant.id, url: `http://127.0.0.1:${serverPort}`, signingSecret: encryptSecret(rawSecret, TEST_KEY), enabledEvents: ["*"], status: "enabled", livemode: false })
      .returning();
    const [evt] = await db.insert(schema.event).values({ merchantId: merchant.id, type: "subscription.renewed", data: { foo: "bar" }, livemode: false }).returning();
    const payload = { id: `evt_${evt.id}`, type: "subscription.renewed", created: new Date().toISOString(), livemode: false, data: { foo: "bar" } };
    const [delivery] = await db
      .insert(schema.webhookDelivery)
      .values({ endpointId: endpoint.id, eventId: evt.id, eventType: "subscription.renewed", payload })
      .returning();
    return delivery;
  }

  it("delivers with a valid HMAC signature and marks the delivery succeeded", async () => {
    const rawSecret = "whsec_test123";
    const delivery = await seedDelivery(rawSecret);

    await deliverWebhook(db, delivery.id, TEST_KEY);

    expect(receivedRequests).toHaveLength(1);
    const [req] = receivedRequests;
    const sigHeader = req.headers["cadence-signature"] as string;
    expect(sigHeader).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

    const [t, sigPart] = sigHeader.split(",");
    const timestamp = t.split("=")[1];
    const expectedSig = createHmac("sha256", rawSecret).update(`${timestamp}.${req.body}`).digest("hex");
    expect(sigPart).toBe(`v1=${expectedSig}`);

    const [row] = await db.select().from(schema.webhookDelivery).where(eq(schema.webhookDelivery.id, delivery.id));
    expect(row.status).toBe("succeeded");
    expect(row.attempts).toBe(1);
    expect(row.responseCode).toBe(200);
  });

  it("sends the Cadence-Event-Id header matching the payload's id", async () => {
    const delivery = await seedDelivery("whsec_test456");
    await deliverWebhook(db, delivery.id, TEST_KEY);

    const [req] = receivedRequests;
    expect(req.headers["cadence-event-id"]).toBe((delivery.payload as { id: string }).id);
  });

  it("schedules a retry with next_attempt_at when the endpoint returns a non-2xx status", async () => {
    responseStatus = 500;
    const delivery = await seedDelivery("whsec_test789");

    await deliverWebhook(db, delivery.id, TEST_KEY);

    const [row] = await db.select().from(schema.webhookDelivery).where(eq(schema.webhookDelivery.id, delivery.id));
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.responseCode).toBe(500);
    expect(row.nextAttemptAt).not.toBeNull();
    expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 50_000); // ~1 minute out, per the ladder's 2nd entry
  });

  it("marks a delivery dead after the 8th failed attempt", async () => {
    responseStatus = 500;
    const delivery = await seedDelivery("whsec_test_dead");
    await db.update(schema.webhookDelivery).set({ attempts: 7 }).where(eq(schema.webhookDelivery.id, delivery.id));

    await deliverWebhook(db, delivery.id, TEST_KEY);

    const [row] = await db.select().from(schema.webhookDelivery).where(eq(schema.webhookDelivery.id, delivery.id));
    expect(row.status).toBe("dead");
    expect(row.attempts).toBe(8);
  });
});
