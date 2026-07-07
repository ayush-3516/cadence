# Phase 1g: Webhooks — Design

## Context

Phases 1e and 1f built the automation loop: a scheduler charges due subscriptions, and dunning retries failures on a backoff ladder. Both phases produce meaningful business transitions (a successful renewal, a payment failure) but only log them via `console.log` — nothing durable is recorded, and nothing is ever delivered anywhere a merchant could see it. Phase 1g closes this gap: a real `event` record for each transition, and HMAC-signed webhook delivery to merchant-registered endpoints.

## Scope

**In scope:**
- `event`, `webhook_endpoint`, `webhook_delivery` app tables (Drizzle-managed, migrated normally).
- `emitEvent(db, merchantId, type, data)` in `apps/worker`, called at the two existing transition points that already exist in this codebase: a successful charge (`apps/worker/src/queues.ts`) and a dunning failure/retry (`apps/worker/src/dunning.ts`).
- A new `webhook-queue` BullMQ Worker in the same `apps/worker` process (alongside the existing `charge-queue` Worker), delivering HMAC-signed payloads with the PRD's fixed retry ladder.
- `apps/api` CRUD for `webhook_endpoint` and read/replay for `webhook_delivery`, all secret-key-only.
- AES-256-GCM encryption of `signing_secret` at rest, using `WEBHOOK_SIGNING_ROTATION_KEY`.

**Explicitly out of scope for this phase:**
- Events for transitions this codebase doesn't yet produce: `plan.created`, `subscription.created`, `subscription.paused`/`resumed`, `subscription.trial_will_end`, `invoice.created`, `payout.distributed`. The `event`/webhook infrastructure is fully general — a future phase adding any of these transitions calls the same `emitEvent` helper with a new type, no changes needed here. This phase does not fabricate events for moments with no real trigger.
- Key rotation for `WEBHOOK_SIGNING_ROTATION_KEY` (a single static key this phase, matching this project's established pattern of building the core mechanism before operational hardening — e.g. Phase 1e deferred fee-bumping/balance-alerting the same way).
- A separate `apps/webhooks` process — the webhook-queue Worker lives in the existing `apps/worker` process, matching the PRD's own three-plane architecture (frontend/API/worker), not a new tier.
- Any customer/portal-facing webhook visibility — all routes are secret-key-only, matching the PRD's table exactly (no `pub` option listed for any webhook route).

## Data Model

### New enums
```
webhook_status  : enabled | disabled
delivery_status : pending | succeeded | failed | dead
```
(`event_type` is a text column, not a Postgres enum, in this phase — only two values exist today; adding a real enum for a two-value set that will grow with every future phase is premature. Follows the same reasoning `onchain_subscription.status`/`onchain_charge.status` already use plain `text` columns rather than Postgres enums, established in Phase 1a.)

### `webhook_endpoint`
```sql
webhook_endpoint (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id     UUID NOT NULL REFERENCES merchant,
  url             TEXT NOT NULL,
  signing_secret  TEXT NOT NULL,                  -- AES-256-GCM ciphertext, never plaintext
  enabled_events  JSONB NOT NULL DEFAULT '["*"]',
  status          webhook_status NOT NULL DEFAULT 'enabled',
  livemode        BOOLEAN NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```
Matches PRD §7.2 exactly. `signing_secret` stores the AES-256-GCM ciphertext (IV + auth tag + ciphertext, packed into one text column, e.g. base64-encoded) — decrypted only in-process, only at delivery time, never returned by any API response after creation.

### `event`
```sql
event (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id     UUID NOT NULL REFERENCES merchant,
  type            TEXT NOT NULL,                  -- "subscription.renewed" | "subscription.payment_failed" this phase
  data            JSONB NOT NULL,
  onchain_tx_hash TEXT,
  livemode        BOOLEAN NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```
Matches PRD §7.2 (with `type` as `text` per the enum decision above). `onchain_tx_hash` is populated for `subscription.renewed` (the charge's tx hash), null for `subscription.payment_failed` (no successful tx to reference).

### `webhook_delivery`
```sql
webhook_delivery (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id     UUID NOT NULL REFERENCES webhook_endpoint,
  event_id        UUID NOT NULL REFERENCES event,
  event_type      TEXT NOT NULL,
  payload         JSONB NOT NULL,
  status          delivery_status NOT NULL DEFAULT 'pending',
  attempts        SMALLINT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  response_code   INTEGER,
  response_body   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, event_id)
);
```
Matches PRD §7.2 exactly, including the `UNIQUE (endpoint_id, event_id)` constraint that makes delivery idempotent per (endpoint, event) pair — a replay re-enqueues the SAME row (incrementing `attempts`), it does not create a new one.

## Emission Point

`emitEvent(db: DbClient, merchantId: string, type: string, data: object, options?: { onchainTxHash?: string }): Promise<void>`:
1. Look up `merchant.livemode` for the given `merchantId` (events/deliveries carry the same `livemode` flag as their merchant).
2. Insert one `event` row.
3. Query `webhook_endpoint` for all `status='enabled'` rows for this `merchant_id` whose `enabled_events` JSONB array contains `"*"` or the specific `type`.
4. For each matching endpoint: insert one `webhook_delivery` row (`status='pending'`, `attempts=0`, `payload` = the event's shape per the PRD's envelope below), then enqueue one `webhook-queue` BullMQ job with `{ deliveryId }`.

Called at exactly two call sites, replacing (not removing — kept alongside) the existing `console.log` lines. Neither existing call site currently resolves a merchant record — both need a NEW lookup, not a reuse of existing logic:
- `apps/worker/src/queues.ts`, in `processChargeJob`, right after the successful `submitCharge` call: resolve the subscription's merchant via `onchain_subscription.onchain_plan_id` → `onchain_plan.merchant_address` → `merchant.owner_address` (a 3-step lookup: fetch the `onchain_subscription` row for `job.data.subId` if not already in scope, fetch its `onchain_plan` row for `merchant_address`, then `SELECT * FROM merchant WHERE owner_address = :merchantAddress AND livemode = false` — this exact merchant-by-owner-address lookup already exists as `MerchantsService.findByOwnerAddress` in `apps/api`, but `apps/worker` has no dependency on `apps/api`, so this phase writes its own equivalent query directly against `schema.merchant`, not by importing across app boundaries). Then `emitEvent(db, merchant.id, "subscription.renewed", { onchain_sub_id, tx_hash }, { onchainTxHash: txHash })`.
- `apps/worker/src/dunning.ts`, in both places `console.log("dunning: payment_failed...")` currently fires (first-failure creation, inside `createRowsForNewFailures`; and repeat-failure retry, inside `advanceOrExhaustRepeatFailures` — NOT the `exhausted` log site, which has no corresponding PRD event type and stays a log-only terminal state per Phase 1f's own established scope boundary). These two sites are NOT symmetric: `createRowsForNewFailures` already fetches the `onchain_plan` row (for its ladder lookup) — that same fetched row's `merchant_address` can be reused for the merchant-resolution query at that site. `advanceOrExhaustRepeatFailures` currently has NO plan lookup at all (it only joins `dunning_state`+`onchain_subscription`, never `onchain_plan`) — this call site needs its OWN new `onchain_plan` fetch (keyed by the subscription's `onchain_plan_id`, which IS already in scope via the joined `onchain_subscription` row) before it can resolve a merchant. Both sites then call `emitEvent(db, merchant.id, "subscription.payment_failed", { onchain_sub_id, attempt })`.

**Resolved design decision on `subscription.renewed`'s trigger (there are two candidate call sites, only one is used):** `dunning.ts`'s existing `deleteRowsForRecoveredSubscriptions` ALSO has a `console.log("dunning: subscription_renewed...")` today, firing specifically when a subscription recovers FROM `past_due` — this is a narrower trigger than "every successful charge." This phase deliberately emits `subscription.renewed` ONLY from `queues.ts`'s successful-charge site (covering both normal on-time renewals and past_due recoveries in one place, since a recovery IS a successful charge from `queues.ts`'s point of view), NOT from `dunning.ts`'s recovery detection — do not add a second `emitEvent` call there, or the same underlying charge would double-emit two `subscription.renewed` events (one from each site) for any recovery case. `dunning.ts`'s existing `console.log` at that site is left as-is (informational only, unchanged).

## Webhook Envelope & Signing (exact, per PRD Appendix D.6)

```json
{ "id": "evt_...", "type": "subscription.renewed", "created": "2026-07-07T00:00:00Z",
  "livemode": false, "data": { /* same shape as the corresponding API resource */ } }
```
`"id"` is the `event.id` prefixed `evt_` (matching the `ck_`-style prefixing convention established for API keys in Phase 1b).

Signing: `t` = current unix time (seconds); `sig = HMAC_SHA256(endpoint.signingSecret, "{t}.{rawBody}")` (hex, lowercase). Header: `Cadence-Signature: t=<t>,v1=<sig>`. Also send `Cadence-Event-Id: <event.id>`.

## Delivery & Retry

BullMQ `webhook-queue`, one job per `webhook_delivery` row, `{ deliveryId }` job data. Processor:
1. Load the `webhook_delivery` row and its `webhook_endpoint`.
2. Decrypt `signing_secret` (AES-256-GCM, `WEBHOOK_SIGNING_ROTATION_KEY`).
3. Build the envelope + signature, POST to `endpoint.url` with a reasonable timeout (10s).
4. On 2xx: mark `succeeded`, record `response_code`.
5. On non-2xx or timeout/network error: increment `attempts`; if `attempts` < 8 (the ladder's length), set `next_attempt_at = now() + ladder[attempts]` (ladder = `[0s,1m,5m,30m,2h,5h,10h,24h]`) and re-enqueue a BullMQ job with a matching delay; else mark `dead`.

Replay (`POST /v1/webhook-deliveries/:id/replay`): re-enqueues the same `webhook_delivery` row's job immediately (bypassing `next_attempt_at`), without resetting `attempts` to 0 — a merchant replaying a `dead` delivery gets one more real attempt recorded in the same row's history, not a fresh idempotency key.

## API Design (`apps/api`, all secret-key-only)

- `POST /v1/webhook-endpoints` — `{ url, enabledEvents?: string[] }` → `{ id, url, signingSecret /* shown once */, enabledEvents, status }`. Generates a random signing secret, encrypts it before storing, returns the raw secret only in this one response.
- `GET /v1/webhook-endpoints` — list, cursor-paginated (matching the established convention), never returns `signing_secret` in any form.
- `PATCH /v1/webhook-endpoints/:id` — `{ url?, enabledEvents?, status? }`.
- `DELETE /v1/webhook-endpoints/:id`.
- `GET /v1/webhook-deliveries` — list, filterable by `endpoint_id`/`status`, cursor-paginated.
- `POST /v1/webhook-deliveries/:id/replay` — no body, 200 on successful re-enqueue.

All scoped to the calling merchant (an endpoint/delivery belonging to another merchant returns 404, matching the ownership-scoping convention established in Phases 1c/1d).

## Testing

- `apps/api`: Testcontainers Postgres e2e tests (matching the established convention) for the CRUD routes — creation shows the secret once, list never exposes it, ownership scoping, replay re-enqueues without resetting attempts.
- `apps/worker`: Testcontainers Postgres unit tests for `emitEvent` (creates the event row, enqueues exactly one job per matching enabled endpoint, respects `enabled_events` filtering including the `"*"` wildcard) and for the encryption helper (encrypt→decrypt round-trip, and confirms the stored value is not the plaintext secret). No anvil/real-HTTP-delivery e2e test this phase — the actual HTTP POST + signature verification is tested via a local HTTP test server (e.g. spinning up a throwaway `http.createServer` in the test process) rather than a real external endpoint, avoiding both flakiness and dependence on network access.

## Global Constraints (for the implementation plan)

- `event.type` is `text`, not a Postgres enum — only two values populated this phase (`subscription.renewed`, `subscription.payment_failed`), by design (see Data Model).
- `emitEvent` is called at exactly the two existing transition points already producing `console.log` output for a real business event — the existing `console.log` calls remain (do not remove them), `emitEvent` is additive.
- `signing_secret` is never stored or returned in plaintext after creation — AES-256-GCM via `WEBHOOK_SIGNING_ROTATION_KEY`, decrypted only in-process at delivery time.
- All new `apps/api` routes are secret-key-only — no publishable-key access to any webhook-related route.
- The webhook-queue Worker lives in the existing `apps/worker` process — no new app/package.
- Retry backoff ladder is exactly `[0s, 1m, 5m, 30m, 2h, 5h, 10h, 24h]` (8 attempts), then `dead` — matching PRD §7.7 verbatim.
- `webhook_delivery`'s `UNIQUE (endpoint_id, event_id)` makes delivery idempotent per (endpoint, event) — replay re-enqueues the same row, never creates a duplicate.
