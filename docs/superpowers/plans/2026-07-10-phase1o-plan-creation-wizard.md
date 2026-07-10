# Phase 1o: Dashboard Plan-Creation Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/dashboard/plans/new`, a two-screen wizard that collects plan details, deploys a 0xSplits Split when there are 2+ payout recipients, calls the (now session-auth-accepting) `GET /v1/prepare/plan`, and submits the resulting `createPlan` transaction.

**Architecture:** A small backend fix widens `/v1/prepare/plan`'s auth to accept session cookies (currently secret-key-only, which the session-authenticated dashboard can never satisfy). The frontend is a client-component page composing two new components — `PlanDetailsForm` (pure local-state form) and `PlanReviewSubmit` (drives a new state-machine hook, `useCreatePlanSubmit`, through the Split-deploy/prepare/submit sequence). `useCreatePlanSubmit` follows `useSubscriptionWrite.ts`'s established `WriteStatus`-shaped state machine, extended with two additional pre-submission states for the Split deployment.

**Tech Stack:** Next.js 15/React 18 client components (existing `apps/web` conventions), wagmi 2.19/viem 2.21 (existing), `@0xsplits/splits-sdk` 6.5.0 (new dependency, viem-native — see Task 3), NestJS/Zod (existing `apps/api` conventions), Vitest + Testing Library (existing test tooling).

## Global Constraints

- Amount input is USDC only — `deployments/84532.json`'s `usdc` address (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`), 6 decimals (matches existing test fixtures, e.g. `apps/api/test/setup.ts`'s `amount: "20000000"` = $20.00).
- Period is a preset select — `Weekly` (`604800`), `Monthly` (`2592000`), `Yearly` (`31536000`) seconds. No raw-seconds input.
- Trial is a preset select — `None` (`0`), `7 days` (`604800`), `14 days` (`1209600`), `30 days` (`2592000`) seconds.
- Recipients start with exactly one row pre-filled at 100%. Percentages must sum to exactly 100 before the form validates.
- When there is exactly 1 recipient, no Split is deployed — that recipient's raw address becomes `payoutSplit` directly. A Split is deployed only for 2+ recipients.
- No `/dashboard/plans/[id]` detail page in this phase — successful creation redirects to the existing `/dashboard/plans` list.
- No multi-token support, no plan editing/deactivation, no portal-side work — all explicitly out of scope per the design spec.
- `@0xsplits/splits-sdk`'s `createSplit()` call resolves only after on-chain confirmation and returns `{ splitAddress, event }` directly — no manual receipt-polling or event-decoding needed (verified against the SDK's real v6.5.0 source).
- `useCreatePlanSubmit`'s write step (submitting `createPlan`) uses wagmi's `useSendTransaction`, not `useWriteContract` — the calldata from `/v1/prepare/plan` is already ABI-encoded server-side, so there is no ABI/function name for `useWriteContract` to type-check against.
- Component tests mock the hook module (`vi.mock("../lib/hooks/useCreatePlanSubmit.js", ...)`), matching `SubscriptionActions.test.tsx`'s established pattern. The hook's own test mocks `wagmi` and `@0xsplits/splits-sdk` directly.

---

### Task 1: Widen `/v1/prepare/plan`'s auth to accept session cookies

**Files:**
- Modify: `apps/api/src/prepare/prepare.controller.ts`
- Modify: `apps/api/test/prepare.e2e-spec.ts`

**Interfaces:**
- Produces: `GET /v1/prepare/plan` now returns 200 for a session-cookie-authenticated request (previously 403 `key_type_not_allowed`), in addition to still accepting a secret API key. Behavior for publishable keys and malformed input is unchanged.

- [ ] **Step 1: Write the failing e2e test**

Modify `apps/api/test/prepare.e2e-spec.ts` — add this test inside the existing `describe("Prepare", ...)` block, immediately after the existing `"returns createPlan calldata that decodes back to the given params"` test (which uses a secret key) and before the `"rejects a publishable key"` test:

```typescript
  it("accepts a session cookie on GET /v1/prepare/plan", async () => {
    const { cookie } = await signInAndCreateMerchant(server);

    const response = await request(server)
      .get("/v1/prepare/plan")
      .set("Cookie", cookie)
      .query({
        payoutSplit: "0xdef000000000000000000000000000000000000b",
        token: "0x000000000000000000000000000000000000000c",
        amount: "20000000",
        period: "2592000",
        trial: "0",
      });

    expect(response.status).toBe(200);
    expect(response.body.to).toBe("0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9");
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run --config vitest.e2e.config.ts test/prepare.e2e-spec.ts`
Expected: the new test FAILS with `expected 403 to be 200` — a session cookie currently gets rejected by the `auth.keyType !== "secret"` check.

- [ ] **Step 3: Widen the auth check**

Modify `apps/api/src/prepare/prepare.controller.ts` — read the current file first (it has a `plan` handler with a `@RequireKeyType("secret")` decorator and a manual `if (auth.keyType !== "secret") throw ...` check, plus a `subscribe` handler with no key-type restriction). Replace the entire file:

```typescript
import { Controller, Get, Query, Req } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { AuthContextService } from "../auth/auth-context.service.js";
import { MerchantsService } from "../merchants/merchants.service.js";
import { AppException } from "../common/errors.js";
import { PrepareService } from "./prepare.service.js";
import { PreparePlanQuerySchema, PrepareSubscribeQuerySchema } from "./prepare.dto.js";

@Controller("v1/prepare")
export class PrepareController {
  constructor(
    private readonly prepareService: PrepareService,
    private readonly authContext: AuthContextService,
    private readonly merchantsService: MerchantsService,
  ) {}

  // Both routes accept session, secret, or publishable auth — publishable-key
  // rejection on /plan was removed because the dashboard (a legitimate,
  // primary caller of this endpoint as of Phase 1o) authenticates via session
  // cookie only and can never hold a secret key. This mirrors /subscribe's
  // existing, already-broader acceptance below.
  @Get("plan")
  async plan(@Query() query: Record<string, string>) {
    const params = parsePreparePlanQuery(query);
    return this.prepareService.buildCreatePlanCalldata(params);
  }

  @Get("subscribe")
  async subscribe(@Query() query: Record<string, string>, @Req() request: FastifyRequest) {
    const params = PrepareSubscribeQuerySchema.parse(query);

    const auth = await this.authContext.resolve(request);
    const callerOwnerAddress =
      auth.keyType === "session"
        ? auth.ownerAddress
        : (await this.resolveMerchantOwnerAddress(auth)).ownerAddress;

    return this.prepareService.buildSubscribePermit(callerOwnerAddress, params);
  }

  private async resolveMerchantOwnerAddress(auth: { merchantId: string | null }): Promise<{ ownerAddress: string }> {
    const merchant = await this.merchantsService.findByOwnerAddressById(auth.merchantId!);
    if (!merchant) {
      throw new AppException({ type: "invalid_request_error", code: "merchant_not_found", message: "No merchant account found for this API key." });
    }
    return { ownerAddress: merchant.ownerAddress };
  }
}

// PreparePlanQuerySchema.parse throws a raw ZodError, which this codebase's
// global AppExceptionFilter (see ../common/http-exception.filter.ts) does not
// know how to format — it would fall through to a generic 500. Wrapping it in
// an AppException here matches every other validation-failure path in this
// codebase (see plans.service.ts's requireOwnedPlan) and produces a real 400.
function parsePreparePlanQuery(query: Record<string, string>) {
  try {
    return PreparePlanQuerySchema.parse(query);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new AppException({
        type: "invalid_request_error",
        code: "invalid_query_params",
        message: error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      });
    }
    throw error;
  }
}
```

Note: `plan` no longer takes `@Req() request` or checks auth at all — it now accepts ANY authenticated caller (session, secret, or publishable), matching `subscribe`'s original unrestricted default. The `RequireKeyType` import is removed since nothing in this file uses it anymore.

- [ ] **Step 4: Also delete the now-obsolete "rejects a publishable key" test**

Modify `apps/api/test/prepare.e2e-spec.ts` — the existing test `"rejects a publishable key on GET /v1/prepare/plan"` (asserting a 403) is no longer correct behavior; `/v1/prepare/plan` now accepts publishable keys too, same as `/v1/prepare/subscribe`. Delete this entire test block:

```typescript
  it("rejects a publishable key on GET /v1/prepare/plan", async () => {
    const { cookie } = await signInAndCreateMerchant(server);
    const pubKey = await createPublishableKey(server, cookie);

    const response = await request(server)
      .get("/v1/prepare/plan")
      .set("Authorization", `Bearer ${pubKey}`)
      .query({
        payoutSplit: "0xdef000000000000000000000000000000000000b",
        token: "0x000000000000000000000000000000000000000c",
        amount: "20000000",
        period: "2592000",
        trial: "0",
      });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("key_type_not_allowed");
  });
```

- [ ] **Step 5: Run the e2e spec to verify it passes**

Run: `cd apps/api && npx tsc --noEmit && npx vitest run --config vitest.e2e.config.ts test/prepare.e2e-spec.ts`
Expected: `tsc` exit 0. Vitest: all tests in this file pass (7 total: the 3 pre-existing `/plan` tests minus the deleted publishable-key-rejection one, plus the new session-cookie test, plus the 3 pre-existing `/subscribe` tests — net 6 in this file, all passing).

- [ ] **Step 6: Run the full apps/api e2e suite to confirm no cross-suite regression**

Run: `cd apps/api && npx vitest run --config vitest.e2e.config.ts`
Expected: all 13 files pass together (this codebase has a documented history of a provider-wiring bug that only manifested when the full e2e suite ran together — confirm this task didn't reintroduce anything like it). Expected total: 82 tests (83 from the Phase 1n baseline, minus the one deleted test).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/prepare/prepare.controller.ts apps/api/test/prepare.e2e-spec.ts
git commit -m "Widen GET /v1/prepare/plan to accept session auth"
```

---

### Task 2: `PlanDetailsForm` component (Screen 1)

**Files:**
- Create: `apps/web/components/plans/PlanDetailsForm.tsx`
- Test: `apps/web/test/PlanDetailsForm.test.tsx`

**Interfaces:**
- Produces:
  ```typescript
  export interface PlanRecipientInput {
    address: string;
    percentage: string; // raw form input, e.g. "60" — validated/parsed by this component
  }

  export interface PlanDetailsFormValues {
    amount: string;       // decimal string, e.g. "20.00"
    periodSeconds: number;
    trialSeconds: number;
    recipients: PlanRecipientInput[];
  }

  export interface PlanDetailsFormProps {
    onContinue: (values: PlanDetailsFormValues) => void;
  }

  export function PlanDetailsForm(props: PlanDetailsFormProps): JSX.Element;
  ```
  `onContinue` fires only when the form is valid: amount is a positive decimal, every recipient has a well-formed `0x`-prefixed 40-hex-char address, and all recipient percentages parse to numbers summing to exactly 100. Consumed by Task 5's wizard page.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/PlanDetailsForm.test.tsx`:

```tsx
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PlanDetailsForm } from "../components/plans/PlanDetailsForm.js";

afterEach(() => {
  cleanup();
});

function fillBaseForm() {
  fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "20.00" } });
  fireEvent.change(screen.getByLabelText(/^address/i), { target: { value: "0xdef000000000000000000000000000000000000b" } });
}

describe("PlanDetailsForm", () => {
  it("starts with a single recipient row pre-filled at 100%", () => {
    render(<PlanDetailsForm onContinue={vi.fn()} />);
    const percentageInputs = screen.getAllByLabelText(/percentage/i);
    expect(percentageInputs).toHaveLength(1);
    expect((percentageInputs[0] as HTMLInputElement).value).toBe("100");
  });

  it("adds a new empty recipient row when 'Add recipient' is clicked", () => {
    render(<PlanDetailsForm onContinue={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /add recipient/i }));
    expect(screen.getAllByLabelText(/percentage/i)).toHaveLength(2);
  });

  it("disables Continue when a single recipient's percentage is not 100", () => {
    render(<PlanDetailsForm onContinue={vi.fn()} />);
    fillBaseForm();
    fireEvent.change(screen.getAllByLabelText(/percentage/i)[0], { target: { value: "90" } });
    expect(screen.getByRole("button", { name: /continue/i })).toHaveProperty("disabled", true);
  });

  it("disables Continue when two recipients' percentages do not sum to 100", () => {
    render(<PlanDetailsForm onContinue={vi.fn()} />);
    fillBaseForm();
    fireEvent.click(screen.getByRole("button", { name: /add recipient/i }));
    const percentageInputs = screen.getAllByLabelText(/percentage/i);
    fireEvent.change(percentageInputs[0], { target: { value: "60" } });
    fireEvent.change(percentageInputs[1], { target: { value: "30" } });
    const addressInputs = screen.getAllByLabelText(/^address/i);
    fireEvent.change(addressInputs[1], { target: { value: "0x999900000000000000000000000000000000000f" } });
    expect(screen.getByRole("button", { name: /continue/i })).toHaveProperty("disabled", true);
  });

  it("enables Continue and calls onContinue with parsed values when two recipients sum to exactly 100", () => {
    const onContinue = vi.fn();
    render(<PlanDetailsForm onContinue={onContinue} />);
    fillBaseForm();
    fireEvent.click(screen.getByRole("button", { name: /add recipient/i }));
    const percentageInputs = screen.getAllByLabelText(/percentage/i);
    fireEvent.change(percentageInputs[0], { target: { value: "60" } });
    fireEvent.change(percentageInputs[1], { target: { value: "40" } });
    const addressInputs = screen.getAllByLabelText(/^address/i);
    fireEvent.change(addressInputs[1], { target: { value: "0x999900000000000000000000000000000000000f" } });

    const continueButton = screen.getByRole("button", { name: /continue/i });
    expect(continueButton).toHaveProperty("disabled", false);
    fireEvent.click(continueButton);

    expect(onContinue).toHaveBeenCalledWith({
      amount: "20.00",
      periodSeconds: 2592000,
      trialSeconds: 0,
      recipients: [
        { address: "0xdef000000000000000000000000000000000000b", percentage: "60" },
        { address: "0x999900000000000000000000000000000000000f", percentage: "40" },
      ],
    });
  });

  it("disables Continue when a recipient address is malformed", () => {
    render(<PlanDetailsForm onContinue={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "20.00" } });
    fireEvent.change(screen.getByLabelText(/^address/i), { target: { value: "not-an-address" } });
    expect(screen.getByRole("button", { name: /continue/i })).toHaveProperty("disabled", true);
  });

  it("defaults period to Monthly and trial to None", () => {
    const onContinue = vi.fn();
    render(<PlanDetailsForm onContinue={onContinue} />);
    fillBaseForm();
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(onContinue).toHaveBeenCalledWith(expect.objectContaining({ periodSeconds: 2592000, trialSeconds: 0 }));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run test/PlanDetailsForm.test.tsx`
Expected: FAIL — `../components/plans/PlanDetailsForm.js` does not exist.

- [ ] **Step 3: Implement `PlanDetailsForm`**

Create `apps/web/components/plans/PlanDetailsForm.tsx`:

```tsx
"use client";

import { useState } from "react";

export interface PlanRecipientInput {
  address: string;
  percentage: string;
}

export interface PlanDetailsFormValues {
  amount: string;
  periodSeconds: number;
  trialSeconds: number;
  recipients: PlanRecipientInput[];
}

export interface PlanDetailsFormProps {
  onContinue: (values: PlanDetailsFormValues) => void;
}

const PERIOD_OPTIONS = [
  { label: "Weekly", seconds: 604800 },
  { label: "Monthly", seconds: 2592000 },
  { label: "Yearly", seconds: 31536000 },
];

const TRIAL_OPTIONS = [
  { label: "None", seconds: 0 },
  { label: "7 days", seconds: 604800 },
  { label: "14 days", seconds: 1209600 },
  { label: "30 days", seconds: 2592000 },
];

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

function isValidAmount(amount: string): boolean {
  const parsed = Number(amount);
  return amount.trim().length > 0 && Number.isFinite(parsed) && parsed > 0;
}

function isValid(amount: string, recipients: PlanRecipientInput[]): boolean {
  if (!isValidAmount(amount)) return false;
  if (recipients.length === 0) return false;

  let sum = 0;
  for (const recipient of recipients) {
    if (!ADDRESS_PATTERN.test(recipient.address)) return false;
    const pct = Number(recipient.percentage);
    if (!Number.isFinite(pct) || pct <= 0) return false;
    sum += pct;
  }
  // Floating point tolerance: percentages are decimal strings from user input.
  return Math.abs(sum - 100) < 0.0001;
}

export function PlanDetailsForm({ onContinue }: PlanDetailsFormProps) {
  const [amount, setAmount] = useState("");
  const [periodSeconds, setPeriodSeconds] = useState(PERIOD_OPTIONS[1].seconds);
  const [trialSeconds, setTrialSeconds] = useState(TRIAL_OPTIONS[0].seconds);
  const [recipients, setRecipients] = useState<PlanRecipientInput[]>([{ address: "", percentage: "100" }]);

  function updateRecipient(index: number, field: keyof PlanRecipientInput, value: string) {
    setRecipients((prev) => prev.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  }

  function addRecipient() {
    setRecipients((prev) => [...prev, { address: "", percentage: "" }]);
  }

  const valid = isValid(amount, recipients);

  return (
    <div className="flex flex-col gap-6 max-w-xl">
      <div>
        <label htmlFor="plan-amount" className="block font-body text-sm mb-1">
          Amount (USDC)
        </label>
        <input
          id="plan-amount"
          type="text"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="w-full rounded-md border border-slate/25 px-3 py-2 font-data"
        />
      </div>

      <div>
        <label htmlFor="plan-period" className="block font-body text-sm mb-1">
          Billing period
        </label>
        <select
          id="plan-period"
          value={periodSeconds}
          onChange={(e) => setPeriodSeconds(Number(e.target.value))}
          className="w-full rounded-md border border-slate/25 px-3 py-2"
        >
          {PERIOD_OPTIONS.map((opt) => (
            <option key={opt.seconds} value={opt.seconds}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="plan-trial" className="block font-body text-sm mb-1">
          Trial period
        </label>
        <select
          id="plan-trial"
          value={trialSeconds}
          onChange={(e) => setTrialSeconds(Number(e.target.value))}
          className="w-full rounded-md border border-slate/25 px-3 py-2"
        >
          {TRIAL_OPTIONS.map((opt) => (
            <option key={opt.seconds} value={opt.seconds}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-3">
        <span className="font-body text-sm">Recipients</span>
        {recipients.map((recipient, index) => (
          <div key={index} className="flex gap-3">
            <div className="flex-1">
              <label htmlFor={`recipient-address-${index}`} className="sr-only">
                Address {index + 1}
              </label>
              <input
                id={`recipient-address-${index}`}
                type="text"
                placeholder="0x..."
                value={recipient.address}
                onChange={(e) => updateRecipient(index, "address", e.target.value)}
                className="w-full rounded-md border border-slate/25 px-3 py-2 font-data"
              />
            </div>
            <div className="w-28">
              <label htmlFor={`recipient-percentage-${index}`} className="sr-only">
                Percentage {index + 1}
              </label>
              <input
                id={`recipient-percentage-${index}`}
                type="text"
                value={recipient.percentage}
                onChange={(e) => updateRecipient(index, "percentage", e.target.value)}
                className="w-full rounded-md border border-slate/25 px-3 py-2 font-data"
              />
            </div>
          </div>
        ))}
        <button type="button" onClick={addRecipient} className="self-start rounded-md border border-slate/25 px-3 py-1.5 text-sm font-body">
          Add recipient
        </button>
      </div>

      <button
        type="button"
        disabled={!valid}
        onClick={() => onContinue({ amount, periodSeconds, trialSeconds, recipients })}
        className="self-start rounded-md bg-sapphire text-paper px-5 py-2.5 font-body font-semibold disabled:opacity-40"
      >
        Continue
      </button>
    </div>
  );
}
```

Note the test file's `getByLabelText(/^address/i)` for the first recipient row matches the `sr-only` label text `"Address 1"` (the `^` anchor avoids ambiguously matching `"Percentage 1"` or similar). Testing Library's `getByLabelText` matches visually-hidden (`sr-only`) labels correctly since it queries the accessibility tree, not visual rendering.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run test/PlanDetailsForm.test.tsx`
Expected: PASS (7/7 tests).

- [ ] **Step 5: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Run the full apps/web suite to confirm no regression**

Run: `cd apps/web && npx vitest run`
Expected: all pre-existing tests pass, plus this task's 7 new ones.

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/plans/PlanDetailsForm.tsx apps/web/test/PlanDetailsForm.test.tsx
git commit -m "Add PlanDetailsForm component (Phase 1o Screen 1)"
```

---

### Task 3: `@0xsplits/splits-sdk` dependency + `useCreatePlanSubmit` hook

**Files:**
- Modify: `apps/web/package.json`
- Create: `apps/web/lib/hooks/useCreatePlanSubmit.ts`
- Test: `apps/web/test/useCreatePlanSubmit.test.tsx`

**Interfaces:**
- Consumes: `PlanDetailsFormValues`/`PlanRecipientInput` (Task 2, from `../components/plans/PlanDetailsForm.js`).
- Produces:
  ```typescript
  export type CreatePlanStatus =
    | "idle"
    | "deploying-split"
    | "split-confirmed"
    | "preparing-plan"
    | "confirming-plan"
    | "pending-plan"
    | "done"
    | "error";

  export interface UseCreatePlanSubmitResult {
    status: CreatePlanStatus;
    error: Error | null;
    submit: (values: PlanDetailsFormValues) => void;
  }

  export function useCreatePlanSubmit(): UseCreatePlanSubmitResult;
  ```
  Consumed by Task 4's `PlanReviewSubmit` component.

- [ ] **Step 1: Add the dependency**

Modify `apps/web/package.json` — read the current file first, then add `"@0xsplits/splits-sdk": "^6.5.0"` to the `"dependencies"` object, alongside the existing `wagmi`/`viem` lines:

```json
    "wagmi": "^2.19.0",
    "viem": "^2.21.0",
    "@0xsplits/splits-sdk": "^6.5.0",
```

- [ ] **Step 2: Install**

Run: `pnpm install` (from repo root)
Expected: `pnpm-lock.yaml` updates to include `@0xsplits/splits-sdk` and its transitive dependencies (`@urql/core`, `graphql`, `lodash`, `base-64`) under `apps/web`; exit 0.

- [ ] **Step 3: Write the failing test**

Create `apps/web/test/useCreatePlanSubmit.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { cleanup } from "@testing-library/react";
import type { PlanDetailsFormValues } from "../components/plans/PlanDetailsForm.js";

const mockCreateSplit = vi.fn();
const mockSendTransaction = vi.fn();
const mockUsePublicClient = vi.fn();
const mockUseWalletClient = vi.fn();
const mockUseSendTransaction = vi.fn();
const mockUseWaitForTransactionReceipt = vi.fn();

vi.mock("@0xsplits/splits-sdk", () => ({
  SplitV2Client: vi.fn().mockImplementation(() => ({ createSplit: mockCreateSplit })),
  SplitV2Type: { Pull: "pull" },
}));

vi.mock("wagmi", () => ({
  usePublicClient: () => mockUsePublicClient(),
  useWalletClient: () => mockUseWalletClient(),
  useSendTransaction: () => mockUseSendTransaction(),
  useWaitForTransactionReceipt: (args: unknown) => mockUseWaitForTransactionReceipt(args),
}));

vi.mock("../lib/apiFetch.js", () => ({
  apiFetch: vi.fn().mockResolvedValue({ to: "0xManagerAddress", data: "0xCalldata", value: "0" }),
}));

const SINGLE_RECIPIENT_VALUES: PlanDetailsFormValues = {
  amount: "20.00",
  periodSeconds: 2592000,
  trialSeconds: 0,
  recipients: [{ address: "0xdef000000000000000000000000000000000000b", percentage: "100" }],
};

const TWO_RECIPIENT_VALUES: PlanDetailsFormValues = {
  amount: "20.00",
  periodSeconds: 2592000,
  trialSeconds: 0,
  recipients: [
    { address: "0xdef000000000000000000000000000000000000b", percentage: "60" },
    { address: "0x999900000000000000000000000000000000000f", percentage: "40" },
  ],
};

describe("useCreatePlanSubmit", () => {
  beforeEach(() => {
    mockCreateSplit.mockReset();
    mockSendTransaction.mockReset();
    mockUsePublicClient.mockReturnValue({});
    mockUseWalletClient.mockReturnValue({ data: {} });
    mockUseSendTransaction.mockReturnValue({ sendTransaction: mockSendTransaction, data: undefined, error: null, isPending: false });
    mockUseWaitForTransactionReceipt.mockReturnValue({ isLoading: false, isSuccess: false, error: null });
  });

  afterEach(() => {
    cleanup();
  });

  it("skips Split deployment for a single recipient and uses their raw address", async () => {
    const { apiFetch } = await import("../lib/apiFetch.js");
    const { useCreatePlanSubmit } = await import("../lib/hooks/useCreatePlanSubmit.js");

    const { result } = renderHook(() => useCreatePlanSubmit());
    act(() => {
      result.current.submit(SINGLE_RECIPIENT_VALUES);
    });

    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(mockCreateSplit).not.toHaveBeenCalled();
    const [path] = (apiFetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toContain("payoutSplit=0xdef000000000000000000000000000000000000b");
  });

  it("deploys a Split for two recipients before preparing the plan", async () => {
    mockCreateSplit.mockResolvedValue({ splitAddress: "0xSplitAddress", event: {} });
    const { apiFetch } = await import("../lib/apiFetch.js");
    const { useCreatePlanSubmit } = await import("../lib/hooks/useCreatePlanSubmit.js");

    const { result } = renderHook(() => useCreatePlanSubmit());
    act(() => {
      result.current.submit(TWO_RECIPIENT_VALUES);
    });

    await waitFor(() => expect(mockCreateSplit).toHaveBeenCalledWith(
      expect.objectContaining({
        recipients: [
          { address: "0xdef000000000000000000000000000000000000b", percentAllocation: 60 },
          { address: "0x999900000000000000000000000000000000000f", percentAllocation: 40 },
        ],
      }),
    ));
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const [path] = (apiFetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toContain("payoutSplit=0xSplitAddress");
  });

  it("sets status to error and stops when Split deployment fails", async () => {
    mockCreateSplit.mockRejectedValue(new Error("split deploy failed"));
    const { useCreatePlanSubmit } = await import("../lib/hooks/useCreatePlanSubmit.js");

    const { result } = renderHook(() => useCreatePlanSubmit());
    act(() => {
      result.current.submit(TWO_RECIPIENT_VALUES);
    });

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error?.message).toBe("split deploy failed");
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it("calls sendTransaction with the calldata returned from /v1/prepare/plan", async () => {
    const { useCreatePlanSubmit } = await import("../lib/hooks/useCreatePlanSubmit.js");

    const { result } = renderHook(() => useCreatePlanSubmit());
    act(() => {
      result.current.submit(SINGLE_RECIPIENT_VALUES);
    });

    await waitFor(() =>
      expect(mockSendTransaction).toHaveBeenCalledWith({
        to: "0xManagerAddress",
        data: "0xCalldata",
        value: 0n,
      }),
    );
  });

  it("reaches done status once the createPlan transaction confirms", async () => {
    mockUseSendTransaction.mockReturnValue({ sendTransaction: mockSendTransaction, data: "0xTxHash", error: null, isPending: false });
    mockUseWaitForTransactionReceipt.mockReturnValue({ isLoading: false, isSuccess: true, error: null });
    const { useCreatePlanSubmit } = await import("../lib/hooks/useCreatePlanSubmit.js");

    const { result } = renderHook(() => useCreatePlanSubmit());
    act(() => {
      result.current.submit(SINGLE_RECIPIENT_VALUES);
    });

    await waitFor(() => expect(result.current.status).toBe("done"));
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cd apps/web && npx vitest run test/useCreatePlanSubmit.test.tsx`
Expected: FAIL — `../lib/hooks/useCreatePlanSubmit.js` does not exist.

- [ ] **Step 5: Implement `useCreatePlanSubmit`**

Create `apps/web/lib/hooks/useCreatePlanSubmit.ts`:

```typescript
import { useEffect, useRef, useState } from "react";
import { usePublicClient, useWalletClient, useSendTransaction, useWaitForTransactionReceipt } from "wagmi";
import { SplitV2Client, SplitV2Type } from "@0xsplits/splits-sdk";
import { apiFetch } from "../apiFetch.js";
import type { PlanDetailsFormValues } from "../../components/plans/PlanDetailsForm.js";

export type CreatePlanStatus =
  | "idle"
  | "deploying-split"
  | "split-confirmed"
  | "preparing-plan"
  | "confirming-plan"
  | "pending-plan"
  | "done"
  | "error";

export interface UseCreatePlanSubmitResult {
  status: CreatePlanStatus;
  error: Error | null;
  submit: (values: PlanDetailsFormValues) => void;
}

const USDC_ADDRESS = (process.env.NEXT_PUBLIC_USDC_ADDRESS ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "84532");

function toWeiAmount(amount: string): string {
  // USDC has 6 decimals — matches this codebase's existing test fixtures
  // (e.g. apps/api/test/setup.ts's amount: "20000000" for $20.00).
  const [whole, fraction = ""] = amount.split(".");
  const paddedFraction = (fraction + "000000").slice(0, 6);
  return `${whole}${paddedFraction}`.replace(/^0+(?=\d)/, "");
}

export function useCreatePlanSubmit(): UseCreatePlanSubmitResult {
  const [status, setStatus] = useState<CreatePlanStatus>("idle");
  const [error, setError] = useState<Error | null>(null);
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { data: walletClient } = useWalletClient();
  const { sendTransaction, data: hash, error: sendError, isPending } = useSendTransaction();
  const { isLoading: isConfirming, isSuccess, error: receiptError } = useWaitForTransactionReceipt({ hash });
  const submittedRef = useRef(false);

  useEffect(() => {
    if (sendError) setStatus("error");
    else if (isPending) setStatus("confirming-plan");
    else if (hash && isConfirming) setStatus("pending-plan");
    else if (isSuccess) setStatus("done");
  }, [sendError, isPending, hash, isConfirming, isSuccess]);

  useEffect(() => {
    if (receiptError) setStatus("error");
  }, [receiptError]);

  useEffect(() => {
    if (sendError) setError(sendError);
    if (receiptError) setError(receiptError);
  }, [sendError, receiptError]);

  async function submit(values: PlanDetailsFormValues) {
    submittedRef.current = true;
    setError(null);
    try {
      let payoutSplit: string;

      if (values.recipients.length === 1) {
        payoutSplit = values.recipients[0].address;
      } else {
        setStatus("deploying-split");
        const splitsClient = new SplitV2Client({ chainId: CHAIN_ID, publicClient, walletClient: walletClient ?? undefined });
        const { splitAddress } = await splitsClient.createSplit({
          recipients: values.recipients.map((r) => ({ address: r.address, percentAllocation: Number(r.percentage) })),
          distributorFeePercent: 0,
          splitType: SplitV2Type.Pull,
          chainId: CHAIN_ID,
        });
        payoutSplit = splitAddress;
        setStatus("split-confirmed");
      }

      setStatus("preparing-plan");
      const query = new URLSearchParams({
        payoutSplit,
        token: USDC_ADDRESS,
        amount: toWeiAmount(values.amount),
        period: String(values.periodSeconds),
        trial: String(values.trialSeconds),
      });
      const prepared = (await apiFetch(`/v1/prepare/plan?${query.toString()}`)) as { to: string; data: string; value: string };

      setStatus("confirming-plan");
      sendTransaction({
        to: prepared.to as `0x${string}`,
        data: prepared.data as `0x${string}`,
        value: BigInt(prepared.value),
      });
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setStatus("error");
    }
  }

  return { status, error, submit };
}
```

Note: `submittedRef` is unused by any branching logic in this step's implementation — remove it; it was a leftover from an earlier draft. Delete the line `const submittedRef = useRef(false);`, the `submittedRef.current = true;` line inside `submit`, and the now-unused `useRef` import.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run test/useCreatePlanSubmit.test.tsx`
Expected: PASS (5/5 tests).

- [ ] **Step 7: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 8: Run the full apps/web suite to confirm no regression**

Run: `cd apps/web && npx vitest run`
Expected: all pre-existing tests pass, plus this task's 5 new ones.

- [ ] **Step 9: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/lib/hooks/useCreatePlanSubmit.ts apps/web/test/useCreatePlanSubmit.test.tsx
git commit -m "Add @0xsplits/splits-sdk dependency and useCreatePlanSubmit hook"
```

---

### Task 4: `PlanReviewSubmit` component (Screen 2)

**Files:**
- Create: `apps/web/components/plans/PlanReviewSubmit.tsx`
- Test: `apps/web/test/PlanReviewSubmit.test.tsx`

**Interfaces:**
- Consumes: `PlanDetailsFormValues` (Task 2); `useCreatePlanSubmit`/`CreatePlanStatus` (Task 3, from `../lib/hooks/useCreatePlanSubmit.js`).
- Produces:
  ```typescript
  export interface PlanReviewSubmitProps {
    values: PlanDetailsFormValues;
    onDone: () => void;
  }

  export function PlanReviewSubmit(props: PlanReviewSubmitProps): JSX.Element;
  ```
  Consumed by Task 5's wizard page. `onDone` fires once when `status` transitions to `"done"`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/PlanReviewSubmit.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PlanReviewSubmit } from "../components/plans/PlanReviewSubmit.js";
import type { PlanDetailsFormValues } from "../components/plans/PlanDetailsForm.js";

const mockUseCreatePlanSubmit = vi.fn();

vi.mock("../lib/hooks/useCreatePlanSubmit.js", () => ({
  useCreatePlanSubmit: () => mockUseCreatePlanSubmit(),
}));

const VALUES: PlanDetailsFormValues = {
  amount: "20.00",
  periodSeconds: 2592000,
  trialSeconds: 0,
  recipients: [{ address: "0xdef000000000000000000000000000000000000b", percentage: "100" }],
};

describe("PlanReviewSubmit", () => {
  beforeEach(() => {
    mockUseCreatePlanSubmit.mockReset();
    mockUseCreatePlanSubmit.mockReturnValue({ status: "idle", error: null, submit: vi.fn() });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders a read-only summary of the plan values", () => {
    render(<PlanReviewSubmit values={VALUES} onDone={vi.fn()} />);
    expect(screen.getByText(/20\.00/)).toBeDefined();
    expect(screen.getByText(/0xdef000000000000000000000000000000000000b/i)).toBeDefined();
    expect(screen.getByText(/100/)).toBeDefined();
  });

  it("calls submit with the values when Create Plan is clicked", () => {
    const submit = vi.fn();
    mockUseCreatePlanSubmit.mockReturnValue({ status: "idle", error: null, submit });
    render(<PlanReviewSubmit values={VALUES} onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /create plan/i }));
    expect(submit).toHaveBeenCalledWith(VALUES);
  });

  it("shows a deploying-split status message and disables the button while deploying", () => {
    mockUseCreatePlanSubmit.mockReturnValue({ status: "deploying-split", error: null, submit: vi.fn() });
    render(<PlanReviewSubmit values={VALUES} onDone={vi.fn()} />);
    expect(screen.getByText(/deploying split/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /create plan/i })).toHaveProperty("disabled", true);
  });

  it("shows a confirming-plan status message", () => {
    mockUseCreatePlanSubmit.mockReturnValue({ status: "confirming-plan", error: null, submit: vi.fn() });
    render(<PlanReviewSubmit values={VALUES} onDone={vi.fn()} />);
    expect(screen.getByText(/confirm in your wallet/i)).toBeDefined();
  });

  it("shows the error message and a retry button on error", () => {
    mockUseCreatePlanSubmit.mockReturnValue({ status: "error", error: new Error("boom"), submit: vi.fn() });
    render(<PlanReviewSubmit values={VALUES} onDone={vi.fn()} />);
    expect(screen.getByText(/boom/)).toBeDefined();
    expect(screen.getByRole("button", { name: /retry/i })).toBeDefined();
  });

  it("calls onDone once when status is done", () => {
    const onDone = vi.fn();
    mockUseCreatePlanSubmit.mockReturnValue({ status: "done", error: null, submit: vi.fn() });
    render(<PlanReviewSubmit values={VALUES} onDone={onDone} />);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run test/PlanReviewSubmit.test.tsx`
Expected: FAIL — `../components/plans/PlanReviewSubmit.js` does not exist.

- [ ] **Step 3: Implement `PlanReviewSubmit`**

Create `apps/web/components/plans/PlanReviewSubmit.tsx`:

```tsx
"use client";

import { useEffect } from "react";
import { useCreatePlanSubmit, type CreatePlanStatus } from "../../lib/hooks/useCreatePlanSubmit.js";
import type { PlanDetailsFormValues } from "./PlanDetailsForm.js";

export interface PlanReviewSubmitProps {
  values: PlanDetailsFormValues;
  onDone: () => void;
}

const STATUS_MESSAGE: Record<Exclude<CreatePlanStatus, "idle" | "error" | "done">, string> = {
  "deploying-split": "Deploying split contract — confirm in your wallet…",
  "split-confirmed": "Split deployed.",
  "preparing-plan": "Preparing plan…",
  "confirming-plan": "Confirm in your wallet…",
  "pending-plan": "Waiting for confirmation…",
};

const IN_FLIGHT_STATUSES: CreatePlanStatus[] = ["deploying-split", "split-confirmed", "preparing-plan", "confirming-plan", "pending-plan"];

export function PlanReviewSubmit({ values, onDone }: PlanReviewSubmitProps) {
  const { status, error, submit } = useCreatePlanSubmit();

  useEffect(() => {
    if (status === "done") onDone();
  }, [status, onDone]);

  const inFlight = IN_FLIGHT_STATUSES.includes(status);

  return (
    <div className="flex flex-col gap-6 max-w-xl">
      <div className="flex flex-col gap-2 font-body text-sm">
        <div>
          <span className="text-slate">Amount:</span> <span className="font-data">{values.amount} USDC</span>
        </div>
        <div>
          <span className="text-slate">Period:</span> <span className="font-data">{values.periodSeconds}s</span>
        </div>
        <div>
          <span className="text-slate">Trial:</span> <span className="font-data">{values.trialSeconds}s</span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-slate">Recipients:</span>
          {values.recipients.map((r, i) => (
            <div key={i} className="font-data pl-3">
              {r.address} — {r.percentage}%
            </div>
          ))}
        </div>
      </div>

      {status !== "idle" && status !== "error" && status !== "done" && (
        <p className="font-body text-sm text-slate">{STATUS_MESSAGE[status]}</p>
      )}

      {status === "error" && error && (
        <p className="font-body text-sm text-signal">{error.message}</p>
      )}

      <button
        type="button"
        disabled={inFlight}
        onClick={() => submit(values)}
        className="self-start rounded-md bg-sapphire text-paper px-5 py-2.5 font-body font-semibold disabled:opacity-40"
      >
        {status === "error" ? "Retry" : "Create Plan"}
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run test/PlanReviewSubmit.test.tsx`
Expected: PASS (6/6 tests).

- [ ] **Step 5: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Run the full apps/web suite to confirm no regression**

Run: `cd apps/web && npx vitest run`
Expected: all pre-existing tests pass, plus this task's 6 new ones.

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/plans/PlanReviewSubmit.tsx apps/web/test/PlanReviewSubmit.test.tsx
git commit -m "Add PlanReviewSubmit component (Phase 1o Screen 2)"
```

---

### Task 5: Wizard page route + "New Plan" link

**Files:**
- Create: `apps/web/app/(dashboard)/dashboard/plans/new/page.tsx`
- Modify: `apps/web/app/(dashboard)/dashboard/plans/page.tsx`

**Interfaces:**
- Consumes: `PlanDetailsForm`/`PlanDetailsFormValues` (Task 2); `PlanReviewSubmit` (Task 4).
- Produces: the complete wizard route. This is the FINAL task of this phase.

- [ ] **Step 1: Build the wizard page**

Create `apps/web/app/(dashboard)/dashboard/plans/new/page.tsx`:

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PlanDetailsForm, type PlanDetailsFormValues } from "../../../../../components/plans/PlanDetailsForm.js";
import { PlanReviewSubmit } from "../../../../../components/plans/PlanReviewSubmit.js";

type WizardScreen = { step: "details" } | { step: "review"; values: PlanDetailsFormValues };

export default function NewPlanPage() {
  const router = useRouter();
  const [screen, setScreen] = useState<WizardScreen>({ step: "details" });

  return (
    <div>
      <h1 className="font-display text-2xl mb-6">New Plan</h1>
      {screen.step === "details" && (
        <PlanDetailsForm onContinue={(values) => setScreen({ step: "review", values })} />
      )}
      {screen.step === "review" && (
        <PlanReviewSubmit values={screen.values} onDone={() => router.push("/dashboard/plans")} />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add the "New Plan" link to the plans list page**

Modify `apps/web/app/(dashboard)/dashboard/plans/page.tsx` — read the current file first, then add a link next to the page heading:

```tsx
"use client";

import Link from "next/link";
import { usePlans } from "../../../../lib/hooks/usePlans.js";
import { StatusBadge } from "@cadence/ui";

export default function PlansPage() {
  const { data, isLoading, error } = usePlans();

  if (isLoading) return <p className="font-body text-slate">Loading…</p>;
  if (error) return <p className="font-body text-signal">Could not load plans.</p>;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-2xl">Plans</h1>
        <Link href="/dashboard/plans/new" className="rounded-md bg-sapphire text-paper px-4 py-2 font-body text-sm font-semibold">
          New Plan
        </Link>
      </div>
      <table className="w-full text-sm font-body">
        <thead>
          <tr className="text-left text-slate border-b border-slate/15">
            <th className="py-2">Name</th>
            <th className="py-2">Price</th>
            <th className="py-2">Period</th>
            <th className="py-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((plan) => (
            <tr key={plan.onchain_plan_id} className="border-b border-slate/10">
              <td className="py-2">{plan.name ?? "Untitled plan"}</td>
              <td className="py-2 font-data tabular-nums">{plan.amount} {plan.token}</td>
              <td className="py-2 font-data tabular-nums">{Math.round(plan.period_seconds / 86400)}d</td>
              <td className="py-2"><StatusBadge status={plan.active ? "active" : "canceled"} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Run the full apps/web suite one final time**

Run: `cd apps/web && npx vitest run`
Expected: all tests pass — no new test files in this task (matches this project's established practice of not unit-testing static page-composition/routing wiring, same as Phase 1m's marketing sections).

- [ ] **Step 5: Manual smoke check**

Run: `cd apps/web && rm -rf .next && pnpm dev` in the background — first confirm port 3001 is genuinely free via BOTH `lsof -i:3001` and `ss -tlnp | grep 3001` (this project has repeatedly found `lsof -ti` alone misses a stray listener; check both). Once booted, curl `/dashboard/plans/new` and confirm an HTTP 200 (the page itself renders regardless of auth state, since the dashboard layout's auth gate wraps it — confirm the response body contains either the sign-in prompt or the wizard's "New Plan" heading, either is an acceptable signal the route compiles and serves). Also curl `/dashboard/plans` and confirm the response contains `New Plan` (the new link's text) in the body. Stop the dev server cleanly afterward and confirm the port is released via both `ss -tlnp` and `lsof -i:3001`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/\(dashboard\)/dashboard/plans/new/page.tsx apps/web/app/\(dashboard\)/dashboard/plans/page.tsx
git commit -m "Add plan-creation wizard page and New Plan link"
```

---

## Plan Self-Review Notes

**Spec coverage check:**
- Backend auth widening (`/v1/prepare/plan` accepts session auth, inert `@RequireKeyType` removed) → Task 1. ✓
- Screen 1 details form (USDC-only amount, preset period/trial, 1+ recipients defaulting to one row at 100%, percentages must sum to 100) → Task 2. ✓
- Screen 2 review + submit, single-recipient skips Split deployment, multi-recipient deploys via `@0xsplits/splits-sdk`, `createPlan` submission via `useSendTransaction` (not `useWriteContract`, since calldata is pre-encoded), state machine matching `useSubscriptionWrite.ts`'s shape → Tasks 3–4. ✓
- Redirect to `/dashboard/plans` on success, no new detail route → Task 5 (`router.push("/dashboard/plans")` in the page, `onDone` callback wired through). ✓
- "New Plan" link surfaced somewhere reachable from the existing UI → Task 5 (added to the plans list page; per the spec, no new top-level nav entry needed since "Plans" already exists). ✓
- No 0xSplits on-chain validation, no multi-token, no plan editing → confirmed absent from every task. ✓

**Placeholder scan:** No "TBD"/"TODO"/vague requirements. Every step has complete, concrete code. One deliberately-flagged correction exists in Task 3 Step 5 (the unused `submittedRef` leftover from an earlier draft) — an explicit, actionable instruction to delete it, not a placeholder.

**Type consistency check:** `PlanDetailsFormValues`/`PlanRecipientInput` (Task 2) are consumed identically by Task 3's `useCreatePlanSubmit(values: PlanDetailsFormValues)`, Task 4's `PlanReviewSubmitProps.values: PlanDetailsFormValues`, and Task 5's wizard page's `WizardScreen` union. `CreatePlanStatus` (Task 3) is consumed identically by Task 4's `STATUS_MESSAGE` record and `IN_FLIGHT_STATUSES` array — every non-idle/error/done state Task 3 defines has a corresponding message in Task 4, verified by cross-referencing the two lists. `useCreatePlanSubmit`'s return shape (`{status, error, submit}`) matches exactly between Task 3's implementation and Task 4's mock-and-consume usage.

**Gap found and fixed during self-review:** Task 3's first implementation draft included a `submittedRef` (`useRef(false)`) intended for a "prevent double-submit" guard, but no step in the plan actually reads or branches on it — it would have been genuinely dead code (assigned once, never read), which is exactly the kind of unused-variable defect a task reviewer would flag as an Important finding. Fixed by adding an explicit removal instruction directly in Task 3 Step 5's text rather than silently leaving it in the "complete" code block, following this project's established practice (see Phase 1m's `text-sapphire-200` note) of flagging known corrections directly in a task's own text when caught during the plan's own self-review, rather than letting an implementer copy a mistake verbatim.

**Design-vs-plan deviation, called out explicitly:** the design spec's Testing section proposed unit-testing `useCreatePlanSubmit` "with mocked wagmi hooks" without specifying whether individual wagmi hooks (`usePublicClient`, `useWalletClient`, `useSendTransaction`, `useWaitForTransactionReceipt`) should be mocked via `vi.mock("wagmi", ...)` at the module level. This plan resolves that ambiguity explicitly: Task 3's test mocks the entire `wagmi` module (all four hooks) plus `@0xsplits/splits-sdk`'s `SplitV2Client` and `apiFetch`, following the `SubscriptionActions.test.tsx` precedent's `vi.mock` pattern but applied one level deeper (mocking wagmi/SDK directly, since this hook — unlike `SubscriptionActions` — is the thing under test, not a consumer of an already-tested hook).
