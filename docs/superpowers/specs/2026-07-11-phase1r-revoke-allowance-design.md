# Phase 1r: Allowance Fix + Revoke Spending Permission — Design Spec

## Background

An earlier PRD gap survey found the revoke-spending-permission flow entirely
absent from the codebase — PRD-mandated even in Phase 1, but no component,
hook, or action exists anywhere for it. Researching what "revoke" actually
means mechanically surfaced a second, more consequential finding: the
subscribe flow's current EIP-2612 permit only grants a **single period's**
allowance, but `SubscriptionManager._charge()` draws down a **standing**
ERC-20 allowance every billing period with no re-permit mechanism. The
contract's own test suite (`test/unit/SubscriptionManager.charge.t.sol`)
confirms this: every test exercising repeat charges approves
`type(uint256).max` up front, and a dedicated test
(`test_charge_insufficientAllowance_setsPastDue`) confirms that approving
only one period's amount causes the **second** charge to fail into
`past_due` — this is tested, expected contract behavior, not a bug in the
contract. The bug is one layer up: `GET /v1/prepare/subscribe`
(`apps/api/src/prepare/prepare.service.ts:92`) sets the permit's `value` to
exactly `plan.amount`, meaning every subscription created via the portal's
existing wizard (Phase 1p) self-terminates into `past_due` after its first
charge. Recurring billing does not currently work end-to-end.

Confirmed with the user: this phase fixes both together, since they are two
sides of the same allowance question — shipping a revoke feature for a
subscribe flow that doesn't actually recur yet would be incomplete, and
understanding the real allowance model was necessary to design revoke
correctly regardless.

### Scope resolution: allowance sizing

The permit's `value` changes from `plan.amount` (one period) to
`plan.amount * 12` (twelve periods) — a fixed, auditable middle ground
between the current broken one-period grant and the contract test suite's
unlimited (`type(uint256).max`) approach. Twelve periods gives a full
year of unattended auto-renewal (for monthly plans; proportionally more or
less for other periods) while bounding a subscriber's real financial
exposure to a concrete, explainable number ("you're approving up to 12
billing periods"), rather than an unlimited standing allowance.

### Scope resolution: what "revoke" means mechanically

Confirmed via direct contract research: revoking is not a
`SubscriptionManager` action at all — there is no on-chain
cancel-and-revoke function, and `SubscriptionManager`'s subscriber-facing
functions are exactly `subscribe`, `subscribeWithPermit`, `cancel`,
`pauseSubscription`, `resumeSubscription`. "Revoke spending permission" is
a plain ERC-20 `approve(spender, 0)` call the subscriber's wallet makes
**directly against the token contract**, zeroing out whatever standing
allowance `SubscriptionManager` currently holds. This is the same
mechanical action tools like revoke.cash perform — Cadence's contribution
is surfacing it in-portal with the right spender/token pre-filled, not a
new on-chain primitive.

### Scope resolution: revoke does not couple to cancel

Confirmed with the user: revoking only zeroes the allowance. It does not
also call `cancel()`. The subscription's status transitions to `past_due`
naturally via the existing, already-tested `ChargeFailed(subId, reason=2)`
path (`SubscriptionManager.sol:157-184`) the next time a charge is
attempted against the now-empty allowance — this reuses infrastructure
that already exists (the indexer already handles `ChargeFailed` and writes
`status: "past_due"`) rather than building new coupled logic. A subscriber
who wants to also formally cancel still uses the existing "Cancel" action
in `SubscriptionActions.tsx` separately, exactly as they could before this
phase.

## Part 1: Allowance sizing fix (`apps/api`)

`apps/api/src/prepare/prepare.service.ts`'s `buildSubscribePermit` changes
one line: `message.value` from `plan.amount` to a new
`PERMIT_PERIODS_ALLOWANCE = 12` multiplied against `plan.amount`
(`BigInt(plan.amount) * BigInt(PERMIT_PERIODS_ALLOWANCE)`, formatted back
to the string the response shape already expects). No other part of the
prepare-subscribe response shape changes — `permit.domain`/`types` are
unaffected; only `permit.message.value` changes.

## Part 2: `useRevokeAllowance` hook (`apps/web`)

New hook `apps/web/lib/hooks/useRevokeAllowance.ts`, following
`useSubscriptionWrite.ts`'s established state-machine shape exactly
(`idle → confirming → pending → processing → done → error`, same
`useWriteContract`/`useWaitForTransactionReceipt` wiring) — but targeting
the **token contract's address** (passed in as an argument, since it
varies per plan, unlike `SubscriptionManager`'s fixed address) rather than
`SUBSCRIPTION_MANAGER_ADDRESS`. Calls
`approve(SUBSCRIPTION_MANAGER_ADDRESS, 0n)`.

Requires a new `approve` entry in `packages/shared/abis/Erc20Permit.ts` —
the standard ERC-20 `approve(address spender, uint256 amount) returns
(bool)` function, distinct from the EIP-2612-specific `permit`/`nonces`
entries already there (that file's existing header comment explicitly
notes it was kept minimal for `/v1/prepare/subscribe`'s signing needs;
this phase's addition is a deliberate, documented expansion of its scope
to also cover the standard-ERC-20 revoke path).

## Part 3: UI (`apps/web`)

A new "Revoke spending permission" button added to
`apps/web/components/SubscriptionActions.tsx`, alongside the existing
cancel/pause/resume actions, on the existing `/portal/subscriptions/[id]`
page — no new route. Needs the plan's `token` address, fetched the same
way `SubscriptionCard.tsx` already does for its `useTokenBalance` hook
(the plan is already fetched for other display purposes on this page;
this phase reuses that data, not a new fetch). Same status-message/
disabled-button UI pattern as the existing three actions
(`STATUS_MESSAGE` record keyed by `WriteStatus`).

Confirmation copy makes clear this is a standing-allowance action, not a
subscription-cancellation action — e.g. "This stops future automatic
charges by revoking your token spending approval. Your subscription
itself is not canceled." — since the two are deliberately decoupled per
the resolution above, and a subscriber could otherwise reasonably assume
"revoke" means "cancel."

## Testing

- `apps/api`: extend the existing `prepare.e2e-spec.ts`'s
  `/v1/prepare/subscribe` test to assert `permit.message.value` equals
  `plan.amount * 12`, not `plan.amount`.
- `apps/web`: `useRevokeAllowance` gets its own unit test (mocked
  `useWriteContract`/`useWaitForTransactionReceipt`, following
  `useCreatePlanSubmit.test.tsx`'s established wagmi-mocking pattern from
  an earlier phase). No prior hook in this codebase has a materially
  identical shape to reuse — `useSubscriptionWrite` targets a fixed
  contract address with a fixed ABI; this hook takes a variable token
  address and calls a different function (`approve`, zero-value) — so a
  dedicated test is warranted, covering: `write` calls `approve` with the
  correct spender/zero-amount args; the status machine transitions
  through `confirming → pending → done` on success and to `error` on a
  rejected/failed transaction.
- `apps/web`: extend `SubscriptionActions.test.tsx` with cases for the new
  button (renders, calls the hook's write function with the right
  spender/token, shows the correct confirmation copy).
- No live wallet/RPC calls in tests — matches every prior on-chain-write
  phase's established practice.

## Out of scope (explicit)

- Any change to `SubscriptionManager.sol` itself — this phase is entirely
  an off-chain (API response shape) and frontend (new hook/UI) change; no
  contract redeployment.
- Coupling revoke to cancel — deliberately decoupled, per the confirmed
  resolution above.
- A generic "revoke any token approval" tool — scoped specifically to the
  one allowance a portal subscriber would plausibly want to revoke
  (their own plan's token, `SubscriptionManager` as spender), not a
  revoke.cash-style general wallet tool.
- Increasing the 12-period allowance dynamically or letting merchants
  configure it per-plan — a fixed constant for this phase; a
  merchant-configurable value is a reasonable future follow-up, not part
  of this phase's scope.
- Detecting or surfacing "your allowance is about to run out" warnings to
  subscribers before the 12-period window lapses — a future
  notification/UX concern, not part of this phase.
