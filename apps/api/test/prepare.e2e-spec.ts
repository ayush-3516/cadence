import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import request from "supertest";
import { Wallet } from "ethers";
import { SiweMessage } from "siwe";
import fastifyCookie from "@fastify/cookie";
import { decodeFunctionData } from "viem";
import { subscriptionManagerAbi } from "@cadence/shared";
import { createDbClient, type DbClient } from "@cadence/db";
import { AppModule } from "../src/app.module.js";
import { startTestDatabase, stopTestDatabase } from "./setup.js";

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

  await request(server).post("/v1/merchants").set("Cookie", cookie).send({ name: "Prepare Test Co", ownerAddress: wallet.address });

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

describe("Prepare", () => {
  let app: NestFastifyApplication;
  let server: Server;
  let db: DbClient;

  beforeAll(async () => {
    const connectionUri = await startTestDatabase();
    process.env.DATABASE_URL = connectionUri;
    process.env.JWT_SECRET = "test-secret";
    process.env.WEBHOOK_SIGNING_ROTATION_KEY = "test-rotation-key-0123456789abcd";
    process.env.CHAIN_ID = "84532";
    process.env.RPC_URL_HTTP = "http://127.0.0.1:1"; // unused by /v1/prepare/plan; /subscribe's coverage in Task 5 overrides the client via DI instead of relying on this being reachable
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

  it("returns createPlan calldata that decodes back to the given params", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const secretKey = await createSecretKey(server, cookie);

    const response = await request(server)
      .get("/v1/prepare/plan")
      .set("Authorization", `Bearer ${secretKey}`)
      .query({
        payoutSplit: "0xdef000000000000000000000000000000000000b",
        token: "0x000000000000000000000000000000000000000c",
        amount: "20000000",
        period: "2592000",
        trial: "0",
      });

    expect(response.status).toBe(200);
    expect(response.body.value).toBe("0");
    expect(response.body.to).toBe("0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9");

    const decoded = decodeFunctionData({ abi: subscriptionManagerAbi, data: response.body.data });
    expect(decoded.functionName).toBe("createPlan");
    expect(decoded.args).toEqual(["0xdef000000000000000000000000000000000000b", "0x000000000000000000000000000000000000000C", 20000000n, 2592000, 0]);
  });

  it("rejects a publishable key on GET /v1/prepare/plan", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const pubKey = await createPublishableKey(server, cookie);

    const response = await request(server)
      .get("/v1/prepare/plan")
      .set("Authorization", `Bearer ${pubKey}`)
      .query({
        payoutSplit: "0xdef000000000000000000000000000000000000b",
        token: "0x000000000000000000000000000000000000000c",
        amount: "20000000",
        period: "2592000",
        trial: "0",
      });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("key_type_not_allowed");
  });

  it("returns a 400-range error for a malformed address", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const secretKey = await createSecretKey(server, cookie);

    const response = await request(server)
      .get("/v1/prepare/plan")
      .set("Authorization", `Bearer ${secretKey}`)
      .query({
        payoutSplit: "not-an-address",
        token: "0x000000000000000000000000000000000000000c",
        amount: "20000000",
        period: "2592000",
        trial: "0",
      });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});
