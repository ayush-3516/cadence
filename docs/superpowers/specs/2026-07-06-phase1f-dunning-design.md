# Phase 1f: Dunning State Machine — Design

## Context

Phase 1e built the charge scheduler: a repeatable job that finds subscriptions due for charging and submits `SubscriptionManager.charge(subId)` via a relayer key. Its due-query deliberately includes `past_due` subscriptions unconditionally (no backoff gate), documented as an accepted rough edge — without `dunning_state`, a subscription with a failing charge gets retried every single scheduler tick (every 5 minutes) forever, with no eventual stop and no notification.

Phase 1f closes this gap: retry backoff via a per-plan configurable ladder (reusing `plan_meta.dunning_ladder` from Phase 1c), and a terminal "exhausted" state that stops the scheduler from retrying indefinitely.

## Scope

**In scope:**
- A new `dunning_state` app table (Drizzle-managed, migrated normally).
- A reconciliation step in `apps/worker` that keeps `dunning_state` in sync with observed subscription status (create on first failure, delete on success, advance/exhaust on repeat failure).
- One additional gate in `apps/worker/src/due-query.ts`: a `past_due` subscription is due only if it has no `dunning_state` row yet, or its `next_retry_at <= now()` and it is not `exhausted`.
- Structured logging at each dunning transition (created / retried / renewed / exhausted), including the customer's opt-in email if on file — log only, no real email delivery.

**Explicitly out of scope for this phase:**
- **Forcing on-chain cancellation when the ladder is exhausted.** Confirmed by reading `SubscriptionManager.sol`: `cancel(subId, immediate)` reverts with `NotSubscriber` unless `msg.sender` is the subscriber themselves — there is no admin or permissionless override, and no other function provides one. This means "ladder exhausted" can only ever be an **off-chain-only terminal state** in the current contract: the scheduler stops retrying, but the subscription's on-chain status remains `past_due` until the subscriber cancels it themselves. This is a real, confirmed architectural gap between the PRD's dunning model (which assumes cancellation is reachable) and what Phase 0's contract actually implements — not something this phase works around or silently patches. A future phase could add a permissionless `finalizeExpiredCancellation`-style function via the contract's UUPS upgrade path, but that is a distinct, larger, Solidity-touching piece of work.
- **Real email/notification delivery** (Resend/Postmark integration, templates). This phase logs the transition and the intended recipient; sending the email is a dedicated future phase's job.
- **Webhook delivery** (`subscription.payment_failed`, `subscription.renewed` events) — the PRD ties these to the same transitions this phase produces, but webhook infrastructure (`webhook_endpoint`/`webhook_delivery` tables, HMAC signing, delivery worker) doesn't exist yet and is out of scope here.
- Modifying `apps/indexer` — it remains strictly a chain-projection service; `dunning_state` is reconciled by the worker polling `onchain_subscription`'s already-projected status, not by the indexer writing to it directly.

## Data Model

### New app table: `dunning_state`

```sql
dunning_state (
  onchain_sub_id  NUMERIC PRIMARY KEY REFERENCES onchain_subscription,
  attempt         SMALLINT NOT NULL DEFAULT 1,
  next_retry_at   TIMESTAMPTZ NOT NULL,
  exhausted       BOOLEAN NOT NULL DEFAULT false,
  ladder          JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Matches PRD §7.2's `dunning_state` shape with one addition: an explicit `exhausted` boolean (the PRD's sketch relies on `attempt > ladder.length` implicitly; making it an explicit column makes the due-query's gate a simple boolean check rather than a length comparison against a JSONB array, and makes "why is this subscription no longer being retried" directly queryable/debuggable). `ladder` is a snapshot of the plan's `dunning_ladder` at the time the row was created (from `plan_meta.dunning_ladder`, defaulting to `["1d","3d","5d","7d"]`) — copied in, not joined live, so a later change to a plan's ladder doesn't retroactively alter an in-flight subscription's retry schedule.

Note: `onchain_subscription.onchain_sub_id` (the mirror table's PK) is `numeric(78,0)`, matching every other FK-shaped reference to it in this codebase (e.g. Phase 1c's join patterns) — `dunning_state.onchain_sub_id` must use the same type to avoid the numeric/text mismatch bug class found repeatedly in Phases 1c/1d.

## Reconciliation Logic

Runs once per scheduler tick, immediately before the due-query (folded into the existing `apps/worker` scheduler process, not a separate cron):

1. **New failures**: `SELECT onchain_sub_id FROM onchain_subscription WHERE status = 'past_due' AND onchain_sub_id NOT IN (SELECT onchain_sub_id FROM dunning_state)`. For each, look up the plan's `dunning_ladder` (via `onchain_plan.onchain_plan_id` → `plan_meta.dunning_ladder`, falling back to the default ladder if no `plan_meta` row exists yet) and insert `{attempt: 1, next_retry_at: now() + parseDuration(ladder[0]), exhausted: false, ladder}`. Log `payment_failed` (first occurrence), including the subscriber's `customer.email` if a `customer` row exists for that address under the plan's merchant (Phase 1d's `customer` table).
2. **Resolved (renewed)**: `SELECT * FROM dunning_state ds JOIN onchain_subscription os ON ds.onchain_sub_id = os.onchain_sub_id WHERE os.status != 'past_due'`. For each, delete the `dunning_state` row. Log `subscription_renewed`.
3. **Repeat failures (still past_due, retry window elapsed)**: `SELECT * FROM dunning_state WHERE next_retry_at <= now() AND exhausted = false` — but only for rows whose subscription is STILL `past_due` (a row appearing here means the due-query already re-attempted a charge on a prior tick and it failed again; if the subscription is no longer `past_due`, case 2 already handled it). For each: if `attempt < ladder.length`, increment `attempt`, set `next_retry_at = now() + parseDuration(ladder[attempt])` (0-indexed: `attempt=1` used `ladder[0]`, so the second attempt uses `ladder[1]`), log `payment_failed` (retry N). Else (`attempt >= ladder.length`), set `exhausted = true`, log `dunning_exhausted` (terminal — includes a note that on-chain status remains `past_due` pending subscriber action).

`parseDuration` converts ladder strings (`"1d"`, `"3d"`, `"5d"`, `"7d"` — the only units the PRD's default ladder uses) into milliseconds: a small helper parsing an integer + a unit suffix, supporting at minimum `d` (days) and `h` (hours) for forward compatibility with a merchant-configured ladder using either granularity.

## Due-Query Change

`apps/worker/src/due-query.ts`'s existing query is extended with one additional condition on the `past_due` branch. Conceptually:

```
WHERE status IN ('active', 'trialing')
   OR (status = 'past_due' AND (
         NOT EXISTS (SELECT 1 FROM dunning_state WHERE dunning_state.onchain_sub_id = onchain_subscription.onchain_sub_id)
         OR (next_retry_at <= now() AND exhausted = false)
       ))
```

`active`/`trialing` subscriptions are unaffected — still gated only by `current_period_end <= now()`, exactly as Phase 1e built it. Only `past_due` gains the additional `dunning_state` condition. A `past_due` subscription with no `dunning_state` row yet is still immediately due (this is the very first failure — reconciliation Step 1 will have just created its row on this same tick, before the due-query runs, so in practice this "no row yet" branch of the due-query condition should rarely if ever fire in the query itself; it's included for correctness/defensiveness against ordering edge cases, not because it's the primary path).

## Error Handling

No new `AppException`/API-facing error codes — this phase has no HTTP surface (it lives entirely in `apps/worker`, which has no API endpoints). Reconciliation failures (e.g., a DB error mid-loop) should not crash the worker process; log and let the next scheduler tick retry the reconciliation pass, matching the existing scheduler's fault-tolerance posture (BullMQ's own job-level retry already covers this if reconciliation is itself a BullMQ job step).

## Testing

Testcontainers Postgres only (no anvil/chain interaction needed — this phase operates purely on already-projected `onchain_subscription` rows and the new `dunning_state` table, using the same seed helpers Phase 1e's `due-query.test.ts` established). Required coverage:
- Reconciliation creates a `dunning_state` row for a newly-`past_due` subscription with no row yet, using the plan's actual `dunning_ladder` (or the default if no `plan_meta` row exists).
- Reconciliation deletes a `dunning_state` row once its subscription is no longer `past_due`.
- Reconciliation advances `attempt`/`next_retry_at` for a subscription still `past_due` past its `next_retry_at`.
- Reconciliation marks a row `exhausted` once `attempt` reaches the ladder's length, and does NOT advance further after that.
- Due-query: a `past_due` subscription with a future `next_retry_at` is excluded; one with `next_retry_at <= now()` is included; one marked `exhausted` is excluded even if its `next_retry_at` is in the past.
- Due-query: `active`/`trialing` subscriptions are completely unaffected by any `dunning_state` presence (they were never gated by it).

## Global Constraints (for the implementation plan)

- `dunning_state.onchain_sub_id` uses the same `numeric(78,0)`-compatible type as every other reference to `onchain_subscription`'s PK in this codebase — verify against `packages/db/src/onchain-schema.ts` directly, don't assume.
- `dunning_state` is migrated via the normal `packages/db/drizzle.config.ts`/`migrations/` path (it's app-owned, like `plan_meta` and `customer` before it) — never through the on-chain mirror path.
- Ladder-exhausted subscriptions are never force-cancelled on-chain in this phase — this is a confirmed, permanent contract limitation for the current SubscriptionManager version, not a temporary omission to "fix later in this same phase."
- No real email sending — logging only.
- No webhook delivery — logging only.
- `apps/indexer` is not modified — `dunning_state` is reconciled by the worker polling projected state, never written to by the indexer.
- The due-query change must not alter `active`/`trialing` gating at all — only `past_due`'s condition gains the additional `dunning_state` check.
