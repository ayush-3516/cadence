import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import path from "node:path";
import { createDbClient, schema, onchainSchema, type DbClient } from "../src/client.js";

describe("onchain schema mirror", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16").withDatabase("cadence_test").start();
    const url = container.getConnectionUri();
    const cwd = path.resolve(__dirname, "..");
    execSync("npx drizzle-kit migrate", { cwd, env: { ...process.env, DATABASE_URL: url }, stdio: "inherit" });
    execSync("npx drizzle-kit migrate --config drizzle.onchain.config.ts", {
      cwd,
      env: { ...process.env, DATABASE_URL: url },
      stdio: "inherit",
    });
    db = createDbClient(url);
  }, 60_000);

  afterAll(async () => {
    // `DbClient`'s type (`NodePgDatabase<...>`) doesn't declare `$client`,
    // but the object `drizzle()` returns has it at runtime — it's the
    // underlying `pg.Pool`. Close it before stopping the container;
    // otherwise the pool's still-open socket receives a connection-reset
    // error with no handler once the container disappears mid-process,
    // which vitest reports as an unhandled error and fails the run even
    // though both tests above already passed. Narrowly typed here rather
    // than widening `packages/db`'s exported `DbClient` type or casting to
    // `any` (same fix pattern as `apps/api/test/health.e2e-spec.ts`).
    await (db as DbClient & { $client: { end(): Promise<void> } }).$client.end();
    await container.stop();
  });

  it("can insert into onchain_plan and read it back via the mirror", async () => {
    await db.insert(onchainSchema.onchainPlan).values({
      onchainPlanId: "1",
      merchantAddress: "0xabc0000000000000000000000000000000000a",
      payoutSplit: "0xdef0000000000000000000000000000000000b",
      token: "0x0000000000000000000000000000000000000c",
      amount: "20000000",
      periodSeconds: 2592000n,
      trialSeconds: 0n,
      active: true,
      chainId: 84532,
    });

    const [row] = await db.select().from(onchainSchema.onchainPlan);
    expect(row.onchainPlanId).toBe("1");
    expect(row.merchantAddress).toBe("0xabc0000000000000000000000000000000000a");
  });

  it("can insert into plan_meta referencing a merchant", async () => {
    const [merchantRow] = await db
      .insert(schema.merchant)
      .values({ name: "Test Co", ownerAddress: "0xabc0000000000000000000000000000000000a" })
      .returning();

    await db.insert(schema.planMeta).values({
      onchainPlanId: "1",
      merchantId: merchantRow.id,
      name: "Pro API",
    });

    const [metaRow] = await db.select().from(schema.planMeta);
    expect(metaRow.name).toBe("Pro API");
    expect(metaRow.dunningLadder).toEqual(["1d", "3d", "5d", "7d"]);
  });
});
