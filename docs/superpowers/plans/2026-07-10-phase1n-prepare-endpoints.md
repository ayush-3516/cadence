# Phase 1n: `/v1/prepare/*` Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two read-only helper endpoints to `apps/api` — `GET /v1/prepare/plan` (unsigned `createPlan` calldata) and `GET /v1/prepare/subscribe` (EIP-2612 permit typed-data + a `subscribeWithPermit` calldata template) — unblocking every deferred on-chain-write frontend feature without building any of those frontends yet.

**Architecture:** A new `PrepareModule` in `apps/api/src/prepare/` follows this codebase's existing per-feature module pattern exactly (controller + service + dto + module, registered in `app.module.ts`). `/v1/prepare/plan` is pure calldata encoding — no DB, no chain read. `/v1/prepare/subscribe` reuses `PlansService.getByOnchainId`'s existing ownership check unmodified, then reads the plan's payment token live via a new viem `createPublicClient` (the first on-chain read client `apps/api` has ever needed) to build a real EIP-2612 permit domain and nonce.

**Tech Stack:** NestJS 11 + Fastify (existing `apps/api` conventions), viem 2.x (new dependency for `apps/api`, already used at the same version by `apps/worker`/`apps/indexer`/`apps/web`), Zod (existing `nestjs-zod` conventions), Vitest (existing conventions — both plain unit tests and testcontainers-backed `*.e2e-spec.ts` files, per this app's established split).

## Global Constraints

- No 0xSplits SDK, ABI, factory address, or on-chain validation of `payoutSplit` anywhere in this phase — `SubscriptionManager` is split-agnostic and accepts any address; the spec confirmed this is out of scope.
- No `packages/shared/chains.ts` — this phase mirrors `apps/worker/src/config.ts`'s existing `deployments/<chainId>.json` read pattern exactly, keyed by an `apps/api`-local `CHAIN_ID` env var.
- No frontend code (dashboard or portal) consumes these endpoints in this phase — that's future work.
- `/v1/prepare/plan` requires a secret key (`@RequireKeyType("secret")`). `/v1/prepare/subscribe` accepts session, secret, or publishable (no restriction decorator), matching `PlansController.list`/`getByOnchainId`'s existing default.
- `/v1/prepare/subscribe`'s `owner` query param (the subscriber's wallet) is explicit and independent of the caller's auth identity (which identifies the merchant whose publishable key is calling, used only for the ownership check).
- Both endpoints are pure functions of their inputs — no writes, no side effects, no state mutation anywhere in this phase.
- All new viem/chain-read code must be unit-testable without a live RPC call — the viem public client is injected via NestJS DI (a new token, mirroring `DB_CLIENT`'s `Symbol()` pattern in `apps/api/src/db/db.module.ts`) so both a plain unit test and the e2e-spec can substitute a fake client.

---

### Task 1: ERC-2612 permit ABI in `packages/shared`

**Files:**
- Create: `packages/shared/abis/Erc20Permit.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/abis-only.ts`
- Test: `packages/shared/test/erc20-permit-abi.test.ts`

**Interfaces:**
- Produces: `erc20PermitAbi` — a viem-shaped ABI array (same JSON-ABI-fragment style as `packages/shared/abis/SubscriptionManager.ts`) exposing `name()`, `nonces(address)`, and `permit(address,address,uint256,uint256,uint8,bytes32,bytes32)`. Exported from both `@cadence/shared` (main barrel) and `@cadence/shared/abis` (browser-safe subpath). Consumed by Task 4's `PrepareService`.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/erc20-permit-abi.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { erc20PermitAbi } from "../abis/Erc20Permit.js";

describe("erc20PermitAbi", () => {
  it("includes name, nonces, and permit function fragments", () => {
    const functionNames = erc20PermitAbi
      .filter((entry) => entry.type === "function")
      .map((entry) => entry.name);

    expect(functionNames).toContain("name");
    expect(functionNames).toContain("nonces");
    expect(functionNames).toContain("permit");
  });

  it("defines nonces as taking one address input and returning one uint256", () => {
    const nonces = erc20PermitAbi.find((entry) => entry.type === "function" && entry.name === "nonces");
    expect(nonces).toBeDefined();
    // @ts-expect-error -- narrowed by the find() above at runtime
    expect(nonces.inputs).toEqual([{ name: "owner", type: "address", internalType: "address" }]);
    // @ts-expect-error -- narrowed by the find() above at runtime
    expect(nonces.outputs).toEqual([{ name: "", type: "uint256", internalType: "uint256" }]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/shared && npx vitest run test/erc20-permit-abi.test.ts`
Expected: FAIL — `../abis/Erc20Permit.js` does not exist.

- [ ] **Step 3: Implement the ABI**

Create `packages/shared/abis/Erc20Permit.ts`:

```typescript
// Minimal EIP-2612 permit ABI fragment — only the functions this codebase's
// /v1/prepare/subscribe endpoint needs to read (name, nonces) or reference
// (permit, for calldata shape parity with SubscriptionManager's own ABI
// style). `version()` (EIP-5267) is deliberately NOT included here — not
// every ERC-20 exposes it uniformly, so PrepareService reads it via a raw
// eth_call with a one-off inline ABI fragment and falls back to "1" on
// revert, rather than depending on a function that might not exist.
export const erc20PermitAbi = [
  {
    type: "function",
    name: "name",
    inputs: [],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "nonces",
    inputs: [{ name: "owner", type: "address", internalType: "address" }],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "permit",
    inputs: [
      { name: "owner", type: "address", internalType: "address" },
      { name: "spender", type: "address", internalType: "address" },
      { name: "value", type: "uint256", internalType: "uint256" },
      { name: "deadline", type: "uint256", internalType: "uint256" },
      { name: "v", type: "uint8", internalType: "uint8" },
      { name: "r", type: "bytes32", internalType: "bytes32" },
      { name: "s", type: "bytes32", internalType: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/shared && npx vitest run test/erc20-permit-abi.test.ts`
Expected: PASS (2/2 tests).

- [ ] **Step 5: Export from both barrels**

Modify `packages/shared/src/index.ts` — read the current file first (it exports `subscriptionManagerAbi`, `feeRegistryAbi`, `encryptSecret`, `decryptSecret`) and add:

```typescript
export { erc20PermitAbi } from "../abis/Erc20Permit.js";
```

Modify `packages/shared/src/abis-only.ts` — read the current file first (it exports `subscriptionManagerAbi`, `feeRegistryAbi` for browser consumers) and add the same line:

```typescript
export { erc20PermitAbi } from "../abis/Erc20Permit.js";
```

- [ ] **Step 6: Typecheck**

Run: `cd packages/shared && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Run the full packages/shared suite to confirm no regression**

Run: `cd packages/shared && npx vitest run`
Expected: all pre-existing tests pass plus the 2 new ones.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/abis/Erc20Permit.ts packages/shared/src/index.ts packages/shared/src/abis-only.ts packages/shared/test/erc20-permit-abi.test.ts
git commit -m "Add ERC-2612 permit ABI to packages/shared"
```

---

### Task 2: `apps/api` config — `CHAIN_ID`, `RPC_URL_HTTP`, deployment address loading

**Files:**
- Create: `apps/api/src/config/prepare-config.ts`
- Test: `apps/api/test/prepare-config.test.ts`

**Interfaces:**
- Produces: `loadPrepareConfig(): PrepareConfig` where `PrepareConfig = { chainId: number; rpcUrlHttp: string; subscriptionManagerAddress: `0x${string}` }`. Consumed by Task 3 (rpc-client) and Task 4/5 (services need `subscriptionManagerAddress`/`chainId`).
- Consumes: `deployments/<chainId>.json` on disk (already exists at repo root, e.g. `deployments/84532.json` with a `subscriptionManager` field) — same file `apps/worker/src/config.ts` reads.

This mirrors `apps/worker/src/config.ts`'s `loadConfig()` pattern (same `requireEnv`/`readFileSync`/`path.resolve` approach) but scoped to only what `apps/api`'s prepare endpoints need — not a full config object, since `apps/api` has its own existing `ConfigModule`-based settings for everything else (DB URL, JWT secret, etc. are read via `@nestjs/config`'s `ConfigService`, not this file).

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/prepare-config.test.ts`:

```typescript
import { describe, expect, it, afterEach } from "vitest";
import { loadPrepareConfig } from "../src/config/prepare-config.js";

describe("loadPrepareConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("throws when CHAIN_ID is missing", () => {
    delete process.env.CHAIN_ID;
    process.env.RPC_URL_HTTP = "http://localhost:8545";
    expect(() => loadPrepareConfig()).toThrow("Missing required environment variable: CHAIN_ID");
  });

  it("throws when RPC_URL_HTTP is missing", () => {
    process.env.CHAIN_ID = "84532";
    delete process.env.RPC_URL_HTTP;
    expect(() => loadPrepareConfig()).toThrow("Missing required environment variable: RPC_URL_HTTP");
  });

  it("loads chainId, rpcUrlHttp, and the deployment's subscriptionManager address for chain 84532", () => {
    process.env.CHAIN_ID = "84532";
    process.env.RPC_URL_HTTP = "http://localhost:8545";

    const config = loadPrepareConfig();

    expect(config.chainId).toBe(84532);
    expect(config.rpcUrlHttp).toBe("http://localhost:8545");
    expect(config.subscriptionManagerAddress).toBe("0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run test/prepare-config.test.ts`
Expected: FAIL — `../src/config/prepare-config.js` does not exist.

- [ ] **Step 3: Implement `loadPrepareConfig`**

Create `apps/api/src/config/prepare-config.ts`:

```typescript
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface PrepareConfig {
  chainId: number;
  rpcUrlHttp: string;
  subscriptionManagerAddress: `0x${string}`;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadPrepareConfig(): PrepareConfig {
  const chainId = Number(requireEnv("CHAIN_ID"));
  const rpcUrlHttp = requireEnv("RPC_URL_HTTP");

  const deploymentPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../deployments",
    `${chainId}.json`,
  );
  const deployment = JSON.parse(readFileSync(deploymentPath, "utf-8")) as { subscriptionManager: string };

  return {
    chainId,
    rpcUrlHttp,
    subscriptionManagerAddress: deployment.subscriptionManager as `0x${string}`,
  };
}
```

Note the path depth: `apps/worker/src/config.ts` resolves `"../../../deployments"` from `apps/worker/src/config.ts` (3 levels up: `src` → `worker` → `apps` → repo root). This file lives one directory deeper (`apps/api/src/config/prepare-config.ts`), so it needs 4 levels up (`"../../../../deployments"`): `config` → `src` → `api` → `apps` → repo root.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run test/prepare-config.test.ts`
Expected: PASS (3/3 tests).

- [ ] **Step 5: Typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/config/prepare-config.ts apps/api/test/prepare-config.test.ts
git commit -m "Add CHAIN_ID/RPC_URL_HTTP config loader to apps/api"
```

---

### Task 3: viem dependency + injectable public client for `apps/api`

**Files:**
- Modify: `apps/api/package.json`
- Create: `apps/api/src/prepare/rpc-client.module.ts`
- Test: none (this task wires DI plumbing with no branching logic of its own; Task 4/5's service tests cover the client's actual usage via injected fakes)

**Interfaces:**
- Produces: `PREPARE_RPC_CLIENT` — a DI token (Symbol), and `PrepareRpcClientModule` — a `@Global()` NestJS module providing a viem `PublicClient` instance under that token, constructed from `loadPrepareConfig()`'s `rpcUrlHttp`. Consumed by Task 4/5's `PrepareService` via constructor injection (`@Inject(PREPARE_RPC_CLIENT)`).

`apps/api` has no viem dependency today — `apps/worker`, `apps/indexer`, and `apps/web` all pin `"viem": "^2.21.3"` (worker/indexer) or `"^2.21.0"` (web). This task adds the same floor to `apps/api`.

- [ ] **Step 1: Add viem to apps/api's dependencies**

Modify `apps/api/package.json` — read the current file first, then add `"viem": "^2.21.3"` to the `"dependencies"` object (matching `apps/worker`'s exact version floor, for consistency across the two processes that both talk to the same chain):

```json
    "@cadence/db": "workspace:*",
    "@cadence/shared": "workspace:*",
    "viem": "^2.21.3"
```

(Insert alongside the existing `@cadence/db`/`@cadence/shared` lines — exact position doesn't matter, `pnpm-lock.yaml` regenerates either way.)

- [ ] **Step 2: Install**

Run: `pnpm install` (from repo root)
Expected: `pnpm-lock.yaml` updates to include `viem` under `apps/api`'s dependency tree; exit 0.

- [ ] **Step 3: Create the injectable public client module**

Create `apps/api/src/prepare/rpc-client.module.ts`:

```typescript
import { Global, Module } from "@nestjs/common";
import { createPublicClient, http, type PublicClient } from "viem";
import { loadPrepareConfig } from "../config/prepare-config.js";

export const PREPARE_RPC_CLIENT = Symbol("PREPARE_RPC_CLIENT");

// Global + a dedicated Symbol token (mirrors DB_CLIENT in ../db/db.module.ts)
// so PrepareService's tests can inject a fake PublicClient via
// overrideProvider(PREPARE_RPC_CLIENT) instead of hitting a live RPC endpoint.
@Global()
@Module({
  providers: [
    {
      provide: PREPARE_RPC_CLIENT,
      useFactory: (): PublicClient => {
        const config = loadPrepareConfig();
        return createPublicClient({ transport: http(config.rpcUrlHttp) });
      },
    },
  ],
  exports: [PREPARE_RPC_CLIENT],
})
export class RpcClientModule {}
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/prepare/rpc-client.module.ts
git commit -m "Add viem dependency and injectable public client to apps/api"
```

---

### Task 4: `GET /v1/prepare/plan`

**Files:**
- Create: `apps/api/src/prepare/prepare.dto.ts`
- Create: `apps/api/src/prepare/prepare.service.ts`
- Create: `apps/api/src/prepare/prepare.controller.ts`
- Create: `apps/api/src/prepare/prepare.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/prepare.e2e-spec.ts` (created in this task, extended in Task 5)

**Interfaces:**
- Consumes: `subscriptionManagerAbi` from `@cadence/shared`; `loadPrepareConfig` from Task 2; `AuthContextService`/`MerchantsService`/`RequireKeyType` (existing, from `../auth/`).
- Produces: `PrepareService.buildCreatePlanCalldata(params: PreparePlanQuery): PreparePlanResponse` where `PreparePlanResponse = { to: string; data: string; value: "0" }`. Also produces the `PrepareController` class (`@Controller("v1/prepare")`) and `PrepareModule`, which Task 5 extends with the `/subscribe` route and its own service method on the same `PrepareService`/`PrepareController`.

- [ ] **Step 1: Write the DTO and its validation test**

Create `apps/api/src/prepare/prepare.dto.ts`:

```typescript
import { z } from "zod";

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "must be a 20-byte hex address");
const uintStringSchema = z.string().regex(/^[0-9]+$/, "must be a non-negative integer string");

export const PreparePlanQuerySchema = z.object({
  payoutSplit: addressSchema,
  token: addressSchema,
  amount: uintStringSchema,
  period: uintStringSchema,
  trial: uintStringSchema,
});
export type PreparePlanQuery = z.infer<typeof PreparePlanQuerySchema>;

export const PrepareSubscribeQuerySchema = z.object({
  planId: z.string().min(1),
  owner: addressSchema,
});
export type PrepareSubscribeQuery = z.infer<typeof PrepareSubscribeQuerySchema>;
```

Create `apps/api/test/prepare-dto.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { PreparePlanQuerySchema, PrepareSubscribeQuerySchema } from "../src/prepare/prepare.dto.js";

describe("PreparePlanQuerySchema", () => {
  const validParams = {
    payoutSplit: "0xdef0000000000000000000000000000000000b",
    token: "0x0000000000000000000000000000000000000c",
    amount: "20000000",
    period: "2592000",
    trial: "0",
  };

  it("accepts a fully valid query", () => {
    expect(PreparePlanQuerySchema.safeParse(validParams).success).toBe(true);
  });

  it("rejects a malformed address", () => {
    const result = PreparePlanQuerySchema.safeParse({ ...validParams, payoutSplit: "not-an-address" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-numeric amount", () => {
    const result = PreparePlanQuerySchema.safeParse({ ...validParams, amount: "abc" });
    expect(result.success).toBe(false);
  });

  it("rejects a negative period", () => {
    const result = PreparePlanQuerySchema.safeParse({ ...validParams, period: "-5" });
    expect(result.success).toBe(false);
  });
});

describe("PrepareSubscribeQuerySchema", () => {
  it("accepts a valid query", () => {
    const result = PrepareSubscribeQuerySchema.safeParse({ planId: "1", owner: "0xdef0000000000000000000000000000000000b" });
    expect(result.success).toBe(true);
  });

  it("rejects a malformed owner address", () => {
    const result = PrepareSubscribeQuerySchema.safeParse({ planId: "1", owner: "not-an-address" });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run test/prepare-dto.test.ts`
Expected: FAIL — `../src/prepare/prepare.dto.js` does not exist.

- [ ] **Step 3: Run it again after creating the DTO file above to verify it passes**

Run: `cd apps/api && npx vitest run test/prepare-dto.test.ts`
Expected: PASS (6/6 tests).

- [ ] **Step 4: Write the service**

Create `apps/api/src/prepare/prepare.service.ts`:

```typescript
import { Injectable } from "@nestjs/common";
import { encodeFunctionData } from "viem";
import { subscriptionManagerAbi } from "@cadence/shared";
import { loadPrepareConfig } from "../config/prepare-config.js";
import type { PreparePlanQuery } from "./prepare.dto.js";

export interface PreparePlanResponse {
  to: string;
  data: string;
  value: "0";
}

@Injectable()
export class PrepareService {
  buildCreatePlanCalldata(params: PreparePlanQuery): PreparePlanResponse {
    const config = loadPrepareConfig();

    const data = encodeFunctionData({
      abi: subscriptionManagerAbi,
      functionName: "createPlan",
      args: [
        params.payoutSplit as `0x${string}`,
        params.token as `0x${string}`,
        BigInt(params.amount),
        Number(params.period),
        Number(params.trial),
      ],
    });

    return { to: config.subscriptionManagerAddress, data, value: "0" };
  }
}
```

- [ ] **Step 5: Write the controller**

Create `apps/api/src/prepare/prepare.controller.ts`:

```typescript
import { Controller, Get, Query } from "@nestjs/common";
import { RequireKeyType } from "../auth/require-key-type.decorator.js";
import { PrepareService } from "./prepare.service.js";
import { PreparePlanQuerySchema } from "./prepare.dto.js";

@Controller("v1/prepare")
export class PrepareController {
  constructor(private readonly prepareService: PrepareService) {}

  @Get("plan")
  @RequireKeyType("secret")
  plan(@Query() query: Record<string, string>) {
    const params = PreparePlanQuerySchema.parse(query);
    return this.prepareService.buildCreatePlanCalldata(params);
  }
}
```

`PreparePlanQuerySchema.parse` throws a Zod `ZodError` on invalid input, not an `AppException` — this codebase's global `AppExceptionFilter` (registered in `app.module.ts` via `APP_FILTER`) only formats `AppException` instances into the `{error: {...}}` envelope. Checking `apps/api/src/common/http-exception.filter.ts`'s exact behavior for non-`AppException` errors is out of scope for this task (Nest's default exception handling still returns a 500 with a generic body for uncaught errors, which is an acceptable outcome for malformed query params in this phase — no task in this plan promises structured 400s beyond what the DTO schema naturally produces via NestJS's built-in behavior). This mirrors `plans.controller.ts`'s existing use of `AppException` only for domain-level errors (not param parsing), so no new error-handling infrastructure is introduced here.

- [ ] **Step 6: Write the module**

Create `apps/api/src/prepare/prepare.module.ts`:

```typescript
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { MerchantsModule } from "../merchants/merchants.module.js";
import { RpcClientModule } from "./rpc-client.module.js";
import { PrepareController } from "./prepare.controller.js";
import { PrepareService } from "./prepare.service.js";

@Module({
  imports: [AuthModule, MerchantsModule, RpcClientModule],
  controllers: [PrepareController],
  providers: [PrepareService],
})
export class PrepareModule {}
```

(`AuthModule`/`MerchantsModule` are imported now even though `/v1/prepare/plan` alone doesn't need merchant resolution — `@RequireKeyType("secret")` reads metadata NestJS's `Reflector` resolves without needing `AuthContextService` injected into `PrepareController` yet. Task 5 wires the ownership-check plumbing that actually uses them.)

- [ ] **Step 7: Register the module in app.module.ts**

Modify `apps/api/src/app.module.ts` — read the current file first, then add the import and registration:

```typescript
import { PrepareModule } from "./prepare/prepare.module.js";
```

Add `PrepareModule` to the `imports` array (after `AnalyticsModule`, matching the file's existing append-at-end convention):

```typescript
    AnalyticsModule,
    PrepareModule,
```

- [ ] **Step 8: Typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 9: Write the e2e spec for /v1/prepare/plan**

Create `apps/api/test/prepare.e2e-spec.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import request from "supertest";
import { Wallet } from "ethers";
import { SiweMessage } from "siwe";
import fastifyCookie from "@fastify/cookie";
import { decodeFunctionData } from "viem";
import { subscriptionManagerAbi } from "@cadence/shared";
import { createDbClient, type DbClient } from "@cadence/db";
import { AppModule } from "../src/app.module.js";
import { startTestDatabase, stopTestDatabase } from "./setup.js";

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

  await request(server).post("/v1/merchants").set("Cookie", cookie).send({ name: "Prepare Test Co", ownerAddress: wallet.address });

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

describe("Prepare", () => {
  let app: NestFastifyApplication;
  let server: Server;
  let db: DbClient;

  beforeAll(async () => {
    const connectionUri = await startTestDatabase();
    process.env.DATABASE_URL = connectionUri;
    process.env.JWT_SECRET = "test-secret";
    process.env.WEBHOOK_SIGNING_ROTATION_KEY = "test-rotation-key-0123456789abcd";
    process.env.CHAIN_ID = "84532";
    process.env.RPC_URL_HTTP = "http://127.0.0.1:1"; // unused by /v1/prepare/plan; /subscribe's coverage in Task 5 overrides the client via DI instead of relying on this being reachable
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

  it("returns createPlan calldata that decodes back to the given params", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const secretKey = await createSecretKey(server, cookie);

    const response = await request(server)
      .get("/v1/prepare/plan")
      .set("Authorization", `Bearer ${secretKey}`)
      .query({
        payoutSplit: "0xdef0000000000000000000000000000000000b",
        token: "0x0000000000000000000000000000000000000c",
        amount: "20000000",
        period: "2592000",
        trial: "0",
      });

    expect(response.status).toBe(200);
    expect(response.body.value).toBe("0");
    expect(response.body.to).toBe("0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9");

    const decoded = decodeFunctionData({ abi: subscriptionManagerAbi, data: response.body.data });
    expect(decoded.functionName).toBe("createPlan");
    expect(decoded.args).toEqual(["0xdef0000000000000000000000000000000000b", "0x0000000000000000000000000000000000000c", 20000000n, 2592000, 0]);
  });

  it("rejects a publishable key on GET /v1/prepare/plan", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const pubKey = await createPublishableKey(server, cookie);

    const response = await request(server)
      .get("/v1/prepare/plan")
      .set("Authorization", `Bearer ${pubKey}`)
      .query({
        payoutSplit: "0xdef0000000000000000000000000000000000b",
        token: "0x0000000000000000000000000000000000000c",
        amount: "20000000",
        period: "2592000",
        trial: "0",
      });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("key_type_not_allowed");
  });

  it("returns a 400-range error for a malformed address", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const secretKey = await createSecretKey(server, cookie);

    const response = await request(server)
      .get("/v1/prepare/plan")
      .set("Authorization", `Bearer ${secretKey}`)
      .query({
        payoutSplit: "not-an-address",
        token: "0x0000000000000000000000000000000000000c",
        amount: "20000000",
        period: "2592000",
        trial: "0",
      });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});
```

- [ ] **Step 10: Run the e2e spec**

Run: `cd apps/api && npx vitest run --config vitest.e2e.config.ts test/prepare.e2e-spec.ts`
Expected: PASS (3/3 tests). This starts a real Postgres testcontainer — allow extra time on first run for the image pull.

- [ ] **Step 11: Run the full apps/api unit + e2e suites to confirm no regression**

Run: `cd apps/api && npx vitest run && npx vitest run --config vitest.e2e.config.ts`
Expected: all pre-existing tests pass plus this task's new ones.

- [ ] **Step 12: Commit**

```bash
git add apps/api/src/prepare apps/api/src/app.module.ts apps/api/test/prepare-dto.test.ts apps/api/test/prepare.e2e-spec.ts
git commit -m "Add GET /v1/prepare/plan endpoint"
```

---

### Task 5: `GET /v1/prepare/subscribe`

**Files:**
- Modify: `apps/api/src/prepare/prepare.service.ts`
- Modify: `apps/api/src/prepare/prepare.controller.ts`
- Modify: `apps/api/src/prepare/prepare.module.ts`
- Modify: `apps/api/test/prepare.e2e-spec.ts`

**Interfaces:**
- Consumes: `PlansService.getByOnchainId` (existing, from `../plans/plans.service.js`, exported by `PlansModule`); `erc20PermitAbi` from `@cadence/shared` (Task 1); `PREPARE_RPC_CLIENT` token (Task 3); `AuthContextService`/`MerchantsService` (existing, same pattern as `PlansController.resolveCallerOwnerAddress`).
- Produces: `PrepareService.buildSubscribePermit(callerOwnerAddress: string, params: PrepareSubscribeQuery): Promise<PrepareSubscribeResponse>` where the response shape matches the spec's documented JSON exactly (see Step 3 below). This is the FINAL task of this phase.

- [ ] **Step 1: Add PlansModule and PREPARE_RPC_CLIENT to prepare.module.ts's imports**

Modify `apps/api/src/prepare/prepare.module.ts`:

```typescript
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { MerchantsModule } from "../merchants/merchants.module.js";
import { PlansModule } from "../plans/plans.module.js";
import { RpcClientModule } from "./rpc-client.module.js";
import { PrepareController } from "./prepare.controller.js";
import { PrepareService } from "./prepare.service.js";

@Module({
  imports: [AuthModule, MerchantsModule, PlansModule, RpcClientModule],
  controllers: [PrepareController],
  providers: [PrepareService],
})
export class PrepareModule {}
```

- [ ] **Step 2: Extend PrepareService with the token-reading permit builder**

Modify `apps/api/src/prepare/prepare.service.ts` — replace the full file:

```typescript
import { Inject, Injectable } from "@nestjs/common";
import { encodeFunctionData, type PublicClient } from "viem";
import { subscriptionManagerAbi, erc20PermitAbi } from "@cadence/shared";
import { loadPrepareConfig } from "../config/prepare-config.js";
import { PREPARE_RPC_CLIENT } from "./rpc-client.module.js";
import { PlansService } from "../plans/plans.service.js";
import type { PreparePlanQuery, PrepareSubscribeQuery } from "./prepare.dto.js";

export interface PreparePlanResponse {
  to: string;
  data: string;
  value: "0";
}

export interface PrepareSubscribeResponse {
  permit: {
    domain: { name: string; version: string; chainId: number; verifyingContract: string };
    types: { Permit: { name: string; type: string }[] };
    message: { owner: string; spender: string; value: string; nonce: string; deadline: string };
  };
  subscribe: { to: string; fn: "subscribeWithPermit"; planId: string; deadline: string };
}

const PERMIT_DEADLINE_SECONDS = 15 * 60;

const VERSION_ABI = [
  { type: "function", name: "version", inputs: [], outputs: [{ name: "", type: "string" }], stateMutability: "view" },
] as const;

@Injectable()
export class PrepareService {
  constructor(
    @Inject(PREPARE_RPC_CLIENT) private readonly publicClient: PublicClient,
    private readonly plansService: PlansService,
  ) {}

  buildCreatePlanCalldata(params: PreparePlanQuery): PreparePlanResponse {
    const config = loadPrepareConfig();

    const data = encodeFunctionData({
      abi: subscriptionManagerAbi,
      functionName: "createPlan",
      args: [
        params.payoutSplit as `0x${string}`,
        params.token as `0x${string}`,
        BigInt(params.amount),
        Number(params.period),
        Number(params.trial),
      ],
    });

    return { to: config.subscriptionManagerAddress, data, value: "0" };
  }

  async buildSubscribePermit(callerOwnerAddress: string, params: PrepareSubscribeQuery): Promise<PrepareSubscribeResponse> {
    const config = loadPrepareConfig();
    const plan = await this.plansService.getByOnchainId(callerOwnerAddress, params.planId);

    const tokenAddress = plan.token as `0x${string}`;
    const owner = params.owner as `0x${string}`;

    const [name, nonce] = await Promise.all([
      this.publicClient.readContract({ address: tokenAddress, abi: erc20PermitAbi, functionName: "name" }),
      this.publicClient.readContract({ address: tokenAddress, abi: erc20PermitAbi, functionName: "nonces", args: [owner] }),
    ]);

    let version = "1";
    try {
      version = await this.publicClient.readContract({ address: tokenAddress, abi: VERSION_ABI, functionName: "version" });
    } catch {
      // Not every ERC-20 exposes version() (EIP-5267 is not universal) — "1" is
      // the EIP-2612 reference implementation's default and a safe fallback.
    }

    const deadline = String(Math.floor(Date.now() / 1000) + PERMIT_DEADLINE_SECONDS);

    return {
      permit: {
        domain: { name, version, chainId: config.chainId, verifyingContract: tokenAddress },
        types: {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        message: {
          owner,
          spender: config.subscriptionManagerAddress,
          value: plan.amount,
          nonce: nonce.toString(),
          deadline,
        },
      },
      subscribe: {
        to: config.subscriptionManagerAddress,
        fn: "subscribeWithPermit",
        planId: params.planId,
        deadline,
      },
    };
  }
}
```

- [ ] **Step 3: Add the controller route**

Modify `apps/api/src/prepare/prepare.controller.ts` — replace the full file:

```typescript
import { Controller, Get, Query, Req } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { AuthContextService } from "../auth/auth-context.service.js";
import { RequireKeyType } from "../auth/require-key-type.decorator.js";
import { MerchantsService } from "../merchants/merchants.service.js";
import { AppException } from "../common/errors.js";
import { PrepareService } from "./prepare.service.js";
import { PreparePlanQuerySchema, PrepareSubscribeQuerySchema } from "./prepare.dto.js";

@Controller("v1/prepare")
export class PrepareController {
  constructor(
    private readonly prepareService: PrepareService,
    private readonly authContext: AuthContextService,
    private readonly merchantsService: MerchantsService,
  ) {}

  @Get("plan")
  @RequireKeyType("secret")
  plan(@Query() query: Record<string, string>) {
    const params = PreparePlanQuerySchema.parse(query);
    return this.prepareService.buildCreatePlanCalldata(params);
  }

  @Get("subscribe")
  async subscribe(@Query() query: Record<string, string>, @Req() request: FastifyRequest) {
    const params = PrepareSubscribeQuerySchema.parse(query);

    const auth = await this.authContext.resolve(request);
    const callerOwnerAddress =
      auth.keyType === "session"
        ? auth.ownerAddress
        : (await this.resolveMerchantOwnerAddress(auth)).ownerAddress;

    return this.prepareService.buildSubscribePermit(callerOwnerAddress, params);
  }

  private async resolveMerchantOwnerAddress(auth: { merchantId: string | null }): Promise<{ ownerAddress: string }> {
    const merchant = await this.merchantsService.findByOwnerAddressById(auth.merchantId!);
    if (!merchant) {
      throw new AppException({ type: "invalid_request_error", code: "merchant_not_found", message: "No merchant account found for this API key." });
    }
    return { ownerAddress: merchant.ownerAddress };
  }
}
```

This mirrors `PlansController.resolveCallerOwnerAddress`'s exact logic (session → `auth.ownerAddress` directly; API key → look up the merchant by `auth.merchantId`) but inlined here rather than imported, since `PlansController`'s version is a `private` method not exported for reuse — duplicating this small, stable auth-resolution snippet matches this codebase's existing pattern (`SubscriptionsController` has its own near-identical copy too; check `apps/api/src/subscriptions/subscriptions.controller.ts` if you want to confirm this precedent before implementing).

- [ ] **Step 4: Typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Extend the e2e spec with /v1/prepare/subscribe tests**

Modify `apps/api/test/prepare.e2e-spec.ts` — add these imports at the top (alongside the existing ones):

```typescript
import type { INestApplication } from "@nestjs/common";
import { PREPARE_RPC_CLIENT } from "../src/prepare/rpc-client.module.js";
import { seedOnchainPlan } from "./setup.js";
```

Change the `Test.createTestingModule({...}).compile()` call in `beforeAll` to override the RPC client with a fake, so this test never makes a real network call:

```typescript
    const fakePublicClient = {
      readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
        if (functionName === "name") return "Test USD Coin";
        if (functionName === "version") return "2";
        if (functionName === "nonces") return 7n;
        throw new Error(`Unexpected readContract call: ${functionName}`);
      },
    };

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PREPARE_RPC_CLIENT)
      .useValue(fakePublicClient)
      .compile();
```

(This replaces the existing plain `const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();` line from Task 4's version of this file.)

Add these tests inside the existing `describe("Prepare", ...)` block, after the three `/v1/prepare/plan` tests:

```typescript
  it("returns permit typed-data and a subscribe template for a plan the caller's key owns", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const plan = await seedOnchainPlan(db, { merchantAddress: ownerAddress, amount: "5000000", token: "0x1234000000000000000000000000000000000e" });
    const pubKey = await createPublishableKey(server, cookie);
    const subscriberOwner = "0x9999000000000000000000000000000000000f";

    const response = await request(server)
      .get("/v1/prepare/subscribe")
      .set("Authorization", `Bearer ${pubKey}`)
      .query({ planId: plan.onchainPlanId, owner: subscriberOwner });

    expect(response.status).toBe(200);
    expect(response.body.permit.domain).toEqual({
      name: "Test USD Coin",
      version: "2",
      chainId: 84532,
      verifyingContract: "0x1234000000000000000000000000000000000e",
    });
    expect(response.body.permit.message).toEqual({
      owner: subscriberOwner,
      spender: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
      value: "5000000",
      nonce: "7",
      deadline: response.body.permit.message.deadline,
    });
    expect(response.body.subscribe).toEqual({
      to: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
      fn: "subscribeWithPermit",
      planId: plan.onchainPlanId,
      deadline: response.body.permit.message.deadline,
    });
  });

  it("returns 404 for a plan the caller's key does not own", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const otherPlan = await seedOnchainPlan(db, { merchantAddress: "0x1111111111111111111111111111111111111a" });
    const pubKey = await createPublishableKey(server, cookie);

    const response = await request(server)
      .get("/v1/prepare/subscribe")
      .set("Authorization", `Bearer ${pubKey}`)
      .query({ planId: otherPlan.onchainPlanId, owner: "0x9999000000000000000000000000000000000f" });

    expect(response.status).toBe(404);
  });

  it("accepts a secret key on GET /v1/prepare/subscribe too", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const plan = await seedOnchainPlan(db, { merchantAddress: ownerAddress });
    const secretKey = await createSecretKey(server, cookie);

    const response = await request(server)
      .get("/v1/prepare/subscribe")
      .set("Authorization", `Bearer ${secretKey}`)
      .query({ planId: plan.onchainPlanId, owner: "0x9999000000000000000000000000000000000f" });

    expect(response.status).toBe(200);
  });
```

- [ ] **Step 6: Run the e2e spec**

Run: `cd apps/api && npx vitest run --config vitest.e2e.config.ts test/prepare.e2e-spec.ts`
Expected: PASS (6/6 tests — 3 from Task 4, 3 new).

- [ ] **Step 7: Run the full apps/api unit + e2e suites one final time**

Run: `cd apps/api && npx vitest run && npx vitest run --config vitest.e2e.config.ts`
Expected: all tests pass across both suites, no regressions.

- [ ] **Step 8: Run the full packages/shared suite to confirm it's unaffected**

Run: `cd packages/shared && npx vitest run`
Expected: unchanged from Task 1's count (this task doesn't touch `packages/shared`).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/prepare apps/api/test/prepare.e2e-spec.ts
git commit -m "Add GET /v1/prepare/subscribe endpoint"
```

---

## Plan Self-Review Notes

**Spec coverage check:**
- `GET /v1/prepare/plan` (secret key, pure calldata encoding, no DB/chain reads, address/deployment sourcing from `deployments/<chainId>.json`) → Tasks 2, 4. ✓
- `GET /v1/prepare/subscribe` (publishable-key OK, DB-backed plan lookup reusing `PlansService.getByOnchainId`'s ownership check, live token `name`/`version`/`nonces` reads, EIP-2612 typed-data + subscribe template response) → Task 5. ✓
- New ERC-2612 permit ABI in `packages/shared`, dual-exported (main barrel + `./abis` subpath) → Task 1. ✓
- No 0xSplits code anywhere → confirmed no task introduces any 0xSplits SDK, ABI, or address. ✓
- No `packages/shared/chains.ts` → confirmed Task 2 mirrors `apps/worker/src/config.ts`'s existing per-app `deployments/<chainId>.json` read instead. ✓
- New `apps/api` viem public client, injectable/mockable for tests → Task 3 (DI token + module), used via `overrideProvider` in Task 5's e2e spec. ✓
- 15-minute permit deadline → Task 5's `PERMIT_DEADLINE_SECONDS = 15 * 60`. ✓

**Placeholder scan:** No "TBD"/"TODO"/vague requirements. Every step has complete, concrete code, including the full final state of every modified file (Task 5 replaces `prepare.service.ts` and `prepare.controller.ts` in full rather than describing a diff, since Task 4 already established their Task-4-only state).

**Type consistency check:** `PreparePlanQuery`/`PrepareSubscribeQuery` (Task 4's `prepare.dto.ts`) are consumed with identical field names by Task 4/5's `PrepareService` methods and `PrepareController` routes. `PrepareSubscribeResponse`'s shape (Task 5) matches the design spec's documented JSON response exactly (`permit.domain`/`permit.types`/`permit.message`/`subscribe`), field-for-field. `PREPARE_RPC_CLIENT` (Task 3) is the same token imported in both Task 5's `prepare.service.ts` and its e2e spec's `overrideProvider` call. `loadPrepareConfig()`'s `PrepareConfig` shape (Task 2: `chainId`, `rpcUrlHttp`, `subscriptionManagerAddress`) is consumed identically by Task 3's `rpc-client.module.ts` (`rpcUrlHttp`) and Task 4/5's `prepare.service.ts` (`subscriptionManagerAddress`, `chainId`).

**Gap found and fixed during self-review:** the design spec's Testing section assumed `vi.fn()`-mocked unit tests for `/v1/prepare/subscribe`, but `apps/api` has no plain-unit-test convention for controller/service logic that depends on other injected services (`PlansService`, auth) — every existing test of this kind in `apps/api/test/` is a testcontainers-backed `*.e2e-spec.ts` hitting a real HTTP server and real Postgres via supertest, with zero prior use of NestJS's `overrideProvider` anywhere in this codebase. Revised the plan to use that established e2e pattern throughout (Tasks 4 and 5), introducing `overrideProvider(PREPARE_RPC_CLIENT)` as this codebase's first use of that NestJS testing feature — a small, well-precedented extension (the token itself was designed in Task 3 specifically to make this override possible), rather than inventing a parallel unit-testing convention this app doesn't otherwise have. The DTO validation logic (`prepare.dto.ts`) and the config loader (`prepare-config.ts`) still get plain fast unit tests, matching `apps/api/test/pagination.test.ts`'s existing precedent for pure-function logic.
