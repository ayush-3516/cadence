import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type DbClient } from "../src/client.js";

describe("dunning_state schema", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16").withDatabase("cadence_test").start();
    const url = container.getConnectionUri();
    const cwd = path.resolve(__dirname, "..");
    execSync("npx drizzle-kit migrate", { cwd, env: { ...process.env, DATABASE_URL: url }, stdio: "inherit" });
    db = createDbClient(url);
  }, 60_000);

  afterAll(async () => {
    await (db as DbClient & { $client: { end(): Promise<void> } }).$client.end();
    await container.stop();
  });

  it("inserts a dunning_state row with defaults applied", async () => {
    const [row] = await db
      .insert(schema.dunningState)
      .values({
        onchainSubId: "1",
        nextRetryAt: new Date(Date.now() + 86_400_000),
        ladder: ["1d", "3d", "5d", "7d"],
      })
      .returning();

    expect(row.attempt).toBe(1);
    expect(row.exhausted).toBe(false);
    expect(row.ladder).toEqual(["1d", "3d", "5d", "7d"]);
  });

  it("allows updating attempt, nextRetryAt, and exhausted", async () => {
    await db.insert(schema.dunningState).values({
      onchainSubId: "2",
      nextRetryAt: new Date(Date.now() + 86_400_000),
      ladder: ["1d", "3d"],
    });

    await db
      .update(schema.dunningState)
      .set({ attempt: 2, exhausted: true, updatedAt: new Date() })
      .where(eq(schema.dunningState.onchainSubId, "2"));

    const [row] = await db.select().from(schema.dunningState).where(eq(schema.dunningState.onchainSubId, "2"));
    expect(row.attempt).toBe(2);
    expect(row.exhausted).toBe(true);
  });
});
