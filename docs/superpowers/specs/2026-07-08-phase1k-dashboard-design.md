# Phase 1k: Merchant Dashboard (read-only) — Design Spec

## Goal

Build the first real page of `apps/web` (currently an empty scaffold): a Next.js 15 (App
Router) merchant dashboard covering SIWE sign-in and five read-only routes, all backed by
REST endpoints that already exist and are live on `main` (Phases 0 through 1i). No on-chain
writes, no missing backend endpoints, no marketing site, no customer portal — those are
separate future phases.

## Background: scoping against PRD §8.4

PRD §8.4 documents ten dashboard routes, several of which assume infrastructure this project
hasn't built yet: `/dashboard/plans/new` (a wizard needing `createPlan`/`setPlanActive`
on-chain writes plus 0xSplits integration for revenue-share), `/dashboard/payouts` (no
`/v1/payouts` endpoint exists), and `/dashboard/settings` (mixes real dunning-ladder config
with unbuilt treasury/split defaults). Building the full spec in one phase would mean adding
missing backend endpoints, wallet-write infrastructure, and every page simultaneously.

**Resolved:** this phase builds only the routes that are pure reads against existing,
already-shipped endpoints:

- `/dashboard` — overview (MRR, active/trialing/past-due counts, recent activity)
- `/dashboard/plans` — list only (no create wizard, no archive/activate — both are on-chain
  writes)
- `/dashboard/subscriptions` — list + detail (includes charge history, already returned by
  `GET /v1/subscriptions/:onchainId`)
- `/dashboard/analytics` — MRR/ARR chart, churn, cohort retention (all four
  `GET /v1/analytics/*` routes from Phase 1i)
- `/dashboard/developers` — API keys (create/list/revoke) and webhook endpoints/deliveries
  (full CRUD + replay) — these ARE writes, but to off-chain metadata via already-real REST
  endpoints, not on-chain transactions, so they fit this phase's "no wallet writes" boundary

**Explicitly deferred:** `/dashboard/plans/new` (create wizard), plan archive/activate,
`/dashboard/payouts`, `/dashboard/settings`, the `SplitFlow` component (no data source yet),
the customer portal (`/portal/*`), the marketing site (`/`).

## Auth: SIWE sign-in, not the SDK

`@cadence/sdk` (Phase 1j) is deliberately API-key-only — it cannot authenticate the SIWE
sign-in flow (`POST /v1/auth/nonce`, `POST /v1/auth/verify`) or any subsequent
session-cookie-authenticated request, since those need cookies, not a Bearer token. This is
not a gap to patch in the SDK; the SDK's own design spec already anticipated this dashboard
phase would resolve session auth separately.

**Resolved:** the dashboard calls `apps/api` directly via a thin `apiFetch` helper
(`fetch` with `credentials: "include"`), mirroring the pattern this project's own e2e test
suites already use to exercise session auth. The SDK is not imported by this phase at all —
every dashboard read goes through `apiFetch`, since every relevant endpoint
(`plans`/`subscriptions`/`analytics`/`webhook-endpoints`/`webhook-deliveries`/`api-keys`)
already accepts a session cookie identically to a secret API key, per the established
dual-auth convention (`AuthContextService.resolve`).

Sign-in flow: a Client Component (`<SignInButton>`) uses wagmi's `useAccount`/
`useSignMessage` to get the connected wallet's signature over the SIWE message, then calls
`apiFetch("/v1/auth/nonce")` → constructs the message → `signMessageAsync` →
`apiFetch("/v1/auth/verify", {method: "POST", body: {message, signature}})`. The browser
stores the resulting `cadence_session` httpOnly cookie automatically; no client-side token
handling needed.

## Wallet stack

PRD §8.2 specifies wagmi v2 + viem + ConnectKit for chain `base`/`baseSepolia`. Even though
this phase has no on-chain reads/writes, SIWE sign-in needs a connected wallet to produce a
signature.

**Resolved:** install the full wagmi + viem + ConnectKit stack now rather than a minimal
ad-hoc `window.ethereum` shim, since (a) it's needed regardless for the on-chain-writes phase
that will follow this one, avoiding a later migration, and (b) ConnectKit provides a
production-quality wallet-connect UI for free. Configured for `baseSepolia` only in this
phase (matches the backend's current testmode-only scope — `LIVE_CHAIN_IDS` in
`plans.service.ts` only recognizes Base mainnet as livemode, and this project has no livemode
merchant support yet per Phase 1i's own documented limitation).

## Design system

PRD §8.1's full palette and typography are adopted now (not deferred), since the cost is low
and every later phase benefits from not retrofitting it:

- **Palette** (Tailwind theme tokens): `ink #0B1020`, `paper #FBFAF7`, `sapphire #2F5BFF`,
  `signal #F4A62A`, `mint #17B890`, `slate #5B6478`.
- **Typography**: Space Grotesk (display/headings), Geist Sans (body/UI text), Geist Mono
  (all money figures, token amounts, addresses, tx hashes — tabular-nums so columns align).

Two `packages/ui` components are built in this phase (the first real components in that
otherwise-empty package):

- **`CadencePulse`** — the billing-rhythm waveform, reads only `period_seconds` and
  `current_period_end` from a `Subscription`/`Plan` (both already returned by existing
  endpoints) — no new backend needed.
- **`StatusBadge`** — status→color mapping (`active`→mint, `past_due`/`paused`→signal,
  `canceled`→slate), used across the plans/subscriptions tables.

**`SplitFlow`** (the animated revenue-split visualization) is explicitly deferred — it
depicts a charge's fee/net/recipient split, and this project has no real payout/split data
source yet (`/v1/payouts` doesn't exist). Building it now would mean mocking data with no
real backing, which this phase's "only wrap what's real" principle (established in the SDK
phase) rules out.

`packages/ui` is bootstrapped alongside the dashboard in this same phase, rather than as a
separate prior phase, since the dashboard is `packages/ui`'s only consumer so far — building
it in isolation first would mean designing an API with no real consumer to validate it
against, and inlining components into `apps/web` now would mean extracting them later anyway.

## Architecture

- **Server Components** fetch on the server for the initial render of each route (using
  Next's `cookies()` to forward the session cookie through the same `apiFetch` helper).
- **TanStack Query** hydrates client-side from the server-fetched initial data, enabling
  refetch/pagination interactivity without a full page reload.
- **`<ChainGuard>`-lite**: before allowing sign-in, check the connected wallet's chain against
  the configured `baseSepolia` chain ID; prompt to switch if mismatched. This is a reduced
  version of PRD §8.2's full `<ChainGuard>` (which also blocks money actions) — this phase has
  no money actions to block, only sign-in to gate.
- **Route structure**: `apps/web/app/(dashboard)/dashboard/{page.tsx, plans/page.tsx,
  subscriptions/{page.tsx, [id]/page.tsx}, analytics/page.tsx, developers/page.tsx}`,
  matching Next 15's App Router route-group convention from PRD §8's own architecture note.

## Testing

- **Component tests** (Vitest + Testing Library, in `packages/ui`): `CadencePulse` (renders
  correct tick count/active-tick position from period math), `StatusBadge` (status→color
  mapping), `AddressDisplay`/`TokenAmount` if built as small supporting primitives for the
  tables.
- **Integration test**: the SIWE sign-in flow, with a mocked wallet (`useAccount`/
  `useSignMessage` mocked) asserting the nonce→sign→verify sequence and that a successful
  verify leads to an authenticated state.
- **No Playwright e2e in this phase** — PRD §8.8's e2e scope centers on the subscribe wizard
  (an on-chain-write flow this phase explicitly excludes); a read-only dashboard has
  substantially lower e2e value until a write flow exists to test end-to-end.
- **Accessibility**: axe checks on each of the five routes (per PRD §8.8), keyboard
  navigation pass on the sign-in flow specifically (no wizard to test yet).

## Explicitly out of scope for this phase

- `/dashboard/plans/new` (create-plan wizard), plan archive/activate — both are on-chain
  writes, deferred to a phase that builds the wallet-write infrastructure.
- `/dashboard/payouts` — no `/v1/payouts` backend endpoint exists.
- `/dashboard/settings` — mixes real (dunning ladder) and unbuilt (treasury/split defaults)
  concerns; deferred whole rather than split.
- `SplitFlow` component — no real data source.
- Customer portal (`/portal/*`), marketing site (`/`) — separate future phases.
- `@cadence/sdk` usage — this phase uses direct `apiFetch` with session cookies throughout,
  not the API-key-only SDK.
- Livemode support — wallet/chain config targets `baseSepolia` only, matching the backend's
  existing testmode-only scope.
- Playwright e2e tests — deferred until an on-chain-write flow exists to justify the setup
  cost, per PRD §8.8's own e2e scope centering on the subscribe wizard.
