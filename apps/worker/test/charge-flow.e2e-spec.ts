import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, StartedRedisContainer } from "@testcontainers/redis";
import { execSync } from "node:child_process";
import path from "node:path";
import Redis from "ioredis";
import { createDbClient, onchainSchema, type DbClient } from "@cadence/db";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { startAnvil, type StartedAnvil } from "./e2e-helpers/anvil.js";
import { deployContracts, type DeployedContracts } from "./e2e-helpers/deploy.js";
import { createQueues, chargeJobId } from "../src/queues.js";
import type { WorkerConfig } from "../src/config.js";
import { acquireChargeLock } from "../src/charge-lock.js";

// Real anvil default accounts (from `anvil`'s own printed "Private Keys"
// section, mnemonic "test test test test test test test test test test test
// junk"), verified directly against a locally spawned anvil instance rather
// than trusted from memory — anvil account #1's key is 32 bytes (64 hex
// chars) ending in "...78690d"; a shorter, truncated variant missing the
// trailing "d" derives to a DIFFERENT (invalid-looking but well-formed)
// address and would have made this test fail confusingly.
const ANVIL_ACCOUNT_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // relayer + deployer
const ANVIL_ACCOUNT_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // test subscriber

const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function mint(address to, uint256 amount) external",
]);

const subscriptionManagerAbi = parseAbi([
  "function createPlan(address payoutSplit, address token, uint256 amount, uint40 period, uint40 trialPeriod) external returns (uint256)",
  "function subscribe(uint256 planId) external returns (uint256)",
]);

describe("Charge flow e2e", () => {
  let anvil: StartedAnvil;
  let contracts: DeployedContracts;
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let db: DbClient;
  let redis: Redis;

  beforeAll(async () => {
    anvil = await startAnvil(8555);
    contracts = deployContracts(anvil.rpcUrl);

    pgContainer = await new PostgreSqlContainer("postgres:16").withDatabase("cadence_test").start();
    const dbUrl = pgContainer.getConnectionUri();
    const dbCwd = path.resolve(__dirname, "../../../packages/db");
    execSync("npx drizzle-kit migrate", { cwd: dbCwd, env: { ...process.env, DATABASE_URL: dbUrl }, stdio: "inherit" });
    execSync("npx drizzle-kit migrate --config drizzle.onchain.config.ts", {
      cwd: dbCwd,
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: "inherit",
    });
    db = createDbClient(dbUrl);

    redisContainer = await new RedisContainer("redis:7").start();
    // BullMQ's Worker requires the underlying ioredis connection to be
    // constructed with `maxRetriesPerRequest: null` (it manages its own
    // blocking-command retry behavior) — matches the real production
    // entrypoint's redis construction in src/index.ts. Without this, creating
    // a BullMQ Worker against this connection throws synchronously.
    redis = new Redis(redisContainer.getConnectionUrl(), { maxRetriesPerRequest: null });
  }, 120_000);

  afterAll(async () => {
    await (db as DbClient & { $client: { end(): Promise<void> } }).$client.end();
    await redis.quit();
    await pgContainer.stop();
    await redisContainer.stop();
    await anvil.stop();
  });

  it("charges a due subscription: submits a real tx and the subscriber's balance decreases", async () => {
    const deployerAccount = privateKeyToAccount(ANVIL_ACCOUNT_0);
    const subscriberAccount = privateKeyToAccount(ANVIL_ACCOUNT_1);
    const publicClient = createPublicClient({ transport: http(anvil.rpcUrl) });
    const deployerWallet = createWalletClient({ account: deployerAccount, transport: http(anvil.rpcUrl) });
    const subscriberWallet = createWalletClient({ account: subscriberAccount, transport: http(anvil.rpcUrl) });

    // 1. Mint USDC to the subscriber and have them approve the SubscriptionManager.
    const amount = 20_000_000n; // 20 USDC at 6 decimals
    await deployerWallet.writeContract({
      address: contracts.usdc,
      abi: erc20Abi,
      functionName: "mint",
      args: [subscriberAccount.address, amount * 3n],
      chain: null,
      account: deployerAccount,
    });
    await subscriberWallet.writeContract({
      address: contracts.usdc,
      abi: erc20Abi,
      functionName: "approve",
      args: [contracts.subscriptionManager, amount * 3n],
      chain: null,
      account: subscriberAccount,
    });

    // 2. Create a plan (period = 30 days) and subscribe.
    const createPlanHash = await deployerWallet.writeContract({
      address: contracts.subscriptionManager,
      abi: subscriptionManagerAbi,
      functionName: "createPlan",
      args: [deployerAccount.address, contracts.usdc, amount, 2_592_000, 0],
      chain: null,
      account: deployerAccount,
    });
    await publicClient.waitForTransactionReceipt({ hash: createPlanHash });

    const subscribeHash = await subscriberWallet.writeContract({
      address: contracts.subscriptionManager,
      abi: subscriptionManagerAbi,
      functionName: "subscribe",
      args: [1n],
      chain: null,
      account: subscriberAccount,
    });
    await publicClient.waitForTransactionReceipt({ hash: subscribeHash });

    // 3. Advance chain time past the first period so the sub becomes due.
    await fetch(anvil.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "evm_increaseTime", params: [2_592_001], id: 1 }),
    });
    await fetch(anvil.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "evm_mine", params: [], id: 1 }),
    });

    // 4. Seed the Postgres mirror row the worker's due-query reads (the real
    // indexer isn't running in this test — Phase 1a's indexer is a separate
    // process this test doesn't need, since the worker only ever reads its
    // OWN Postgres mirror, never the chain directly, for the due-query).
    await db.insert(onchainSchema.onchainPlan).values({
      onchainPlanId: "1",
      merchantAddress: deployerAccount.address,
      payoutSplit: deployerAccount.address,
      token: contracts.usdc,
      amount: amount.toString(),
      periodSeconds: 2_592_000n,
      trialSeconds: 0n,
      active: true,
      chainId: 84532,
    });
    await db.insert(onchainSchema.onchainSubscription).values({
      onchainSubId: "1",
      onchainPlanId: "1",
      subscriberAddress: subscriberAccount.address,
      status: "active",
      currentPeriodEnd: new Date(Date.now() - 60_000),
      pausedRemaining: 0n,
      pendingCancel: false,
      chainId: 84532,
    });

    // 5. Run one scheduler tick + one job cycle directly (not via the full
    // BullMQ repeatable-job/process lifecycle from index.ts, to keep this
    // test deterministic rather than waiting on real wall-clock intervals).
    const config: WorkerConfig = {
      databaseUrl: pgContainer.getConnectionUri(),
      redisUrl: redisContainer.getConnectionUrl(),
      relayerPrivateKey: ANVIL_ACCOUNT_0,
      rpcUrlHttp: anvil.rpcUrl,
      chainId: 84532,
      schedulerIntervalMs: 300_000,
      subscriptionManagerAddress: contracts.subscriptionManager,
      webhookSigningRotationKey: "0123456789abcdef0123456789abcdef",
      feeRegistryAddress: "0x0000000000000000000000000000000000000000",
      s3Endpoint: "http://localhost:9000",
      s3Bucket: "cadence-invoices-test",
      s3AccessKeyId: "minioadmin",
      s3SecretAccessKey: "minioadmin",
      s3Region: "auto",
      s3ForcePathStyle: true,
      s3PublicBaseUrl: "http://localhost:9000/cadence-invoices-test",
    };
    const { scheduleDueCharges, startChargeWorker } = createQueues(config, db, redis);
    const worker = startChargeWorker();

    const balanceBefore = await publicClient.readContract({
      address: contracts.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [subscriberAccount.address],
    });

    await scheduleDueCharges();
    await new Promise((resolve) => setTimeout(resolve, 5_000)); // let the queued job process

    const balanceAfter = await publicClient.readContract({
      address: contracts.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [subscriberAccount.address],
    });

    expect(balanceBefore - balanceAfter).toBe(amount);

    await worker.close();
  }, 60_000);

  it("does not submit a second transaction when the charge lock is already held", async () => {
    const periodEnd = new Date(Date.now() - 60_000);
    await db.insert(onchainSchema.onchainSubscription).values({
      onchainSubId: "2",
      onchainPlanId: "1",
      subscriberAddress: "0x1110000000000000000000000000000000000d",
      status: "active",
      currentPeriodEnd: periodEnd,
      pausedRemaining: 0n,
      pendingCancel: false,
      chainId: 84532,
    });

    const preAcquired = await acquireChargeLock(redis, "2", periodEnd);
    expect(preAcquired).toBe(true); // confirms the lock really was free before this test pre-acquired it

    const config: WorkerConfig = {
      databaseUrl: pgContainer.getConnectionUri(),
      redisUrl: redisContainer.getConnectionUrl(),
      relayerPrivateKey: ANVIL_ACCOUNT_0,
      rpcUrlHttp: anvil.rpcUrl,
      chainId: 84532,
      schedulerIntervalMs: 300_000,
      subscriptionManagerAddress: contracts.subscriptionManager,
      webhookSigningRotationKey: "0123456789abcdef0123456789abcdef",
      feeRegistryAddress: "0x0000000000000000000000000000000000000000",
      s3Endpoint: "http://localhost:9000",
      s3Bucket: "cadence-invoices-test",
      s3AccessKeyId: "minioadmin",
      s3SecretAccessKey: "minioadmin",
      s3Region: "auto",
      s3ForcePathStyle: true,
      s3PublicBaseUrl: "http://localhost:9000/cadence-invoices-test",
    };
    const { chargeQueue, startChargeWorker } = createQueues(config, db, redis);
    const worker = startChargeWorker();

    const publicClient = createPublicClient({ transport: http(anvil.rpcUrl) });
    const relayerAddress = privateKeyToAccount(ANVIL_ACCOUNT_0).address;

    // Capture the relayer's nonce immediately before enqueuing the job — this
    // makes the assertion below self-contained and order-independent: it
    // doesn't matter whether this test runs first or second, or how many
    // real charges preceded it, only that the nonce doesn't move as a
    // *result of this test's own job*.
    const nonceBefore = await publicClient.getTransactionCount({ address: relayerAddress });

    await chargeQueue.add(
      "charge",
      { subId: "2", periodEnd: periodEnd.toISOString(), chainId: 84532 },
      { jobId: chargeJobId("2", periodEnd) },
    );
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    const nonceAfter = await publicClient.getTransactionCount({ address: relayerAddress });

    // The lock (pre-acquired above) must have blocked processChargeJob from
    // ever calling submitCharge, so the relayer must not have submitted any
    // new transaction: the nonce after processing must equal the nonce
    // captured before the job was even added, not merely "some" value.
    expect(nonceAfter).toBe(nonceBefore);

    await worker.close();
  }, 30_000);
});
