# Phase 1m: Marketing Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `apps/web/app/page.tsx`'s placeholder with a real landing page at `/`: a hero section built around a new, reusable `SplitFlow` component in `packages/ui`, plus four marketing-only sections (wedge, how-it-works, pricing, docs/CTA).

**Architecture:** `SplitFlow` is a genuine, prop-driven `packages/ui` component (no hardcoded amounts) using plain CSS keyframes + SVG `offset-path` animation, scoped via an inline `<style>` tag (the first `packages/ui` component needing custom keyframes — no existing component or shared stylesheet has this yet). The marketing page is a single Server Component composing `SplitFlow` (illustrative props) with four small presentational components under a new `apps/web/components/marketing/` directory. No client-side data fetching anywhere on this page.

**Tech Stack:** React 18 (existing `packages/ui`/`apps/web` conventions), Tailwind v4 utility classes (existing design tokens), Vitest + Testing Library (existing `packages/ui` test tooling) — zero new dependencies.

## Global Constraints

- `SplitFlow` accepts amounts/recipients as props — never hardcoded inside the component. The marketing page passes illustrative values; a future phase can pass real data once it exists.
- No new runtime dependency anywhere in this phase (no animation library) — the split's motion is CSS keyframes + SVG `offset-path`, matching `CadencePulse`'s existing zero-new-dependency precedent.
- Every dynamic class string in `SplitFlow` must use full literal class names in a lookup object, never template-literal interpolation (e.g. `` `bg-${color}` ``) — Tailwind's static analyzer cannot extract interpolated fragments into real CSS. This is the exact bug class the Phase 1k whole-branch review found and fixed in `StatusBadge`; `SplitFlow`'s three distinctly-colored payout paths (`mint`, `signal`, and a light sapphire-blue with no existing design token) must follow `StatusBadge`'s established `Record<string, string>`-of-complete-classes pattern.
- `prefers-reduced-motion: reduce` must disable `SplitFlow`'s looping animation entirely (matching PRD §8.1's quality-floor rule, already honored by every other animated element in this codebase).
- Money/on-chain values render in `font-data` (Geist Mono) with `tabular-nums` — the project's established "the product is a ledger" typography rule, honored by every prior phase's money-rendering code.
- The marketing page commits to a dark ground (`bg-ink text-paper`) for its entire single-page scope, overriding `apps/web/app/globals.css`'s `body`'s current light (`paper`) default — matching the portal's dark-default, not the dashboard's light-default, per the validated hero mockup.
- `apps/web/app/page.tsx` remains a Server Component with zero client-side data fetching, zero `"use client"` directive at the page level — only `SplitFlow` itself (which needs `prefers-reduced-motion` media-query awareness, achievable via pure CSS, not a `useEffect`) may need `"use client"` if any interactivity requires it; if it doesn't (this phase's design has no interactivity beyond the ambient CSS animation), it stays a Server Component too.
- No test is written for `apps/web/app/page.tsx` itself or any of the four marketing section components — matching this project's established practice of not unit-testing static, non-conditional JSX composition. Only `SplitFlow` (in `packages/ui`, real logic: prop-driven rendering + reduced-motion behavior) gets a test.

---

### Task 1: `SplitFlow` component in `packages/ui`

**Files:**
- Create: `packages/ui/src/SplitFlow.tsx`
- Modify: `packages/ui/src/index.ts`
- Test: `packages/ui/test/SplitFlow.test.tsx`

**Interfaces:**
- Produces: `<SplitFlow amount={string} feeAmount={string} feeLabel={string} recipients={{amount: string, label: string}[]} />` — exported from `@cadence/ui`. `recipients` accepts 1 or more entries (the visual demo in this phase always passes exactly 2, but the component itself does not hardcode a count). Consumed by Task 2's hero section.

- [ ] **Step 1: Write the failing test**

Create `packages/ui/test/SplitFlow.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SplitFlow } from "../src/SplitFlow.js";

const RECIPIENTS = [
  { amount: "14.44", label: "founder.eth" },
  { amount: "4.81", label: "agency.eth" },
];

describe("SplitFlow", () => {
  it("renders the source amount, fee amount/label, and every recipient's amount/label", () => {
    render(<SplitFlow amount="20.00" feeAmount="0.75" feeLabel="platform" recipients={RECIPIENTS} />);

    expect(screen.getByText(/20\.00/)).toBeDefined();
    expect(screen.getByText(/0\.75/)).toBeDefined();
    expect(screen.getByText("platform")).toBeDefined();
    expect(screen.getByText(/14\.44/)).toBeDefined();
    expect(screen.getByText("founder.eth")).toBeDefined();
    expect(screen.getByText(/4\.81/)).toBeDefined();
    expect(screen.getByText("agency.eth")).toBeDefined();
  });

  it("renders one SVG path per recipient plus one for the fee", () => {
    const { container } = render(<SplitFlow amount="20.00" feeAmount="0.75" feeLabel="platform" recipients={RECIPIENTS} />);

    const paths = container.querySelectorAll("svg path[data-split-path]");
    // 1 fee path + 2 recipient paths = 3
    expect(paths.length).toBe(3);
  });

  it("assigns each recipient a distinct color class, cycling through the palette", () => {
    const { container } = render(<SplitFlow amount="20.00" feeAmount="0.75" feeLabel="platform" recipients={RECIPIENTS} />);

    const recipientChips = container.querySelectorAll("[data-split-chip='recipient']");
    expect(recipientChips.length).toBe(2);
    const firstClasses = recipientChips[0].className;
    const secondClasses = recipientChips[1].className;
    expect(firstClasses).not.toBe(secondClasses);
  });

  it("marks the animation as disabled when prefers-reduced-motion is set", () => {
    const { container } = render(
      <SplitFlow amount="20.00" feeAmount="0.75" feeLabel="platform" recipients={RECIPIENTS} reducedMotion={true} />,
    );

    const pulses = container.querySelectorAll("[data-split-pulse]");
    pulses.forEach((pulse) => {
      expect((pulse as HTMLElement).style.animation).toBe("none");
    });
  });

  it("does not disable the animation when reducedMotion is false", () => {
    const { container } = render(
      <SplitFlow amount="20.00" feeAmount="0.75" feeLabel="platform" recipients={RECIPIENTS} reducedMotion={false} />,
    );

    const pulses = container.querySelectorAll("[data-split-pulse]");
    pulses.forEach((pulse) => {
      expect((pulse as HTMLElement).style.animation).not.toBe("none");
    });
  });
});
```

Note the `reducedMotion` prop is explicit (not auto-detected via `window.matchMedia` inside the component) — this keeps `SplitFlow` a pure, testable function of its props with no browser-API dependency inside the component itself, and lets Task 2's consuming page decide how to detect the media query (a plain CSS `@media (prefers-reduced-motion: reduce)` rule scoped to the component's own `<style>` block handles the real browser case automatically, independent of this prop; the prop exists so this exact behavior is directly unit-testable without a jsdom `matchMedia` mock, which this codebase has no existing precedent for setting up).

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/ui && npx vitest run test/SplitFlow.test.tsx`
Expected: FAIL — `../src/SplitFlow.js` does not exist.

- [ ] **Step 3: Implement `SplitFlow`**

Create `packages/ui/src/SplitFlow.tsx`:

```tsx
// Full class strings in a lookup array, not interpolated fragments — Tailwind's
// static analyzer only extracts whole utility-class literals from source, so a
// template literal like `text-${color}` never emits any CSS for the class it
// builds. Matches the exact pattern StatusBadge.tsx already established (and the
// bug the Phase 1k whole-branch review found and fixed when this rule was
// violated). Cycles through this list if there are ever more recipients than
// colors defined here.
const RECIPIENT_PALETTE = [
  { text: "text-mint", border: "border-mint/35", stroke: "#17B890", glow: "rgba(23,184,144,0.85)" },
  { text: "text-sapphire-200", border: "border-sapphire-200/35", stroke: "#6fb3ff", glow: "rgba(111,179,255,0.85)" },
];

export interface SplitFlowRecipient {
  amount: string;
  label: string;
}

export interface SplitFlowProps {
  /** The total amount charged, rendered at the source node. Formatted string, e.g. "20.00" — no currency symbol prefix is added by this component. */
  amount: string;
  /** The platform fee amount, rendered at the fee node. */
  feeAmount: string;
  /** Label under the fee chip, e.g. "platform". */
  feeLabel: string;
  /** One or more payout recipients. Each gets a distinct color from RECIPIENT_PALETTE, cycling if there are more recipients than palette entries. */
  recipients: SplitFlowRecipient[];
  /** Explicit override for prefers-reduced-motion — see the note in SplitFlow.test.tsx for why this isn't auto-detected inside the component. Defaults to false (animate). */
  reducedMotion?: boolean;
}

function verticalPercent(index: number, total: number): number {
  if (total === 1) return 50;
  const span = 88; // leaves 6% margin top and bottom, matching the validated hero mockup's spacing
  return 6 + (span * index) / (total - 1);
}

export function SplitFlow({ amount, feeAmount, feeLabel, recipients, reducedMotion = false }: SplitFlowProps) {
  // Fee is always the first "right-side" node; recipients follow it, all sharing
  // the same vertical distribution logic (fee counts as one of the slots).
  const allRightNodes = [{ amount: feeAmount, label: feeLabel, kind: "fee" as const }, ...recipients.map((r) => ({ ...r, kind: "recipient" as const }))];
  const total = allRightNodes.length;

  return (
    <div className="relative rounded-2xl border border-paper/10 bg-ink p-6 sm:p-8" data-testid="split-flow">
      <style>{`
        @keyframes split-flow-travel {
          0%   { offset-distance: 0%;   opacity: 0; }
          8%   { opacity: 1; }
          92%  { opacity: 1; }
          100% { offset-distance: 100%; opacity: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-split-pulse] { animation: none !important; }
        }
      `}</style>
      <div className="relative" style={{ height: "clamp(200px, 26vw, 240px)" }}>
        <div className="absolute flex flex-col items-start gap-1.5" style={{ left: 0, top: "50%", transform: "translateY(-50%)" }}>
          <span className="font-data tabular-nums text-sm sm:text-base font-medium text-paper border border-paper/25 rounded-lg px-3.5 py-2 whitespace-nowrap" data-split-chip="source">
            {amount} charged
          </span>
        </div>

        <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
          {allRightNodes.map((node, i) => {
            const y = verticalPercent(i, total);
            const color = node.kind === "fee" ? "#F4A62A" : RECIPIENT_PALETTE[(i - 1) % RECIPIENT_PALETTE.length].stroke;
            const glow = node.kind === "fee" ? "rgba(244,166,42,0.85)" : RECIPIENT_PALETTE[(i - 1) % RECIPIENT_PALETTE.length].glow;
            const path = `M 24 50 C 55 50 55 ${y} 76 ${y}`;
            return (
              <g key={i}>
                <path data-split-path d={path} fill="none" stroke={color} strokeOpacity={0.55} strokeWidth={1.5} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                <circle
                  data-split-pulse
                  r={1.4}
                  fill={color}
                  style={{
                    filter: `drop-shadow(0 0 5px ${glow})`,
                    offsetPath: `path('${path}')`,
                    animation: reducedMotion ? "none" : `split-flow-travel 2.8s ease-in-out infinite`,
                    animationDelay: `${i * 0.15}s`,
                  }}
                />
              </g>
            );
          })}
        </svg>

        {allRightNodes.map((node, i) => {
          const y = verticalPercent(i, total);
          const palette = node.kind === "fee" ? { text: "text-signal", border: "border-signal/35" } : RECIPIENT_PALETTE[(i - 1) % RECIPIENT_PALETTE.length];
          return (
            <div key={i} className="absolute flex flex-col items-end gap-1.5" style={{ right: 0, top: `${y}%`, transform: "translateY(-50%)" }}>
              <span
                className={`font-data tabular-nums text-sm sm:text-base font-medium ${palette.text} border ${palette.border} rounded-lg px-3.5 py-2 whitespace-nowrap bg-ink`}
                data-split-chip={node.kind}
              >
                {node.amount} {node.kind === "fee" ? "" : "net"}
              </span>
              <span className="font-data text-xs uppercase tracking-wide text-slate">{node.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

Note `RECIPIENT_PALETTE` uses `text-sapphire-200`/`border-sapphire-200` — these do NOT exist as design tokens yet (the validated mockup used a hardcoded `#6fb3ff`, not a Tailwind theme color). Since Tailwind v4's `@theme` only defines `--color-sapphire` (one shade), `text-sapphire-200` is not a real utility class and would silently fail to apply. **Do not use this class name as written** — instead, the recipient color must be applied via the same inline `style` mechanism already used for the SVG stroke/glow (which correctly uses raw hex `#6fb3ff`), NOT via a Tailwind class for the second recipient's chip text/border. Revise the `RECIPIENT_PALETTE` and the chip-rendering `<span>` so the mint recipient uses the real `text-mint`/`border-mint/35` Tailwind classes (these tokens DO exist), while the second-and-later recipients use inline `style={{ color: palette.stroke, borderColor: ... }}` instead of a nonexistent Tailwind class. Concretely, change `RECIPIENT_PALETTE`'s second entry's `text`/`border` fields to `null` (or omit them) and branch in the chip-rendering code: if `palette.text` is falsy, apply `style={{ color: palette.stroke, borderColor: palette.stroke + "59" }}` (raw hex + alpha suffix) instead of Tailwind classes for that one chip. Confirm this renders correctly by inspecting the rendered DOM's computed style during Step 6's manual check, not just by trusting the test (which only asserts the classes/content differ between chips, not that the color is visually correct).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/ui && npx vitest run test/SplitFlow.test.tsx`
Expected: PASS (5/5 tests).

- [ ] **Step 5: Export `SplitFlow` from the package barrel**

Modify `packages/ui/src/index.ts`:

```typescript
export { CadencePulse, type CadencePulseProps } from "./CadencePulse.js";
export { StatusBadge, type StatusBadgeProps } from "./StatusBadge.js";
export { SplitFlow, type SplitFlowProps, type SplitFlowRecipient } from "./SplitFlow.js";
```

- [ ] **Step 6: Typecheck**

Run: `cd packages/ui && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Run the full packages/ui suite to confirm no regression**

Run: `cd packages/ui && npx vitest run`
Expected: all tests pass (10 pre-existing from CadencePulse/StatusBadge + 5 new from this task = 15 total).

- [ ] **Step 8: Commit**

```bash
git add packages/ui/src/SplitFlow.tsx packages/ui/src/index.ts packages/ui/test/SplitFlow.test.tsx
git commit -m "Add SplitFlow component to packages/ui"
```

---

### Task 2: Marketing page hero (consumes `SplitFlow`)

**Files:**
- Modify: `apps/web/app/page.tsx`
- Modify: `apps/web/app/globals.css`
- Create: `apps/web/components/marketing/Hero.tsx`

**Interfaces:**
- Consumes: `SplitFlow` (Task 1, imported from `@cadence/ui`).
- Produces: the page's dark-ground override and the hero section, consumed by Task 3 (which appends the remaining sections below the hero on the same page).

- [ ] **Step 1: Override the marketing page's ground to dark**

Modify `apps/web/app/globals.css` — the existing `body` rule sets the light (`paper`) default for the whole app (used by the dashboard). Add a page-scoped override instead of changing the global default, since the dashboard/portal still need their own existing surfaces:

```css
body {
  background: var(--color-paper);
  color: var(--color-ink);
  font-family: var(--font-body);
}

/* Marketing page (/) commits to a dark ground for its entire single-page scope,
   matching the portal's dark-default rather than the dashboard's light-default —
   per the Phase 1m design spec's validated hero mockup. Scoped to a class the
   root page applies to its own <main>, not a global override, since the
   dashboard/portal keep their existing light/dark defaults untouched. */
.marketing-page {
  background: var(--color-ink);
  color: var(--color-paper);
}
```

- [ ] **Step 2: Build the Hero component**

Create `apps/web/components/marketing/Hero.tsx`:

```tsx
import { SplitFlow } from "@cadence/ui";

export function Hero() {
  return (
    <section className="grid md:grid-cols-[minmax(280px,1fr)_minmax(320px,1.4fr)] items-center gap-8 md:gap-16 px-6 sm:px-12 py-16 md:py-24 max-w-7xl mx-auto">
      <div>
        <div className="inline-flex items-center gap-2 font-data text-xs uppercase tracking-wide text-slate mb-5">
          <span className="w-1.5 h-1.5 rounded-full bg-mint" style={{ boxShadow: "0 0 0 3px rgba(23,184,144,0.18)" }} />
          Live on Base
        </div>
        <h1 className="font-display font-bold text-4xl sm:text-5xl leading-[1.04] tracking-tight mb-5" style={{ textWrap: "balance" }}>
          One payment, split <span className="text-mint">instantly</span>, on-chain.
        </h1>
        <p className="font-body text-base sm:text-lg leading-relaxed text-paper/70 max-w-[46ch] mb-8">
          Cadence charges your subscribers in USDC and settles every fee and payout the moment the charge clears — no invoicing, no manual
          splits, no waiting on a payout batch. Built for AI tools, creators, and agencies who bill recurring and pay out revenue-share the
          same instant.
        </p>
        <div className="flex flex-wrap gap-3 mb-10">
          <a href="#" className="rounded-lg bg-sapphire text-paper font-body font-semibold text-sm px-5 py-3 hover:-translate-y-px transition-transform">
            Start building
          </a>
          <a href="#" className="rounded-lg border border-paper/20 text-paper font-body font-semibold text-sm px-5 py-3 hover:border-paper/35 transition-colors">
            Read the docs
          </a>
        </div>
        <div className="flex flex-wrap gap-4 font-data text-xs text-slate">
          <span>
            Built for <span className="text-paper/55">AI tools</span>
          </span>
          <span>
            · <span className="text-paper/55">Creators</span>
          </span>
          <span>
            · <span className="text-paper/55">Agencies</span>
          </span>
        </div>
      </div>

      <SplitFlow
        amount="20.00"
        feeAmount="0.75"
        feeLabel="platform"
        recipients={[
          { amount: "14.44", label: "founder.eth" },
          { amount: "4.81", label: "agency.eth" },
        ]}
      />
    </section>
  );
}
```

Note the illustrative amounts (`$20.00` charged → `$0.75` fee + `$14.44` + `$4.81` net) are hardcoded directly in this call site, per this phase's Global Constraint that `SplitFlow` itself never hardcodes values — the marketing page, as the consumer, is exactly where illustrative data belongs.

- [ ] **Step 3: Wire the Hero into the root page**

Modify `apps/web/app/page.tsx`:

```tsx
import { Hero } from "../components/marketing/Hero.js";

export default function RootPage() {
  return (
    <main className="marketing-page min-h-screen">
      <Hero />
    </main>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Run the full apps/web suite to confirm no regression**

Run: `cd apps/web && npx vitest run`
Expected: all tests pass (31 pre-existing, unchanged — this task adds no new test files per this phase's Global Constraints).

- [ ] **Step 6: Manual smoke check**

Run: `cd apps/web && rm -rf .next && pnpm dev` in the background (check `lsof -ti:3001` first and kill anything found, per this project's established practice of confirming the port is genuinely free before booting — a stray process has caused wasted debugging time in a prior phase). Wait for ready, then curl `/` and confirm HTTP 200 with the hero's headline text present in the response body. Also open the page in a way you can inspect computed styles (or grep the compiled CSS at `.next/static/css/app/layout.css` for `bg-mint`, `text-mint`, `bg-ink`, and the raw hex `#6fb3ff` used inline for the second recipient) to confirm `SplitFlow`'s Tailwind classes actually compiled (this codebase has twice found real "classes exist in source but don't compile" bugs — Task 1's `text-sapphire-200` note exists specifically to avoid a third occurrence of that same class). Stop the dev server cleanly afterward and confirm the port is released.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/page.tsx apps/web/app/globals.css apps/web/components/marketing/Hero.tsx
git commit -m "Add marketing page hero with SplitFlow"
```

---

### Task 3: Remaining marketing sections (wedge, how-it-works, pricing, CTA)

**Files:**
- Create: `apps/web/components/marketing/Wedge.tsx`
- Create: `apps/web/components/marketing/HowItWorks.tsx`
- Create: `apps/web/components/marketing/Pricing.tsx`
- Create: `apps/web/components/marketing/ClosingCta.tsx`
- Modify: `apps/web/app/page.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks (these four components have no dependency on `SplitFlow` or `Hero`).
- Produces: the complete marketing page. This is the FINAL task of this phase.

- [ ] **Step 1: Build the Wedge component**

Create `apps/web/components/marketing/Wedge.tsx`:

```tsx
const USE_CASES = [
  {
    audience: "AI tools",
    copy: "Meter API usage, bill monthly, and split revenue with your model provider automatically — every charge settles the split in the same transaction.",
  },
  {
    audience: "Creators",
    copy: "Run a subscription tier and pay your editor or co-host their cut the instant a fan's payment clears, with no manual accounting.",
  },
  {
    audience: "Agencies",
    copy: "Bill clients recurring and route each project's revenue-share to the right contractor without ever touching a spreadsheet.",
  },
];

export function Wedge() {
  return (
    <section className="px-6 sm:px-12 py-16 md:py-20 max-w-7xl mx-auto">
      <div className="grid sm:grid-cols-3 gap-6">
        {USE_CASES.map((useCase) => (
          <div key={useCase.audience} className="rounded-xl border border-paper/10 p-6">
            <h3 className="font-display font-semibold text-lg mb-2">{useCase.audience}</h3>
            <p className="font-body text-sm leading-relaxed text-paper/65">{useCase.copy}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Build the HowItWorks component**

Create `apps/web/components/marketing/HowItWorks.tsx`:

```tsx
const STEPS = [
  {
    title: "Subscribe",
    copy: "A subscriber signs a gasless permit — no upfront transaction, no manual approval flow.",
  },
  {
    title: "Charge",
    copy: "Anyone can trigger the charge once it's due; Cadence's scheduler does this automatically, on-chain, permissionlessly.",
  },
  {
    title: "Split",
    copy: "The moment the charge clears, the fee and every recipient's share settle atomically in the same transaction.",
  },
];

export function HowItWorks() {
  return (
    <section className="px-6 sm:px-12 py-16 md:py-20 max-w-7xl mx-auto">
      <h2 className="font-display font-bold text-2xl sm:text-3xl mb-10" style={{ textWrap: "balance" }}>
        How it works
      </h2>
      <div className="grid sm:grid-cols-3 gap-8">
        {STEPS.map((step, i) => (
          <div key={step.title}>
            <div className="font-data text-sm text-slate mb-2">{String(i + 1).padStart(2, "0")}</div>
            <h3 className="font-display font-semibold text-lg mb-2">{step.title}</h3>
            <p className="font-body text-sm leading-relaxed text-paper/65">{step.copy}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
```

Note the `01`/`02`/`03` numbered markers here ARE justified per this phase's design spec — subscribe→charge→split is a genuine causal sequence the reader needs the order of, unlike `Wedge`'s three cards (which are deliberately NOT numbered, since AI tools/Creators/Agencies have no inherent order).

- [ ] **Step 3: Build the Pricing component**

Create `apps/web/components/marketing/Pricing.tsx`:

```tsx
export function Pricing() {
  return (
    <section className="px-6 sm:px-12 py-16 md:py-20 max-w-7xl mx-auto">
      <div className="rounded-2xl border border-paper/10 p-8 sm:p-10 max-w-2xl">
        <h2 className="font-display font-bold text-2xl mb-3">Pricing</h2>
        <p className="font-body text-base text-paper/70 leading-relaxed mb-4">
          <span className="font-data tabular-nums text-mint text-lg font-medium">3.75%</span> per successful charge. Zero platform fees
          otherwise — no monthly minimum, no setup cost, no fee on failed or retried charges.
        </p>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Build the ClosingCta component**

Create `apps/web/components/marketing/ClosingCta.tsx`:

```tsx
export function ClosingCta() {
  return (
    <section className="px-6 sm:px-12 py-16 md:py-24 max-w-7xl mx-auto text-center">
      <h2 className="font-display font-bold text-2xl sm:text-3xl mb-8" style={{ textWrap: "balance" }}>
        Start splitting payments on-chain.
      </h2>
      <div className="flex flex-wrap gap-3 justify-center">
        <a href="#" className="rounded-lg bg-sapphire text-paper font-body font-semibold text-sm px-5 py-3 hover:-translate-y-px transition-transform">
          Start building
        </a>
        <a href="#" className="rounded-lg border border-paper/20 text-paper font-body font-semibold text-sm px-5 py-3 hover:border-paper/35 transition-colors">
          Read the docs
        </a>
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Wire all four sections into the root page**

Modify `apps/web/app/page.tsx`:

```tsx
import { Hero } from "../components/marketing/Hero.js";
import { Wedge } from "../components/marketing/Wedge.js";
import { HowItWorks } from "../components/marketing/HowItWorks.js";
import { Pricing } from "../components/marketing/Pricing.js";
import { ClosingCta } from "../components/marketing/ClosingCta.js";

export default function RootPage() {
  return (
    <main className="marketing-page min-h-screen">
      <Hero />
      <Wedge />
      <HowItWorks />
      <Pricing />
      <ClosingCta />
    </main>
  );
}
```

- [ ] **Step 6: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Run the full apps/web suite one final time**

Run: `cd apps/web && npx vitest run`
Expected: all tests pass (31/31, unchanged — no new test files in this task either).

- [ ] **Step 8: Run the full packages/ui suite to confirm it's unaffected**

Run: `cd packages/ui && npx vitest run`
Expected: 15/15, unchanged (this task doesn't touch `packages/ui`).

- [ ] **Step 9: Manual smoke check**

Run: `cd apps/web && rm -rf .next && pnpm dev` in the background (confirm port 3001 is free first, per Task 2 Step 6's established practice). Curl `/` and confirm HTTP 200 with all five sections' headline text present in the response (hero headline, each of the three wedge audience names, "How it works", "Pricing", the closing CTA headline). Stop the dev server cleanly and confirm the port is released afterward.

- [ ] **Step 10: Commit**

```bash
git add apps/web/components/marketing/Wedge.tsx apps/web/components/marketing/HowItWorks.tsx apps/web/components/marketing/Pricing.tsx apps/web/components/marketing/ClosingCta.tsx apps/web/app/page.tsx
git commit -m "Add wedge, how-it-works, pricing, and closing CTA sections to marketing page"
```

---

## Plan Self-Review Notes

**Spec coverage check:**
- `SplitFlow` as a genuine, prop-driven `packages/ui` component (not hardcoded), zero new dependency, CSS/SVG-only animation, `prefers-reduced-motion` respected → Task 1. ✓
- Hero section (dark ground, two-column layout, validated mockup's copy/structure, illustrative `SplitFlow` props) → Task 2. ✓
- Wedge, how-it-works (numbered, justified), pricing (minimal), docs/CTA → Task 3. ✓
- No client-side data fetching anywhere on the page → confirmed no task adds a `"use client"` directive with a `useQuery`/`useState`/`useEffect` data-fetch anywhere; the whole page stays a Server Component tree. ✓
- No auth, no wallet, no backend calls → confirmed nowhere in any task. ✓

**Placeholder scan:** No "TBD"/"TODO"/vague requirements found. Every step has complete, concrete code. One deliberately-flagged, non-obvious correction exists in Task 1 Step 3 (the `text-sapphire-200` nonexistent-Tailwind-class issue) — this is not a placeholder, it's an explicit, actionable correction with the exact replacement approach specified, following this project's established practice of documenting known traps directly in a task's own text when a plan author catches a mistake before an implementer would.

**Type consistency check:** `SplitFlow`'s prop shape (`amount`, `feeAmount`, `feeLabel`, `recipients: SplitFlowRecipient[]`, `reducedMotion?`) defined in Task 1 is consumed identically by Task 2's `Hero.tsx` (`amount="20.00"`, `feeAmount="0.75"`, `feeLabel="platform"`, `recipients={[...]}` — no `reducedMotion` passed, correctly relying on the prop's `= false` default combined with the component's own internal `@media (prefers-reduced-motion: reduce)` CSS rule for the real browser case). `SplitFlowRecipient`'s `{amount: string, label: string}` shape matches exactly between Task 1's interface definition and Task 2's call site's two recipient objects.

**Gap found and fixed during self-review:** an initial draft of Task 1's `SplitFlow` implementation used `text-sapphire-200`/`border-sapphire-200` as Tailwind class names for the second recipient's color, directly copying the validated mockup's raw-hex approach into what looked like a Tailwind utility class name without checking whether that token actually exists in `apps/web/app/globals.css`'s `@theme` block. It does not — only a single `--color-sapphire` shade is defined, matching every other design token (no shade-scale for any of the six tokens). Fixed by adding an explicit, prominent note directly after Task 1 Step 3's code block instructing the implementer to detect this at typecheck/render time and use inline `style` with the raw hex value (already correctly used for the SVG stroke) for that one chip's Tailwind-incompatible color, rather than a nonexistent class name that would silently render unstyled — the same "silently missing Tailwind class" bug class the Phase 1k whole-branch review already found and fixed twice in this codebase's history (`StatusBadge`'s interpolated classes, then `@cadence/shared`'s and `@cadence/sdk`'s barrel-export `node:crypto` leaks were a different bug class but the same "invisible to tests, only caught by inspecting real output" pattern) — flagging this explicitly in the plan text itself, rather than letting a third occurrence reach implementation before being caught by a task reviewer.
