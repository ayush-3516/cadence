# Phase 1q: Payouts Vertical — Design Spec

## Background

The PRD is explicit and unambiguous that a "payout" is money moving from a
0xSplits Split contract to individual recipients — a distinct, downstream,
permissionless event, separate from the `SubscriptionManager → payoutSplit`
transfer that already happens on every successful charge (already indexed
into `onchain_charge`). Confirmed by direct PRD quotes gathered during
brainstorming:

- Glossary: `**Payout / Distribution** | Funds leaving a Split to a recipient.`
- Flow D: "Indexer records distributions ─▶ webhook `payout.distributed` ─▶ dashboard Payouts view."
- §5.1: `**Payout** | 0xSplits events | splitAddress, recipient, token, amount, txHash, timestamp`
- §6.7: "The indexer also reads 0xSplits distribution/withdrawal events ... to populate the Payouts view."
- §7.4: `GET /v1/payouts | sec | list distributions per split/recipient`

`onchain_charge` stops at "net sent to the Split" and cannot see
recipient-level distribution — this genuinely requires indexing 0xSplits'
own on-chain events, not a smaller derivation from existing data. The
`onchain_payout` table is already specified in `apps/indexer/ponder.schema.ts`
(added in an earlier phase, unused by any handler) — no schema change
needed, only a handler and its contract config.

### Scope resolution: Pull-split-only, per-recipient accuracy

0xSplits' V2 architecture has two split types. `SplitDistributed` (emitted
by the Split contract itself, for both types) carries only an **aggregate**
amount — reconstructing per-recipient shares would require off-chain math
against the Split's stored percentages. For **Pull**-type splits
specifically, a separate, genuinely per-recipient on-chain signal exists:
the shared `SplitsWarehouse` contract's ERC6909 `Transfer` event, emitted
once per recipient when `PullSplit._distribute()` calls
`SplitsWarehouse.batchTransfer()`.

Confirmed during brainstorming: Phase 1o's wizard (`useCreatePlanSubmit.ts`)
calls `SplitV2Client.createSplit()` without specifying `splitType` or
`version`, so it uses the SDK's actual defaults —
`SplitV2Type.Pull` and version `"splitV2o2"` — meaning every Split this
codebase's own wizard ever creates is a Pull split targeting one specific
factory address. This phase indexes **only** that path:

- Factory: `PullSplitFactoryV2.2` at `0x6B9118074aB15142d7524E8c4ea8f62A3Bdb98f1`
  (Base Sepolia, confirmed against the installed `@0xsplits/splits-sdk@6.5.0`'s
  own `PULL_SPLIT_V2o2_FACTORY_ADDRESS` constant and `DEFAULT_V2_VERSION`).
- Warehouse: `SplitsWarehouse` at `0x8fb66F38cF86A3d5e8768f8F1754A24A6c661Fb8`
  (fixed address, shared across all Splits on the chain).

Push-type splits and other factory versions are out of scope — nothing in
this codebase ever creates one, so there is nothing to index for them.

### Scope resolution: single-recipient plans have no payout to show

Per Phase 1o's own resolution, a plan with exactly one recipient never
deploys a Split at all — the recipient's raw wallet address is used
directly as `payoutSplit`, and funds land there via the charge's plain
ERC-20 transfer with no further on-chain step. Such plans correctly show
zero rows in the Payouts view; this is expected, not a gap.

### Scope resolution: "payout" means the distribution credit, not the later withdrawal

A Pull split's flow has two separate moments: (1) `distribute()` credits
each recipient's withdrawable balance in the Warehouse (the `Transfer`
event), and (2) the recipient (or a keeper) later calls `withdraw()` to
actually move tokens into their wallet (a separate `Withdraw` event, which
may happen much later or never). Confirmed with the user: Cadence treats
moment (1) — the distribution credit — as the payout. This matches the
PRD's "funds leaving a Split to a recipient" framing at the point Cadence's
own charge → distribute flow has done its job; withdrawal timing is
entirely the recipient's choice and shouldn't gate whether a merchant sees
a payout as having happened. The `Withdraw` event is not indexed in this
phase.

**Discriminator for a genuine distribution credit** (vs. any other
Warehouse `Transfer`): `SplitsWarehouse.batchTransfer()` emits
`Transfer({caller: msg.sender, sender: msg.sender, receiver, id, amount})`
where `msg.sender` is always the calling Split contract itself (confirmed
by reading `SplitsWarehouse.sol`'s `batchTransfer` implementation
directly). So a `Transfer` event counts as a payout exactly when its
`sender` matches a Split address the indexer already knows about (i.e., one
discovered via the `PullSplitFactoryV2.2`'s `SplitCreated` event) — this
is a clean, reliable filter with no ambiguity against deposits or other
Warehouse activity.

## Indexer (`apps/indexer`)

Two additions to `ponder.config.ts`:

1. **`PullSplitFactoryV2o2`** — factory-pattern config: watch the
   factory's `SplitCreated` event, dynamically indexing every Split
   address it deploys (the standard Ponder pattern for dynamically-created
   contracts). No `onchain_split` table is needed to persist these
   addresses separately — Ponder's factory pattern tracks the discovered
   address set internally for event-watching purposes; the indexer's
   `Transfer`-event handler filters by checking `sender` against the same
   dynamically-discovered address set.
2. **`SplitsWarehouse`** — fixed address, watching its ERC6909 `Transfer`
   event.

New handler file `apps/indexer/src/SplitsWarehouse.ts`, following the
existing `SubscriptionManager.ts` handler pattern (`ponder.on(...)`,
`context.db.insert(onchainPayout).values({...})`). Inserts one
`onchain_payout` row per qualifying `Transfer` event:
- `id`: `` `${txHash}:${logIndex}` `` (matches `onchain_charge`'s existing
  ID convention).
- `splitAddress`: the event's `sender`.
- `recipient`: the event's `receiver`.
- `token`: decoded from the event's `id` (`uint256(uint160(tokenAddress))`,
  per ERC6909 — the Warehouse's `toUint256`/token-ID convention confirmed
  during research).
- `amount`: the event's `amount`.
- `txHash`, `blockNumber`, `chainId`, `distributedAt`: from the event/block
  context, matching `onchain_charge`'s existing field-population pattern.
- `usdValue`: left `null` in this phase — no USD-conversion pipeline exists
  for payouts yet (the existing `usdValue` on `onchain_charge` is populated
  by a separate mechanism not in scope here; adding USD conversion for
  payouts is a reasonable future follow-up, not blocking this phase).

## Backend (`apps/api`)

New `PayoutsModule`/`PayoutsController`/`PayoutsService`, following the
existing `AnalyticsModule`'s structure (`analytics.controller.ts`'s
`resolveMerchantId` pattern — session or secret key, matching `GET
/v1/payouts`'s `sec` designation in the PRD's endpoint table).

`GET /v1/payouts`: returns payouts scoped to the calling merchant's own
plans — joins `onchain_payout.splitAddress` against
`onchain_plan.payoutSplit` filtered to `onchain_plan.merchantAddress =
<caller>`, since the indexer itself doesn't scope by merchant (it indexes
every Pull split created via that one factory, not just Cadence's own
merchants' splits — filtering to "this merchant's plans" happens at the
API layer, not the indexer). Paginated using this codebase's established
page-envelope convention (`limit`/`starting_after`, matching
`plans.controller.ts`'s `list` endpoint).

Response fields per row: `split_address`, `recipient`, `token`, `amount`,
`usd_value`, `tx_hash`, `distributed_at` — matching the PRD's §5.1 entity
definition and `onchain_payout`'s actual columns.

## Frontend (`apps/web`)

`/dashboard/payouts` — a new read-only page (no on-chain-write; nothing to
sign, unlike every phase since 1o). Follows the existing
`usePlans`/`apps/web/app/(dashboard)/dashboard/plans/page.tsx` hook+table
pattern: a new `usePayouts` hook wrapping `apiFetch("/v1/payouts")`, a
table showing recipient, token, amount, distributed-at, and a link to the
transaction (matching `SubscriptionCard`'s existing external-link
convention for tx hashes, if one exists — otherwise a plain block-explorer
URL construction). Added to `DashboardNav`'s `NAV_ITEMS` array as a new
top-level entry (unlike Phase 1o's wizard, which lived under the existing
"Plans" entry — Payouts has no existing parent page to nest under).

## Testing

- Indexer handler: unit test asserting a `Transfer` event with `sender`
  matching a known-discovered Split address produces a correctly-shaped
  `onchain_payout` insert; a `Transfer` event with an unrelated `sender`
  is ignored. Matches this codebase's existing indexer test conventions
  (mocked Ponder context, direct handler invocation) if such a precedent
  exists in `apps/indexer` already — otherwise, follows `apps/worker`'s
  established mocked-DB-client unit test pattern as the closest analog.
- Backend: e2e test (testcontainers Postgres, real booted app, matching
  every prior `apps/api` phase's convention) covering: a merchant sees
  only payouts for their own plans' splits, not another merchant's;
  pagination behaves per this codebase's established envelope tests
  (see `plans.e2e-spec.ts`'s pagination test as the precedent).
- Frontend: `usePayouts` hook test (mocked `apiFetch`, matching
  `usePlans.ts`'s existing test precedent if one exists) plus the page's
  loading/empty/error-state rendering, matching
  `apps/web/app/(dashboard)/dashboard/plans/page.tsx`'s established
  (untested, static-composition) pattern — no on-chain-write logic exists
  on this page, so no wagmi mocking is needed, unlike every prior
  on-chain-write phase.

## Out of scope (explicit)

- Push-type splits — nothing in this codebase ever creates one.
- Other 0xSplits factory versions (`V2.1`, base `PullSplitFactory`) —
  the SDK's actual default targets only `V2.2`.
- The `Withdraw` event / actual wallet-arrival moment — a payout is
  defined as the distribution credit, not the later withdrawal.
- USD-value conversion for payout rows — left `null`, a future follow-up.
- `payout.distributed` webhook firing — the PRD mentions this (Flow D),
  but it's a separate concern from the read-side vertical this phase
  builds; a natural follow-up once payouts are indexed and readable.
- Any write/action UI on the payouts page (e.g. a "trigger distribute"
  button) — this phase is read-only, matching how the underlying
  `distribute()` call is itself permissionless and not something Cadence
  needs to initiate on the merchant's behalf.
