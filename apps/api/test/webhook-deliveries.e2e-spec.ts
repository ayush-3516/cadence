import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import request from "supertest";
import { Wallet } from "ethers";
import { SiweMessage } from "siwe";
import fastifyCookie from "@fastify/cookie";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type DbClient } from "@cadence/db";
import { AppModule } from "../src/app.module.js";
import { startTestDatabase, stopTestDatabase } from "./setup.js";

type Server = ReturnType<ReturnType<NestFastifyApplication["getHttpAdapter"]>["getInstance"]>["server"];

async function signInAndCreateMerchant(server: Server): Promise<{ cookie: string; ownerAddress: string }> {
  const wallet = Wallet.createRandom();
  const nonceResponse = await request(server).post("/v1/auth/nonce").send();
  const { nonce } = nonceResponse.body;
  const siweMessage = new SiweMessage({ domain: "localhost", address: wallet.address, uri: "http://localhost:3000", version: "1", chainId: 1, nonce });
  const messageToSign = siweMessage.prepareMessage();
  const signature = await wallet.signMessage(messageToSign);
  const verifyResponse = await request(server).post("/v1/auth/verify").send({ message: messageToSign, signature });
  const cookie = (verifyResponse.headers["set-cookie"][0] as string).split(";")[0];
  await request(server).post("/v1/merchants").set("Cookie", cookie).send({ name: "WH Delivery Test Co", ownerAddress: wallet.address });
  return { cookie, ownerAddress: wallet.address };
}

describe("Webhook Deliveries", () => {
  let app: NestFastifyApplication;
  let server: Server;
  let db: DbClient;

  beforeAll(async () => {
    const connectionUri = await startTestDatabase();
    process.env.DATABASE_URL = connectionUri;
    process.env.JWT_SECRET = "test-secret";
    process.env.WEBHOOK_SIGNING_ROTATION_KEY = "test-rotation-key-0123456789abcd";
    db = createDbClient(connectionUri);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie, { secret: "test-secret" });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    server = app.getHttpAdapter().getInstance().server;
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await stopTestDatabase();
  });

  async function seedDeliveryFor(cookie: string, ownerAddress: string) {
    const createResponse = await request(server).post("/v1/webhook-endpoints").set("Cookie", cookie).send({ url: "https://example.com/hook" });
    const endpointId = createResponse.body.id;

    const [merchantRow] = await db.select().from(schema.merchant).where(eq(schema.merchant.ownerAddress, ownerAddress));
    const [evt] = await db.insert(schema.event).values({ merchantId: merchantRow.id, type: "subscription.renewed", data: {}, livemode: false }).returning();
    const [delivery] = await db
      .insert(schema.webhookDelivery)
      .values({ endpointId, eventId: evt.id, eventType: "subscription.renewed", payload: { id: `evt_${evt.id}` }, status: "dead", attempts: 8 })
      .returning();
    return delivery;
  }

  it("lists deliveries scoped to the calling merchant's endpoints", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    await seedDeliveryFor(cookie, ownerAddress);

    const response = await request(server).get("/v1/webhook-deliveries").set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
  });

  it("does not show another merchant's deliveries", async () => {
    const { cookie: cookieA, ownerAddress: ownerA } = await signInAndCreateMerchant(server);
    const { cookie: cookieB } = await signInAndCreateMerchant(server);
    await seedDeliveryFor(cookieA, ownerA);

    const response = await request(server).get("/v1/webhook-deliveries").set("Cookie", cookieB);
    expect(response.body.data).toHaveLength(0);
  });

  it("filters deliveries by status", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    await seedDeliveryFor(cookie, ownerAddress);

    const response = await request(server).get("/v1/webhook-deliveries?status=dead").set("Cookie", cookie);
    expect(response.body.data).toHaveLength(1);

    const emptyResponse = await request(server).get("/v1/webhook-deliveries?status=succeeded").set("Cookie", cookie);
    expect(emptyResponse.body.data).toHaveLength(0);
  });

  it("replays a dead delivery, re-enqueuing without resetting attempts", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const delivery = await seedDeliveryFor(cookie, ownerAddress);

    const response = await request(server).post(`/v1/webhook-deliveries/${delivery.id}/replay`).set("Cookie", cookie);
    expect(response.status).toBe(200);

    const [row] = await db.select().from(schema.webhookDelivery).where(eq(schema.webhookDelivery.id, delivery.id));
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(8); // unchanged — replay doesn't reset the attempt counter
  });

  it("returns 404 replaying another merchant's delivery", async () => {
    const { cookie: cookieA, ownerAddress: ownerA } = await signInAndCreateMerchant(server);
    const { cookie: cookieB } = await signInAndCreateMerchant(server);
    const delivery = await seedDeliveryFor(cookieA, ownerA);

    const response = await request(server).post(`/v1/webhook-deliveries/${delivery.id}/replay`).set("Cookie", cookieB);
    expect(response.status).toBe(404);
  });

  // Extra insurance beyond the brief's literal test list: Task 5's identical (createdAt, id)
  // correlated-subquery cursor pattern needed a real multi-page test to catch a genuine bug
  // (JS-Date round-tripping silently truncating microsecond-precision timestamps, causing the
  // cursor row to reappear on the next page). A naive gt(id)+asc(id) cursor over this table's
  // random UUID primary key would also independently skip/duplicate rows across pages, since
  // UUIDv4 has no relationship to insertion order. This test seeds several delivery rows for one
  // merchant, walks every page with a limit smaller than the row count, and confirms every row
  // id is seen exactly once — this would fail against either buggy version:
  //   - random-UUID gt(id) cursor: rows can be skipped or repeated because `id` ordering has no
  //     relationship to which rows haven't been returned yet.
  //   - JS-Date-roundtrip (createdAt, id) cursor: the cursor row's truncated-down createdAt makes
  //     it satisfy its own `createdAt > cursor` comparison, so it reappears at the start of the
  //     next page (a duplicate), and — depending on `next_cursor` — pagination may never
  //     terminate on a genuine duplicate as expected here.
  it("paginates webhook deliveries across multiple pages without skipping or duplicating rows", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const seeded = [await seedDeliveryFor(cookie, ownerAddress), await seedDeliveryFor(cookie, ownerAddress), await seedDeliveryFor(cookie, ownerAddress)];
    expect(seeded).toHaveLength(3);

    const seenIds = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;

    for (;;) {
      const response = await request(server)
        .get("/v1/webhook-deliveries")
        .query(cursor ? { limit: "2", starting_after: cursor } : { limit: "2" })
        .set("Cookie", cookie);
      expect(response.status).toBe(200);
      pages += 1;
      expect(pages).toBeLessThan(10); // guard against an infinite loop from a non-terminating cursor

      for (const row of response.body.data as { id: string }[]) {
        expect(seenIds.has(row.id)).toBe(false); // no duplicates across pages
        seenIds.add(row.id);
      }

      if (!response.body.has_more) break;
      cursor = response.body.next_cursor;
    }

    expect(seenIds.size).toBe(3); // no skips: every seeded row was returned exactly once
    for (const delivery of seeded) {
      expect(seenIds.has(delivery.id)).toBe(true);
    }
  });
});
