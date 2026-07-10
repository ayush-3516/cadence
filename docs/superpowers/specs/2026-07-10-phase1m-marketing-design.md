# Phase 1m: Marketing Site — Design Spec

## Goal

Replace `apps/web/app/page.tsx`'s placeholder (a bare "Cadence" heading + "under
construction" text, left over from Phase 1k's initial scaffold) with a real landing
page at `/`, per PRD §8.6. No auth, no wallet integration, no backend calls — the
smallest, least-blocked remaining piece of PRD §8's frontend scope.

## Background: scoping SplitFlow

The PRD's hero explicitly wants `SplitFlow` — "the animated split moment" — as a
"live demo" of the product's core mechanic (one payment splitting into fee + net
payouts, settled on-chain). `SplitFlow` was deliberately deferred during the
dashboard phase (Phase 1k) because it needs real payout/split data that doesn't
exist in the backend yet (no `/v1/payouts` endpoint).

**Resolved:** the marketing page never needed live data to begin with — a "live
demo" of illustrative amounts flowing from a charge into fee + recipient shares is
exactly what a marketing hero's demo means, not a promise of real user data. This
phase builds `SplitFlow` as a genuine, reusable `packages/ui` component (accepting
amounts/recipients as props, not hardcoded), with the marketing page as its first
real consumer, passing illustrative numbers. A future phase wiring `/v1/payouts`
data into a dashboard charge-detail page gets a ready-built component to consume
real data with — this phase does not need to build that data path itself.

**Resolved (animation approach):** plain CSS/SVG transitions and `offset-path`
animation, no new dependency — matching the zero-new-runtime-dependency precedent
every `packages/ui` component has followed so far (`CadencePulse`'s tick-pulsing
uses the same approach). The split's motion (a payment splitting into three paths,
converging on distinctly-colored recipient chips, looping continuously) is fully
achievable with CSS keyframes and SVG path animation.

## Hero design (validated via mockup)

Dark ground (`--ink`), matching the portal's dark-default rather than the
dashboard's light-default — this phase commits to one dark visual world for the
whole page, not alternating sections. Two-column layout: headline
("One payment, split *instantly*, on-chain."), subhead, and dual CTAs
(primary "Start building" / ghost "Read the docs") on the left third; the
`SplitFlow` demo as the visual anchor on the right two-thirds. Every amount,
address, and on-chain label renders in Geist Mono with tabular figures, per the
project's own established "the product is a ledger" typography rule. The demo
shows a $20.00 charge splitting into a signal-colored fee path and two
distinctly-colored payout paths (mint and a light sapphire-blue, so the two
recipients read as genuinely different parties, not duplicates) — animated pulses
travel each path continuously, with a small pulsing "confirming" indicator and
"settled on-chain, same block" caption reinforcing the real-time framing.

## Remaining sections

- **Wedge** — three quiet cards (AI tools / Creators / Agencies), each naming one
  concrete use case grounded in what the product actually does (e.g., metering
  API usage and splitting revenue with a model provider automatically) — not
  generic marketing copy.
- **How it works** — a real 3-step sequence (subscribe → charge → split).
  Numbered markers are justified here specifically because this is a genuine
  causal chain the reader needs the order of, unlike a generic feature list.
  Each step is one line grounded in the actual mechanism (permit-based
  subscribe, permissionless charge, atomic on-chain split) — not abstracted
  marketing language.
- **Pricing** — minimal, per the PRD's own "Minimal landing" framing: the
  take-rate stated plainly (e.g., "3.75% per successful charge, zero platform
  fees otherwise"), no complex tiered pricing table.
- **Docs/CTA** — closing section repeating the hero's two CTAs, quiet, no new
  visual flourish — the hero already spent this page's one bold moment.

## Architecture

- A single Server Component page (`apps/web/app/page.tsx`) — no client-side data
  fetching anywhere on this page, since every section is static content.
- Small presentational components under `apps/web/components/marketing/`,
  separate from the dashboard's/portal's component directories (landing-page-only,
  not intended for reuse elsewhere in `apps/web`).
- `SplitFlow` itself lives in `packages/ui` (not `apps/web/components/marketing/`),
  since the PRD lists it in the shared component inventory (§8.7) and this phase
  is deliberately building it as a genuine, prop-driven, future-reusable
  component — not a marketing-page-only mockup.

## Testing

- Component test for `SplitFlow` (in `packages/ui/test/`, following the exact
  structural pattern already established by `CadencePulse.test.tsx`/
  `StatusBadge.test.tsx` from the dashboard phase): verifies the component
  renders the correct amount/recipient values from its props, and that
  `prefers-reduced-motion` disables the looping animation (matching the
  accessibility requirement already honored by every other animated element in
  this codebase's design system, per PRD §8.1's "Respect `prefers-reduced-motion`"
  quality-floor rule).
- No test for the marketing page itself beyond a typecheck/build pass — it is
  static JSX composition with no conditional rendering or client-side logic to
  unit test, matching this project's established practice of not writing
  component tests for pure-presentational pages with nothing to assert against.

## Explicitly out of scope for this phase

- Any real payout/split data — `SplitFlow` on the marketing page uses
  illustrative, hardcoded prop values, not a live backend call.
- Wiring `SplitFlow` into any dashboard or portal page — that remains a future
  phase's job once `/v1/payouts` (or an equivalent data source) exists.
- Any other `packages/ui` component from PRD §8.7's inventory not needed by this
  page (`DataTable`, `RevShareBuilder`, `SubscribeWizard`, etc.) — only
  `SplitFlow` is built in this phase.
- Auth, wallet connection, or any backend/API call from the marketing page.
- A/B testing, analytics instrumentation, or SEO-specific tooling beyond
  standard Next.js metadata.
