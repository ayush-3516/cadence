# Phase 1d — Customers Read/Write API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `GET /v1/customers` (list, derived from on-chain subscription activity), `GET /v1/customers/:address/subscriptions` (a customer's own subscriptions, portal-facing), and `POST /v1/customers/:address/email` (opt-in email for dunning notices), completing the read-API trio started in Phase 1c.

**Architecture:** A new `customer` app table (Drizzle-managed, migrated normally — unlike Phase 1c's on-chain mirrors, this is a genuine app table) stores only the opt-in email override. `GET /v1/customers` derives its list from `DISTINCT subscriber_address` in `onchain_subscription`, scoped through `onchain_plan.merchant_address`, LEFT JOINed with `customer` for email. `GET /v1/customers/:address/subscriptions` delegates to the existing `SubscriptionsService.list()` (Phase 1c) with the address as its `subscriber` filter. `POST /v1/customers/:address/email` upserts the `customer` row.

**Tech Stack:** NestJS 11 (Fastify adapter), Drizzle ORM 0.45.2, drizzle-kit 0.31.10, Vitest + Testcontainers, nestjs-zod — all pre-existing from Phases 1a-1c, no new dependencies.

## Global Constraints

- The `customer` table is migrated normally via `packages/db`'s standard `drizzle-kit generate`/`migrate` path (`packages/db/drizzle.config.ts`, output to `packages/db/migrations/`) — it is app-owned, unlike Phase 1c's on-chain mirror tables, which use a separate config/output and must never appear here.
- All new routes reuse the existing `AppException`/`STATUS_BY_TYPE` error envelope (`apps/api/src/common/errors.ts`) — no new error-handling mechanism.
- All new routes accept a session cookie OR an API key (dual-auth via `AuthContextService.resolve()`), matching the existing pattern in `PlansController`/`SubscriptionsController`.
- `GET /v1/customers` requires a **secret** key (or session cookie) — publishable keys get 403 `permission_error`/`key_type_not_allowed`. `GET /v1/customers/:address/subscriptions` and `POST /v1/customers/:address/email` accept **either** key type (or session cookie).
- `POST /v1/customers/:address/email` does **not** verify that the caller controls the wallet at `:address` — presenting a valid key (secret or publishable) for the merchant is sufficient. This is a deliberate, documented simplification (see the design spec's "Auth simplification" section) — do not add signature verification in this phase.
- `GET /v1/customers` uses the same cursor pagination envelope as Phase 1c (`{data, has_more, next_cursor}`, `?limit=&starting_after=`), but the cursor is the subscriber **address** (text), not a numeric on-chain ID.
- An address with zero subscriptions and no email on file is not an error state for either read endpoint — both return an empty/default result, never a 404.
- No `amount_usd` or other monetary fields appear in any customer response (not applicable to this phase's data).

---

## File Structure

**New files:**
- `apps/api/src/customers/customers.dto.ts` — Zod schema + DTO for `POST /v1/customers/:address/email`.
- `apps/api/src/customers/customers.service.ts` — `list()` (derives customers from on-chain data), `setEmail()` (upserts the `customer` row).
- `apps/api/src/customers/customers.controller.ts` — the three customer routes.
- `apps/api/src/customers/customers.module.ts`
- `apps/api/test/customers.e2e-spec.ts`

**Modified files:**
- `packages/db/src/schema.ts` — add `customer` table.
- `apps/api/src/subscriptions/subscriptions.module.ts` — add `SubscriptionsService` to `exports` (currently not exported; `CustomersModule` needs to inject it for `GET /v1/customers/:address/subscriptions`).
- `apps/api/src/app.module.ts` — register `CustomersModule`.

---

### Task 1: `customer` table (packages/db)

**Files:**
- Modify: `packages/db/src/schema.ts`
- Test: `packages/db/test/customer-schema.test.ts` (new)

**Interfaces:**
- Produces: `schema.customer` (Drizzle table, columns: `id` uuid PK, `merchantId` uuid FK → `merchant.id`, `address` text, `email` text nullable, `createdAt` timestamptz; unique on `(merchantId, address)`), consumed by Task 2 (`CustomersService`).

- [ ] **Step 1: Add `customer` to `packages/db/src/schema.ts`**

Read the current file first — it defines `apiKeyType`, `merchant`, `apiKey`, `planMeta`. Add after `planMeta`:

```typescript
export const customer = pgTable(
  "customer",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    merchantId: uuid("merchant_id").notNull().references(() => merchant.id),
    address: text("address").notNull(),
    email: text("email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("customer_merchant_id_address_unique").on(table.merchantId, table.address)],
);
```

No new imports are needed — `pgTable`, `uuid`, `text`, `timestamp`, `unique`, and `sql` are all already imported at the top of the file for `merchant`/`apiKey`/`planMeta`.

- [ ] **Step 2: Generate and inspect the migration**

Run: `cd packages/db && npx drizzle-kit generate --name add_customer`
Expected: a new file under `packages/db/migrations/`, e.g. `0002_<name>.sql`, containing exactly one `CREATE TABLE "customer" (...)` statement referencing `merchant(id)`, plus a unique constraint on `(merchant_id, address)`. No other table should be touched, and — critically — no `onchain_plan`/`onchain_subscription`/`onchain_charge` tables should appear (those belong only in `packages/db/migrations-onchain/`, generated by a separate config; this step must never touch that directory).

- [ ] **Step 3: Write a test proving the table works with the unique constraint**

Create `packages/db/test/customer-schema.test.ts`:

```typescript
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
```

- [ ] **Step 4: Run the test**

Run: `cd packages/db && npx vitest run test/customer-schema.test.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Rebuild and typecheck**

Run: `cd packages/db && npm run build && npm run typecheck`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/migrations packages/db/test/customer-schema.test.ts
git commit -m "Add customer table for opt-in dunning email"
```

---

### Task 2: `CustomersService` + `CustomersController` + module wiring

**Files:**
- Create: `apps/api/src/customers/customers.dto.ts`
- Create: `apps/api/src/customers/customers.service.ts`
- Create: `apps/api/src/customers/customers.controller.ts`
- Create: `apps/api/src/customers/customers.module.ts`
- Modify: `apps/api/src/subscriptions/subscriptions.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/customers.e2e-spec.ts`

**Interfaces:**
- Consumes: `AuthContextService.resolve(request, executionContext?)` returning `{ ownerAddress: string; merchantId: string | null; keyType: "session" | "secret" | "publishable" }` (Phase 1c, `apps/api/src/auth/auth-context.service.ts`); `parsePaginationQuery`/`buildPageEnvelope` (Phase 1c, `apps/api/src/common/pagination.ts`); `MerchantsService.findByOwnerAddressById(merchantId): Promise<Merchant | undefined>` and `MerchantsService.findByOwnerAddress(ownerAddress, livemode): Promise<Merchant | undefined>` (Phase 1b, `apps/api/src/merchants/merchants.service.ts`); `SubscriptionsService.list(callerOwnerAddress, params): Promise<SubscriptionSummary[]>` (Phase 1c, `apps/api/src/subscriptions/subscriptions.service.ts` — accepts a `subscriber` filter param already); `schema.customer`, `schema.merchant` (Task 1); `onchainSchema.onchainSubscription`, `onchainSchema.onchainPlan` (Phase 1c mirrors).
- Produces: `CustomersService.list(callerOwnerAddress, params): Promise<CustomerSummary[]>`, `CustomersService.setEmail(merchantId, address, email): Promise<{ address: string; email: string }>`. Used only within this task.

- [ ] **Step 1: Write the DTO for email set**

Create `apps/api/src/customers/customers.dto.ts`:

```typescript
import { z } from "zod";
import { createZodDto } from "nestjs-zod";

export const SetCustomerEmailSchema = z.object({
  email: z.string().email(),
});

export class SetCustomerEmailDto extends createZodDto(SetCustomerEmailSchema) {}
```

- [ ] **Step 2: Write the failing e2e test**

Create `apps/api/test/customers.e2e-spec.ts`. This is the full file — it covers all three routes:

```typescript
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import request from "supertest";
import { Wallet } from "ethers";
import { SiweMessage } from "siwe";
import fastifyCookie from "@fastify/cookie";
import { createDbClient, type DbClient } from "@cadence/db";
import { AppModule } from "../src/app.module.js";
import { startTestDatabase, stopTestDatabase, seedOnchainPlan, seedOnchainSubscription } from "./setup.js";

type Server = ReturnType<ReturnType<NestFastifyApplication["getHttpAdapter"]>["getInstance"]>["server"];

async function signInAndCreateMerchant(server: Server): Promise<{ cookie: string; ownerAddress: string }> {
  const wallet = Wallet.createRandom();
  const nonceResponse = await request(server).post("/v1/auth/nonce").send();
  const { nonce } = nonceResponse.body;

  const siweMessage = new SiweMessage({
    domain: "localhost",
    address: wallet.address,
    uri: "http://localhost:3000",
    version: "1",
    chainId: 1,
    nonce,
  });
  const messageToSign = siweMessage.prepareMessage();
  const signature = await wallet.signMessage(messageToSign);
  const verifyResponse = await request(server).post("/v1/auth/verify").send({ message: messageToSign, signature });
  const cookie = (verifyResponse.headers["set-cookie"][0] as string).split(";")[0];

  await request(server).post("/v1/merchants").set("Cookie", cookie).send({ name: "Customer Test Co", ownerAddress: wallet.address });

  return { cookie, ownerAddress: wallet.address };
}

async function createSecretKey(server: Server, cookie: string): Promise<string> {
  const response = await request(server).post("/v1/api-keys").set("Cookie", cookie).send({ type: "secret" });
  return response.body.key;
}

async function createPublishableKey(server: Server, cookie: string): Promise<string> {
  const response = await request(server).post("/v1/api-keys").set("Cookie", cookie).send({ type: "publishable" });
  return response.body.key;
}

describe("Customers", () => {
  let app: NestFastifyApplication;
  let server: Server;
  let db: DbClient;

  beforeAll(async () => {
    const connectionUri = await startTestDatabase();
    process.env.DATABASE_URL = connectionUri;
    process.env.JWT_SECRET = "test-secret";
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

  it("lists only the calling merchant's customers, derived from on-chain subscriptions", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const ownPlan = await seedOnchainPlan(db, { merchantAddress: ownerAddress });
    const otherPlan = await seedOnchainPlan(db, { merchantAddress: "0x9990000000000000000000000000000000000a" });
    await seedOnchainSubscription(db, { onchainPlanId: ownPlan.onchainPlanId, subscriberAddress: "0x1110000000000000000000000000000000000f" });
    await seedOnchainSubscription(db, { onchainPlanId: otherPlan.onchainPlanId, subscriberAddress: "0x2220000000000000000000000000000000000f" });

    const response = await request(server).get("/v1/customers").set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].address).toBe("0x1110000000000000000000000000000000000f");
    expect(response.body.data[0].email).toBeNull();
    expect(response.body.data[0].subscription_count).toBe(1);
  });

  it("shows the opt-in email once set, and counts multiple subscriptions correctly", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const plan = await seedOnchainPlan(db, { merchantAddress: ownerAddress });
    const subscriberAddress = "0x3330000000000000000000000000000000000f";
    await seedOnchainSubscription(db, { onchainPlanId: plan.onchainPlanId, subscriberAddress });
    await seedOnchainSubscription(db, { onchainPlanId: plan.onchainPlanId, subscriberAddress });

    await request(server).post(`/v1/customers/${subscriberAddress}/email`).set("Cookie", cookie).send({ email: "customer@example.com" });

    const response = await request(server).get("/v1/customers").set("Cookie", cookie);
    const found = response.body.data.find((c: { address: string }) => c.address === subscriberAddress);
    expect(found.email).toBe("customer@example.com");
    expect(found.subscription_count).toBe(2);
  });

  it("paginates customer list with has_more and next_cursor", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const plan = await seedOnchainPlan(db, { merchantAddress: ownerAddress });
    const addresses = [
      "0x1000000000000000000000000000000000000a",
      "0x2000000000000000000000000000000000000a",
      "0x3000000000000000000000000000000000000a",
    ];
    for (const subscriberAddress of addresses) {
      await seedOnchainSubscription(db, { onchainPlanId: plan.onchainPlanId, subscriberAddress });
    }

    const firstPage = await request(server).get("/v1/customers?limit=2").set("Cookie", cookie);
    expect(firstPage.body.data).toHaveLength(2);
    expect(firstPage.body.has_more).toBe(true);
    expect(firstPage.body.next_cursor).not.toBeNull();

    const secondPage = await request(server)
      .get(`/v1/customers?limit=2&starting_after=${firstPage.body.next_cursor}`)
      .set("Cookie", cookie);
    expect(secondPage.body.data).toHaveLength(1);
    expect(secondPage.body.has_more).toBe(false);
  });

  it("rejects GET /v1/customers with a publishable key", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    await seedOnchainPlan(db, { merchantAddress: ownerAddress });
    const pubKey = await createPublishableKey(server, cookie);

    const response = await request(server).get("/v1/customers").set("Authorization", `Bearer ${pubKey}`);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("key_type_not_allowed");
  });

  it("accepts a secret key on GET /v1/customers", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    await seedOnchainPlan(db, { merchantAddress: ownerAddress });
    const secretKey = await createSecretKey(server, cookie);

    const response = await request(server).get("/v1/customers").set("Authorization", `Bearer ${secretKey}`);
    expect(response.status).toBe(200);
  });

  it("gets a customer's subscriptions, scoped to the calling merchant", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const ownPlan = await seedOnchainPlan(db, { merchantAddress: ownerAddress });
    const otherPlan = await seedOnchainPlan(db, { merchantAddress: "0x8880000000000000000000000000000000000a" });
    const subscriberAddress = "0x4440000000000000000000000000000000000f";
    await seedOnchainSubscription(db, { onchainPlanId: ownPlan.onchainPlanId, subscriberAddress });
    await seedOnchainSubscription(db, { onchainPlanId: otherPlan.onchainPlanId, subscriberAddress });

    const response = await request(server).get(`/v1/customers/${subscriberAddress}/subscriptions`).set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].subscriber).toBe(subscriberAddress);
  });

  it("returns an empty list, not 404, for an address with zero subscriptions", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const response = await request(server).get("/v1/customers/0x0000000000000000000000000000000000dead/subscriptions").set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(0);
  });

  it("accepts a publishable key on GET /v1/customers/:address/subscriptions", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const plan = await seedOnchainPlan(db, { merchantAddress: ownerAddress });
    const subscriberAddress = "0x5550000000000000000000000000000000000f";
    await seedOnchainSubscription(db, { onchainPlanId: plan.onchainPlanId, subscriberAddress });
    const pubKey = await createPublishableKey(server, cookie);

    const response = await request(server)
      .get(`/v1/customers/${subscriberAddress}/subscriptions`)
      .set("Authorization", `Bearer ${pubKey}`);
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
  });

  it("sets a customer's email, creating the row on first call", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const address = "0x6660000000000000000000000000000000000f";

    const response = await request(server).post(`/v1/customers/${address}/email`).set("Cookie", cookie).send({ email: "first@example.com" });
    expect(response.status).toBe(201);
    expect(response.body.address).toBe(address);
    expect(response.body.email).toBe("first@example.com");
  });

  it("upserts a customer's email on a second call", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const address = "0x7770000000000000000000000000000000000f";

    await request(server).post(`/v1/customers/${address}/email`).set("Cookie", cookie).send({ email: "old@example.com" });
    const response = await request(server).post(`/v1/customers/${address}/email`).set("Cookie", cookie).send({ email: "new@example.com" });

    expect(response.status).toBe(201);
    expect(response.body.email).toBe("new@example.com");
  });

  it("sets a customer's email independent of any on-chain subscription existing", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const address = "0x8880000000000000000000000000000000000f";

    const response = await request(server).post(`/v1/customers/${address}/email`).set("Cookie", cookie).send({ email: "preregistered@example.com" });
    expect(response.status).toBe(201);
  });

  it("accepts a publishable key on POST /v1/customers/:address/email", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const address = "0x9990000000000000000000000000000000000f";
    const pubKey = await createPublishableKey(server, cookie);

    const response = await request(server)
      .post(`/v1/customers/${address}/email`)
      .set("Authorization", `Bearer ${pubKey}`)
      .send({ email: "viapub@example.com" });
    expect(response.status).toBe(201);
  });

  it("rejects an invalid email", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const address = "0xaaa0000000000000000000000000000000000f";

    const response = await request(server).post(`/v1/customers/${address}/email`).set("Cookie", cookie).send({ email: "not-an-email" });
    expect(response.status).toBe(400);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run --config vitest.e2e.config.ts test/customers.e2e-spec.ts`
Expected: FAIL — `/v1/customers` routes don't exist yet (404s / connection errors on every request).

- [ ] **Step 4: Export `SubscriptionsService` from `SubscriptionsModule`**

Modify `apps/api/src/subscriptions/subscriptions.module.ts`. Read the current file first (it currently has no `exports` array). Add one:

```typescript
import { Module, forwardRef } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { MerchantsModule } from "../merchants/merchants.module.js";
import { SubscriptionsController } from "./subscriptions.controller.js";
import { SubscriptionsService } from "./subscriptions.service.js";

@Module({
  imports: [AuthModule, forwardRef(() => MerchantsModule)],
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
```

- [ ] **Step 5: Implement `CustomersService`**

Create `apps/api/src/customers/customers.service.ts`:

```typescript
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, eq, gt, sql } from "drizzle-orm";
import { schema, onchainSchema } from "@cadence/db";
import type { DbClient } from "@cadence/db";
import { DB_CLIENT } from "../db/db.module.js";

export interface CustomerSummary {
  id: string; // = address, used by buildPageEnvelope's cursor slicing
  address: string;
  email: string | null;
  subscription_count: number;
}

@Injectable()
export class CustomersService {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async list(
    callerOwnerAddress: string,
    params: { limit: number; startingAfter: string | null },
  ): Promise<CustomerSummary[]> {
    const conditions = [eq(onchainSchema.onchainPlan.merchantAddress, callerOwnerAddress)];
    if (params.startingAfter !== null) {
      conditions.push(gt(onchainSchema.onchainSubscription.subscriberAddress, params.startingAfter));
    }

    // drizzle-orm's count() aggregates over Postgres bigint, which node-postgres
    // deserializes as a JS string (same reason plan.periodSeconds elsewhere in
    // this codebase needs Number(...) before use) — the Number() cast below on
    // row.subscriptionCount is required, not optional, or subscription_count
    // would serialize as a numeric-looking string instead of a JSON number.
    const rows = await this.db
      .select({
        address: onchainSchema.onchainSubscription.subscriberAddress,
        subscriptionCount: count(onchainSchema.onchainSubscription.onchainSubId),
      })
      .from(onchainSchema.onchainSubscription)
      .innerJoin(onchainSchema.onchainPlan, eq(onchainSchema.onchainSubscription.onchainPlanId, onchainSchema.onchainPlan.onchainPlanId))
      .where(and(...conditions))
      .groupBy(onchainSchema.onchainSubscription.subscriberAddress)
      .orderBy(asc(onchainSchema.onchainSubscription.subscriberAddress))
      .limit(params.limit + 1);

    if (rows.length === 0) return [];

    // customer.merchant_id is a UUID, not the raw owner address — resolve it once
    // via the merchant row so the email LEFT JOIN below can match on it.
    const [merchantRow] = await this.db.select().from(schema.merchant).where(eq(schema.merchant.ownerAddress, callerOwnerAddress));
    if (!merchantRow) return rows.map((row) => ({ id: row.address, address: row.address, email: null, subscription_count: Number(row.subscriptionCount) }));

    const customerRows = await this.db
      .select()
      .from(schema.customer)
      .where(eq(schema.customer.merchantId, merchantRow.id));
    const emailByAddress = new Map(customerRows.map((c) => [c.address, c.email]));

    return rows.map((row) => ({
      id: row.address,
      address: row.address,
      email: emailByAddress.get(row.address) ?? null,
      subscription_count: Number(row.subscriptionCount),
    }));
  }

  async setEmail(merchantId: string, address: string, email: string): Promise<{ address: string; email: string }> {
    await this.db
      .insert(schema.customer)
      .values({ merchantId, address, email })
      .onConflictDoUpdate({
        target: [schema.customer.merchantId, schema.customer.address],
        set: { email },
      });

    return { address, email };
  }
}
```

Note the `list()` method resolves the calling merchant's own row separately (via `schema.merchant`, matched by `ownerAddress`) rather than joining `customer` directly by address in the main query — this is because `customer.merchant_id` is a UUID foreign key, while the on-chain query only has the merchant's raw `owner_address` string in scope; a direct `eq()` between those two would be comparing unrelated column types, similar in spirit to (though not the same bug as) the `numeric`-vs-`text` mismatch found in Phase 1c. Resolving the merchant row once and building an in-memory `Map` for the (at most `limit + 1`) rows in this page avoids a second per-row query and avoids that type mismatch entirely.

- [ ] **Step 6: Implement `CustomersController`**

Create `apps/api/src/customers/customers.controller.ts`:

```typescript
import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { AuthContextService } from "../auth/auth-context.service.js";
import { MerchantsService } from "../merchants/merchants.service.js";
import { SubscriptionsService } from "../subscriptions/subscriptions.service.js";
import { CustomersService } from "./customers.service.js";
import { SetCustomerEmailDto } from "./customers.dto.js";
import { parsePaginationQuery, buildPageEnvelope } from "../common/pagination.js";
import { AppException } from "../common/errors.js";

@Controller("v1/customers")
export class CustomersController {
  constructor(
    private readonly customersService: CustomersService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly merchantsService: MerchantsService,
    private readonly authContext: AuthContextService,
  ) {}

  private async resolveCallerOwnerAddress(request: FastifyRequest, requireSecret: boolean): Promise<string> {
    const auth = await this.authContext.resolve(request);
    if (auth.keyType === "session") return auth.ownerAddress;

    if (requireSecret && auth.keyType !== "secret") {
      throw new AppException({ type: "permission_error", code: "key_type_not_allowed", message: "This endpoint requires a secret API key." });
    }

    const merchant = await this.merchantsService.findByOwnerAddressById(auth.merchantId!);
    if (!merchant) {
      throw new AppException({ type: "invalid_request_error", code: "merchant_not_found", message: "No merchant account found for this API key." });
    }
    return merchant.ownerAddress;
  }

  private async resolveCallerMerchantId(request: FastifyRequest): Promise<string> {
    const auth = await this.authContext.resolve(request);
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
  async list(@Query() query: { limit?: string; starting_after?: string }, @Req() request: FastifyRequest) {
    const ownerAddress = await this.resolveCallerOwnerAddress(request, true);
    const { limit, startingAfter } = parsePaginationQuery(query);

    const rows = await this.customersService.list(ownerAddress, { limit, startingAfter });
    return buildPageEnvelope(rows, limit);
  }

  @Get(":address/subscriptions")
  async getSubscriptions(
    @Param("address") address: string,
    @Query() query: { limit?: string; starting_after?: string },
    @Req() request: FastifyRequest,
  ) {
    const ownerAddress = await this.resolveCallerOwnerAddress(request, false);
    const { limit, startingAfter } = parsePaginationQuery(query);

    const rows = await this.subscriptionsService.list(ownerAddress, { limit, startingAfter, subscriber: address });
    return buildPageEnvelope(rows, limit);
  }

  @Post(":address/email")
  async setEmail(@Param("address") address: string, @Body() body: SetCustomerEmailDto, @Req() request: FastifyRequest) {
    const merchantId = await this.resolveCallerMerchantId(request);
    return this.customersService.setEmail(merchantId, address, body.email);
  }
}
```

`resolveCallerOwnerAddress` is copied verbatim from `PlansController`'s established helper (same signature, same behavior) rather than extracted into a shared base class — this repo's existing convention (see `PlansController`, `SubscriptionsController`) is per-controller duplication of this small helper, not a shared abstraction; do not introduce one as part of this task.

`resolveCallerMerchantId` is a new, distinct helper (not present in `PlansController`/`SubscriptionsController`) because `setEmail` needs the merchant's UUID `id` for the upsert, not just its `owner_address` — this mirrors how `PlansController.attachMetadata` separately resolves `merchant.id` via a second lookup rather than threading it through `resolveCallerOwnerAddress`.

- [ ] **Step 7: Create `CustomersModule`**

Create `apps/api/src/customers/customers.module.ts`:

```typescript
import { Module, forwardRef } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { MerchantsModule } from "../merchants/merchants.module.js";
import { SubscriptionsModule } from "../subscriptions/subscriptions.module.js";
import { CustomersController } from "./customers.controller.js";
import { CustomersService } from "./customers.service.js";

@Module({
  imports: [AuthModule, forwardRef(() => MerchantsModule), SubscriptionsModule],
  controllers: [CustomersController],
  providers: [CustomersService],
})
export class CustomersModule {}
```

`SubscriptionsModule` is imported bare (no `forwardRef`) because this is a one-directional dependency — `SubscriptionsModule` has no reason to ever import `CustomersModule` back, so there is no cycle to break, unlike the existing `AuthModule`/`ApiKeysModule`/`MerchantsModule` three-way cycle (see `PlansModule`/`SubscriptionsModule` for why `MerchantsModule` specifically needs `forwardRef` here — that cycle is unchanged by this task).

- [ ] **Step 8: Register `CustomersModule` in `app.module.ts`**

Add `CustomersModule` to the `imports` array in `apps/api/src/app.module.ts` (alongside `MerchantsModule`, `ApiKeysModule`, `PlansModule`, `SubscriptionsModule`) and add the import statement.

- [ ] **Step 9: Run the customers e2e test suite**

Run: `cd apps/api && npx vitest run --config vitest.e2e.config.ts test/customers.e2e-spec.ts`
Expected: PASS (13/13 tests).

- [ ] **Step 10: Run the full e2e suite to confirm no cross-file regression**

Run: `cd apps/api && npx vitest run --config vitest.e2e.config.ts`
Expected: all 7 spec files pass (31 + 13 = 44 tests), same known pre-existing Testcontainers teardown-noise errors as before (non-blocking, documented in the Phase 1b/1c ledgers), no new failures.

- [ ] **Step 11: Typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 12: Commit**

```bash
git add apps/api/src/customers apps/api/src/subscriptions/subscriptions.module.ts apps/api/src/app.module.ts apps/api/test/customers.e2e-spec.ts
git commit -m "Add customer list, subscriptions, and email-set endpoints"
```

---

## Plan Self-Review Notes

**Spec coverage check:**
- `customer` app table, migrated normally (not excluded like Phase 1c's mirrors) → Task 1. ✓
- `GET /v1/customers` derived from on-chain subscription activity, LEFT JOINed with `customer` for email, `subscription_count` field, secret-key-only, cursor-paginated on address → Task 2. ✓
- `GET /v1/customers/:address/subscriptions` delegating to existing `SubscriptionsService.list()` with `subscriber` filter, either key type, empty list (not 404) for zero subscriptions → Task 2. ✓
- `POST /v1/customers/:address/email` upsert, either key type, no wallet-ownership verification (explicit simplification), works independent of on-chain subscription existing → Task 2. ✓
- Dual-auth (session or API key) on all 3 routes, correct key-type split (secret-only for list, either for the other two) → Task 2, reusing `AuthContextService` + the established `resolveCallerOwnerAddress(request, requireSecret)` pattern from `PlansController`. ✓
- Cursor pagination on customer list, with the address-as-cursor adaptation explicitly called out → Task 2, reusing `buildPageEnvelope`/`parsePaginationQuery` unchanged. ✓
- Testing requirements from spec (ownership scoping for both read endpoints, email present/absent, `subscription_count` correctness, pagination, both key-type directions on all 3 routes, upsert-on-second-call, independent-of-chain-timing, invalid-email rejection) → all present as explicit test cases in Task 2. ✓

**Placeholder scan:** No TBD/TODO markers. Every step has complete, runnable code.

**Type consistency check:** `CustomerSummary` (Task 2) matches the design spec's example response shape (`address`, `email`, `subscription_count`). `CustomersService.setEmail`'s return shape (`{ address, email }`) matches the spec's `POST .../email` response example. `CustomersController.getSubscriptions` reuses `SubscriptionsService.list()`'s existing `SubscriptionSummary` return type unchanged (Phase 1c) — response shape is identical to `GET /v1/subscriptions`'s list response, as the spec requires.

No gaps found requiring a new task.
