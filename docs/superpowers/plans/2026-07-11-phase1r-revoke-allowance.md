# Phase 1r: Allowance Fix + Revoke Spending Permission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `/v1/prepare/subscribe`'s permit sizing (one period → twelve, so recurring billing actually recurs) and add a "Revoke spending permission" action to the portal's subscription detail page.

**Architecture:** A one-line backend change scales the EIP-2612 permit's `value`. A new `useRevokeAllowance` hook, following `useSubscriptionWrite.ts`'s established state-machine shape, targets the plan's ERC-20 token contract (not `SubscriptionManager`) with a new `approve` ABI entry. The subscription detail page — which currently has no plan/token data at all — gains a `usePortalPlan` call to fetch it, threading the token address into `SubscriptionActions` as a new prop.

**Tech Stack:** NestJS/viem (existing, `apps/api`), wagmi 2.19/viem 2.21 (existing, `apps/web`), Vitest + Testing Library (existing).

## Global Constraints

- The permit's `value` changes from `plan.amount` (one period) to `plan.amount * 12` (twelve periods) — a fixed constant, not merchant-configurable in this phase.
- Revoke is a plain ERC-20 `approve(SUBSCRIPTION_MANAGER_ADDRESS, 0n)` call against the plan's token contract — never a `SubscriptionManager` function call.
- Revoke does NOT call `cancel()` — the subscription lapses into `past_due` naturally via the existing `ChargeFailed(reason=2)` path on its next billing attempt. No new coupling between revoke and cancellation logic anywhere in this phase.
- No changes to `packages/contracts` — this phase is entirely off-chain (API response shape) and frontend (new hook/UI).
- No live wallet/RPC calls in any test — matches every prior on-chain-write phase's established practice.

---

### Task 1: Allowance sizing fix (`apps/api`)

**Files:**
- Modify: `apps/api/src/prepare/prepare.service.ts`
- Modify: `apps/api/test/prepare.e2e-spec.ts`

**Interfaces:**
- Produces: `GET /v1/prepare/subscribe`'s `permit.message.value` now equals `plan.amount * 12` (as a decimal string), not `plan.amount`. No other field in the response shape changes.

- [ ] **Step 1: Write the failing test**

Modify `apps/api/test/prepare.e2e-spec.ts` — find the existing test `"returns permit typed-data and a subscribe template for a plan the caller's key owns"` (asserts `permit.message` with `value: "5000000"`, since the seeded plan's `amount` is `"5000000"`). Replace its assertion block:

```typescript
    expect(response.body.permit.message).toEqual({
      owner: subscriberOwner,
      spender: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
      value: "5000000",
      nonce: "7",
      deadline: response.body.permit.message.deadline,
    });
```

with:

```typescript
    expect(response.body.permit.message).toEqual({
      owner: subscriberOwner,
      spender: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
      value: "60000000", // 5000000 * 12 periods
      nonce: "7",
      deadline: response.body.permit.message.deadline,
    });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run --config vitest.e2e.config.ts test/prepare.e2e-spec.ts`
Expected: FAIL — the test asserting `value: "60000000"` fails because the current code still returns `"5000000"`.

- [ ] **Step 3: Implement the fix**

Modify `apps/api/src/prepare/prepare.service.ts` — read the current file first, then add a constant near the top (after the existing `PERMIT_DEADLINE_SECONDS` constant) and change the `value` field in `buildSubscribePermit`'s return:

```typescript
const PERMIT_DEADLINE_SECONDS = 15 * 60;
// SubscriptionManager._charge() draws down a standing ERC-20 allowance every
// billing period (no fresh permit per charge) — a permit sized to exactly one
// period's amount means every subscription self-terminates into past_due
// after its first charge. 12 periods gives a full year of unattended
// auto-renewal for monthly plans while bounding the subscriber's real
// exposure to an auditable, fixed number rather than an unlimited allowance.
const PERMIT_PERIODS_ALLOWANCE = 12;
```

Then change the `message.value` line inside `buildSubscribePermit`'s return statement from:

```typescript
          value: plan.amount,
```

to:

```typescript
          value: (BigInt(plan.amount) * BigInt(PERMIT_PERIODS_ALLOWANCE)).toString(),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run --config vitest.e2e.config.ts test/prepare.e2e-spec.ts`
Expected: PASS (all 7 tests in this file, including the modified one).

- [ ] **Step 5: Typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Run the full apps/api e2e suite to confirm no cross-suite regression**

Run: `cd apps/api && npx vitest run --config vitest.e2e.config.ts`
Expected: all 14 files pass together (this codebase has a documented history of a bug that only manifested when the full suite ran together, so this check matters).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/prepare/prepare.service.ts apps/api/test/prepare.e2e-spec.ts
git commit -m "Size subscribe permits to 12 periods instead of 1"
```

---

### Task 2: `approve` ABI entry in `packages/shared`

**Files:**
- Modify: `packages/shared/abis/Erc20Permit.ts`
- Modify: `packages/shared/test/erc20-permit-abi.test.ts`

**Interfaces:**
- Produces: `erc20PermitAbi` (already exported from both `@cadence/shared` and `@cadence/shared/abis` — this task only adds a new entry to the existing array, no new export/barrel change needed) now also includes a standard ERC-20 `approve` function fragment. Consumed by Task 3's hook.

- [ ] **Step 1: Write the failing test**

Modify `packages/shared/test/erc20-permit-abi.test.ts` — read the current file first, then add a new test inside the existing `describe("erc20PermitAbi", ...)` block:

```typescript
  it("includes a standard ERC-20 approve function fragment", () => {
    const approveFn = erc20PermitAbi.find((entry) => entry.type === "function" && entry.name === "approve");
    expect(approveFn).toBeDefined();
    // @ts-expect-error -- narrowed by the find() above at runtime
    expect(approveFn.inputs).toEqual([
      { name: "spender", type: "address", internalType: "address" },
      { name: "amount", type: "uint256", internalType: "uint256" },
    ]);
    // @ts-expect-error -- narrowed by the find() above at runtime
    expect(approveFn.outputs).toEqual([{ name: "", type: "bool", internalType: "bool" }]);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/shared && npx vitest run test/erc20-permit-abi.test.ts`
Expected: FAIL — `approveFn` is `undefined`.

- [ ] **Step 3: Add the ABI entry**

Modify `packages/shared/abis/Erc20Permit.ts` — read the current file first, then add a new entry to the `erc20PermitAbi` array (after the existing `permit` entry, before the closing `] as const;`):

```typescript
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address", internalType: "address" },
      { name: "amount", type: "uint256", internalType: "uint256" },
    ],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
    stateMutability: "nonpayable",
  },
```

Also update the file's header comment (currently states the ABI is "minimal ... only the functions this codebase's /v1/prepare/subscribe endpoint needs") to reflect the expanded scope — replace the first sentence:

```typescript
// Minimal EIP-2612 permit ABI fragment — only the functions this codebase's
// /v1/prepare/subscribe endpoint needs to read (name, nonces) or reference
// (permit, for calldata shape parity with SubscriptionManager's own ABI
// style). `version()` (EIP-5267) is deliberately NOT included here — not
// every ERC-20 exposes it uniformly, so PrepareService reads it via a raw
// eth_call with a one-off inline ABI fragment and falls back to "1" on
// revert, rather than depending on a function that might not exist.
```

with:

```typescript
// Minimal ERC-20/EIP-2612 ABI fragment covering exactly what this codebase
// needs: /v1/prepare/subscribe reads (name, nonces) or references (permit,
// for calldata shape parity with SubscriptionManager's own ABI style);
// apps/web's useRevokeAllowance hook calls the standard ERC-20 `approve`
// directly against a subscriber's own wallet to zero out a standing
// allowance (Phase 1r). `version()` (EIP-5267) is deliberately NOT included
// here — not every ERC-20 exposes it uniformly, so PrepareService reads it
// via a raw eth_call with a one-off inline ABI fragment and falls back to
// "1" on revert, rather than depending on a function that might not exist.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/shared && npx vitest run test/erc20-permit-abi.test.ts`
Expected: PASS (3/3 tests).

- [ ] **Step 5: Typecheck**

Run: `cd packages/shared && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Run the full packages/shared suite to confirm no regression**

Run: `cd packages/shared && npx vitest run`
Expected: all pre-existing tests pass, plus this task's 1 new one.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/abis/Erc20Permit.ts packages/shared/test/erc20-permit-abi.test.ts
git commit -m "Add approve function to erc20PermitAbi"
```

---

### Task 3: `useRevokeAllowance` hook

**Files:**
- Create: `apps/web/lib/hooks/useRevokeAllowance.ts`
- Test: `apps/web/test/useRevokeAllowance.test.tsx`

**Interfaces:**
- Consumes: `erc20PermitAbi` (Task 2, from `@cadence/shared/abis`).
- Produces:
  ```typescript
  export type RevokeStatus = "idle" | "confirming" | "pending" | "processing" | "done" | "error";

  export interface UseRevokeAllowanceResult {
    write: (tokenAddress: string) => void;
    status: RevokeStatus;
    error: Error | null;
  }

  export function useRevokeAllowance(): UseRevokeAllowanceResult;
  ```
  Consumed by Task 4's `SubscriptionActions` component.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/useRevokeAllowance.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";

const mockWriteContract = vi.fn();
const mockUseWriteContract = vi.fn();
const mockUseWaitForTransactionReceipt = vi.fn();

vi.mock("wagmi", () => ({
  useWriteContract: () => mockUseWriteContract(),
  useWaitForTransactionReceipt: (args: unknown) => mockUseWaitForTransactionReceipt(args),
}));

const SUBSCRIPTION_MANAGER_ADDRESS = "0x0000000000000000000000000000000000000000";
const TOKEN_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

describe("useRevokeAllowance", () => {
  beforeEach(() => {
    mockWriteContract.mockReset();
    mockUseWriteContract.mockReturnValue({ writeContract: mockWriteContract, data: undefined, error: null, isPending: false });
    mockUseWaitForTransactionReceipt.mockReturnValue({ isLoading: false, isSuccess: false, error: null });
  });

  afterEach(() => {
    cleanup();
  });

  it("calls writeContract with approve(spender, 0) against the given token address", async () => {
    const { useRevokeAllowance } = await import("../lib/hooks/useRevokeAllowance.js");
    const { result } = renderHook(() => useRevokeAllowance());

    act(() => {
      result.current.write(TOKEN_ADDRESS);
    });

    expect(mockWriteContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: TOKEN_ADDRESS,
        functionName: "approve",
        args: [SUBSCRIPTION_MANAGER_ADDRESS, 0n],
      }),
    );
  });

  it("transitions through confirming to done on success", async () => {
    mockUseWriteContract.mockReturnValue({ writeContract: mockWriteContract, data: "0xTxHash", error: null, isPending: false });
    mockUseWaitForTransactionReceipt.mockReturnValue({ isLoading: false, isSuccess: true, error: null });
    const { useRevokeAllowance } = await import("../lib/hooks/useRevokeAllowance.js");
    const { result } = renderHook(() => useRevokeAllowance());

    act(() => {
      result.current.write(TOKEN_ADDRESS);
    });

    await waitFor(() => expect(result.current.status).toBe("processing"));
  });

  it("sets status to error when the write fails", async () => {
    mockUseWriteContract.mockReturnValue({ writeContract: mockWriteContract, data: undefined, error: new Error("user rejected"), isPending: false });
    const { useRevokeAllowance } = await import("../lib/hooks/useRevokeAllowance.js");
    const { result } = renderHook(() => useRevokeAllowance());

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error?.message).toBe("user rejected");
  });
});
```

Note: `SUBSCRIPTION_MANAGER_ADDRESS` in this test file is the same zero-address fallback `useSubscriptionWrite.ts` uses when `NEXT_PUBLIC_SUBSCRIPTION_MANAGER_ADDRESS` isn't set — matching the environment this test runs in (no env var set during `vitest run`).

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run test/useRevokeAllowance.test.tsx`
Expected: FAIL — `../lib/hooks/useRevokeAllowance.js` does not exist.

- [ ] **Step 3: Implement `useRevokeAllowance`**

Create `apps/web/lib/hooks/useRevokeAllowance.ts`:

```typescript
import { useEffect, useState } from "react";
import { useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { erc20PermitAbi } from "@cadence/shared/abis";

export type RevokeStatus = "idle" | "confirming" | "pending" | "processing" | "done" | "error";

export interface UseRevokeAllowanceResult {
  write: (tokenAddress: string) => void;
  status: RevokeStatus;
  error: Error | null;
}

const SUBSCRIPTION_MANAGER_ADDRESS = (process.env.NEXT_PUBLIC_SUBSCRIPTION_MANAGER_ADDRESS ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;

export function useRevokeAllowance(): UseRevokeAllowanceResult {
  const [status, setStatus] = useState<RevokeStatus>("idle");
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

  function write(tokenAddress: string) {
    setStatus("confirming");
    writeContract({
      address: tokenAddress as `0x${string}`,
      abi: erc20PermitAbi,
      functionName: "approve",
      args: [SUBSCRIPTION_MANAGER_ADDRESS, 0n],
    });
  }

  return { write, status, error: writeError ?? receiptError ?? null };
}
```

This mirrors `useSubscriptionWrite.ts`'s exact state-machine shape (same effect wiring, same `processing → done` timeout pattern) but targets a caller-supplied `tokenAddress` instead of the fixed `SUBSCRIPTION_MANAGER_ADDRESS`, and calls `approve` with a fixed zero-value args tuple instead of a polymorphic `functionName`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run test/useRevokeAllowance.test.tsx`
Expected: PASS (3/3 tests).

- [ ] **Step 5: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Run the full apps/web suite to confirm no regression**

Run: `cd apps/web && npx vitest run`
Expected: all pre-existing tests pass (21 files/61 tests, per Phase 1q's final state), plus this task's 3 new ones.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/hooks/useRevokeAllowance.ts apps/web/test/useRevokeAllowance.test.tsx
git commit -m "Add useRevokeAllowance hook"
```

---

### Task 4: `SubscriptionActions` UI + detail page wiring

**Files:**
- Modify: `apps/web/components/SubscriptionActions.tsx`
- Modify: `apps/web/test/SubscriptionActions.test.tsx`
- Modify: `apps/web/app/(portal)/portal/subscriptions/[id]/page.tsx`

**Interfaces:**
- Consumes: `useRevokeAllowance`/`RevokeStatus` (Task 3, from `../lib/hooks/useRevokeAllowance.js`); `usePortalPlan` (existing, from `../../../../../lib/hooks/usePortalPlan.js` — already used by `SubscriptionCard.tsx` for the identical `token`-fetching need, just not yet wired into this specific page).
- Produces: the complete revoke UI. This is the FINAL task of this phase.

The subscription detail page (`portal/subscriptions/[id]/page.tsx`) currently has NO plan/token data at all — it only fetches the subscription list via `usePortalSubscriptions` and finds the matching row, which has no `token` field. This task adds a `usePortalPlan` call to the page (mirroring exactly how `SubscriptionCard.tsx` already does it for the same underlying need) and threads the resulting `token` address into `SubscriptionActions` as a new required prop.

- [ ] **Step 1: Write the failing test**

Modify `apps/web/test/SubscriptionActions.test.tsx` — read the current file first, then add `token="0x036CbD53842c5426634e7929541eC2318f3dCF7e"` to every existing `render(<SubscriptionActions .../>)` call (all 6 call sites in the file — the component's prop signature is about to require it), and add a new mock plus new tests. First, add the mock alongside the existing `mockUseSubscriptionWrite` mock at the top of the file:

```typescript
const mockUseRevokeAllowance = vi.fn();

vi.mock("../lib/hooks/useRevokeAllowance.js", () => ({
  useRevokeAllowance: () => mockUseRevokeAllowance(),
}));
```

Add a `beforeEach` reset for it (extend the existing `beforeEach` block):

```typescript
  beforeEach(() => {
    mockUseSubscriptionWrite.mockReset();
    mockUseSubscriptionWrite.mockReturnValue({ write: vi.fn(), status: "idle", error: null });
    mockUseRevokeAllowance.mockReset();
    mockUseRevokeAllowance.mockReturnValue({ write: vi.fn(), status: "idle", error: null });
  });
```

Add these new tests at the end of the `describe` block, before the closing `});`:

```tsx
  it("shows a Revoke spending permission button", () => {
    render(<SubscriptionActions subId="1" status="active" token="0x036CbD53842c5426634e7929541eC2318f3dCF7e" />);
    expect(screen.getByRole("button", { name: /revoke spending permission/i })).toBeDefined();
  });

  it("calls revoke's write with the token address when clicked", () => {
    const write = vi.fn();
    mockUseRevokeAllowance.mockReturnValue({ write, status: "idle", error: null });

    render(<SubscriptionActions subId="1" status="active" token="0x036CbD53842c5426634e7929541eC2318f3dCF7e" />);
    fireEvent.click(screen.getByRole("button", { name: /revoke spending permission/i }));

    expect(write).toHaveBeenCalledWith("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
  });

  it("shows clarifying copy that revoke does not cancel the subscription", () => {
    render(<SubscriptionActions subId="1" status="active" token="0x036CbD53842c5426634e7929541eC2318f3dCF7e" />);
    expect(screen.getByText(/subscription itself is not canceled/i)).toBeDefined();
  });

  it("disables the revoke button while any write (including revoke) is in flight", () => {
    mockUseRevokeAllowance.mockReturnValue({ write: vi.fn(), status: "confirming", error: null });

    render(<SubscriptionActions subId="1" status="active" token="0x036CbD53842c5426634e7929541eC2318f3dCF7e" />);
    expect(screen.getByRole("button", { name: /revoke spending permission/i })).toHaveProperty("disabled", true);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run test/SubscriptionActions.test.tsx`
Expected: FAIL — `token` prop doesn't exist yet on `SubscriptionActionsProps`, and no Revoke button is rendered.

- [ ] **Step 3: Add the Revoke button to `SubscriptionActions`**

Modify `apps/web/components/SubscriptionActions.tsx` — replace the full file:

```tsx
"use client";

import { useSubscriptionWrite } from "../lib/hooks/useSubscriptionWrite.js";
import { useRevokeAllowance } from "../lib/hooks/useRevokeAllowance.js";

export interface SubscriptionActionsProps {
  subId: string;
  status: string;
  token: string;
}

const STATUS_MESSAGE: Record<string, string> = {
  confirming: "Confirm in your wallet…",
  pending: "Transaction submitted, waiting for confirmation…",
  processing: "Confirmed — updating…",
  error: "Something went wrong. Please try again.",
};

export function SubscriptionActions({ subId, status, token }: SubscriptionActionsProps) {
  const cancelWrite = useSubscriptionWrite("cancel");
  const pauseWrite = useSubscriptionWrite("pauseSubscription");
  const resumeWrite = useSubscriptionWrite("resumeSubscription");
  const revokeWrite = useRevokeAllowance();

  const anyInFlight = [cancelWrite.status, pauseWrite.status, resumeWrite.status, revokeWrite.status].some(
    (s) => s === "confirming" || s === "pending",
  );
  const activeStatus = [cancelWrite.status, pauseWrite.status, resumeWrite.status, revokeWrite.status].find(
    (s) => s !== "idle" && s !== "done",
  );

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
      <div className="flex flex-col gap-1 mt-2 pt-2 border-t border-paper/10">
        <button
          onClick={() => revokeWrite.write(token)}
          disabled={anyInFlight}
          className="self-start rounded-md border border-paper/30 px-3 py-1.5 text-sm font-body disabled:opacity-50"
        >
          Revoke spending permission
        </button>
        <p className="font-body text-xs text-slate">
          This stops future automatic charges by revoking your token spending approval. Your subscription itself is not canceled.
        </p>
      </div>
      {activeStatus && STATUS_MESSAGE[activeStatus] && <p className="font-body text-xs text-slate">{STATUS_MESSAGE[activeStatus]}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run test/SubscriptionActions.test.tsx`
Expected: PASS (all tests in this file — 6 pre-existing plus 4 new = 10).

- [ ] **Step 5: Wire the plan/token fetch into the detail page**

Modify `apps/web/app/(portal)/portal/subscriptions/[id]/page.tsx` — replace the full file:

```tsx
"use client";

import { useParams } from "next/navigation";
import { useAccount } from "wagmi";
import { usePortalSubscriptions } from "../../../../../lib/hooks/usePortalSubscriptions.js";
import { usePortalPlan } from "../../../../../lib/hooks/usePortalPlan.js";
import { SubscriptionActions } from "../../../../../components/SubscriptionActions.js";
import { StatusBadge } from "@cadence/ui";

export default function PortalSubscriptionDetailPage() {
  const params = useParams<{ id: string }>();
  const { address } = useAccount();
  const { data, isLoading, error } = usePortalSubscriptions(address);

  const subscription = data?.find((sub) => sub.onchain_sub_id === params.id);
  const { data: plan } = usePortalPlan(subscription?.onchain_plan_id);

  if (isLoading) return <p className="font-body text-slate">Loading…</p>;
  if (error) return <p className="font-body text-signal">Could not load subscription.</p>;
  if (!subscription) return <p className="font-body text-signal">Subscription not found.</p>;

  return (
    <div>
      <h1 className="font-display text-2xl mb-2">Subscription #{subscription.onchain_sub_id}</h1>
      <div className="flex items-center gap-3 mb-4">
        <StatusBadge status={subscription.status} />
        <span className="font-data text-sm text-slate">{subscription.subscriber}</span>
      </div>
      {plan && <SubscriptionActions subId={subscription.onchain_sub_id} status={subscription.status} token={plan.token} />}
    </div>
  );
}
```

Note: `usePortalPlan(subscription?.onchain_plan_id)` is called unconditionally (React's Rules of Hooks — hooks can't be called after an early `return`), and `usePortalPlan` itself already handles an `undefined` ID via its existing `enabled: onchainPlanId !== undefined` guard (no new fetch happens until `subscription` resolves). `SubscriptionActions` only renders once `plan` has loaded, since it now requires the `token` prop — this means there's a brief window where the subscription header renders but the action buttons haven't appeared yet, which is an acceptable, minor UX tradeoff for this phase (no loading spinner is added specifically for this gap, matching this codebase's established practice of not over-building loading states beyond what a task's own scope requires).

- [ ] **Step 6: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Run the full apps/web suite one final time**

Run: `cd apps/web && npx vitest run`
Expected: all tests pass — final total 21 files / 68 tests (61 from Phase 1q's baseline + 3 from Task 3 + 4 from Task 4's new `SubscriptionActions` tests). No new test file for the page itself, matching this project's established practice of not unit-testing static page composition/data-threading (see every prior phase's detail/list page precedent).

- [ ] **Step 8: Manual smoke check**

Run: `cd apps/web && rm -rf .next && pnpm dev` in the background — first confirm port 3001 is genuinely free via BOTH `lsof -i:3001` and `ss -tlnp | grep 3001`. Once booted, curl `/portal/subscriptions/1` (any numeric ID is fine — the real subscription lookup happens client-side, so a nonexistent ID still exercises the route's compile/serve path) and confirm HTTP 200. Since this is a `"use client"` component with client-side data fetching, the raw SSR body will show a loading/wallet-connect state, not the actual subscription content — that's expected, matching every prior portal-page smoke check in this project's history; a 200 status is the correct verification signal. Stop the dev server cleanly afterward and confirm the port is released via both tools.

- [ ] **Step 9: Commit**

```bash
git add apps/web/components/SubscriptionActions.tsx apps/web/test/SubscriptionActions.test.tsx "apps/web/app/(portal)/portal/subscriptions/[id]/page.tsx"
git commit -m "Add revoke spending permission action to subscription detail page"
```

---

## Plan Self-Review Notes

**Spec coverage check:**
- Allowance sizing fix (`plan.amount` → `plan.amount * 12`) → Task 1. ✓
- `approve` ABI entry, distinct from EIP-2612-specific entries, documented scope expansion → Task 2. ✓
- `useRevokeAllowance` targeting the token contract (not `SubscriptionManager`), calling `approve(spender, 0)` → Task 3. ✓
- UI on the existing `/portal/subscriptions/[id]` page (no new route), needing the plan's `token` fetched the same way `SubscriptionCard.tsx` already does → Task 4. ✓
- Revoke decoupled from cancel — confirmed no task calls `cancel()` from the revoke path; `useRevokeAllowance` only ever calls `approve`. ✓
- Confirmation copy clarifying revoke ≠ cancel → Task 4 Step 3's exact copy, tested in Task 4 Step 1. ✓
- No `packages/contracts` changes anywhere — confirmed absent from every task. ✓

**Placeholder scan:** No "TBD"/"TODO"/vague requirements. Every step has complete, concrete code. One deliberately-flagged design note exists in Task 4 Step 5 (the brief window where `SubscriptionActions` doesn't render until `plan` loads) — an explicit, actionable acknowledgment of a real but minor UX gap, not a placeholder.

**Type consistency check:** `RevokeStatus`/`UseRevokeAllowanceResult` (Task 3) are consumed identically by Task 4's `SubscriptionActions` (`revokeWrite.status`, `revokeWrite.write(token)`, `revokeWrite.error` — all matching the hook's actual return shape). `SubscriptionActionsProps`'s new `token: string` field (Task 4) matches exactly how Task 4's own page-wiring step passes `plan.token` (the `Plan` interface's existing `token: string` field, confirmed against `usePlans.ts`'s established `Plan` interface shape used elsewhere in this codebase). `erc20PermitAbi`'s new `approve` entry (Task 2) matches exactly how Task 3's hook calls `functionName: "approve"` with `args: [spender, amount]` — same parameter order and types.

**Gap found and fixed during self-review:** an initial pass assumed `SubscriptionActions` could simply receive a `token` prop without checking whether its current sole caller (`portal/subscriptions/[id]/page.tsx`) actually has that data available. Reading the actual page revealed it does not — it only fetches the subscription list via `usePortalSubscriptions`, which has no `token` field on its `Subscription` rows. Fixed by adding Task 4 Step 5's `usePortalPlan` wiring explicitly, following the exact precedent `SubscriptionCard.tsx` already established for the identical need (fetching a plan by ID to get its `token` for a different downstream hook) — this is not a new pattern invented for this phase, but reuse of an existing, already-proven one.
