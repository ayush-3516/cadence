# Phase 1b — API Foundation: Design

**Date:** 2026-07-04
**Status:** Approved for planning
**Source:** `cadence-prd.md` §7.2 (app tables subset), §7.3, §7.4 (subset), §7.4.1, §7.11, Appendix D.3

## 1. Purpose

Build the foundation of Cadence's backend API: the Drizzle-managed app-owned
database tables, a NestJS service skeleton, and the auth layer everything
else depends on — SIWE merchant sign-in and API-key issuance/verification.
This is the second Phase 1 sub-project after the indexer (Phase 1a); read
endpoints for plans/subscriptions/analytics/webhooks are a separate,
later sub-project that depends on this one.

## 2. Non-goals (explicitly deferred)

- All read endpoints from PRD §7.4's table except `GET /v1/merchants/me`
  (plans, subscriptions, customers, charges, invoices, payouts, analytics,
  webhook-endpoints, webhook-deliveries, events, prepare-helpers) — a
  later sub-project.
- App tables beyond `merchant` and `api_key`: `plan_meta`, `customer`,
  `dunning_state`, `invoice`, `webhook_endpoint`, `event`,
  `webhook_delivery`, `analytics_daily` — built when the sub-project that
  reads/writes them exists.
- Rate limiting (Redis token bucket) — real, but deferred; this slice's
  auth guard establishes the `{merchantId, livemode, keyType}` context
  rate limiting would key off of, without implementing the limiter itself.
- Idempotency-Key handling for POSTs — deferred to the sub-project that
  adds mutating endpoints beyond key/merchant creation (this slice's two
  POSTs — merchant creation via SIWE, API key creation — are inherently
  non-repeatable in a way that makes idempotency replay less urgent; note
  this as an open item, not a permanent exemption).
- The worker/scheduler, frontend, and SDK — untouched.

## 3. Database (`packages/db`)

Drizzle ORM, migrations via `drizzle-kit`, targeting the same Postgres
instance the indexer uses (separate tables, no overlap — Ponder owns
`onchain_*`, Drizzle owns these).

Exact table definitions from PRD §7.2 (frozen interface — a later
sub-project depends on these column names/types):

```sql
merchant (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  owner_address   TEXT NOT NULL,
  livemode        BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ, updated_at TIMESTAMPTZ,
  UNIQUE (owner_address, livemode)
);

api_key (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id   UUID NOT NULL REFERENCES merchant,
  type          api_key_type NOT NULL,           -- publishable | secret
  key_hash      TEXT NOT NULL,
  prefix        TEXT NOT NULL,
  livemode      BOOLEAN NOT NULL,
  last_used_at  TIMESTAMPTZ, revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ,
  UNIQUE (key_hash)
);  -- idx: (merchant_id), (key_hash)
```

`api_key_type` enum: `publishable | secret`.

## 4. NestJS API (`apps/api`)

Fastify adapter, `nestjs-zod` for request validation, Swagger/OpenAPI
auto-generated at `/docs`, per PRD §4.2's tech stack table.

### 4.1 SIWE sign-in flow (PRD §7.4.1)
1. `GET /v1/auth/nonce` — generates and stores a single-use, expiring
   nonce (a short random string), returns it to the caller.
2. Frontend constructs an EIP-4361 SIWE message embedding that nonce, has
   the merchant's wallet sign it.
3. `POST /v1/auth/verify` — body `{ message, signature }`. Verifies the
   signature recovers to the address the message claims, verifies the
   nonce matches a stored, unexpired, unused one (and marks it used),
   verifies the message's domain/expiration fields. On success, issues a
   session (signed JWT, delivered as an httpOnly cookie) and returns the
   merchant's `owner_address`.
4. `POST /v1/merchants` (session-authed) — body `{ name, ownerAddress }`
   per PRD Appendix D.3, creates the `merchant` row (`livemode` defaults
   false for this slice — a merchant only gets a `livemode=true` row once
   they explicitly go live, itself a later concern). Requires the session's
   verified address to match `ownerAddress`.
5. `GET /v1/merchants/me` — sec/pub auth (session OR API key), returns the
   authenticated merchant's profile. This is the slice's end-to-end proof
   endpoint.

### 4.2 API keys (PRD §7.3)
- **Format:** `ck_{test|live}_{pub|sec}_{random}` — random is a
  cryptographically random string (e.g. 24 bytes, base62-encoded).
- **Storage:** `sha256(key)` in `key_hash`, plus a `prefix` for display
  (e.g. `ck_test_sec_a1b2c3d4`, first ~12 chars). Raw key returned exactly
  once, at creation.
- `POST /v1/api-keys` (session-authed) — body `{ type: "secret" | "publishable" }`,
  returns `{ id, key, prefix }` (key shown once).
- `GET /v1/api-keys` (session-authed) — lists `{ id, type, prefix, livemode, lastUsedAt, revokedAt }`, never the raw key or hash.
- `DELETE /v1/api-keys/:id` (session-authed) — sets `revoked_at`.

### 4.3 Auth guard (the core mechanism everything downstream depends on)
A NestJS guard applied per-route:
- Extracts `Authorization: Bearer <key>`, hashes it, looks up `api_key`
  where `key_hash` matches and `revoked_at IS NULL`. Attaches
  `{ merchantId, livemode, keyType }` to the request.
- Separately, a session guard checks the SIWE-issued JWT/cookie, attaches
  `{ merchantId, livemode: false }` (sessions imply dashboard/test-mode
  context in this slice — real live-mode session handling is a later
  concern once the dashboard exists).
- Endpoints declare which guard(s) they accept (`sec` = secret-key-only,
  `pub` = publishable-or-secret, session-only for merchant/key management
  itself per the table above).
- Publishable keys are rejected on any write route (checked at the guard
  or via a decorator + interceptor).
- `last_used_at` updated on successful auth, throttled (e.g., only if
  more than 60s since last update, to avoid a write on every request) —
  implemented as a simple in-guard check against the fetched row's current
  value, not a separate scheduled job.

### 4.4 Error envelope (PRD §7.4)
A global NestJS exception filter producing:
```json
{ "error": { "type": "invalid_request_error", "code": "plan_not_found",
             "message": "...", "param": "..." } }
```
Error types this slice actually exercises: `authentication_error` (401,
bad/missing/revoked key or session), `invalid_request_error` (400, Zod
validation failures; 404, merchant/key not found), `api_error` (500,
unexpected). `permission_error` (403) and `rate_limit_error` (429) are
defined in the filter's type union now (so the shape is frozen per PRD
Appendix A) but this slice has no route that actually triggers them yet.

### 4.5 Health check
`GET /v1/health` — no auth, returns liveness (confirms the process is up)
and readiness (confirms it can reach Postgres).

## 5. Testing (PRD §7.11, using Testcontainers)

Integration tests via Supertest + `@testcontainers/postgresql` (a fresh,
isolated Postgres container per test suite run, migrations applied against
it before tests execute):
- SIWE flow: nonce issuance, valid signature → session issued, invalid
  signature → 401, expired/reused nonce → 401, merchant creation requires
  a matching session address.
- API key lifecycle: create (secret + publishable), list (prefixes only,
  no raw key/hash ever returned), revoke, auth with a revoked key → 401,
  auth with a publishable key on a write route → 403.
- Mode partitioning: a `livemode=true` merchant row and a
  `livemode=false` row for the same `owner_address` are distinct and
  don't leak into each other's key lists.
- Error envelope shape asserted on at least one 400 and one 401 case.
- `GET /v1/health` returns 200 when Postgres is reachable.

Unit tests (Vitest, per PRD's general testing stack) for: key hashing,
key format generation/parsing, SIWE message/nonce validation logic in
isolation from HTTP.

## 6. Definition of Done

- [ ] `packages/db` has `merchant`/`api_key` tables + `api_key_type` enum,
      migrations runnable via `drizzle-kit`.
- [ ] `apps/api` NestJS app boots, Swagger docs at `/docs`.
- [ ] Full SIWE flow works: nonce → sign → verify → session issued.
- [ ] `POST /v1/merchants` creates a merchant tied to the session's
      verified address.
- [ ] API key issuance, listing (prefix-only), and revocation work.
- [ ] Auth guard correctly attaches `{merchantId, livemode, keyType}`,
      rejects revoked keys, rejects writes on publishable keys.
- [ ] `GET /v1/merchants/me` works via both session and API key.
- [ ] Standard error envelope shape used consistently.
- [ ] Integration test suite (Testcontainers) covers the above; unit
      tests cover key hashing/format and SIWE validation logic.

## 7. Open items carried forward (not blocking this phase)

- Rate limiting (Redis token bucket) — the guard's `{merchantId, ...}`
  context is exactly what a rate limiter would key off of; implementing
  the limiter itself is deferred.
- Idempotency-Key replay storage — deferred until a sub-project adds
  POSTs where replay-safety materially matters (e.g., a payment-adjacent
  action); flagged as a real gap to close then, not a permanent exemption.
- `livemode=true` merchant/session semantics — this slice treats sessions
  as implicitly test-mode; a merchant explicitly switching to live mode
  (and what unlocks that) is a later product decision.
- CORS configuration (locking origins to the dashboard/portal) — no
  frontend exists yet to lock origins to; deferred until one does.
