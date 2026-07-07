# Phase 1h: Invoices — Design Spec

## Goal

On every successful on-chain charge, generate a merchant-branded invoice: allocate a sequential
per-merchant invoice number, compute the platform fee split, render a PDF, upload it to
S3-compatible object storage, persist an `invoice` row, and fire an `invoice.created` webhook
event through the existing Phase 1g webhook infrastructure. Expose merchant- and customer-facing
read access via two new `apps/api` endpoints.

This is Phase 1 scope per the PRD's own milestone list (§11) that was implemented out of order —
dunning (1f) and webhooks (1g) shipped first. Invoices depend only on the already-built
charge-success code path (`apps/worker/src/queues.ts`'s `processChargeJob`) and the already-built
webhook-emission infrastructure (`emitEvent`, `webhook_delivery`), so it has no blocking
dependencies on anything not yet built.

## Background: why the trigger point is not literally "on `Charged`"

The PRD says (§7.9) "On `Charged` (success), enqueue invoice generation." Read literally, `Charged`
is an on-chain event, and the natural place to react to it is the indexer's own
`ponder.on("SubscriptionManager:Charged", ...)` handler in `apps/indexer/src/SubscriptionManager.ts`
— which is exactly where the authoritative `amount`/`platformFee`/`net`/`txHash` values are already
computed and written into `onchain_charge` today.

However, Phase 1g established a different, already-shipped pattern: `subscription.renewed` is
emitted directly from `apps/worker/src/queues.ts`'s `processChargeJob`, immediately after the
relayer submits the charge transaction — **before** the indexer has processed the corresponding
`Charged` log and written the `onchain_charge` row. The indexer itself (`apps/indexer`) has zero
webhook/queue wiring and no BullMQ/Redis dependency; introducing one now would be a significant,
unplanned architectural change and would create two independent "sources of truth" for webhook
emission (worker-side for `subscription.renewed`, indexer-side for `invoice.created`).

**Resolved:** invoice generation hooks into the same site as `subscription.renewed` —
`processChargeJob`, right after the charge tx is submitted and the merchant/plan lookup already
performed for the webhook emission. This keeps a single call site responsible for all
charge-success side effects, consistent with the precedent Phase 1g established.

**Consequence:** because `processChargeJob` runs before the indexer has processed the event, it
cannot join against `onchain_charge` (that row doesn't exist yet) to get `platformFee`/`net`. It
must independently compute these values — see the Fee Computation section below. The invoice's
`tx_hash` column is populated directly from the submitted transaction's hash; there is no FK
relationship to `onchain_charge` (see Schema section).

## Fee computation

`onchain_plan.amount` (already fetched in `processChargeJob` for the `subscription.renewed`
emission) gives the gross charge amount. The platform fee rate is NOT stored anywhere in
Postgres — it lives on-chain in `FeeRegistry.getFeeBps(merchant)` (a `view` function, no
transaction, `MAX_FEE_BPS = 1000` i.e. 10% cap) and is only otherwise observable via the indexer's
`onchain_charge.platformFee`/`.net` columns, populated later from the real `Charged` event args.

**Resolved:** `processChargeJob` makes one extra `viem` `readContract` call to
`FeeRegistry.getFeeBps(merchant.ownerAddress)` right after the existing plan/merchant lookup, then
computes locally:

```
feeBps = await feeRegistry.read.getFeeBps([merchantAddress])  // uint16, e.g. 250 = 2.5%
platformFee = (amount * BigInt(feeBps)) / 10_000n
net = amount - platformFee
```

This is a read-only RPC call (no gas, no relayer nonce involvement), safe to make on every charge.
The `FeeRegistry` contract address is already present in `deployments/{chainId}.json`
(`feeRegistry` key, confirmed populated from Phase 0's deployment). `WorkerConfig` gains a new
`feeRegistryAddress: \`0x${string}\`` field, sourced from the deployment JSON exactly like
`subscriptionManagerAddress` is today. `packages/shared` gains a new `feeRegistryAbi` export
(mirroring the existing `subscriptionManagerAbi` pattern) — only the `getFeeBps` function needs to
be in the ABI.

This computed value may differ from the indexer's eventual `onchain_charge.platformFee`/`.net`
only in the theoretical case of a fee-rate change occurring in the same block window between the
worker's read and the transaction's actual execution — an accepted, documented edge case, not
something this phase needs to reconcile (the invoice reflects the fee rate effective at
generation time; a rate change mid-flight is out of scope, consistent with the PRD's general
"trust the chain event" philosophy applied here as "trust the rate read at generation time").

## Schema (`packages/db/src/schema.ts`)

```typescript
export const invoice = pgTable(
  "invoice",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    merchantId: uuid("merchant_id").notNull().references(() => merchant.id),
    number: text("number").notNull(),               // "CAD-000123"
    pdfUrl: text("pdf_url"),                         // nullable until upload succeeds
    txHash: text("tx_hash").notNull(),                // NO FK to onchain_charge — see Background
    amount: numeric("amount", { precision: 78, scale: 0 }).notNull(),
    platformFee: numeric("platform_fee", { precision: 78, scale: 0 }).notNull(),
    net: numeric("net", { precision: 78, scale: 0 }).notNull(),
    onchainSubId: numeric("onchain_sub_id", { precision: 78, scale: 0 }).notNull(),
    onchainPlanId: numeric("onchain_plan_id", { precision: 78, scale: 0 }).notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("invoice_merchant_id_number_unique").on(table.merchantId, table.number),
    index("invoice_merchant_id_created_at_idx").on(table.merchantId, table.createdAt),
    index("invoice_onchain_sub_id_idx").on(table.onchainSubId),
  ],
);
```

`amount`/`platformFee`/`net`/`onchainSubId`/`onchainPlanId` go beyond the PRD's minimal table
definition (§7.2 lists only `id, charge_id, merchant_id, number, pdf_url, tx_hash, issued_at`).
This is a deliberate, justified addition: the PDF needs these values to render, and the API's
detail response needs to expose them (per the PRD's own frontend spec listing invoice amount in
`InvoiceRow`/`/portal/invoices`) — storing them denormalized on `invoice` avoids a fragile,
possibly-never-consistent join back through `onchain_charge` (which may lag indefinitely if the
indexer falls behind, or in the theoretical case of an indexer resync).

**`merchant` table addition:** one new column,
`invoiceSequence: integer("invoice_sequence").notNull().default(0)`.

## Invoice number allocation

Allocated atomically in the same transaction as the invoice insert, avoiding a race between
concurrent charges for the same merchant:

```sql
UPDATE merchant SET invoice_sequence = invoice_sequence + 1
WHERE id = :merchantId
RETURNING invoice_sequence;
```

The returned integer is formatted as `CAD-{n.toString().padStart(6, "0")}` (e.g. `CAD-000123`).

## PDF generation

Uses `pdfkit` (plain Node, no React/JSX pipeline) — `apps/worker` has no React anywhere today, and
the PRD explicitly allows `pdfkit` as an alternative to `@react-pdf/renderer`. The PDF includes:
merchant name, customer (subscriber) address, plan details, amount, platform fee, net, billing
period, transaction hash, and a block-explorer link (constructed from `chainId` + `txHash`,
matching the existing pattern used elsewhere for tx links). Rendered to an in-memory buffer (no
temp files on disk).

## Object storage

Uses `@aws-sdk/client-s3` against generic `S3_ENDPOINT`/`S3_BUCKET`/`S3_ACCESS_KEY_ID`/
`S3_SECRET_ACCESS_KEY` env vars (already named in the PRD's env template, §4.5) — this client
works unmodified against both AWS S3 and Cloudflare R2 (R2 exposes an S3-compatible API), so no
vendor-specific SDK or code branching is needed. The uploaded object key is
`invoices/{merchantId}/{invoiceId}.pdf`; the resulting `pdf_url` is either a public bucket URL or
a pre-signed URL depending on bucket configuration (left as a deployment-time choice, not encoded
in application logic — the worker just uses whatever URL the S3 client constructs/returns for the
configured endpoint).

## Failure isolation

Invoice generation (fee-rate RPC read, number allocation, PDF render, S3 upload, DB insert,
`invoice.created` emission) is wrapped in its own try/catch inside `processChargeJob`, entirely
separate from the charge-submission and `subscription.renewed`-emission code above it. A failure
at any step is logged (`console.error`) but does not throw, does not block `subscription.renewed`
from firing, and does not affect the charge-lock's `finally`-block release. The on-chain charge is
already final and successful regardless of whether an invoice PDF could be produced — invoice
generation is a best-effort side effect, not a component of charge correctness. This is a
deliberate choice, not an oversight: letting invoice failures propagate would risk BullMQ retrying
the entire job (including a second `submitCharge` call, layered on top of `processChargeJob`'s
existing idempotency guards, adding real risk for a purely cosmetic failure mode).

If invoice generation fails, no `invoice` row is created and no `invoice.created` event fires —
there is no partial/pending invoice state in this phase. A future phase could add a retry/backfill
mechanism for failed invoice generation; out of scope here, consistent with `webhook_delivery`'s
own replay mechanism being a separate, later addition (Phase 1g's Task 6) rather than something
Phase 1g's Task 3/4 needed to solve immediately.

## API (`apps/api/src/invoices/`)

New module: `invoices.dto.ts` (none needed — these are read-only GET endpoints, no body DTOs),
`invoices.service.ts`, `invoices.controller.ts`, `invoices.module.ts`.

`InvoicesService.listForMerchant(merchantId, { subscriberAddress?, limit, startingAfter })` —
cursor-paginated using the compound `(createdAt, id)` keyset pattern established in Phase 1g's
`WebhookEndpointsService`/`WebhookDeliveriesService` (a correlated SQL subquery comparing the
cursor row's `createdAt` entirely inside Postgres, never round-tripped through a JS `Date` — see
Phase 1g's `progress.md` for the full account of why the naive `gt(id)+asc(id)` version is broken
over a random UUID primary key, and why a JS-Date round-trip for the compound cursor is *also*
broken due to Postgres `timestamptz` microsecond precision vs. JS `Date` millisecond precision).
When `subscriberAddress` is supplied, join through `onchain_subscription.subscriberAddress` via
`invoice.onchainSubId`.

`InvoicesService.getById(merchantId, id)` — single invoice lookup scoped to the merchant.

### `GET /v1/invoices`

- Secret key: unscoped list (all merchant invoices), optional `subscriber` query param filters to
  one customer.
- Publishable key: **requires** the `subscriber` query param (400 `invalid_request_error` if
  absent) — results scoped to that address's own invoices only. This mirrors the already-built
  `GET /v1/customers/:address/subscriptions` pattern: a publishable key resolves only to a
  `merchantId` (confirmed via `AuthContextService` — never a customer address), so "pub-scoped to
  one customer" can only work if the caller supplies the customer's address as a parameter; the
  pub key just proves the caller is allowed to ask about *some* customer of this merchant, and the
  address itself scopes the query. This deliberately diverges from the PRD's literal `sec/pub`
  annotation (which doesn't distinguish scoped-vs-unscoped pub access) to avoid a real data
  exposure risk: an unscoped pub-key list would let anyone holding a merchant's publishable key
  (a credential meant to be safe to embed client-side, per Phase 1b's key-type model) enumerate
  every customer's invoices.

### `GET /v1/invoices/:id`

- Secret key: any invoice belonging to the merchant.
- Publishable key: any invoice belonging to the merchant — no additional customer-scoping. The
  invoice `id` is an unguessable UUID (not enumerable), and this matches the existing trust model
  of `GET /v1/subscriptions/:onchainId` (also pub-accessible, also not customer-scoped beyond
  merchant ownership). A customer's portal already learns which invoice ids are theirs from the
  scoped list call above; detail-by-id doesn't need (and per `AuthContextService`, cannot
  cryptographically enforce) a second, redundant customer check.

Response shape: `{ id, number, pdf_url, tx_hash, amount, platform_fee, net, onchain_sub_id,
onchain_plan_id, issued_at }`.

## Testing

- **Unit:** fee-bps computation (edge cases: 0 bps, `MAX_FEE_BPS`, rounding behavior of integer
  division); PDF rendering produces a non-empty buffer containing expected text fields (merchant
  name, amount, tx hash).
- **Integration (`packages/db`):** the atomic invoice-number counter under concurrent inserts for
  the same merchant (no duplicate numbers, no gaps skipped incorrectly beyond expected
  concurrent-increment behavior).
- **E2E (`apps/worker`, extending the existing anvil-based charge-flow test):** subscribe via a
  test wallet → run scheduler → assert `Charged` submitted → assert an `invoice` row exists with
  correct amount/fee/net (computed independently in the test from the known plan amount and a
  known `FeeRegistry` bps value) → assert a real PDF was uploaded (or, if a real S3 bucket isn't
  available in CI, assert the upload call was attempted with correct parameters against a local
  S3-compatible test double — decided at plan-writing time based on what test infrastructure is
  practical).
- **API e2e (`apps/api`):** both auth modes for both routes (secret unscoped, pub requiring
  `subscriber`, pub detail-by-id, 404 for cross-merchant access), plus a multi-page pagination
  test following Phase 1g's precedent (seed 3+ invoices, verify no skip/duplicate across pages
  using the same `Set`-based check pattern).

## Explicitly out of scope for this phase

- Retry/backfill for failed invoice generation (deferred; the failure-isolation design above makes
  this a clean future addition, not a blocking gap).
- ERC-721 receipt NFT minting (PRD explicitly marks this "Optional Phase 3").
- Reconciling worker-computed fee/net against the indexer's eventual `onchain_charge` values if
  they ever diverge (accepted edge case, documented above).
- Any frontend/dashboard work (`InvoiceRow`, `/portal/invoices`, `useInvoices`) — backend only,
  matching every prior phase's scope boundary in this project.
