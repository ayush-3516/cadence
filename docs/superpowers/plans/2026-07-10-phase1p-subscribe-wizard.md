# Phase 1p: Portal Subscribe Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/portal/subscribe/[planId]`, a single-screen wizard that previews a plan before wallet connect, signs an EIP-2612 permit (no gas), and submits the resulting `subscribeWithPermit` transaction.

**Architecture:** A new state-machine hook, `useSubscribeSubmit`, follows `useCreatePlanSubmit.ts`'s established shape but adds a genuinely new first step — a pure `useSignTypedData` signature, no transaction — before its `useSendTransaction`/`useWaitForTransactionReceipt` tail. The wizard page composes the already-existing `usePortalPlan` hook (fetches by `planId` alone, no wallet needed) with `useSubscribeSubmit`, deferring the wallet-connect prompt until the "Subscribe" button is clicked.

**Tech Stack:** Next.js 15/React 18 client components, wagmi 2.19/viem 2.21 (existing — this phase's only new wagmi hook usage is `useSignTypedData`, no new dependency), `@cadence/sdk` (existing, via `apps/web/lib/cadence-client.ts`), Vitest + Testing Library.

## Global Constraints

- No backend changes — `GET /v1/prepare/subscribe` already accepts publishable-key auth and needs no modification.
- No new npm dependency — `useSignTypedData` and `parseSignature` are already available in the installed `wagmi`/`viem` versions.
- Plan details (`usePortalPlan(planId)`) render before wallet connect; the connect prompt appears only when "Subscribe" is clicked, deferring auth to the point it's actually needed — a deliberate, scoped exception to the portal's existing gate-the-whole-page pattern, confirmed with the user during brainstorming.
- No new shared `PortalConnectGate` component — the connect-timing logic lives inline in this phase's one new page.
- No new `/portal/subscriptions/[id]`-adjacent route — on success, redirect to the existing `/portal` list.
- Retry on error always restarts from the `preparing` state (re-fetches a fresh permit with a new 15-minute deadline and nonce), never resumes from a partially-completed step — a stale signature from an earlier attempt could have expired by the time a later retry runs.
- The wizard page gets a real component test (unlike Phase 1o's static-composition pages) because it has genuine conditional logic: plan preview before connect, gated Subscribe button after.

---

### Task 1: `useSubscribeSubmit` hook

**Files:**
- Create: `apps/web/lib/hooks/useSubscribeSubmit.ts`
- Test: `apps/web/test/useSubscribeSubmit.test.tsx`

**Interfaces:**
- Produces:
  ```typescript
  export type SubscribeStatus =
    | "idle"
    | "preparing"
    | "signing"
    | "submitting"
    | "confirming"
    | "done"
    | "error";

  export interface UseSubscribeSubmitResult {
    status: SubscribeStatus;
    error: Error | null;
    submit: (planId: string, owner: string) => void;
  }

  export function useSubscribeSubmit(): UseSubscribeSubmitResult;
  ```
  Consumed by Task 2's wizard page.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/useSubscribeSubmit.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import { decodeFunctionData } from "viem";
import { subscriptionManagerAbi } from "@cadence/shared";

const mockSignTypedDataAsync = vi.fn();
const mockSendTransaction = vi.fn();
const mockUseSignTypedData = vi.fn();
const mockUseSendTransaction = vi.fn();
const mockUseWaitForTransactionReceipt = vi.fn();

vi.mock("wagmi", () => ({
  useSignTypedData: () => mockUseSignTypedData(),
  useSendTransaction: () => mockUseSendTransaction(),
  useWaitForTransactionReceipt: (args: unknown) => mockUseWaitForTransactionReceipt(args),
}));

vi.mock("../lib/apiFetch.js", () => ({
  apiFetch: vi.fn().mockResolvedValue({
    permit: {
      domain: { name: "Test USD Coin", version: "2", chainId: 84532, verifyingContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
      types: {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      message: {
        owner: "0x999900000000000000000000000000000000000f",
        spender: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
        value: "20000000",
        nonce: "7",
        deadline: "1234567890",
      },
    },
    subscribe: { to: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9", fn: "subscribeWithPermit", planId: "1", deadline: "1234567890" },
  }),
}));

// A real, valid secp256k1 signature (65 bytes hex) with v=27 (yParityOrV byte 0x1b),
// used so viem's parseSignature can genuinely parse it rather than needing a mock.
const FAKE_SIGNATURE =
  "0x6e100a352ec6ad1b70802290e18aeed190704973570f3b8ed42cb9808e2ea6bf4a90a229a244495b41890987806fcbd2d5d23fc0dbe5f5256c2613c039d76db81b";

describe("useSubscribeSubmit", () => {
  beforeEach(async () => {
    mockSignTypedDataAsync.mockReset();
    mockSignTypedDataAsync.mockResolvedValue(FAKE_SIGNATURE);
    mockSendTransaction.mockReset();
    const { apiFetch } = await import("../lib/apiFetch.js");
    (apiFetch as ReturnType<typeof vi.fn>).mockClear();
    mockUseSignTypedData.mockReturnValue({ signTypedDataAsync: mockSignTypedDataAsync });
    mockUseSendTransaction.mockReturnValue({ sendTransaction: mockSendTransaction, data: undefined, error: null, isPending: false });
    mockUseWaitForTransactionReceipt.mockReturnValue({ isLoading: false, isSuccess: false, error: null });
  });

  afterEach(() => {
    cleanup();
  });

  it("prepares, signs, and submits subscribeWithPermit calldata that decodes back to the expected args", async () => {
    const { useSubscribeSubmit } = await import("../lib/hooks/useSubscribeSubmit.js");
    const { result } = renderHook(() => useSubscribeSubmit());

    act(() => {
      result.current.submit("1", "0x999900000000000000000000000000000000000f");
    });

    await waitFor(() => expect(mockSendTransaction).toHaveBeenCalled());

    const [sentTx] = mockSendTransaction.mock.calls[0];
    expect(sentTx.to).toBe("0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9");

    const decoded = decodeFunctionData({ abi: subscriptionManagerAbi, data: sentTx.data });
    expect(decoded.functionName).toBe("subscribeWithPermit");
    expect(decoded.args[0]).toBe(1n); // planId
    expect(decoded.args[1]).toBe(20000000n); // value
    expect(decoded.args[2]).toBe(1234567890n); // deadline
    expect(typeof decoded.args[3]).toBe("number"); // v, uint8
    expect(decoded.args[3]).toBe(27);
  });

  it("calls signTypedDataAsync with exactly the permit domain/types/message from the prepare response", async () => {
    const { useSubscribeSubmit } = await import("../lib/hooks/useSubscribeSubmit.js");
    const { result } = renderHook(() => useSubscribeSubmit());

    act(() => {
      result.current.submit("1", "0x999900000000000000000000000000000000000f");
    });

    await waitFor(() =>
      expect(mockSignTypedDataAsync).toHaveBeenCalledWith({
        domain: { name: "Test USD Coin", version: "2", chainId: 84532, verifyingContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
        types: {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        primaryType: "Permit",
        message: {
          owner: "0x999900000000000000000000000000000000000f",
          spender: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
          value: "20000000",
          nonce: "7",
          deadline: "1234567890",
        },
      }),
    );
  });

  it("sets status to error and does not sign or submit when the prepare call fails", async () => {
    const { apiFetch } = await import("../lib/apiFetch.js");
    (apiFetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("plan not found"));
    const { useSubscribeSubmit } = await import("../lib/hooks/useSubscribeSubmit.js");
    const { result } = renderHook(() => useSubscribeSubmit());

    act(() => {
      result.current.submit("999", "0x999900000000000000000000000000000000000f");
    });

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error?.message).toBe("plan not found");
    expect(mockSignTypedDataAsync).not.toHaveBeenCalled();
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it("sets status to error and does not submit when signing fails", async () => {
    mockSignTypedDataAsync.mockRejectedValue(new Error("user rejected signature"));
    const { useSubscribeSubmit } = await import("../lib/hooks/useSubscribeSubmit.js");
    const { result } = renderHook(() => useSubscribeSubmit());

    act(() => {
      result.current.submit("1", "0x999900000000000000000000000000000000000f");
    });

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error?.message).toBe("user rejected signature");
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it("reaches done status once the subscribeWithPermit transaction confirms", async () => {
    mockUseSendTransaction.mockReturnValue({ sendTransaction: mockSendTransaction, data: "0xTxHash", error: null, isPending: false });
    mockUseWaitForTransactionReceipt.mockReturnValue({ isLoading: false, isSuccess: true, error: null });
    const { useSubscribeSubmit } = await import("../lib/hooks/useSubscribeSubmit.js");
    const { result } = renderHook(() => useSubscribeSubmit());

    act(() => {
      result.current.submit("1", "0x999900000000000000000000000000000000000f");
    });

    await waitFor(() => expect(result.current.status).toBe("done"));
  });
});
```

Note on the fake signature: `0x6e100a352ec6ad1b70802290e18aeed190704973570f3b8ed42cb9808e2ea6bf4a90a229a244495b41890987806fcbd2d5d23fc0dbe5f5256c2613c039d76db81b` is a syntactically valid 65-byte secp256k1 signature hex string (64 bytes of r/s plus a trailing `1b` = 27 decimal for the v/yParity byte) — using a real-shaped value lets the test exercise viem's actual `parseSignature` function rather than mocking it, since `parseSignature` is a pure, deterministic utility (not a wagmi hook) with no reason to mock.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run test/useSubscribeSubmit.test.tsx`
Expected: FAIL — `../lib/hooks/useSubscribeSubmit.js` does not exist.

- [ ] **Step 3: Implement `useSubscribeSubmit`**

Create `apps/web/lib/hooks/useSubscribeSubmit.ts`:

```typescript
import { useEffect, useState } from "react";
import { useSignTypedData, useSendTransaction, useWaitForTransactionReceipt } from "wagmi";
import { encodeFunctionData, parseSignature } from "viem";
import { subscriptionManagerAbi } from "@cadence/shared/abis";
import { apiFetch } from "../apiFetch.js";

export type SubscribeStatus = "idle" | "preparing" | "signing" | "submitting" | "confirming" | "done" | "error";

export interface UseSubscribeSubmitResult {
  status: SubscribeStatus;
  error: Error | null;
  submit: (planId: string, owner: string) => void;
}

interface PreparedSubscribe {
  permit: {
    domain: { name: string; version: string; chainId: number; verifyingContract: string };
    types: { Permit: { name: string; type: string }[] };
    message: { owner: string; spender: string; value: string; nonce: string; deadline: string };
  };
  subscribe: { to: string; fn: "subscribeWithPermit"; planId: string; deadline: string };
}

export function useSubscribeSubmit(): UseSubscribeSubmitResult {
  const [status, setStatus] = useState<SubscribeStatus>("idle");
  const [error, setError] = useState<Error | null>(null);
  const [hasSubmittedTx, setHasSubmittedTx] = useState(false);
  const { signTypedDataAsync } = useSignTypedData();
  const { sendTransaction, data: hash, error: sendError, isPending } = useSendTransaction();
  const { isLoading: isConfirming, isSuccess, error: receiptError } = useWaitForTransactionReceipt({ hash });

  useEffect(() => {
    if (!hasSubmittedTx) return;
    if (sendError) setStatus("error");
    else if (isPending) setStatus("submitting");
    else if (hash && isConfirming) setStatus("confirming");
    else if (hash && isSuccess) setStatus("done");
  }, [hasSubmittedTx, sendError, isPending, hash, isConfirming, isSuccess]);

  useEffect(() => {
    if (receiptError) setStatus("error");
  }, [receiptError]);

  useEffect(() => {
    if (sendError) setError(sendError);
    if (receiptError) setError(receiptError);
  }, [sendError, receiptError]);

  async function submit(planId: string, owner: string) {
    setError(null);
    try {
      setStatus("preparing");
      const query = new URLSearchParams({ planId, owner });
      const prepared = (await apiFetch(`/v1/prepare/subscribe?${query.toString()}`)) as PreparedSubscribe;

      setStatus("signing");
      const signature = await signTypedDataAsync({
        domain: prepared.permit.domain,
        types: prepared.permit.types,
        primaryType: "Permit",
        message: prepared.permit.message,
      });

      // parseSignature's return type allows `v` to be undefined (its `yParityOrV
      // === 0 | 1` branch); `yParity` is always present, and the wallet-standard
      // 27/28 convention this endpoint's permit signing always produces means
      // `yParity + 27` is the correct, type-safe way to derive `v` regardless of
      // which branch parseSignature took, without depending on its possibly-
      // undefined `v` field directly.
      const { r, s, yParity } = parseSignature(signature);
      const v = yParity + 27;

      const data = encodeFunctionData({
        abi: subscriptionManagerAbi,
        functionName: "subscribeWithPermit",
        args: [BigInt(prepared.subscribe.planId), BigInt(prepared.permit.message.value), BigInt(prepared.subscribe.deadline), v, r, s],
      });

      sendTransaction({ to: prepared.subscribe.to as `0x${string}`, data });
      setHasSubmittedTx(true);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setStatus("error");
    }
  }

  return { status, error, submit };
}
```

Note the import of `subscriptionManagerAbi` from `@cadence/shared/abis` (the browser-safe subpath), matching `useSubscriptionWrite.ts`'s and `useCreatePlanSubmit.ts`'s established convention — never the main `@cadence/shared` barrel in browser code, since that barrel also exports `encryptSecret`/`decryptSecret`, which pull in `node:crypto`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run test/useSubscribeSubmit.test.tsx`
Expected: PASS (5/5 tests).

- [ ] **Step 5: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Run the full apps/web suite to confirm no regression**

Run: `cd apps/web && npx vitest run`
Expected: all pre-existing tests pass (18 files / 49 tests, per Phase 1o's final state), plus this task's 5 new ones.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/hooks/useSubscribeSubmit.ts apps/web/test/useSubscribeSubmit.test.tsx
git commit -m "Add useSubscribeSubmit hook"
```

---

### Task 2: Wizard page (`/portal/subscribe/[planId]`)

**Files:**
- Create: `apps/web/app/(portal)/portal/subscribe/[planId]/page.tsx`
- Test: `apps/web/test/SubscribePage.test.tsx`

**Interfaces:**
- Consumes: `usePortalPlan` (existing, from `../../../../../lib/hooks/usePortalPlan.js` — already fetches `{onchain_plan_id, name, amount, token, period_seconds, ...}` by ID, no wallet needed); `useSubscribeSubmit`/`SubscribeStatus` (Task 1, from `../../../../../lib/hooks/useSubscribeSubmit.js`); wagmi's `useAccount` and `connectkit`'s `ConnectKitButton` (existing portal pattern, see `portal/page.tsx`).
- Produces: the complete wizard route. This is the FINAL task of this phase.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/SubscribePage.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const mockUsePortalPlan = vi.fn();
const mockUseAccount = vi.fn();
const mockUseSubscribeSubmit = vi.fn();

vi.mock("../lib/hooks/usePortalPlan.js", () => ({
  usePortalPlan: (id: string | undefined) => mockUsePortalPlan(id),
}));

vi.mock("wagmi", () => ({
  useAccount: () => mockUseAccount(),
}));

vi.mock("connectkit", () => ({
  ConnectKitButton: () => <button type="button">Connect Wallet</button>,
}));

vi.mock("../lib/hooks/useSubscribeSubmit.js", () => ({
  useSubscribeSubmit: () => mockUseSubscribeSubmit(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ planId: "1" }),
  useRouter: () => ({ push: vi.fn() }),
}));

const PLAN = {
  onchain_plan_id: "1",
  name: "Pro Plan",
  amount: "20000000",
  token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  period_seconds: 2592000,
};

describe("SubscribePage", () => {
  beforeEach(() => {
    mockUsePortalPlan.mockReset();
    mockUseAccount.mockReset();
    mockUseSubscribeSubmit.mockReset();
    mockUsePortalPlan.mockReturnValue({ data: PLAN, isLoading: false, error: null });
    mockUseAccount.mockReturnValue({ address: undefined, isConnected: false });
    mockUseSubscribeSubmit.mockReturnValue({ status: "idle", error: null, submit: vi.fn() });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the plan's name and price before the wallet is connected, with no ConnectKitButton visible yet", async () => {
    const { default: SubscribePage } = await import("../app/(portal)/portal/subscribe/[planId]/page.js");
    render(<SubscribePage />);

    expect(screen.getByText(/pro plan/i)).toBeDefined();
    expect(screen.getByText(/20000000/)).toBeDefined();
    expect(screen.queryByText(/connect wallet/i)).toBeNull();
  });

  it("shows ConnectKitButton instead of a submit action when Subscribe is clicked while disconnected", async () => {
    const { default: SubscribePage } = await import("../app/(portal)/portal/subscribe/[planId]/page.js");
    render(<SubscribePage />);

    fireEvent.click(screen.getByRole("button", { name: /subscribe/i }));
    expect(screen.getByText(/connect wallet/i)).toBeDefined();
  });

  it("calls submit with planId and the connected address when Subscribe is clicked while connected", async () => {
    const submit = vi.fn();
    mockUseAccount.mockReturnValue({ address: "0x999900000000000000000000000000000000000f", isConnected: true });
    mockUseSubscribeSubmit.mockReturnValue({ status: "idle", error: null, submit });
    const { default: SubscribePage } = await import("../app/(portal)/portal/subscribe/[planId]/page.js");
    render(<SubscribePage />);

    fireEvent.click(screen.getByRole("button", { name: /subscribe/i }));
    expect(submit).toHaveBeenCalledWith("1", "0x999900000000000000000000000000000000000f");
  });

  it("shows a status message and disables Subscribe while signing", async () => {
    mockUseAccount.mockReturnValue({ address: "0x999900000000000000000000000000000000000f", isConnected: true });
    mockUseSubscribeSubmit.mockReturnValue({ status: "signing", error: null, submit: vi.fn() });
    const { default: SubscribePage } = await import("../app/(portal)/portal/subscribe/[planId]/page.js");
    render(<SubscribePage />);

    expect(screen.getByText(/sign in your wallet/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /subscribe/i })).toHaveProperty("disabled", true);
  });

  it("shows the error message and a Retry button on error", async () => {
    mockUseAccount.mockReturnValue({ address: "0x999900000000000000000000000000000000000f", isConnected: true });
    mockUseSubscribeSubmit.mockReturnValue({ status: "error", error: new Error("boom"), submit: vi.fn() });
    const { default: SubscribePage } = await import("../app/(portal)/portal/subscribe/[planId]/page.js");
    render(<SubscribePage />);

    expect(screen.getByText(/boom/)).toBeDefined();
    expect(screen.getByRole("button", { name: /retry/i })).toBeDefined();
  });

  it("shows a not-found message when the plan fails to load", async () => {
    mockUsePortalPlan.mockReturnValue({ data: undefined, isLoading: false, error: new Error("not found") });
    const { default: SubscribePage } = await import("../app/(portal)/portal/subscribe/[planId]/page.js");
    render(<SubscribePage />);

    expect(screen.getByText(/could not load|not found/i)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run test/SubscribePage.test.tsx`
Expected: FAIL — `../app/(portal)/portal/subscribe/[planId]/page.js` does not exist.

- [ ] **Step 3: Implement the wizard page**

Create `apps/web/app/(portal)/portal/subscribe/[planId]/page.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import { ConnectKitButton } from "connectkit";
import { usePortalPlan } from "../../../../../lib/hooks/usePortalPlan.js";
import { useSubscribeSubmit, type SubscribeStatus } from "../../../../../lib/hooks/useSubscribeSubmit.js";

const STATUS_MESSAGE: Record<Exclude<SubscribeStatus, "idle" | "error" | "done">, string> = {
  preparing: "Preparing…",
  signing: "Sign in your wallet…",
  submitting: "Confirm in your wallet…",
  confirming: "Waiting for confirmation…",
};

const IN_FLIGHT_STATUSES: SubscribeStatus[] = ["preparing", "signing", "submitting", "confirming"];

export default function SubscribePage() {
  const { planId } = useParams<{ planId: string }>();
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const { data: plan, isLoading, error: planError } = usePortalPlan(planId);
  const { status, error, submit } = useSubscribeSubmit();
  const [showConnect, setShowConnect] = useState(false);

  useEffect(() => {
    if (status === "done") router.push("/portal");
  }, [status, router]);

  if (isLoading) return <p className="font-body text-slate">Loading…</p>;
  if (planError || !plan) return <p className="font-body text-signal">Could not load this plan.</p>;

  const inFlight = IN_FLIGHT_STATUSES.includes(status);

  function handleSubscribeClick() {
    if (!isConnected || !address) {
      setShowConnect(true);
      return;
    }
    submit(planId, address);
  }

  return (
    <div className="flex flex-col gap-6 max-w-xl">
      <h1 className="font-display text-2xl">{plan.name ?? "Subscribe"}</h1>
      <div className="font-data tabular-nums text-sm">
        {plan.amount} {plan.token} / {plan.period_seconds}s
      </div>

      {showConnect && !isConnected && <ConnectKitButton />}

      {status !== "idle" && status !== "error" && status !== "done" && (
        <p className="font-body text-sm text-slate">{STATUS_MESSAGE[status]}</p>
      )}

      {status === "error" && error && <p className="font-body text-sm text-signal">{error.message}</p>}

      <button
        type="button"
        disabled={inFlight}
        onClick={handleSubscribeClick}
        className="self-start rounded-md bg-sapphire text-paper px-5 py-2.5 font-body font-semibold disabled:opacity-40"
      >
        {status === "error" ? "Retry" : "Subscribe"}
      </button>
    </div>
  );
}
```

Note: `handleSubscribeClick`'s early-return-to-`setShowConnect(true)` path means clicking "Subscribe" while disconnected never calls `submit` — it only reveals the `ConnectKitButton`. Once the wallet connects (ConnectKit's own UI handles the actual connection flow), the visitor clicks "Subscribe" again, and this time `isConnected`/`address` are populated, so `submit` runs. This matches the test's two separate assertions (click-while-disconnected reveals the button; click-while-connected calls submit) as two distinct interactions, not one.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run test/SubscribePage.test.tsx`
Expected: PASS (6/6 tests).

- [ ] **Step 5: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Run the full apps/web suite to confirm no regression**

Run: `cd apps/web && npx vitest run`
Expected: all pre-existing tests pass, plus this task's 6 new ones, plus Task 1's 5 — final total 19 files / 60 tests.

- [ ] **Step 7: Manual smoke check**

Run: `cd apps/web && rm -rf .next && pnpm dev` in the background — first confirm port 3001 is genuinely free via BOTH `lsof -i:3001` and `ss -tlnp | grep 3001` (this project has a documented history of `lsof -ti` alone missing a stray listener — check both). Once booted, curl `/portal/subscribe/1` (any numeric ID is fine — the real plan lookup happens client-side via `usePortalPlan`, so a nonexistent ID still exercises the route's compile/serve path) and confirm HTTP 200. Since this is a `"use client"` component with client-side data fetching, the raw SSR response body will show a loading state, not the plan's actual name — that's expected Next.js App Router behavior (same nuance the Phase 1o final review flagged for `/dashboard/plans/new`), not a defect; a 200 status is the correct verification signal here. Stop the dev server cleanly afterward and confirm the port is released via both tools.

- [ ] **Step 8: Commit**

```bash
git add "apps/web/app/(portal)/portal/subscribe/[planId]/page.tsx" apps/web/test/SubscribePage.test.tsx
git commit -m "Add portal subscribe wizard page"
```

---

## Plan Self-Review Notes

**Spec coverage check:**
- `useSubscribeSubmit` state machine (`idle → preparing → signing → submitting → confirming → done`, error/retry-from-preparing) → Task 1. ✓
- EIP-712 typed-data signing via `useSignTypedData`, exactly `{domain, types, primaryType: "Permit", message}` from the prepare response → Task 1 Step 3. ✓
- Signature splitting via `parseSignature` and `subscribeWithPermit` calldata assembly in the exact ABI param order (`planId, value, deadline, v, r, s`) → Task 1 Step 3, verified via the `decodeFunctionData` round-trip test in Step 1. ✓
- Plan preview before wallet connect (via existing `usePortalPlan`, no wallet needed) → Task 2 Step 3, confirmed by Task 2's first test asserting plan details render before any `ConnectKitButton` appears. ✓
- Connect-only-when-needed (deferred to the Subscribe click, not gating the whole page) → Task 2 Step 3's `handleSubscribeClick`/`showConnect` logic, tested explicitly. ✓
- Redirect to `/portal` on `done` → Task 2 Step 3's `useEffect`. ✓
- No backend changes, no new dependency, no new detail route, no shared `PortalConnectGate` → confirmed absent from both tasks. ✓

**Placeholder scan:** No "TBD"/"TODO"/vague requirements. Every step has complete, concrete code. One deliberately-flagged note exists in Task 1 Step 3 (the `parseSignature` `v`/`yParity` derivation) — an explicit, actionable explanation of a real TypeScript type-safety subtlety (`v` can be `undefined` in `parseSignature`'s return type depending on which branch it takes), not a placeholder.

**Type consistency check:** `SubscribeStatus` (Task 1) is consumed identically by Task 2's `STATUS_MESSAGE` record and `IN_FLIGHT_STATUSES` array — every non-idle/error/done state Task 1 defines (`preparing`, `signing`, `submitting`, `confirming`) has a corresponding message, cross-referenced against the hook's actual type definition. `UseSubscribeSubmitResult`'s `submit(planId: string, owner: string)` signature (Task 1) matches Task 2's `submit(planId, address)` call site exactly — both positional string arguments, same order. `usePortalPlan`'s consumed shape (`{onchain_plan_id, name, amount, token, period_seconds, ...}`, from the existing, unmodified hook) matches Task 2's rendering code's field accesses (`plan.name`, `plan.amount`, `plan.token`, `plan.period_seconds`) exactly, cross-checked against the actual `Plan` interface in `packages/sdk/src/types.ts`.

**Gap found and fixed during self-review:** an initial pass considered mocking viem's `parseSignature` in Task 1's test (matching how `wagmi`/`apiFetch` are mocked) but this would hide a real integration risk — whether the hook's `v`/`r`/`s` extraction genuinely produces calldata that decodes correctly. Fixed by using a real, syntactically valid signature hex string in the test fixture instead, letting the actual `parseSignature` run for real and asserting the final calldata decodes to the exact expected `args` (including `v === 27`, confirming the `yParity + 27` derivation is correct) — this is a stronger test than mocking would have produced, and follows this codebase's established precedent (Phase 1n's e2e tests never mock viem's pure encode/decode utilities, only the network-touching parts).
