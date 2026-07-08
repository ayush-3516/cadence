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
  await request(server).post("/v1/merchants").set("Cookie", cookie).send({ name: "Analytics Test Co", ownerAddress: wallet.address });
  return { cookie, ownerAddress: wallet.address };
}

async function createPublishableKey(server: Server, cookie: string): Promise<string> {
  const response = await request(server).post("/v1/api-keys").set("Cookie", cookie).send({ type: "publishable" });
  return response.body.key;
}

describe("Analytics", () => {
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

  async function seedRollupRow(ownerAddress: string, date: string, overrides: Partial<typeof schema.analyticsDaily.$inferInsert> = {}) {
    const [merchantRow] = await db.select().from(schema.merchant).where(eq(schema.merchant.ownerAddress, ownerAddress));
    await db.insert(schema.analyticsDaily).values({
      merchantId: merchantRow.id,
      date,
      mrrUsd: "1000.000000",
      arrUsd: "12000.000000",
      activeSubs: 10,
      trialingSubs: 2,
      pastDueSubs: 1,
      newSubs: 1,
      canceledSubs: 0,
      grossVolumeUsd: "500.000000",
      feeRevenueUsd: "12.500000",
      ...overrides,
    });
  }

  it("returns the latest rollup row reshaped as the summary response", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    await seedRollupRow(ownerAddress, "2026-07-01");
    await seedRollupRow(ownerAddress, "2026-07-02", { mrrUsd: "1500.000000", arrUsd: "18000.000000", activeSubs: 15 });

    const response = await request(server).get("/v1/analytics/summary").set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.body.mrr_usd).toBe("1500.000000");
    expect(response.body.arr_usd).toBe("18000.000000");
    expect(response.body.active_subscriptions).toBe(15);
    expect(response.body).toHaveProperty("arpu_usd");
    expect(response.body).toHaveProperty("gross_volume_30d_usd");
    expect(response.body).toHaveProperty("fee_revenue_30d_usd");
    expect(response.body).toHaveProperty("churn_rate_30d");
  });

  it("returns an mrr time series from analytics_daily", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    await seedRollupRow(ownerAddress, "2026-06-01", { mrrUsd: "1000.000000" });
    await seedRollupRow(ownerAddress, "2026-06-02", { mrrUsd: "1100.000000" });
    await seedRollupRow(ownerAddress, "2026-06-03", { mrrUsd: "1200.000000" });

    const response = await request(server)
      .get("/v1/analytics/mrr")
      .query({ from: "2026-06-01", to: "2026-06-03", interval: "day" })
      .set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(3);
    expect(response.body.data[0]).toEqual({ date: "2026-06-01", mrr_usd: "1000.000000", arr_usd: "12000.000000" });
    expect(response.body.data[2].mrr_usd).toBe("1200.000000");
  });

  it("does not show another merchant's rollup data", async () => {
    const { cookie: cookieA, ownerAddress: ownerA } = await signInAndCreateMerchant(server);
    const { cookie: cookieB } = await signInAndCreateMerchant(server);
    await seedRollupRow(ownerA, "2026-07-05");

    const response = await request(server).get("/v1/analytics/summary").set("Cookie", cookieB);
    expect(response.status).toBe(200);
    expect(response.body.mrr_usd).toBe("0.000000"); // no rollup rows for this merchant — zeroed response, not another merchant's data
  });

  it("rejects a publishable key on the summary and mrr routes", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const pubKey = await createPublishableKey(server, cookie);

    const summaryResponse = await request(server).get("/v1/analytics/summary").set("Authorization", `Bearer ${pubKey}`);
    expect(summaryResponse.status).toBe(403);
    expect(summaryResponse.body.error.code).toBe("key_type_not_allowed");

    const mrrResponse = await request(server).get("/v1/analytics/mrr").set("Authorization", `Bearer ${pubKey}`);
    expect(mrrResponse.status).toBe(403);
  });

  it("computes churn rate and revenue churn over a window", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    await seedRollupRow(ownerAddress, "2026-05-01", { activeSubs: 100, mrrUsd: "5000.000000", canceledSubs: 0 });
    await seedRollupRow(ownerAddress, "2026-05-15", { activeSubs: 97, mrrUsd: "4900.000000", canceledSubs: 3 });
    await seedRollupRow(ownerAddress, "2026-05-31", { activeSubs: 95, mrrUsd: "4900.000000", canceledSubs: 2 });

    const response = await request(server)
      .get("/v1/analytics/churn")
      .query({ from: "2026-05-01", to: "2026-05-31" })
      .set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.body.churn_rate).toBeCloseTo(5 / 100, 6); // 3+2 canceled across the window / 100 starting actives
    expect(response.body.revenue_churn).toBeCloseTo(100 / 5000, 6); // (5000-4900)/5000
  });

  it("returns zero churn for a merchant with no rollup history", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const response = await request(server).get("/v1/analytics/churn").set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.body.churn_rate).toBe(0);
    expect(response.body.revenue_churn).toBe(0);
  });

  it("computes a cohort retention matrix from onchain_subscription", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const [merchantRow] = await db.select().from(schema.merchant).where(eq(schema.merchant.ownerAddress, ownerAddress));
    await db.insert(onchainSchema.onchainPlan).values({
      onchainPlanId: `${Date.now()}`,
      merchantAddress: ownerAddress,
      payoutSplit: ownerAddress,
      token: "0xusdc",
      amount: "10000000",
      periodSeconds: 2_592_000n,
      trialSeconds: 0n,
      active: true,
      chainId: 84532,
    });
    const [plan] = await db.select().from(onchainSchema.onchainPlan).where(eq(onchainSchema.onchainPlan.merchantAddress, ownerAddress));
    await db.insert(onchainSchema.onchainSubscription).values([
      { onchainSubId: `${Date.now()}1`, onchainPlanId: plan.onchainPlanId, subscriberAddress: "0x111", status: "active", currentPeriodEnd: new Date(), pausedRemaining: 0n, pendingCancel: false, chainId: 84532, createdAt: new Date("2026-01-15T00:00:00Z") },
      { onchainSubId: `${Date.now()}2`, onchainPlanId: plan.onchainPlanId, subscriberAddress: "0x222", status: "canceled", currentPeriodEnd: new Date(), pausedRemaining: 0n, pendingCancel: false, chainId: 84532, createdAt: new Date("2026-01-20T00:00:00Z"), canceledAt: new Date("2026-02-10T00:00:00Z") },
    ]);

    const response = await request(server).get("/v1/analytics/cohorts").set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.data)).toBe(true);
    const januaryCohort = response.body.data.find((c: { cohort: string }) => c.cohort === "2026-01");
    expect(januaryCohort).toBeDefined();
    expect(januaryCohort.cohort_size).toBe(2);
    // Retention here checks CURRENT status against whether the offset-month has occurred yet (documented
    // simplification — no status-history table). Of the two January subs, only the "active" one currently
    // counts as retained; the "canceled" one never counts as retained at any offset under this check.
    expect(januaryCohort.offsets[0].retention_pct).toBeCloseTo(0.5, 6);
  });

  it("rejects a publishable key on churn and cohorts", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const pubKey = await createPublishableKey(server, cookie);

    const churnResponse = await request(server).get("/v1/analytics/churn").set("Authorization", `Bearer ${pubKey}`);
    expect(churnResponse.status).toBe(403);

    const cohortsResponse = await request(server).get("/v1/analytics/cohorts").set("Authorization", `Bearer ${pubKey}`);
    expect(cohortsResponse.status).toBe(403);
  });
});
