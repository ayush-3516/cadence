# Phase 1n: `/v1/prepare/*` Endpoints — Design Spec

## Background

Every deferred on-chain-write feature (dashboard's plan-creation wizard, portal's
subscribe wizard) is blocked on backend support for building unsigned calldata
and EIP-2612 permit typed-data. This phase adds that backend support — and
nothing else. The wizards that will consume these endpoints are explicitly out
of scope; they land in future phases once this groundwork exists.

The PRD (`cadence-prd.md`) frames both endpoints as thin helpers that never
sign anything (§7.4, §D.4):

```
GET /v1/prepare/plan       sec  returns unsigned createPlan calldata
GET /v1/prepare/subscribe  pub  returns unsigned subscribe/permit calldata
```

### Scope resolution: no 0xSplits backend work

The PRD (§6.7) is explicit that Cadence "does not implement splitting logic."
Split creation happens off-chain, wallet-signed, in the frontend via
`@0xsplits/splits-sdk`; the resulting Split address is passed to `createPlan`
as an opaque `payoutSplit` address. `SubscriptionManager` is "split-agnostic"
— it accepts any address, not just real 0xSplits contracts, and never
validates it. Confirmed with the user during brainstorming: this phase adds
**no** 0xSplits SDK, ABI, factory address, or on-chain validation of
`payoutSplit`. `/v1/prepare/plan` accepts whatever address the caller
supplies, exactly like the contract does.

### Scope resolution: chain address sourcing

`apps/api` has never needed on-chain deployment addresses before — plans and
subscriptions are served from Postgres rows the worker indexes. This phase
is the first time `apps/api` needs to know a contract address. Rather than
introduce the PRD's proposed `packages/shared/chains.ts` (a bigger, riskier
change touching `apps/worker`'s existing config too), this phase mirrors
`apps/worker/src/config.ts`'s existing pattern exactly: read
`deployments/<chainId>.json` directly via `readFileSync`, keyed by an
`apps/api`-local `CHAIN_ID` env var. Consistent with existing code; the
`chains.ts` unification remains a future cleanup, not part of this phase.

## Endpoints

### `GET /v1/prepare/plan`

**Auth:** secret key required (`@RequireKeyType("secret")`, same decorator
`PlansController.attachMetadata` uses).

**Query params** (all required, all strings from the wire):
- `payoutSplit` — address, any value accepted (see Scope resolution above)
- `token` — ERC-20 token address
- `amount` — uint256 as a decimal string
- `period` — uint40 seconds as a decimal string
- `trial` — uint40 seconds as a decimal string (`"0"` for no trial)

**Behavior:** pure calldata encoding. No DB read, no chain read. Validates
each param is a well-formed address (`payoutSplit`, `token`) or non-negative
integer string (`amount`, `period`, `trial`) via a Zod schema, returns
`invalid_request_error` (400) on failure — matching this codebase's existing
`AppException` conventions. Encodes calldata with viem's
`encodeFunctionData({ abi: subscriptionManagerAbi, functionName: "createPlan", args: [...] })`.

**Response:**
```json
{ "to": "0x...", "data": "0x...", "value": "0" }
```
`to` is `deployments/<CHAIN_ID>.json`'s `subscriptionManager` address.

### `GET /v1/prepare/subscribe`

**Auth:** publishable key OK (no `@RequireKeyType` restriction — same
default as `PlansController.list`/`getByOnchainId`, which accept session,
secret, or publishable).

**Query params:**
- `planId` — the plan's `onchain_plan_id`
- `owner` — the subscriber's wallet address (the customer signing the
  permit) — **explicit param, not derived from auth.** The caller's auth
  identity (resolved via `AuthContextService`) identifies the *merchant*
  whose publishable key is calling — used only to verify the merchant owns
  the plan (via `PlansService.getByOnchainId`'s existing `requireOwnedPlan`
  check, reused as-is). `owner` identifies who the permit is *for*.

**Behavior:**
1. Resolve caller's owner address via `AuthContextService` + `MerchantsService`
   (same pattern as `PlansController.resolveCallerOwnerAddress`).
2. Look up the plan via `PlansService.getByOnchainId(callerOwnerAddress, planId)`
   — reuses the existing ownership check unmodified: if the calling
   merchant's publishable key doesn't own this plan, 404 (matching
   `getByOnchainId`'s existing disclose-nothing behavior). This is a genuine
   integrity check, not incidental reuse: a merchant's publishable key must
   not be usable to build a subscribe permit for a competitor's plan.
3. Read the token contract live via a new viem `createPublicClient` (the
   first on-chain read client in `apps/api` — mirrors
   `apps/worker/src/queues.ts`'s `createPublicClient({ transport: http(rpcUrlHttp) })`
   pattern):
   - `name()` — required for the EIP-712 domain
   - `version()` — read via `eth_call` against the token's own ABI if it
     exposes one (most permit tokens do, per EIP-5267 patterns); default to
     `"1"` on revert/missing function. USDC-style tokens commonly use `"2"`
     — reading it live (rather than hardcoding) is why this phase adds a
     public client instead of a static lookup table.
   - `nonces(owner)` — required for the permit message; always present on
     any EIP-2612 token, no fallback.
4. Compute `deadline` as `now + 15 minutes` (Unix seconds) — long enough for
   a user to review and sign in a wallet UI, short enough to bound replay
   risk of an unused, unsigned permit response.
5. Build the EIP-2612 typed-data structure and the calldata template.

**Response:**
```json
{
  "permit": {
    "domain": {
      "name": "USD Coin",
      "version": "2",
      "chainId": 84532,
      "verifyingContract": "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
    },
    "types": {
      "Permit": [
        { "name": "owner", "type": "address" },
        { "name": "spender", "type": "address" },
        { "name": "value", "type": "uint256" },
        { "name": "nonce", "type": "uint256" },
        { "name": "deadline", "type": "uint256" }
      ]
    },
    "message": {
      "owner": "0x<owner>",
      "spender": "0x<subscriptionManager>",
      "value": "<plan.amount>",
      "nonce": "<live nonces(owner) read>",
      "deadline": "<now + 900>"
    }
  },
  "subscribe": {
    "to": "0x<subscriptionManager>",
    "fn": "subscribeWithPermit",
    "planId": "<planId>",
    "deadline": "<same as permit.message.deadline>"
  }
}
```
The `subscribe` block is a template, not full calldata — `v`, `r`, `s` don't
exist until the client signs the permit. Full `subscribeWithPermit` calldata
assembly (via `encodeFunctionData` with the signature split in) is the
consuming wizard's job in a future phase, not this endpoint's.

## New code

### `packages/shared`: ERC-2612 permit ABI

New `packages/shared/abis/Erc20Permit.ts` — a minimal ABI fragment (`name`,
`nonces`, `permit`; `version` handled as a raw `eth_call` with manual ABI
since not every ERC-20 exposes it uniformly — see Task detail in the plan).
Exported from both the main barrel (`packages/shared/src/index.ts`) and the
existing browser-safe `./abis` subpath (`packages/shared/src/abis-only.ts`)
— future frontend wizards will need it to render/verify the permit before
prompting a signature, so it follows the same dual-export precedent
`subscriptionManagerAbi`/`feeRegistryAbi` already established.

### `apps/api`: new `PrepareModule`

Follows the existing per-feature module pattern
(`<name>.controller.ts` + `.service.ts` + `.module.ts`, registered in
`app.module.ts`). New files:
- `apps/api/src/prepare/prepare.controller.ts`
- `apps/api/src/prepare/prepare.service.ts`
- `apps/api/src/prepare/prepare.module.ts`
- `apps/api/src/prepare/prepare.dto.ts` — Zod schemas for both query shapes,
  following `webhook-endpoints.dto.ts`'s `createZodDto` pattern. (Query
  params still land as `@Query() query: {...}` typed inline per this
  codebase's existing GET convention, e.g. `PlansController.list`; the Zod
  schema is used for explicit `.parse()` validation inside the service, not
  wired through `createZodDto` on the query decorator, since no controller
  in this codebase does that for GET query params today.)
- `apps/api/src/prepare/rpc-client.ts` — the new viem `createPublicClient`,
  constructed once from `RPC_URL_HTTP`/`CHAIN_ID` env vars (same var names
  `apps/worker` already uses, for operational consistency — both processes
  point at the same chain).

`PrepareModule` imports `AuthModule` and `MerchantsModule` (needed to resolve
the caller's merchant identity for `/v1/prepare/subscribe`'s ownership
check) and `PlansModule` (to reuse `PlansService.getByOnchainId`).

## Testing

Both endpoints are pure functions of `(query params | DB row | live token
reads) → deterministic response` — no writes, no side effects. Follows this
codebase's existing Vitest conventions:
- `/v1/prepare/plan`: unit tests over the Zod validation (bad address, bad
  integer string) and the calldata encoding (assert the decoded calldata via
  viem's `decodeFunctionData` round-trips to the input args) — no chain
  client needed, no mocking required.
- `/v1/prepare/subscribe`: unit tests with a mocked viem public client
  (`vi.fn()` stand-ins for `readContract` calls returning canned
  `name`/`version`/`nonces` values) and a mocked `PlansService`, asserting
  the response's `domain`/`message`/`subscribe` fields match expected
  values given known inputs. Also covers the not-owned-plan 404 path
  (reusing `PlansService`'s existing behavior, verified via the mock).
- No live RPC calls in tests — matches `apps/worker`'s existing test
  conventions of mocking viem clients rather than hitting real chains.

## Out of scope (explicit)

- 0xSplits SDK, ABI, or factory address — not needed (see Background).
- `packages/shared/chains.ts` — deferred; this phase mirrors worker's
  existing per-app `deployments/<chainId>.json` read instead.
- Any dashboard or portal UI consuming these endpoints — future phases.
- `subscribeWithPermit2` (Permit2-based flow mentioned in the PRD but not
  implemented in the current contract) — only `subscribeWithPermit`
  (native EIP-2612) exists in `SubscriptionManager.sol` today.
- Live/on-chain validation that a `payoutSplit` address is a real deployed
  Split — the contract doesn't require it and neither does this phase.
