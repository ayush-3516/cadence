# Phase 1o: Dashboard Plan-Creation Wizard — Design Spec

## Background

Phase 1n built `/v1/prepare/*`, the backend groundwork every deferred
on-chain-write frontend feature needs. This phase is the first consumer:
the dashboard's plan-creation wizard at `/dashboard/plans/new`. It is the
first on-chain-write frontend feature in the entire app — every prior
dashboard/portal phase was read-only or wallet-connect-only, deferring any
real transaction-submission UI to this point.

Per the PRD's §6.7 (0xSplits integration, read during Phase 1n): Cadence's
backend does zero 0xSplits work. Split creation is a frontend, wallet-signed
concern via `@0xsplits/splits-sdk`; `SubscriptionManager` accepts any
`payoutSplit` address without validating it against 0xSplits at all. This
phase is the first place in the codebase that actually creates a Split.

### Scope resolution: auth blocker found and fixed

`GET /v1/prepare/plan` (Phase 1n) only accepts a secret API key
(`prepare.controller.ts`'s manual `auth.keyType !== "secret"` check) — but
the dashboard authenticates via session cookie
(`apps/web/app/(dashboard)/layout.tsx`), never an API key. As built, the
dashboard cannot call this endpoint. Confirmed with the user: this phase
also widens `/v1/prepare/plan` to accept session auth, mirroring
`/v1/prepare/subscribe`'s already-broader acceptance. The now-inert
`@RequireKeyType("secret")` decorator is removed from the route (it never
did anything per Phase 1n's finding — `AuthContextService.resolve()` only
enforces it when given an `ExecutionContext`, which no `@Query()`-only route
supplies — but leaving it on the route text would misleadingly imply a
restriction that no longer holds).

### Scope resolution: no plan detail page

No `/dashboard/plans/[id]` route exists yet, and none is built in this
phase. On successful plan creation, the wizard redirects to the existing
`/dashboard/plans` list page, which already re-fetches via `usePlans()` and
will show the new plan once the indexer picks it up. A detail page is a
natural future phase.

### Scope resolution: single-recipient case skips the Split entirely

0xSplits Splits exist to divide a single stream among multiple addresses.
When the wizard's recipient list has exactly one entry (the default,
100%-to-one-address state the form starts in), deploying a Split contract
for it is pointless — the wizard uses that recipient's raw address
directly as `payoutSplit`, skipping the Split-deployment transaction
entirely. A Split is only deployed when there are 2+ recipients.

## User flow

Two screens, no wizard library, no URL-based step routing — this is a
short, linear flow managed by local `useState` in one client component.

### Screen 1 — Details form

Fields:
- **Amount** — decimal input, USDC only (`deployments/84532.json`'s `usdc`
  address; no multi-token UI exists anywhere in this codebase yet, and
  nothing outside this preset is in scope).
- **Period** — preset select: `Weekly | Monthly | Yearly`, mapped to exact
  seconds (`604800 | 2592000 | 31536000`).
- **Trial period** — preset select: `None | 7 days | 14 days | 30 days`,
  mapped to seconds (`0 | 604800 | 1209600 | 2592000`).
- **Recipients** — array of `{ address, percentage }` rows. Starts with one
  row pre-filled at 100%. An "Add recipient" button appends a new empty
  row. Client-side validation requires all percentages to sum to exactly
  100 and every address to be a well-formed `0x` address before "Continue"
  is enabled.

"Continue" advances to Screen 2 only when the form validates. No data is
submitted yet — this screen is pure local state.

### Screen 2 — Review + submit

Read-only summary of Screen 1's data (amount, period, trial, each
recipient's address + percentage). A "Create Plan" button drives a small
internal state machine through up to two sequential wallet signatures:

```
idle
  → (if 2+ recipients) depositing-split → split-confirmed
  → (if 1 recipient) [skip straight to next state, no signature]
  → preparing-plan
  → confirming-plan → pending-plan → plan-confirmed
  → done (redirect to /dashboard/plans)
error (from any state, with a retry scoped to the failed step)
```

1. **Split deployment** (only when 2+ recipients): calls
   `@0xsplits/splits-sdk`'s create-split flow with the recipient
   addresses/percentages converted to 0xSplits' basis-point format. Per the
   confirmed design, the wizard **waits for the deployment transaction's
   receipt** and reads the deployed Split's address from it — it does not
   use the SDK's CREATE2-predicted address, to avoid any risk of building
   `createPlan` calldata against an address that turns out to differ from
   what actually deployed.
2. **Prepare plan calldata**: calls `GET /v1/prepare/plan` with
   `payoutSplit` (the Split address from step 1, or the sole recipient's
   raw address if step 1 was skipped), `token` (USDC), `amount`, `period`,
   `trial`. Gets back `{ to, data, value }`.
3. **Submit createPlan**: sends the raw `to`/`data`/`value` from step 2 via
   wagmi. Since the calldata is already ABI-encoded (not a typed contract
   call), this uses wagmi's `useSendTransaction`, not `useWriteContract` —
   the one place this phase's write flow structurally differs from
   `useSubscriptionWrite.ts`'s precedent, because that hook calls a known
   ABI function with typed args, while this step has opaque pre-encoded
   calldata from the server. The state machine shape itself
   (`confirming → pending → processing/done → error`) still follows
   `useSubscriptionWrite.ts`'s established pattern exactly.
4. On confirmation, redirect to `/dashboard/plans`.

Each state renders a corresponding status line with a spinner. `error`
shows the underlying error message with a retry button scoped to just the
failed step (does not re-run an already-succeeded step, e.g. does not
redeploy a Split that already deployed successfully if only the
`createPlan` submission failed).

## New code

### `apps/web`

- `apps/web/app/(dashboard)/dashboard/plans/new/page.tsx` — the wizard
  page (client component), composing two new components below.
- `apps/web/components/plans/PlanDetailsForm.tsx` — Screen 1.
- `apps/web/components/plans/PlanReviewSubmit.tsx` — Screen 2, owns the
  submit state machine.
- `apps/web/lib/hooks/useCreatePlanSubmit.ts` — the state-machine hook
  driving the Split-deploy (conditional) → prepare → submit sequence,
  following `useSubscriptionWrite.ts`'s state-shape precedent.
- `apps/web/app/(dashboard)/dashboard/plans/page.tsx` — modified to add a
  "New Plan" link to `/dashboard/plans/new`.
- `apps/web/components/DashboardNav.tsx` — unmodified; "Plans" already
  exists as a nav entry and the new route lives under it. (No new
  top-level nav entry needed.)

### New dependency

`@0xsplits/splits-sdk`, added to `apps/web/package.json` — this phase's
only new runtime dependency anywhere in the codebase.

### `apps/api` (small, bundled fix)

- `apps/api/src/prepare/prepare.controller.ts` — the `plan` handler's
  manual auth check widens from `auth.keyType !== "secret"` to accept
  `"session"` as well (mirroring `subscribe`'s existing pattern). The
  `@RequireKeyType("secret")` decorator is removed from the route.

## Testing

- `PlanDetailsForm`: unit tests for the percentage-sums-to-100 validation,
  add-recipient behavior, and preset-to-seconds mapping — pure logic, no
  network.
- `useCreatePlanSubmit`: unit tests with mocked `@0xsplits/splits-sdk` and
  mocked wagmi hooks, covering: single-recipient path skips Split
  deployment; multi-recipient path deploys a Split first; each state
  transition; the error/retry path for each of the three steps
  independently.
- `apps/api`'s widened auth check: extend the existing
  `apps/api/test/prepare.e2e-spec.ts` with a test confirming a
  session-cookie-authenticated request to `GET /v1/prepare/plan` now
  succeeds (200), alongside the existing secret-key coverage.
- No live 0xSplits contract calls in tests — matches this codebase's
  established practice of mocking on-chain reads/writes in frontend tests
  (see `useSubscriptionWrite.ts`'s existing test precedent) and mocking
  viem clients in backend tests (Phase 1n).
- Manual smoke check: boot the dev server, walk through both screens with
  a connected test wallet against a local/test chain, confirm both wallet
  prompts appear in the right order and the final redirect lands on
  `/dashboard/plans`.

## Out of scope (explicit)

- `/dashboard/plans/[id]` detail page — the wizard redirects to the
  existing list page instead.
- Editing or deactivating existing plans — this phase only creates new
  ones.
- Multi-token support — USDC only, matching every other deployed-chain
  reference in this codebase.
- The portal's subscribe wizard — a separate future phase.
- On-chain validation that a deployed Split is genuinely a 0xSplits
  contract — `SubscriptionManager` doesn't require it and neither does
  this phase (same resolution Phase 1n reached for `payoutSplit` broadly).
