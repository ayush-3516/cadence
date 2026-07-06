# Phase 1e — Charge Scheduler & Automation Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone `apps/worker` process that finds on-chain subscriptions due for charging and submits `SubscriptionManager.charge(subId)` transactions via a relayer key, on a repeatable schedule — the first automation/write capability in the platform.

**Architecture:** A plain Node process (no NestJS) using BullMQ for scheduling and job processing, `@cadence/db` for the due-query against Postgres, and `viem` for chain interaction. A repeatable job runs the due-query and enqueues one `charge-queue` job per due subscription; a serialized (`concurrency: 1`) Worker processes each job: acquire a Redis lock, submit the transaction with a simple incrementing nonce, wait for 1 confirmation, log, release. The already-running indexer (unchanged) is the sole source of truth for charge outcomes.

**Tech Stack:** Node.js, TypeScript, BullMQ (Redis-backed queues), `viem` 2.x (chain client, matching `apps/indexer`'s existing dependency), `@cadence/db` (Drizzle/Postgres), Vitest, `@testcontainers/postgresql`, a locally-spawned `anvil` + `forge script` for e2e chain state.

## Global Constraints

- `apps/worker` is a standalone process — no NestJS, no HTTP server.
- Chain interactions use `viem`, not `ethers` (matches `apps/indexer`; `apps/api`'s `ethers` dependency is scoped to SIWE only and is not precedent here).
- Contract addresses come from `deployments/{chainId}.json` (the same file `apps/indexer/ponder.config.ts` already reads) — no separate deployment-address configuration for the worker.
- The `charge-queue` BullMQ Worker MUST run with `concurrency: 1` — this is a correctness requirement (the in-process nonce counter is only safe under strict serialization), not a performance choice.
- One `charge()` call per due subscription — `chargeBatch()` is out of scope this phase.
- No transaction-replacement, fee-bumping, or stuck-tx detection logic. BullMQ's own job-level retry (fixed small attempt count, exponential backoff) is the only retry mechanism, and it retries the *submission call*, not an already-broadcast transaction.
- The worker never decodes transaction receipt logs to determine charge success/failure — the indexer's projected `Charged`/`ChargeFailed` events are the sole source of truth for outcome.
- The due-query includes `past_due` subscriptions unconditionally (no `dunning_state` gate — that table doesn't exist yet). This is intentional; do not add ad hoc backoff logic.
- `REDIS_URL` and `RELAYER_PRIVATE_KEY` are read from environment variables per the PRD's canonical naming (§4.5) — no new naming conventions.

---

## File Structure

**New files:**
- `apps/worker/package.json` — dependencies (`bullmq`, `ioredis`, `viem`, `@cadence/db`), scripts (`build`, `start`, `test`, `test:e2e`, `typecheck`).
- `apps/worker/tsconfig.json` — dev-mode config (mirrors `apps/api/tsconfig.json`'s shape).
- `apps/worker/tsconfig.build.json` — CommonJS production build config (mirrors `packages/db/tsconfig.build.json`'s pattern, established in Phase 1b after a real production-boot bug was found there).
- `apps/worker/.env.local.example` — documents `DATABASE_URL`, `REDIS_URL`, `RELAYER_PRIVATE_KEY`, `RPC_URL_HTTP`, `CHAIN_ID`, `CHARGE_SCHEDULER_INTERVAL_MS`.
- `apps/worker/src/config.ts` — reads and validates all env vars once at startup, exports a typed `WorkerConfig`.
- `apps/worker/src/due-query.ts` — `findDueSubscriptions(db, params): Promise<DueSubscription[]>`.
- `apps/worker/src/charge-lock.ts` — `acquireChargeLock(redis, subId, periodEnd): Promise<boolean>`, `releaseChargeLock(redis, subId, periodEnd): Promise<void>`.
- `apps/worker/src/nonce-manager.ts` — `createNonceManager(publicClient, relayerAddress): Promise<NonceManager>` with `.next(): number`.
- `apps/worker/src/charge-submitter.ts` — `submitCharge(deps, subId): Promise<{ txHash: string }>` — builds and sends the `charge(subId)` transaction, waits for 1 confirmation.
- `apps/worker/src/queues.ts` — BullMQ queue/worker definitions: `chargeSchedulerQueue`, `chargeQueue`, the scheduler's repeatable-job registration, and the `chargeQueue` Worker's processor function wiring together `due-query.ts` → `charge-lock.ts` → `charge-submitter.ts`.
- `apps/worker/src/index.ts` — process entrypoint: loads config, creates DB/Redis/viem clients, registers the repeatable scheduler job, starts the `chargeQueue` Worker, handles `SIGTERM`/`SIGINT` for graceful shutdown.
- `apps/worker/test/due-query.test.ts` — Testcontainers Postgres, no chain needed.
- `apps/worker/test/charge-lock.test.ts` — Testcontainers Redis (via `@testcontainers/redis`, matching the project's existing Testcontainers-for-everything testing convention rather than a mock library).
- `apps/worker/test/nonce-manager.test.ts` — unit test with a stubbed viem public client.
- `packages/contracts/script/DeployLocal.s.sol` — a new local-only Foundry deploy script (see Task 5) that deploys `MockUSDC` instead of referencing a real network's USDC address, for use only by the e2e test helpers below. `packages/contracts/script/Deploy.s.sol` (the real deployment path) is untouched.
- `apps/worker/test/e2e-helpers/anvil.ts` — spawns/tears down a local `anvil` child process on an ephemeral port.
- `apps/worker/test/e2e-helpers/deploy.ts` — runs `forge script script/DeployLocal.s.sol` against the spawned anvil, parses the resulting broadcast JSON for contract addresses (never touches the shared `deployments/84532.json`).
- `apps/worker/test/charge-flow.e2e-spec.ts` — the full anvil + Testcontainers Postgres + Redis e2e test.

**Modified files:** none — this phase is purely additive, both the new `apps/worker` package and the new `packages/contracts/script/DeployLocal.s.sol` file are net-new, and no existing file is changed.

---

### Task 1: Worker scaffolding, config, and due-query

**Files:**
- Create: `apps/worker/package.json`
- Create: `apps/worker/tsconfig.json`
- Create: `apps/worker/tsconfig.build.json`
- Create: `apps/worker/.env.local.example`
- Create: `apps/worker/src/config.ts`
- Create: `apps/worker/src/due-query.ts`
- Test: `apps/worker/test/due-query.test.ts`

**Interfaces:**
- Produces: `WorkerConfig` type — `{ databaseUrl: string; redisUrl: string; relayerPrivateKey: \`0x${string}\`; rpcUrlHttp: string; chainId: number; schedulerIntervalMs: number; subscriptionManagerAddress: \`0x${string}\` }`. `loadConfig(): WorkerConfig` reads `process.env`, throws with a clear message if any required var is missing, and reads `subscriptionManagerAddress` from `deployments/{chainId}.json` (not an env var). Produces `DueSubscription` type — `{ onchainSubId: string; currentPeriodEnd: Date }`. Produces `findDueSubscriptions(db: DbClient, params: { chainId: number; batchSize: number }): Promise<DueSubscription[]>`, consumed by Task 5's queue wiring.

- [ ] **Step 1: Create the package skeleton**

Create `apps/worker/package.json`:

```json
{
  "name": "@cadence/worker",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:e2e": "vitest run --config vitest.e2e.config.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@cadence/db": "workspace:*",
    "bullmq": "^5.34.0",
    "ioredis": "^5.4.1",
    "viem": "^2.21.3"
  },
  "devDependencies": {
    "@testcontainers/postgresql": "^12.0.4",
    "@types/node": "^20.10.0",
    "typescript": "^5.7.3",
    "vitest": "^2.1.0"
  }
}
```

`viem` is pinned to the same `^2.21.3` already used by `apps/indexer/package.json` — confirm this by reading that file before running install, and match the exact version range rather than assuming.

- [ ] **Step 2: Create `tsconfig.json` (dev mode) and `tsconfig.build.json` (production build)**

Create `apps/worker/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Create `apps/worker/tsconfig.build.json` (CommonJS, matching `packages/db/tsconfig.build.json`'s pattern — Phase 1b found a real production-boot bug when a package lacked this):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "Node10",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "declaration": true,
    "outDir": "./dist",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "test"]
}
```

Note `apps/worker/package.json`'s top-level `"type": "module"` combined with `tsconfig.build.json`'s CommonJS output is intentionally the SAME mismatch pattern `packages/db` uses successfully (dev-mode ESM, build-mode CommonJS) — this is a deliberate, already-proven pattern in this repo, not an oversight. Do not "fix" it to be consistent.

- [ ] **Step 3: Document required env vars**

Create `apps/worker/.env.local.example`:

```
DATABASE_URL=postgres://cadence:cadence@localhost:5432/cadence
REDIS_URL=redis://localhost:6379
RELAYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
RPC_URL_HTTP=http://localhost:8545
CHAIN_ID=84532
CHARGE_SCHEDULER_INTERVAL_MS=300000
```

The example `RELAYER_PRIVATE_KEY` value is anvil's well-known default account #0 private key (safe to commit as an example — it is a publicly documented test-only key with no real funds, the same key `packages/contracts/script/Deploy.s.sol` already uses locally via `DEPLOYER_PRIVATE_KEY`). Real deployments must never use this key.

- [ ] **Step 4: Write the failing test for `loadConfig`**

Create `apps/worker/test/config.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";

const REQUIRED_ENV = {
  DATABASE_URL: "postgres://cadence:cadence@localhost:5432/cadence",
  REDIS_URL: "redis://localhost:6379",
  RELAYER_PRIVATE_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  RPC_URL_HTTP: "http://localhost:8545",
  CHAIN_ID: "84532",
};

describe("loadConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads all required fields with a default scheduler interval", () => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) vi.stubEnv(key, value);
    vi.stubEnv("CHARGE_SCHEDULER_INTERVAL_MS", undefined);

    const config = loadConfig();
    expect(config.databaseUrl).toBe(REQUIRED_ENV.DATABASE_URL);
    expect(config.chainId).toBe(84532);
    expect(config.schedulerIntervalMs).toBe(300_000);
  });

  it("respects a custom scheduler interval", () => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) vi.stubEnv(key, value);
    vi.stubEnv("CHARGE_SCHEDULER_INTERVAL_MS", "60000");

    expect(loadConfig().schedulerIntervalMs).toBe(60_000);
  });

  it("throws a clear error when RELAYER_PRIVATE_KEY is missing", () => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      if (key !== "RELAYER_PRIVATE_KEY") vi.stubEnv(key, value);
    }
    expect(() => loadConfig()).toThrow(/RELAYER_PRIVATE_KEY/);
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `cd apps/worker && npx vitest run test/config.test.ts`
Expected: FAIL — `../src/config.js` does not exist yet.

- [ ] **Step 6: Implement `apps/worker/src/config.ts`**

```typescript
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface WorkerConfig {
  databaseUrl: string;
  redisUrl: string;
  relayerPrivateKey: `0x${string}`;
  rpcUrlHttp: string;
  chainId: number;
  schedulerIntervalMs: number;
  subscriptionManagerAddress: `0x${string}`;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): WorkerConfig {
  const chainId = Number(requireEnv("CHAIN_ID"));
  const relayerPrivateKey = requireEnv("RELAYER_PRIVATE_KEY");
  if (!relayerPrivateKey.startsWith("0x")) {
    throw new Error("RELAYER_PRIVATE_KEY must start with 0x");
  }

  const deploymentPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../deployments",
    `${chainId}.json`,
  );
  const deployment = JSON.parse(readFileSync(deploymentPath, "utf-8")) as { subscriptionManager: string };

  return {
    databaseUrl: requireEnv("DATABASE_URL"),
    redisUrl: requireEnv("REDIS_URL"),
    relayerPrivateKey: relayerPrivateKey as `0x${string}`,
    rpcUrlHttp: requireEnv("RPC_URL_HTTP"),
    chainId,
    schedulerIntervalMs: process.env.CHARGE_SCHEDULER_INTERVAL_MS
      ? Number(process.env.CHARGE_SCHEDULER_INTERVAL_MS)
      : 300_000,
    subscriptionManagerAddress: deployment.subscriptionManager as `0x${string}`,
  };
}
```

The `deployments/{chainId}.json` path resolution mirrors `apps/indexer/ponder.config.ts`'s existing `readFileSync(new URL("../../deployments/...", import.meta.url), ...)` pattern — but written via `path.resolve`/`fileURLToPath` instead of a raw `new URL(...)` call, because `apps/worker/src/config.ts` is one directory level deeper (`src/config.ts` vs. `ponder.config.ts` at the indexer's root) — verify the exact relative depth yourself by checking `apps/worker/src/config.ts`'s actual location relative to the repo root's `deployments/` directory before trusting the `../../../deployments` literal above; adjust if the level count is wrong.

- [ ] **Step 7: Run the config test again to verify it passes**

Run: `cd apps/worker && npx vitest run test/config.test.ts`
Expected: PASS (3/3 tests). Note this test does not need `deployments/84532.json` to exist for the missing-var test (Step 4's third test fails before reaching the file read), but the first two tests DO need it to exist at the real repo path (it already does, from Phase 0) — if those two fail with an `ENOENT`, the path resolution in Step 6 is wrong; fix it before proceeding.

- [ ] **Step 8: Write the failing test for `findDueSubscriptions`**

Create `apps/worker/test/due-query.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import path from "node:path";
import { createDbClient, onchainSchema, type DbClient } from "@cadence/db";
import { findDueSubscriptions } from "../src/due-query.js";

describe("findDueSubscriptions", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16").withDatabase("cadence_test").start();
    const url = container.getConnectionUri();
    const dbCwd = path.resolve(__dirname, "../../../packages/db");
    execSync("npx drizzle-kit migrate", { cwd: dbCwd, env: { ...process.env, DATABASE_URL: url }, stdio: "inherit" });
    execSync("npx drizzle-kit migrate --config drizzle.onchain.config.ts", {
      cwd: dbCwd,
      env: { ...process.env, DATABASE_URL: url },
      stdio: "inherit",
    });
    db = createDbClient(url);
  }, 60_000);

  afterAll(async () => {
    await (db as DbClient & { $client: { end(): Promise<void> } }).$client.end();
    await container.stop();
  });

  async function seedPlanAndSub(overrides: { onchainSubId: string; status: string; currentPeriodEnd: Date; chainId?: number }) {
    await db.insert(onchainSchema.onchainPlan).values({
      onchainPlanId: "1",
      merchantAddress: "0xabc0000000000000000000000000000000000a",
      payoutSplit: "0xdef0000000000000000000000000000000000b",
      token: "0x0000000000000000000000000000000000000c",
      amount: "20000000",
      periodSeconds: 2592000n,
      trialSeconds: 0n,
      active: true,
      chainId: overrides.chainId ?? 84532,
    }).onConflictDoNothing();

    await db.insert(onchainSchema.onchainSubscription).values({
      onchainSubId: overrides.onchainSubId,
      onchainPlanId: "1",
      subscriberAddress: "0x1110000000000000000000000000000000000d",
      status: overrides.status,
      currentPeriodEnd: overrides.currentPeriodEnd,
      pausedRemaining: 0n,
      pendingCancel: false,
      chainId: overrides.chainId ?? 84532,
    });
  }

  it("returns an active subscription whose period has ended", async () => {
    await seedPlanAndSub({ onchainSubId: "1", status: "active", currentPeriodEnd: new Date(Date.now() - 60_000) });

    const due = await findDueSubscriptions(db, { chainId: 84532, batchSize: 100 });
    expect(due.map((d) => d.onchainSubId)).toContain("1");
  });

  it("excludes a subscription whose period has not ended yet", async () => {
    await seedPlanAndSub({ onchainSubId: "2", status: "active", currentPeriodEnd: new Date(Date.now() + 60_000) });

    const due = await findDueSubscriptions(db, { chainId: 84532, batchSize: 100 });
    expect(due.map((d) => d.onchainSubId)).not.toContain("2");
  });

  it("excludes a canceled subscription even if its period has ended", async () => {
    await seedPlanAndSub({ onchainSubId: "3", status: "canceled", currentPeriodEnd: new Date(Date.now() - 60_000) });

    const due = await findDueSubscriptions(db, { chainId: 84532, batchSize: 100 });
    expect(due.map((d) => d.onchainSubId)).not.toContain("3");
  });

  it("includes a past_due subscription unconditionally (no dunning gate exists yet)", async () => {
    await seedPlanAndSub({ onchainSubId: "4", status: "past_due", currentPeriodEnd: new Date(Date.now() - 60_000) });

    const due = await findDueSubscriptions(db, { chainId: 84532, batchSize: 100 });
    expect(due.map((d) => d.onchainSubId)).toContain("4");
  });

  it("respects the chainId filter", async () => {
    await seedPlanAndSub({ onchainSubId: "5", status: "active", currentPeriodEnd: new Date(Date.now() - 60_000), chainId: 999 });

    const due = await findDueSubscriptions(db, { chainId: 84532, batchSize: 100 });
    expect(due.map((d) => d.onchainSubId)).not.toContain("5");
  });

  it("respects batchSize and orders by current_period_end ascending", async () => {
    await seedPlanAndSub({ onchainSubId: "6", status: "active", currentPeriodEnd: new Date(Date.now() - 120_000) });
    await seedPlanAndSub({ onchainSubId: "7", status: "active", currentPeriodEnd: new Date(Date.now() - 30_000) });

    const due = await findDueSubscriptions(db, { chainId: 84532, batchSize: 1 });
    expect(due).toHaveLength(1);
    expect(due[0].onchainSubId).toBe("6");
  });
});
```

- [ ] **Step 9: Run it to verify it fails**

Run: `cd apps/worker && npx vitest run test/due-query.test.ts`
Expected: FAIL — `../src/due-query.js` does not exist yet.

- [ ] **Step 10: Implement `apps/worker/src/due-query.ts`**

```typescript
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { onchainSchema } from "@cadence/db";
import type { DbClient } from "@cadence/db";

export interface DueSubscription {
  onchainSubId: string;
  currentPeriodEnd: Date;
}

export async function findDueSubscriptions(
  db: DbClient,
  params: { chainId: number; batchSize: number },
): Promise<DueSubscription[]> {
  const rows = await db
    .select({
      onchainSubId: onchainSchema.onchainSubscription.onchainSubId,
      currentPeriodEnd: onchainSchema.onchainSubscription.currentPeriodEnd,
    })
    .from(onchainSchema.onchainSubscription)
    .where(
      and(
        inArray(onchainSchema.onchainSubscription.status, ["active", "trialing", "past_due"]),
        lte(onchainSchema.onchainSubscription.currentPeriodEnd, new Date()),
        eq(onchainSchema.onchainSubscription.chainId, params.chainId),
      ),
    )
    .orderBy(asc(onchainSchema.onchainSubscription.currentPeriodEnd))
    .limit(params.batchSize);

  return rows;
}
```

- [ ] **Step 11: Run the due-query test again to verify it passes**

Run: `cd apps/worker && npx vitest run test/due-query.test.ts`
Expected: PASS (6/6 tests).

- [ ] **Step 12: Typecheck**

Run: `cd apps/worker && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 13: Commit**

```bash
git add apps/worker/package.json apps/worker/tsconfig.json apps/worker/tsconfig.build.json apps/worker/.env.local.example apps/worker/src/config.ts apps/worker/src/due-query.ts apps/worker/test/config.test.ts apps/worker/test/due-query.test.ts
git commit -m "Scaffold apps/worker: config loading and due-subscription query"
```

---

### Task 2: Redis charge lock

**Files:**
- Create: `apps/worker/src/charge-lock.ts`
- Test: `apps/worker/test/charge-lock.test.ts`

**Interfaces:**
- Consumes: `ioredis`'s `Redis` client type.
- Produces: `acquireChargeLock(redis: Redis, onchainSubId: string, periodEnd: Date): Promise<boolean>` (returns `true` if the lock was newly acquired, `false` if another process already holds it), `releaseChargeLock(redis: Redis, onchainSubId: string, periodEnd: Date): Promise<void>`. Both consumed by Task 5's queue processor.

- [ ] **Step 1: Write the failing test**

This test needs a real Redis instance. Create `apps/worker/test/charge-lock.test.ts`:

```typescript
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { RedisContainer, StartedRedisContainer } from "@testcontainers/redis";
import Redis from "ioredis";
import { acquireChargeLock, releaseChargeLock } from "../src/charge-lock.js";

describe("charge lock", () => {
  let container: StartedRedisContainer;
  let redis: Redis;

  beforeAll(async () => {
    container = await new RedisContainer("redis:7").start();
    redis = new Redis(container.getConnectionUrl());
  }, 60_000);

  afterEach(async () => {
    await redis.flushall();
  });

  afterAll(async () => {
    await redis.quit();
    await container.stop();
  });

  const periodEnd = new Date("2026-08-01T00:00:00Z");

  it("acquires a lock that does not yet exist", async () => {
    const acquired = await acquireChargeLock(redis, "42", periodEnd);
    expect(acquired).toBe(true);
  });

  it("fails to acquire a lock already held for the same sub+period", async () => {
    await acquireChargeLock(redis, "42", periodEnd);
    const secondAttempt = await acquireChargeLock(redis, "42", periodEnd);
    expect(secondAttempt).toBe(false);
  });

  it("allows a different period for the same sub to acquire independently", async () => {
    await acquireChargeLock(redis, "42", periodEnd);
    const otherPeriod = await acquireChargeLock(redis, "42", new Date("2026-09-01T00:00:00Z"));
    expect(otherPeriod).toBe(true);
  });

  it("allows re-acquiring after release", async () => {
    await acquireChargeLock(redis, "42", periodEnd);
    await releaseChargeLock(redis, "42", periodEnd);
    const reacquired = await acquireChargeLock(redis, "42", periodEnd);
    expect(reacquired).toBe(true);
  });
});
```

Add `"@testcontainers/redis": "^12.0.4"` to `apps/worker/package.json`'s `devDependencies` (version-matched to the already-pinned `@testcontainers/postgresql@^12.0.4` from Task 1 — confirm this version exists on the `@testcontainers/redis` npm package before assuming it matches exactly; use whatever the latest `^12.x` is if `12.0.4` specifically isn't published).

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/worker && npx vitest run test/charge-lock.test.ts`
Expected: FAIL — `../src/charge-lock.js` does not exist yet.

- [ ] **Step 3: Implement `apps/worker/src/charge-lock.ts`**

```typescript
import type { Redis } from "ioredis";

const LOCK_TTL_SECONDS = 600; // 10 minutes: long enough to cover submission + 1 confirmation, short enough to self-heal if the process crashes mid-job.

function lockKey(onchainSubId: string, periodEnd: Date): string {
  return `charging:${onchainSubId}:${periodEnd.toISOString()}`;
}

export async function acquireChargeLock(redis: Redis, onchainSubId: string, periodEnd: Date): Promise<boolean> {
  const result = await redis.set(lockKey(onchainSubId, periodEnd), "1", "EX", LOCK_TTL_SECONDS, "NX");
  return result === "OK";
}

export async function releaseChargeLock(redis: Redis, onchainSubId: string, periodEnd: Date): Promise<void> {
  await redis.del(lockKey(onchainSubId, periodEnd));
}
```

`SET key value EX seconds NX` is Redis's standard atomic "set if not exists with expiry" idiom — this is what makes `acquireChargeLock` safe against a race between two workers checking-then-setting separately (there's no separate "check" step at all).

- [ ] **Step 4: Run the test again to verify it passes**

Run: `cd apps/worker && npx vitest run test/charge-lock.test.ts`
Expected: PASS (4/4 tests).

- [ ] **Step 5: Typecheck**

Run: `cd apps/worker && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/charge-lock.ts apps/worker/test/charge-lock.test.ts apps/worker/package.json
git commit -m "Add Redis-backed per-subscription-period charge lock"
```

---

### Task 3: Nonce manager and chain-submission service

**Files:**
- Create: `apps/worker/src/nonce-manager.ts`
- Create: `apps/worker/src/charge-submitter.ts`
- Test: `apps/worker/test/nonce-manager.test.ts`

**Interfaces:**
- Consumes: viem's `PublicClient`/`WalletClient` types, `WorkerConfig` (Task 1).
- Produces: `NonceManager` interface — `{ next(): number }`. `createNonceManager(publicClient: PublicClient, relayerAddress: \`0x${string}\`): Promise<NonceManager>` (queries the current on-chain transaction count once, then increments in-process on every `.next()` call). Produces `submitCharge(deps: { walletClient: WalletClient; publicClient: PublicClient; subscriptionManagerAddress: \`0x${string}\`; nonceManager: NonceManager }, onchainSubId: string): Promise<{ txHash: \`0x${string}\` }>`, consumed by Task 5's queue processor.

- [ ] **Step 1: Write the failing test for the nonce manager**

Create `apps/worker/test/nonce-manager.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { createNonceManager } from "../src/nonce-manager.js";

describe("createNonceManager", () => {
  it("starts from the chain's current transaction count", async () => {
    const publicClient = { getTransactionCount: vi.fn().mockResolvedValue(5) } as any;
    const manager = await createNonceManager(publicClient, "0x0000000000000000000000000000000000dead");

    expect(manager.next()).toBe(5);
  });

  it("increments on every call, never reusing a nonce", async () => {
    const publicClient = { getTransactionCount: vi.fn().mockResolvedValue(10) } as any;
    const manager = await createNonceManager(publicClient, "0x0000000000000000000000000000000000dead");

    expect(manager.next()).toBe(10);
    expect(manager.next()).toBe(11);
    expect(manager.next()).toBe(12);
  });

  it("queries getTransactionCount with the pending block tag", async () => {
    const getTransactionCount = vi.fn().mockResolvedValue(0);
    const publicClient = { getTransactionCount } as any;
    await createNonceManager(publicClient, "0x0000000000000000000000000000000000dead");

    expect(getTransactionCount).toHaveBeenCalledWith({
      address: "0x0000000000000000000000000000000000dead",
      blockTag: "pending",
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/worker && npx vitest run test/nonce-manager.test.ts`
Expected: FAIL — `../src/nonce-manager.js` does not exist yet.

- [ ] **Step 3: Implement `apps/worker/src/nonce-manager.ts`**

```typescript
import type { PublicClient } from "viem";

export interface NonceManager {
  next(): number;
}

export async function createNonceManager(publicClient: PublicClient, relayerAddress: `0x${string}`): Promise<NonceManager> {
  let currentNonce = await publicClient.getTransactionCount({ address: relayerAddress, blockTag: "pending" });

  return {
    next(): number {
      const nonce = currentNonce;
      currentNonce += 1;
      return nonce;
    },
  };
}
```

`blockTag: "pending"` (not `"latest"`) is used so the counter correctly starts after any transactions the relayer has already broadcast but not yet mined — relevant if the worker process restarts while transactions are in flight. This nonce manager is safe ONLY because `apps/worker/src/queues.ts` (Task 5) runs the `charge-queue` Worker with `concurrency: 1` — document this coupling clearly in that task, since a future reader adding concurrency without understanding this would silently reintroduce nonce collisions.

- [ ] **Step 4: Run the test again to verify it passes**

Run: `cd apps/worker && npx vitest run test/nonce-manager.test.ts`
Expected: PASS (3/3 tests).

- [ ] **Step 5: Implement `apps/worker/src/charge-submitter.ts`**

No isolated unit test for this file — it is a thin wrapper around viem calls with no independently-testable branching logic of its own (all its behavior is exercised by Task 6's full e2e test, which is the only way to meaningfully verify a real chain submission works). Read `packages/shared/abis/SubscriptionManager.ts` yourself to confirm the exact export name (`subscriptionManagerAbi`) before importing it.

```typescript
import type { PublicClient, WalletClient } from "viem";
import { subscriptionManagerAbi } from "../../../packages/shared/abis/SubscriptionManager.js";
import type { NonceManager } from "./nonce-manager.js";

export interface ChargeSubmitterDeps {
  walletClient: WalletClient;
  publicClient: PublicClient;
  subscriptionManagerAddress: `0x${string}`;
  nonceManager: NonceManager;
}

export async function submitCharge(deps: ChargeSubmitterDeps, onchainSubId: string): Promise<{ txHash: `0x${string}` }> {
  const { maxFeePerGas, maxPriorityFeePerGas } = await deps.publicClient.estimateFeesPerGas();

  const txHash = await deps.walletClient.writeContract({
    address: deps.subscriptionManagerAddress,
    abi: subscriptionManagerAbi,
    functionName: "charge",
    args: [BigInt(onchainSubId)],
    nonce: deps.nonceManager.next(),
    maxFeePerGas,
    maxPriorityFeePerGas,
    chain: null,
    account: deps.walletClient.account!,
  });

  await deps.publicClient.waitForTransactionReceipt({ hash: txHash });

  return { txHash };
}
```

The import path `"../../../packages/shared/abis/SubscriptionManager.js"` matches the exact relative-path pattern `apps/indexer/ponder.config.ts` already uses for the same file — `@cadence/shared` is not set up as a resolvable workspace package (it has no `main`/`exports` in its `package.json`), so a bare `"@cadence/shared"` import will NOT work; do not attempt it. `chain: null` is passed because `writeContract` requires either a `chain` (for chain-switching validation, irrelevant for a backend service with no wallet-extension context) or an explicit opt-out; passing `null` matches viem's documented pattern for server-side signing where no chain-switch prompt is possible or desired — read viem's own `writeContract` type signature yourself to confirm this is still correct for the installed viem version (`2.21.3` per Task 1) before treating this as unquestionable.

- [ ] **Step 6: Typecheck**

Run: `cd apps/worker && npx tsc --noEmit`
Expected: exit 0. If `chain: null` or the ABI import causes a type error, resolve it by reading viem's actual type definitions in `node_modules/.pnpm/viem@.../dist/...`, not by guessing — this file has no test coverage of its own, so a type error here would otherwise only surface at Task 6's e2e test.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/nonce-manager.ts apps/worker/src/charge-submitter.ts apps/worker/test/nonce-manager.test.ts
git commit -m "Add relayer nonce manager and charge-submission service"
```

---

### Task 4: BullMQ scheduler and queue wiring

**Files:**
- Create: `apps/worker/src/queues.ts`
- Create: `apps/worker/src/index.ts`

**Interfaces:**
- Consumes: `loadConfig` (Task 1), `findDueSubscriptions` (Task 1), `acquireChargeLock`/`releaseChargeLock` (Task 2), `createNonceManager`/`submitCharge` (Task 3).
- Produces: `createQueues(config: WorkerConfig): { chargeSchedulerQueue: Queue; chargeQueue: Queue; startChargeWorker(): Worker }`, used only by `index.ts` in this same task (no later task consumes this file directly — Task 6's e2e test drives the process via its compiled entrypoint, not by importing these functions).

No unit test for this task — BullMQ's own repeatable-job and queue mechanics are third-party infrastructure, and the meaningful behavior (does a due subscription actually get charged) is exercised end-to-end by Task 6. Writing a unit test that mocks BullMQ itself would only prove the mocks were wired correctly, not that the real scheduling works — skip it per YAGNI, and rely on Task 6's real integration test as the test for this task's logic. This is a deliberate deviation from strict TDD for this one task; every other task in this plan has real tests.

- [ ] **Step 1: Implement `apps/worker/src/queues.ts`**

```typescript
import { Queue, Worker, type Job } from "bullmq";
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { DbClient } from "@cadence/db";
import type { WorkerConfig } from "./config.js";
import { findDueSubscriptions } from "./due-query.js";
import { acquireChargeLock, releaseChargeLock } from "./charge-lock.js";
import { createNonceManager, type NonceManager } from "./nonce-manager.js";
import { submitCharge } from "./charge-submitter.js";
import type { Redis } from "ioredis";

export const CHARGE_SCHEDULER_QUEUE_NAME = "charge-scheduler";
export const CHARGE_QUEUE_NAME = "charge-queue";

export interface ChargeJobData {
  subId: string;
  periodEnd: string; // ISO string — BullMQ job data must be JSON-serializable, so Date is not usable directly
  chainId: number;
}

export function createQueues(config: WorkerConfig, db: DbClient, redis: Redis) {
  const connection = { connection: redis };

  const chargeSchedulerQueue = new Queue(CHARGE_SCHEDULER_QUEUE_NAME, connection);
  const chargeQueue = new Queue<ChargeJobData>(CHARGE_QUEUE_NAME, connection);

  const account = privateKeyToAccount(config.relayerPrivateKey);
  const publicClient = createPublicClient({ transport: http(config.rpcUrlHttp) });
  const walletClient = createWalletClient({ account, transport: http(config.rpcUrlHttp) });

  let nonceManagerPromise: Promise<NonceManager> | null = null;
  function getNonceManager(): Promise<NonceManager> {
    if (!nonceManagerPromise) {
      nonceManagerPromise = createNonceManager(publicClient, account.address);
    }
    return nonceManagerPromise;
  }

  async function scheduleDueCharges(): Promise<void> {
    const due = await findDueSubscriptions(db, { chainId: config.chainId, batchSize: 100 });
    for (const sub of due) {
      await chargeQueue.add(
        "charge",
        { subId: sub.onchainSubId, periodEnd: sub.currentPeriodEnd.toISOString(), chainId: config.chainId },
        { jobId: `${sub.onchainSubId}:${sub.currentPeriodEnd.toISOString()}` },
      );
    }
  }

  async function processChargeJob(job: Job<ChargeJobData>): Promise<void> {
    const periodEnd = new Date(job.data.periodEnd);
    const acquired = await acquireChargeLock(redis, job.data.subId, periodEnd);
    if (!acquired) {
      return; // Another tick or process already owns this sub+period — not a failure.
    }

    try {
      const nonceManager = await getNonceManager();
      const { txHash } = await submitCharge(
        { walletClient, publicClient, subscriptionManagerAddress: config.subscriptionManagerAddress, nonceManager },
        job.data.subId,
      );
      console.log(`Charged subId=${job.data.subId} txHash=${txHash}`);
    } finally {
      await releaseChargeLock(redis, job.data.subId, periodEnd);
    }
  }

  function startChargeWorker(): Worker<ChargeJobData> {
    return new Worker<ChargeJobData>(CHARGE_QUEUE_NAME, processChargeJob, {
      ...connection,
      concurrency: 1, // REQUIRED for nonce-manager correctness — see nonce-manager.ts.
      settings: { backoffStrategy: () => 5_000 },
    });
  }

  return { chargeSchedulerQueue, chargeQueue, scheduleDueCharges, startChargeWorker };
}
```

The `jobId: \`${sub.onchainSubId}:${sub.currentPeriodEnd.toISOString()}\`` on `chargeQueue.add` gives BullMQ its own built-in de-duplication for identical job IDs added while a prior job with the same ID hasn't completed — this is a second, independent layer of protection alongside the Redis lock (Task 2), not a replacement for it: the lock also protects against two separate WORKER PROCESSES (not just two ticks within one process) racing, which BullMQ's own job-ID dedup does not cover across independently-connected queue instances in the same way. Keep both.

`releaseChargeLock` in a `finally` block ensures the lock is released even if `submitCharge` throws — letting BullMQ's own retry mechanism attempt the job again on the next attempt without waiting for the lock's TTL to expire.

- [ ] **Step 2: Implement `apps/worker/src/index.ts`**

```typescript
import Redis from "ioredis";
import { createDbClient } from "@cadence/db";
import { loadConfig } from "./config.js";
import { createQueues, CHARGE_SCHEDULER_QUEUE_NAME } from "./queues.js";

async function main() {
  const config = loadConfig();
  const db = createDbClient(config.databaseUrl);
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

  const { chargeSchedulerQueue, scheduleDueCharges, startChargeWorker } = createQueues(config, db, redis);

  await chargeSchedulerQueue.upsertJobScheduler(
    `${CHARGE_SCHEDULER_QUEUE_NAME}-repeat`,
    { every: config.schedulerIntervalMs },
    { name: "scan-due-subscriptions", data: {} },
  );

  const schedulerQueueWorker = new (await import("bullmq")).Worker(
    CHARGE_SCHEDULER_QUEUE_NAME,
    async () => {
      await scheduleDueCharges();
    },
    { connection: redis },
  );

  const chargeWorker = startChargeWorker();

  console.log(`Worker started. Scheduler interval: ${config.schedulerIntervalMs}ms.`);

  async function shutdown() {
    console.log("Shutting down...");
    await schedulerQueueWorker.close();
    await chargeWorker.close();
    await redis.quit();
    process.exit(0);
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Worker failed to start:", err);
  process.exit(1);
});
```

`maxRetriesPerRequest: null` on the `ioredis` client is BullMQ's own documented requirement for its Redis connections (BullMQ manages retries itself) — this is not optional configuration, omitting it causes BullMQ to throw at startup. `upsertJobScheduler` is BullMQ 5.x's API for repeatable jobs (replacing the older `queue.add(..., {repeat: ...})` pattern) — confirm this method exists on the installed `bullmq` version (`^5.34.0` per Task 1) by checking `node_modules/.pnpm/bullmq@.../dist/...`'s type definitions before trusting this API name; if the installed version's API differs, adapt to whatever the actual installed version exposes for repeatable jobs, since BullMQ's repeat-job API has changed across major versions.

- [ ] **Step 3: Typecheck**

Run: `cd apps/worker && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Build (production compile check)**

Run: `cd apps/worker && npm run build`
Expected: exit 0, `apps/worker/dist/index.js` exists.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/queues.ts apps/worker/src/index.ts
git commit -m "Wire BullMQ scheduler and charge-queue worker"
```

---

### Task 5: Anvil e2e test helpers (spawn + deploy)

**Files:**
- Create: `packages/contracts/script/DeployLocal.s.sol`
- Create: `apps/worker/test/e2e-helpers/anvil.ts`
- Create: `apps/worker/test/e2e-helpers/deploy.ts`

**Interfaces:**
- Produces: `startAnvil(port: number): Promise<{ rpcUrl: string; stop(): Promise<void> }>` — spawns a local `anvil` child process, waits until it accepts RPC requests, returns its URL and a teardown function. Produces `deployContracts(rpcUrl: string): Promise<{ subscriptionManager: \`0x${string}\`; usdc: \`0x${string}\`; treasury: \`0x${string}\` }>` — runs `forge script script/DeployLocal.s.sol` against the given RPC URL using anvil's well-known default deployer key, then parses the resulting Foundry broadcast JSON (NOT the shared `deployments/84532.json`) for contract addresses. Both consumed by Task 6.

**Pre-resolved investigation (do not re-derive — this was checked before writing this task):** `packages/contracts/script/Deploy.s.sol` (the existing, production-facing deploy script) hardcodes `Config.BASE_SEPOLIA_USDC` — a real Base Sepolia token address with no bytecode on a fresh local anvil chain — as the supported token, and never deploys `MockUSDC` (confirmed by reading `Deploy.s.sol` and `Config.sol` in full: `Config.sol` only defines `BASE_SEPOLIA_USDC`/`DEFAULT_FEE_BPS`/`TIMELOCK_MIN_DELAY`, no local-chain variant exists anywhere in `packages/contracts/script/`). Using `Deploy.s.sol` unmodified against a fresh anvil chain would produce a `SubscriptionManager` configured with a token that has no code, and any `subscribe()`/`charge()` call would revert. Do not attempt to force `Deploy.s.sol` to work for this — Step 0 below adds a new, separate, local-only script instead, leaving `Deploy.s.sol` completely untouched (it remains the only script real deployments use).

- [ ] **Step 0: Add a local-only deploy script that deploys `MockUSDC`**

Create `packages/contracts/script/DeployLocal.s.sol`. This mirrors `Deploy.s.sol`'s structure exactly, with one addition (deploying `MockUSDC` instead of referencing `Config.BASE_SEPOLIA_USDC`) and one simplification (no Timelock role transfer — the test deployer keeps admin directly, since these e2e tests never touch governance/upgrade paths and the extra role-transfer transactions would only slow down every test run for no test value):

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {FeeRegistry} from "../src/FeeRegistry.sol";
import {SubscriptionManager} from "../src/SubscriptionManager.sol";
import {MockUSDC} from "../test/helpers/MockUSDC.sol";
import {Config} from "./Config.sol";

// Local-only deploy script for e2e tests against a fresh anvil chain. Unlike
// Deploy.s.sol (the real deployment path, which targets a live network with a
// real USDC address and transfers admin roles to a Timelock), this script:
//   1. Deploys a MockUSDC token instead of referencing a real network's USDC
//      address, since a fresh anvil chain has no code at that address.
//   2. Leaves the deployer as admin directly (no Timelock role transfer) —
//      these tests never exercise governance/upgrade paths, so the extra
//      transactions would only slow down every test run.
// Never use this script against a real network.
contract DeployLocal is Script {
    function run() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPk);

        vm.startBroadcast(deployerPk);

        MockUSDC usdc = new MockUSDC();

        FeeRegistry feeImpl = new FeeRegistry();
        FeeRegistry feeRegistry = FeeRegistry(
            address(new ERC1967Proxy(address(feeImpl), abi.encodeCall(FeeRegistry.initialize, (deployer, Config.DEFAULT_FEE_BPS))))
        );

        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        SubscriptionManager mgrImpl = new SubscriptionManager();
        SubscriptionManager manager = SubscriptionManager(
            address(
                new ERC1967Proxy(
                    address(mgrImpl),
                    abi.encodeCall(SubscriptionManager.initialize, (deployer, deployer, address(feeRegistry), tokens))
                )
            )
        );

        vm.stopBroadcast();

        console2.log("MockUSDC:", address(usdc));
        console2.log("FeeRegistry (proxy):", address(feeRegistry));
        console2.log("SubscriptionManager (proxy):", address(manager));
    }
}
```

Note this script does NOT call `_writeDeploymentJson`/`vm.writeFile` at all — it has no `fs_permissions` need beyond what `foundry.toml` already grants (read-write on `../../deployments`, which this script never touches), and Task 5's Step 3 below reads addresses from forge's own broadcast artifact instead.

- [ ] **Step 1: Verify the new script compiles**

Run: `cd packages/contracts && forge build`
Expected: exit 0, no new compiler errors. This confirms `DeployLocal.s.sol` type-checks against the real `FeeRegistry`/`SubscriptionManager`/`MockUSDC` contracts before any TypeScript code tries to invoke it.

- [ ] **Step 2: Implement `apps/worker/test/e2e-helpers/anvil.ts`**

- [ ] **Step 1: Implement `apps/worker/test/e2e-helpers/anvil.ts`**

```typescript
import { spawn, type ChildProcess } from "node:child_process";

export interface StartedAnvil {
  rpcUrl: string;
  stop(): Promise<void>;
}

export async function startAnvil(port: number): Promise<StartedAnvil> {
  const child: ChildProcess = spawn("anvil", ["--port", String(port), "--chain-id", "84532", "--silent"], {
    stdio: ["ignore", "ignore", "pipe"],
  });

  const rpcUrl = `http://127.0.0.1:${port}`;

  await waitForRpc(rpcUrl);

  return {
    rpcUrl,
    async stop() {
      child.kill();
    },
  };
}

async function waitForRpc(rpcUrl: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
      });
      if (response.ok) return;
    } catch {
      // anvil not accepting connections yet — retry
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`anvil did not become ready on ${rpcUrl} within ${timeoutMs}ms`);
}
```

`--chain-id 84532` matches the chain ID already used throughout this project's `deployments/84532.json`/indexer config, so the worker's `findDueSubscriptions({ chainId: 84532, ... })` filter matches test-seeded rows without needing a special test-only chain ID. `--silent` suppresses anvil's verbose per-block/per-tx logging, which would otherwise flood test output.

- [ ] **Step 3: Implement `apps/worker/test/e2e-helpers/deploy.ts`**

```typescript
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const ANVIL_DEFAULT_DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export interface DeployedContracts {
  subscriptionManager: `0x${string}`;
  usdc: `0x${string}`;
  treasury: `0x${string}`;
}

export function deployContracts(rpcUrl: string): DeployedContracts {
  const contractsDir = path.resolve(__dirname, "../../../../packages/contracts");

  execSync(`forge script script/DeployLocal.s.sol --rpc-url ${rpcUrl} --broadcast`, {
    cwd: contractsDir,
    env: { ...process.env, DEPLOYER_PRIVATE_KEY: ANVIL_DEFAULT_DEPLOYER_KEY },
    stdio: "inherit",
  });

  // Read forge's own broadcast artifact — NOT the shared deployments/84532.json.
  // DeployLocal.s.sol (Step 0 of this task) never writes to that file at all;
  // it exists purely so apps/indexer and apps/api's real dev setup is never
  // touched by a throwaway test deployment.
  const broadcastPath = path.join(contractsDir, "broadcast/DeployLocal.s.sol/84532/run-latest.json");
  const broadcast = JSON.parse(readFileSync(broadcastPath, "utf-8")) as {
    transactions: { contractName: string; contractAddress: string }[];
  };

  function addressOf(contractName: string): `0x${string}` {
    const tx = broadcast.transactions.find((t) => t.contractName === contractName);
    if (!tx) throw new Error(`No deployed contract named ${contractName} found in broadcast artifact`);
    return tx.contractAddress as `0x${string}`;
  }

  // DeployLocal.s.sol deploys SubscriptionManager behind an ERC1967Proxy — the
  // proxy IS the address callers use. Forge's broadcast JSON records each
  // CREATE transaction under the name of the contract actually being
  // constructed, so the proxy deployment is recorded as "ERC1967Proxy" (twice —
  // once for FeeRegistry's proxy, once for SubscriptionManager's), NOT as
  // "SubscriptionManager". The deployment order in DeployLocal.s.sol is fixed
  // (MockUSDC, then FeeRegistry impl+proxy, then SubscriptionManager
  // impl+proxy), so the SECOND ERC1967Proxy transaction in broadcast order is
  // always the SubscriptionManager proxy. Implementer: verify this against a
  // real run's broadcast JSON (print `broadcast.transactions.map(t => t.contractName)`
  // once and read it) before trusting the index-based lookup below — do not
  // assume the ordering without checking the actual artifact at least once.
  const proxyDeployments = broadcast.transactions.filter((t) => t.contractName === "ERC1967Proxy");
  if (proxyDeployments.length < 2) {
    throw new Error(
      `Expected 2 ERC1967Proxy deployments (FeeRegistry, SubscriptionManager) in broadcast artifact, found ${proxyDeployments.length}`,
    );
  }

  return {
    subscriptionManager: proxyDeployments[1].contractAddress as `0x${string}`,
    usdc: addressOf("MockUSDC"),
    treasury: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", // anvil default account #0 — DeployLocal.s.sol's deployer, matching Deploy.s.sol's own deployer-as-treasury-placeholder convention for Phase 0
  };
}
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/worker && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/script/DeployLocal.s.sol apps/worker/test/e2e-helpers
git commit -m "Add local-only deploy script and anvil e2e test helpers"
```

---

### Task 6: Full charge-flow e2e test

**Files:**
- Create: `apps/worker/vitest.e2e.config.ts`
- Create: `apps/worker/test/charge-flow.e2e-spec.ts`

**Interfaces:**
- Consumes: `startAnvil`/`deployContracts` (Task 5), `createQueues` (Task 4), `loadConfig`-shaped config built directly in the test (not via env vars, since the anvil URL/addresses are only known after Task 5's helpers run).

- [ ] **Step 1: Create the e2e Vitest config**

Create `apps/worker/vitest.e2e.config.ts`, mirroring `apps/api/vitest.e2e.config.ts`'s shape (no SWC/decorator-metadata plugin is needed here since `apps/worker` has no NestJS dependency-injection to preserve):

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.e2e-spec.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
```

Timeouts are set higher than `apps/api`'s existing e2e config (60s) because this test additionally spawns anvil and runs a real `forge script` deployment, both slower than Testcontainers Postgres alone.

- [ ] **Step 2: Write the full e2e test**

Create `apps/worker/test/charge-flow.e2e-spec.ts`:

```typescript
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
import { createQueues } from "../src/queues.js";
import type { WorkerConfig } from "../src/config.js";
import { acquireChargeLock } from "../src/charge-lock.js";

const ANVIL_ACCOUNT_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // relayer + deployer
const ANVIL_ACCOUNT_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690"; // test subscriber

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
    redis = new Redis(redisContainer.getConnectionUrl());
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
    };
    const { chargeQueue, startChargeWorker } = createQueues(config, db, redis);
    const worker = startChargeWorker();

    await chargeQueue.add(
      "charge",
      { subId: "2", periodEnd: periodEnd.toISOString(), chainId: 84532 },
      { jobId: "2:already-locked-test" },
    );
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    const publicClient = createPublicClient({ transport: http(anvil.rpcUrl) });
    const nonceAfter = await publicClient.getTransactionCount({
      address: privateKeyToAccount(ANVIL_ACCOUNT_0).address,
    });
    // If the lock correctly blocked submission, the relayer's nonce should be
    // unchanged from whatever it was after the previous test's one real charge
    // tx — this test runs second, so it should be exactly 1 tx-count higher
    // than a fresh account, not 2. A looser but still meaningful assertion:
    // confirm no NEW transaction targeting subId 2 was mined by checking the
    // subscriber's on-chain subscription status is untouched (would have
    // advanced currentPeriodEnd if charged).
    expect(nonceAfter).toBeGreaterThanOrEqual(0); // placeholder lower bound; the real assertion is below

    await worker.close();
  }, 30_000);
});
```

The second test's final assertions are intentionally left partially weak in this draft (the comment says so directly) — this is a case where verifying "no transaction was submitted" is inherently awkward to assert directly (proving a negative). The implementer must strengthen this before considering the task done: read `viem`'s `PublicClient` methods for a way to assert the relayer's nonce did NOT increase relative to a captured baseline taken immediately before `chargeQueue.add(...)` in this test (not compared against "a fresh account" or the previous test's side effects, which makes the current comment's reasoning unreliable across re-runs or reordering). Capture `nonceBefore` right before adding the job, then assert `nonceAfter === nonceBefore` — this is a self-contained, order-independent assertion, unlike what's drafted above. Fix this as part of implementing this task, and note in your task report that you did so.

- [ ] **Step 3: Run the e2e test**

Run: `cd apps/worker && npx vitest run --config vitest.e2e.config.ts`
Expected: PASS (2/2 tests). This is the slowest test in the whole project so far (spawns anvil, runs a real forge deployment, waits for real block confirmations) — if it times out, first check whether `anvil`/`forge` are on `PATH` (`which anvil forge`) before assuming a logic bug.

- [ ] **Step 4: Typecheck**

Run: `cd apps/worker && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/vitest.e2e.config.ts apps/worker/test/charge-flow.e2e-spec.ts
git commit -m "Add full anvil-based charge-flow e2e test"
```

---

## Plan Self-Review Notes

**Spec coverage check:**
- Standalone `apps/worker` process, no NestJS → Task 1 (package scaffolding). ✓
- Due-query (`active`/`trialing`/`past_due`, `current_period_end <= now()`, `chainId` filter, `past_due` unconditional/no dunning gate, batch size, ordering) → Task 1. ✓
- Redis idempotency lock `charging:{subId}:{periodEnd}` → Task 2. ✓
- Simple in-process nonce counter, safe only under serialization → Task 3, enforced by Task 4's `concurrency: 1`. ✓
- One `charge()` call per due sub (no `chargeBatch`) → Task 3's `submitCharge`, confirmed single-sub signature. ✓
- Wait for 1 confirmation, log tx hash, no receipt-log parsing for outcome → Task 3 (`waitForTransactionReceipt`, no log decoding) + Task 4 (`console.log`, no outcome branching). ✓
- Repeatable BullMQ scheduler (default 5 min, configurable) → Task 1 (`schedulerIntervalMs` config) + Task 4 (`upsertJobScheduler`). ✓
- `viem`, not `ethers` → all of Tasks 3-6. ✓
- Contract addresses from `deployments/{chainId}.json` → Task 1's `loadConfig`. ✓
- anvil-based e2e testing (real tx, real balance change) → Task 5 (helpers) + Task 6 (the test itself). ✓
- No fee-bumping/stuck-tx/balance-alerting/dunning_state → explicitly absent from every task's code; called out in Global Constraints.

**Placeholder scan:** No open placeholders remain. One genuine pre-existing-code discrepancy was found and resolved during plan-writing itself (not deferred to the implementer): `Deploy.s.sol` (the real deployment script) hardcodes a real Base Sepolia USDC address and never deploys `MockUSDC`, which would make it unusable against a fresh local anvil chain for e2e testing. This was confirmed by reading `Deploy.s.sol` and `Config.sol` directly, and resolved by adding a new, separate `DeployLocal.s.sol` script (Task 5, Step 0) rather than leaving the question open — the plan's code for `deployContracts` (Task 5, Step 3) targets this new script directly, with no unresolved branches. One remaining known weak spot is explicitly flagged with a precise, bounded fix path rather than left vague: Task 6's second test's final assertion needs the implementer to capture the relayer's nonce immediately before adding the test's job and compare it to the nonce immediately after (an order-independent, self-contained check), rather than the draft's weaker comparison against an assumed baseline — this is called out inline in that task's code block.

**Type consistency check:** `WorkerConfig` (Task 1) is consumed identically in Task 4's `createQueues(config, db, redis)` and Task 6's test-constructed config object — field names match exactly (`databaseUrl`, `redisUrl`, `relayerPrivateKey`, `rpcUrlHttp`, `chainId`, `schedulerIntervalMs`, `subscriptionManagerAddress`). `DueSubscription` (Task 1) → consumed by Task 4's `scheduleDueCharges` via `sub.onchainSubId`/`sub.currentPeriodEnd`, matching field names. `NonceManager` (Task 3) → consumed by Task 4's `getNonceManager()`/`submitCharge` call site with the same `.next()` method name. `ChargeSubmitterDeps` (Task 3) → constructed in Task 4 with matching field names (`walletClient`, `publicClient`, `subscriptionManagerAddress`, `nonceManager`).

No gaps found requiring an additional task.
