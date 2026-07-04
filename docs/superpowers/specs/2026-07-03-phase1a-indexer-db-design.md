# Phase 1a — Indexer + DB Schema: Design

**Date:** 2026-07-03
**Status:** Approved for planning
**Source:** `cadence-prd.md` §7.1, §7.2, §7.11, Appendix A, Appendix D.1; §11 Phase 1 (partial)

## 1. Purpose

Build the chain-projection layer of Cadence: a Ponder indexer that consumes
`SubscriptionManager` events and writes them into a queryable Postgres
projection, matching the frozen schema in PRD §7.2. This is the first of
several Phase 1 sub-projects (indexer/DB → API → scheduler/worker →
frontend); each depends on the previous, and this one has no dependency on
any of the others.

This phase also stands up a **persistent** local anvil deployment of the
Phase 0 contracts to index against, replacing the ephemeral dry-run
deployment used during Phase 0's build.

## 2. Non-goals (explicitly deferred)

- Backend API (`apps/api`), scheduler/worker (`apps/worker`), frontend
  (`apps/web`) — separate future sub-projects that read this projection.
- The unified `event` audit log table and webhook/invoice job enqueueing
  (PRD §7.1 steps 2–4) — these are app-owned concerns with no consumer
  until the worker sub-project exists. Only step (1), the projection
  write, is in scope here.
- `onchain_payout` population — the table is created (frozen schema
  shape, PRD §7.2) but stays empty; no 0xSplits integration exists yet to
  emit distribution events.
- Live Base Sepolia deployment — this phase targets local anvil only, per
  explicit user direction. Re-pointing the indexer at Base Sepolia later
  is a config change (network + start block + addresses), not a code
  change to the handlers themselves.
- `packages/shared`'s full scope (Zod schemas, chain config, etc.) — only
  the ABI JSON files needed by Ponder are added to `packages/shared/abis/`
  in this phase.
- App tables (`merchant`, `api_key`, `plan_meta`, `customer`,
  `dunning_state`, `invoice`, `webhook_endpoint`, `event`,
  `webhook_delivery`, `analytics_daily`) — built when the API sub-project
  starts.

## 3. Persistent local anvil + fresh deployment

Phase 0's deployment to anvil was a one-off dry run against a
throwaway, forked instance that's no longer running in a durable form.
This phase:

1. Starts a **long-running** local anvil instance (matching
   `docker-compose.yml`'s `anvil` service — forking Base Sepolia, so real
   USDC is available, same pattern proven in Phase 0).
2. Runs `packages/contracts/script/Deploy.s.sol` against it fresh.
3. Records the resulting addresses somewhere the indexer's config can read
   them — per PRD §4.4/§9.1's guidance, `deployments/<chainId>.json` is
   the canonical source; Ponder's config will read from this file (or a
   thin wrapper) rather than hardcoding addresses.

This deployment is expected to be **long-lived for the duration of this
sub-project's development and testing** (unlike Phase 0's throwaway dry
run) — the indexer needs a stable chain to point at across multiple test
runs.

## 4. Ponder indexer (`apps/indexer`)

Per PRD §7.1 and Appendix D.1.

### 4.1 Configuration
- `ponder.config.ts`: one network entry (`anvilLocal`, chainId 84532 since
  it's a Base Sepolia fork — matches what's already proven to work),
  pointing at `http://localhost:8545`. One contract entry
  (`SubscriptionManager`) with address from `deployments/84532.json`,
  ABI from `packages/shared/abis/SubscriptionManager.json`, and
  `startBlock` = the block the fresh deployment was mined in.
- `ponder.schema.ts`: declares `onchain_plan`, `onchain_subscription`,
  `onchain_charge`, `onchain_payout` per PRD §7.2's exact column
  names/types (frozen interface — Appendix A).

### 4.2 ABIs
- Foundry's `forge build` already emits ABI JSON as part of each
  contract's `out/<Contract>.sol/<Contract>.json` artifact. This phase
  extracts just the `abi` field for `SubscriptionManager` (the only
  contract the indexer needs — `FeeRegistry` and `RevenueSplitter` emit no
  events the indexer projection tables consume) into
  `packages/shared/abis/SubscriptionManager.json`.

### 4.3 Event handlers
One handler per event, each performing exactly one upsert (no event
log, no queue enqueue, per §2 Non-goals):

| Event | Handler action |
|---|---|
| `PlanCreated` | insert `onchain_plan` row |
| `PlanStatusChanged` | update `onchain_plan.active` |
| `Subscribed` | insert `onchain_subscription` row (status, current_period_end) |
| `Charged` | insert `onchain_charge` row (status=success); update subscription's `current_period_end`/`status` |
| `ChargeFailed` | insert `onchain_charge` row (status=failed, reason); update subscription `status`=past_due |
| `StatusChanged` | update `onchain_subscription.status` |
| `Paused` | update `onchain_subscription.status`, `paused_remaining` |
| `Resumed` | update `onchain_subscription.status`, `current_period_end`, clear `paused_remaining` |
| `CancelScheduled` | update `onchain_subscription.pending_cancel`, `canceled_at` |
| `Canceled` | update `onchain_subscription.status`=canceled, `canceled_at` |

USD normalization (PRD §5.5): since only USDC is supported at this phase
(no volatile-token price feed exists), `usd_value = amount` (decimals
already handled — USDC has 6 decimals, stored raw; `usd_value` is a
separate `NUMERIC(20,6)` column computed as `amount / 1e6`).

### 4.4 Idempotency & reorgs
Ponder handles both natively (idempotent replay keyed by
`(txHash, logIndex)`; automatic rollback/re-apply on reorg). This phase
verifies rather than re-implements: a test asserts that re-processing the
same block range doesn't duplicate rows.

## 5. Database schema (indexer-owned tables only)

Exact column definitions from PRD §7.2, reproduced here for this phase's
scope (verbatim, since these are frozen interface columns per Appendix A):

```sql
onchain_plan (
  onchain_plan_id   NUMERIC PRIMARY KEY,
  merchant_address  TEXT NOT NULL,
  payout_split      TEXT NOT NULL,
  token             TEXT NOT NULL,
  amount            NUMERIC(78,0) NOT NULL,
  period_seconds    BIGINT NOT NULL,
  trial_seconds     BIGINT NOT NULL,
  active            BOOLEAN NOT NULL,
  chain_id          INTEGER NOT NULL,
  created_block     BIGINT, created_tx TEXT, created_at TIMESTAMPTZ
);

onchain_subscription (
  onchain_sub_id      NUMERIC PRIMARY KEY,
  onchain_plan_id     NUMERIC NOT NULL REFERENCES onchain_plan,
  subscriber_address  TEXT NOT NULL,
  status              subscription_status NOT NULL,
  current_period_end  TIMESTAMPTZ NOT NULL,
  paused_remaining    BIGINT NOT NULL DEFAULT 0,
  pending_cancel      BOOLEAN NOT NULL DEFAULT false,
  canceled_at         TIMESTAMPTZ,
  chain_id            INTEGER NOT NULL,
  created_at          TIMESTAMPTZ, updated_at TIMESTAMPTZ
);

onchain_charge (
  id               TEXT PRIMARY KEY,
  onchain_sub_id   NUMERIC NOT NULL REFERENCES onchain_subscription,
  onchain_plan_id  NUMERIC NOT NULL,
  status           charge_status NOT NULL,
  reason           SMALLINT,
  amount           NUMERIC(78,0), platform_fee NUMERIC(78,0), net NUMERIC(78,0),
  token            TEXT, usd_value NUMERIC(20,6),
  tx_hash          TEXT NOT NULL, block_number BIGINT, chain_id INTEGER,
  charged_at       TIMESTAMPTZ NOT NULL
);

onchain_payout (
  id               TEXT PRIMARY KEY,
  split_address    TEXT NOT NULL,
  recipient        TEXT NOT NULL,
  token            TEXT NOT NULL,
  amount           NUMERIC(78,0) NOT NULL, usd_value NUMERIC(20,6),
  tx_hash          TEXT, block_number BIGINT, chain_id INTEGER,
  distributed_at   TIMESTAMPTZ NOT NULL
);

-- enum required by onchain_subscription/onchain_charge:
subscription_status : none | trialing | active | past_due | paused | canceled
charge_status       : success | failed
```

Ponder owns these tables directly (via `ponder.schema.ts`), not Drizzle —
per PRD §7.2's split ("indexer tables, Ponder-managed" vs "app tables,
Drizzle-managed"). `packages/db` (currently a stub) is NOT touched in this
phase; it's reserved for the app-owned Drizzle schema in a later
sub-project.

## 6. Testing (PRD §7.11 "Indexer tests")

1. **Live-chain projection test**: using the local anvil deployment,
   execute a real sequence of transactions (createPlan → subscribe →
   warp + charge → cancel) via `cast send` or a small script, then query
   Ponder's Postgres store and assert each row matches the on-chain state
   exactly (mirrors the Phase 0 smoke test, but asserts against the DB
   instead of `cast call`).
2. **Idempotency test**: re-index the same block range (e.g., restart
   Ponder against the same start block) and assert no duplicate rows.
3. **Reorg test**: if `anvil_reorg` (or equivalent) is available in the
   installed anvil version, simulate a reorg that un-happens a charge and
   assert the projection rolls back correctly. If unavailable, this test
   is skipped with a documented reason (Foundry version limitation), not
   silently dropped.

## 7. Definition of Done

- [ ] Persistent local anvil running with a fresh `Deploy.s.sol` run;
      `deployments/84532.json` reflects this deployment.
- [ ] `packages/shared/abis/SubscriptionManager.json` contains the correct
      ABI.
- [ ] Ponder indexer running, consuming all 10 events listed in §4.3.
- [ ] All 4 indexer-owned tables (§5) exist with exact PRD §7.2 column
      shapes.
- [ ] Live-chain projection test passes: a full subscribe→charge→cancel
      sequence produces correct, matching rows.
- [ ] Idempotency test passes.
- [ ] Reorg test passes, or is explicitly skipped with a documented
      Foundry-version reason.

## 8. Open items carried forward (not blocking this phase)

- `onchain_payout` population — deferred to a future 0xSplits-integration
  phase.
- The unified `event` log and webhook/invoice enqueueing — deferred to the
  worker sub-project.
- Re-pointing at live Base Sepolia — a config change for a later phase,
  not a blocker now.
- `packages/db` Drizzle schema (app tables) — deferred to the API
  sub-project.
