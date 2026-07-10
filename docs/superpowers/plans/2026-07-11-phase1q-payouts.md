# Phase 1q: Payouts Vertical Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Index 0xSplits Pull-split distribution events into `onchain_payout`, expose them via `GET /v1/payouts`, and show them on a new `/dashboard/payouts` page.

**Architecture:** `apps/indexer` gains a factory-pattern watch on 0xSplits' `PullSplitFactoryV2.2` (to discover every Split address Cadence's own plan-creation wizard ever deploys) plus a fixed-address watch on the shared `SplitsWarehouse` contract. A new indexer-internal `onchain_split` table (Ponder-only, never mirrored into `apps/api`) bridges the factory's discovered addresses to the Warehouse's `Transfer` handler, which is the actual per-recipient payout signal. `apps/api` gains a read-only `PayoutsModule` mirroring `AnalyticsModule`'s structure. `apps/web` gains a read-only `/dashboard/payouts` page mirroring `/dashboard/plans`'s hook+table pattern — no wallet/signing logic anywhere in this phase.

**Tech Stack:** Ponder 0.16.6 (existing, `apps/indexer`'s only indexing framework), viem 2.21/2.54 (existing), NestJS/Zod (existing, `apps/api`), Next.js/TanStack Query (existing, `apps/web`), Vitest (new to `apps/indexer` — this phase adds its first tests).

## Global Constraints

- Only Pull-type 0xSplits splits are indexed, only the `PullSplitFactoryV2.2` factory (`0x6B9118074aB15142d7524E8c4ea8f62A3Bdb98f1` on Base Sepolia, chain 84532) — confirmed as the actual default `@0xsplits/splits-sdk@6.5.0` targets when called with no explicit `splitType`/`version` (matching how Phase 1o's `useCreatePlanSubmit.ts` calls it).
- The `SplitsWarehouse` contract is at the fixed address `0x8fb66F38cF86A3d5e8768f8F1754A24A6c661Fb8` on Base Sepolia.
- A "payout" is the Warehouse's ERC6909 `Transfer` event during a Split's `distribute()` call (the distribution credit), never the later, separate `Withdraw` event — confirmed with the user during brainstorming.
- The discriminator for a genuine payout: the `Transfer` event's `sender` must be a known Split address (one discovered via the factory's `SplitCreated` event) — this requires a new indexer-internal `onchain_split` table (Ponder-only; NOT added to `packages/db/src/onchain-schema.ts`'s mirror, since `apps/api` never needs to query it directly).
- `GET /v1/payouts` requires session or secret key (matches the PRD's `sec` designation and `AnalyticsController`'s `resolveMerchantId` pattern) and scopes results to the calling merchant's own plans via a join on `onchain_plan.payoutSplit`.
- `usdValue` is left `null` on every inserted payout row in this phase — no USD-conversion pipeline exists for payouts yet.
- No write/action UI anywhere in this phase — `/dashboard/payouts` is entirely read-only, matching how `distribute()` itself is permissionless and not something Cadence initiates.
- Ponder's registry/schema imports use the special module specifiers `ponder:registry` and `ponder:schema` (not relative paths) — matching the existing `SubscriptionManager.ts` handler's imports exactly.

---

### Task 1: 0xSplits ABI fragments in `packages/shared`

**Files:**
- Create: `packages/shared/abis/SplitV2Factory.ts`
- Create: `packages/shared/abis/SplitsWarehouse.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/abis-only.ts`
- Test: `packages/shared/test/splits-abis.test.ts`

**Interfaces:**
- Produces: `splitV2FactoryAbi` (exposes the `SplitCreated` event) and `splitsWarehouseAbi` (exposes the `Transfer` event) — viem-shaped ABI arrays, exported from both `@cadence/shared` (main barrel) and `@cadence/shared/abis` (browser-safe subpath, matching `erc20PermitAbi`'s established dual-export precedent from Phase 1n). Consumed by Task 3 (indexer config) and Task 4 (indexer handler).

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/splits-abis.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { splitV2FactoryAbi } from "../abis/SplitV2Factory.js";
import { splitsWarehouseAbi } from "../abis/SplitsWarehouse.js";

describe("splitV2FactoryAbi", () => {
  it("includes the SplitCreated event with a split address and a splitParams tuple", () => {
    const event = splitV2FactoryAbi.find((entry) => entry.type === "event" && entry.name === "SplitCreated");
    expect(event).toBeDefined();
    // @ts-expect-error -- narrowed by the find() above at runtime
    const splitInput = event.inputs.find((i: { name: string }) => i.name === "split");
    expect(splitInput).toEqual({ indexed: true, internalType: "address", name: "split", type: "address" });
  });
});

describe("splitsWarehouseAbi", () => {
  it("includes the ERC6909 Transfer event with sender/receiver/id/amount", () => {
    const event = splitsWarehouseAbi.find((entry) => entry.type === "event" && entry.name === "Transfer");
    expect(event).toBeDefined();
    // @ts-expect-error -- narrowed by the find() above at runtime
    const names = event.inputs.map((i: { name: string }) => i.name);
    expect(names).toEqual(["caller", "sender", "receiver", "id", "amount"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/shared && npx vitest run test/splits-abis.test.ts`
Expected: FAIL — `../abis/SplitV2Factory.js` does not exist.

- [ ] **Step 3: Implement the ABI fragments**

Create `packages/shared/abis/SplitV2Factory.ts`:

```typescript
// Minimal ABI fragment for 0xSplits' PullSplitFactoryV2.2 (Base Sepolia:
// 0x6B9118074aB15142d7524E8c4ea8f62A3Bdb98f1) — only the SplitCreated event,
// used by apps/indexer's factory-pattern config (Task 3) to discover every
// Split address the factory deploys. Confirmed against the installed
// @0xsplits/splits-sdk@6.5.0's own splitV2o2Factory ABI (the exact factory
// version the SDK's SplitV2Client.createSplit() targets by default).
export const splitV2FactoryAbi = [
  {
    type: "event",
    anonymous: false,
    name: "SplitCreated",
    inputs: [
      { indexed: true, internalType: "address", name: "split", type: "address" },
      {
        indexed: false,
        internalType: "struct SplitV2Lib.Split",
        name: "splitParams",
        type: "tuple",
        components: [
          { internalType: "address[]", name: "recipients", type: "address[]" },
          { internalType: "uint256[]", name: "allocations", type: "uint256[]" },
          { internalType: "uint256", name: "totalAllocation", type: "uint256" },
          { internalType: "uint16", name: "distributionIncentive", type: "uint16" },
        ],
      },
      { indexed: false, internalType: "address", name: "owner", type: "address" },
      { indexed: false, internalType: "address", name: "creator", type: "address" },
      { indexed: false, internalType: "bytes32", name: "salt", type: "bytes32" },
    ],
  },
] as const;
```

Create `packages/shared/abis/SplitsWarehouse.ts`:

```typescript
// Minimal ABI fragment for 0xSplits' SplitsWarehouse (Base Sepolia, fixed
// address 0x8fb66F38cF86A3d5e8768f8F1754A24A6c661Fb8) — only the ERC6909
// Transfer event, which fires once per recipient when a Pull split's
// distribute() calls batchTransfer(). Confirmed against the installed
// @0xsplits/splits-sdk@6.5.0's own warehouse ABI.
export const splitsWarehouseAbi = [
  {
    type: "event",
    anonymous: false,
    name: "Transfer",
    inputs: [
      { name: "caller", type: "address", indexed: false, internalType: "address" },
      { name: "sender", type: "address", indexed: true, internalType: "address" },
      { name: "receiver", type: "address", indexed: true, internalType: "address" },
      { name: "id", type: "uint256", indexed: true, internalType: "uint256" },
      { name: "amount", type: "uint256", indexed: false, internalType: "uint256" },
    ],
  },
] as const;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/shared && npx vitest run test/splits-abis.test.ts`
Expected: PASS (2/2 tests).

- [ ] **Step 5: Export from both barrels**

Modify `packages/shared/src/index.ts` — read the current file first, then add:

```typescript
export { splitV2FactoryAbi } from "../abis/SplitV2Factory.js";
export { splitsWarehouseAbi } from "../abis/SplitsWarehouse.js";
```

Modify `packages/shared/src/abis-only.ts` — read the current file first, then add the same two lines.

- [ ] **Step 6: Typecheck**

Run: `cd packages/shared && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Run the full packages/shared suite to confirm no regression**

Run: `cd packages/shared && npx vitest run`
Expected: all pre-existing tests pass, plus this task's 2 new ones.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/abis/SplitV2Factory.ts packages/shared/abis/SplitsWarehouse.ts packages/shared/src/index.ts packages/shared/src/abis-only.ts packages/shared/test/splits-abis.test.ts
git commit -m "Add 0xSplits SplitV2Factory and SplitsWarehouse ABI fragments"
```

---

### Task 2: `onchain_split` Ponder table + `onchain_payout` mirror in `packages/db`

**Files:**
- Modify: `apps/indexer/ponder.schema.ts`
- Modify: `packages/db/src/onchain-schema.ts`
- Create: `packages/db/migrations-onchain/0001_onchain_payout_mirror.sql`

**Interfaces:**
- Produces: `onchainSplit` (new Ponder-only table, `apps/indexer/ponder.schema.ts`) — bridges factory-discovered Split addresses to the Warehouse handler; never mirrored into `packages/db`. `onchainPayout` (new Drizzle mirror, `packages/db/src/onchain-schema.ts`) — matches the `onchain_payout` table `ponder.schema.ts` already defines (from an earlier phase), so `apps/api` can query it. Consumed by Task 4 (indexer handler) and Task 5 (`apps/api`'s `PayoutsService`).

- [ ] **Step 1: Add `onchainSplit` to the indexer's Ponder schema**

Modify `apps/indexer/ponder.schema.ts` — read the current file first (it already defines `onchainPlan`, `onchainSubscription`, `onchainCharge`, `onchainPayout`), then add:

```typescript
// Indexer-internal only — bridges Split addresses discovered via
// PullSplitFactoryV2.2's SplitCreated event (Task 3/4) to the
// SplitsWarehouse Transfer handler (Task 4), which needs to check whether
// a Transfer's `sender` is a known Split before recording it as a payout.
// Never mirrored into packages/db/src/onchain-schema.ts — apps/api never
// queries this table directly, only onchain_payout.
export const onchainSplit = onchainTable("onchain_split", (t) => ({
  address: t.text("address").primaryKey(),
  chainId: t.integer("chain_id").notNull(),
  createdAt: t.timestamp("created_at", { withTimezone: true }),
}));
```

(The `onchainTable` import already exists at the top of the file — this is an additive change, not a new import.)

- [ ] **Step 2: Add the `onchainPayout` read-only mirror to `packages/db`**

Modify `packages/db/src/onchain-schema.ts` — read the current file first (it defines `onchainPlan`, `onchainSubscription`, `onchainCharge` as read-only mirrors of Ponder-owned tables, per its header comment), then add, matching the exact column types `apps/indexer/ponder.schema.ts`'s existing `onchainPayout` definition already specifies:

```typescript
export const onchainPayout = pgTable("onchain_payout", {
  id: text("id").primaryKey(),
  splitAddress: text("split_address").notNull(),
  recipient: text("recipient").notNull(),
  token: text("token").notNull(),
  amount: numeric("amount", { precision: 78, scale: 0 }).notNull(),
  usdValue: numeric("usd_value", { precision: 20, scale: 6 }),
  txHash: text("tx_hash"),
  blockNumber: bigint("block_number", { mode: "bigint" }),
  chainId: integer("chain_id"),
  distributedAt: timestamp("distributed_at", { withTimezone: true }).notNull(),
});
```

- [ ] **Step 3: Write the migration for the new mirror table**

Create `packages/db/migrations-onchain/0001_onchain_payout_mirror.sql`:

```sql
CREATE TABLE "onchain_payout" (
	"id" text PRIMARY KEY NOT NULL,
	"split_address" text NOT NULL,
	"recipient" text NOT NULL,
	"token" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"usd_value" numeric(20, 6),
	"tx_hash" text,
	"block_number" bigint,
	"chain_id" integer,
	"distributed_at" timestamp with time zone NOT NULL
);
```

- [ ] **Step 4: Regenerate the migration journal**

Run: `cd packages/db && npx drizzle-kit generate --config drizzle.onchain.config.ts --name onchain_payout_mirror`
Expected: drizzle-kit detects the schema change and confirms the SQL matches what you hand-wrote in Step 3 (if it generates a differently-named or differently-shaped file, use drizzle-kit's own output instead of the hand-written version — the hand-written SQL above is a specification of intent, not a substitute for drizzle-kit's actual journal bookkeeping, which also updates `packages/db/migrations-onchain/meta/_journal.json`).

- [ ] **Step 5: Typecheck both affected packages**

Run: `cd apps/indexer && npx tsc --noEmit && cd ../../packages/db && npx tsc --noEmit`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/indexer/ponder.schema.ts packages/db/src/onchain-schema.ts packages/db/migrations-onchain
git commit -m "Add onchain_split Ponder table and onchain_payout DB mirror"
```

---

### Task 3: `apps/indexer` config — factory + Warehouse contracts

**Files:**
- Modify: `apps/indexer/ponder.config.ts`
- Modify: `apps/indexer/package.json`

**Interfaces:**
- Consumes: `splitV2FactoryAbi`, `splitsWarehouseAbi` (Task 1, from `@cadence/shared/abis`).
- Produces: two new Ponder contract configs (`PullSplitFactoryV2o2`, `SplitsWarehouse`), consumed by Task 4's handler file via `"PullSplitFactoryV2o2:SplitCreated"` / `"SplitsWarehouse:Transfer"` registration strings.

- [ ] **Step 1: Add the vitest dependency (this phase's first indexer tests, Task 4)**

Modify `apps/indexer/package.json` — read the current file first, then add to `"devDependencies"`:

```json
    "vitest": "^2.1.0"
```

And add a `"test"` script to `"scripts"`:

```json
    "test": "vitest run"
```

- [ ] **Step 2: Install**

Run: `pnpm install` (from repo root)
Expected: exit 0, `pnpm-lock.yaml` updates with `vitest` under `apps/indexer`.

- [ ] **Step 3: Add the two new contracts to `ponder.config.ts`**

Modify `apps/indexer/ponder.config.ts` — read the current file first (it imports `createConfig` from `"ponder"` and defines a single `SubscriptionManager` contract), then replace with:

```typescript
import { createConfig } from "ponder";
import { readFileSync } from "node:fs";
import { subscriptionManagerAbi } from "../../packages/shared/abis/SubscriptionManager.js";
import { splitV2FactoryAbi } from "../../packages/shared/abis/SplitV2Factory.js";
import { splitsWarehouseAbi } from "../../packages/shared/abis/SplitsWarehouse.js";

const deployment = JSON.parse(
  readFileSync(new URL("../../deployments/84532.json", import.meta.url), "utf-8"),
);

const PULL_SPLIT_FACTORY_V2O2_ADDRESS = "0x6B9118074aB15142d7524E8c4ea8f62A3Bdb98f1";
const SPLITS_WAREHOUSE_ADDRESS = "0x8fb66F38cF86A3d5e8768f8F1754A24A6c661Fb8";

export default createConfig({
  chains: {
    anvilLocal: {
      id: 84532,
      rpc: process.env.PONDER_RPC_URL_84532,
    },
  },
  contracts: {
    SubscriptionManager: {
      chain: "anvilLocal",
      abi: subscriptionManagerAbi,
      address: deployment.subscriptionManager,
      startBlock: 43690474,
    },
    PullSplitFactoryV2o2: {
      chain: "anvilLocal",
      abi: splitV2FactoryAbi,
      address: PULL_SPLIT_FACTORY_V2O2_ADDRESS,
      startBlock: 43690474,
    },
    SplitsWarehouse: {
      chain: "anvilLocal",
      abi: splitsWarehouseAbi,
      address: SPLITS_WAREHOUSE_ADDRESS,
      startBlock: 43690474,
    },
  },
});
```

Note this task does NOT use Ponder's `factory()` helper for address discovery in `ponder.config.ts` — per the spec's confirmed architecture, `PullSplitFactoryV2o2` is watched directly (as a fixed-address contract emitting `SplitCreated`), and Task 4's handler is what populates `onchainSplit` from those events. Ponder's `factory()` helper is for a different use case (watching events *on* the dynamically-deployed contracts themselves, e.g. if this phase needed to watch each individual Split's own events) — this phase only needs `SplitCreated` (on the factory itself) and `Transfer` (on the fixed-address Warehouse), neither of which requires `factory()`. `startBlock: 43690474` matches `SubscriptionManager`'s existing start block, since Phase 1o (the earliest point any Split could have been created) landed after that block.

Note the three ABI imports use direct file paths (`.../SubscriptionManager.js`, `.../SplitV2Factory.js`, `.../SplitsWarehouse.js`), matching the pre-existing `ponder.config.ts`'s established convention exactly (confirmed: `packages/shared/abis/` has no `index.ts`, and `packages/shared/package.json`'s `exports` map only defines `.` and `./abis` subpaths pointing at `dist/src/index.js`/`dist/src/abis-only.js` — neither of which `apps/indexer` currently uses; it imports individual ABI files directly from `packages/shared/abis/`, bypassing the package's own `exports` map entirely via a relative path, which is how the existing `SubscriptionManager` import already works).

- [ ] **Step 4: Typecheck**

Run: `cd apps/indexer && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/indexer/ponder.config.ts apps/indexer/package.json pnpm-lock.yaml
git commit -m "Add PullSplitFactoryV2o2 and SplitsWarehouse to indexer config"
```

---

### Task 4: Indexer handler — `SplitsWarehouse.ts`

**Files:**
- Create: `apps/indexer/src/SplitsWarehouse.ts`
- Test: `apps/indexer/test/splits-warehouse-handlers.test.ts`

**Interfaces:**
- Consumes: `onchainSplit`, `onchainPayout` (Task 2, from `ponder:schema`); the two new contract configs (Task 3).
- Produces: two `ponder.on(...)` registrations (`"PullSplitFactoryV2o2:SplitCreated"`, `"SplitsWarehouse:Transfer"`). This is the FINAL indexer task.

Ponder's `ponder.on(...)` callback can't be unit-tested by calling `ponder.on` directly (it registers against Ponder's own runtime, not a plain function this repo's test suite can invoke standalone) — matching `apps/worker`'s established pattern of extracting the actual logic into a plain, testable function that the `ponder.on` callback delegates to, with a mocked `context.db` object standing in for Ponder's real DB client (mirroring `apps/worker/test/nonce-manager.test.ts`'s `vi.fn()`-mocked-client style, the closest existing precedent in this codebase for testing logic that would otherwise require a live runtime).

- [ ] **Step 1: Write the failing test**

Create `apps/indexer/test/splits-warehouse-handlers.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { handleSplitCreated, handleWarehouseTransfer } from "../src/SplitsWarehouse.js";

const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
// uint256 token ID for the above address, per ERC6909's uint256(uint160(tokenAddress)) convention.
const USDC_TOKEN_ID = BigInt(USDC_ADDRESS);

function makeMockContext() {
  const insertedSplits: unknown[] = [];
  const insertedPayouts: unknown[] = [];
  const knownSplits = new Set<string>();

  return {
    chain: { id: 84532 },
    db: {
      insert: (table: { name?: string }) => ({
        values: async (values: Record<string, unknown>) => {
          // Distinguish which table by checking a field only that table's rows have.
          if ("recipient" in values) {
            insertedPayouts.push(values);
          } else {
            insertedSplits.push(values);
            knownSplits.add(values.address as string);
          }
        },
      }),
      find: async (_table: unknown, where: { address: string }) => {
        return knownSplits.has(where.address) ? { address: where.address } : null;
      },
    },
    _insertedSplits: insertedSplits,
    _insertedPayouts: insertedPayouts,
    _knownSplits: knownSplits,
  };
}

describe("handleSplitCreated", () => {
  it("inserts a new onchain_split row for the discovered address", async () => {
    const context = makeMockContext() as any;
    await handleSplitCreated({
      event: {
        args: { split: "0xSplitAddress0000000000000000000000000a" },
        block: { timestamp: 1700000000n },
      } as any,
      context,
    });

    expect(context._insertedSplits).toEqual([
      { address: "0xSplitAddress0000000000000000000000000a", chainId: 84532, createdAt: new Date(1700000000 * 1000) },
    ]);
  });
});

describe("handleWarehouseTransfer", () => {
  it("records a payout when the Transfer's sender is a known Split", async () => {
    const context = makeMockContext() as any;
    context._knownSplits.add("0xSplitAddress0000000000000000000000000a");

    await handleWarehouseTransfer({
      event: {
        args: {
          sender: "0xSplitAddress0000000000000000000000000a",
          receiver: "0xRecipient000000000000000000000000000b",
          id: USDC_TOKEN_ID,
          amount: 5000000n,
        },
        transaction: { hash: "0xtxhash1" },
        block: { number: 100n, timestamp: 1700000100n },
        log: { logIndex: 3 },
      } as any,
      context,
    });

    expect(context._insertedPayouts).toEqual([
      {
        id: "0xtxhash1:3",
        splitAddress: "0xSplitAddress0000000000000000000000000a",
        recipient: "0xRecipient000000000000000000000000000b",
        token: USDC_ADDRESS,
        amount: "5000000",
        usdValue: null,
        txHash: "0xtxhash1",
        blockNumber: 100n,
        chainId: 84532,
        distributedAt: new Date(1700000100 * 1000),
      },
    ]);
  });

  it("ignores a Transfer whose sender is not a known Split", async () => {
    const context = makeMockContext() as any;
    // No Split registered as known.

    await handleWarehouseTransfer({
      event: {
        args: {
          sender: "0xNotASplit00000000000000000000000000000c",
          receiver: "0xRecipient000000000000000000000000000b",
          id: USDC_TOKEN_ID,
          amount: 5000000n,
        },
        transaction: { hash: "0xtxhash2" },
        block: { number: 101n, timestamp: 1700000200n },
        log: { logIndex: 0 },
      } as any,
      context,
    });

    expect(context._insertedPayouts).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/indexer && npx vitest run test/splits-warehouse-handlers.test.ts`
Expected: FAIL — `../src/SplitsWarehouse.js` does not exist.

- [ ] **Step 3: Implement the handler**

Create `apps/indexer/src/SplitsWarehouse.ts`:

```typescript
import { ponder } from "ponder:registry";
import { onchainSplit, onchainPayout } from "ponder:schema";
import { getAddress } from "viem";

// ERC6909's token-ID convention is uint256(uint160(tokenAddress)) — the
// low 160 bits of the ID, reinterpreted as an address. Confirmed against
// 0xSplits' SplitsWarehouse source (interfaces/IERC6909.sol) during
// brainstorming.
function tokenIdToAddress(id: bigint): string {
  const hex = id.toString(16).padStart(40, "0").slice(-40);
  return getAddress(`0x${hex}`);
}

export async function handleSplitCreated({ event, context }: { event: any; context: any }) {
  await context.db.insert(onchainSplit).values({
    address: event.args.split,
    chainId: context.chain.id,
    createdAt: new Date(Number(event.block.timestamp) * 1000),
  });
}

export async function handleWarehouseTransfer({ event, context }: { event: any; context: any }) {
  const split = await context.db.find(onchainSplit, { address: event.args.sender });
  if (!split) return; // not a known Split — ignore (e.g. an unrelated Warehouse deposit/transfer)

  await context.db.insert(onchainPayout).values({
    id: `${event.transaction.hash}:${event.log.logIndex}`,
    splitAddress: event.args.sender,
    recipient: event.args.receiver,
    token: tokenIdToAddress(event.args.id),
    amount: event.args.amount.toString(),
    usdValue: null,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    chainId: context.chain.id,
    distributedAt: new Date(Number(event.block.timestamp) * 1000),
  });
}

ponder.on("PullSplitFactoryV2o2:SplitCreated", handleSplitCreated);
ponder.on("SplitsWarehouse:Transfer", handleWarehouseTransfer);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/indexer && npx vitest run test/splits-warehouse-handlers.test.ts`
Expected: PASS (3/3 tests).

- [ ] **Step 5: Typecheck**

Run: `cd apps/indexer && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/indexer/src/SplitsWarehouse.ts apps/indexer/test/splits-warehouse-handlers.test.ts
git commit -m "Add SplitsWarehouse indexer handler for 0xSplits payouts"
```

---

### Task 5: `GET /v1/payouts`

**Files:**
- Create: `apps/api/src/payouts/payouts.dto.ts`
- Create: `apps/api/src/payouts/payouts.service.ts`
- Create: `apps/api/src/payouts/payouts.controller.ts`
- Create: `apps/api/src/payouts/payouts.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/test/setup.ts`
- Test: `apps/api/test/payouts.e2e-spec.ts`

**Interfaces:**
- Consumes: `onchainPayout`, `onchainPlan` (Task 2, from `@cadence/db`'s `onchainSchema`); `AuthContextService`, `MerchantsService`, `parsePaginationQuery`, `buildPageEnvelope` (existing, matching `AnalyticsController`/`PlansController`'s established patterns).
- Produces: `GET /v1/payouts` returning a paginated envelope of payout rows. This is the FINAL `apps/api` task.

- [ ] **Step 1: Add a `seedOnchainPayout` test helper**

Modify `apps/api/test/setup.ts` — read the current file first (it has `seedOnchainPlan`, `seedOnchainSubscription`, `seedOnchainCharge`, each following an identical `let counter` + insert + `.returning()` pattern), then add:

```typescript
let payoutCounter = 0;

export async function seedOnchainPayout(
  db: DbClient,
  overrides: Partial<typeof onchainSchema.onchainPayout.$inferInsert> = {},
): Promise<typeof onchainSchema.onchainPayout.$inferSelect> {
  payoutCounter += 1;
  const [row] = await db
    .insert(onchainSchema.onchainPayout)
    .values({
      id: `0xpayout${payoutCounter}:0`,
      splitAddress: "0xdef0000000000000000000000000000000000b",
      recipient: "0x2220000000000000000000000000000000000e",
      token: "0x0000000000000000000000000000000000000c",
      amount: "5000000",
      chainId: 84532,
      distributedAt: new Date(),
      ...overrides,
    })
    .returning();
  return row;
}
```

- [ ] **Step 2: Write the failing e2e spec**

Create `apps/api/test/payouts.e2e-spec.ts`:

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
import { startTestDatabase, stopTestDatabase, seedOnchainPlan, seedOnchainPayout } from "./setup.js";

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

  await request(server).post("/v1/merchants").set("Cookie", cookie).send({ name: "Payouts Test Co", ownerAddress: wallet.address });

  return { cookie, ownerAddress: wallet.address };
}

describe("Payouts", () => {
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

  it("lists payouts for the caller's own plan's split", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const plan = await seedOnchainPlan(db, { merchantAddress: ownerAddress, payoutSplit: "0xmysplit000000000000000000000000000000a" });
    await seedOnchainPayout(db, { splitAddress: plan.payoutSplit, amount: "1000000" });

    const response = await request(server).get("/v1/payouts").set("Cookie", cookie);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].split_address).toBe("0xmysplit000000000000000000000000000000a");
    expect(response.body.data[0].amount).toBe("1000000");
  });

  it("does not show another merchant's payouts", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const otherPlan = await seedOnchainPlan(db, {
      merchantAddress: "0x9999999999999999999999999999999999999a",
      payoutSplit: "0xothersplit0000000000000000000000000000b",
    });
    await seedOnchainPayout(db, { splitAddress: otherPlan.payoutSplit });

    const response = await request(server).get("/v1/payouts").set("Cookie", cookie);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(0);
  });

  it("paginates with has_more and next_cursor", async () => {
    const { cookie, ownerAddress } = await signInAndCreateMerchant(server);
    const plan = await seedOnchainPlan(db, { merchantAddress: ownerAddress, payoutSplit: "0xpagesplit0000000000000000000000000000c" });
    for (let i = 0; i < 3; i += 1) {
      await seedOnchainPayout(db, { splitAddress: plan.payoutSplit });
    }

    const firstPage = await request(server).get("/v1/payouts?limit=2").set("Cookie", cookie);
    expect(firstPage.body.data).toHaveLength(2);
    expect(firstPage.body.has_more).toBe(true);
    expect(firstPage.body.next_cursor).not.toBeNull();
  });

  it("rejects a request with no session cookie and no API key", async () => {
    const response = await request(server).get("/v1/payouts");
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("missing_credentials");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/api && npx vitest run --config vitest.e2e.config.ts test/payouts.e2e-spec.ts`
Expected: FAIL — route not found (module doesn't exist yet).

- [ ] **Step 4: Write the DTO**

Create `apps/api/src/payouts/payouts.dto.ts`:

```typescript
export interface PayoutResponse {
  id: string;
  split_address: string;
  recipient: string;
  token: string;
  amount: string;
  usd_value: string | null;
  tx_hash: string | null;
  distributed_at: string;
}
```

- [ ] **Step 5: Write the service**

Create `apps/api/src/payouts/payouts.service.ts`:

```typescript
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { onchainSchema } from "@cadence/db";
import type { DbClient } from "@cadence/db";
import { DB_CLIENT } from "../db/db.module.js";
import type { PayoutResponse } from "./payouts.dto.js";

function toPayoutResponse(payout: typeof onchainSchema.onchainPayout.$inferSelect): PayoutResponse & { id: string } {
  return {
    id: payout.id,
    split_address: payout.splitAddress,
    recipient: payout.recipient,
    token: payout.token,
    amount: payout.amount,
    usd_value: payout.usdValue,
    tx_hash: payout.txHash,
    distributed_at: payout.distributedAt.toISOString(),
  };
}

@Injectable()
export class PayoutsService {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async list(
    callerOwnerAddress: string,
    params: { limit: number; startingAfter: string | null },
  ): Promise<(PayoutResponse & { id: string })[]> {
    const plans = await this.db
      .select({ payoutSplit: onchainSchema.onchainPlan.payoutSplit })
      .from(onchainSchema.onchainPlan)
      .where(eq(onchainSchema.onchainPlan.merchantAddress, callerOwnerAddress));
    const splitAddresses = plans.map((p) => p.payoutSplit);
    if (splitAddresses.length === 0) return [];

    const conditions = [inArray(onchainSchema.onchainPayout.splitAddress, splitAddresses)];
    if (params.startingAfter !== null) {
      conditions.push(gt(onchainSchema.onchainPayout.id, params.startingAfter));
    }

    const rows = await this.db
      .select()
      .from(onchainSchema.onchainPayout)
      .where(and(...conditions))
      .orderBy(asc(onchainSchema.onchainPayout.id))
      .limit(params.limit + 1);

    return rows.map(toPayoutResponse);
  }
}
```

- [ ] **Step 6: Write the controller**

Create `apps/api/src/payouts/payouts.controller.ts`:

```typescript
import { Controller, Get, Query, Req } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { AuthContextService } from "../auth/auth-context.service.js";
import { MerchantsService } from "../merchants/merchants.service.js";
import { AppException } from "../common/errors.js";
import { parsePaginationQuery, buildPageEnvelope } from "../common/pagination.js";
import { PayoutsService } from "./payouts.service.js";

@Controller("v1/payouts")
export class PayoutsController {
  constructor(
    private readonly payoutsService: PayoutsService,
    private readonly merchantsService: MerchantsService,
    private readonly authContext: AuthContextService,
  ) {}

  private async resolveOwnerAddress(request: FastifyRequest): Promise<string> {
    const auth = await this.authContext.resolve(request);
    if (auth.keyType !== "session" && auth.keyType !== "secret") {
      throw new AppException({ type: "permission_error", code: "key_type_not_allowed", message: "This endpoint requires a secret API key." });
    }
    if (auth.keyType === "session") return auth.ownerAddress;

    const merchant = await this.merchantsService.findByOwnerAddressById(auth.merchantId!);
    if (!merchant) {
      throw new AppException({ type: "invalid_request_error", code: "merchant_not_found", message: "No merchant account exists." });
    }
    return merchant.ownerAddress;
  }

  @Get()
  async list(@Query() query: { limit?: string; starting_after?: string }, @Req() request: FastifyRequest) {
    const ownerAddress = await this.resolveOwnerAddress(request);
    const { limit, startingAfter } = parsePaginationQuery(query);
    const rows = await this.payoutsService.list(ownerAddress, { limit, startingAfter });
    return buildPageEnvelope(rows, limit);
  }
}
```

Note: `resolveOwnerAddress` calls `this.authContext.resolve(request)` — this genuinely enforces the `key_type_not_allowed` check because `auth.keyType` is read directly from the already-resolved `AuthContext`, not gated behind an `ExecutionContext`-dependent decorator (matching the established, hard-won lesson from Phase 1n: `@RequireKeyType` alone enforces nothing in this codebase; the manual check here is the real enforcement, exactly like `AnalyticsController.resolveMerchantId` and `PlansController.resolveCallerOwnerAddress`).

- [ ] **Step 7: Write the module**

Create `apps/api/src/payouts/payouts.module.ts`:

```typescript
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { MerchantsModule } from "../merchants/merchants.module.js";
import { PayoutsController } from "./payouts.controller.js";
import { PayoutsService } from "./payouts.service.js";

@Module({
  imports: [AuthModule, MerchantsModule],
  controllers: [PayoutsController],
  providers: [PayoutsService],
})
export class PayoutsModule {}
```

- [ ] **Step 8: Register the module in app.module.ts**

Modify `apps/api/src/app.module.ts` — read the current file first, then add the import and registration, following the file's existing append-at-end convention:

```typescript
import { PayoutsModule } from "./payouts/payouts.module.js";
```

Add `PayoutsModule` to the `imports` array, after the last existing entry.

- [ ] **Step 9: Typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 10: Run the e2e spec**

Run: `cd apps/api && npx vitest run --config vitest.e2e.config.ts test/payouts.e2e-spec.ts`
Expected: PASS (4/4 tests).

- [ ] **Step 11: Run the full apps/api e2e suite to confirm no cross-suite regression**

Run: `cd apps/api && npx vitest run --config vitest.e2e.config.ts`
Expected: all 14 files pass together (13 pre-existing + 1 new) — this codebase has a documented history of a bug that only manifested when the full suite ran together (Phase 1n's `RpcClientModule` incident), so this check matters.

- [ ] **Step 12: Commit**

```bash
git add apps/api/src/payouts apps/api/src/app.module.ts apps/api/test/setup.ts apps/api/test/payouts.e2e-spec.ts
git commit -m "Add GET /v1/payouts endpoint"
```

---

### Task 6: `/dashboard/payouts` page + nav entry

**Files:**
- Create: `apps/web/lib/hooks/usePayouts.ts`
- Create: `apps/web/app/(dashboard)/dashboard/payouts/page.tsx`
- Modify: `apps/web/components/DashboardNav.tsx`
- Test: `apps/web/test/usePayouts.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks directly (calls `GET /v1/payouts` via `apiFetch`, matching `usePlans.ts`'s established pattern).
- Produces: the complete payouts vertical. This is the FINAL task of this phase.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/usePayouts.test.tsx`:

```tsx
import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../lib/apiFetch.js", () => ({
  apiFetch: vi.fn().mockResolvedValue({
    data: [
      {
        id: "0xpayout1:0",
        split_address: "0xdef0000000000000000000000000000000000b",
        recipient: "0x2220000000000000000000000000000000000e",
        token: "0x0000000000000000000000000000000000000c",
        amount: "5000000",
        usd_value: null,
        tx_hash: "0xtxhash1",
        distributed_at: "2026-07-01T00:00:00.000Z",
      },
    ],
    has_more: false,
    next_cursor: null,
  }),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
});

describe("usePayouts", () => {
  it("fetches /v1/payouts and unwraps the data array", async () => {
    const { apiFetch } = await import("../lib/apiFetch.js");
    const { usePayouts } = await import("../lib/hooks/usePayouts.js");

    const { result } = renderHook(() => usePayouts(), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(apiFetch).toHaveBeenCalledWith("/v1/payouts");
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0].recipient).toBe("0x2220000000000000000000000000000000000e");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run test/usePayouts.test.tsx`
Expected: FAIL — `../lib/hooks/usePayouts.js` does not exist.

- [ ] **Step 3: Implement `usePayouts`**

Create `apps/web/lib/hooks/usePayouts.ts`:

```typescript
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../apiFetch.js";

export interface Payout {
  id: string;
  split_address: string;
  recipient: string;
  token: string;
  amount: string;
  usd_value: string | null;
  tx_hash: string | null;
  distributed_at: string;
}

interface PageEnvelope<T> {
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export function usePayouts() {
  const query = useQuery({
    queryKey: ["payouts"],
    queryFn: () => apiFetch("/v1/payouts") as Promise<PageEnvelope<Payout>>,
  });
  return { ...query, data: query.data?.data };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run test/usePayouts.test.tsx`
Expected: PASS (1/1 test).

- [ ] **Step 5: Build the payouts page**

Create `apps/web/app/(dashboard)/dashboard/payouts/page.tsx`:

```tsx
"use client";

import { usePayouts } from "../../../../lib/hooks/usePayouts.js";

export default function PayoutsPage() {
  const { data, isLoading, error } = usePayouts();

  if (isLoading) return <p className="font-body text-slate">Loading…</p>;
  if (error) return <p className="font-body text-signal">Could not load payouts.</p>;

  return (
    <div>
      <h1 className="font-display text-2xl mb-6">Payouts</h1>
      {data?.length === 0 && <p className="font-body text-slate">No payouts yet.</p>}
      <table className="w-full text-sm font-body">
        <thead>
          <tr className="text-left text-slate border-b border-slate/15">
            <th className="py-2">Recipient</th>
            <th className="py-2">Token</th>
            <th className="py-2">Amount</th>
            <th className="py-2">Distributed</th>
            <th className="py-2">Tx</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((payout) => (
            <tr key={payout.id} className="border-b border-slate/10">
              <td className="py-2 font-data">{payout.recipient}</td>
              <td className="py-2 font-data">{payout.token}</td>
              <td className="py-2 font-data tabular-nums">{payout.amount}</td>
              <td className="py-2 font-data tabular-nums">{new Date(payout.distributed_at).toLocaleDateString()}</td>
              <td className="py-2 font-data">
                {payout.tx_hash ? (
                  <a href={`https://sepolia.basescan.org/tx/${payout.tx_hash}`} target="_blank" rel="noreferrer" className="text-sapphire hover:underline">
                    View
                  </a>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 6: Add the nav entry**

Modify `apps/web/components/DashboardNav.tsx` — read the current file first, then add a new entry to `NAV_ITEMS` (after `"/dashboard/plans"`, before `"/dashboard/subscriptions"`, matching the order money-related pages would naturally group):

```typescript
const NAV_ITEMS = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/plans", label: "Plans" },
  { href: "/dashboard/payouts", label: "Payouts" },
  { href: "/dashboard/subscriptions", label: "Subscriptions" },
  { href: "/dashboard/analytics", label: "Analytics" },
  { href: "/dashboard/developers", label: "Developers" },
];
```

- [ ] **Step 7: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 8: Run the full apps/web suite to confirm no regression**

Run: `cd apps/web && npx vitest run`
Expected: all pre-existing tests pass, plus this task's 1 new one. No test file for the page itself, matching this project's established practice of not unit-testing static, non-conditional table/page composition (see `/dashboard/plans/page.tsx`'s own precedent — no test file exists for it either).

- [ ] **Step 9: Manual smoke check**

Run: `cd apps/web && rm -rf .next && pnpm dev` in the background — first confirm port 3001 is genuinely free via BOTH `lsof -i:3001` and `ss -tlnp | grep 3001`. Once booted, curl `/dashboard/payouts` and confirm HTTP 200 (client-component route; raw SSR body will show a loading/auth-gate state, which is the expected signal — a 200 status confirms the route compiles and serves). Also curl `/dashboard/plans` and confirm the response contains `Payouts` (the new nav link's text, rendered by `DashboardNav` which is included in the dashboard layout shell). Stop the dev server cleanly afterward and confirm the port is released via both tools.

- [ ] **Step 10: Commit**

```bash
git add apps/web/lib/hooks/usePayouts.ts apps/web/app/(dashboard)/dashboard/payouts/page.tsx apps/web/components/DashboardNav.tsx apps/web/test/usePayouts.test.tsx
git commit -m "Add /dashboard/payouts page"
```

---

## Plan Self-Review Notes

**Spec coverage check:**
- Indexer: factory watch on `PullSplitFactoryV2.2`, fixed-address watch on `SplitsWarehouse`, `onchain_split` bridge table, `Transfer`-event-with-known-sender discriminator → Tasks 1, 2, 3, 4. ✓
- `onchain_payout`'s DB mirror (Ponder schema already existed; the `packages/db` read-only mirror did not — added in Task 2) → Task 2. ✓
- `usdValue` left `null` → Task 4's handler explicitly sets `usdValue: null`. ✓
- `GET /v1/payouts`, session-or-secret auth, merchant-scoped via `onchain_plan.payoutSplit` join, pagination → Task 5. ✓
- `/dashboard/payouts`, read-only, no wallet/signing logic, nav entry → Task 6. ✓
- No `Withdraw` event indexed, no Push-split handling, no other factory versions → confirmed absent from every task. ✓

**Placeholder scan:** No "TBD"/"TODO"/vague requirements. Every step has complete, concrete code, including the exact ABI import paths in Task 3 (independently verified during plan-writing against `packages/shared/package.json`'s actual `exports` map and `packages/shared/abis/`'s actual directory listing — no `index.ts` exists, confirming the existing `ponder.config.ts`'s direct-file-import convention is correct to replicate for the two new ABIs).

**Type consistency check:** `onchainSplit`/`onchainPayout` (Task 2, Ponder schema) are consumed identically by Task 4's handler (`context.db.insert(onchainSplit)`/`insert(onchainPayout)`, matching field names exactly: `address`, `chainId`, `createdAt` for splits; `id`, `splitAddress`, `recipient`, `token`, `amount`, `usdValue`, `txHash`, `blockNumber`, `chainId`, `distributedAt` for payouts). The `packages/db` mirror's column names (Task 2) match Task 5's `PayoutsService`'s Drizzle field accesses (`onchainSchema.onchainPayout.splitAddress`, `.id`, etc.) exactly — both derive from the same source-of-truth column list. `PayoutResponse`'s shape (Task 5) matches Task 6's `Payout` interface field-for-field (`split_address`, `recipient`, `token`, `amount`, `usd_value`, `tx_hash`, `distributed_at`), which in turn matches the PRD's §5.1 entity definition.

**Gap found and fixed during self-review:** an initial pass assumed Ponder's `factory()` config helper (confirmed real and documented during research) would be the mechanism for discovering Split addresses, but closer reading of Ponder's actual architecture revealed `factory()` only controls which addresses get watched for events *of the same configured contract* — it has no built-in mechanism for exposing a discovered address set to a *different* contract's handler (confirmed via direct research against Ponder's docs). Fixed by designing the manual `onchain_split` bridge-table pattern instead (Task 2's new table, Task 4's `handleSplitCreated`/`handleWarehouseTransfer` handlers), which is Ponder's own documented idiomatic approach for exactly this cross-contract cross-referencing case — this is not a workaround but the correct, intended pattern, confirmed against Ponder's own "write to the database" documentation before finalizing the plan.
