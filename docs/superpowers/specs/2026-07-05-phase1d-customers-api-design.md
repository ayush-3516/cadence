# Phase 1d: Customers Read/Write API — Design

## Context

Phase 1b built the API foundation (SIWE auth, merchant bootstrap, API keys). Phase 1c built the first two legs of the merchant-facing read API: `GET /v1/plans` and `GET /v1/subscriptions`, both joining Ponder's on-chain projections with merchant-owned off-chain metadata, with a shared dual-auth resolver, cursor pagination, and secret/publishable key-type enforcement.

Phase 1d completes the read-API trio with **customers**: `GET /v1/customers` (list), `GET /v1/customers/:address/subscriptions` (a customer's own subscriptions, portal-facing), and `POST /v1/customers/:address/email` (opt-in email for dunning notices, per PRD §7.2/§7.4). This phase is also a prerequisite for the later dunning-worker phase, which needs an opt-in email address to notify customers of failed payments.

## Scope

**In scope:**
- New `customer` app table (Drizzle-managed, migrated) per PRD §7.2: `id`, `merchant_id`, `address`, `email` (nullable, opt-in), `created_at`, unique on `(merchant_id, address)`.
- `GET /v1/customers` — list a merchant's customers, derived from on-chain subscription activity, cursor-paginated.
- `GET /v1/customers/:address/subscriptions` — a single customer's subscriptions under this merchant, cursor-paginated.
- `POST /v1/customers/:address/email` — upsert the opt-in email for a customer address.

**Out of scope (future phases):** `GET /v1/charges` as a standalone list, invoices, payouts, analytics, webhooks, scheduler, dunning worker (this phase only stores the email dunning will later read).

## Data Model

### New app table: `customer`

```sql
customer (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id   UUID NOT NULL REFERENCES merchant,
  address       TEXT NOT NULL,
  email         TEXT,                             -- opt-in, for dunning notifications
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, address)
);
```

Matches PRD §7.2 exactly. This table stores only the opt-in email override — it is not the source of truth for "who is a customer" (see below). A row may or may not exist for any given on-chain subscriber address; its absence means "no email on file," not "not a customer."

## Customer Sourcing (the core design decision)

A merchant's real customers are defined by on-chain subscription activity (who holds a subscription to one of their plans), not by who has set an email. `customer` has no foreign key or trigger tying it to `onchain_subscription` — it is deliberately a thin metadata table, following the same pattern `plan_meta` established in Phase 1c (on-chain data is the source of truth; the app table only carries metadata that has no on-chain representation).

Consequently:
- `GET /v1/customers` derives its list from `SELECT DISTINCT subscriber_address FROM onchain_subscription JOIN onchain_plan ON ... WHERE onchain_plan.merchant_address = :caller`, LEFT JOINed with `customer` for the `email` field. An address with subscriptions but no `customer` row still appears, with `email: null`.
- `POST /v1/customers/:address/email` does **not** require an existing on-chain subscription for `:address` — it upserts the `customer` row unconditionally (scoped to the caller's merchant), so a merchant (or the address itself, via the portal) can register an email before or independent of on-chain confirmation timing. This mirrors how `plan_meta` rows can be attached without waiting on-chain.

## API Design

### `GET /v1/customers`

Auth: session cookie or **secret** key only (per PRD's `sec` marking).

Query params: `?limit=` (default 20, max 100), `?starting_after=<address>` (cursor is the subscriber address itself, not a numeric ID — see Pagination below).

Query: distinct `subscriber_address` values from `onchain_subscription` scoped through `onchain_plan.merchant_address = :callerOwnerAddress`, ordered alphabetically, LEFT JOINed with `customer` on `(merchant_id, address)` for `email`.

Response shape (`CustomerSummary`):
```json
{
  "address": "0xabc...",
  "email": "user@example.com",
  "subscription_count": 2
}
```

`subscription_count` is the count of this address's subscriptions to the calling merchant's plans (any status) — a useful summary field for a customer list view, computed via `COUNT(*)` in the same grouped query, not a separate round trip.

Response envelope: `{ "data": [CustomerSummary...], "has_more": boolean, "next_cursor": string | null }`.

### `GET /v1/customers/:address/subscriptions`

Auth: session cookie, secret key, or publishable key (per PRD's `sec/pub` marking — "portal uses pub").

Query params: same cursor pagination as `GET /v1/subscriptions` (`?limit=`, `?starting_after=<onchainSubId>`), plus an implicit `subscriber = :address` filter.

This reuses `SubscriptionsService.list()` from Phase 1c unchanged, passing `:address` as the `subscriber` filter parameter — no new query logic, since Phase 1c's subscriptions list already supports filtering by subscriber address, scoped to the caller's merchant. The only new code is the controller route and its auth handling (allowing publishable keys here, unlike `GET /v1/subscriptions` itself, which is secret-only).

Response: identical shape to `GET /v1/subscriptions`'s list response (`{ data: [SubscriptionSummary...], has_more, next_cursor }`). An address with zero subscriptions returns an empty `data` array, not a 404 — "zero subscriptions" is a valid, non-error result, consistent with how `GET /v1/subscriptions?subscriber=X` already behaves for an unrecognized address.

### `POST /v1/customers/:address/email`

Auth: session cookie, secret key, or publishable key (per PRD's `sec/pub` marking).

Request body: `{ "email": string }` (validated as a well-formed email address).

Behavior:
1. Resolve the caller's `merchant_id` (via session address lookup or API-key merchant lookup, matching the existing dual-auth pattern).
2. Upsert `customer` on `(merchant_id, address)`: insert if absent (with the given email), update `email` if present.
3. Return the resulting customer record: `{ "address": "0xabc...", "email": "user@example.com" }`.

**Auth simplification (explicit, deliberate scope boundary):** this endpoint does **not** verify that the caller controls the wallet at `:address` — presenting a valid key (secret or publishable) for the merchant is sufficient to set any address's email under that merchant. There is no signature-based proof of address ownership in this phase. This is acceptable because: (a) the only other authenticated identity in this codebase is merchant login via SIWE, which has no notion of "customer identity" to extend; (b) building customer-side wallet-signature verification is a meaningfully larger scope increase that belongs in a dedicated future phase if customer self-service email management becomes a real product surface; (c) the blast radius of the simplification is limited to a dunning notification email address, not funds or on-chain state. Future hardening path: require a SIWE-style signed message proving control of `:address` before allowing the email to be set for that address, the same way merchant login already proves control of `owner_address`.

## Pagination

`GET /v1/customers` follows Phase 1c's convention (`{data, has_more, next_cursor}`, `?limit=&starting_after=`) with one adaptation: the cursor is the subscriber **address** (text, ordered alphabetically), not a numeric on-chain ID, since there is no single on-chain primary key for "a customer" — the row is a derived `DISTINCT address` grouping. Query pattern: `WHERE subscriber_address > :cursor ORDER BY subscriber_address ASC LIMIT :limit + 1`, then slice and derive `has_more`/`next_cursor` via the existing `buildPageEnvelope` helper, reused unchanged — its type constraint is `T extends { id: string }` (any string-typed `id` field, not specifically numeric), so `CustomerSummary` supplies `id: address` the same way Phase 1c's plan/subscription responses alias their own on-chain ID field to `id`.

`GET /v1/customers/:address/subscriptions` reuses `GET /v1/subscriptions`'s existing numeric-cursor pagination unchanged (no adaptation needed, since it delegates to the same `SubscriptionsService.list()`).

## Error Handling

Reuses `AppException`/`STATUS_BY_TYPE` from Phase 1b/1c. No new error codes are needed for missing customers — an address with no subscriptions and no email is not an error state for either read endpoint (both return an empty list, not a 404). Standard validation errors apply to the email body (`invalid_request_error`, 400, `invalid_email`) and to pagination params (reusing the existing `invalid_limit`/`invalid_cursor` codes).

## Testing

Existing Testcontainers + Vitest e2e harness. Required coverage:
- Customer list: derives correctly from seeded `onchain_subscription` rows across multiple plans/subscribers for one merchant; another merchant's subscribers never appear; a customer with a `customer` row shows the email, one without shows `null`; `subscription_count` is correct when an address has 2+ subscriptions; pagination (`has_more`/`next_cursor`) across a real multi-address scenario.
- Customer subscriptions: returns only the given address's subscriptions, scoped to the calling merchant (another merchant's plan-subscription for the same address must not appear); empty list (not 404) for an address with zero subscriptions; publishable key accepted (positive case, unlike the secret-only `GET /v1/subscriptions`).
- Email set: creates a `customer` row on first call; upserts (updates existing email) on a second call for the same address; works with either key type; independent of whether an on-chain subscription exists for that address yet.

## Global Constraints (for the implementation plan)

- The `customer` table is migrated normally via `packages/db`'s standard `drizzle-kit generate`/`migrate` path (it is an app-owned table, unlike the on-chain mirrors from Phase 1c) — no special exclusion needed.
- All new routes reuse the existing `AppException`/error-envelope pattern and the existing dual-auth resolver (`AuthContextService`) from Phase 1b/1c — no new auth or error mechanism.
- `GET /v1/customers` requires a secret key (or session cookie); `GET /v1/customers/:address/subscriptions` and `POST /v1/customers/:address/email` accept either key type (or session cookie).
- Cursor pagination shape is unchanged from Phase 1c (`{data, has_more, next_cursor}`, `?limit=&starting_after=`); `GET /v1/customers`'s cursor is a text address rather than a numeric ID, everything else identical.
- `POST /v1/customers/:address/email` does not verify wallet ownership of `:address` — this is an explicit, documented simplification, not an oversight (see Auth simplification above).
- Money/`amount_usd` conventions are not relevant to this phase (no monetary fields in any customer response).
