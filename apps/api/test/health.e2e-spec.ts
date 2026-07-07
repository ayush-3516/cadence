import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import request from "supertest";
import type { DbClient } from "@cadence/db";
import { AppModule } from "../src/app.module.js";
import { DB_CLIENT } from "../src/db/db.module.js";
import { startTestDatabase, stopTestDatabase } from "./setup.js";

describe("GET /v1/health", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const connectionUri = await startTestDatabase();
    process.env.DATABASE_URL = connectionUri;
    process.env.WEBHOOK_SIGNING_ROTATION_KEY = "test-rotation-key-0123456789abcd";

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 60_000);

  afterAll(async () => {
    // `DbClient` (NodePgDatabase) doesn't type the `$client` member that
    // `drizzle()` actually attaches at runtime, so we narrow just enough to
    // close the underlying pg Pool before tearing down the container.
    const db = app.get<DbClient & { $client: { end(): Promise<void> } }>(DB_CLIENT);
    await db.$client.end();
    await app.close();
    await stopTestDatabase();
  });

  it("returns ok when the database is reachable", async () => {
    const server = app.getHttpAdapter().getInstance().server;
    const response = await request(server).get("/v1/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });
});
