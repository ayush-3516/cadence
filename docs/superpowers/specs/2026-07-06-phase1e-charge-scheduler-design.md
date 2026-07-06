# Phase 1e: Charge Scheduler & Automation Worker — Design

## Context

Phases 1a-1d built the read/write API surface (indexer projections, merchant auth, plans, subscriptions, customers) — all either read-only or SIWE-gated off-chain metadata writes. Nothing in the project so far actually moves money or drives the on-chain subscription lifecycle forward. Phase 1e is the first automation/write capability: a scheduler that finds subscriptions due for charging and submits `SubscriptionManager.charge(subId)` on-chain via a relayer key, closing the platform's core value loop (subscriptions renew automatically without either party acting).

This phase introduces two pieces of infrastructure never used before in this project: Redis (via BullMQ) and a hot relayer private key. Both already exist in the PRD's canonical environment variable list (§4.5: `REDIS_URL`, `RELAYER_PRIVATE_KEY`) and `docker-compose.yml` already provisions a `redis` service — this phase is the first to actually use it.

## Scope

**In scope:**
- A new standalone process in `apps/worker` (currently an empty placeholder package).
- A repeatable BullMQ job (default every 5 minutes, configurable) that runs the due-query and enqueues one `charge-queue` job per due subscription.
- A `charge-queue` Worker that submits `SubscriptionManager.charge(subId)` via a single relayer key (viem), waits for 1 confirmation, and logs the outcome — without parsing receipt logs for success/failure (the indexer's `Charged`/`ChargeFailed` projection remains the sole source of truth, per the PRD's explicit trust model in §7.5 point 5).
- A Redis-backed idempotency lock (`charging:{subId}:{periodEnd}`) preventing two overlapping scheduler ticks from double-charging the same subscription/period.
- A simple in-process nonce counter for the relayer (queried once at startup, incremented per submission, safe because jobs are processed serially).

**Explicitly out of scope for this phase (deliberate simplifications, each a natural follow-up):**
- `chargeBatch()` — one `charge()` call per due subscription, not batched.
- Stuck-transaction detection, fee bumping, or replace-by-fee retry logic.
- Relayer balance monitoring / low-balance alerting / auto-topup.
- `dunning_state` integration — `past_due` subscriptions are included in the due-query unconditionally (no backoff gate), since `dunning_state` doesn't exist yet. A `past_due` subscription whose charge keeps failing will be retried on every scheduler tick until it succeeds or a later dunning phase adds real backoff. This is accepted as a known rough edge, not a bug to work around in this phase.
- Account abstraction / UserOp submission (PRD's Phase 2 path) — this phase only implements the "Phase 1: raw tx via relayer key" path from PRD §7.5.

## Architecture

**Process shape.** `apps/worker` is a standalone Node process, not a NestJS app — it has no HTTP surface, just a BullMQ scheduler and worker, so the NestJS DI/module machinery used by `apps/api` would be pure overhead here. It depends on `@cadence/db` (read-only queries against `onchain_subscription`) and connects independently to Redis and the chain RPC.

**Chain client.** Uses `viem` (not `ethers`), for consistency with `apps/indexer` (which already uses viem 2.21.3) and the PRD's own stated convention (Appendix D.4: "The API encodes calldata via viem `encodeFunctionData`"). `apps/api`'s existing `ethers` dependency is scoped to SIWE message verification only and is not relevant precedent here.

**Contract address source.** Reads `deployments/{chainId}.json` (the same file `apps/indexer/ponder.config.ts` already reads) for `subscriptionManager`'s address — no new source of truth for deployment addresses is introduced.

**Scheduling.** A BullMQ repeatable job (`charge-scheduler` queue, one recurring job) runs the due-query on a cron-like interval (default 5 minutes, via `CHARGE_SCHEDULER_INTERVAL_MS` env var). For each due `onchain_sub_id`, it enqueues a job onto `charge-queue` with `{ subId, periodEnd, chainId }` (matching PRD Appendix D.2's job-data shape).

**Due-query:**
```sql
SELECT onchain_sub_id, current_period_end
FROM onchain_subscription
WHERE status IN ('active', 'trialing', 'past_due')
  AND current_period_end <= now()
  AND chain_id = :chainId
ORDER BY current_period_end ASC
LIMIT :batchSize;
```
`chainId` and `batchSize` (default 100) are config values — `batchSize` caps how many due subscriptions one scheduler tick will enqueue jobs for, not a `chargeBatch()` on-chain call (that remains out of scope per this spec's Scope section; each enqueued job still submits its own individual `charge()` transaction). No `dunning_state` join (doesn't exist yet — see Scope).

**Job execution (`charge-queue` processor), one job per due subscription:**
1. Attempt to acquire a Redis lock `charging:{subId}:{periodEnd}` with a TTL (e.g. 10 minutes — long enough to cover submission + confirmation, short enough to self-heal if the process crashes mid-job). If the lock is already held, skip this job (another tick or process is already handling this sub/period) and complete successfully (not a failure — this is the expected outcome of the idempotency guard working).
2. Read the relayer's current nonce from an in-process counter (initialized once at worker startup via `publicClient.getTransactionCount()`, incremented after every submission — safe only because BullMQ's `charge-queue` Worker has `concurrency: 1`, so submissions are strictly serial).
3. Submit `charge(subId)` via viem's wallet client, using EIP-1559 fee fields from the RPC's fee estimation (`publicClient.estimateFeesPerGas()`) — no custom bumping logic.
4. Wait for 1 confirmation (`publicClient.waitForTransactionReceipt()`).
5. Log the transaction hash and completion — do not decode receipt logs to determine `Charged` vs `ChargeFailed`; that projection belongs to the indexer alone.
6. Release the lock (or let the TTL expire naturally).

**Error handling.** If step 3's submission itself throws (RPC error, insufficient relayer balance for gas, etc. — not a contract-level revert, since `charge()` doesn't revert on business-logic failure), the job fails, BullMQ's default retry/backoff applies, and the Redis lock's TTL expiry (not an explicit release) ensures the next attempt isn't permanently blocked. No custom retry policy beyond BullMQ's built-in job-level retry (configured with a small fixed attempt count, e.g. 3, exponential backoff) — this is different from the *transaction-replacement* retry logic explicitly scoped out above; retrying a failed *submission* (the RPC call itself) is a much smaller concern than replacing an already-broadcast, stuck transaction.

## Data Flow

1. Scheduler tick fires → due-query runs against Postgres (via `@cadence/db`, reading the on-chain mirror tables the indexer maintains).
2. One `charge-queue` job enqueued per due subscription.
3. Worker processes jobs serially: lock → submit → confirm → log → unlock.
4. Independently, the already-running indexer (a separate process, unchanged by this phase) observes the same transaction's `Charged` or `ChargeFailed` event and updates `onchain_subscription`/`onchain_charge` — this is what the API's existing `GET /v1/subscriptions/:id` endpoint (Phase 1c) will reflect, not anything the worker writes directly.

## Testing

Following Phase 0/1a's established precedent of testing against a real local anvil instance (not mocks):
- e2e test spins up anvil (or reuses a running instance, matching the indexer's test setup), deploys or reuses the already-deployed contracts from `deployments/84532.json`.
- Seeds a real plan + subscription via actual on-chain calls (mirroring how Phase 0's contract tests and Phase 1a's indexer tests already create on-chain state).
- Advances chain time past `current_period_end` via anvil's `evm_increaseTime` + `evm_mine`.
- Runs one due-query + job cycle against a Testcontainers Postgres seeded with the matching `onchain_subscription` row (matching the pattern established in Phases 1c/1d's seed helpers).
- Asserts a real transaction lands: the subscriber's token balance decreases, the treasury/payout-split balances increase, and (optionally, as a secondary check) `SubscriptionManager`'s own on-chain `currentPeriodEnd` for that sub has advanced — not just that the worker "decided" to charge something.
- A second test confirms the Redis lock prevents a double-charge: manually pre-acquire the lock, run the job, and assert no transaction was submitted.
- A third test confirms a `past_due` subscription is picked up by the due-query on the next tick (no backoff), documenting the accepted rough edge as an explicit, intentional test assertion rather than an implicit gap.

## Global Constraints (for the implementation plan)

- `apps/worker` is a standalone process (no NestJS), using BullMQ directly.
- Chain interactions use `viem`, matching `apps/indexer`'s existing dependency — not `ethers`.
- Contract addresses come from `deployments/{chainId}.json`, the same file `apps/indexer/ponder.config.ts` reads — no separate deployment-address configuration.
- One `charge()` call per due subscription — `chargeBatch()` is out of scope this phase.
- The `charge-queue` Worker MUST run with `concurrency: 1` — this is a correctness requirement (the in-process nonce counter is only safe under strict serialization), not a performance tuning choice.
- No transaction-replacement, fee-bumping, or stuck-tx detection logic — BullMQ's own job-level retry (small fixed attempts, exponential backoff) is the only retry mechanism, and it retries the *submission call*, not an already-broadcast transaction.
- The worker never decodes transaction receipt logs to determine charge success/failure — the indexer's projected `Charged`/`ChargeFailed` events are the sole source of truth for outcome, per PRD §7.5.
- The due-query includes `past_due` subscriptions unconditionally (no `dunning_state` gate) — this is intentional, not a bug, and must not be "fixed" by adding ad hoc backoff logic in this phase (that belongs to a dedicated dunning phase).
- `REDIS_URL` and `RELAYER_PRIVATE_KEY` are read from environment variables per the PRD's canonical list (§4.5) — no new env var naming conventions.
