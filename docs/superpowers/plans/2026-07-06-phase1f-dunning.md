# Phase 1f — Dunning State Machine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the charge scheduler from retrying a failing subscription every 5 minutes forever — add a per-plan-configurable retry ladder with backoff, and a terminal "exhausted" state, via a new `dunning_state` table reconciled against observed subscription status.

**Architecture:** A new `dunning_state` app table tracks retry attempts per subscription. A reconciliation step runs at the start of every scheduler tick (folded into `apps/worker/src/queues.ts`'s existing `scheduleDueCharges()`, not a separate process): it creates rows for newly-`past_due` subscriptions, deletes rows for subscriptions that recovered, and advances/exhausts rows for subscriptions still `past_due` past their retry window. `apps/worker/src/due-query.ts` gains one additional gate on the `past_due` branch only.

**Tech Stack:** Drizzle ORM (matching `packages/db`'s existing conventions), Vitest + Testcontainers Postgres (matching `apps/worker`'s existing test conventions from Phase 1e) — no new dependencies.

## Global Constraints

- `dunning_state.onchain_sub_id` uses `numeric(78,0)` (matching `onchain_subscription.onchain_sub_id`'s actual column type in `packages/db/src/onchain-schema.ts` — verified, not assumed).
- `dunning_state` is migrated via the normal `packages/db/drizzle.config.ts`/`migrations/` path — it is app-owned (like `plan_meta`/`customer`), never routed through the on-chain-mirror path.
- Ladder-exhausted subscriptions are NEVER force-cancelled on-chain in this phase. `SubscriptionManager.cancel()` is subscriber-only with no admin/permissionless override (confirmed by reading the contract) — exhaustion is an off-chain-only terminal state (`dunning_state.exhausted = true`, scheduler stops retrying), and the subscription's on-chain status remains `past_due` until the subscriber acts. Do not add contract changes or any workaround for this in this phase.
- No real email sending — every dunning transition (created/retried/renewed/exhausted) is logged via `console.log`, never sent to an email provider.
- No webhook delivery — logging only, same as email.
- `apps/indexer` is not modified in this phase — `dunning_state` is reconciled by the worker polling already-projected `onchain_subscription` status, never written to by the indexer.
- The due-query change must not alter `active`/`trialing` gating at all — only the `past_due` branch gains the additional `dunning_state` condition. `active`/`trialing` subscriptions remain gated solely by `current_period_end <= now()`, exactly as Phase 1e built it.
- Numeric/text mismatches: `onchain_plan.onchain_plan_id` is `numeric(78,0)` but `plan_meta.onchain_plan_id` is `text` — any join between them needs an explicit `sql\`...::text\`` cast, following the exact pattern already established in `apps/api/src/plans/plans.service.ts:133`.

---

## File Structure

**New files:**
- `apps/worker/src/dunning.ts` — `parseDuration(s: string): number` (ladder-string-to-milliseconds), `reconcileDunningState(db: DbClient, chainId: number): Promise<void>` (the full reconciliation logic: create/delete/advance/exhaust).
- `apps/worker/test/dunning.test.ts` — Testcontainers Postgres tests for `reconcileDunningState` and `parseDuration`.

**Modified files:**
- `packages/db/src/schema.ts` — add `dunningState` table.
- `apps/worker/src/due-query.ts` — add the `dunning_state` gate to the `past_due` branch of the WHERE clause.
- `apps/worker/src/queues.ts` — call `reconcileDunningState(db, config.chainId)` at the start of `scheduleDueCharges()`, before `findDueSubscriptions()` runs.
- `apps/worker/test/due-query.test.ts` — **update, not just leave alone**: the existing test `"includes a past_due subscription unconditionally (no dunning gate exists yet)"` (line 76) asserts behavior this phase deliberately changes. It must be replaced with tests that reflect the new gated behavior (a `past_due` sub with no `dunning_state` row is still due; one with a future `next_retry_at` is excluded; one with a past `next_retry_at` and not exhausted is included; one `exhausted` is excluded).

---

### Task 1: `dunning_state` table (packages/db)

**Files:**
- Modify: `packages/db/src/schema.ts`
- Test: `packages/db/test/dunning-schema.test.ts` (new)

**Interfaces:**
- Produces: `schema.dunningState` (Drizzle table: `onchainSubId` numeric(78,0) PK, `attempt` smallint not null default 1, `nextRetryAt` timestamptz not null, `exhausted` boolean not null default false, `ladder` jsonb not null, `createdAt`/`updatedAt` timestamptz not null default now()), consumed by Task 2 (`reconcileDunningState`) and Task 3 (`findDueSubscriptions`).

- [ ] **Step 1: Add `dunningState` to `packages/db/src/schema.ts`**

Read the current file first — it defines `apiKeyType`, `merchant`, `apiKey`, `planMeta`, `customer`. The existing imports at the top already include `pgTable`, `text`, `boolean`, `timestamp`, `jsonb`, `sql` — but NOT `numeric` or `smallint` (those are currently only used in `packages/db/src/onchain-schema.ts`, a separate file). Add `numeric` and `smallint` to this file's `drizzle-orm/pg-core` import line.

Add after `customer`:

```typescript
export const dunningState = pgTable("dunning_state", {
  onchainSubId: numeric("onchain_sub_id", { precision: 78, scale: 0 }).primaryKey(),
  attempt: smallint("attempt").notNull().default(1),
  nextRetryAt: timestamp("next_retry_at", { withTimezone: true }).notNull(),
  exhausted: boolean("exhausted").notNull().default(false),
  ladder: jsonb("ladder").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Note: this table has NO foreign-key `.references()` call to `onchain_subscription` — unlike `plan_meta`/`customer`'s references to `merchant`, `onchain_subscription` lives in the separate on-chain-mirror schema (`onchain-schema.ts`), which Drizzle cannot declare a cross-file/cross-config FK constraint against (the two schemas are migrated through entirely separate `drizzle-kit` configs, per the on-chain-mirror pattern established in Phase 1c). The PRD's sketch shows `REFERENCES onchain_subscription`, but this codebase's actual established pattern (confirmed in `packages/db/src/onchain-schema.ts`'s own header comment) is that cross-schema references are enforced at the application level, not the database level.

- [ ] **Step 2: Generate and inspect the migration**

Run: `cd packages/db && npx drizzle-kit generate --name add_dunning_state`
Expected: a new file under `packages/db/migrations/`, e.g. `0003_<name>.sql`, containing exactly one `CREATE TABLE "dunning_state" (...)` statement with no foreign key constraints. No other table should be touched, and — critically — no `onchain_plan`/`onchain_subscription`/`onchain_charge` tables should appear (those belong only in `packages/db/migrations-onchain/`).

- [ ] **Step 3: Write a test proving the table works**

Create `packages/db/test/dunning-schema.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import path from "node:path";
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
```

This test needs `eq` imported from `drizzle-orm` — add `import { eq } from "drizzle-orm";` to the top of the file alongside the existing imports.

- [ ] **Step 4: Run the test**

Run: `cd packages/db && npx vitest run test/dunning-schema.test.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Rebuild and typecheck**

Run: `cd packages/db && npm run build && npm run typecheck`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/migrations packages/db/test/dunning-schema.test.ts
git commit -m "Add dunning_state table for retry backoff tracking"
```

---

### Task 2: Reconciliation logic (`apps/worker/src/dunning.ts`)

**Files:**
- Create: `apps/worker/src/dunning.ts`
- Test: `apps/worker/test/dunning.test.ts`

**Interfaces:**
- Consumes: `schema.dunningState`, `schema.planMeta` (Task 1, `@cadence/db`), `onchainSchema.onchainPlan`/`onchainSchema.onchainSubscription` (already exist, `@cadence/db`).
- Produces: `parseDuration(s: string): number` (exported for its own unit tests and for Task 3's due-query, though Task 3 doesn't need it directly — it's exported because it's a small, independently-testable pure function, not because another task calls it). Produces `reconcileDunningState(db: DbClient, chainId: number): Promise<void>`, consumed by Task 3 (called from `queues.ts`'s `scheduleDueCharges()`).

- [ ] **Step 1: Write the failing test for `parseDuration`**

Create `apps/worker/test/dunning.test.ts`. This is the full file — it covers both `parseDuration` and `reconcileDunningState`:

```typescript
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import path from "node:path";
import { createDbClient, schema, onchainSchema, type DbClient } from "@cadence/db";
import { parseDuration, reconcileDunningState } from "../src/dunning.js";

describe("parseDuration", () => {
  it("parses days", () => {
    expect(parseDuration("1d")).toBe(24 * 60 * 60 * 1000);
    expect(parseDuration("7d")).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("parses hours", () => {
    expect(parseDuration("6h")).toBe(6 * 60 * 60 * 1000);
  });

  it("throws on an unrecognized format", () => {
    expect(() => parseDuration("3w")).toThrow();
    expect(() => parseDuration("abc")).toThrow();
  });
});

describe("reconcileDunningState", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbClient;
  let planCounter = 0;
  let subCounter = 0;

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

  async function seedPlan(overrides: Partial<typeof onchainSchema.onchainPlan.$inferInsert> = {}) {
    planCounter += 1;
    const onchainPlanId = String(planCounter);
    await db.insert(onchainSchema.onchainPlan).values({
      onchainPlanId,
      merchantAddress: "0xabc0000000000000000000000000000000000a",
      payoutSplit: "0xdef0000000000000000000000000000000000b",
      token: "0x0000000000000000000000000000000000000c",
      amount: "20000000",
      periodSeconds: 2592000n,
      trialSeconds: 0n,
      active: true,
      chainId: 84532,
      ...overrides,
    });
    return onchainPlanId;
  }

  async function seedSub(onchainPlanId: string, overrides: Partial<typeof onchainSchema.onchainSubscription.$inferInsert> = {}) {
    subCounter += 1;
    const onchainSubId = String(subCounter);
    await db.insert(onchainSchema.onchainSubscription).values({
      onchainSubId,
      onchainPlanId,
      subscriberAddress: "0x1110000000000000000000000000000000000d",
      status: "past_due",
      currentPeriodEnd: new Date(Date.now() - 60_000),
      pausedRemaining: 0n,
      pendingCancel: false,
      chainId: 84532,
      ...overrides,
    });
    return onchainSubId;
  }

  it("creates a dunning_state row for a newly past_due subscription using the plan's ladder", async () => {
    const planId = await seedPlan();
    await db.insert(schema.merchant).values({ name: "Test Co", ownerAddress: "0xabc0000000000000000000000000000000000a" }).onConflictDoNothing();
    const [merchantRow] = await db.select().from(schema.merchant).where(eq(schema.merchant.ownerAddress, "0xabc0000000000000000000000000000000000a"));
    await db.insert(schema.planMeta).values({ onchainPlanId: planId, merchantId: merchantRow.id, name: "Test Plan", dunningLadder: ["2d", "4d"] });
    const subId = await seedSub(planId);

    await reconcileDunningState(db, 84532);

    const [row] = await db.select().from(schema.dunningState).where(eq(schema.dunningState.onchainSubId, subId));
    expect(row).toBeDefined();
    expect(row.attempt).toBe(1);
    expect(row.exhausted).toBe(false);
    expect(row.ladder).toEqual(["2d", "4d"]);
    const expectedRetryAt = Date.now() + parseDuration("2d");
    expect(Math.abs(row.nextRetryAt.getTime() - expectedRetryAt)).toBeLessThan(5000);
  });

  it("uses the default ladder when the plan has no plan_meta row", async () => {
    const planId = await seedPlan();
    const subId = await seedSub(planId);

    await reconcileDunningState(db, 84532);

    const [row] = await db.select().from(schema.dunningState).where(eq(schema.dunningState.onchainSubId, subId));
    expect(row.ladder).toEqual(["1d", "3d", "5d", "7d"]);
  });

  it("deletes the dunning_state row once the subscription is no longer past_due", async () => {
    const planId = await seedPlan();
    const subId = await seedSub(planId);
    await reconcileDunningState(db, 84532);

    await db.update(onchainSchema.onchainSubscription).set({ status: "active" }).where(eq(onchainSchema.onchainSubscription.onchainSubId, subId));
    await reconcileDunningState(db, 84532);

    const rows = await db.select().from(schema.dunningState).where(eq(schema.dunningState.onchainSubId, subId));
    expect(rows).toHaveLength(0);
  });

  it("advances attempt and next_retry_at for a subscription still past_due past its retry window", async () => {
    const planId = await seedPlan();
    const subId = await seedSub(planId);
    await db.insert(schema.dunningState).values({
      onchainSubId: subId,
      attempt: 1,
      nextRetryAt: new Date(Date.now() - 1000),
      exhausted: false,
      ladder: ["1d", "3d", "5d", "7d"],
    });

    await reconcileDunningState(db, 84532);

    const [row] = await db.select().from(schema.dunningState).where(eq(schema.dunningState.onchainSubId, subId));
    expect(row.attempt).toBe(2);
    expect(row.exhausted).toBe(false);
    const expectedRetryAt = Date.now() + parseDuration("3d");
    expect(Math.abs(row.nextRetryAt.getTime() - expectedRetryAt)).toBeLessThan(5000);
  });

  it("marks a row exhausted once attempt reaches the ladder's length, and does not advance further", async () => {
    const planId = await seedPlan();
    const subId = await seedSub(planId);
    await db.insert(schema.dunningState).values({
      onchainSubId: subId,
      attempt: 4,
      nextRetryAt: new Date(Date.now() - 1000),
      exhausted: false,
      ladder: ["1d", "3d", "5d", "7d"],
    });

    await reconcileDunningState(db, 84532);

    const [row] = await db.select().from(schema.dunningState).where(eq(schema.dunningState.onchainSubId, subId));
    expect(row.exhausted).toBe(true);
    expect(row.attempt).toBe(4);

    const nextRetryAtBefore = row.nextRetryAt.getTime();
    await reconcileDunningState(db, 84532);
    const [rowAfter] = await db.select().from(schema.dunningState).where(eq(schema.dunningState.onchainSubId, subId));
    expect(rowAfter.exhausted).toBe(true);
    expect(rowAfter.nextRetryAt.getTime()).toBe(nextRetryAtBefore);
  });

  it("does not touch a dunning_state row whose next_retry_at is still in the future", async () => {
    const planId = await seedPlan();
    const subId = await seedSub(planId);
    const futureRetry = new Date(Date.now() + 86_400_000);
    await db.insert(schema.dunningState).values({
      onchainSubId: subId,
      attempt: 1,
      nextRetryAt: futureRetry,
      exhausted: false,
      ladder: ["1d", "3d", "5d", "7d"],
    });

    await reconcileDunningState(db, 84532);

    const [row] = await db.select().from(schema.dunningState).where(eq(schema.dunningState.onchainSubId, subId));
    expect(row.attempt).toBe(1);
    expect(row.nextRetryAt.getTime()).toBe(futureRetry.getTime());
  });

  it("respects the chainId filter when creating new dunning_state rows", async () => {
    const planId = await seedPlan({ chainId: 999 });
    const subId = await seedSub(planId, { chainId: 999 });

    await reconcileDunningState(db, 84532);

    const rows = await db.select().from(schema.dunningState).where(eq(schema.dunningState.onchainSubId, subId));
    expect(rows).toHaveLength(0);
  });
});
```

This test file needs `eq` from `drizzle-orm` — add `import { eq } from "drizzle-orm";` at the top.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/worker && npx vitest run test/dunning.test.ts`
Expected: FAIL — `../src/dunning.js` does not exist yet.

- [ ] **Step 3: Implement `apps/worker/src/dunning.ts`**

```typescript
import { and, eq, inArray, isNull, lte, ne, notInArray, sql } from "drizzle-orm";
import { schema, onchainSchema } from "@cadence/db";
import type { DbClient } from "@cadence/db";

const DEFAULT_LADDER = ["1d", "3d", "5d", "7d"];

const DURATION_PATTERN = /^(\d+)(d|h)$/;

export function parseDuration(value: string): number {
  const match = DURATION_PATTERN.exec(value);
  if (!match) {
    throw new Error(`Unrecognized dunning ladder duration: "${value}" (expected e.g. "1d" or "6h")`);
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const msPerUnit = unit === "d" ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  return amount * msPerUnit;
}

export async function reconcileDunningState(db: DbClient, chainId: number): Promise<void> {
  await createRowsForNewFailures(db, chainId);
  await deleteRowsForRecoveredSubscriptions(db, chainId);
  await advanceOrExhaustRepeatFailures(db, chainId);
}

async function createRowsForNewFailures(db: DbClient, chainId: number): Promise<void> {
  const existingIds = await db.select({ id: schema.dunningState.onchainSubId }).from(schema.dunningState);
  const existingIdSet = existingIds.map((r) => r.id);

  const newlyFailed = await db
    .select()
    .from(onchainSchema.onchainSubscription)
    .where(
      and(
        eq(onchainSchema.onchainSubscription.status, "past_due"),
        eq(onchainSchema.onchainSubscription.chainId, chainId),
        existingIdSet.length > 0 ? notInArray(onchainSchema.onchainSubscription.onchainSubId, existingIdSet) : undefined,
      ),
    );

  for (const sub of newlyFailed) {
    const [plan] = await db
      .select()
      .from(onchainSchema.onchainPlan)
      .where(eq(onchainSchema.onchainPlan.onchainPlanId, sub.onchainPlanId));

    let ladder: string[] = DEFAULT_LADDER;
    if (plan) {
      const [meta] = await db
        .select()
        .from(schema.planMeta)
        .where(eq(sql`${plan.onchainPlanId}::text`, schema.planMeta.onchainPlanId));
      if (meta?.dunningLadder) {
        ladder = meta.dunningLadder as string[];
      }
    }

    await db.insert(schema.dunningState).values({
      onchainSubId: sub.onchainSubId,
      attempt: 1,
      nextRetryAt: new Date(Date.now() + parseDuration(ladder[0])),
      exhausted: false,
      ladder,
    });

    console.log(`dunning: payment_failed subId=${sub.onchainSubId} attempt=1 next_retry_at=${new Date(Date.now() + parseDuration(ladder[0])).toISOString()}`);
  }
}

async function deleteRowsForRecoveredSubscriptions(db: DbClient, chainId: number): Promise<void> {
  const recovered = await db
    .select({ onchainSubId: schema.dunningState.onchainSubId })
    .from(schema.dunningState)
    .innerJoin(onchainSchema.onchainSubscription, eq(schema.dunningState.onchainSubId, onchainSchema.onchainSubscription.onchainSubId))
    .where(and(ne(onchainSchema.onchainSubscription.status, "past_due"), eq(onchainSchema.onchainSubscription.chainId, chainId)));

  for (const row of recovered) {
    await db.delete(schema.dunningState).where(eq(schema.dunningState.onchainSubId, row.onchainSubId));
    console.log(`dunning: subscription_renewed subId=${row.onchainSubId}`);
  }
}

async function advanceOrExhaustRepeatFailures(db: DbClient, chainId: number): Promise<void> {
  const dueForRetryCheck = await db
    .select({ dunning: schema.dunningState, sub: onchainSchema.onchainSubscription })
    .from(schema.dunningState)
    .innerJoin(onchainSchema.onchainSubscription, eq(schema.dunningState.onchainSubId, onchainSchema.onchainSubscription.onchainSubId))
    .where(
      and(
        eq(schema.dunningState.exhausted, false),
        lte(schema.dunningState.nextRetryAt, new Date()),
        eq(onchainSchema.onchainSubscription.status, "past_due"),
        eq(onchainSchema.onchainSubscription.chainId, chainId),
      ),
    );

  for (const { dunning } of dueForRetryCheck) {
    const ladder = dunning.ladder as string[];
    if (dunning.attempt < ladder.length) {
      const nextAttempt = dunning.attempt + 1;
      const nextRetryAt = new Date(Date.now() + parseDuration(ladder[nextAttempt - 1]));
      await db
        .update(schema.dunningState)
        .set({ attempt: nextAttempt, nextRetryAt, updatedAt: new Date() })
        .where(eq(schema.dunningState.onchainSubId, dunning.onchainSubId));
      console.log(`dunning: payment_failed (retry ${nextAttempt}) subId=${dunning.onchainSubId} next_retry_at=${nextRetryAt.toISOString()}`);
    } else {
      await db
        .update(schema.dunningState)
        .set({ exhausted: true, updatedAt: new Date() })
        .where(eq(schema.dunningState.onchainSubId, dunning.onchainSubId));
      console.log(`dunning: exhausted subId=${dunning.onchainSubId} — on-chain status remains past_due pending subscriber cancellation`);
    }
  }
}
```

Note the ladder indexing: `attempt: 1` was created using `ladder[0]` (Step "createRowsForNewFailures" above). When advancing from `attempt=1` to `attempt=2`, the NEXT retry delay is `ladder[1]` (the second element) — `advanceOrExhaustRepeatFailures` computes this as `ladder[nextAttempt - 1]` where `nextAttempt = dunning.attempt + 1`, i.e. `ladder[(dunning.attempt + 1) - 1] = ladder[dunning.attempt]`. Trace through with `ladder = ["1d","3d","5d","7d"]` (length 4): starting at `attempt=1`, first check has `dunning.attempt=1 < 4`, so `nextAttempt=2`, uses `ladder[1]="3d"` — correct, this is the SECOND element for the SECOND attempt. Continuing: `attempt=2→3` uses `ladder[2]="5d"`; `attempt=3→4` uses `ladder[3]="7d"`; `attempt=4`, check is `4 < 4` which is false, so this row is marked exhausted instead of advancing to a nonexistent `ladder[4]`. This matches the test's "marks a row exhausted once attempt reaches the ladder's length" case exactly (seeded at `attempt: 4`, immediately exhausted on the next reconciliation pass).

`isNull` is imported but unused in this file as written — remove it from the import line if your editor/linter flags it (it was included as a placeholder during drafting and is not needed since `notInArray`'s ternary-guarded call handles the empty-set case without needing an `IS NULL` check).

- [ ] **Step 4: Run the test again to verify it passes**

Run: `cd apps/worker && npx vitest run test/dunning.test.ts`
Expected: PASS (3 `parseDuration` tests + 7 `reconcileDunningState` tests = 10 total).

- [ ] **Step 5: Typecheck**

Run: `cd apps/worker && npx tsc --noEmit`
Expected: exit 0. If the unused `isNull` import causes a build warning (not necessarily a hard error depending on `tsconfig`'s strictness settings), remove it as noted in Step 3.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/dunning.ts apps/worker/test/dunning.test.ts
git commit -m "Add dunning reconciliation: create/delete/advance/exhaust retry state"
```

---

### Task 3: Due-query gate + scheduler wiring

**Files:**
- Modify: `apps/worker/src/due-query.ts`
- Modify: `apps/worker/src/queues.ts`
- Modify: `apps/worker/test/due-query.test.ts`

**Interfaces:**
- Consumes: `reconcileDunningState` (Task 2, `apps/worker/src/dunning.js`), `schema.dunningState` (Task 1, `@cadence/db`).
- Produces: no new exports — `findDueSubscriptions`'s signature is unchanged; only its internal query and `queues.ts`'s internal `scheduleDueCharges()` body change.

- [ ] **Step 1: Update the existing due-query test to reflect gated `past_due` behavior**

Read the current `apps/worker/test/due-query.test.ts` in full first. Replace the test named `"includes a past_due subscription unconditionally (no dunning gate exists yet)"` (currently around line 76) — this assertion is about to become false — with the following four tests, inserted in its place:

```typescript
  it("includes a past_due subscription with no dunning_state row yet", async () => {
    await seedPlanAndSub({ onchainSubId: "4", status: "past_due", currentPeriodEnd: new Date(Date.now() - 60_000) });

    const due = await findDueSubscriptions(db, { chainId: 84532, batchSize: 100 });
    expect(due.map((d) => d.onchainSubId)).toContain("4");
  });

  it("excludes a past_due subscription whose dunning_state.next_retry_at is in the future", async () => {
    await seedPlanAndSub({ onchainSubId: "4b", status: "past_due", currentPeriodEnd: new Date(Date.now() - 60_000) });
    await db.insert(schema.dunningState).values({
      onchainSubId: "4b",
      attempt: 1,
      nextRetryAt: new Date(Date.now() + 86_400_000),
      exhausted: false,
      ladder: ["1d", "3d", "5d", "7d"],
    });

    const due = await findDueSubscriptions(db, { chainId: 84532, batchSize: 100 });
    expect(due.map((d) => d.onchainSubId)).not.toContain("4b");
  });

  it("includes a past_due subscription whose dunning_state.next_retry_at has elapsed", async () => {
    await seedPlanAndSub({ onchainSubId: "4c", status: "past_due", currentPeriodEnd: new Date(Date.now() - 60_000) });
    await db.insert(schema.dunningState).values({
      onchainSubId: "4c",
      attempt: 1,
      nextRetryAt: new Date(Date.now() - 1000),
      exhausted: false,
      ladder: ["1d", "3d", "5d", "7d"],
    });

    const due = await findDueSubscriptions(db, { chainId: 84532, batchSize: 100 });
    expect(due.map((d) => d.onchainSubId)).toContain("4c");
  });

  it("excludes a past_due subscription whose dunning_state is exhausted, even if next_retry_at has elapsed", async () => {
    await seedPlanAndSub({ onchainSubId: "4d", status: "past_due", currentPeriodEnd: new Date(Date.now() - 60_000) });
    await db.insert(schema.dunningState).values({
      onchainSubId: "4d",
      attempt: 4,
      nextRetryAt: new Date(Date.now() - 1000),
      exhausted: true,
      ladder: ["1d", "3d", "5d", "7d"],
    });

    const due = await findDueSubscriptions(db, { chainId: 84532, batchSize: 100 });
    expect(due.map((d) => d.onchainSubId)).not.toContain("4d");
  });

  it("active and trialing subscriptions are unaffected by dunning_state presence", async () => {
    await seedPlanAndSub({ onchainSubId: "4e", status: "active", currentPeriodEnd: new Date(Date.now() - 60_000) });
    await db.insert(schema.dunningState).values({
      onchainSubId: "4e",
      attempt: 4,
      nextRetryAt: new Date(Date.now() + 86_400_000),
      exhausted: true,
      ladder: ["1d", "3d", "5d", "7d"],
    });

    const due = await findDueSubscriptions(db, { chainId: 84532, batchSize: 100 });
    expect(due.map((d) => d.onchainSubId)).toContain("4e");
  });
```

Add `import { schema } from "@cadence/db";` to the test file's existing `@cadence/db` import line (currently `import { createDbClient, onchainSchema, type DbClient } from "@cadence/db";` — change to `import { createDbClient, schema, onchainSchema, type DbClient } from "@cadence/db";`).

- [ ] **Step 2: Run the updated test file to verify the new/changed tests fail for the right reason**

Run: `cd apps/worker && npx vitest run test/due-query.test.ts`
Expected: the four new tests referencing `dunning_state` gating FAIL (the current `findDueSubscriptions` query has no such gate yet, so `past_due` subs are always returned regardless of `dunning_state`) — specifically, `"excludes a past_due subscription whose dunning_state.next_retry_at is in the future"` and `"excludes ... exhausted"` should fail (they'd incorrectly include the subscription); the other tests in the file should still pass unmodified.

- [ ] **Step 3: Update `apps/worker/src/due-query.ts`**

Read the current file first. Replace its query's `where` clause:

```typescript
import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { onchainSchema, schema } from "@cadence/db";
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
    .leftJoin(schema.dunningState, eq(onchainSchema.onchainSubscription.onchainSubId, schema.dunningState.onchainSubId))
    .where(
      and(
        lte(onchainSchema.onchainSubscription.currentPeriodEnd, new Date()),
        eq(onchainSchema.onchainSubscription.chainId, params.chainId),
        or(
          inArray(onchainSchema.onchainSubscription.status, ["active", "trialing"]),
          and(
            eq(onchainSchema.onchainSubscription.status, "past_due"),
            or(
              isNull(schema.dunningState.onchainSubId),
              and(lte(schema.dunningState.nextRetryAt, new Date()), eq(schema.dunningState.exhausted, false)),
            ),
          ),
        ),
      ),
    )
    .orderBy(asc(onchainSchema.onchainSubscription.currentPeriodEnd))
    .limit(params.batchSize);

  return rows;
}
```

Note the query now uses a `LEFT JOIN` (not an inner join) against `dunning_state`, since a `past_due` subscription with no `dunning_state` row yet must still be included — an inner join would silently exclude it. Also note this query selects columns only from `onchain_subscription` (not `dunning_state`), so the join doesn't change `DueSubscription`'s shape or `findDueSubscriptions`'s return type — no other caller of this function needs to change.

- [ ] **Step 4: Run the due-query test suite again to verify it passes**

Run: `cd apps/worker && npx vitest run test/due-query.test.ts`
Expected: PASS (all tests, including the 5 new/replaced ones — the file now has 10 tests total: the 5 unchanged original tests minus the one that was replaced, plus the 5 new ones — verify the exact count by counting `it(` blocks in your final file rather than trusting this arithmetic blindly).

- [ ] **Step 5: Wire `reconcileDunningState` into `queues.ts`'s `scheduleDueCharges()`**

Read the current `apps/worker/src/queues.ts` in full. Add an import and one call at the start of `scheduleDueCharges`:

```typescript
import { reconcileDunningState } from "./dunning.js";
```

(add alongside the existing imports at the top of the file)

```typescript
  async function scheduleDueCharges(): Promise<void> {
    await reconcileDunningState(db, config.chainId);
    const due = await findDueSubscriptions(db, { chainId: config.chainId, batchSize: 100 });
    for (const sub of due) {
      await chargeQueue.add(
        "charge",
        { subId: sub.onchainSubId, periodEnd: sub.currentPeriodEnd.toISOString(), chainId: config.chainId },
        { jobId: chargeJobId(sub.onchainSubId, sub.currentPeriodEnd) },
      );
    }
  }
```

This is the only change to `scheduleDueCharges` — everything else in `queues.ts` (the charge-queue Worker, the nonce manager, `submitCharge` call, lock acquire/release) is untouched by this phase.

- [ ] **Step 6: Typecheck**

Run: `cd apps/worker && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Run the FULL existing worker unit suite to confirm no regression**

Run: `cd apps/worker && npx vitest run`
Expected: all spec files pass — this now includes `config.test.ts` (3), `charge-lock.test.ts` (4), `nonce-manager.test.ts` (3), `due-query.test.ts` (10, per Step 4), `dunning.test.ts` (10, per Task 2 Step 4) = 30 tests across 5 files. Count the actual files/tests in your output rather than trusting this arithmetic.

- [ ] **Step 8: Run the e2e suite to confirm the charge-flow still works end-to-end with dunning wired in**

Run: `cd apps/worker && npx vitest run --config vitest.e2e.config.ts`
Expected: PASS (2/2, same as Phase 1e — this e2e test's two subscriptions are `active` status, not `past_due`, so `reconcileDunningState` should be a no-op for them; confirm the test still passes to prove the new reconciliation call doesn't break the existing happy-path charge flow).

- [ ] **Step 9: Commit**

```bash
git add apps/worker/src/due-query.ts apps/worker/src/queues.ts apps/worker/test/due-query.test.ts
git commit -m "Gate past_due retries on dunning_state.next_retry_at"
```

---

## Plan Self-Review Notes

**Spec coverage check:**
- `dunning_state` table (with an added explicit `exhausted` boolean per the spec's own justification) → Task 1. ✓
- Reconciliation: create on new failure using the plan's ladder (or default) → Task 2's `createRowsForNewFailures`. ✓
- Reconciliation: delete on recovery → Task 2's `deleteRowsForRecoveredSubscriptions`. ✓
- Reconciliation: advance attempt/next_retry_at on repeat failure → Task 2's `advanceOrExhaustRepeatFailures`. ✓
- Reconciliation: mark exhausted once ladder is exhausted, no further advancement → Task 2's `advanceOrExhaustRepeatFailures`, tested explicitly (two consecutive reconciliation calls, second call is a no-op). ✓
- Due-query gate: `past_due` only due if no `dunning_state` row OR (`next_retry_at<=now()` AND not exhausted); `active`/`trialing` unaffected → Task 3. ✓
- Ladder-exhausted subscriptions never force-cancelled on-chain (confirmed architectural gap) → explicitly called out in Global Constraints; no task attempts an on-chain cancel call. ✓
- Log-only notifications (no real email) → Task 2's `console.log` calls at every transition; no email SDK/dependency added anywhere in this plan. ✓
- No webhook delivery → no webhook code anywhere in this plan. ✓
- `apps/indexer` untouched → no task modifies any file under `apps/indexer/`. ✓
- The already-shipped Phase 1e test that asserted the OLD "unconditional past_due retry" behavior is explicitly identified and replaced (Task 3, Step 1) rather than silently left contradicting the new behavior. ✓

**Placeholder scan:** No TBD/TODO markers. One inline note in Task 2 flags a drafting leftover (`isNull` unused import) with an explicit instruction to remove it — this is a concrete, bounded correction, not a vague placeholder.

**Type consistency check:** `parseDuration(s: string): number` — used consistently in Task 2's `dunning.ts` and its own test. `reconcileDunningState(db: DbClient, chainId: number): Promise<void>` — signature matches between its Task 2 definition and its Task 3 call site in `queues.ts` (`reconcileDunningState(db, config.chainId)`). `dunningState` table's field names (`onchainSubId`, `attempt`, `nextRetryAt`, `exhausted`, `ladder`) are used consistently across Task 1's schema, Task 2's reconciliation logic and tests, and Task 3's due-query join and tests — no naming drift found (e.g., no `dunning_state.subId` vs `dunning_state.onchainSubId` mismatch).

No gaps found requiring an additional task.

**Fixed during self-review:** Task 3's `due-query.ts` import list originally included an unused `gt` import (a leftover from drafting, mirroring the `isNull`-in-`dunning.ts` mistake but not flagged inline at the time) — removed. Confirmed `isNull` in this same file IS genuinely used (the `LEFT JOIN` null-check for "no `dunning_state` row yet"), unlike `dunning.ts`'s `isNull`, which is genuinely unused there and is correctly flagged inline in Task 2 for the implementer to remove.
