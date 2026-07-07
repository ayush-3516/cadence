import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import request from "supertest";
import { Wallet } from "ethers";
import { SiweMessage } from "siwe";
import fastifyCookie from "@fastify/cookie";
import { eq } from "drizzle-orm";
import { createDbClient, schema, onchainSchema, type DbClient } from "@cadence/db";
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
  await request(server).post("/v1/merchants").set("Cookie", cookie).send({ name: "Invoice Test Co", ownerAddress: wallet.address });
  return { cookie, ownerAddress: wallet.address };
}

async function createPublishableKey(server: Server, cookie: string): Promise<string> {
  const response = await request(server).post("/v1/api-keys").set("Cookie", cookie).send({ type: "publishable" });
  return response.body.key;
}

describe("Invoices", () => {
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

  async function seedInvoice(ownerAddress: string, subscriberAddress: string, number: string) {
    const [merchantRow] = await db.select().from(schema.merchant).where(eq(schema.merchant.ownerAddress, ownerAddress));
    await db.insert(onchainSchema.onchainSubscription).values({
      onchainSubId: `${Date.now()}${Math.floor(Math.random() * 1000)}`,
      onchainPlanId: "1",
      subscriberAddress,
      status: "active",
      currentPeriodEnd: new Date(),
      pausedRemaining: 0n,
      pendingCancel: false,
      chainId: 84532,
    }).returning();
    const [sub] = await db.select().from(onchainSchema.onchainSubscription).where(eq(onchainSchema.onchainSubscription.subscriberAddress, subscriberAddress));
    const [invoiceRow] = await db
      .insert(schema.invoice)
      .values({
        merchantId: merchantRow.id,
        number,
        txHash: `0x${Math.random().toString(16).slice(2)}`,
        amount: "20000000",
        platformFee: "150000",
        net: "19850000",
        onchainSubId: sub.onchainSubId,
        onchainPlanId: "1",
      })
      .returning();
    return invoiceRow;
  }

  it("lists invoices scoped to the calling merchant via secret key", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    await seedInvoice(ownerAddress, "0x1111111111111111111111111111111111111111", "CAD-000001");

    const response = await request(server).get("/v1/invoices").set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].number).toBe("CAD-000001");
  });

  it("does not show another merchant's invoices", async () => {
    const { cookie: cookieA, ownerAddress: ownerA } = await signInAndCreateMerchant(server);
    const { cookie: cookieB } = await signInAndCreateMerchant(server);
    await seedInvoice(ownerA, "0x2222222222222222222222222222222222222222", "CAD-000001");

    const response = await request(server).get("/v1/invoices").set("Cookie", cookieB);
    expect(response.body.data).toHaveLength(0);
  });

  it("gets invoice detail by id via secret key", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const invoiceRow = await seedInvoice(ownerAddress, "0x3333333333333333333333333333333333333333", "CAD-000001");

    const response = await request(server).get(`/v1/invoices/${invoiceRow.id}`).set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.body.number).toBe("CAD-000001");
    expect(response.body.pdf_url).toBeNull();
    expect(response.body.tx_hash).toBe(invoiceRow.txHash);
  });

  it("returns 404 for another merchant's invoice detail", async () => {
    const { cookie: cookieA, ownerAddress: ownerA } = await signInAndCreateMerchant(server);
    const { cookie: cookieB } = await signInAndCreateMerchant(server);
    const invoiceRow = await seedInvoice(ownerA, "0x4444444444444444444444444444444444444444", "CAD-000001");

    const response = await request(server).get(`/v1/invoices/${invoiceRow.id}`).set("Cookie", cookieB);
    expect(response.status).toBe(404);
  });

  it("rejects a publishable-key list request without a subscriber filter", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const pubKey = await createPublishableKey(server, cookie);

    const response = await request(server).get("/v1/invoices").set("Authorization", `Bearer ${pubKey}`);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("subscriber_required");
  });

  it("scopes a publishable-key list request to the given subscriber", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const pubKey = await createPublishableKey(server, cookie);
    await seedInvoice(ownerAddress, "0x5555555555555555555555555555555555555555", "CAD-000001");
    await seedInvoice(ownerAddress, "0x6666666666666666666666666666666666666666", "CAD-000002");

    const response = await request(server)
      .get("/v1/invoices")
      .query({ subscriber: "0x5555555555555555555555555555555555555555" })
      .set("Authorization", `Bearer ${pubKey}`);
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].number).toBe("CAD-000001");
  });

  it("allows a publishable key to fetch any invoice detail belonging to its own merchant", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const pubKey = await createPublishableKey(server, cookie);
    const invoiceRow = await seedInvoice(ownerAddress, "0x7777777777777777777777777777777777777777", "CAD-000001");

    const response = await request(server).get(`/v1/invoices/${invoiceRow.id}`).set("Authorization", `Bearer ${pubKey}`);
    expect(response.status).toBe(200);
    expect(response.body.number).toBe("CAD-000001");
  });

  it("paginates invoices across multiple pages without skipping or duplicating rows", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const created = [
      await seedInvoice(ownerAddress, "0x8888888888888888888888888888888888888a", "CAD-000101"),
      await seedInvoice(ownerAddress, "0x8888888888888888888888888888888888888b", "CAD-000102"),
      await seedInvoice(ownerAddress, "0x8888888888888888888888888888888888888c", "CAD-000103"),
    ];

    const seenIds = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const response: { body: { data: { id: string }[]; has_more: boolean; next_cursor: string | null } } = await request(server)
        .get("/v1/invoices")
        .query(cursor ? { limit: "2", starting_after: cursor } : { limit: "2" })
        .set("Cookie", cookie);
      pages += 1;
      expect(pages).toBeLessThan(10); // guard against a non-terminating cursor
      for (const row of response.body.data) {
        expect(seenIds.has(row.id)).toBe(false); // no duplicates across pages
        seenIds.add(row.id);
      }
      cursor = response.body.has_more ? response.body.next_cursor : null;
    } while (cursor);

    expect(seenIds.size).toBe(3);
    for (const invoiceRow of created) {
      expect(seenIds.has(invoiceRow.id)).toBe(true); // no skips
    }
  });
});
