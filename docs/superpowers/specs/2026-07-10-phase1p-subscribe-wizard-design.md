# Phase 1p: Portal Subscribe Wizard — Design Spec

## Background

Phase 1o built the dashboard's plan-creation wizard, the first on-chain-write
frontend feature in the app. This phase completes the on-chain-write loop:
merchants can create plans, and this phase lets customers actually subscribe
to them, via `/portal/subscribe/[planId]`.

The backend groundwork (`GET /v1/prepare/subscribe`, Phase 1n) already
returns EIP-2612 permit typed-data plus a `subscribeWithPermit` calldata
template. This phase's genuinely novel piece: signing EIP-712 typed data
(wagmi's `useSignTypedData`) is a pure signature step — no gas, no
transaction, no wallet fee-confirmation screen. Nothing in this codebase has
done a signature-only step before; every prior write flow
(`useSubscriptionWrite.ts`, Phase 1o's `useCreatePlanSubmit.ts`) goes
straight to a transaction.

### Scope resolution: plan preview before wallet connect

The portal has no layout-level auth gate — each existing page
(`portal/page.tsx`, `portal/invoices/page.tsx`) independently checks
`useAccount().isConnected` and renders `ConnectKitButton` inline if not
connected. Confirmed with the user: this phase does NOT follow that
gate-the-whole-page pattern. Instead, plan details (name, price, period)
render immediately via `usePortalPlan(planId)` — an existing hook already
built in this codebase but not yet wired to any page — since fetching a
plan by ID needs only `planId`, not a connected wallet's address. The
wallet-connect prompt appears only when the visitor clicks "Subscribe",
right before the step that actually needs an address
(`GET /v1/prepare/subscribe`'s `owner` param). This is a deliberate,
scoped exception to the existing per-page pattern, not a new shared
component — a shared `PortalConnectGate` was considered and explicitly
deferred as unnecessary scope expansion for this phase.

### Scope resolution: no new detail route

Same resolution as Phase 1o: on success, the wizard redirects to the
existing `/portal` subscriptions list (`usePortalSubscriptions`), which
will show the new subscription once the indexer picks it up. No
`/portal/subscriptions/[id]`-adjacent new route is built for this flow
(a subscription detail route already exists from an earlier phase and is
unaffected).

## User flow

Single screen — unlike Phase 1o's two-screen wizard, there's no multi-field
form to fill out; the plan's terms are fixed by the merchant, and the
customer's only decision is whether to subscribe.

1. Page loads, calls `usePortalPlan(planId)` immediately (no wallet
   required). Renders the plan's name, price, and billing period. If the
   plan doesn't exist or fails to load, shows an error state (matching
   `usePortalPlan`'s existing `useQuery` error surface).
2. A "Subscribe" button is shown. If the wallet isn't connected yet,
   clicking it (or the button's own inline state) shows `ConnectKitButton`
   — matching the existing portal pattern, just deferred to this later
   point rather than gating the whole page.
3. Once connected, clicking "Subscribe" drives `useSubscribeSubmit` through:
   ```
   idle → preparing → signing → submitting → confirming → done
   error (from any state, retry restarts from preparing)
   ```
   - **`preparing`**: calls `GET /v1/prepare/subscribe?planId=<planId>&owner=<address>`
     via `apiFetch`. Response: `{ permit: { domain, types, message }, subscribe: { to, fn, planId, deadline } }`.
   - **`signing`**: wagmi's `useSignTypedData`, signing exactly
     `{ domain: permit.domain, types: permit.types, primaryType: "Permit", message: permit.message }`.
     This is a pure signature request — the wallet shows a "Sign" prompt,
     not a transaction/gas confirmation. Produces a raw hex signature.
   - **`submitting`**: the signature is split into `{ v, r, s }` via viem's
     `parseSignature` (confirmed real and exported in the installed viem
     version — returns `{ r, s, v, yParity }`, `v` as a `bigint` needing a
     `Number()` cast for the ABI's `uint8` param). Full calldata is
     assembled via `encodeFunctionData` against `subscriptionManagerAbi`'s
     `subscribeWithPermit(planId, value, deadline, v, r, s)` — exact
     parameter order confirmed against the ABI. Submitted via wagmi's
     `useSendTransaction`, mirroring `useCreatePlanSubmit.ts`'s
     transaction-submission tail exactly (same status-effect shape).
   - **`confirming → done`**: `useWaitForTransactionReceipt`, same pattern
     as every prior write hook in this codebase.
4. On `done`, redirect to `/portal`.
5. On `error` at any step, show the error message and a "Retry" button.
   Retry always restarts from `preparing` (not from whatever step failed)
   — the permit's 15-minute deadline (set server-side, Phase 1n) means a
   stale signature from a much-earlier attempt could be expired by the
   time a later transaction-submission retry runs; re-preparing gets a
   fresh deadline and nonce, which is simpler and safer than trying to
   detect and reuse a still-valid prior signature.

## New code

- `apps/web/app/(portal)/portal/subscribe/[planId]/page.tsx` — the wizard
  page. Reads `planId` from the route params, renders `usePortalPlan`'s
  data, composes the subscribe button and `useSubscribeSubmit`'s status
  UI inline (single component, not split into two files the way Phase
  1o's two-screen flow was — no natural second "screen" exists here).
- `apps/web/lib/hooks/useSubscribeSubmit.ts` — the state-machine hook
  described above.
- No changes to `usePortalPlan.ts` (already correct, already exists) or
  any backend code — `GET /v1/prepare/subscribe` already accepts
  publishable-key auth (confirmed unchanged from Phase 1n) and needs no
  modification, unlike Phase 1o's `/v1/prepare/plan` widening.
- A "Subscribe" link/entry point from wherever a customer would discover
  a plan to subscribe to: out of scope for this phase (there is currently
  no plan-browsing/discovery page anywhere in the portal — a merchant
  would share a direct `/portal/subscribe/[planId]` link, e.g. via their
  own external site, matching how Stripe-style hosted checkout links
  work). Building plan discovery is a separate future phase if needed.

## Testing

- `useSubscribeSubmit`: unit tests with mocked `wagmi` (`useSignTypedData`,
  `useSendTransaction`, `useWaitForTransactionReceipt`) and mocked
  `apiFetch`, following `useCreatePlanSubmit.test.tsx`'s established
  mocking pattern (Phase 1o). Covers: the full happy path through all
  states; the `parseSignature`→`v`/`r`/`s` splitting producing correct
  calldata (assert via `decodeFunctionData` round-trip, matching this
  codebase's backend-test convention from Phase 1n); retry-from-preparing
  behavior after each step's failure.
- The wizard page: matches Phase 1o's practice of not unit-testing static
  page composition, EXCEPT for the wallet-connect-timing logic (plan
  details render before connect, subscribe button gates on connection) —
  this is real conditional logic, not static composition, so it gets a
  component test with a mocked `usePortalPlan` and mocked `useAccount`.
- No live wallet signature or live RPC calls in tests — matches this
  codebase's established practice throughout every prior on-chain-write
  phase.

## Out of scope (explicit)

- Plan discovery/browsing UI — customers reach this page via a direct
  link only.
- A subscription success/detail page — redirects to the existing
  `/portal` list instead.
- Any backend changes — `/v1/prepare/subscribe` already works as-is.
- A shared `PortalConnectGate` component — the connect-only-when-needed
  pattern is implemented inline in this phase's one new page, following
  (not replacing) the existing per-page inline pattern.
