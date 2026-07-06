# Phase 1g — Webhooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver HMAC-signed webhook notifications to merchant-registered endpoints for the two real business transitions this codebase already produces (successful charges, dunning failures/retries), with retry backoff, a replay endpoint, and a full CRUD API for managing webhook endpoints.

**Architecture:** Three new `packages/db` tables (`event`, `webhook_endpoint`, `webhook_delivery`). A shared AES-256-GCM encryption helper in `@cadence/shared` (used by both `apps/api` to encrypt on creation and `apps/worker` to decrypt at delivery time). An `emitEvent` helper in `apps/worker`, called at the existing charge-success and dunning-failure/retry sites, which writes an `event` row and enqueues one `webhook-queue` job per matching enabled endpoint. A new BullMQ Worker (in the same `apps/worker` process, alongside the existing `charge-queue` Worker) delivers each job via HTTP POST with HMAC signing and the PRD's fixed retry ladder. `apps/api` gets secret-key-only CRUD for `webhook_endpoint` and read/replay for `webhook_delivery`.

**Tech Stack:** Drizzle ORM, Node's built-in `crypto` module (AES-256-GCM — no new dependency), BullMQ (already in `apps/worker`), `nestjs-zod` (already in `apps/api`), Vitest + Testcontainers Postgres.

## Global Constraints

- `event.type` is a `text` column, not a Postgres enum — only `"subscription.renewed"` and `"subscription.payment_failed"` are populated this phase (see spec's Data Model rationale — a two-value enum for a set that grows every future phase is premature).
- `emitEvent` is additive — it does NOT replace the existing `console.log` calls in `apps/worker/src/queues.ts`/`dunning.ts`; both remain.
- `subscription.renewed` is emitted from EXACTLY ONE call site: `apps/worker/src/queues.ts`'s successful-charge path in `processChargeJob`. It is NOT emitted from `apps/worker/src/dunning.ts`'s `deleteRowsForRecoveredSubscriptions` (which has its own pre-existing, unrelated `console.log` for recovery detection — leave that log line exactly as-is, do not add an `emitEvent` call there, or a recovering subscription's single successful charge would produce two duplicate `subscription.renewed` events instead of one).
- `subscription.payment_failed` is emitted from BOTH of `apps/worker/src/dunning.ts`'s existing `console.log("dunning: payment_failed...")` sites: `createRowsForNewFailures` (first failure) and `advanceOrExhaustRepeatFailures` (repeat failure/retry) — but NOT from the `exhausted` log site (no corresponding PRD event type; stays log-only per Phase 1f's own scope boundary).
- `webhook_endpoint.signing_secret` is NEVER stored or returned in plaintext after creation. Encrypted via AES-256-GCM using `WEBHOOK_SIGNING_ROTATION_KEY`, decrypted only in-process at delivery time.
- All new `apps/api` routes (`webhook-endpoints`, `webhook-deliveries`) are secret-key-only (or session cookie) — no publishable-key access to any webhook-related route.
- The webhook-queue Worker lives in the existing `apps/worker` process — no new app/package.
- Retry backoff ladder is exactly `[0s, 1m, 5m, 30m, 2h, 5h, 10h, 24h]` (8 attempts), then `dead` — matching PRD §7.7 verbatim.
- `webhook_delivery`'s `UNIQUE (endpoint_id, event_id)` constraint makes delivery idempotent per (endpoint, event) pair — a replay re-enqueues the SAME row (incrementing `attempts`), never creates a duplicate.
- Numeric/text mismatches: none apply to this phase's new tables directly (all new FKs are UUID-to-UUID, matching `merchant`/`plan_meta`/`customer`'s existing pattern) — no `sql\`...::text\`` casts needed here, unlike phases that joined against the on-chain mirror tables.

---

## File Structure

**New files:**
- `packages/shared/src/index.ts` — barrel re-exporting the existing ABI (`subscriptionManagerAbi`) and the new `webhook-crypto.ts` exports, so `@cadence/shared`'s single `main` entry point continues to work for existing consumers (`apps/indexer`'s relative-path import, `apps/worker/src/charge-submitter.ts`'s `@cadence/shared` import) while gaining new exports.
- `packages/shared/src/webhook-crypto.ts` — `encryptSecret(plaintext: string, key: string): string`, `decryptSecret(ciphertext: string, key: string): string` (AES-256-GCM, Node's built-in `crypto`).
- `packages/shared/test/webhook-crypto.test.ts`.
- `apps/worker/src/events.ts` — `emitEvent(db, merchantId, type, data, options?): Promise<void>`.
- `apps/worker/test/events.test.ts`.
- `apps/worker/src/webhook-delivery.ts` — the webhook-queue Worker's processor: loads a delivery + endpoint, decrypts the secret, signs, POSTs, records the outcome, schedules the next retry or marks `dead`.
- `apps/api/src/webhooks/webhook-endpoints.dto.ts` — Zod schemas for create/patch.
- `apps/api/src/webhooks/webhook-endpoints.service.ts`
- `apps/api/src/webhooks/webhook-endpoints.controller.ts`
- `apps/api/src/webhooks/webhook-deliveries.service.ts`
- `apps/api/src/webhooks/webhook-deliveries.controller.ts`
- `apps/api/src/webhooks/webhooks.module.ts`
- `apps/api/test/webhook-endpoints.e2e-spec.ts`
- `apps/api/test/webhook-deliveries.e2e-spec.ts`

**Modified files:**
- `packages/db/src/schema.ts` — add `webhookStatus`/`deliveryStatus` enums, `event`, `webhookEndpoint`, `webhookDelivery` tables.
- `packages/shared/package.json` — `main`/`types` repointed at the new `src/index.ts` barrel instead of directly at `abis/SubscriptionManager.ts`; `tsconfig.json`/`tsconfig.build.json`'s `include` gains `"src/**/*.ts"`.
- `apps/worker/src/queues.ts` — add the `subscription.renewed` `emitEvent` call in `processChargeJob`; add the webhook-queue Queue/Worker creation alongside the existing charge-queue ones.
- `apps/worker/src/dunning.ts` — add the `subscription.payment_failed` `emitEvent` calls in `createRowsForNewFailures` and `advanceOrExhaustRepeatFailures`.
- `apps/worker/src/config.ts` — add `webhookSigningRotationKey` to `WorkerConfig`.
- `apps/worker/src/index.ts` — start the new webhook-queue Worker alongside the existing charge-queue Worker; include it in graceful shutdown.
- `apps/worker/.env.local.example` — document `WEBHOOK_SIGNING_ROTATION_KEY`.
- `apps/api/src/app.module.ts` — register `WebhooksModule`.
- `apps/api/.env.local.example` — document `WEBHOOK_SIGNING_ROTATION_KEY`.

---

### Task 1: `event`, `webhook_endpoint`, `webhook_delivery` tables (packages/db)

**Files:**
- Modify: `packages/db/src/schema.ts`
- Test: `packages/db/test/webhooks-schema.test.ts` (new)

**Interfaces:**
- Produces: `schema.webhookStatusEnum` (pgEnum: `"enabled" | "disabled"`), `schema.deliveryStatusEnum` (pgEnum: `"pending" | "succeeded" | "failed" | "dead"`), `schema.event` (uuid PK, merchantId uuid FK, type text, data jsonb, onchainTxHash text nullable, livemode boolean, createdAt), `schema.webhookEndpoint` (uuid PK, merchantId uuid FK, url text, signingSecret text, enabledEvents jsonb default `["*"]`, status webhookStatusEnum default 'enabled', livemode boolean, createdAt/updatedAt), `schema.webhookDelivery` (uuid PK, endpointId uuid FK to webhookEndpoint, eventId uuid FK to event, eventType text, payload jsonb, status deliveryStatusEnum default 'pending', attempts smallint default 0, nextAttemptAt timestamptz nullable, responseCode integer nullable, responseBody text nullable, createdAt/updatedAt, unique on (endpointId, eventId)). Consumed by every later task in this plan.

- [ ] **Step 1: Add the new enums and tables to `packages/db/src/schema.ts`**

Read the current file first — it already imports `pgTable, pgEnum, uuid, text, boolean, timestamp, unique, index, jsonb, numeric, smallint` from `drizzle-orm/pg-core` and `sql` from `drizzle-orm`. Add `integer` to the `drizzle-orm/pg-core` import line (not currently imported in this file — used for `response_code`).

Add after `dunningState`:

```typescript
export const webhookStatusEnum = pgEnum("webhook_status", ["enabled", "disabled"]);
export const deliveryStatusEnum = pgEnum("delivery_status", ["pending", "succeeded", "failed", "dead"]);

export const event = pgTable(
  "event",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    merchantId: uuid("merchant_id").notNull().references(() => merchant.id),
    type: text("type").notNull(),
    data: jsonb("data").notNull(),
    onchainTxHash: text("onchain_tx_hash"),
    livemode: boolean("livemode").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("event_merchant_id_created_at_idx").on(table.merchantId, table.createdAt),
    index("event_type_idx").on(table.type),
  ],
);

export const webhookEndpoint = pgTable(
  "webhook_endpoint",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    merchantId: uuid("merchant_id").notNull().references(() => merchant.id),
    url: text("url").notNull(),
    signingSecret: text("signing_secret").notNull(),
    enabledEvents: jsonb("enabled_events").notNull().default(sql`'["*"]'::jsonb`),
    status: webhookStatusEnum("status").notNull().default("enabled"),
    livemode: boolean("livemode").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("webhook_endpoint_merchant_id_idx").on(table.merchantId)],
);

export const webhookDelivery = pgTable(
  "webhook_delivery",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    endpointId: uuid("endpoint_id").notNull().references(() => webhookEndpoint.id),
    eventId: uuid("event_id").notNull().references(() => event.id),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    status: deliveryStatusEnum("status").notNull().default("pending"),
    attempts: smallint("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    responseCode: integer("response_code"),
    responseBody: text("response_body"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("webhook_delivery_endpoint_id_event_id_unique").on(table.endpointId, table.eventId),
    index("webhook_delivery_status_next_attempt_at_idx").on(table.status, table.nextAttemptAt),
  ],
);
```

- [ ] **Step 2: Generate and inspect the migration**

Run: `cd packages/db && npx drizzle-kit generate --name add_webhooks`
Expected: a new file under `packages/db/migrations/`, e.g. `0004_<name>.sql`, containing the two enum `CREATE TYPE` statements and three `CREATE TABLE` statements (`event`, `webhook_endpoint`, `webhook_delivery`), plus FK constraints from `event.merchant_id`/`webhook_endpoint.merchant_id` to `merchant.id`, and from `webhook_delivery.endpoint_id`/`webhook_delivery.event_id` to `webhook_endpoint.id`/`event.id`. No other table touched.

- [ ] **Step 3: Write a test proving the tables work together**

Create `packages/db/test/webhooks-schema.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type DbClient } from "../src/client.js";

describe("webhooks schema", () => {
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

  async function seedMerchant() {
    const [row] = await db
      .insert(schema.merchant)
      .values({ name: "Webhook Test Co", ownerAddress: `0x${Date.now().toString(16).padStart(40, "0")}` })
      .returning();
    return row;
  }

  it("inserts an event row", async () => {
    const merchant = await seedMerchant();
    const [row] = await db
      .insert(schema.event)
      .values({ merchantId: merchant.id, type: "subscription.renewed", data: { onchain_sub_id: "1" }, livemode: false })
      .returning();

    expect(row.type).toBe("subscription.renewed");
    expect(row.data).toEqual({ onchain_sub_id: "1" });
  });

  it("inserts a webhook_endpoint row with defaults applied", async () => {
    const merchant = await seedMerchant();
    const [row] = await db
      .insert(schema.webhookEndpoint)
      .values({ merchantId: merchant.id, url: "https://example.com/hook", signingSecret: "ciphertext", livemode: false })
      .returning();

    expect(row.enabledEvents).toEqual(["*"]);
    expect(row.status).toBe("enabled");
  });

  it("inserts a webhook_delivery row and enforces uniqueness on (endpoint_id, event_id)", async () => {
    const merchant = await seedMerchant();
    const [endpoint] = await db
      .insert(schema.webhookEndpoint)
      .values({ merchantId: merchant.id, url: "https://example.com/hook", signingSecret: "ciphertext", livemode: false })
      .returning();
    const [evt] = await db
      .insert(schema.event)
      .values({ merchantId: merchant.id, type: "subscription.renewed", data: {}, livemode: false })
      .returning();

    await db.insert(schema.webhookDelivery).values({
      endpointId: endpoint.id,
      eventId: evt.id,
      eventType: "subscription.renewed",
      payload: { id: "evt_1" },
    });

    await expect(
      db.insert(schema.webhookDelivery).values({
        endpointId: endpoint.id,
        eventId: evt.id,
        eventType: "subscription.renewed",
        payload: { id: "evt_1" },
      }),
    ).rejects.toThrow();
  });

  it("allows updating webhook_delivery status/attempts", async () => {
    const merchant = await seedMerchant();
    const [endpoint] = await db
      .insert(schema.webhookEndpoint)
      .values({ merchantId: merchant.id, url: "https://example.com/hook", signingSecret: "ciphertext", livemode: false })
      .returning();
    const [evt] = await db
      .insert(schema.event)
      .values({ merchantId: merchant.id, type: "subscription.payment_failed", data: {}, livemode: false })
      .returning();
    const [delivery] = await db
      .insert(schema.webhookDelivery)
      .values({ endpointId: endpoint.id, eventId: evt.id, eventType: "subscription.payment_failed", payload: {} })
      .returning();

    await db
      .update(schema.webhookDelivery)
      .set({ status: "succeeded", attempts: 1, responseCode: 200, updatedAt: new Date() })
      .where(eq(schema.webhookDelivery.id, delivery.id));

    const [row] = await db.select().from(schema.webhookDelivery).where(eq(schema.webhookDelivery.id, delivery.id));
    expect(row.status).toBe("succeeded");
    expect(row.attempts).toBe(1);
    expect(row.responseCode).toBe(200);
  });
});
```

- [ ] **Step 4: Run the test**

Run: `cd packages/db && npx vitest run test/webhooks-schema.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Rebuild and typecheck**

Run: `cd packages/db && npm run build && npm run typecheck`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/migrations packages/db/test/webhooks-schema.test.ts
git commit -m "Add event, webhook_endpoint, and webhook_delivery tables"
```

---

### Task 2: Shared AES-256-GCM encryption helper (`@cadence/shared`)

**Files:**
- Modify: `packages/shared/package.json`
- Modify: `packages/shared/tsconfig.json`
- Modify: `packages/shared/tsconfig.build.json`
- Create: `packages/shared/src/webhook-crypto.ts`
- Create: `packages/shared/src/index.ts`
- Test: `packages/shared/test/webhook-crypto.test.ts`

**Interfaces:**
- Produces: `encryptSecret(plaintext: string, key: string): string`, `decryptSecret(ciphertext: string, key: string): string`, both exported from `@cadence/shared`'s new `index.ts` barrel alongside the existing `subscriptionManagerAbi`. Consumed by Task 5 (`apps/api`'s webhook-endpoint creation) and Task 4 (`apps/worker`'s delivery processor).

- [ ] **Step 1: Read the current `packages/shared` structure**

Read `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/tsconfig.build.json` in full first — confirm their current `include`/`main`/`types` fields exactly (they currently only reference `abis/**/*.ts` and `./dist/SubscriptionManager.js`/`.d.ts`) before editing, since Task 4 of Phase 1e already touched this package once and you must not silently regress that prior change.

- [ ] **Step 2: Write the failing test**

Create `packages/shared/test/webhook-crypto.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { encryptSecret, decryptSecret } from "../src/webhook-crypto.js";

const TEST_KEY = "0123456789abcdef0123456789abcdef"; // 32 bytes as a utf-8 string, matching WEBHOOK_SIGNING_ROTATION_KEY's expected format

describe("webhook-crypto", () => {
  it("round-trips a secret through encrypt then decrypt", () => {
    const plaintext = "whsec_abcdefghijklmnopqrstuvwxyz0123456789";
    const ciphertext = encryptSecret(plaintext, TEST_KEY);
    expect(decryptSecret(ciphertext, TEST_KEY)).toBe(plaintext);
  });

  it("produces ciphertext that does not contain the plaintext", () => {
    const plaintext = "whsec_abcdefghijklmnopqrstuvwxyz0123456789";
    const ciphertext = encryptSecret(plaintext, TEST_KEY);
    expect(ciphertext).not.toContain(plaintext);
  });

  it("produces different ciphertext on each call for the same plaintext (random IV)", () => {
    const plaintext = "whsec_abcdefghijklmnopqrstuvwxyz0123456789";
    const a = encryptSecret(plaintext, TEST_KEY);
    const b = encryptSecret(plaintext, TEST_KEY);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, TEST_KEY)).toBe(plaintext);
    expect(decryptSecret(b, TEST_KEY)).toBe(plaintext);
  });

  it("throws when decrypting with the wrong key", () => {
    const plaintext = "whsec_abcdefghijklmnopqrstuvwxyz0123456789";
    const ciphertext = encryptSecret(plaintext, TEST_KEY);
    const wrongKey = "fedcba9876543210fedcba9876543210";
    expect(() => decryptSecret(ciphertext, wrongKey)).toThrow();
  });

  it("throws when decrypting tampered ciphertext", () => {
    const plaintext = "whsec_abcdefghijklmnopqrstuvwxyz0123456789";
    const ciphertext = encryptSecret(plaintext, TEST_KEY);
    const tampered = ciphertext.slice(0, -4) + "abcd";
    expect(() => decryptSecret(tampered, TEST_KEY)).toThrow();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd packages/shared && npx vitest run test/webhook-crypto.test.ts`
Expected: FAIL — `../src/webhook-crypto.js` does not exist yet, and `vitest`/`@testcontainers` aren't even installed as devDependencies in this package yet (this is the first task to add tests to `packages/shared` at all — check `packages/shared/package.json`'s current `devDependencies`, which currently only has `typescript`).

- [ ] **Step 4: Add `vitest` as a devDependency**

Add to `packages/shared/package.json`'s `devDependencies`: `"vitest": "^2.1.0"` (matching the exact version already pinned in `packages/db`/`apps/worker`/`apps/api`). Also add a `"test": "vitest run"` script to `packages/shared/package.json`'s `scripts`.

- [ ] **Step 5: Implement `packages/shared/src/webhook-crypto.ts`**

```typescript
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM's recommended nonce length
const SALT = "cadence-webhook-signing-secret"; // fixed salt: WEBHOOK_SIGNING_ROTATION_KEY is already a high-entropy secret managed out-of-band (KMS/env), not a user password — a fixed salt here is standard practice for key-derivation-from-a-secret (not key-derivation-from-a-password, which is what a random-per-use salt would defend against).

function deriveKey(key: string): Buffer {
  return scryptSync(key, SALT, 32);
}

export function encryptSecret(plaintext: string, key: string): string {
  const derivedKey = deriveKey(key);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, derivedKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptSecret(ciphertext: string, key: string): string {
  const derivedKey = deriveKey(key);
  const buf = Buffer.from(ciphertext, "base64");
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + 16);
  const encrypted = buf.subarray(IV_LENGTH + 16);
  const decipher = createDecipheriv(ALGORITHM, derivedKey, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}
```

`scryptSync` derives a proper 32-byte AES key from `WEBHOOK_SIGNING_ROTATION_KEY` regardless of that env var's actual string length (AES-256-GCM requires exactly a 32-byte key; the raw env var string might not be exactly 32 bytes) — this is why `TEST_KEY` in the test above being a specific 32-char string doesn't actually matter for correctness, `deriveKey` normalizes any input string to 32 bytes. `decipher.final()` is what throws on a bad auth tag (wrong key) or tampered ciphertext — this is GCM's built-in authenticated-encryption integrity check, not something this code implements manually.

- [ ] **Step 6: Create the barrel `packages/shared/src/index.ts`**

```typescript
export { subscriptionManagerAbi } from "../abis/SubscriptionManager.js";
export { encryptSecret, decryptSecret } from "./webhook-crypto.js";
```

- [ ] **Step 7: Update `packages/shared/package.json`, `tsconfig.json`, `tsconfig.build.json`**

In `package.json`, change `"main": "./dist/SubscriptionManager.js"` to `"main": "./dist/index.js"` and `"types": "./dist/SubscriptionManager.d.ts"` to `"types": "./dist/index.d.ts"`.

In both `tsconfig.json` and `tsconfig.build.json`, change `"include": ["abis/**/*.ts"]` to `"include": ["abis/**/*.ts", "src/**/*.ts"]`.

- [ ] **Step 8: Run the test again to verify it passes**

Run: `cd packages/shared && npx vitest run test/webhook-crypto.test.ts`
Expected: PASS (5/5 tests).

- [ ] **Step 9: Rebuild and confirm the existing ABI export still resolves**

Run: `cd packages/shared && npm run build`
Expected: exit 0, `dist/index.js` and `dist/SubscriptionManager.js` both exist (the barrel re-exports from the sibling compiled file, so both are needed).

Then confirm `apps/worker`'s existing `@cadence/shared` import (in `charge-submitter.ts`, added during Phase 1e) still resolves correctly after this package's `main` changed:

Run: `cd apps/worker && npx tsc --noEmit`
Expected: exit 0 — if this fails with a `subscriptionManagerAbi` resolution error, the barrel's re-export path is wrong; fix `index.ts`'s import path before proceeding (double-check the relative path from `packages/shared/src/index.ts` to `packages/shared/abis/SubscriptionManager.ts` is exactly `"../abis/SubscriptionManager.js"` — one level up from `src/`, then into `abis/`).

- [ ] **Step 10: Typecheck the shared package itself**

Run: `cd packages/shared && npm run typecheck`
Expected: exit 0.

- [ ] **Step 11: Commit**

```bash
git add packages/shared/package.json packages/shared/tsconfig.json packages/shared/tsconfig.build.json packages/shared/src packages/shared/test
git commit -m "Add AES-256-GCM webhook-secret encryption helper to @cadence/shared"
```

---

### Task 3: `emitEvent` + worker emission wiring

**Files:**
- Create: `apps/worker/src/events.ts`
- Modify: `apps/worker/src/queues.ts`
- Modify: `apps/worker/src/dunning.ts`
- Test: `apps/worker/test/events.test.ts`

**Interfaces:**
- Consumes: `schema.merchant`, `schema.event`, `schema.webhookEndpoint`, `schema.webhookDelivery` (Task 1, `@cadence/db`). Does NOT consume anything from Task 2 (encryption happens only at delivery time, Task 4) or the BullMQ queue object directly — `emitEvent` takes a `chargeQueue`-style enqueue callback as a parameter so it stays decoupled from BullMQ's own API surface (see below).
- Produces: `emitEvent(db: DbClient, params: { merchantId: string; type: string; data: object; onchainTxHash?: string }, enqueueDelivery: (deliveryId: string) => Promise<void>): Promise<void>`, consumed by Task 4's `queues.ts` wiring (which supplies the actual `webhookQueue.add(...)` callback).

- [ ] **Step 1: Write the failing test**

Create `apps/worker/test/events.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type DbClient } from "@cadence/db";
import { emitEvent } from "../src/events.js";

describe("emitEvent", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16").withDatabase("cadence_test").start();
    const url = container.getConnectionUri();
    const dbCwd = path.resolve(__dirname, "../../../packages/db");
    execSync("npx drizzle-kit migrate", { cwd: dbCwd, env: { ...process.env, DATABASE_URL: url }, stdio: "inherit" });
    db = createDbClient(url);
  }, 60_000);

  afterAll(async () => {
    await (db as DbClient & { $client: { end(): Promise<void> } }).$client.end();
    await container.stop();
  });

  async function seedMerchant(overrides: Partial<typeof schema.merchant.$inferInsert> = {}) {
    const [row] = await db
      .insert(schema.merchant)
      .values({ name: "Events Test Co", ownerAddress: `0x${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.padEnd(42, "0").slice(0, 42), livemode: false, ...overrides })
      .returning();
    return row;
  }

  it("inserts an event row with the given type and data", async () => {
    const merchant = await seedMerchant();
    const enqueueDelivery = vi.fn();

    await emitEvent(db, { merchantId: merchant.id, type: "subscription.renewed", data: { onchain_sub_id: "1" } }, enqueueDelivery);

    const rows = await db.select().from(schema.event).where(eq(schema.event.merchantId, merchant.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("subscription.renewed");
    expect(rows[0].data).toEqual({ onchain_sub_id: "1" });
    expect(rows[0].livemode).toBe(merchant.livemode);
  });

  it("does not enqueue any delivery when the merchant has no webhook endpoints", async () => {
    const merchant = await seedMerchant();
    const enqueueDelivery = vi.fn();

    await emitEvent(db, { merchantId: merchant.id, type: "subscription.renewed", data: {} }, enqueueDelivery);

    expect(enqueueDelivery).not.toHaveBeenCalled();
  });

  it("enqueues a delivery for an enabled endpoint whose enabled_events includes the wildcard", async () => {
    const merchant = await seedMerchant();
    await db.insert(schema.webhookEndpoint).values({
      merchantId: merchant.id,
      url: "https://example.com/hook",
      signingSecret: "ciphertext",
      enabledEvents: ["*"],
      status: "enabled",
      livemode: false,
    });
    const enqueueDelivery = vi.fn();

    await emitEvent(db, { merchantId: merchant.id, type: "subscription.renewed", data: {} }, enqueueDelivery);

    expect(enqueueDelivery).toHaveBeenCalledTimes(1);
    const deliveries = await db.select().from(schema.webhookDelivery);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe("pending");
    expect(deliveries[0].attempts).toBe(0);
  });

  it("enqueues a delivery for an endpoint whose enabled_events includes the specific type", async () => {
    const merchant = await seedMerchant();
    await db.insert(schema.webhookEndpoint).values({
      merchantId: merchant.id,
      url: "https://example.com/hook",
      signingSecret: "ciphertext",
      enabledEvents: ["subscription.payment_failed"],
      status: "enabled",
      livemode: false,
    });
    const enqueueDelivery = vi.fn();

    await emitEvent(db, { merchantId: merchant.id, type: "subscription.payment_failed", data: {} }, enqueueDelivery);

    expect(enqueueDelivery).toHaveBeenCalledTimes(1);
  });

  it("does not enqueue a delivery for an endpoint whose enabled_events excludes the type", async () => {
    const merchant = await seedMerchant();
    await db.insert(schema.webhookEndpoint).values({
      merchantId: merchant.id,
      url: "https://example.com/hook",
      signingSecret: "ciphertext",
      enabledEvents: ["subscription.payment_failed"],
      status: "enabled",
      livemode: false,
    });
    const enqueueDelivery = vi.fn();

    await emitEvent(db, { merchantId: merchant.id, type: "subscription.renewed", data: {} }, enqueueDelivery);

    expect(enqueueDelivery).not.toHaveBeenCalled();
  });

  it("does not enqueue a delivery for a disabled endpoint even if enabled_events matches", async () => {
    const merchant = await seedMerchant();
    await db.insert(schema.webhookEndpoint).values({
      merchantId: merchant.id,
      url: "https://example.com/hook",
      signingSecret: "ciphertext",
      enabledEvents: ["*"],
      status: "disabled",
      livemode: false,
    });
    const enqueueDelivery = vi.fn();

    await emitEvent(db, { merchantId: merchant.id, type: "subscription.renewed", data: {} }, enqueueDelivery);

    expect(enqueueDelivery).not.toHaveBeenCalled();
  });

  it("enqueues one delivery per matching endpoint when a merchant has multiple", async () => {
    const merchant = await seedMerchant();
    await db.insert(schema.webhookEndpoint).values([
      { merchantId: merchant.id, url: "https://example.com/hook1", signingSecret: "a", enabledEvents: ["*"], status: "enabled", livemode: false },
      { merchantId: merchant.id, url: "https://example.com/hook2", signingSecret: "b", enabledEvents: ["*"], status: "enabled", livemode: false },
    ]);
    const enqueueDelivery = vi.fn();

    await emitEvent(db, { merchantId: merchant.id, type: "subscription.renewed", data: {} }, enqueueDelivery);

    expect(enqueueDelivery).toHaveBeenCalledTimes(2);
  });

  it("stores onchainTxHash on the event row when provided", async () => {
    const merchant = await seedMerchant();
    await emitEvent(db, { merchantId: merchant.id, type: "subscription.renewed", data: {}, onchainTxHash: "0xabc" }, vi.fn());

    const [row] = await db.select().from(schema.event).where(eq(schema.event.merchantId, merchant.id));
    expect(row.onchainTxHash).toBe("0xabc");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/worker && npx vitest run test/events.test.ts`
Expected: FAIL — `../src/events.js` does not exist yet.

- [ ] **Step 3: Implement `apps/worker/src/events.ts`**

```typescript
import { and, eq } from "drizzle-orm";
import { schema } from "@cadence/db";
import type { DbClient } from "@cadence/db";

export interface EmitEventParams {
  merchantId: string;
  type: string;
  data: object;
  onchainTxHash?: string;
}

export async function emitEvent(
  db: DbClient,
  params: EmitEventParams,
  enqueueDelivery: (deliveryId: string) => Promise<void>,
): Promise<void> {
  const [merchant] = await db.select().from(schema.merchant).where(eq(schema.merchant.id, params.merchantId));
  if (!merchant) {
    throw new Error(`emitEvent: no merchant found for id ${params.merchantId}`);
  }

  const [evt] = await db
    .insert(schema.event)
    .values({
      merchantId: params.merchantId,
      type: params.type,
      data: params.data,
      onchainTxHash: params.onchainTxHash,
      livemode: merchant.livemode,
    })
    .returning();

  const endpoints = await db
    .select()
    .from(schema.webhookEndpoint)
    .where(and(eq(schema.webhookEndpoint.merchantId, params.merchantId), eq(schema.webhookEndpoint.status, "enabled")));

  const matching = endpoints.filter((endpoint) => {
    const enabledEvents = endpoint.enabledEvents as string[];
    return enabledEvents.includes("*") || enabledEvents.includes(params.type);
  });

  for (const endpoint of matching) {
    const payload = { id: `evt_${evt.id}`, type: evt.type, created: evt.createdAt.toISOString(), livemode: evt.livemode, data: evt.data };
    const [delivery] = await db
      .insert(schema.webhookDelivery)
      .values({ endpointId: endpoint.id, eventId: evt.id, eventType: params.type, payload })
      .returning();
    await enqueueDelivery(delivery.id);
  }
}
```

Note `emitEvent` takes `enqueueDelivery` as a callback parameter rather than importing/constructing a BullMQ `Queue` internally — this keeps `events.ts` free of any BullMQ dependency, matching this file's narrow responsibility (event/delivery-row bookkeeping only), and makes the function trivially testable with a plain `vi.fn()` mock rather than needing a real or mocked Redis connection for this task's tests. Task 4 wires the real `webhookQueue.add(...)` call as the callback passed at the actual call sites.

- [ ] **Step 4: Run the test again to verify it passes**

Run: `cd apps/worker && npx vitest run test/events.test.ts`
Expected: PASS (8/8 tests).

- [ ] **Step 5: Wire `emitEvent` into `apps/worker/src/queues.ts`'s successful-charge path**

Read the current `apps/worker/src/queues.ts` in full — this task's wiring here is intentionally minimal; the FULL webhook-queue Worker itself (creating the Queue, starting the Worker, actually delivering) is Task 4's job. This task only adds the `emitEvent` CALL — using a placeholder `enqueueDelivery` callback that Task 4 will replace with a real one.

Add an import: `import { emitEvent } from "./events.js";` and `import { onchainSchema } from "@cadence/db";` if not already imported (check — `queues.ts` currently imports only `type DbClient` from `@cadence/db`, not `onchainSchema` or `schema`; add both).

Modify `processChargeJob`'s success path:

```typescript
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

      const [sub] = await db.select().from(onchainSchema.onchainSubscription).where(eq(onchainSchema.onchainSubscription.onchainSubId, job.data.subId));
      if (sub) {
        const [plan] = await db.select().from(onchainSchema.onchainPlan).where(eq(onchainSchema.onchainPlan.onchainPlanId, sub.onchainPlanId));
        if (plan) {
          const [merchant] = await db.select().from(schema.merchant).where(and(eq(schema.merchant.ownerAddress, plan.merchantAddress), eq(schema.merchant.livemode, false)));
          if (merchant) {
            await emitEvent(
              db,
              { merchantId: merchant.id, type: "subscription.renewed", data: { onchain_sub_id: job.data.subId, tx_hash: txHash }, onchainTxHash: txHash },
              async (deliveryId) => {
                await webhookQueue.add("deliver", { deliveryId }, { jobId: deliveryId });
              },
            );
          }
        }
      }
    } finally {
      await releaseChargeLock(redis, job.data.subId, periodEnd);
    }
  }
```

This references `webhookQueue`, which does not exist yet in this file at this point in the plan — Task 4 creates it. Add `import { and, eq } from "drizzle-orm";` to this file's imports (not currently imported — `queues.ts` currently has no drizzle-orm import at all, since `findDueSubscriptions`/`acquireChargeLock`/etc. handle their own queries internally).

- [ ] **Step 6: Wire `emitEvent` into `apps/worker/src/dunning.ts`'s two failure/retry sites**

Read the current `apps/worker/src/dunning.ts` in full. In `createRowsForNewFailures`, right after the existing `console.log("dunning: payment_failed subId=...")` line (inside the `for (const sub of newlyFailed)` loop, where `plan` is already fetched):

```typescript
    const [merchant] = await db
      .select()
      .from(schema.merchant)
      .where(and(eq(schema.merchant.ownerAddress, plan?.merchantAddress ?? ""), eq(schema.merchant.livemode, false)));
    if (merchant) {
      await emitEvent(
        db,
        { merchantId: merchant.id, type: "subscription.payment_failed", data: { onchain_sub_id: sub.onchainSubId, attempt: 1 } },
        async (deliveryId) => {
          await enqueueWebhookDelivery(deliveryId);
        },
      );
    }
```

In `advanceOrExhaustRepeatFailures`, the `if (dunning.attempt < ladder.length)` branch (the retry case, NOT the `else` exhausted case) needs its OWN new `onchain_plan` fetch first, since this function currently never queries `onchain_plan` at all — read the function's current code to confirm this, then add, right after the existing `console.log("dunning: payment_failed (retry...")` line:

```typescript
      const [plan] = await db.select().from(onchainSchema.onchainPlan).where(eq(onchainSchema.onchainPlan.onchainPlanId, sub.onchainPlanId));
      const [merchant] = await db
        .select()
        .from(schema.merchant)
        .where(and(eq(schema.merchant.ownerAddress, plan?.merchantAddress ?? ""), eq(schema.merchant.livemode, false)));
      if (merchant) {
        await emitEvent(
          db,
          { merchantId: merchant.id, type: "subscription.payment_failed", data: { onchain_sub_id: dunning.onchainSubId, attempt: nextAttempt } },
          async (deliveryId) => {
            await enqueueWebhookDelivery(deliveryId);
          },
        );
      }
```

`sub` here refers to the joined `onchain_subscription` row already available in `dueForRetryCheck`'s destructured `{ dunning, sub }` — read the surrounding loop code to confirm `sub` is in scope at this point (it should be, from the `for (const { dunning, sub } of dueForRetryCheck)` line — but the CURRENT code only destructures `{ dunning }`, not `{ dunning, sub }` — you must change the destructuring to include `sub` too, since it's needed for `sub.onchainPlanId` here).

This introduces a new module-level dependency: `enqueueWebhookDelivery`, a function `dunning.ts` doesn't currently have any way to call (it has no Queue instance). Since `reconcileDunningState`'s signature is `(db, chainId)` and is called from `queues.ts`, the cleanest fix — done in Task 4, not this task — is to change `reconcileDunningState`'s signature to accept a third parameter, `enqueueWebhookDelivery: (deliveryId: string) => Promise<void>`, threaded through from `createRowsForNewFailures`/`advanceOrExhaustRepeatFailures`'s own signatures too. Add this parameter to all three functions' signatures now (in this task), even though the real callback is only supplied starting in Task 4 — this task's own tests (Task 2's dunning tests, already passing, unaffected — see Step 7 below) pass a `vi.fn()` no-op for this new parameter, proving the plumbing compiles and doesn't break Task 1f's existing dunning tests.

- [ ] **Step 7: Update `apps/worker/src/dunning.ts`'s exported signatures and update its existing test file's call sites**

`reconcileDunningState`, `createRowsForNewFailures`, `advanceOrExhaustRepeatFailures` all gain a third parameter: `enqueueWebhookDelivery: (deliveryId: string) => Promise<void>`. Update `apps/worker/test/dunning.test.ts`'s existing 11 calls to `reconcileDunningState(db, 84532)` to `reconcileDunningState(db, 84532, async () => {})` (a no-op callback — Task 1f's own tests don't assert anything about webhook delivery, they only test the retry-state machine itself, so a no-op is correct and sufficient here). Also update `apps/worker/src/queues.ts`'s own call site, `await reconcileDunningState(db, config.chainId);`, to pass a third argument — for THIS task, pass `async () => {}` as a placeholder (Task 4 replaces it with the real `webhookQueue.add(...)` callback, matching the same pattern as Step 5 above).

- [ ] **Step 8: Typecheck**

Run: `cd apps/worker && npx tsc --noEmit`
Expected: exit 0. This will NOT yet compile cleanly if Step 5's reference to `webhookQueue` has no declaration in scope — since `webhookQueue` is genuinely not created until Task 4, add a temporary local `const webhookQueue = { add: async (..._args: unknown[]) => {} };` stub directly in `queues.ts`'s `createQueues` function body for THIS task only, with a comment `// TODO(Task 4): replace with the real webhook-queue Queue instance`. This is the one deliberate, temporary, clearly-marked placeholder in this entire plan — it exists only because Task 3 and Task 4 are artificially split for reviewability, and Task 4 removes it in its own Step 1.

- [ ] **Step 9: Run the full existing worker unit suite to confirm no regression**

Run: `cd apps/worker && npx vitest run`
Expected: all 6 spec files pass (config 3, charge-lock 4, nonce-manager 3, due-query 10, dunning 11, events 8 = 39 tests total — verify the actual count in your output).

- [ ] **Step 10: Commit**

```bash
git add apps/worker/src/events.ts apps/worker/src/queues.ts apps/worker/src/dunning.ts apps/worker/test/events.test.ts apps/worker/test/dunning.test.ts
git commit -m "Add emitEvent and wire it into charge-success and dunning-failure paths"
```

---

### Task 4: Webhook-queue delivery Worker

**Files:**
- Create: `apps/worker/src/webhook-delivery.ts`
- Modify: `apps/worker/src/queues.ts` (remove Task 3's temporary stub; add the real webhook-queue Queue/Worker)
- Modify: `apps/worker/src/config.ts`
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/worker/.env.local.example`

**Interfaces:**
- Consumes: `encryptSecret`/`decryptSecret` (Task 2, `@cadence/shared`), `schema.webhookDelivery`/`schema.webhookEndpoint` (Task 1, `@cadence/db`).
- Produces: `deliverWebhook(db: DbClient, deliveryId: string, webhookSigningRotationKey: string): Promise<void>`, called by the webhook-queue Worker's processor in `queues.ts`.

- [ ] **Step 1: Implement `apps/worker/src/webhook-delivery.ts`**

No isolated unit test for this file's actual HTTP POST — real network calls in a unit test are flaky and slow; this is tested via the e2e-style local-HTTP-server approach in Step 5's test, using Node's own `http` module to spin up a real (but local, in-process) server rather than mocking `fetch` entirely, so the signature/header logic is genuinely exercised end-to-end.

```typescript
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@cadence/db";
import { decryptSecret } from "@cadence/shared";
import type { DbClient } from "@cadence/db";

const RETRY_LADDER_MS = [0, 60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 5 * 3_600_000, 10 * 3_600_000, 24 * 3_600_000];

export async function deliverWebhook(db: DbClient, deliveryId: string, webhookSigningRotationKey: string): Promise<void> {
  const [delivery] = await db.select().from(schema.webhookDelivery).where(eq(schema.webhookDelivery.id, deliveryId));
  if (!delivery) return; // Deleted or never created — nothing to do.

  const [endpoint] = await db.select().from(schema.webhookEndpoint).where(eq(schema.webhookEndpoint.id, delivery.endpointId));
  if (!endpoint || endpoint.status !== "enabled") {
    await db.update(schema.webhookDelivery).set({ status: "failed", updatedAt: new Date() }).where(eq(schema.webhookDelivery.id, deliveryId));
    return;
  }

  const rawBody = JSON.stringify(delivery.payload);
  const t = Math.floor(Date.now() / 1000);
  const signingSecret = decryptSecret(endpoint.signingSecret, webhookSigningRotationKey);
  const sig = createHmac("sha256", signingSecret).update(`${t}.${rawBody}`).digest("hex");

  let responseCode: number | null = null;
  let responseBody: string | null = null;
  let succeeded = false;

  try {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cadence-Signature": `t=${t},v1=${sig}`,
        "Cadence-Event-Id": (delivery.payload as { id: string }).id,
      },
      body: rawBody,
      signal: AbortSignal.timeout(10_000),
    });
    responseCode = response.status;
    responseBody = (await response.text()).slice(0, 2000); // cap stored body size
    succeeded = response.status >= 200 && response.status < 300;
  } catch {
    responseCode = null;
    responseBody = "request failed (network error or timeout)";
    succeeded = false;
  }

  const attempts = delivery.attempts + 1;

  if (succeeded) {
    await db
      .update(schema.webhookDelivery)
      .set({ status: "succeeded", attempts, responseCode, responseBody, updatedAt: new Date() })
      .where(eq(schema.webhookDelivery.id, deliveryId));
    return;
  }

  if (attempts < RETRY_LADDER_MS.length) {
    const nextAttemptAt = new Date(Date.now() + RETRY_LADDER_MS[attempts]);
    await db
      .update(schema.webhookDelivery)
      .set({ status: "pending", attempts, nextAttemptAt, responseCode, responseBody, updatedAt: new Date() })
      .where(eq(schema.webhookDelivery.id, deliveryId));
  } else {
    await db
      .update(schema.webhookDelivery)
      .set({ status: "dead", attempts, responseCode, responseBody, updatedAt: new Date() })
      .where(eq(schema.webhookDelivery.id, deliveryId));
  }
}
```

Note `RETRY_LADDER_MS[attempts]` (not `[attempts - 1]`) — trace through: on the FIRST failure, `delivery.attempts` starts at 0, so `attempts = 0 + 1 = 1` after this failure; the retry ladder's index 0 is `0` (immediate retry — "0s" per the PRD), so the delay BEFORE the retry that becomes attempt 2 should be `RETRY_LADDER_MS[1]` = 1 minute. Since `attempts` is already `1` at this point (post-increment), `RETRY_LADDER_MS[attempts]` = `RETRY_LADDER_MS[1]` = `60_000` — correct. Continue this pattern: after the 2nd failure, `attempts=2`, delay = `RETRY_LADDER_MS[2]` = 5 min; ... after the 7th failure, `attempts=7`, delay = `RETRY_LADDER_MS[7]` = 24h; after the 8th failure, `attempts=8`, the `attempts < RETRY_LADDER_MS.length` check (`8 < 8`) is false, so it's marked `dead`. This yields exactly 8 total delivery attempts before `dead`, matching the PRD's `[0s,1m,5m,30m,2h,5h,10h,24h]` (8 entries) exactly.

- [ ] **Step 2: Add `webhookSigningRotationKey` to `WorkerConfig`**

Read the current `apps/worker/src/config.ts`. Add `webhookSigningRotationKey: string;` to the `WorkerConfig` interface, and `webhookSigningRotationKey: requireEnv("WEBHOOK_SIGNING_ROTATION_KEY"),` to `loadConfig`'s returned object.

- [ ] **Step 3: Update `apps/worker/.env.local.example`**

Add: `WEBHOOK_SIGNING_ROTATION_KEY=dev-only-change-in-production-please`

- [ ] **Step 4: Update `apps/worker/src/queues.ts`: remove Task 3's stub, add the real webhook-queue Queue/Worker**

Remove the temporary `const webhookQueue = { add: async (...) => {} };` stub added in Task 3, Step 8. Add the real one:

```typescript
export const WEBHOOK_QUEUE_NAME = "webhook-queue";

export interface WebhookJobData {
  deliveryId: string;
}
```

(add near the top of the file, alongside the existing `CHARGE_SCHEDULER_QUEUE_NAME`/`CHARGE_QUEUE_NAME` constants)

Inside `createQueues`, add:

```typescript
  const webhookQueue = new Queue<WebhookJobData>(WEBHOOK_QUEUE_NAME, connection);

  async function processWebhookJob(job: Job<WebhookJobData>): Promise<void> {
    await deliverWebhook(db, job.data.deliveryId, config.webhookSigningRotationKey);
  }

  function startWebhookWorker(): Worker<WebhookJobData> {
    return new Worker<WebhookJobData>(WEBHOOK_QUEUE_NAME, processWebhookJob, connection);
  }
```

(no `concurrency: 1` restriction here — unlike the charge-queue Worker, webhook delivery has no shared mutable relayer-nonce state to protect, so concurrent delivery processing is safe and desirable for throughput)

Update the function's final `return` statement to include `webhookQueue` and `startWebhookWorker`:

```typescript
  return { chargeSchedulerQueue, chargeQueue, webhookQueue, scheduleDueCharges, startChargeWorker, startWebhookWorker };
```

Add the import: `import { deliverWebhook } from "./webhook-delivery.js";`.

Update Task 3's two `emitEvent(...)` call sites (in `processChargeJob` and via `reconcileDunningState`'s third parameter) to use the now-real `webhookQueue`:

```typescript
              async (deliveryId) => {
                await webhookQueue.add("deliver", { deliveryId }, { jobId: deliveryId });
              },
```

(this replaces both Task 3's placeholder `async () => {}` at the `reconcileDunningState(db, config.chainId, async () => {})` call site, and confirms the `processChargeJob` site's own inline callback, added in Task 3 Step 5, already had this exact shape — no change needed there beyond confirming `webhookQueue` now resolves to the real Queue instead of the stub).

- [ ] **Step 5: Write the delivery-processor test using a real local HTTP server**

Create `apps/worker/test/webhook-delivery.test.ts`:

```typescript
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type DbClient } from "@cadence/db";
import { encryptSecret } from "@cadence/shared";
import { deliverWebhook } from "../src/webhook-delivery.js";

const TEST_KEY = "0123456789abcdef0123456789abcdef";

describe("deliverWebhook", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbClient;
  let server: Server;
  let serverPort: number;
  let receivedRequests: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  let responseStatus = 200;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16").withDatabase("cadence_test").start();
    const url = container.getConnectionUri();
    const dbCwd = path.resolve(__dirname, "../../../packages/db");
    execSync("npx drizzle-kit migrate", { cwd: dbCwd, env: { ...process.env, DATABASE_URL: url }, stdio: "inherit" });
    db = createDbClient(url);

    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        receivedRequests.push({ headers: req.headers, body });
        res.writeHead(responseStatus);
        res.end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    serverPort = (server.address() as { port: number }).port;
  }, 60_000);

  afterEach(() => {
    receivedRequests = [];
    responseStatus = 200;
  });

  afterAll(async () => {
    await (db as DbClient & { $client: { end(): Promise<void> } }).$client.end();
    await container.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function seedDelivery(rawSecret: string) {
    const [merchant] = await db.insert(schema.merchant).values({ name: "WH Test", ownerAddress: `0x${Date.now()}${Math.random()}`.padEnd(42, "0").slice(0, 42), livemode: false }).returning();
    const [endpoint] = await db
      .insert(schema.webhookEndpoint)
      .values({ merchantId: merchant.id, url: `http://127.0.0.1:${serverPort}`, signingSecret: encryptSecret(rawSecret, TEST_KEY), enabledEvents: ["*"], status: "enabled", livemode: false })
      .returning();
    const [evt] = await db.insert(schema.event).values({ merchantId: merchant.id, type: "subscription.renewed", data: { foo: "bar" }, livemode: false }).returning();
    const payload = { id: `evt_${evt.id}`, type: "subscription.renewed", created: new Date().toISOString(), livemode: false, data: { foo: "bar" } };
    const [delivery] = await db
      .insert(schema.webhookDelivery)
      .values({ endpointId: endpoint.id, eventId: evt.id, eventType: "subscription.renewed", payload })
      .returning();
    return delivery;
  }

  it("delivers with a valid HMAC signature and marks the delivery succeeded", async () => {
    const rawSecret = "whsec_test123";
    const delivery = await seedDelivery(rawSecret);

    await deliverWebhook(db, delivery.id, TEST_KEY);

    expect(receivedRequests).toHaveLength(1);
    const [req] = receivedRequests;
    const sigHeader = req.headers["cadence-signature"] as string;
    expect(sigHeader).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

    const [t, sigPart] = sigHeader.split(",");
    const timestamp = t.split("=")[1];
    const expectedSig = createHmac("sha256", rawSecret).update(`${timestamp}.${req.body}`).digest("hex");
    expect(sigPart).toBe(`v1=${expectedSig}`);

    const [row] = await db.select().from(schema.webhookDelivery).where(eq(schema.webhookDelivery.id, delivery.id));
    expect(row.status).toBe("succeeded");
    expect(row.attempts).toBe(1);
    expect(row.responseCode).toBe(200);
  });

  it("sends the Cadence-Event-Id header matching the payload's id", async () => {
    const delivery = await seedDelivery("whsec_test456");
    await deliverWebhook(db, delivery.id, TEST_KEY);

    const [req] = receivedRequests;
    expect(req.headers["cadence-event-id"]).toBe((delivery.payload as { id: string }).id);
  });

  it("schedules a retry with next_attempt_at when the endpoint returns a non-2xx status", async () => {
    responseStatus = 500;
    const delivery = await seedDelivery("whsec_test789");

    await deliverWebhook(db, delivery.id, TEST_KEY);

    const [row] = await db.select().from(schema.webhookDelivery).where(eq(schema.webhookDelivery.id, delivery.id));
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.responseCode).toBe(500);
    expect(row.nextAttemptAt).not.toBeNull();
    expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 50_000); // ~1 minute out, per the ladder's 2nd entry
  });

  it("marks a delivery dead after the 8th failed attempt", async () => {
    responseStatus = 500;
    const delivery = await seedDelivery("whsec_test_dead");
    await db.update(schema.webhookDelivery).set({ attempts: 7 }).where(eq(schema.webhookDelivery.id, delivery.id));

    await deliverWebhook(db, delivery.id, TEST_KEY);

    const [row] = await db.select().from(schema.webhookDelivery).where(eq(schema.webhookDelivery.id, delivery.id));
    expect(row.status).toBe("dead");
    expect(row.attempts).toBe(8);
  });
});
```

- [ ] **Step 6: Run the test**

Run: `cd apps/worker && npx vitest run test/webhook-delivery.test.ts`
Expected: PASS (4/4 tests).

- [ ] **Step 7: Update `apps/worker/src/index.ts` to start the webhook Worker and include it in shutdown**

Read the current file. Add `startWebhookWorker` to the destructured `createQueues(...)` return, start it (`const webhookWorker = startWebhookWorker();`), and add `await webhookWorker.close();` to the `shutdown()` function alongside the existing `schedulerQueueWorker`/`chargeWorker` closes.

- [ ] **Step 8: Typecheck and run the full unit suite**

Run: `cd apps/worker && npx tsc --noEmit` then `cd apps/worker && npx vitest run`
Expected: `tsc` exits 0; full suite passes across 7 spec files (config 3, charge-lock 4, nonce-manager 3, due-query 10, dunning 11, events 8, webhook-delivery 4 = 43 tests — verify the actual count).

- [ ] **Step 9: Run the e2e suite to confirm the whole charge-flow still works with the new emitEvent call wired in**

Run: `cd apps/worker && npx vitest run --config vitest.e2e.config.ts`
Expected: PASS (2/2, same as before — this proves the new `emitEvent`/merchant-lookup code added to `processChargeJob`'s success path doesn't break the real anvil-based charge flow; note the e2e test's seeded subscriber has no corresponding `merchant` row with a matching `owner_address`, so `emitEvent`'s merchant lookup will find nothing and it will silently skip event emission for that test — this is expected and fine, not a bug, since the e2e test's focus is the charge itself, not webhook delivery).

- [ ] **Step 10: Commit**

```bash
git add apps/worker/src/webhook-delivery.ts apps/worker/src/queues.ts apps/worker/src/config.ts apps/worker/src/index.ts apps/worker/.env.local.example apps/worker/test/webhook-delivery.test.ts
git commit -m "Add webhook-queue delivery worker with HMAC signing and retry ladder"
```

---

### Task 5: Webhook-endpoint CRUD API

**Files:**
- Create: `apps/api/src/webhooks/webhook-endpoints.dto.ts`
- Create: `apps/api/src/webhooks/webhook-endpoints.service.ts`
- Create: `apps/api/src/webhooks/webhook-endpoints.controller.ts`
- Create: `apps/api/src/webhooks/webhooks.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/.env.local.example`
- Test: `apps/api/test/webhook-endpoints.e2e-spec.ts`

**Interfaces:**
- Consumes: `encryptSecret` (Task 2, `@cadence/shared`), `schema.webhookEndpoint` (Task 1, `@cadence/db`), `AuthContextService`, `MerchantsService.findByOwnerAddress`/`findByOwnerAddressById`, `parsePaginationQuery`/`buildPageEnvelope`, `AppException` (all pre-existing, Phase 1b/1c).
- Produces: `WebhookEndpointsService` methods, consumed only by this task's own controller (Task 6's delivery routes don't need endpoint CRUD, only endpoint-existence checks via a shared lookup — see Task 6).

- [ ] **Step 1: Write the DTOs**

Create `apps/api/src/webhooks/webhook-endpoints.dto.ts`:

```typescript
import { z } from "zod";
import { createZodDto } from "nestjs-zod";

export const CreateWebhookEndpointSchema = z.object({
  url: z.string().url(),
  enabledEvents: z.array(z.string()).optional(),
});
export class CreateWebhookEndpointDto extends createZodDto(CreateWebhookEndpointSchema) {}

export const UpdateWebhookEndpointSchema = z.object({
  url: z.string().url().optional(),
  enabledEvents: z.array(z.string()).optional(),
  status: z.enum(["enabled", "disabled"]).optional(),
});
export class UpdateWebhookEndpointDto extends createZodDto(UpdateWebhookEndpointSchema) {}
```

- [ ] **Step 2: Write the failing e2e test**

Create `apps/api/test/webhook-endpoints.e2e-spec.ts`:

```typescript
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
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/api && npx vitest run --config vitest.e2e.config.ts test/webhook-endpoints.e2e-spec.ts`
Expected: FAIL — no `/v1/webhook-endpoints` routes exist yet.

- [ ] **Step 4: Implement `WebhookEndpointsService`**

Create `apps/api/src/webhooks/webhook-endpoints.service.ts`:

```typescript
import { Inject, Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { and, asc, eq, gt } from "drizzle-orm";
import { schema } from "@cadence/db";
import type { DbClient } from "@cadence/db";
import { encryptSecret } from "@cadence/shared";
import { DB_CLIENT } from "../db/db.module.js";
import { AppException } from "../common/errors.js";
import type { CreateWebhookEndpointDto, UpdateWebhookEndpointDto } from "./webhook-endpoints.dto.js";

export type WebhookEndpointRow = typeof schema.webhookEndpoint.$inferSelect;

function generateRawSigningSecret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

@Injectable()
export class WebhookEndpointsService {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient, private readonly webhookSigningRotationKey: string) {}

  async create(merchantId: string, body: CreateWebhookEndpointDto): Promise<WebhookEndpointRow & { signingSecret: string }> {
    const rawSecret = generateRawSigningSecret();
    const encrypted = encryptSecret(rawSecret, this.webhookSigningRotationKey);

    const [created] = await this.db
      .insert(schema.webhookEndpoint)
      .values({
        merchantId,
        url: body.url,
        signingSecret: encrypted,
        enabledEvents: body.enabledEvents ?? ["*"],
        livemode: false,
      })
      .returning();

    return { ...created, signingSecret: rawSecret };
  }

  async listForMerchant(
    merchantId: string,
    params: { limit: number; startingAfter: string | null },
  ): Promise<Omit<WebhookEndpointRow, "signingSecret">[]> {
    const conditions = [eq(schema.webhookEndpoint.merchantId, merchantId)];
    if (params.startingAfter !== null) conditions.push(gt(schema.webhookEndpoint.id, params.startingAfter));

    const rows = await this.db
      .select()
      .from(schema.webhookEndpoint)
      .where(and(...conditions))
      .orderBy(asc(schema.webhookEndpoint.id))
      .limit(params.limit + 1);

    return rows.map(({ signingSecret: _s, ...rest }) => rest);
  }

  async update(merchantId: string, id: string, body: UpdateWebhookEndpointDto): Promise<Omit<WebhookEndpointRow, "signingSecret">> {
    const existing = await this.requireOwned(merchantId, id);
    const [updated] = await this.db
      .update(schema.webhookEndpoint)
      .set({
        url: body.url ?? existing.url,
        enabledEvents: body.enabledEvents ?? existing.enabledEvents,
        status: body.status ?? existing.status,
        updatedAt: new Date(),
      })
      .where(eq(schema.webhookEndpoint.id, id))
      .returning();
    const { signingSecret: _s, ...rest } = updated;
    return rest;
  }

  async delete(merchantId: string, id: string): Promise<void> {
    await this.requireOwned(merchantId, id);
    await this.db.delete(schema.webhookEndpoint).where(eq(schema.webhookEndpoint.id, id));
  }

  private async requireOwned(merchantId: string, id: string): Promise<WebhookEndpointRow> {
    const [existing] = await this.db
      .select()
      .from(schema.webhookEndpoint)
      .where(and(eq(schema.webhookEndpoint.id, id), eq(schema.webhookEndpoint.merchantId, merchantId)));
    if (!existing) {
      throw new AppException({ type: "invalid_request_error", code: "webhook_endpoint_not_found", message: "No webhook endpoint with that id exists for this merchant.", param: "id", status: 404 });
    }
    return existing;
  }
}
```

Note the constructor takes `webhookSigningRotationKey: string` as a plain constructor parameter, not via `@Inject(ConfigService)` directly in this class — Task's Step 6 (module wiring) supplies it via a factory provider reading `ConfigService.getOrThrow("WEBHOOK_SIGNING_ROTATION_KEY")`, keeping this service's own code decoupled from NestJS's config system (easier to unit-test in isolation later if needed, consistent with how `charge-submitter.ts` in `apps/worker` takes its dependencies as plain parameters rather than framework-injected ones).

- [ ] **Step 5: Implement `WebhookEndpointsController`**

Create `apps/api/src/webhooks/webhook-endpoints.controller.ts`:

```typescript
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { AuthContextService } from "../auth/auth-context.service.js";
import { MerchantsService } from "../merchants/merchants.service.js";
import { WebhookEndpointsService } from "./webhook-endpoints.service.js";
import { CreateWebhookEndpointDto, UpdateWebhookEndpointDto } from "./webhook-endpoints.dto.js";
import { parsePaginationQuery, buildPageEnvelope } from "../common/pagination.js";
import { AppException } from "../common/errors.js";

@Controller("v1/webhook-endpoints")
export class WebhookEndpointsController {
  constructor(
    private readonly webhookEndpointsService: WebhookEndpointsService,
    private readonly merchantsService: MerchantsService,
    private readonly authContext: AuthContextService,
  ) {}

  private async resolveCallerMerchantId(request: FastifyRequest): Promise<string> {
    const auth = await this.authContext.resolve(request);
    if (auth.keyType !== "session" && auth.keyType !== "secret") {
      throw new AppException({ type: "permission_error", code: "key_type_not_allowed", message: "This endpoint requires a secret API key." });
    }
    const merchant =
      auth.keyType === "session"
        ? await this.merchantsService.findByOwnerAddress(auth.ownerAddress, false)
        : await this.merchantsService.findByOwnerAddressById(auth.merchantId!);
    if (!merchant) {
      throw new AppException({ type: "invalid_request_error", code: "merchant_not_found", message: "No merchant account exists." });
    }
    return merchant.id;
  }

  @Post()
  async create(@Body() body: CreateWebhookEndpointDto, @Req() request: FastifyRequest) {
    const merchantId = await this.resolveCallerMerchantId(request);
    return this.webhookEndpointsService.create(merchantId, body);
  }

  @Get()
  async list(@Query() query: { limit?: string; starting_after?: string }, @Req() request: FastifyRequest) {
    const merchantId = await this.resolveCallerMerchantId(request);
    const { limit, startingAfter } = parsePaginationQuery(query);
    const rows = await this.webhookEndpointsService.listForMerchant(merchantId, { limit, startingAfter });
    return buildPageEnvelope(rows, limit);
  }

  @Patch(":id")
  async update(@Param("id") id: string, @Body() body: UpdateWebhookEndpointDto, @Req() request: FastifyRequest) {
    const merchantId = await this.resolveCallerMerchantId(request);
    return this.webhookEndpointsService.update(merchantId, id, body);
  }

  @Delete(":id")
  async delete(@Param("id") id: string, @Req() request: FastifyRequest) {
    const merchantId = await this.resolveCallerMerchantId(request);
    await this.webhookEndpointsService.delete(merchantId, id);
    return { deleted: true };
  }
}
```

Note `resolveCallerMerchantId` here rejects `keyType === "publishable"` UNCONDITIONALLY (not via a `requireSecret` boolean parameter like `PlansController`'s pattern) — since EVERY route on this controller is secret-only per the Global Constraints, there's no route that needs to accept a publishable key, so the simpler unconditional check is correct here and intentionally diverges from `PlansController`'s more general two-mode helper (which exists there because Plans has BOTH secret-only and either-key-type routes on the same controller).

- [ ] **Step 6: Create `WebhooksModule` and wire `WEBHOOK_SIGNING_ROTATION_KEY`**

Create `apps/api/src/webhooks/webhooks.module.ts`:

```typescript
import { Module, forwardRef } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { AuthModule } from "../auth/auth.module.js";
import { MerchantsModule } from "../merchants/merchants.module.js";
import { DB_CLIENT } from "../db/db.module.js";
import { WebhookEndpointsController } from "./webhook-endpoints.controller.js";
import { WebhookEndpointsService } from "./webhook-endpoints.service.js";

@Module({
  imports: [AuthModule, forwardRef(() => MerchantsModule), ConfigModule],
  controllers: [WebhookEndpointsController],
  providers: [
    {
      provide: WebhookEndpointsService,
      inject: [DB_CLIENT, ConfigService],
      useFactory: (dbClient: unknown, config: ConfigService) =>
        new WebhookEndpointsService(dbClient as never, config.getOrThrow<string>("WEBHOOK_SIGNING_ROTATION_KEY")),
    },
  ],
  exports: [WebhookEndpointsService],
})
export class WebhooksModule {}
```

`DB_CLIENT` is imported from `apps/api/src/db/db.module.ts` — confirmed (verified while writing this plan, not left to guesswork) to be a real exported `Symbol("DB_CLIENT")` constant, NOT the bare string `"DB_CLIENT"`. Using the string literal in `inject: [...]` would silently fail to match the token NestJS actually registered (`DB_CLIENT` the Symbol), since NestJS resolves providers by exact token identity — a string and a `Symbol` with the same-looking name are different tokens. Always import and use the real `DB_CLIENT` constant, never a string literal standing in for it.

This factory provider is REQUIRED, not optional, given `WebhookEndpointsService`'s constructor signature from Step 4 (`constructor(@Inject(DB_CLIENT) private readonly db: DbClient, private readonly webhookSigningRotationKey: string)`) — NestJS's automatic constructor injection cannot resolve a plain, undecorated `string` constructor parameter (`webhookSigningRotationKey`) on its own; it needs either an explicit `@Inject()` token on that parameter (which would require picking some token name and registering a matching provider anyway) or, as done here, a factory provider that constructs the whole class manually with both arguments supplied directly. The factory approach keeps `webhook-endpoints.service.ts` itself free of any additional DI-token boilerplate beyond its existing `@Inject(DB_CLIENT)` on the first parameter.

- [ ] **Step 7: Register `WebhooksModule` in `app.module.ts`**

Add `WebhooksModule` to the `imports` array and the import statement, alongside `CustomersModule`.

- [ ] **Step 8: Document the new env var**

Add to `apps/api/.env.local.example`: `WEBHOOK_SIGNING_ROTATION_KEY=dev-only-change-in-production-please`

- [ ] **Step 9: Run the e2e test suite**

Run: `cd apps/api && npx vitest run --config vitest.e2e.config.ts test/webhook-endpoints.e2e-spec.ts`
Expected: PASS (8/8 tests).

- [ ] **Step 10: Run the full e2e suite to confirm no cross-file regression**

Run: `cd apps/api && npx vitest run --config vitest.e2e.config.ts`
Expected: all spec files pass (7 pre-existing + this new one).

- [ ] **Step 11: Typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 12: Commit**

```bash
git add apps/api/src/webhooks apps/api/src/app.module.ts apps/api/.env.local.example apps/api/test/webhook-endpoints.e2e-spec.ts
git commit -m "Add webhook-endpoint CRUD API"
```

---

### Task 6: Webhook-delivery list + replay API

**Files:**
- Create: `apps/api/src/webhooks/webhook-deliveries.service.ts`
- Create: `apps/api/src/webhooks/webhook-deliveries.controller.ts`
- Modify: `apps/api/src/webhooks/webhooks.module.ts`
- Test: `apps/api/test/webhook-deliveries.e2e-spec.ts`

**Interfaces:**
- Consumes: `schema.webhookDelivery`/`schema.webhookEndpoint` (Task 1), the same `resolveCallerMerchantId` pattern from Task 5 (duplicated per-controller, matching this codebase's established convention of not sharing this helper across controllers).
- Produces: nothing consumed by later tasks — this is the last task in the plan.

- [ ] **Step 1: Write the failing e2e test**

Create `apps/api/test/webhook-deliveries.e2e-spec.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import request from "supertest";
import { Wallet } from "ethers";
import { SiweMessage } from "siwe";
import fastifyCookie from "@fastify/cookie";
import { createDbClient, schema, type DbClient } from "@cadence/db";
import { AppModule } from "../src/app.module.js";
import { startTestDatabase, stopTestDatabase } from "./setup.js";

type Server = ReturnType<ReturnType<NestFastifyApplication["getHttpAdapter"]>["getInstance"]>["server"];

async function signInAndCreateMerchant(server: Server): Promise<{ cookie: string; ownerAddress: string }> {
  const wallet = Wallet.createRandom();
  const nonceResponse = await request(server).post("/v1/auth/nonce").send();
  const { nonce } = nonceResponse.body;
  const siweMessage = new SiweMessage({ domain: "localhost", address: wallet.address, uri: "http://localhost:3000", version: "1", chainId: 1, nonce });
  const messageToSign = siweMessage.prepareMessage();
  const signature = await wallet.signMessage(messageToSign);
  const verifyResponse = await request(server).post("/v1/auth/verify").send({ message: messageToSign, signature });
  const cookie = (verifyResponse.headers["set-cookie"][0] as string).split(";")[0];
  await request(server).post("/v1/merchants").set("Cookie", cookie).send({ name: "WH Delivery Test Co", ownerAddress: wallet.address });
  return { cookie, ownerAddress: wallet.address };
}

describe("Webhook Deliveries", () => {
  let app: NestFastifyApplication;
  let server: Server;
  let db: DbClient;

  beforeAll(async () => {
    const connectionUri = await startTestDatabase();
    process.env.DATABASE_URL = connectionUri;
    process.env.JWT_SECRET = "test-secret";
    process.env.WEBHOOK_SIGNING_ROTATION_KEY = "test-rotation-key-0123456789abcd";
    db = createDbClient(connectionUri);

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

  async function seedDeliveryFor(cookie: string, ownerAddress: string) {
    const createResponse = await request(server).post("/v1/webhook-endpoints").set("Cookie", cookie).send({ url: "https://example.com/hook" });
    const endpointId = createResponse.body.id;

    const [merchantRow] = await db.select().from(schema.merchant).where(eq(schema.merchant.ownerAddress, ownerAddress));
    const [evt] = await db.insert(schema.event).values({ merchantId: merchantRow.id, type: "subscription.renewed", data: {}, livemode: false }).returning();
    const [delivery] = await db
      .insert(schema.webhookDelivery)
      .values({ endpointId, eventId: evt.id, eventType: "subscription.renewed", payload: { id: `evt_${evt.id}` }, status: "dead", attempts: 8 })
      .returning();
    return delivery;
  }

  it("lists deliveries scoped to the calling merchant's endpoints", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    await seedDeliveryFor(cookie, ownerAddress);

    const response = await request(server).get("/v1/webhook-deliveries").set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
  });

  it("does not show another merchant's deliveries", async () => {
    const { cookie: cookieA, ownerAddress: ownerA } = await signInAndCreateMerchant(server);
    const { cookie: cookieB } = await signInAndCreateMerchant(server);
    await seedDeliveryFor(cookieA, ownerA);

    const response = await request(server).get("/v1/webhook-deliveries").set("Cookie", cookieB);
    expect(response.body.data).toHaveLength(0);
  });

  it("filters deliveries by status", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    await seedDeliveryFor(cookie, ownerAddress);

    const response = await request(server).get("/v1/webhook-deliveries?status=dead").set("Cookie", cookie);
    expect(response.body.data).toHaveLength(1);

    const emptyResponse = await request(server).get("/v1/webhook-deliveries?status=succeeded").set("Cookie", cookie);
    expect(emptyResponse.body.data).toHaveLength(0);
  });

  it("replays a dead delivery, re-enqueuing without resetting attempts", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const delivery = await seedDeliveryFor(cookie, ownerAddress);

    const response = await request(server).post(`/v1/webhook-deliveries/${delivery.id}/replay`).set("Cookie", cookie);
    expect(response.status).toBe(200);

    const [row] = await db.select().from(schema.webhookDelivery).where(eq(schema.webhookDelivery.id, delivery.id));
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(8); // unchanged — replay doesn't reset the attempt counter
  });

  it("returns 404 replaying another merchant's delivery", async () => {
    const { cookie: cookieA, ownerAddress: ownerA } = await signInAndCreateMerchant(server);
    const { cookie: cookieB } = await signInAndCreateMerchant(server);
    const delivery = await seedDeliveryFor(cookieA, ownerA);

    const response = await request(server).post(`/v1/webhook-deliveries/${delivery.id}/replay`).set("Cookie", cookieB);
    expect(response.status).toBe(404);
  });
});
```

This test file needs `import { eq } from "drizzle-orm";` added at the top.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run --config vitest.e2e.config.ts test/webhook-deliveries.e2e-spec.ts`
Expected: FAIL — no `/v1/webhook-deliveries` routes exist yet.

- [ ] **Step 3: Implement `WebhookDeliveriesService`**

Create `apps/api/src/webhooks/webhook-deliveries.service.ts`:

```typescript
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { schema } from "@cadence/db";
import type { DbClient } from "@cadence/db";
import { DB_CLIENT } from "../db/db.module.js";
import { AppException } from "../common/errors.js";

export type WebhookDeliveryRow = typeof schema.webhookDelivery.$inferSelect;

@Injectable()
export class WebhookDeliveriesService {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  private async ownedEndpointIds(merchantId: string): Promise<string[]> {
    const rows = await this.db.select({ id: schema.webhookEndpoint.id }).from(schema.webhookEndpoint).where(eq(schema.webhookEndpoint.merchantId, merchantId));
    return rows.map((r) => r.id);
  }

  async listForMerchant(
    merchantId: string,
    params: { status?: string; limit: number; startingAfter: string | null },
  ): Promise<WebhookDeliveryRow[]> {
    const endpointIds = await this.ownedEndpointIds(merchantId);
    if (endpointIds.length === 0) return [];

    const conditions = [inArray(schema.webhookDelivery.endpointId, endpointIds)];
    if (params.status) conditions.push(eq(schema.webhookDelivery.status, params.status as "pending" | "succeeded" | "failed" | "dead"));
    if (params.startingAfter !== null) conditions.push(gt(schema.webhookDelivery.id, params.startingAfter));

    return this.db
      .select()
      .from(schema.webhookDelivery)
      .where(and(...conditions))
      .orderBy(asc(schema.webhookDelivery.id))
      .limit(params.limit + 1);
  }

  async replay(merchantId: string, deliveryId: string): Promise<{ replayed: boolean }> {
    const endpointIds = await this.ownedEndpointIds(merchantId);
    const [delivery] = await this.db
      .select()
      .from(schema.webhookDelivery)
      .where(and(eq(schema.webhookDelivery.id, deliveryId), endpointIds.length > 0 ? inArray(schema.webhookDelivery.endpointId, endpointIds) : eq(schema.webhookDelivery.id, "")));

    if (!delivery) {
      throw new AppException({ type: "invalid_request_error", code: "webhook_delivery_not_found", message: "No webhook delivery with that id exists for this merchant.", param: "id", status: 404 });
    }

    await this.db.update(schema.webhookDelivery).set({ status: "pending", updatedAt: new Date() }).where(eq(schema.webhookDelivery.id, deliveryId));
    return { replayed: true };
  }
}
```

Note `replay` here only flips `status` back to `pending` — it does NOT itself enqueue a BullMQ job, since `apps/api` has no BullMQ connection/dependency (only `apps/worker` does, per this project's established process boundary). A real production deployment needs a SEPARATE mechanism to notice `pending` deliveries whose `next_attempt_at` has passed (or, for a replay specifically, deliveries flipped back to `pending` with no `next_attempt_at` set) and re-enqueue them — this is a genuine, deliberate scope gap in THIS task, flagged here rather than silently worked around: a full solution would need either (a) a small polling job in `apps/worker` that periodically scans for `pending` deliveries with no active BullMQ job and re-enqueues them, or (b) `apps/api` and `apps/worker` sharing a Redis/BullMQ connection so `apps/api` can enqueue directly. Given this plan's scope boundary (this phase does not introduce cross-app BullMQ coupling), Step 3's `replay` implementation is a deliberately partial mechanism: it updates the row to indicate "should be retried," but actual re-delivery of an already-`dead` delivery whose retry window has fully elapsed requires a human or a future phase to close this loop. Document this explicitly in the task's own commit message and report — do not claim `replay` fully works end-to-end without a running BullMQ enqueue path.

- [ ] **Step 4: Implement `WebhookDeliveriesController`**

Create `apps/api/src/webhooks/webhook-deliveries.controller.ts`:

```typescript
import { Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { AuthContextService } from "../auth/auth-context.service.js";
import { MerchantsService } from "../merchants/merchants.service.js";
import { WebhookDeliveriesService } from "./webhook-deliveries.service.js";
import { parsePaginationQuery, buildPageEnvelope } from "../common/pagination.js";
import { AppException } from "../common/errors.js";

@Controller("v1/webhook-deliveries")
export class WebhookDeliveriesController {
  constructor(
    private readonly webhookDeliveriesService: WebhookDeliveriesService,
    private readonly merchantsService: MerchantsService,
    private readonly authContext: AuthContextService,
  ) {}

  private async resolveCallerMerchantId(request: FastifyRequest): Promise<string> {
    const auth = await this.authContext.resolve(request);
    if (auth.keyType !== "session" && auth.keyType !== "secret") {
      throw new AppException({ type: "permission_error", code: "key_type_not_allowed", message: "This endpoint requires a secret API key." });
    }
    const merchant =
      auth.keyType === "session"
        ? await this.merchantsService.findByOwnerAddress(auth.ownerAddress, false)
        : await this.merchantsService.findByOwnerAddressById(auth.merchantId!);
    if (!merchant) {
      throw new AppException({ type: "invalid_request_error", code: "merchant_not_found", message: "No merchant account exists." });
    }
    return merchant.id;
  }

  @Get()
  async list(@Query() query: { status?: string; limit?: string; starting_after?: string }, @Req() request: FastifyRequest) {
    const merchantId = await this.resolveCallerMerchantId(request);
    const { limit, startingAfter } = parsePaginationQuery(query);
    const rows = await this.webhookDeliveriesService.listForMerchant(merchantId, { status: query.status, limit, startingAfter });
    return buildPageEnvelope(rows, limit);
  }

  @Post(":id/replay")
  async replay(@Param("id") id: string, @Req() request: FastifyRequest) {
    const merchantId = await this.resolveCallerMerchantId(request);
    return this.webhookDeliveriesService.replay(merchantId, id);
  }
}
```

- [ ] **Step 5: Register the new controller/service in `webhooks.module.ts`**

Read the current `apps/api/src/webhooks/webhooks.module.ts` (from Task 5). Add `WebhookDeliveriesController` to `controllers` and `WebhookDeliveriesService` to `providers` (this one uses ordinary constructor injection — only `DB_CLIENT` — so no factory-provider workaround is needed here, unlike `WebhookEndpointsService`).

- [ ] **Step 6: Run the e2e test suite**

Run: `cd apps/api && npx vitest run --config vitest.e2e.config.ts test/webhook-deliveries.e2e-spec.ts`
Expected: PASS (5/5 tests).

- [ ] **Step 7: Run the full e2e suite one final time**

Run: `cd apps/api && npx vitest run --config vitest.e2e.config.ts`
Expected: all spec files pass (8 pre-existing + this new one).

- [ ] **Step 8: Typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/webhooks/webhook-deliveries.service.ts apps/api/src/webhooks/webhook-deliveries.controller.ts apps/api/src/webhooks/webhooks.module.ts apps/api/test/webhook-deliveries.e2e-spec.ts
git commit -m "Add webhook-delivery list and replay endpoints"
```

---

## Plan Self-Review Notes

**Spec coverage check:**
- `event`, `webhook_endpoint`, `webhook_delivery` tables → Task 1. ✓
- AES-256-GCM encryption via `WEBHOOK_SIGNING_ROTATION_KEY` → Task 2. ✓
- `emitEvent` called at exactly the two real transition points, NOT double-emitting on recovery → Task 3, with the recovery-vs-renewal decision explicitly resolved and encoded in Global Constraints. ✓
- Webhook envelope + HMAC signing exactly per PRD Appendix D.6 → Task 4. ✓
- Retry ladder `[0s,1m,5m,30m,2h,5h,10h,24h]` then `dead` → Task 4, with the off-by-one indexing traced explicitly. ✓
- Webhook-queue Worker in the SAME `apps/worker` process → Task 4. ✓
- Secret-key-only CRUD for `webhook_endpoint` → Task 5. ✓
- List + replay for `webhook_delivery`, idempotent (`UNIQUE (endpoint_id, event_id)`, replay doesn't reset `attempts`) → Task 6. ✓
- No fabricated events for un-triggered PRD event types → confirmed nowhere in this plan does any task add emission for `plan.created`/`invoice.created`/etc. ✓

**Placeholder scan:** One INTENTIONAL, explicitly-flagged temporary placeholder exists (Task 3 Step 8's `webhookQueue` stub, removed in Task 4 Step 4) — this is a deliberate task-boundary artifact, not a forbidden vague placeholder, and its exact removal point is specified. One INTENTIONAL, explicitly-flagged scope gap exists (Task 6's `replay` not actually re-enqueuing a BullMQ job, since `apps/api` has no BullMQ connection) — this is disclosed prominently in Task 6's own text, not silently glossed over, and is consistent with this plan's overall boundary of not introducing cross-app BullMQ coupling in this phase. No other placeholders found.

**Type consistency check:** `emitEvent`'s signature (`db, params, enqueueDelivery`) is used identically in its own test (Task 3) and at both real call sites (Task 3's wiring into `queues.ts`/`dunning.ts`, Task 4's replacement of the stub callback). `encryptSecret`/`decryptSecret`'s signatures (`(value: string, key: string): string`) are used consistently between Task 2's own test, Task 4's `webhook-delivery.ts`, Task 5's `webhook-endpoints.service.ts`, and Task 4's own delivery test (which calls `encryptSecret` directly to seed a delivery). `WebhookEndpointRow`/`WebhookDeliveryRow` type aliases are defined once (Tasks 5/6's respective services) and not redefined elsewhere.

**Gap found and fixed during self-review:** Task 3's plan for `dunning.ts` required threading a THIRD parameter (`enqueueWebhookDelivery`) through `reconcileDunningState`/`createRowsForNewFailures`/`advanceOrExhaustRepeatFailures`'s signatures — all three were re-checked to confirm the parameter is added consistently to all three (not just the outermost `reconcileDunningState`), and Task 3's Step 7 explicitly calls out updating the EXISTING `dunning.test.ts` (Phase 1f) call sites to pass a no-op callback, so that test file's 11 pre-existing tests keep passing rather than breaking on a changed function signature.

**A second gap found and fixed during self-review:** an initial draft of Task 5's `WebhookEndpointsController.list` and Task 6's `WebhookDeliveriesController.list`/`WebhookDeliveriesService.listForMerchant` fetched ALL matching rows from the database unbounded, then applied `limit`/`starting_after` filtering in application code (Task 6's draft even hand-rolled `limit` parsing without calling `parsePaginationQuery` at all, so it had no `invalid_limit` validation). This diverges from every other list endpoint in this codebase (Phases 1c/1d), which push `LIMIT`/cursor filtering down into the SQL query itself via `.orderBy(asc(...)).limit(params.limit + 1)`. Fixed by changing both services' `listForMerchant` signatures to accept `{ limit, startingAfter }` (matching `findDueSubscriptions`'s and `PlansService.list`'s established shape) and moving the `gt(...)`/`orderBy(asc(...))`/`.limit(...)` logic into the SQL query, and fixing both controllers to call `parsePaginationQuery` uniformly. This matters most for `WebhookDeliveriesService` (delivery rows accumulate per-event and could realistically number in the thousands for an active merchant) and is a correctness/consistency fix for `WebhookEndpointsService` too (endpoints are few per merchant in practice, so the severity there was lower, but the inconsistency with the rest of the codebase's pagination convention was still real).
