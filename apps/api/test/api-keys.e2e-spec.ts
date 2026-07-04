import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import request from "supertest";
import { HDNodeWallet, Wallet } from "ethers";
import { SiweMessage } from "siwe";
import fastifyCookie from "@fastify/cookie";
import { AppModule } from "../src/app.module.js";
import { startTestDatabase, stopTestDatabase } from "./setup.js";

// Inferred from the actual accessor (not `unknown`) so that `request(server)`
// below still type-checks against supertest's expected `App` argument type.
type Server = ReturnType<ReturnType<NestFastifyApplication["getHttpAdapter"]>["getInstance"]>["server"];

async function signInAndCreateMerchant(server: Server): Promise<{ cookie: string; wallet: HDNodeWallet }> {
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

  await request(server).post("/v1/merchants").set("Cookie", cookie).send({ name: "Test Co", ownerAddress: wallet.address });

  return { cookie, wallet };
}

describe("API Keys", () => {
  let app: NestFastifyApplication;
  let server: Server;

  beforeAll(async () => {
    const connectionUri = await startTestDatabase();
    process.env.DATABASE_URL = connectionUri;
    process.env.JWT_SECRET = "test-secret";

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // Mirrors src/main.ts: the SessionGuard reads request.cookies and the
    // AuthController sets a cookie on the reply, both of which require the
    // @fastify/cookie plugin to be registered on the underlying Fastify
    // instance. Without this, `reply.setCookie` doesn't exist at runtime.
    await app.register(fastifyCookie, { secret: "test-secret" });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    server = app.getHttpAdapter().getInstance().server;
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await stopTestDatabase();
  });

  it("creates a secret key, shows the raw key once, and never returns the hash", async () => {
    const { cookie } = await signInAndCreateMerchant(server);

    const createResponse = await request(server).post("/v1/api-keys").set("Cookie", cookie).send({ type: "secret" });
    expect(createResponse.status).toBe(201);
    expect(createResponse.body.key).toMatch(/^ck_test_sec_/);
    expect(createResponse.body).not.toHaveProperty("keyHash");

    const listResponse = await request(server).get("/v1/api-keys").set("Cookie", cookie);
    expect(listResponse.status).toBe(200);
    expect(listResponse.body).toHaveLength(1);
    expect(listResponse.body[0]).not.toHaveProperty("keyHash");
    expect(listResponse.body[0]).not.toHaveProperty("key");
    expect(listResponse.body[0].prefix).toMatch(/^ck_test_sec_/);
  });

  it("authenticates GET /v1/merchants/me using a created secret key, and records last_used_at", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const createResponse = await request(server).post("/v1/api-keys").set("Cookie", cookie).send({ type: "secret" });
    const { id, key } = createResponse.body;

    const beforeList = await request(server).get("/v1/api-keys").set("Cookie", cookie);
    const beforeKey = beforeList.body.find((row: { id: string }) => row.id === id);
    expect(beforeKey.lastUsedAt).toBeNull();

    const meResponse = await request(server).get("/v1/merchants/me").set("Authorization", `Bearer ${key}`);
    expect(meResponse.status).toBe(200);
    expect(meResponse.body.name).toBe("Test Co");

    const afterList = await request(server).get("/v1/api-keys").set("Cookie", cookie);
    const afterKey = afterList.body.find((row: { id: string }) => row.id === id);
    expect(afterKey.lastUsedAt).not.toBeNull();
  });

  it("rejects a revoked key", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const createResponse = await request(server).post("/v1/api-keys").set("Cookie", cookie).send({ type: "secret" });
    const { id, key } = createResponse.body;

    const revokeResponse = await request(server).delete(`/v1/api-keys/${id}`).set("Cookie", cookie);
    expect(revokeResponse.status).toBe(200);

    const meResponse = await request(server).get("/v1/merchants/me").set("Authorization", `Bearer ${key}`);
    expect(meResponse.status).toBe(401);
    expect(meResponse.body.error.code).toBe("invalid_api_key");
  });

  it("rejects a nonexistent key", async () => {
    const response = await request(server).get("/v1/merchants/me").set("Authorization", "Bearer ck_test_sec_doesnotexist");
    expect(response.status).toBe(401);
  });
});
