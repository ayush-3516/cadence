import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import request from "supertest";
import { Wallet } from "ethers";
import { SiweMessage } from "siwe";
import fastifyCookie from "@fastify/cookie";
import { AppModule } from "../src/app.module.js";
import { startTestDatabase, stopTestDatabase } from "./setup.js";

describe("SIWE auth flow", () => {
  let app: NestFastifyApplication;
  // Inferred from the actual accessor (not `unknown`) so that `request(server)`
  // below still type-checks against supertest's expected `App` argument type.
  let server: ReturnType<ReturnType<NestFastifyApplication["getHttpAdapter"]>["getInstance"]>["server"];

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

  it("issues a nonce, accepts a valid signed SIWE message, and sets a session cookie", async () => {
    const nonceResponse = await request(server).post("/v1/auth/nonce").send();
    expect(nonceResponse.status).toBe(201);
    const { nonce } = nonceResponse.body;
    expect(typeof nonce).toBe("string");

    const wallet = Wallet.createRandom();
    const siweMessage = new SiweMessage({
      domain: "localhost",
      address: wallet.address,
      statement: "Sign in to Cadence.",
      uri: "http://localhost:3000",
      version: "1",
      chainId: 1,
      nonce,
    });
    const messageToSign = siweMessage.prepareMessage();
    const signature = await wallet.signMessage(messageToSign);

    const verifyResponse = await request(server)
      .post("/v1/auth/verify")
      .send({ message: messageToSign, signature });

    expect(verifyResponse.status).toBe(201);
    expect(verifyResponse.body).toEqual({ address: wallet.address });
    expect(verifyResponse.headers["set-cookie"]).toBeDefined();
    const cookieHeader = verifyResponse.headers["set-cookie"][0] as string;
    expect(cookieHeader).toContain("cadence_session=");
  });

  it("rejects a reused nonce", async () => {
    const nonceResponse = await request(server).post("/v1/auth/nonce").send();
    const { nonce } = nonceResponse.body;

    const wallet = Wallet.createRandom();
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

    const first = await request(server).post("/v1/auth/verify").send({ message: messageToSign, signature });
    expect(first.status).toBe(201);

    const second = await request(server).post("/v1/auth/verify").send({ message: messageToSign, signature });
    expect(second.status).toBe(401);
    expect(second.body.error.type).toBe("authentication_error");
    expect(second.body.error.code).toBe("invalid_nonce");
  });

  it("rejects an invalid signature", async () => {
    const nonceResponse = await request(server).post("/v1/auth/nonce").send();
    const { nonce } = nonceResponse.body;

    const wallet = Wallet.createRandom();
    const otherWallet = Wallet.createRandom();
    const siweMessage = new SiweMessage({
      domain: "localhost",
      address: wallet.address,
      uri: "http://localhost:3000",
      version: "1",
      chainId: 1,
      nonce,
    });
    const messageToSign = siweMessage.prepareMessage();
    // Sign with the WRONG wallet -> signature won't recover to wallet.address
    const signature = await otherWallet.signMessage(messageToSign);

    const response = await request(server).post("/v1/auth/verify").send({ message: messageToSign, signature });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("invalid_signature");
  });
});
