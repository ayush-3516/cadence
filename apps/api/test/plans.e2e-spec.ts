import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import request from "supertest";
import { Wallet } from "ethers";
import { SiweMessage } from "siwe";
import fastifyCookie from "@fastify/cookie";
import { createDbClient, type DbClient } from "@cadence/db";
import { AppModule } from "../src/app.module.js";
import { startTestDatabase, stopTestDatabase, seedOnchainPlan } from "./setup.js";

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

  await request(server).post("/v1/merchants").set("Cookie", cookie).send({ name: "Plan Test Co", ownerAddress: wallet.address });

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

describe("Plans", () => {
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

  it("attaches metadata to a plan owned by the calling merchant", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const plan = await seedOnchainPlan(db, { merchantAddress: ownerAddress });

    const response = await request(server)
      .post(`/v1/plans/${plan.onchainPlanId}/metadata`)
      .set("Cookie", cookie)
      .send({ name: "Pro API", description: "Our pro tier" });

    expect(response.status).toBe(201);
    expect(response.body.name).toBe("Pro API");
    expect(response.body.description).toBe("Our pro tier");
    expect(response.body.onchain_plan_id).toBe(plan.onchainPlanId);
  });

  it("upserts metadata on a second call", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const plan = await seedOnchainPlan(db, { merchantAddress: ownerAddress });

    await request(server).post(`/v1/plans/${plan.onchainPlanId}/metadata`).set("Cookie", cookie).send({ name: "First Name" });
    const response = await request(server)
      .post(`/v1/plans/${plan.onchainPlanId}/metadata`)
      .set("Cookie", cookie)
      .send({ name: "Second Name" });

    expect(response.status).toBe(201);
    expect(response.body.name).toBe("Second Name");

    const listResponse = await request(server).get("/v1/plans").set("Cookie", cookie);
    const matching = listResponse.body.data.filter((p: { onchain_plan_id: string }) => p.onchain_plan_id === plan.onchainPlanId);
    expect(matching).toHaveLength(1);
  });

  it("rejects attaching metadata to a plan owned by a different merchant", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const plan = await seedOnchainPlan(db, { merchantAddress: "0x9999999999999999999999999999999999999a" });

    const response = await request(server)
      .post(`/v1/plans/${plan.onchainPlanId}/metadata`)
      .set("Cookie", cookie)
      .send({ name: "Should Not Work" });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("plan_not_owned");
  });

  it("returns 404 attaching metadata to a nonexistent plan", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const response = await request(server).post("/v1/plans/999999/metadata").set("Cookie", cookie).send({ name: "Ghost Plan" });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("plan_not_found");
  });

  it("lists only the calling merchant's plans, with metadata joined", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const ownPlan = await seedOnchainPlan(db, { merchantAddress: ownerAddress });
    await seedOnchainPlan(db, { merchantAddress: "0x8888888888888888888888888888888888888b" });
    await request(server).post(`/v1/plans/${ownPlan.onchainPlanId}/metadata`).set("Cookie", cookie).send({ name: "My Plan" });

    const response = await request(server).get("/v1/plans").set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].name).toBe("My Plan");
    expect(response.body.has_more).toBe(false);
  });

  it("lists a plan with no metadata yet as null fields, not an error", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    await seedOnchainPlan(db, { merchantAddress: ownerAddress });

    const response = await request(server).get("/v1/plans").set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.body.data[0].name).toBeNull();
  });

  it("paginates plan list with has_more and next_cursor", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    for (let i = 0; i < 3; i += 1) {
      await seedOnchainPlan(db, { merchantAddress: ownerAddress });
    }

    const firstPage = await request(server).get("/v1/plans?limit=2").set("Cookie", cookie);
    expect(firstPage.body.data).toHaveLength(2);
    expect(firstPage.body.has_more).toBe(true);
    expect(firstPage.body.next_cursor).not.toBeNull();

    const secondPage = await request(server)
      .get(`/v1/plans?limit=2&starting_after=${firstPage.body.next_cursor}`)
      .set("Cookie", cookie);
    expect(secondPage.body.data).toHaveLength(1);
    expect(secondPage.body.has_more).toBe(false);
  });

  it("gets plan detail by onchainId", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const plan = await seedOnchainPlan(db, { merchantAddress: ownerAddress });
    await request(server).post(`/v1/plans/${plan.onchainPlanId}/metadata`).set("Cookie", cookie).send({ name: "Detail Plan" });

    const response = await request(server).get(`/v1/plans/${plan.onchainPlanId}`).set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.body.name).toBe("Detail Plan");
    expect(response.body.amount).toBe("20000000");
  });

  it("returns 404 for another merchant's plan detail (not 403 — existence not disclosed)", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const plan = await seedOnchainPlan(db, { merchantAddress: "0x7777777777777777777777777777777777777c" });

    const response = await request(server).get(`/v1/plans/${plan.onchainPlanId}`).set("Cookie", cookie);
    expect(response.status).toBe(404);
  });

  it("accepts a publishable key on GET /v1/plans", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    await seedOnchainPlan(db, { merchantAddress: ownerAddress });
    const pubKey = await createPublishableKey(server, cookie);

    const response = await request(server).get("/v1/plans").set("Authorization", `Bearer ${pubKey}`);
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
  });

  it("accepts a secret key on POST /v1/plans/:id/metadata", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const plan = await seedOnchainPlan(db, { merchantAddress: ownerAddress });
    const secretKey = await createSecretKey(server, cookie);

    const response = await request(server)
      .post(`/v1/plans/${plan.onchainPlanId}/metadata`)
      .set("Authorization", `Bearer ${secretKey}`)
      .send({ name: "Via Secret Key" });
    expect(response.status).toBe(201);
  });

  it("rejects a publishable key on POST /v1/plans/:id/metadata with key_type_not_allowed", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const plan = await seedOnchainPlan(db, { merchantAddress: ownerAddress });
    const pubKey = await createPublishableKey(server, cookie);

    const response = await request(server)
      .post(`/v1/plans/${plan.onchainPlanId}/metadata`)
      .set("Authorization", `Bearer ${pubKey}`)
      .send({ name: "Should Fail" });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("key_type_not_allowed");
  });
});
