import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import request from "supertest";
import { Wallet } from "ethers";
import { SiweMessage } from "siwe";
import fastifyCookie from "@fastify/cookie";
import { createDbClient, type DbClient } from "@cadence/db";
import { AppModule } from "../src/app.module.js";
import { startTestDatabase, stopTestDatabase, seedOnchainPlan, seedOnchainSubscription } from "./setup.js";

type Server = ReturnType<ReturnType<NestFastifyApplication["getHttpAdapter"]>["getInstance"]>["server"];

async function signInAndCreateMerchant(server: Server): Promise<{ cookie: string; ownerAddress: string }> {
  const wallet = Wallet.createRandom();
  const nonceResponse = await request(server).post("/v1/auth/nonce").send();
  const { nonce } = nonceResponse.body;

  const siweMessage = new SiweMessage({
    domain: "localhost",
    address: wallet.address,
    uri: "http://localhost:3000",
    version: "1",
    chainId: 1,
    nonce,
  });
  const messageToSign = siweMessage.prepareMessage();
  const signature = await wallet.signMessage(messageToSign);
  const verifyResponse = await request(server).post("/v1/auth/verify").send({ message: messageToSign, signature });
  const cookie = (verifyResponse.headers["set-cookie"][0] as string).split(";")[0];

  await request(server).post("/v1/merchants").set("Cookie", cookie).send({ name: "Customer Test Co", ownerAddress: wallet.address });

  return { cookie, ownerAddress: wallet.address };
}

async function createSecretKey(server: Server, cookie: string): Promise<string> {
  const response = await request(server).post("/v1/api-keys").set("Cookie", cookie).send({ type: "secret" });
  return response.body.key;
}

async function createPublishableKey(server: Server, cookie: string): Promise<string> {
  const response = await request(server).post("/v1/api-keys").set("Cookie", cookie).send({ type: "publishable" });
  return response.body.key;
}

describe("Customers", () => {
  let app: NestFastifyApplication;
  let server: Server;
  let db: DbClient;

  beforeAll(async () => {
    const connectionUri = await startTestDatabase();
    process.env.DATABASE_URL = connectionUri;
    process.env.JWT_SECRET = "test-secret";
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

  it("lists only the calling merchant's customers, derived from on-chain subscriptions", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const ownPlan = await seedOnchainPlan(db, { merchantAddress: ownerAddress });
    const otherPlan = await seedOnchainPlan(db, { merchantAddress: "0x9990000000000000000000000000000000000a" });
    await seedOnchainSubscription(db, { onchainPlanId: ownPlan.onchainPlanId, subscriberAddress: "0x1110000000000000000000000000000000000f" });
    await seedOnchainSubscription(db, { onchainPlanId: otherPlan.onchainPlanId, subscriberAddress: "0x2220000000000000000000000000000000000f" });

    const response = await request(server).get("/v1/customers").set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].address).toBe("0x1110000000000000000000000000000000000f");
    expect(response.body.data[0].email).toBeNull();
    expect(response.body.data[0].subscription_count).toBe(1);
  });

  it("shows the opt-in email once set, and counts multiple subscriptions correctly", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const plan = await seedOnchainPlan(db, { merchantAddress: ownerAddress });
    const subscriberAddress = "0x3330000000000000000000000000000000000f";
    await seedOnchainSubscription(db, { onchainPlanId: plan.onchainPlanId, subscriberAddress });
    await seedOnchainSubscription(db, { onchainPlanId: plan.onchainPlanId, subscriberAddress });

    await request(server).post(`/v1/customers/${subscriberAddress}/email`).set("Cookie", cookie).send({ email: "customer@example.com" });

    const response = await request(server).get("/v1/customers").set("Cookie", cookie);
    const found = response.body.data.find((c: { address: string }) => c.address === subscriberAddress);
    expect(found.email).toBe("customer@example.com");
    expect(found.subscription_count).toBe(2);
  });

  it("paginates customer list with has_more and next_cursor", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const plan = await seedOnchainPlan(db, { merchantAddress: ownerAddress });
    const addresses = [
      "0x1000000000000000000000000000000000000a",
      "0x2000000000000000000000000000000000000a",
      "0x3000000000000000000000000000000000000a",
    ];
    for (const subscriberAddress of addresses) {
      await seedOnchainSubscription(db, { onchainPlanId: plan.onchainPlanId, subscriberAddress });
    }

    const firstPage = await request(server).get("/v1/customers?limit=2").set("Cookie", cookie);
    expect(firstPage.body.data).toHaveLength(2);
    expect(firstPage.body.has_more).toBe(true);
    expect(firstPage.body.next_cursor).not.toBeNull();

    const secondPage = await request(server)
      .get(`/v1/customers?limit=2&starting_after=${firstPage.body.next_cursor}`)
      .set("Cookie", cookie);
    expect(secondPage.body.data).toHaveLength(1);
    expect(secondPage.body.has_more).toBe(false);
  });

  it("rejects GET /v1/customers with a publishable key", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    await seedOnchainPlan(db, { merchantAddress: ownerAddress });
    const pubKey = await createPublishableKey(server, cookie);

    const response = await request(server).get("/v1/customers").set("Authorization", `Bearer ${pubKey}`);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("key_type_not_allowed");
  });

  it("accepts a secret key on GET /v1/customers", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    await seedOnchainPlan(db, { merchantAddress: ownerAddress });
    const secretKey = await createSecretKey(server, cookie);

    const response = await request(server).get("/v1/customers").set("Authorization", `Bearer ${secretKey}`);
    expect(response.status).toBe(200);
  });

  it("gets a customer's subscriptions, scoped to the calling merchant", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const ownPlan = await seedOnchainPlan(db, { merchantAddress: ownerAddress });
    const otherPlan = await seedOnchainPlan(db, { merchantAddress: "0x8880000000000000000000000000000000000a" });
    const subscriberAddress = "0x4440000000000000000000000000000000000f";
    await seedOnchainSubscription(db, { onchainPlanId: ownPlan.onchainPlanId, subscriberAddress });
    await seedOnchainSubscription(db, { onchainPlanId: otherPlan.onchainPlanId, subscriberAddress });

    const response = await request(server).get(`/v1/customers/${subscriberAddress}/subscriptions`).set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].subscriber).toBe(subscriberAddress);
  });

  it("returns an empty list, not 404, for an address with zero subscriptions", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const response = await request(server).get("/v1/customers/0x0000000000000000000000000000000000dead/subscriptions").set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(0);
  });

  it("accepts a publishable key on GET /v1/customers/:address/subscriptions", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const plan = await seedOnchainPlan(db, { merchantAddress: ownerAddress });
    const subscriberAddress = "0x5550000000000000000000000000000000000f";
    await seedOnchainSubscription(db, { onchainPlanId: plan.onchainPlanId, subscriberAddress });
    const pubKey = await createPublishableKey(server, cookie);

    const response = await request(server)
      .get(`/v1/customers/${subscriberAddress}/subscriptions`)
      .set("Authorization", `Bearer ${pubKey}`);
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
  });

  it("sets a customer's email, creating the row on first call", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const address = "0x6660000000000000000000000000000000000f";

    const response = await request(server).post(`/v1/customers/${address}/email`).set("Cookie", cookie).send({ email: "first@example.com" });
    expect(response.status).toBe(201);
    expect(response.body.address).toBe(address);
    expect(response.body.email).toBe("first@example.com");
  });

  it("upserts a customer's email on a second call", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const address = "0x7770000000000000000000000000000000000f";

    await request(server).post(`/v1/customers/${address}/email`).set("Cookie", cookie).send({ email: "old@example.com" });
    const response = await request(server).post(`/v1/customers/${address}/email`).set("Cookie", cookie).send({ email: "new@example.com" });

    expect(response.status).toBe(201);
    expect(response.body.email).toBe("new@example.com");
  });

  it("sets a customer's email independent of any on-chain subscription existing", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const address = "0x8880000000000000000000000000000000000f";

    const response = await request(server).post(`/v1/customers/${address}/email`).set("Cookie", cookie).send({ email: "preregistered@example.com" });
    expect(response.status).toBe(201);
  });

  it("accepts a publishable key on POST /v1/customers/:address/email", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const address = "0x9990000000000000000000000000000000000f";
    const pubKey = await createPublishableKey(server, cookie);

    const response = await request(server)
      .post(`/v1/customers/${address}/email`)
      .set("Authorization", `Bearer ${pubKey}`)
      .send({ email: "viapub@example.com" });
    expect(response.status).toBe(201);
  });

  it("rejects an invalid email", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const address = "0xaaa0000000000000000000000000000000000f";

    const response = await request(server).post(`/v1/customers/${address}/email`).set("Cookie", cookie).send({ email: "not-an-email" });
    expect(response.status).toBe(400);
  });
});
