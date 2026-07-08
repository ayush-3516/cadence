# Phase 1j: SDK (`@cadence/sdk`) — Design Spec

## Goal

Build `@cadence/sdk`, a thin, typed, isomorphic (Node + browser) TypeScript
client wrapping the REST API this project has already shipped through
Phase 1i. Location `packages/sdk` (currently an empty scaffold — just a
`package.json`). Per PRD §10, this is "the DX moat" — a first-class
deliverable, not an afterthought.

## Background: scoping against what's actually built

The PRD's §10 method list (`cadence.payouts`, `cadence.events`,
`cadence.onchain.prepareX()`) references `/v1/payouts`, `/v1/events`, and
`/v1/prepare/*` — none of which exist as real endpoints in this codebase
today. A grep of every `apps/api/src/*/*.controller.ts` file confirms the
only real resource controllers are: `merchants`, `api-keys`, `plans`,
`subscriptions`, `customers`, `invoices`, `analytics`, `webhook-endpoints`,
`webhook-deliveries`, `auth`, `health`.

**Resolved:** this phase's SDK wraps only real, live endpoints. Payouts,
events, and on-chain `prepare` helpers are deferred to a future phase once
their backend routes exist — building them now would silently expand scope
beyond §10's SDK-specific mandate into new backend work.

**Resolved (auth):** API-key auth only (`Authorization: Bearer <key>`).
Session-cookie auth (SIWE sign-in, used by the not-yet-built dashboard) is
a browser/dashboard-app concern, not this general-purpose SDK's.

**Resolved (api-keys):** `POST /v1/api-keys`, `GET /v1/api-keys`, and
`DELETE /v1/api-keys/:id` are entirely gated by `@UseGuards(SessionGuard)`
in `apps/api/src/api-keys/api-keys.controller.ts` — there is no API-key-
authenticated path to any of them. Given the API-key-only auth decision
above, `cadence.apiKeys.*` has no callable backend route in this phase and
is dropped from the SDK's surface entirely, the same treatment as
payouts/events/prepare. A future phase can add it back if/when the SDK
also supports session-cookie auth. `POST /v1/merchants` (merchant
creation) is similarly session-only and is also excluded; `GET
/v1/merchants/me` is NOT session-gated (it uses `AuthContextService.
resolve`, which accepts any key type) and remains in scope.

**Resolved (init):** the PRD's example `new Cadence({ apiKey, chain })`
included a `chain` param for the on-chain helpers this phase excludes —
dropped. Constructor is `{ apiKey, baseUrl? }`, with `baseUrl` defaulting
to `http://localhost:3000` (this project has no hosted API deployment yet;
`http://localhost:3000` matches `apps/api`'s own `.env.local.example`
default `PORT`/`SIWE_URI`).

**Resolved (HTTP client):** native `fetch`, no runtime HTTP dependency.
Node 18+ (this project's floor) and every modern browser both ship global
`fetch`; `apps/worker/src/webhook-delivery.ts` already calls `fetch`
directly rather than pulling in axios/node-fetch, so this matches existing
practice as well as being the natural isomorphic choice.

**Resolved (build output):** CommonJS, matching every other package in
this monorepo (`packages/db`, `packages/shared` both ship
`tsc -p tsconfig.build.json` → CJS `dist/`, despite their dev-facing
`tsconfig.json` looking ESM/Bundler-mode — that file is typecheck/IDE-only,
not the real build). Modern bundlers (webpack/Vite/Next.js) consume CJS
dependencies transparently, so this doesn't block real browser use, and it
keeps `packages/sdk`'s tooling consistent with its siblings rather than
introducing the one ESM-only outlier in the repo.

## Architecture

One internal `request()` helper does all HTTP work: builds the full URL
from `baseUrl` + path, injects `Authorization: Bearer <apiKey>`,
JSON-encodes request bodies, parses JSON responses, and — for any
non-2xx status — parses the standard `{ error: { type, code, message,
param? } }` envelope and throws a `CadenceError`.

Each REST resource area gets its own small class (`PlansResource`,
`SubscriptionsResource`, etc.), constructed with a reference to the shared
`request()` helper. The top-level `Cadence` class instantiates one of each
in its constructor and exposes them as public readonly properties
(`this.plans = new PlansResource(request)`), mirroring how `apps/api`
already organizes one NestJS module per resource — this is the same
decomposition, just mirrored client-side. No resource class knows about
any other; each is independently testable by injecting a mock `request`
function.

```
packages/sdk/src/
  client.ts          — Cadence class, constructor, request() helper, CadenceError
  types.ts           — shared response/param types (Plan, Subscription, Customer, Invoice, ...)
  resources/
    merchants.ts
    api-keys.ts
    plans.ts
    subscriptions.ts
    customers.ts
    invoices.ts
    analytics.ts
    webhook-endpoints.ts
    webhook-deliveries.ts
    webhooks-verify.ts   — pure HMAC helper, no network call
  index.ts           — public exports (Cadence, CadenceError, types)
```

## Resource surface (mapped 1:1 to real controllers)

- `cadence.merchants.me()` → `GET /v1/merchants/me`
- `cadence.plans.list(filter)` / `.get(onchainId)` /
  `.attachMetadata(onchainId, {name, description})` →
  `GET /v1/plans`, `GET /v1/plans/:onchainId`,
  `POST /v1/plans/:onchainId/metadata`
- `cadence.subscriptions.list(filter)` / `.get(onchainId)` →
  `GET /v1/subscriptions`, `GET /v1/subscriptions/:onchainId`
- `cadence.customers.list()` / `.subscriptions(address)` /
  `.setEmail(address, email)` → `GET /v1/customers`,
  `GET /v1/customers/:address/subscriptions`,
  `POST /v1/customers/:address/email`
- `cadence.invoices.list(filter)` / `.get(id)` → `GET /v1/invoices`,
  `GET /v1/invoices/:id`
- `cadence.analytics.summary()` / `.mrr(range)` / `.churn(range)` /
  `.cohorts()` → the four `GET /v1/analytics/*` routes from Phase 1i
- `cadence.webhookEndpoints.create({url, events})` / `.list()` /
  `.update(id, {...})` / `.delete(id)` → the four
  `/v1/webhook-endpoints*` routes
- `cadence.webhookDeliveries.list(filter)` / `.replay(id)` →
  `GET /v1/webhook-deliveries`, `POST /v1/webhook-deliveries/:id/replay`
- `cadence.webhooks.verifySignature(rawBody, header, secret): boolean` —
  pure local HMAC verification, no network call. Reverses the exact scheme
  `apps/worker/src/webhook-delivery.ts` already signs with: header format
  `t=<unix_ts>,v1=<hex_hmac_sha256>`, signed payload `` `${t}.${rawBody}` ``,
  algorithm `createHmac("sha256", secret)`. Parses `t`/`v1` out of the
  header, recomputes the HMAC, and compares using a constant-time compare
  (`crypto.timingSafeEqual`) to avoid a timing side-channel — matching how
  Stripe's own SDK (this PRD's explicit model) implements the equivalent
  helper.

Auth for merchant sign-in (`POST /v1/auth/nonce`, `POST /v1/auth/verify`)
is intentionally NOT wrapped — SIWE sign-in is a session-cookie/browser
dashboard flow, out of scope per the API-key-only resolution above.

## Error handling

```ts
export class CadenceError extends Error {
  type: string;      // "invalid_request_error" | "authentication_error" | ...
  code: string;       // "plan_not_found", "key_type_not_allowed", ...
  status: number;      // the HTTP status the API actually returned
  param?: string;
}
```

Any non-2xx response is parsed and thrown as a `CadenceError`. Callers
catch one class and branch on `.code`/`.type` if they need to — standard
SDK ergonomics, matching how Stripe's own SDK (explicitly referenced by
this PRD as the model to follow) surfaces API errors.

## Pagination

List methods return the raw envelope, typed generically:

```ts
interface PageEnvelope<T> {
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}
```

Callers pass `next_cursor` back in as `starting_after` for the next page.
No auto-pagination iterator in this phase — thin wrapping only, matching
the PRD's own "thin, typed, wrapping REST" framing for the SDK.

## Testing

- **Unit tests for `request()`/error mapping:** mock global `fetch`
  (via `vi.stubGlobal("fetch", ...)` or equivalent), assert the URL/method/
  headers/body sent for a representative call in each resource, assert a
  non-2xx JSON error response is correctly thrown as `CadenceError` with
  the right `.type`/`.code`/`.status`/`.param`.
- **Per-resource tests:** for each resource class, at least one test per
  method confirming it calls `request()` with the correct path/query
  params/body shape and returns the (mocked) response verbatim/typed.
- **`verifySignature` round-trip test:** sign a payload with
  `createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")`
  (the exact algorithm `webhook-delivery.ts` uses), verify
  `verifySignature` accepts it; then tamper with the body or secret and
  verify it rejects. No real network/webhook infra needed — this is pure
  local crypto.
- No integration/e2e suite against a real running `apps/api` in this
  phase — the per-resource unit tests (mocked `fetch`) are sufficient to
  prove each method builds the correct request; the request/response
  shapes themselves are already proven correct by `apps/api`'s own e2e
  suites from Phases 1a–1i.

## Explicitly out of scope for this phase

- `cadence.onchain.*` (prepareCreatePlan, prepareSubscribeWithPermit,
  prepareCancel, etc.) — no `/v1/prepare/*` backend endpoints exist yet.
- `cadence.payouts` — no `/v1/payouts` backend endpoint exists yet.
- `cadence.events` — no `/v1/events` backend endpoint exists yet.
- `cadence.apiKeys.*` — `/v1/api-keys*` is entirely session-cookie-gated,
  no API-key-authenticated path exists.
- `cadence.merchants.create()` — `POST /v1/merchants` is session-only.
- Session-cookie/SIWE auth support in the SDK.
- Auto-pagination (async iterators).
- `@cadence/react` (hooks, `<SubscribeButton />`) — explicitly a later
  PRD deliverable ("React package `@cadence/react` later").
- Any frontend consumption of this SDK (the dashboard/portal apps
  themselves remain unbuilt, per this session's own scoping discussion).
