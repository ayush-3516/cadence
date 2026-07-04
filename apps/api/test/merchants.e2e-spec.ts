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

async function signInAndGetCookie(server: Server, wallet: HDNodeWallet): Promise<string> {
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
  return (verifyResponse.headers["set-cookie"][0] as string).split(";")[0];
}

describe("Merchants", () => {
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

  it("creates a merchant tied to the session address, then GET /me returns it", async () => {
    const wallet = Wallet.createRandom();
    const cookie = await signInAndGetCookie(server, wallet);

    const createResponse = await request(server)
      .post("/v1/merchants")
      .set("Cookie", cookie)
      .send({ name: "Maya's API Co", ownerAddress: wallet.address });

    expect(createResponse.status).toBe(201);
    expect(createResponse.body.name).toBe("Maya's API Co");
    expect(createResponse.body.ownerAddress.toLowerCase()).toBe(wallet.address.toLowerCase());
    expect(createResponse.body.livemode).toBe(false);

    const meResponse = await request(server).get("/v1/merchants/me").set("Cookie", cookie);
    expect(meResponse.status).toBe(200);
    expect(meResponse.body.name).toBe("Maya's API Co");
  });

  it("rejects merchant creation when ownerAddress doesn't match the session", async () => {
    const wallet = Wallet.createRandom();
    const otherWallet = Wallet.createRandom();
    const cookie = await signInAndGetCookie(server, wallet);

    const response = await request(server)
      .post("/v1/merchants")
      .set("Cookie", cookie)
      .send({ name: "Impersonator Inc", ownerAddress: otherWallet.address });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("address_mismatch");
  });

  it("rejects merchant creation without a session", async () => {
    const wallet = Wallet.createRandom();
    const response = await request(server)
      .post("/v1/merchants")
      .send({ name: "No Session Co", ownerAddress: wallet.address });

    expect(response.status).toBe(401);
  });

  it("GET /me returns 400 when no merchant exists yet for the session", async () => {
    const wallet = Wallet.createRandom();
    const cookie = await signInAndGetCookie(server, wallet);

    const response = await request(server).get("/v1/merchants/me").set("Cookie", cookie);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("merchant_not_found");
  });
});
