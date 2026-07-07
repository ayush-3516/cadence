import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import request from "supertest";
import { Wallet } from "ethers";
import { SiweMessage } from "siwe";
import fastifyCookie from "@fastify/cookie";
import { AppModule } from "../src/app.module.js";
import { startTestDatabase, stopTestDatabase } from "./setup.js";

type Server = ReturnType<ReturnType<NestFastifyApplication["getHttpAdapter"]>["getInstance"]>["server"];

async function signInAndCreateMerchant(server: Server): Promise<{ cookie: string }> {
  const wallet = Wallet.createRandom();
  const nonceResponse = await request(server).post("/v1/auth/nonce").send();
  const { nonce } = nonceResponse.body;
  const siweMessage = new SiweMessage({ domain: "localhost", address: wallet.address, uri: "http://localhost:3000", version: "1", chainId: 1, nonce });
  const messageToSign = siweMessage.prepareMessage();
  const signature = await wallet.signMessage(messageToSign);
  const verifyResponse = await request(server).post("/v1/auth/verify").send({ message: messageToSign, signature });
  const cookie = (verifyResponse.headers["set-cookie"][0] as string).split(";")[0];
  await request(server).post("/v1/merchants").set("Cookie", cookie).send({ name: "Webhook Test Co", ownerAddress: wallet.address });
  return { cookie };
}

async function createSecretKey(server: Server, cookie: string): Promise<string> {
  const response = await request(server).post("/v1/api-keys").set("Cookie", cookie).send({ type: "secret" });
  return response.body.key;
}
async function createPublishableKey(server: Server, cookie: string): Promise<string> {
  const response = await request(server).post("/v1/api-keys").set("Cookie", cookie).send({ type: "publishable" });
  return response.body.key;
}

describe("Webhook Endpoints", () => {
  let app: NestFastifyApplication;
  let server: Server;

  beforeAll(async () => {
    const connectionUri = await startTestDatabase();
    process.env.DATABASE_URL = connectionUri;
    process.env.JWT_SECRET = "test-secret";
    process.env.WEBHOOK_SIGNING_ROTATION_KEY = "test-rotation-key-0123456789abcd";

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

  it("creates a webhook endpoint, showing the signing secret once", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const response = await request(server).post("/v1/webhook-endpoints").set("Cookie", cookie).send({ url: "https://example.com/hook" });

    expect(response.status).toBe(201);
    expect(response.body.url).toBe("https://example.com/hook");
    expect(response.body.signingSecret).toMatch(/^whsec_/);
    expect(response.body.enabledEvents).toEqual(["*"]);
  });

  it("never returns the signing secret from list", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    await request(server).post("/v1/webhook-endpoints").set("Cookie", cookie).send({ url: "https://example.com/hook" });

    const response = await request(server).get("/v1/webhook-endpoints").set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.body.data[0]).not.toHaveProperty("signingSecret");
  });

  it("scopes list to the calling merchant", async () => {
    const { cookie: cookieA } = await signInAndCreateMerchant(server);
    const { cookie: cookieB } = await signInAndCreateMerchant(server);
    await request(server).post("/v1/webhook-endpoints").set("Cookie", cookieA).send({ url: "https://example.com/a" });

    const response = await request(server).get("/v1/webhook-endpoints").set("Cookie", cookieB);
    expect(response.body.data).toHaveLength(0);
  });

  it("updates an endpoint's url and status", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const createResponse = await request(server).post("/v1/webhook-endpoints").set("Cookie", cookie).send({ url: "https://example.com/hook" });
    const { id } = createResponse.body;

    const patchResponse = await request(server).patch(`/v1/webhook-endpoints/${id}`).set("Cookie", cookie).send({ status: "disabled" });
    expect(patchResponse.status).toBe(200);
    expect(patchResponse.body.status).toBe("disabled");
  });

  it("deletes an endpoint", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const createResponse = await request(server).post("/v1/webhook-endpoints").set("Cookie", cookie).send({ url: "https://example.com/hook" });
    const { id } = createResponse.body;

    const deleteResponse = await request(server).delete(`/v1/webhook-endpoints/${id}`).set("Cookie", cookie);
    expect(deleteResponse.status).toBe(200);

    const listResponse = await request(server).get("/v1/webhook-endpoints").set("Cookie", cookie);
    expect(listResponse.body.data).toHaveLength(0);
  });

  it("returns 404 updating another merchant's endpoint", async () => {
    const { cookie: cookieA } = await signInAndCreateMerchant(server);
    const { cookie: cookieB } = await signInAndCreateMerchant(server);
    const createResponse = await request(server).post("/v1/webhook-endpoints").set("Cookie", cookieA).send({ url: "https://example.com/hook" });
    const { id } = createResponse.body;

    const patchResponse = await request(server).patch(`/v1/webhook-endpoints/${id}`).set("Cookie", cookieB).send({ status: "disabled" });
    expect(patchResponse.status).toBe(404);
  });

  it("paginates across multiple pages without skipping or duplicating rows", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const created: string[] = [];
    for (const url of ["https://example.com/1", "https://example.com/2", "https://example.com/3"]) {
      const response = await request(server).post("/v1/webhook-endpoints").set("Cookie", cookie).send({ url });
      created.push(response.body.id as string);
    }

    const page1 = await request(server).get("/v1/webhook-endpoints").query({ limit: 2 }).set("Cookie", cookie);
    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.has_more).toBe(true);
    expect(page1.body.next_cursor).not.toBeNull();

    const page2 = await request(server)
      .get("/v1/webhook-endpoints")
      .query({ limit: 2, starting_after: page1.body.next_cursor })
      .set("Cookie", cookie);
    expect(page2.status).toBe(200);
    expect(page2.body.has_more).toBe(false);

    const allIds = [...page1.body.data, ...page2.body.data].map((row: { id: string }) => row.id);
    // Every created endpoint appears, and appears exactly once, across both pages.
    expect(allIds).toHaveLength(3);
    expect(new Set(allIds).size).toBe(3);
    expect(new Set(allIds)).toEqual(new Set(created));
  });

  it("rejects a publishable key on every webhook-endpoint route", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const pubKey = await createPublishableKey(server, cookie);

    const createResponse = await request(server).post("/v1/webhook-endpoints").set("Authorization", `Bearer ${pubKey}`).send({ url: "https://example.com/hook" });
    expect(createResponse.status).toBe(403);
    expect(createResponse.body.error.code).toBe("key_type_not_allowed");

    const listResponse = await request(server).get("/v1/webhook-endpoints").set("Authorization", `Bearer ${pubKey}`);
    expect(listResponse.status).toBe(403);
  });

  it("accepts a secret key on every webhook-endpoint route", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const secretKey = await createSecretKey(server, cookie);

    const createResponse = await request(server).post("/v1/webhook-endpoints").set("Authorization", `Bearer ${secretKey}`).send({ url: "https://example.com/hook" });
    expect(createResponse.status).toBe(201);
  });
});
