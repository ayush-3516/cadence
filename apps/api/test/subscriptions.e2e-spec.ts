import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import request from "supertest";
import { Wallet } from "ethers";
import { SiweMessage } from "siwe";
import fastifyCookie from "@fastify/cookie";
import { createDbClient, type DbClient } from "@cadence/db";
import { AppModule } from "../src/app.module.js";
import { startTestDatabase, stopTestDatabase, seedOnchainPlan, seedOnchainSubscription, seedOnchainCharge } from "./setup.js";

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

  await request(server).post("/v1/merchants").set("Cookie", cookie).send({ name: "Sub Test Co", ownerAddress: wallet.address });

  return { cookie, ownerAddress: wallet.address };
}

async function createPublishableKey(server: Server, cookie: string): Promise<string> {
  const response = await request(server).post("/v1/api-keys").set("Cookie", cookie).send({ type: "publishable" });
  return response.body.key;
}

describe("Subscriptions", () => {
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

  it("lists only the calling merchant's subscriptions", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const ownPlan = await seedOnchainPlan(db, { merchantAddress: ownerAddress });
    const otherPlan = await seedOnchainPlan(db, { merchantAddress: "0x6666666666666666666666666666666666666e" });
    await seedOnchainSubscription(db, { onchainPlanId: ownPlan.onchainPlanId, subscriberAddress: "0x1111111111111111111111111111111111111f" });
    await seedOnchainSubscription(db, { onchainPlanId: otherPlan.onchainPlanId });

    const response = await request(server).get("/v1/subscriptions").set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].subscriber).toBe("0x1111111111111111111111111111111111111f");
  });

  it("filters subscriptions by status", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const plan = await seedOnchainPlan(db, { merchantAddress: ownerAddress });
    await seedOnchainSubscription(db, { onchainPlanId: plan.onchainPlanId, status: "active" });
    await seedOnchainSubscription(db, { onchainPlanId: plan.onchainPlanId, status: "past_due" });

    const response = await request(server).get("/v1/subscriptions?status=past_due").set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].status).toBe("past_due");
  });

  it("filters subscriptions by subscriber address", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const plan = await seedOnchainPlan(db, { merchantAddress: ownerAddress });
    await seedOnchainSubscription(db, { onchainPlanId: plan.onchainPlanId, subscriberAddress: "0x2220000000000000000000000000000000000a" });
    await seedOnchainSubscription(db, { onchainPlanId: plan.onchainPlanId, subscriberAddress: "0x3330000000000000000000000000000000000b" });

    const response = await request(server)
      .get("/v1/subscriptions?subscriber=0x2220000000000000000000000000000000000a")
      .set("Cookie", cookie);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].subscriber).toBe("0x2220000000000000000000000000000000000a");
  });

  it("rejects GET /v1/subscriptions with a publishable key", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    await seedOnchainPlan(db, { merchantAddress: ownerAddress });
    const pubKey = await createPublishableKey(server, cookie);

    const response = await request(server).get("/v1/subscriptions").set("Authorization", `Bearer ${pubKey}`);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("key_type_not_allowed");
  });

  it("gets subscription detail with embedded charge history, most recent first", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const plan = await seedOnchainPlan(db, { merchantAddress: ownerAddress });
    const sub = await seedOnchainSubscription(db, { onchainPlanId: plan.onchainPlanId });
    await seedOnchainCharge(db, {
      onchainSubId: sub.onchainSubId,
      onchainPlanId: plan.onchainPlanId,
      chargedAt: new Date("2026-05-01T00:00:00Z"),
    });
    await seedOnchainCharge(db, {
      onchainSubId: sub.onchainSubId,
      onchainPlanId: plan.onchainPlanId,
      chargedAt: new Date("2026-06-01T00:00:00Z"),
    });

    const response = await request(server).get(`/v1/subscriptions/${sub.onchainSubId}`).set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.body.onchain_sub_id).toBe(sub.onchainSubId);
    expect(response.body.plan.onchain_plan_id).toBe(plan.onchainPlanId);
    expect(response.body.plan.amount).toBe("20000000");
    expect(response.body.charges).toHaveLength(2);
    expect(response.body.charges[0].charged_at).toBe("2026-06-01T00:00:00.000Z");
    expect(response.body.charges[1].charged_at).toBe("2026-05-01T00:00:00.000Z");
  });

  it("returns 404 for another merchant's subscription", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const otherPlan = await seedOnchainPlan(db, { merchantAddress: "0x5555555555555555555555555555555555555a" });
    const sub = await seedOnchainSubscription(db, { onchainPlanId: otherPlan.onchainPlanId });

    const response = await request(server).get(`/v1/subscriptions/${sub.onchainSubId}`).set("Cookie", cookie);
    expect(response.status).toBe(404);
  });

  it("paginates subscription list", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const plan = await seedOnchainPlan(db, { merchantAddress: ownerAddress });
    for (let i = 0; i < 3; i += 1) {
      await seedOnchainSubscription(db, { onchainPlanId: plan.onchainPlanId });
    }

    const firstPage = await request(server).get("/v1/subscriptions?limit=2").set("Cookie", cookie);
    expect(firstPage.body.data).toHaveLength(2);
    expect(firstPage.body.has_more).toBe(true);

    const secondPage = await request(server)
      .get(`/v1/subscriptions?limit=2&starting_after=${firstPage.body.next_cursor}`)
      .set("Cookie", cookie);
    expect(secondPage.body.data).toHaveLength(1);
    expect(secondPage.body.has_more).toBe(false);
  });
});
