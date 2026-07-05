import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import path from "node:path";
import { createDbClient, onchainSchema, type DbClient } from "@cadence/db";

let container: StartedPostgreSqlContainer;

export async function startTestDatabase(): Promise<string> {
  container = await new PostgreSqlContainer("postgres:16")
    .withDatabase("cadence_test")
    .withUsername("cadence")
    .withPassword("cadence")
    .start();

  const connectionUri = container.getConnectionUri();
  const dbCwd = path.resolve(__dirname, "../../../packages/db");

  execSync("npx drizzle-kit migrate", {
    cwd: dbCwd,
    env: { ...process.env, DATABASE_URL: connectionUri },
    stdio: "inherit",
  });
  execSync("npx drizzle-kit migrate --config drizzle.onchain.config.ts", {
    cwd: dbCwd,
    env: { ...process.env, DATABASE_URL: connectionUri },
    stdio: "inherit",
  });

  return connectionUri;
}

export async function stopTestDatabase(): Promise<void> {
  await container.stop();
}

let planCounter = 0;
let subCounter = 0;

export async function seedOnchainPlan(
  db: DbClient,
  overrides: Partial<typeof onchainSchema.onchainPlan.$inferInsert> = {},
): Promise<typeof onchainSchema.onchainPlan.$inferSelect> {
  planCounter += 1;
  const [row] = await db
    .insert(onchainSchema.onchainPlan)
    .values({
      onchainPlanId: String(planCounter),
      merchantAddress: "0xabc0000000000000000000000000000000000a",
      payoutSplit: "0xdef0000000000000000000000000000000000b",
      token: "0x0000000000000000000000000000000000000c",
      amount: "20000000",
      periodSeconds: 2592000n,
      trialSeconds: 0n,
      active: true,
      chainId: 84532,
      ...overrides,
    })
    .returning();
  return row;
}

export async function seedOnchainSubscription(
  db: DbClient,
  overrides: Partial<typeof onchainSchema.onchainSubscription.$inferInsert> = {},
): Promise<typeof onchainSchema.onchainSubscription.$inferSelect> {
  subCounter += 1;
  const [row] = await db
    .insert(onchainSchema.onchainSubscription)
    .values({
      onchainSubId: String(subCounter),
      onchainPlanId: "1",
      subscriberAddress: "0x1110000000000000000000000000000000000d",
      status: "active",
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      pausedRemaining: 0n,
      pendingCancel: false,
      chainId: 84532,
      ...overrides,
    })
    .returning();
  return row;
}

export async function seedOnchainCharge(
  db: DbClient,
  overrides: Partial<typeof onchainSchema.onchainCharge.$inferInsert> = {},
): Promise<typeof onchainSchema.onchainCharge.$inferSelect> {
  const [row] = await db
    .insert(onchainSchema.onchainCharge)
    .values({
      id: `0xcharge${Date.now()}${Math.random()}:0`,
      onchainSubId: "1",
      onchainPlanId: "1",
      status: "success",
      amount: "20000000",
      platformFee: "150000",
      net: "19850000",
      token: "0x0000000000000000000000000000000000000c",
      txHash: `0xcharge${Date.now()}${Math.random()}`,
      chainId: 84532,
      chargedAt: new Date(),
      ...overrides,
    })
    .returning();
  return row;
}
