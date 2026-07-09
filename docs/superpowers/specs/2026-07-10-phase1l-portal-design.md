# Phase 1l: Customer Portal — Design Spec

## Goal

Build the Customer Portal, at a new `(portal)` route group in the existing `apps/web`
Next.js app (currently only has `(dashboard)`). Per PRD §8.5, this is the subscriber-facing
UI: viewing subscriptions with balance warnings, managing a subscription (cancel/pause/
resume), and viewing/downloading invoices. Auth is wallet-connect only — no SIWE, no
session, no account.

## Background: scoping against PRD §8.5 and the real backend/on-chain state

PRD §8.5 documents four routes. Two assumptions in the PRD don't hold once checked against
the actual codebase state:

**On-chain writes are NOT uniformly blocked, unlike the dashboard's create-plan wizard.**
`cancel(subId, immediate)`, `pauseSubscription(subId)`, and `resumeSubscription(subId)` are
plain contract calls on `SubscriptionManager` needing only the caller's own on-chain
subscription id — no calldata-preparation endpoint, no 0xSplits-style external integration.
`packages/shared` already exports the full `subscriptionManagerAbi` (confirmed via
`packages/shared/src/index.ts`). These three writes can be wired directly via wagmi's
`useWriteContract`, with zero new backend work — a materially different situation from the
dashboard phase's plan-creation wizard, which was genuinely blocked by missing
`/v1/prepare/*` and 0xSplits integration.

`/portal/subscribe/[planId]`, by contrast, genuinely needs `GET /v1/prepare/subscribe`
(EIP-2612 permit typed-data) — confirmed absent from `apps/api/src/` (no `prepare` module
exists anywhere). This route is deferred, matching the exact category of gap the dashboard
phase already established a precedent for deferring.

**Resolved:** this phase builds `/portal` (list), `/portal/subscriptions/[id]` (detail, with
REAL cancel/pause/resume wallet-write buttons — not stubs), and `/portal/invoices`. It
defers `/portal/subscribe/[planId]` (blocked) and "revoke spending permission" (a separate
allowance/permit-revocation investigation not covered by this design).

**The portal is inherently single-merchant, not cross-merchant.** `GET /v1/customers/
:address/subscriptions` requires a publishable API key and is scoped to that key's one
merchant (`resolveCallerOwnerAddress` filters by the key's own `merchant.ownerAddress` —
confirmed by reading `apps/api/src/customers/customers.controller.ts` in full). There is no
endpoint that aggregates a wallet's subscriptions across every merchant it has ever
subscribed to. This is not a gap to fill — PRD §8.5's own closing note says the portal "can
be white-labeled/embedded per merchant later," which is exactly this shape: one portal
deployment, one merchant, one publishable key.

**Resolved:** the portal is configured with a single `NEXT_PUBLIC_PORTAL_PUBLISHABLE_KEY`
build-time env var identifying which merchant this deployment serves. A connected wallet's
subscriptions are shown for that one merchant only.

## Auth and HTTP client

**Resolved (auth):** wallet-connect only via the same wagmi/ConnectKit setup already
configured for the dashboard (`apps/web/lib/wagmi-config.ts`) — reused as-is, same
`baseSepolia` chain target. No sign-in flow, no session cookie: a connected wallet address
is sufficient to query "this address's subscriptions with this merchant."

**Resolved (HTTP client):** the portal uses `@cadence/sdk` directly
(`cadence.customers.subscriptions(address)`, `cadence.invoices.list({subscriber})`) rather
than a hand-rolled `apiFetch` like the dashboard's. The dashboard couldn't use the SDK
because it authenticates via session cookies, a model the SDK deliberately excludes (Phase
1j's own design spec). The portal authenticates via `Authorization: Bearer <publishable_key>`
— exactly the SDK's intended use case. This is the SDK's first real consumer in this
codebase. The `Cadence` client is constructed once (module-level, in a small
`lib/cadence-client.ts`) with `NEXT_PUBLIC_PORTAL_PUBLISHABLE_KEY` and
`NEXT_PUBLIC_API_BASE_URL` (reusing the dashboard's existing env var).

**No new CORS work.** The portal lives in the same `apps/web` Next.js server/origin as the
dashboard (same port 3001) — `apps/api`'s existing `CORS_ORIGINS` allowlist from the
dashboard phase already covers it.

## Routes

- **`/portal`** — subscription list. Each card: plan name, price (`font-data`, tabular),
  status (`StatusBadge`, reused from `packages/ui`), cadence pulse to next charge
  (`CadencePulse`, reused as-is), and a balance warning if the connected wallet's USDC
  balance is below the next charge amount. Uses `cadence.customers.subscriptions(address)`.
- **`/portal/subscriptions/[id]`** — detail. **Resolved (data source):** `GET
  /v1/subscriptions/:onchainId` (the full detail endpoint, with `plan`/`charges`) requires a
  secret or session key — confirmed in `apps/api/src/subscriptions/subscriptions.controller.ts`,
  it rejects publishable keys outright. The portal has only a publishable key. The only
  endpoint actually available is `GET /v1/customers/:address/subscriptions` (via
  `cadence.customers.subscriptions(address)`), which returns the summary shape only — no
  plan name, no `period_seconds`, no charge history. This page therefore shows status,
  `onchain_sub_id`, subscriber address, and the three wallet-write actions
  (cancel/pause/resume — each needs only the `onchain_sub_id`, already available from the
  summary), found by filtering the same list the `/portal` page already fetches down to the
  one matching `onchain_sub_id`. No charge-history table, no full plan name/period display —
  this is a real, permanent API constraint (publishable keys are deliberately more
  restricted than secret keys throughout this codebase), not a temporary gap to work around.
  Cancel offers **immediate or at period end** (passed as `cancel`'s `immediate` boolean
  param); only one of Pause/Resume is shown, depending on current status.
- **`/portal/invoices`** — all invoices for the connected wallet across this merchant, with
  a **Download** link to each invoice's `pdf_url`. Uses `cadence.invoices.list({subscriber:
  address})`.

## On-chain writes

Each of cancel/pause/resume follows the PRD's own state-machine framing, adapted from the
subscribe wizard's documented pattern since this is the closest existing precedent:
`idle → confirming (wallet prompt shown) → pending (tx submitted, awaiting confirmation) →
processing (tx confirmed, awaiting indexer to reflect the new status) → done | error`. Wired
via wagmi's `useWriteContract` + `useWaitForTransactionReceipt` against
`subscriptionManagerAbi` (imported from `@cadence/shared`, matching the exact pattern
`apps/worker`'s charge-submission code already uses for contract interaction). After a
write's tx confirms, invalidate the relevant TanStack Query cache key so the UI reflects
new state once the indexer catches up (matching the dashboard's own established
invalidate-on-write pattern from its API-key/webhook-endpoint mutations).

## Balance warning

`/portal`'s cards read the connected wallet's ERC-20 balance for each subscription's plan
token via wagmi's `useReadContract` with viem's built-in `erc20Abi` (`balanceOf`) — no new
ABI needed, this is a standard ERC-20 read. Compared against the plan's `amount` (already
returned by the subscription detail's nested plan data); if balance < amount, render a
`BalanceWarning`-style inline notice (PRD §8.7 names this component; built here for the
first time, matching the same "component built when its first real consumer needs it"
practice already established for `CadencePulse`/`StatusBadge` in the dashboard phase).

## Design system

Dark-default (per PRD §8.5's explicit "Dark default," the opposite of the dashboard's light
default) — the existing six design tokens (`ink`/`paper`/`sapphire`/`signal`/`mint`/`slate`)
already support both surfaces; this phase only needs to flip which token is the default
`body` background/foreground for pages under `(portal)`, not add new tokens.

## Testing

- **Component tests** (Vitest + Testing Library, in `apps/web`): the three write-action
  buttons' state-machine transitions (mocked `useWriteContract`/
  `useWaitForTransactionReceipt`, matching the mocking pattern already established for
  `SignInButton`'s wagmi mocks in the dashboard phase), `BalanceWarning`'s render logic
  (below/above threshold), and each of the three SDK-backed hooks
  (`usePortalSubscriptions`, `usePortalSubscription`, `usePortalInvoices`) with mocked
  `Cadence` client responses.
- **No Playwright e2e in this phase** — matches the dashboard phase's own deferral
  (PRD §8.8's e2e scope centers on the full subscribe-wizard flow, which this phase
  explicitly excludes).

## Explicitly out of scope for this phase

- `/portal/subscribe/[planId]` (the subscribe wizard) — blocked on `GET /v1/prepare/subscribe`,
  which doesn't exist.
- "Revoke spending permission" action — a separate permit/allowance-revocation
  investigation, not covered here.
- Cross-merchant subscription aggregation — the portal is single-merchant by design,
  matching the PRD's own "white-labeled/embedded per merchant" framing.
- Any new backend/API work — this phase is pure frontend, consuming only endpoints that
  already exist.
- Marketing site (`/`, PRD §8.6) — a separate future phase.
- White-labeling/embedding infrastructure (custom domains, per-merchant theming beyond the
  existing design tokens) — not addressed by this phase, only the single-key-per-deployment
  mechanism that makes future white-labeling possible.
