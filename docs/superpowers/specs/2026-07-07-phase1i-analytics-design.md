# Phase 1i: Analytics — Design Spec

## Goal

Give merchants provable, on-chain-derived SaaS metrics: MRR/ARR time series, churn over a
window, cohort retention, and a headline summary — computed from data this platform has
already indexed, with no new on-chain event handling required. Ship all four endpoints the
PRD documents (`summary`, `mrr`, `churn`, `cohorts`), rather than a partial subset, matching
this project's established practice (Phases 1g and 1h both shipped their full documented
endpoint surface ahead of the PRD's own frontend-milestone ordering, which nominally defers
"full analytics" to Phase 2 — that ordering describes when the *dashboard* consumes these
metrics, not when the backend should exist).

## Background: resolving the PRD's scope ambiguity

The PRD's own milestone breakdown (§11) is internally inconsistent: it lists all four
analytics endpoints together in its API table (§7.7) with no phase annotation, but its
Phase-1-vs-Phase-2 deliverable lists say Phase 1 gets only "basic `analytics_daily` rollup"
and "analytics-summary", while "full analytics (churn/cohorts)" is named under Phase 2 —
alongside webhooks and invoice PDF generation, both already built in this session ahead of
that same ordering. **Resolved:** build all four endpoints now, consistent with how this
project has actually proceeded phase-by-phase.

## Trigger mechanism

A single BullMQ repeatable job (`analytics-rollup`), registered via `upsertJobScheduler`
exactly like `apps/worker/src/index.ts`'s existing `chargeSchedulerQueue` registration,
fires once per day. On each fire, it queries all distinct merchant addresses that own at
least one `onchain_plan`, resolves each to a real `merchant.id` (using the exact
`eq(merchant.ownerAddress, plan.merchantAddress) AND eq(merchant.livemode, false)` pattern
already established in `queues.ts`/`dunning.ts` — this project's worker-side code has, to
date, only ever resolved testmode merchants this way; livemode support is an existing,
pre-existing constraint this phase does not change), and computes + upserts one
`analytics_daily` row per merchant for the current date.

**Resolved:** a single job looping over all merchants sequentially, not a fan-out queue with
one child job per merchant. The per-merchant computation is a handful of aggregate SQL
queries over already-indexed data — no external calls, no meaningful risk of one merchant's
computation failing independently of another's — so BullMQ's per-job retry/failure-isolation
semantics aren't needed here, unlike the charge-scheduler's fan-out (where each child job
submits a real, potentially-failing on-chain transaction).

## Schema (`packages/db/src/schema.ts`)

```typescript
export const analyticsDaily = pgTable(
  "analytics_daily",
  {
    merchantId: uuid("merchant_id").notNull().references(() => merchant.id),
    date: date("date").notNull(),
    mrrUsd: numeric("mrr_usd", { precision: 20, scale: 6 }).notNull(),
    arrUsd: numeric("arr_usd", { precision: 20, scale: 6 }).notNull(),
    activeSubs: integer("active_subs").notNull(),
    trialingSubs: integer("trialing_subs").notNull(),
    pastDueSubs: integer("past_due_subs").notNull(),
    newSubs: integer("new_subs").notNull(),
    canceledSubs: integer("canceled_subs").notNull(),
    grossVolumeUsd: numeric("gross_volume_usd", { precision: 20, scale: 6 }).notNull(),
    feeRevenueUsd: numeric("fee_revenue_usd", { precision: 20, scale: 6 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.merchantId, table.date] }),
  ],
);
```

Matches the PRD's §7.2 table exactly, column-for-column. All metric columns are `NOT NULL`
— the rollup always computes a complete row (a merchant with zero subscriptions still gets
a row with all zeros), so there is no nullable-metric ambiguity for API consumers to handle.

No other schema changes. `onchain_plan.amount` (raw token units) is normalized to USD
inline wherever needed (`Number(plan.amount) / 1e6`), not persisted as a new column — this
project is USDC-only (6 decimals, 1:1 with USD) per the PRD's own explicit scope (§12
decision #5), matching the exact normalization the indexer already applies for
`onchain_charge.usdValue`.

## MRR / ARR / ARPU computation

For each merchant, over all `onchain_subscription` rows joined to their `onchain_plan`
where `plan.merchantAddress` matches the merchant's `ownerAddress`:

```
for each subscription where status = 'active':
  monthlyAmount = (plan.amount / 1e6) * (30 * 86400 / plan.periodSeconds)
  mrr += monthlyAmount
trialing subscriptions: counted into trialingSubs, excluded from mrr
  (PRD §12 decision #3 default: "Excluded from MRR, counted separately")
arr = mrr * 12
arpu = active_subs > 0 ? mrr / active_subs : 0   (guarded, not a throw)
```

**Resolved normalization formula:** a single continuous formula,
`monthly = amount * (30d / periodSeconds)`, rather than bucketing periods into named
"monthly/annual/weekly" cases with tolerance windows. This naturally reproduces the PRD's
named examples (a 365-day period → ×30/365 ≈ ÷12.17, close to the PRD's "annual→/12"
shorthand; a 7-day period → ×30/7, exactly the PRD's own weekly formula) while correctly
handling arbitrary custom periods (45 days, 90 days, etc.) with no bucketing logic and no
undefined fallback case.

`past_due_subs` = count where `status = 'past_due'`. `new_subs` = count where
`createdAt` falls within `[rollup_date, rollup_date + 1 day)`. `canceled_subs` = count
where `canceledAt` falls within that same window.

## Gross volume / fee revenue computation

Over `onchain_charge` rows (status = `success`) in the trailing 24-hour window ending at
the rollup run time, for subscriptions belonging to the merchant (joined via
`onchain_charge.onchainPlanId` → `onchain_plan.merchantAddress`):

```
grossVolumeUsd = Σ usdValue
feeRevenueUsd = Σ (platformFee / 1e6)
```

## Churn computation (`GET /v1/analytics/churn`)

Computed from `analytics_daily`, not a separate table, over the caller's `[from, to]`
window (default: trailing 30 days, matching the PRD's own "Churn (30d)" framing):

```
active_at_window_start = active_subs on the analytics_daily row closest to `from`
canceled_in_window = Σ canceled_subs across rows in [from, to]
churn_rate = active_at_window_start > 0 ? canceled_in_window / active_at_window_start : 0
mrr_at_window_start = mrr_usd on the row closest to `from`
mrr_lost_in_window = mrr_at_window_start - mrr_usd on the row closest to `to`
  (clamped to ≥ 0 — MRR can grow net-positive even with some churn; "MRR lost" per the
  PRD's own phrasing means the gross reduction attributable to churn, not net MRR delta,
  but computing true gross MRR-lost would require per-subscription-cancellation tracking
  this phase's rollup doesn't capture — approximated here as max(0, start - end), a
  documented simplification, not a full revenue-churn breakdown)
revenue_churn = mrr_at_window_start > 0 ? mrr_lost_in_window / mrr_at_window_start : 0
```

## Cohort computation (`GET /v1/analytics/cohorts`)

Per the PRD's own §7.8 spec: **computed on-read directly from `onchain_subscription`, not
rollup-backed** — retention-by-signup-month doesn't fit a daily-snapshot table's shape
(each cohort needs its full subscriber list re-evaluated at every month-offset, which a
single day's rollup row cannot represent).

```
group subscriptions by date_trunc('month', createdAt) → cohort
cohort_size = count(subscriptions in that cohort)
for month_offset in 0..N (N = min(12, months since oldest cohort)):
  stillActive = count(subscriptions in cohort where
    status IN ('active', 'trialing')
    AND (createdAt + month_offset months) <= now())
  retentionPct = cohort_size > 0 ? stillActive / cohort_size : 0
```

Per the PRD's explicit instruction, this is cached in Redis (this computation is a
per-merchant full-table scan across `onchain_subscription`, worth caching) — a 1-hour TTL,
keyed by `merchant_id` (the PRD doesn't specify a TTL; this is a documented default,
consistent with this project's practice of picking a sensible default when the PRD is
silent rather than leaving it unspecified).

## API (`apps/api/src/analytics/`)

All four routes are secret-key-only per the PRD's own endpoint table (§7.7) — `session`
cookies are treated as equivalent to `secret` keys (the established convention in this
codebase: a merchant's own dashboard login is trusted the same as their own secret key;
only `publishable` keys are rejected), matching every other `sec`-only controller already
shipped (webhooks, invoices).

- `GET /v1/analytics/summary` → the latest `analytics_daily` row (today's if the rollup has
  already run, otherwise the most recent available), reshaped to match the PRD's own
  documented example response exactly: `{ mrr_usd, arr_usd, active_subscriptions, arpu_usd,
  gross_volume_30d_usd, fee_revenue_30d_usd, churn_rate_30d }`. The `_30d` fields are
  trailing-30-day sums/rates computed the same way `churn` computes them, not single-day
  values from the latest row alone.
- `GET /v1/analytics/mrr?from=&to=&interval=day|week|month` → time series from
  `analytics_daily`. Gap-filling: a day with no rollup row *within* the merchant's known
  active date range is filled by carrying forward the last known value (MRR is a snapshot
  metric, not a flow metric — a missing day due to a rollup-job failure shouldn't read as
  zero). Days before the merchant's first rollup row are not filled (no data exists yet,
  not zero). `interval=week|month` aggregates by taking the last day's value in each bucket
  (a snapshot-of-period-end, matching how MRR is inherently a point-in-time metric, not
  something to sum across days).
- `GET /v1/analytics/churn?from=&to=` → the churn/revenue-churn calculation above, default
  window = trailing 30 days if unspecified.
- `GET /v1/analytics/cohorts` → the on-read, Redis-cached cohort matrix.

## Testing

- **Unit (`apps/worker`):** MRR/ARR/ARPU normalization math and churn math against
  hand-computed fixtures (the PRD's own §7.11 explicitly calls out "MRR/churn math" as a
  required unit-test area) — including the period-normalization formula's exact behavior
  for standard (30d, 7d, 365d) and non-standard (45d, 90d) periods, and both zero-guards
  (ARPU with zero active subs, churn with zero starting actives).
- **Integration (`packages/db` or `apps/worker`, testcontainers):** the daily rollup job
  against seeded `onchain_subscription`/`onchain_plan`/`onchain_charge` rows spanning
  multiple merchants, multiple subscription statuses, and a mix of standard/custom billing
  periods — asserting the resulting `analytics_daily` row's every column against
  hand-computed expected values.
- **API e2e (`apps/api`):** auth (secret/session accepted, publishable rejected, matching
  every other `sec`-only route's existing test pattern) and response-shape tests for all
  four endpoints, including the `mrr` endpoint's gap-filling behavior and the `cohorts`
  endpoint's Redis-caching behavior (a second request within the TTL window should not
  re-scan `onchain_subscription` — verifiable by asserting identical results without
  re-seeding new data between calls, or via a cache-hit assertion if the caching layer
  exposes one cleanly).

## Explicitly out of scope for this phase

- Any frontend/dashboard work (`MRRChart`, `ChurnChart`, `CohortHeatmap`, `useAnalyticsSummary`
  etc.) — backend only, matching every prior phase's scope boundary in this project.
- Livemode merchant support in the rollup job — the existing worker-side merchant-resolution
  pattern this phase reuses (`eq(merchant.livemode, false)`) is hardcoded to testmode only,
  a pre-existing constraint from earlier phases, not something this phase introduces or
  fixes.
- True gross revenue-churn tracking (per-subscription-cancellation MRR attribution) — the
  `mrr_lost_in_window` approximation documented above (`max(0, start - end)`) is a
  deliberate simplification, not a full breakdown.
- A configurable trialing-MRR-inclusion toggle — the PRD's own default (decision #3,
  "excluded from MRR, counted separately") is used unconditionally; no per-merchant config
  for this is built.
