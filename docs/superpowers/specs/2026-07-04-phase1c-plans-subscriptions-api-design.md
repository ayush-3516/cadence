# Phase 1c: Plans & Subscriptions Read API — Design

## Context

Phase 1a built the Ponder indexer, which projects on-chain `SubscriptionManager` events into `onchain_plan`, `onchain_subscription`, `onchain_charge`, and `onchain_payout` tables (owned and migrated by Ponder, defined in `apps/indexer/ponder.schema.ts`). Phase 1b built the API foundation: NestJS scaffold, SIWE merchant auth, merchant bootstrap, and API keys — but no endpoint yet reads real chain data.

Phase 1c is the first slice that joins on-chain projections with merchant-owned off-chain metadata to produce the read API a merchant dashboard needs for plans and subscriptions. Customers, charges-as-a-standalone-list, invoices, payouts, analytics, webhooks, scheduler, and dunning are explicitly out of scope — each is its own later phase per PRD §7.4–§7.9.

## Scope

**In scope:**
- New `plan_meta` app table (Drizzle-managed, migrated) per PRD §7.2.
- Read-only Drizzle mirror definitions of `onchain_plan`, `onchain_subscription`, `onchain_charge` in `packages/db` (no migrations generated — Ponder owns their DDL).
- `POST /v1/plans/:onchainId/metadata` — attach/update name/description/dunning-ladder metadata on an on-chain plan.
- `GET /v1/plans` — list plans (on-chain + metadata joined), cursor-paginated.
- `GET /v1/plans/:onchainId` — plan detail.
- `GET /v1/subscriptions` — list subscriptions (filterable), cursor-paginated.
- `GET /v1/subscriptions/:onchainId` — subscription detail, including embedded charge history.
- Mounting `ApiKeyGuard` for the first time, extended with per-route secret/publishable enforcement.

**Out of scope (future phases):** `customer` table and customer endpoints, `GET /v1/charges` as a standalone list, invoices, payouts, analytics, webhooks, scheduler, dunning worker.

## Data Model

### New app table: `plan_meta`

```sql
plan_meta (
  onchain_plan_id NUMERIC PRIMARY KEY REFERENCES onchain_plan,
  merchant_id     UUID NOT NULL REFERENCES merchant,
  name            TEXT NOT NULL,
  description     TEXT,
  image_url       TEXT,
  dunning_ladder  JSONB NOT NULL DEFAULT '["1d","3d","5d","7d"]',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Matches PRD §7.2 exactly. `onchain_plan_id` is both primary key and the join key back to the indexer's `onchain_plan` table — one metadata row per on-chain plan, upserted by `POST /v1/plans/:onchainId/metadata`.

### Read-only mirrors of indexer tables

Added to `packages/db/src/schema.ts` as plain `pgTable` definitions with the **same column names and types** as `apps/indexer/ponder.schema.ts`, but excluded from `drizzle-kit generate`/`migrate` (see Global Constraints). These exist purely so `apps/api` can build type-safe queries and JOINs against tables it does not own.

- `onchainPlan` mirrors `apps/indexer/ponder.schema.ts:11-24`
- `onchainSubscription` mirrors `apps/indexer/ponder.schema.ts:26-38`
- `onchainCharge` mirrors `apps/indexer/ponder.schema.ts:40-55`

If Ponder's schema changes shape in a future phase, these mirrors must be updated by hand — there is no automated sync. This is an accepted tradeoff (see Approaches Considered).

## API Design

### `POST /v1/plans/:onchainId/metadata`

Auth: session cookie or **secret** API key only.

Request body: `{ "name": string, "description"?: string, "imageUrl"?: string, "dunningLadder"?: string[] }`

Behavior:
1. Look up `onchain_plan` by `onchainId`. 404 (`plan_not_found`, `invalid_request_error`) if absent.
2. Verify `onchain_plan.merchant_address` (lowercased) equals the calling merchant's `owner_address` (lowercased). If not, 403 (`permission_error`, `plan_not_owned`) — a merchant must not be able to attach metadata to another merchant's plan.
3. Upsert `plan_meta` (insert if absent, update `name`/`description`/`image_url`/`dunning_ladder`/`updated_at` if present).
4. Return the merged plan (on-chain fields + metadata fields), same shape as `GET /v1/plans/:onchainId`.

### `GET /v1/plans`

Auth: session cookie, secret key, or publishable key.

Query params: `?limit=` (default 20, max 100), `?starting_after=<onchainPlanId>`, `?active=true|false` (optional filter).

Scoped to the calling merchant: `WHERE onchain_plan.merchant_address = :callerOwnerAddress`. LEFT JOIN `plan_meta` — a plan with no metadata yet still appears, with `name`/`description`/`imageUrl` as `null`.

Response: `{ "data": [Plan...], "has_more": boolean, "next_cursor": string | null }`.

### `GET /v1/plans/:onchainId`

Auth: session cookie, secret key, or publishable key. Same ownership scoping as the list endpoint — 404 if the plan doesn't belong to the caller (not 403; existence of another merchant's plan is not disclosed).

Response shape (`Plan`):
```json
{
  "onchain_plan_id": "7",
  "name": "Pro API",
  "description": "...",
  "image_url": null,
  "amount": "20000000",
  "token": "0x...",
  "period_seconds": 2592000,
  "trial_seconds": 0,
  "active": true,
  "payout_split": "0x...",
  "dunning_ladder": ["1d", "3d", "5d", "7d"],
  "created_at": "2026-06-01T00:00:00Z",
  "livemode": false
}
```

`amount_usd` is deferred: no price-feed/conversion mechanism exists yet in any merged phase, so it is omitted from responses this phase rather than hardcoded or faked. This is a deliberate, explicit deviation from the PRD's example payloads (see Open Deviations below).

`livemode` is derived from `onchain_plan.chain_id` matching the configured live chain ID vs. testnet — the exact mapping is defined in a Task brief in the implementation plan, not here, since it depends on env-var conventions already established in Phase 1a/1b.

### `GET /v1/subscriptions`

Auth: session cookie or **secret** key only (subscriber addresses and subscription status are considered sensitive business data, unlike plan listings).

Query params: `?limit=`, `?starting_after=<onchainSubId>`, `?status=` (filter, one of the subscription_status enum values), `?plan_id=` (filter by `onchain_plan_id`), `?subscriber=` (filter by address).

Scoped to the calling merchant via `onchain_subscription.onchain_plan_id → onchain_plan.merchant_address = :callerOwnerAddress`.

Response: `{ "data": [SubscriptionSummary...], "has_more": boolean, "next_cursor": string | null }`. `SubscriptionSummary` omits charge history (list view); full charges appear only in the detail endpoint.

### `GET /v1/subscriptions/:onchainId`

Auth: session cookie or secret key only. Same ownership scoping — 404 if not the caller's.

Response shape, matching the PRD's example (§7.4) minus `amount_usd`:
```json
{
  "onchain_sub_id": "123",
  "plan": { "onchain_plan_id": "7", "name": "Pro API", "amount": "20000000", "token": "0x...", "period_seconds": 2592000 },
  "subscriber": "0xabc...",
  "status": "active",
  "current_period_end": "2026-07-30T00:00:00Z",
  "created_at": "2026-06-01T00:00:00Z",
  "charges": [
    { "id": "0xtx:3", "status": "success", "amount": "20000000", "platform_fee": "150000", "net": "19850000", "tx_hash": "0xtx", "charged_at": "2026-06-30T00:00:00Z" }
  ],
  "livemode": false
}
```

Charges are embedded (all charges for this subscription, most recent first, no pagination this phase — acceptable since a single subscription's charge count is naturally small and bounded by its age).

## Auth Enforcement

`ApiKeyGuard` (built in Phase 1b, never mounted) is mounted on all five routes above, alongside the existing session-cookie path (reusing the dual-auth pattern from `GET /v1/merchants/me`). A new `@RequireKeyType("secret")` decorator + a check inside the guard enforces the split:

- No decorator (default) → either key type accepted: `GET /v1/plans`, `GET /v1/plans/:onchainId`.
- `@RequireKeyType("secret")` → publishable keys rejected with 403 (`permission_error`, `key_type_not_allowed`): `POST /v1/plans/:onchainId/metadata`, `GET /v1/subscriptions`, `GET /v1/subscriptions/:onchainId`.

Session-cookie auth is always full-access regardless of route (a logged-in merchant dashboard is never restricted the way a publishable key is).

## Pagination

Convention established here for reuse by all future list endpoints (customers, charges, invoices, payouts, events):

- `?limit=` — integer, default 20, max 100. Values outside `[1, 100]` → 400 (`invalid_request_error`, `invalid_limit`).
- `?starting_after=<id>` — opaque cursor, the previous page's last row's primary key (`onchain_plan_id` or `onchain_sub_id`, both numeric and naturally orderable).
- Query pattern: `WHERE id > :cursor ORDER BY id ASC LIMIT :limit + 1`, then slice to `:limit` rows; `has_more = (fetched.length > limit)`; `next_cursor = has_more ? last_returned_row.id : null`.
- Response envelope: `{ "data": [...], "has_more": boolean, "next_cursor": string | null }`.

## Error Handling

Reuses `AppException`/`STATUS_BY_TYPE` from Phase 1b (`apps/api/src/common/errors.ts`). New codes introduced this phase:

| Code | Type | Status | When |
|---|---|---|---|
| `plan_not_found` | `invalid_request_error` | 404 | Plan doesn't exist or isn't owned by caller |
| `subscription_not_found` | `invalid_request_error` | 404 | Subscription doesn't exist or isn't owned by caller |
| `plan_not_owned` | `permission_error` | 403 | Metadata-attach attempted on another merchant's plan |
| `key_type_not_allowed` | `permission_error` | 403 | Publishable key used on a secret-only route |
| `invalid_limit` | `invalid_request_error` | 400 | `?limit=` outside `[1, 100]` |
| `invalid_cursor` | `invalid_request_error` | 400 | `?starting_after=` is not a valid ID for this resource |

## Testing

Existing Testcontainers + Vitest e2e harness (established Phase 1b). Since `onchain_plan`/`onchain_subscription`/`onchain_charge` are normally populated by a live Ponder indexer process (out of scope to run in these tests), test setup seeds rows directly via the Drizzle client using the read-only mirror table definitions — this is the one place tests write to tables the app otherwise only reads.

Required coverage:
- Plan metadata attach: happy path, ownership-mismatch rejection, upsert-on-second-call behavior.
- Plan list: pagination (`has_more`/`next_cursor` correctness across a 3-page seed), `active` filter, merchant scoping (another merchant's plans never appear).
- Plan detail: found, not-found (both nonexistent and not-owned → same 404).
- Subscription list: pagination, each filter (`status`, `plan_id`, `subscriber`), merchant scoping, secret-key-only enforcement (publishable key → 403).
- Subscription detail: found with embedded charges in correct order, not-found, secret-key-only enforcement.
- Publishable key accepted on `GET /v1/plans` and `GET /v1/plans/:onchainId` (positive case for the non-restricted routes).

## Approaches Considered

**Onchain table access — mirrored Drizzle tables (chosen) vs. raw `sql\`\`` per query:** Mirroring costs a manual-sync burden if Ponder's schema changes, but every endpoint in this phase needs JOINs across on-chain and app tables — raw SQL for all of them would forfeit Drizzle's query builder and type safety on the majority of this phase's code. Chosen: mirrored tables, explicitly flagged as manually-synced (not auto-generated) in both this spec and inline code comments.

**Pagination — cursor (chosen) vs. offset:** Cursor pagination matches the PRD's global contract and avoids page-drift under concurrent writes (charges/subscriptions are written continuously by the indexer). Offset would be simpler to implement but would need replacing later for every list endpoint, including the two built this phase — not worth the rework.

## Open Deviations From PRD Text

- **`amount_usd` omitted from all responses.** No USD price-feed or conversion mechanism exists in any merged phase yet. Rather than hardcode a fake rate, this phase omits the field entirely; a later phase (likely alongside analytics, which needs the same conversion) adds it.
- **Charges in subscription detail are unpaginated.** The PRD doesn't specify pagination for the embedded `charges` array; this spec makes that explicit and justifies it (bounded by subscription age/frequency).

## Global Constraints (for the implementation plan)

- Mirrored on-chain tables in `packages/db/src/schema.ts` MUST NOT be included in `drizzle-kit generate`/`migrate` output — Ponder owns their DDL. Exclude via whatever mechanism `drizzle-kit`'s config supports (e.g., a separate schema file not referenced by `drizzle.config.ts`'s `schema` glob, or explicit `// ponder-owned, do not migrate` comments plus a generate-time exclusion — the implementation plan must pick one and verify no migration file is generated for these three tables).
- All new routes reuse the existing `AppException` / error-envelope pattern from Phase 1b (`apps/api/src/common/errors.ts`) — no new error-handling mechanism.
- All new routes reuse the existing dual-auth pattern (session cookie OR API key) from `GET /v1/merchants/me` (Phase 1b, `apps/api/src/merchants/merchants.controller.ts`) rather than requiring API keys exclusively.
- Cursor pagination shape (`{data, has_more, next_cursor}`, `?limit=&starting_after=`) is binding for both list endpoints in this phase and is the pattern future phases must reuse.
- Money amounts remain raw `NUMERIC(78,0)` strings (matching Phase 1a's indexer schema) — no `amount_usd` this phase (see Open Deviations).
