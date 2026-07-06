import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import path from "node:path";
import { createDbClient, schema, type DbClient } from "../src/client.js";

describe("customer schema", () => {
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
    // See packages/db/test/onchain-schema.test.ts for why this close is required:
    // DbClient's type doesn't declare $client, but drizzle() attaches it at
    // runtime as the underlying pg.Pool — closing it before the container
    // stops avoids an unhandled connection-reset error after tests pass.
    await (db as DbClient & { $client: { end(): Promise<void> } }).$client.end();
    await container.stop();
  });

  it("inserts a customer row referencing a merchant", async () => {
    const [merchantRow] = await db
      .insert(schema.merchant)
      .values({ name: "Test Co", ownerAddress: "0xabc0000000000000000000000000000000000a" })
      .returning();

    const [customerRow] = await db
      .insert(schema.customer)
      .values({ merchantId: merchantRow.id, address: "0xdef0000000000000000000000000000000000b", email: "user@example.com" })
      .returning();

    expect(customerRow.address).toBe("0xdef0000000000000000000000000000000000b");
    expect(customerRow.email).toBe("user@example.com");
  });

  it("rejects a duplicate (merchant_id, address) pair", async () => {
    const [merchantRow] = await db
      .insert(schema.merchant)
      .values({ name: "Test Co 2", ownerAddress: "0xaaa0000000000000000000000000000000000a" })
      .returning();

    await db.insert(schema.customer).values({ merchantId: merchantRow.id, address: "0xbbb0000000000000000000000000000000000b" });

    await expect(
      db.insert(schema.customer).values({ merchantId: merchantRow.id, address: "0xbbb0000000000000000000000000000000000b" }),
    ).rejects.toThrow();
  });
});
