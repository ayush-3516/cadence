import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import request from "supertest";
import { Wallet } from "ethers";
import { SiweMessage } from "siwe";
import fastifyCookie from "@fastify/cookie";
import { createDbClient, type DbClient } from "@cadence/db";
import { AppModule } from "../src/app.module.js";
import { startTestDatabase, stopTestDatabase, seedOnchainPlan, seedOnchainPayout } from "./setup.js";

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

  await request(server).post("/v1/merchants").set("Cookie", cookie).send({ name: "Payouts Test Co", ownerAddress: wallet.address });

  return { cookie, ownerAddress: wallet.address };
}

describe("Payouts", () => {
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

  it("lists payouts for the caller's own plan's split", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const plan = await seedOnchainPlan(db, { merchantAddress: ownerAddress, payoutSplit: "0xmysplit000000000000000000000000000000a" });
    await seedOnchainPayout(db, { splitAddress: plan.payoutSplit, amount: "1000000" });

    const response = await request(server).get("/v1/payouts").set("Cookie", cookie);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].split_address).toBe("0xmysplit000000000000000000000000000000a");
    expect(response.body.data[0].amount).toBe("1000000");
  });

  it("does not show another merchant's payouts", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const otherPlan = await seedOnchainPlan(db, {
      merchantAddress: "0x9999999999999999999999999999999999999a",
      payoutSplit: "0xothersplit0000000000000000000000000000b",
    });
    await seedOnchainPayout(db, { splitAddress: otherPlan.payoutSplit });

    const response = await request(server).get("/v1/payouts").set("Cookie", cookie);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(0);
  });

  it("paginates with has_more and next_cursor", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const plan = await seedOnchainPlan(db, { merchantAddress: ownerAddress, payoutSplit: "0xpagesplit0000000000000000000000000000c" });
    for (let i = 0; i < 3; i += 1) {
      await seedOnchainPayout(db, { splitAddress: plan.payoutSplit });
    }

    const firstPage = await request(server).get("/v1/payouts?limit=2").set("Cookie", cookie);
    expect(firstPage.body.data).toHaveLength(2);
    expect(firstPage.body.has_more).toBe(true);
    expect(firstPage.body.next_cursor).not.toBeNull();
  });

  it("rejects a request with no session cookie and no API key", async () => {
    const response = await request(server).get("/v1/payouts");
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("missing_credentials");
  });
});
