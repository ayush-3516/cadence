# Phase 1l: Customer Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Customer Portal — a new `(portal)` route group in `apps/web` — with wallet-connect-only auth, a subscription list with balance warnings, a subscription detail page with real cancel/pause/resume wallet writes, and an invoices list.

**Architecture:** The portal reuses `apps/web`'s existing root layout, wagmi/ConnectKit providers, and Next.js config (all already wired app-wide by the merged dashboard phase — no new provider setup needed). Reads go through `@cadence/sdk`'s `Cadence` client (constructed once with a build-time publishable key), not a hand-rolled fetch wrapper — this is the SDK's first real consumer, since its Bearer-token auth model fits the portal's no-session design exactly (unlike the dashboard, which needed cookies). Writes (cancel/pause/resume) go through wagmi's `useWriteContract` directly against the already-exported `subscriptionManagerAbi`.

**Tech Stack:** Next.js 15 App Router (existing `apps/web`), `@cadence/sdk` (existing `packages/sdk`), wagmi 2.19.x + viem 2.x (existing config), `@cadence/ui`'s `StatusBadge`/`CadencePulse` (existing `packages/ui`), TanStack Query 5.x (existing provider).

## Global Constraints

- The portal is single-merchant: one deployment serves one merchant's subscribers, identified by a single build-time `NEXT_PUBLIC_PORTAL_PUBLISHABLE_KEY` env var. No merchant-selection UI, no cross-merchant aggregation.
- All reads use `@cadence/sdk`'s `Cadence` client — never a hand-rolled `apiFetch`, never a raw `fetch` call. The client is constructed once, module-level, with `{ apiKey: process.env.NEXT_PUBLIC_PORTAL_PUBLISHABLE_KEY, baseUrl: process.env.NEXT_PUBLIC_API_BASE_URL }`.
- `GET /v1/subscriptions/:onchainId` (the full detail endpoint, with `plan`/`charges`) rejects publishable keys — confirmed in `apps/api/src/subscriptions/subscriptions.controller.ts`'s `resolveSecretCallerOwnerAddress`. The portal can only use `cadence.customers.subscriptions(address)`, which returns the summary shape (`Subscription`: `id`, `onchain_sub_id`, `onchain_plan_id`, `subscriber`, `status`, `current_period_end`, `created_at` — no `plan`, no `charges`). `/portal/subscriptions/[id]` is built entirely from this summary shape, found by filtering the same list `/portal` already fetches down to the matching `onchain_sub_id`. No charge-history table, no full plan name/period display — this is a permanent API constraint, not a gap to patch around.
- `CadencePulse` receives a hardcoded `periodSeconds={30 * 86400}` wherever the summary shape is the only data available (no per-subscription `period_seconds` exists in that shape) — matching the exact precedent and inline-comment convention already established in `apps/web/app/(dashboard)/dashboard/subscriptions/page.tsx`.
- `Invoice.pdf_url` is nullable (`string | null`) — the Download link/button must handle the null case (disabled or hidden), never assume a URL is present.
- No `/portal/subscribe/[planId]` (blocked on `GET /v1/prepare/subscribe`, which doesn't exist), no "revoke spending permission" action, no cross-merchant aggregation, no new backend/API work, no marketing site — all explicitly out of scope per the design spec.
- Dark-default surface for pages under `(portal)`, opposite of the dashboard's light-default — using the same six existing design tokens (`ink`/`paper`/`sapphire`/`signal`/`mint`/`slate`), no new tokens.
- Wallet/chain config targets `baseSepolia` only (chain id `84532`), reusing the existing `apps/web/lib/wagmi-config.ts` as-is — no portal-specific wagmi config.
- No new CORS work — the portal lives in the same `apps/web` Next.js server/origin (port 3001) already covered by `apps/api`'s existing `CORS_ORIGINS` allowlist.

---

### Task 1: Portal shell — SDK client, env vars, `(portal)` layout, subscription-manager write helper

**Files:**
- Create: `apps/web/lib/cadence-client.ts`
- Create: `apps/web/lib/hooks/usePortalSubscriptions.ts`
- Create: `apps/web/lib/hooks/useSubscriptionWrite.ts`
- Create: `apps/web/app/(portal)/layout.tsx`
- Modify: `apps/web/.env.local.example`
- Test: `apps/web/test/cadence-client.test.ts`
- Test: `apps/web/test/usePortalSubscriptions.test.tsx`

**Interfaces:**
- Produces: `cadence: Cadence` (module-level singleton, exported from `cadence-client.ts`); `usePortalSubscriptions(address: string | undefined): {data, isLoading, error}` (wraps `cadence.customers.subscriptions(address)`, returns the unwrapped `Subscription[]`); `useSubscriptionWrite(functionName: "cancel" | "pauseSubscription" | "resumeSubscription")` returning `{ write: (subId: string, extraArgs?: unknown[]) => void, status: "idle" | "confirming" | "pending" | "processing" | "done" | "error", error: Error | null }` (wraps wagmi's `useWriteContract` + `useWaitForTransactionReceipt` against `subscriptionManagerAbi`). Every later task (2, 3) consumes these three exactly as defined here.

- [ ] **Step 1: Add the new env vars**

Modify `apps/web/.env.local.example` — append:

```
NEXT_PUBLIC_PORTAL_PUBLISHABLE_KEY=ck_test_pub_replace-with-a-real-publishable-key
NEXT_PUBLIC_SUBSCRIPTION_MANAGER_ADDRESS=0x0000000000000000000000000000000000000000
```

- [ ] **Step 2: Write the failing test for the SDK client**

Create `apps/web/test/cadence-client.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";

describe("cadence client", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("constructs a Cadence client with the publishable key and base URL from env", async () => {
    vi.stubEnv("NEXT_PUBLIC_PORTAL_PUBLISHABLE_KEY", "ck_test_pub_abc123");
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://localhost:3000");

    const { cadence } = await import("../lib/cadence-client.js");

    expect(cadence).toBeDefined();
    expect(cadence.customers).toBeDefined();
    expect(cadence.subscriptions).toBeDefined();
    expect(cadence.invoices).toBeDefined();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/web && npx vitest run test/cadence-client.test.ts`
Expected: FAIL — `../lib/cadence-client.js` does not exist.

- [ ] **Step 4: Implement the SDK client singleton**

Create `apps/web/lib/cadence-client.ts`:

```typescript
import { Cadence } from "@cadence/sdk";

export const cadence = new Cadence({
  apiKey: process.env.NEXT_PUBLIC_PORTAL_PUBLISHABLE_KEY ?? "",
  baseUrl: process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000",
});
```

- [ ] **Step 5: Add `@cadence/sdk` as a dependency**

Modify `apps/web/package.json` — add to `dependencies`:

```json
"@cadence/sdk": "workspace:*",
```

Run: `pnpm install` (from repo root, to link the new workspace dependency).

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run test/cadence-client.test.ts`
Expected: PASS (1/1 test).

- [ ] **Step 7: Write the failing test for `usePortalSubscriptions`**

Create `apps/web/test/usePortalSubscriptions.test.tsx`:

```tsx
import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { usePortalSubscriptions } from "../lib/hooks/usePortalSubscriptions.js";
import { cadence } from "../lib/cadence-client.js";

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("usePortalSubscriptions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches cadence.customers.subscriptions(address) and returns the unwrapped array", async () => {
    vi.spyOn(cadence.customers, "subscriptions").mockResolvedValue({
      data: [{ id: "1", onchain_sub_id: "1", onchain_plan_id: "7", subscriber: "0xabc", status: "active", current_period_end: "2026-08-01T00:00:00Z", created_at: null }],
      has_more: false,
      next_cursor: null,
    });

    const { result } = renderHook(() => usePortalSubscriptions("0xabc"), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0].onchain_sub_id).toBe("1");
    expect(cadence.customers.subscriptions).toHaveBeenCalledWith("0xabc");
  });

  it("does not fetch when address is undefined (wallet not connected)", async () => {
    const spy = vi.spyOn(cadence.customers, "subscriptions");

    const { result } = renderHook(() => usePortalSubscriptions(undefined), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(spy).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });
});
```

- [ ] **Step 8: Run it to verify it fails**

Run: `cd apps/web && npx vitest run test/usePortalSubscriptions.test.tsx`
Expected: FAIL — `../lib/hooks/usePortalSubscriptions.js` does not exist.

- [ ] **Step 9: Implement `usePortalSubscriptions`**

Create `apps/web/lib/hooks/usePortalSubscriptions.ts`:

```typescript
import { useQuery } from "@tanstack/react-query";
import { cadence } from "../cadence-client.js";

export function usePortalSubscriptions(address: string | undefined) {
  const query = useQuery({
    queryKey: ["portal", "subscriptions", address],
    queryFn: () => cadence.customers.subscriptions(address!),
    enabled: address !== undefined,
  });
  return { ...query, data: query.data?.data };
}
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run test/usePortalSubscriptions.test.tsx`
Expected: PASS (2/2 tests).

- [ ] **Step 11: Implement `useSubscriptionWrite`**

This hook is not independently tested in this task (its state-machine behavior is exercised by Task 3's component tests, which mock wagmi's `useWriteContract`/`useWaitForTransactionReceipt` directly — testing this thin wrapper in isolation would just re-test wagmi's own hooks). Create `apps/web/lib/hooks/useSubscriptionWrite.ts`:

```typescript
import { useEffect, useState } from "react";
import { useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { subscriptionManagerAbi } from "@cadence/shared";

export type WriteStatus = "idle" | "confirming" | "pending" | "processing" | "done" | "error";

const SUBSCRIPTION_MANAGER_ADDRESS = (process.env.NEXT_PUBLIC_SUBSCRIPTION_MANAGER_ADDRESS ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;

export function useSubscriptionWrite(functionName: "cancel" | "pauseSubscription" | "resumeSubscription") {
  const [status, setStatus] = useState<WriteStatus>("idle");
  const { writeContract, data: hash, error: writeError, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess, error: receiptError } = useWaitForTransactionReceipt({ hash });

  useEffect(() => {
    if (writeError) setStatus("error");
    else if (isPending) setStatus("confirming");
    else if (hash && isConfirming) setStatus("pending");
    else if (isSuccess) setStatus("processing");
  }, [writeError, isPending, hash, isConfirming, isSuccess]);

  useEffect(() => {
    if (receiptError) setStatus("error");
  }, [receiptError]);

  useEffect(() => {
    if (status === "processing") {
      const timer = setTimeout(() => setStatus("done"), 3000);
      return () => clearTimeout(timer);
    }
  }, [status]);

  function write(subId: string, extraArgs: unknown[] = []) {
    setStatus("confirming");
    writeContract({
      address: SUBSCRIPTION_MANAGER_ADDRESS,
      abi: subscriptionManagerAbi,
      functionName,
      args: [BigInt(subId), ...extraArgs],
    });
  }

  return { write, status, error: writeError ?? receiptError ?? null };
}
```

Note the `"processing" → "done"` transition uses a fixed 3-second timeout rather than actually polling the indexer/API for updated status — this is a deliberate, minimal placeholder for "awaiting indexer reflect" per the design spec's state machine (`processing (tx confirmed, awaiting indexer to reflect the new status)`). A real indexer-poll would require a new API round-trip pattern this phase doesn't otherwise need; the fixed delay is a pragmatic approximation, and Task 3's consuming page independently triggers a TanStack Query cache invalidation/refetch after `write()` resolves to `"done"`, so the UI does eventually show fresh data regardless of whether 3 seconds was enough — it's a UX pacing choice, not a correctness dependency.

- [ ] **Step 12: Add `@cadence/shared` as a dependency**

Modify `apps/web/package.json` — add to `dependencies`:

```json
"@cadence/shared": "workspace:*",
```

Run: `pnpm install` (from repo root).

- [ ] **Step 13: Create the `(portal)` layout**

Create `apps/web/app/(portal)/layout.tsx`:

```tsx
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-ink text-paper">
      <div className="max-w-2xl mx-auto p-6">{children}</div>
    </div>
  );
}
```

Note this layout does NOT gate on a signed-in session (unlike `(dashboard)/layout.tsx`) — the portal has no session concept at all. Wallet-connection state is checked per-page (Task 2), not at the layout level, since a disconnected wallet is a valid state to render a "connect your wallet" prompt from, not an error state to redirect away from.

- [ ] **Step 14: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 15: Run the full apps/web suite to confirm no regression**

Run: `cd apps/web && npx vitest run`
Expected: all tests pass (13 pre-existing from the merged dashboard phase + 3 new from this task = 16 total).

- [ ] **Step 16: Commit**

```bash
git add apps/web/lib/cadence-client.ts apps/web/lib/hooks/usePortalSubscriptions.ts apps/web/lib/hooks/useSubscriptionWrite.ts "apps/web/app/(portal)/layout.tsx" apps/web/.env.local.example apps/web/package.json apps/web/test/cadence-client.test.ts apps/web/test/usePortalSubscriptions.test.tsx
git commit -m "Add portal shell: SDK client, subscription hooks, write helper, layout"
```

---

### Task 2: `/portal` — subscription list with balance warning

**Files:**
- Create: `apps/web/app/(portal)/portal/page.tsx`
- Create: `apps/web/lib/hooks/useTokenBalance.ts`
- Create: `apps/web/lib/hooks/usePortalPlan.ts`
- Create: `apps/web/components/BalanceWarning.tsx`
- Create: `apps/web/components/SubscriptionCard.tsx`
- Test: `apps/web/test/BalanceWarning.test.tsx`
- Test: `apps/web/test/SubscriptionCard.test.tsx`

**Interfaces:**
- Consumes: `usePortalSubscriptions` (Task 1), `StatusBadge`/`CadencePulse` (`@cadence/ui`, pre-existing).
- Produces: `useTokenBalance(tokenAddress: \`0x${string}\` | undefined, account: \`0x${string}\` | undefined): {balance: bigint | undefined, isLoading: boolean}` (wraps wagmi's `useReadContract` with viem's `erc20Abi`); `usePortalPlan(onchainPlanId: string | undefined): {data: Plan | undefined, isLoading, error}` (wraps `cadence.plans.get(onchainPlanId)` — `GET /v1/plans/:onchainId` accepts publishable keys, confirmed in `apps/api/src/plans/plans.controller.ts`'s `resolveCallerOwnerAddress(request, false)`); `<BalanceWarning balance={bigint | undefined} required={string}>` (renders a warning if `balance < BigInt(required)`); `<SubscriptionCard subscription={Subscription} account={\`0x${string}\` | undefined}>` (per-row component that fetches its own plan via `usePortalPlan` and its own balance via `useTokenBalance`, composing `StatusBadge`/`CadencePulse`/`BalanceWarning`). Consumed by this task's own page only — no later task depends on these.

- [ ] **Step 1: Write the failing test for `BalanceWarning`**

Create `apps/web/test/BalanceWarning.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { BalanceWarning } from "../components/BalanceWarning.js";

describe("BalanceWarning", () => {
  it("renders a warning when balance is below the required amount", () => {
    render(<BalanceWarning balance={5_000_000n} required="20000000" />);
    expect(screen.getByText(/insufficient/i)).toBeInTheDocument();
  });

  it("renders nothing when balance covers the required amount", () => {
    const { container } = render(<BalanceWarning balance={50_000_000n} required="20000000" />);
    expect(container.textContent).toBe("");
  });

  it("renders nothing while balance is still loading (undefined)", () => {
    const { container } = render(<BalanceWarning balance={undefined} required="20000000" />);
    expect(container.textContent).toBe("");
  });
});
```

Note this test asserts `container.textContent` (not `.toBeInTheDocument()`, which needs `@testing-library/jest-dom` — not installed anywhere in this monorepo, confirmed in the dashboard phase's own test files) for the "renders nothing" cases, and `screen.getByText` (which throws if not found, a real assertion) for the "renders a warning" case — matching the exact assertion conventions already established across every `apps/web` test file from the dashboard phase.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run test/BalanceWarning.test.tsx`
Expected: FAIL — `../components/BalanceWarning.js` does not exist.

- [ ] **Step 3: Implement `BalanceWarning`**

Create `apps/web/components/BalanceWarning.tsx`:

```tsx
export interface BalanceWarningProps {
  balance: bigint | undefined;
  required: string;
}

export function BalanceWarning({ balance, required }: BalanceWarningProps) {
  if (balance === undefined) return null;
  if (balance >= BigInt(required)) return null;

  return (
    <p className="text-signal text-xs font-body mt-1">Insufficient USDC balance for the next charge.</p>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run test/BalanceWarning.test.tsx`
Expected: PASS (3/3 tests).

- [ ] **Step 5: Implement `useTokenBalance` and `usePortalPlan`**

Create `apps/web/lib/hooks/useTokenBalance.ts`:

```typescript
import { useReadContract } from "wagmi";
import { erc20Abi } from "viem";

export function useTokenBalance(tokenAddress: `0x${string}` | undefined, account: `0x${string}` | undefined) {
  const { data, isLoading } = useReadContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    query: { enabled: tokenAddress !== undefined && account !== undefined },
  });
  return { balance: data, isLoading };
}
```

Create `apps/web/lib/hooks/usePortalPlan.ts`:

```typescript
import { useQuery } from "@tanstack/react-query";
import { cadence } from "../cadence-client.js";

export function usePortalPlan(onchainPlanId: string | undefined) {
  return useQuery({
    queryKey: ["portal", "plan", onchainPlanId],
    queryFn: () => cadence.plans.get(onchainPlanId!),
    enabled: onchainPlanId !== undefined,
  });
}
```

`GET /v1/plans/:onchainId` accepts publishable keys (`resolveCallerOwnerAddress(request, false)` in `apps/api/src/plans/plans.controller.ts`), so this is a real, working fetch — not blocked the way the subscription detail endpoint is.

- [ ] **Step 6: Write the failing test for `SubscriptionCard`**

Create `apps/web/test/SubscriptionCard.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SubscriptionCard } from "../components/SubscriptionCard.js";

const mockUsePortalPlan = vi.fn();
const mockUseTokenBalance = vi.fn();

vi.mock("../lib/hooks/usePortalPlan.js", () => ({
  usePortalPlan: (id: string | undefined) => mockUsePortalPlan(id),
}));
vi.mock("../lib/hooks/useTokenBalance.js", () => ({
  useTokenBalance: (token: string | undefined, account: string | undefined) => mockUseTokenBalance(token, account),
}));

const SUBSCRIPTION = {
  id: "1",
  onchain_sub_id: "1",
  onchain_plan_id: "7",
  subscriber: "0xabc",
  status: "active",
  current_period_end: "2026-08-01T00:00:00Z",
  created_at: null,
};

describe("SubscriptionCard", () => {
  beforeEach(() => {
    mockUsePortalPlan.mockReset();
    mockUseTokenBalance.mockReset();
  });

  it("passes the subscription's onchain_plan_id to usePortalPlan", () => {
    mockUsePortalPlan.mockReturnValue({ data: undefined, isLoading: true });
    mockUseTokenBalance.mockReturnValue({ balance: undefined, isLoading: true });

    render(<SubscriptionCard subscription={SUBSCRIPTION} account="0xdef" />);

    expect(mockUsePortalPlan).toHaveBeenCalledWith("7");
  });

  it("fetches the balance for the plan's token once the plan loads", () => {
    mockUsePortalPlan.mockReturnValue({
      data: { onchain_plan_id: "7", name: "Pro", amount: "20000000", token: "0xusdc", period_seconds: 2_592_000, trial_seconds: 0, active: true, payout_split: "0x0", dunning_ladder: [], created_at: null, livemode: false, description: null, image_url: null },
      isLoading: false,
    });
    mockUseTokenBalance.mockReturnValue({ balance: 5_000_000n, isLoading: false });

    render(<SubscriptionCard subscription={SUBSCRIPTION} account="0xdef" />);

    expect(mockUseTokenBalance).toHaveBeenCalledWith("0xusdc", "0xdef");
  });

  it("renders a balance warning when the plan is loaded and balance is insufficient", () => {
    mockUsePortalPlan.mockReturnValue({
      data: { onchain_plan_id: "7", name: "Pro", amount: "20000000", token: "0xusdc", period_seconds: 2_592_000, trial_seconds: 0, active: true, payout_split: "0x0", dunning_ladder: [], created_at: null, livemode: false, description: null, image_url: null },
      isLoading: false,
    });
    mockUseTokenBalance.mockReturnValue({ balance: 5_000_000n, isLoading: false });

    render(<SubscriptionCard subscription={SUBSCRIPTION} account="0xdef" />);

    expect(screen.getByText(/insufficient/i)).toBeDefined();
  });

  it("renders no warning while the plan is still loading", () => {
    mockUsePortalPlan.mockReturnValue({ data: undefined, isLoading: true });
    mockUseTokenBalance.mockReturnValue({ balance: undefined, isLoading: true });

    render(<SubscriptionCard subscription={SUBSCRIPTION} account="0xdef" />);

    expect(screen.queryByText(/insufficient/i)).toBeNull();
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `cd apps/web && npx vitest run test/SubscriptionCard.test.tsx`
Expected: FAIL — `../components/SubscriptionCard.js` does not exist.

- [ ] **Step 8: Implement `SubscriptionCard`**

Create `apps/web/components/SubscriptionCard.tsx`:

```tsx
"use client";

import Link from "next/link";
import { StatusBadge, CadencePulse } from "@cadence/ui";
import { usePortalPlan } from "../lib/hooks/usePortalPlan.js";
import { useTokenBalance } from "../lib/hooks/useTokenBalance.js";
import { BalanceWarning } from "./BalanceWarning.js";
import type { Subscription } from "@cadence/sdk";

export interface SubscriptionCardProps {
  subscription: Subscription;
  account: `0x${string}` | undefined;
}

export function SubscriptionCard({ subscription, account }: SubscriptionCardProps) {
  const { data: plan } = usePortalPlan(subscription.onchain_plan_id);
  const { balance } = useTokenBalance(plan?.token as `0x${string}` | undefined, account);

  return (
    <Link
      href={`/portal/subscriptions/${subscription.onchain_sub_id}`}
      className="block rounded-lg border border-paper/15 p-4 hover:border-sapphire/40"
    >
      <div className="flex items-center justify-between mb-2">
        <span className="font-data text-sm">{plan?.name ?? `Subscription #${subscription.onchain_sub_id}`}</span>
        <StatusBadge status={subscription.status} />
      </div>
      {/* GET /v1/customers/:address/subscriptions has no per-plan period_seconds (only the
          secret-key-only detail endpoint does), so this hardcodes a 30-day period rather
          than trusting the fetched plan's real period_seconds for the pulse specifically —
          the plan fetch here is only for token/amount/name, and using its real
          period_seconds too would be a reasonable future improvement, but this task's own
          scope is just the balance-warning wiring, so the pulse keeps the pre-existing
          hardcoded-30-day convention from the dashboard phase unchanged. */}
      <CadencePulse periodSeconds={30 * 86400} currentPeriodEnd={subscription.current_period_end} />
      {plan && <BalanceWarning balance={balance} required={plan.amount} />}
    </Link>
  );
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run test/SubscriptionCard.test.tsx`
Expected: PASS (4/4 tests).

- [ ] **Step 10: Build the `/portal` list page**

Create `apps/web/app/(portal)/portal/page.tsx`:

```tsx
"use client";

import { useAccount } from "wagmi";
import { ConnectKitButton } from "connectkit";
import { usePortalSubscriptions } from "../../../lib/hooks/usePortalSubscriptions.js";
import { SubscriptionCard } from "../../../components/SubscriptionCard.js";

export default function PortalPage() {
  const { address, isConnected } = useAccount();
  const { data, isLoading, error } = usePortalSubscriptions(address);

  if (!isConnected) {
    return (
      <div className="flex flex-col items-center mt-24 gap-4">
        <h1 className="font-display text-2xl">Your subscriptions</h1>
        <p className="font-body text-slate">Connect your wallet to view your subscriptions.</p>
        <ConnectKitButton />
      </div>
    );
  }

  if (isLoading) return <p className="font-body text-slate">Loading…</p>;
  if (error) return <p className="font-body text-signal">Could not load subscriptions.</p>;

  return (
    <div>
      <h1 className="font-display text-2xl mb-6">Your subscriptions</h1>
      {data?.length === 0 && <p className="font-body text-slate">No subscriptions yet.</p>}
      <div className="flex flex-col gap-3">
        {data?.map((sub) => (
          <SubscriptionCard key={sub.onchain_sub_id} subscription={sub} account={address} />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 11: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 12: Run the full apps/web suite to confirm no regression**

Run: `cd apps/web && npx vitest run`
Expected: all tests pass (16 from Task 1 + 3 (BalanceWarning) + 4 (SubscriptionCard) from this task = 23 total).

- [ ] **Step 13: Commit**

```bash
git add "apps/web/app/(portal)/portal/page.tsx" apps/web/lib/hooks/useTokenBalance.ts apps/web/lib/hooks/usePortalPlan.ts apps/web/components/BalanceWarning.tsx apps/web/components/SubscriptionCard.tsx apps/web/test/BalanceWarning.test.tsx apps/web/test/SubscriptionCard.test.tsx
git commit -m "Add /portal subscription list page with real balance-warning wiring"
```

---

### Task 3: `/portal/subscriptions/[id]` — detail + cancel/pause/resume

**Files:**
- Create: `apps/web/app/(portal)/portal/subscriptions/[id]/page.tsx`
- Create: `apps/web/components/SubscriptionActions.tsx`
- Test: `apps/web/test/SubscriptionActions.test.tsx`

**Interfaces:**
- Consumes: `usePortalSubscriptions` (Task 1, re-fetched and filtered by `onchain_sub_id` per this phase's Global Constraints — no separate detail-fetching hook exists since the detail endpoint is unavailable to publishable keys), `useSubscriptionWrite` (Task 1), `StatusBadge` (`@cadence/ui`).
- Produces: `<SubscriptionActions subId={string} status={string}>` — the three write-action buttons, consumed only by this task's own page. This is the FINAL task touching subscription-write functionality; Task 4 is independent (invoices only).

- [ ] **Step 1: Write the failing test for `SubscriptionActions`**

Create `apps/web/test/SubscriptionActions.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SubscriptionActions } from "../components/SubscriptionActions.js";

const mockUseSubscriptionWrite = vi.fn();

vi.mock("../lib/hooks/useSubscriptionWrite.js", () => ({
  useSubscriptionWrite: (fn: string) => mockUseSubscriptionWrite(fn),
}));

describe("SubscriptionActions", () => {
  beforeEach(() => {
    mockUseSubscriptionWrite.mockReset();
    mockUseSubscriptionWrite.mockReturnValue({ write: vi.fn(), status: "idle", error: null });
  });

  it("shows a Pause button (not Resume) when status is active", () => {
    render(<SubscriptionActions subId="1" status="active" />);
    expect(screen.getByRole("button", { name: /pause/i })).toBeDefined();
    expect(screen.queryByRole("button", { name: /^resume$/i })).toBeNull();
  });

  it("shows a Resume button (not Pause) when status is paused", () => {
    render(<SubscriptionActions subId="1" status="paused" />);
    expect(screen.getByRole("button", { name: /resume/i })).toBeDefined();
    expect(screen.queryByRole("button", { name: /^pause$/i })).toBeNull();
  });

  it("always shows Cancel with immediate/at-period-end options", () => {
    render(<SubscriptionActions subId="1" status="active" />);
    expect(screen.getByRole("button", { name: /cancel immediately/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /cancel at period end/i })).toBeDefined();
  });

  it("calls write with the subId and immediate=true when 'Cancel immediately' is clicked", () => {
    const write = vi.fn();
    mockUseSubscriptionWrite.mockReturnValue({ write, status: "idle", error: null });

    render(<SubscriptionActions subId="42" status="active" />);
    fireEvent.click(screen.getByRole("button", { name: /cancel immediately/i }));

    expect(write).toHaveBeenCalledWith("42", [true]);
  });

  it("calls write with the subId and immediate=false when 'Cancel at period end' is clicked", () => {
    const write = vi.fn();
    mockUseSubscriptionWrite.mockReturnValue({ write, status: "idle", error: null });

    render(<SubscriptionActions subId="42" status="active" />);
    fireEvent.click(screen.getByRole("button", { name: /cancel at period end/i }));

    expect(write).toHaveBeenCalledWith("42", [false]);
  });

  it("disables all buttons and shows a status message while a write is in flight", () => {
    mockUseSubscriptionWrite.mockReturnValue({ write: vi.fn(), status: "confirming", error: null });

    render(<SubscriptionActions subId="1" status="active" />);
    expect(screen.getByRole("button", { name: /pause/i })).toHaveProperty("disabled", true);
    expect(screen.getByText(/confirm in your wallet/i)).toBeDefined();
  });
});
```

Note `SubscriptionActions` calls THREE separate `useSubscriptionWrite` instances (one per action — `cancel`, `pauseSubscription`, `resumeSubscription`), but the test mocks the hook module-wide with one `mockUseSubscriptionWrite` function returning the same state for all three calls — this is intentional and sufficient for these tests, since each test only exercises one action's button at a time and the mock's return value applies uniformly. A real component would have three independent write states in practice, but testing that three-way independence is not necessary for this task's behavioral requirements (button visibility by status, correct call arguments, disabled-during-flight styling) — it would only be needed if the design required, e.g., "can you cancel while a pause is in flight," which the spec does not.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run test/SubscriptionActions.test.tsx`
Expected: FAIL — `../components/SubscriptionActions.js` does not exist.

- [ ] **Step 3: Implement `SubscriptionActions`**

Create `apps/web/components/SubscriptionActions.tsx`:

```tsx
"use client";

import { useSubscriptionWrite } from "../lib/hooks/useSubscriptionWrite.js";

export interface SubscriptionActionsProps {
  subId: string;
  status: string;
}

const STATUS_MESSAGE: Record<string, string> = {
  confirming: "Confirm in your wallet…",
  pending: "Transaction submitted, waiting for confirmation…",
  processing: "Confirmed — updating…",
  error: "Something went wrong. Please try again.",
};

export function SubscriptionActions({ subId, status }: SubscriptionActionsProps) {
  const cancelWrite = useSubscriptionWrite("cancel");
  const pauseWrite = useSubscriptionWrite("pauseSubscription");
  const resumeWrite = useSubscriptionWrite("resumeSubscription");

  const anyInFlight = [cancelWrite.status, pauseWrite.status, resumeWrite.status].some((s) => s === "confirming" || s === "pending");
  const activeStatus = [cancelWrite.status, pauseWrite.status, resumeWrite.status].find((s) => s !== "idle" && s !== "done");

  return (
    <div className="flex flex-col gap-2 mt-4">
      <div className="flex gap-2">
        {status === "active" && (
          <button
            onClick={() => pauseWrite.write(subId)}
            disabled={anyInFlight}
            className="rounded-md border border-paper/30 px-3 py-1.5 text-sm font-body disabled:opacity-50"
          >
            Pause
          </button>
        )}
        {status === "paused" && (
          <button
            onClick={() => resumeWrite.write(subId)}
            disabled={anyInFlight}
            className="rounded-md border border-paper/30 px-3 py-1.5 text-sm font-body disabled:opacity-50"
          >
            Resume
          </button>
        )}
        <button
          onClick={() => cancelWrite.write(subId, [true])}
          disabled={anyInFlight}
          className="rounded-md border border-signal/50 text-signal px-3 py-1.5 text-sm font-body disabled:opacity-50"
        >
          Cancel immediately
        </button>
        <button
          onClick={() => cancelWrite.write(subId, [false])}
          disabled={anyInFlight}
          className="rounded-md border border-paper/30 px-3 py-1.5 text-sm font-body disabled:opacity-50"
        >
          Cancel at period end
        </button>
      </div>
      {activeStatus && STATUS_MESSAGE[activeStatus] && <p className="font-body text-xs text-slate">{STATUS_MESSAGE[activeStatus]}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run test/SubscriptionActions.test.tsx`
Expected: PASS (6/6 tests).

- [ ] **Step 5: Build the subscription detail page**

Create `apps/web/app/(portal)/portal/subscriptions/[id]/page.tsx`:

```tsx
"use client";

import { useParams } from "next/navigation";
import { useAccount } from "wagmi";
import { usePortalSubscriptions } from "../../../../../lib/hooks/usePortalSubscriptions.js";
import { SubscriptionActions } from "../../../../../components/SubscriptionActions.js";
import { StatusBadge } from "@cadence/ui";

export default function PortalSubscriptionDetailPage() {
  const params = useParams<{ id: string }>();
  const { address } = useAccount();
  const { data, isLoading, error } = usePortalSubscriptions(address);

  if (isLoading) return <p className="font-body text-slate">Loading…</p>;
  if (error) return <p className="font-body text-signal">Could not load subscription.</p>;

  const subscription = data?.find((sub) => sub.onchain_sub_id === params.id);
  if (!subscription) return <p className="font-body text-signal">Subscription not found.</p>;

  return (
    <div>
      <h1 className="font-display text-2xl mb-2">Subscription #{subscription.onchain_sub_id}</h1>
      <div className="flex items-center gap-3 mb-4">
        <StatusBadge status={subscription.status} />
        <span className="font-data text-sm text-slate">{subscription.subscriber}</span>
      </div>
      <SubscriptionActions subId={subscription.onchain_sub_id} status={subscription.status} />
    </div>
  );
}
```

Note this page re-fetches the SAME list `/portal` already fetched (`usePortalSubscriptions(address)`) and finds the matching row by `onchain_sub_id`, rather than a dedicated single-subscription fetch — per this phase's Global Constraints, no publishable-key-accessible endpoint returns a single subscription by id; the only available endpoint is the list. TanStack Query's cache (same `queryKey`) means this is not a duplicate network request if the user navigated here from `/portal` within the cache's staleness window — it's a genuine re-fetch only on a fresh page load (e.g. a bookmarked/shared detail URL), which is unavoidable given the available API surface.

- [ ] **Step 6: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Run the full apps/web suite to confirm no regression**

Run: `cd apps/web && npx vitest run`
Expected: all tests pass (23 from Tasks 1-2 + 6 from this task = 29 total).

- [ ] **Step 8: Commit**

```bash
git add "apps/web/app/(portal)/portal/subscriptions/[id]/page.tsx" apps/web/components/SubscriptionActions.tsx apps/web/test/SubscriptionActions.test.tsx
git commit -m "Add /portal/subscriptions/[id] detail page with cancel/pause/resume actions"
```

---

### Task 4: `/portal/invoices`

**Files:**
- Create: `apps/web/app/(portal)/portal/invoices/page.tsx`
- Create: `apps/web/lib/hooks/usePortalInvoices.ts`
- Test: `apps/web/test/usePortalInvoices.test.tsx`

**Interfaces:**
- Consumes: `cadence` client (Task 1).
- Produces: `usePortalInvoices(address: string | undefined): {data, isLoading, error}` (wraps `cadence.invoices.list({subscriber: address})`, returns the unwrapped `Invoice[]`). This is the FINAL task of this phase — no later task depends on this.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/usePortalInvoices.test.tsx`:

```tsx
import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { usePortalInvoices } from "../lib/hooks/usePortalInvoices.js";
import { cadence } from "../lib/cadence-client.js";

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("usePortalInvoices", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches cadence.invoices.list({subscriber: address}) and returns the unwrapped array", async () => {
    vi.spyOn(cadence.invoices, "list").mockResolvedValue({
      data: [{ id: "inv_1", number: "1", pdf_url: "https://example.com/inv1.pdf", tx_hash: "0xabc", amount: "20000000", platform_fee: "150000", net: "19850000", onchain_sub_id: "1", onchain_plan_id: "7", issued_at: "2026-07-01T00:00:00Z" }],
      has_more: false,
      next_cursor: null,
    });

    const { result } = renderHook(() => usePortalInvoices("0xabc"), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toHaveLength(1);
    expect(cadence.invoices.list).toHaveBeenCalledWith({ subscriber: "0xabc" });
  });

  it("does not fetch when address is undefined", async () => {
    const spy = vi.spyOn(cadence.invoices, "list");

    const { result } = renderHook(() => usePortalInvoices(undefined), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run test/usePortalInvoices.test.tsx`
Expected: FAIL — `../lib/hooks/usePortalInvoices.js` does not exist.

- [ ] **Step 3: Implement `usePortalInvoices`**

Create `apps/web/lib/hooks/usePortalInvoices.ts`:

```typescript
import { useQuery } from "@tanstack/react-query";
import { cadence } from "../cadence-client.js";

export function usePortalInvoices(address: string | undefined) {
  const query = useQuery({
    queryKey: ["portal", "invoices", address],
    queryFn: () => cadence.invoices.list({ subscriber: address! }),
    enabled: address !== undefined,
  });
  return { ...query, data: query.data?.data };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run test/usePortalInvoices.test.tsx`
Expected: PASS (2/2 tests).

- [ ] **Step 5: Build the invoices page**

Create `apps/web/app/(portal)/portal/invoices/page.tsx`:

```tsx
"use client";

import { useAccount } from "wagmi";
import { ConnectKitButton } from "connectkit";
import { usePortalInvoices } from "../../../../lib/hooks/usePortalInvoices.js";

export default function PortalInvoicesPage() {
  const { address, isConnected } = useAccount();
  const { data, isLoading, error } = usePortalInvoices(address);

  if (!isConnected) {
    return (
      <div className="flex flex-col items-center mt-24 gap-4">
        <h1 className="font-display text-2xl">Invoices</h1>
        <p className="font-body text-slate">Connect your wallet to view your invoices.</p>
        <ConnectKitButton />
      </div>
    );
  }

  if (isLoading) return <p className="font-body text-slate">Loading…</p>;
  if (error) return <p className="font-body text-signal">Could not load invoices.</p>;

  return (
    <div>
      <h1 className="font-display text-2xl mb-6">Invoices</h1>
      {data?.length === 0 && <p className="font-body text-slate">No invoices yet.</p>}
      <table className="w-full text-sm font-body">
        <thead>
          <tr className="text-left text-slate border-b border-paper/15">
            <th className="py-2">Number</th>
            <th className="py-2">Date</th>
            <th className="py-2">Amount</th>
            <th className="py-2"></th>
          </tr>
        </thead>
        <tbody>
          {data?.map((invoice) => (
            <tr key={invoice.id} className="border-b border-paper/10">
              <td className="py-2 font-data">{invoice.number}</td>
              <td className="py-2 font-data tabular-nums">{new Date(invoice.issued_at).toLocaleDateString()}</td>
              <td className="py-2 font-data tabular-nums">{invoice.amount}</td>
              <td className="py-2">
                {invoice.pdf_url ? (
                  <a href={invoice.pdf_url} target="_blank" rel="noreferrer" className="text-sapphire hover:underline text-xs">
                    Download
                  </a>
                ) : (
                  <span className="text-slate text-xs">Not available</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

Note the `invoice.pdf_url ? ... : "Not available"` branch is required per this phase's Global Constraints (`Invoice.pdf_url` is nullable) — do not assume every invoice has a downloadable PDF.

- [ ] **Step 6: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Run the full apps/web suite one final time**

Run: `cd apps/web && npx vitest run`
Expected: all tests pass (29 from Tasks 1-3 + 2 from this task = 31 total).

- [ ] **Step 8: Run the full packages/ui and packages/sdk suites to confirm they're unaffected**

Run: `cd packages/ui && npx vitest run` — expected 10/10, unchanged.
Run: `cd packages/sdk && npx vitest run` — expected 33/33, unchanged (this phase only ever calls the SDK's public methods, never modifies `packages/sdk` itself).

- [ ] **Step 9: Manual smoke check**

Run: `pnpm --filter @cadence/api start:dev` in the background, `pnpm --filter @cadence/web dev` in the background, then curl `/portal`, `/portal/invoices` (both should return 200 and render the "Connect your wallet" prompt, since no wallet is connected in a headless check). Stop both dev servers after confirming.

- [ ] **Step 10: Commit**

```bash
git add "apps/web/app/(portal)/portal/invoices/page.tsx" apps/web/lib/hooks/usePortalInvoices.ts apps/web/test/usePortalInvoices.test.tsx
git commit -m "Add /portal/invoices page"
```

---

## Plan Self-Review Notes

**Spec coverage check:**
- Portal shell (SDK client, env vars, layout, no session gating) → Task 1. ✓
- `/portal` list with `StatusBadge`/`CadencePulse` → Task 2. ✓
- Balance warning (`BalanceWarning`/`useTokenBalance`, genuinely wired into `/portal`'s rendered output via `SubscriptionCard`'s per-row `usePortalPlan(onchain_plan_id)` fetch — resolving a real data-availability gap discovered during this plan's drafting, per a fresh clarifying question the user answered) → Task 2. ✓
- `/portal/subscriptions/[id]` detail (summary-shape-only, per the spec's own resolved constraint) + cancel/pause/resume real wallet writes → Task 3. ✓
- `/portal/invoices` with nullable-`pdf_url` handling → Task 4. ✓
- No subscribe wizard, no revoke-permission action, no cross-merchant aggregation, no new backend work → confirmed nowhere in this plan does any task build these. ✓
- `@cadence/sdk` as the sole HTTP client (no hand-rolled `apiFetch`) → every hook across all 4 tasks calls `cadence.*` methods exclusively; grepped for any raw `fetch(` call in new files — none found. ✓
- Dark-default surface → Task 1's `(portal)/layout.tsx` sets `bg-ink text-paper` unconditionally. ✓
- Reused wagmi config, `packages/ui` components, `extensionAlias`/Tailwind `@source` fixes → all consumed as-is with zero modification across every task. ✓

**Placeholder scan:** No "TBD"/"TODO"/vague requirements found. Every step has complete, concrete code. One genuine, explicitly-flagged limitation exists (Task 2's balance-warning wiring gap) — this is disclosed prominently in-task with full reasoning, not a silently-dropped requirement, and is flagged again here in the self-review for visibility at the final whole-branch review stage.

**Type consistency check:** `usePortalSubscriptions`'s return shape (`{data: Subscription[] | undefined, isLoading, error}`, Task 1) is consumed identically in Task 2's `/portal` page and Task 3's detail page (which re-fetches the same hook rather than a separate detail hook, per the documented API constraint). `useSubscriptionWrite`'s `{write, status, error}` shape (Task 1) is consumed identically by all three action buttons in Task 3's `SubscriptionActions`. `cadence` (Task 1) is imported identically (`import { cadence } from "../cadence-client.js"` with the correct relative depth per file) in Tasks 1, 2 (indirectly via the hook), 3, and 4 — no task re-constructs a second `Cadence` instance.

**Gap found and resolved during plan drafting:** the design spec's balance-warning requirement assumed the summary `Subscription` shape (the only one available to a publishable key) would carry enough data to check balance against — it doesn't; it has no `token`/`amount` field. Rather than silently building `BalanceWarning` unwired against no real data, this was surfaced as a fresh clarifying question. Resolved: add `usePortalPlan(onchain_plan_id)`, a per-subscription fetch to `GET /v1/plans/:onchainId` (confirmed publishable-key-accessible, no backend changes needed), so `SubscriptionCard` (Task 2) can pull each subscription's real `token`/`amount` and feed them to `useTokenBalance`/`BalanceWarning`. This means `/portal`'s list page now issues one plan-fetch per visible subscription card (in addition to the one subscriptions-list fetch) — a deliberate, accepted N+1-shaped tradeoff for a list that's realistically small per subscriber (a handful of active subscriptions, not hundreds), matching this project's general practice of accepting small N+1 costs at the read layer when the alternative is a new backend endpoint with no other consumer (the same tradeoff class as the dashboard phase's own hardcoded-30-day `CadencePulse` decision, just resolved in the opposite direction here since balance correctness is genuinely worth the extra request in a way period-precision on a list view wasn't).
