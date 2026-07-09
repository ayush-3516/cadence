import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import request from "supertest";
import fastifyCookie from "@fastify/cookie";
import { AppModule } from "../src/app.module.js";
import { startTestDatabase, stopTestDatabase } from "./setup.js";

type Server = ReturnType<ReturnType<NestFastifyApplication["getHttpAdapter"]>["getInstance"]>["server"];

describe("CORS", () => {
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
    app.enableCors({ origin: ["http://localhost:3001"], credentials: true });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    server = app.getHttpAdapter().getInstance().server;
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await stopTestDatabase();
  });

  it("allows a credentialed preflight request from the dashboard's dev origin", async () => {
    const response = await request(server)
      .options("/v1/merchants/me")
      .set("Origin", "http://localhost:3001")
      .set("Access-Control-Request-Method", "GET")
      .set("Access-Control-Request-Headers", "content-type");

    expect(response.status).toBeLessThan(300);
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3001");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("rejects a request from an unlisted origin", async () => {
    const response = await request(server).options("/v1/merchants/me").set("Origin", "http://evil.example.com").set("Access-Control-Request-Method", "GET");

    expect(response.headers["access-control-allow-origin"]).not.toBe("http://evil.example.com");
  });
});
