# Phase 1k: Merchant Dashboard (read-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first real page of `apps/web` — a Next.js 15 merchant dashboard with SIWE sign-in and five read-only routes, all backed by REST endpoints already live on `main`.

**Architecture:** `apps/web` is a Next.js 15 App Router app. A thin `apiFetch` helper (fetch with `credentials: "include"`) talks directly to `apps/api` using session cookies — the dashboard does NOT use `@cadence/sdk` (API-key-only, wrong auth model for a browser session). SIWE sign-in uses wagmi v2 + viem + ConnectKit to get a wallet signature, then calls `/v1/auth/nonce`/`/v1/auth/verify` via `apiFetch`. Two new `packages/ui` components (`CadencePulse`, `StatusBadge`) plus Tailwind v4 design tokens are bootstrapped alongside the dashboard, since the dashboard is their only consumer so far.

**Tech Stack:** Next.js 15.5.x (App Router), React 18.x (NOT 19 — ConnectKit's peer range is `17.x || 18.x` only), wagmi 2.19.x + viem 2.x + connectkit 1.9.x, `@tanstack/react-query` 5.x, Tailwind CSS 4.x, `siwe` 3.x (client-side message construction), Recharts 3.x (analytics charts), Vitest 2.1.x + `@testing-library/react` 16.x + jsdom for component tests.

## Global Constraints

- The dashboard does NOT import `@cadence/sdk` anywhere. Every API call goes through a local `apiFetch` helper using `credentials: "include"` — this is deliberate (the SDK is API-key-only; session-cookie auth is this app's own concern, per Phase 1j's own design spec).
- React is pinned to `^18.3.0` (not 19) for ConnectKit compatibility. Every new `apps/web`/`packages/ui` `package.json` must declare this exact React version.
- `apps/api` currently has zero CORS configuration (confirmed by reading `apps/api/src/main.ts` — no `@fastify/cors` registration exists). Task 1 adds it; without this fix, every credentialed cross-origin request from `apps/web` to `apps/api` is blocked by the browser.
- The backend's SIWE `verify()` (`apps/api/src/auth/auth.service.ts`) does NOT enforce the message's `domain`/`uri` against a fixed value — it only validates the signature and consumes the nonce. The dashboard is free to construct its SIWE message with its own origin; no backend change is needed for this specifically (confirmed by reading the full `verify()` implementation).
- `GET /v1/merchants/me` returns HTTP 400 `{error: {code: "merchant_not_found"}}` for a signed-in wallet with no merchant account yet. The dashboard must handle this with an inline "create your merchant account" prompt (a single name field, `POST /v1/merchants`) — not a full onboarding wizard, and not by ignoring the case.
- Every monetary value and on-chain datum (amounts, addresses, tx hashes, dates-of-record) renders in a monospace font with tabular figures, per the design system. Use Geist Mono (or the closest available equivalent if unavailable via `next/font/google`, in which case use `JetBrains Mono` as a documented substitute — check availability during Task 1).
- Design tokens (exact hex values): `ink #0B1020`, `paper #FBFAF7`, `sapphire #2F5BFF`, `signal #F4A62A`, `mint #17B890`, `slate #5B6478`.
- No `SplitFlow` component, no `/dashboard/plans/new` wizard, no plan archive/activate, no `/dashboard/payouts`, no `/dashboard/settings`, no customer portal, no marketing site, no Playwright e2e tests — all explicitly out of scope per the design spec.
- Wallet/chain config targets `baseSepolia` only (chain id `84532`) — matches the backend's existing testmode-only scope (confirmed: `LIVE_CHAIN_IDS` in `apps/api/src/plans/plans.service.ts` only recognizes chain id `8453`, Base mainnet, as livemode).

---

### Task 1: `apps/web` scaffold, Tailwind design tokens, and the `apps/api` CORS fix

**Files:**
- Modify: `apps/api/src/main.ts` (add CORS)
- Modify: `apps/api/package.json` (add `@fastify/cors`)
- Create: `apps/web/package.json`
- Create: `apps/web/next.config.ts`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/app/layout.tsx`
- Create: `apps/web/app/globals.css`
- Create: `apps/web/app/page.tsx` (placeholder root page — the real `(dashboard)` route group is added in Task 3)
- Create: `apps/web/.env.local.example`
- Test: `apps/api/test/cors.e2e-spec.ts`

**Interfaces:**
- Produces: a running Next.js dev server (`pnpm --filter @cadence/web dev`) serving a placeholder page at `/`, with Tailwind v4 design tokens available as CSS custom properties AND Tailwind utility classes (`bg-ink`, `text-sapphire`, etc.) for every later task to consume. `apps/api` now accepts credentialed cross-origin requests from `http://localhost:3001` (the dashboard's dev port — `apps/api` already owns port 3000).

- [ ] **Step 1: Write the failing CORS test**

Create `apps/api/test/cors.e2e-spec.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import request from "supertest";
import fastifyCookie from "@fastify/cookie";
import { AppModule } from "../src/app.module.js";
import { startTestDatabase, stopTestDatabase } from "./setup.js";

type Server = ReturnType<ReturnType<NestFastifyApplication["getHttpAdapter"]>["getInstance"]>["server"];

describe("CORS", () => {
  let app: NestFastifyApplication;
  let server: Server;

  beforeAll(async () => {
    const connectionUri = await startTestDatabase();
    process.env.DATABASE_URL = connectionUri;
    process.env.JWT_SECRET = "test-secret";
    process.env.WEBHOOK_SIGNING_ROTATION_KEY = "test-rotation-key-0123456789abcd";

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie, { secret: "test-secret" });
    app.enableCors({ origin: ["http://localhost:3001"], credentials: true });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    server = app.getHttpAdapter().getInstance().server;
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await stopTestDatabase();
  });

  it("allows a credentialed preflight request from the dashboard's dev origin", async () => {
    const response = await request(server)
      .options("/v1/merchants/me")
      .set("Origin", "http://localhost:3001")
      .set("Access-Control-Request-Method", "GET")
      .set("Access-Control-Request-Headers", "content-type");

    expect(response.status).toBeLessThan(300);
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3001");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("rejects a request from an unlisted origin", async () => {
    const response = await request(server).options("/v1/merchants/me").set("Origin", "http://evil.example.com").set("Access-Control-Request-Method", "GET");

    expect(response.headers["access-control-allow-origin"]).not.toBe("http://evil.example.com");
  });
});
```

Note this test constructs its OWN `NestFastifyApplication` with `enableCors` called explicitly (rather than importing `apps/api/src/main.ts`'s `bootstrap()`, which isn't exported/testable) — this proves the CORS *configuration this task adds* is correct in isolation. The actual `main.ts` wiring is verified by Step 5's manual dev-server check, since `main.ts` itself has no exported, testable `bootstrap` function in this codebase's existing convention (confirmed: every other `apps/api` e2e spec in this codebase builds its own `Test.createTestingModule` rather than importing `main.ts`).

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run --config vitest.e2e.config.ts test/cors.e2e-spec.ts`
Expected: FAIL — no CORS headers present (the test's own `app.enableCors(...)` call means this specific test file's assertions will actually pass immediately once `@fastify/cors` is installed, since the test builds its own app; the real regression check is Step 2b below).

- [ ] **Step 2b: Add `@fastify/cors` and verify the test's own `enableCors` call needs it**

Run: `cd apps/api && npx vitest run --config vitest.e2e.config.ts test/cors.e2e-spec.ts` before installing `@fastify/cors`.
Expected: FAIL with an error indicating `enableCors` is not registered/supported without the underlying platform package (NestJS's Fastify adapter requires `@fastify/cors` to be installed as a peer for `app.enableCors()` to function) — confirms the dependency is genuinely required, not just documentation.

- [ ] **Step 3: Install `@fastify/cors` and add it to `main.ts`**

Modify `apps/api/package.json` — add to `dependencies`:

```json
"@fastify/cors": "^10.0.0",
```

Run: `cd apps/api && pnpm install`

Modify `apps/api/src/main.ts`:

```typescript
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import fastifyCookie from "@fastify/cookie";
import { AppModule } from "./app.module.js";

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  await app.register(fastifyCookie, { secret: process.env.JWT_SECRET ?? "dev-only-secret" });

  const corsOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:3001").split(",");
  app.enableCors({ origin: corsOrigins, credentials: true });

  const config = new DocumentBuilder().setTitle("Cadence API").setVersion("1.0").build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("docs", app, document);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, "0.0.0.0");
}
bootstrap();
```

Add to `apps/api/.env.local.example`:

```
CORS_ORIGINS=http://localhost:3001
```

- [ ] **Step 4: Run the CORS test to verify it passes**

Run: `cd apps/api && npx vitest run --config vitest.e2e.config.ts test/cors.e2e-spec.ts`
Expected: PASS (2/2 tests).

- [ ] **Step 5: Run the full apps/api e2e suite to confirm no regression**

Run: `cd apps/api && npx vitest run --config vitest.e2e.config.ts`
Expected: all pre-existing spec files still pass, plus the new 2 CORS tests (as of Phase 1j this was 11 files/75 tests — expect 12 files/77 tests, but verify the actual current count yourself rather than trusting this arithmetic).

- [ ] **Step 6: Scaffold `apps/web`'s package.json**

Replace `apps/web/package.json` in full:

```json
{
  "name": "@cadence/web",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "next dev -p 3001",
    "build": "next build",
    "start": "next start -p 3001",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "next": "^15.5.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "wagmi": "^2.19.0",
    "viem": "^2.21.0",
    "connectkit": "^1.9.0",
    "@tanstack/react-query": "^5.60.0",
    "siwe": "^3.0.0",
    "recharts": "^3.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.10.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "typescript": "^5.7.3",
    "tailwindcss": "^4.0.0",
    "@tailwindcss/postcss": "^4.0.0",
    "vitest": "^2.1.0",
    "@testing-library/react": "^16.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "jsdom": "^25.0.0"
  }
}
```

- [ ] **Step 7: Add TypeScript and Next.js config**

Create `apps/web/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

Create `apps/web/next.config.ts`:

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
```

- [ ] **Step 8: Add Tailwind v4 design tokens**

Create `apps/web/app/globals.css`:

```css
@import "tailwindcss";
@source "../../../packages/ui/src";

@theme {
  --color-ink: #0B1020;
  --color-paper: #FBFAF7;
  --color-sapphire: #2F5BFF;
  --color-signal: #F4A62A;
  --color-mint: #17B890;
  --color-slate: #5B6478;

  --font-display: "Space Grotesk", sans-serif;
  --font-body: "Geist Sans", system-ui, sans-serif;
  --font-data: "Geist Mono", "JetBrains Mono", monospace;
}

body {
  background: var(--color-paper);
  color: var(--color-ink);
  font-family: var(--font-body);
}
```

This makes `bg-ink`, `text-sapphire`, `font-display`, `font-data`, etc. available as Tailwind utility classes throughout `apps/web`, per Tailwind v4's CSS-first `@theme` configuration (no separate `tailwind.config.js` needed).

Create a PostCSS config so Next.js picks up Tailwind — `apps/web/postcss.config.mjs`:

```javascript
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
```

- [ ] **Step 9: Add the root layout and a placeholder page**

Create `apps/web/app/layout.tsx`:

```tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cadence",
  description: "Merchant dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

Create `apps/web/app/page.tsx`:

```tsx
export default function RootPage() {
  return (
    <main className="p-8">
      <h1 className="font-display text-2xl">Cadence</h1>
      <p className="font-body text-slate">Merchant dashboard — under construction.</p>
    </main>
  );
}
```

- [ ] **Step 10: Add the env example**

Create `apps/web/.env.local.example`:

```
NEXT_PUBLIC_API_BASE_URL=http://localhost:3000
NEXT_PUBLIC_CHAIN_ID=84532
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=your-walletconnect-project-id
```

- [ ] **Step 11: Install dependencies and run the dev server manually to confirm it boots**

Run: `pnpm install` (from repo root — picks up the new `apps/web` workspace member).
Run: `cd apps/web && pnpm dev` in the background, then `curl -s http://localhost:3001 | grep -o "Cadence"` to confirm the placeholder page renders. Stop the dev server after confirming.
Expected: the curl output contains `Cadence`.

- [ ] **Step 12: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 13: Commit**

```bash
git add apps/api/src/main.ts apps/api/package.json apps/api/.env.local.example apps/api/test/cors.e2e-spec.ts apps/web/
git commit -m "Scaffold apps/web (Next.js 15 + Tailwind v4) and add CORS support to apps/api"
```

---

### Task 2: `packages/ui` — `CadencePulse` and `StatusBadge`

**Files:**
- Create: `packages/ui/package.json`
- Create: `packages/ui/tsconfig.json`
- Create: `packages/ui/vitest.config.ts`
- Create: `packages/ui/src/CadencePulse.tsx`
- Create: `packages/ui/src/StatusBadge.tsx`
- Create: `packages/ui/src/index.ts`
- Test: `packages/ui/test/CadencePulse.test.tsx`
- Test: `packages/ui/test/StatusBadge.test.tsx`

**Interfaces:**
- Produces: `<CadencePulse periodSeconds={number} currentPeriodEnd={string} />` (renders a tick-based rhythm visualization: ticks evenly spaced within the current period, an "active" tick roughly at the elapsed-fraction position, and a distinct "next charge" tick at the end); `<StatusBadge status={string} />` (maps `"active"`→mint, `"trialing"`→mint, `"past_due"`→signal, `"paused"`→signal, `"canceled"`→slate, any other value→slate as a safe default). Both exported from `packages/ui/src/index.ts`. Consumed by Tasks 5 (subscriptions) and 4/5/7 (status displays generally).

- [ ] **Step 1: Write the failing tests**

Create `packages/ui/test/StatusBadge.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "../src/StatusBadge.js";

describe("StatusBadge", () => {
  it("renders active status in mint", () => {
    render(<StatusBadge status="active" />);
    const badge = screen.getByText("active");
    expect(badge.className).toContain("mint");
  });

  it("renders trialing status in mint", () => {
    render(<StatusBadge status="trialing" />);
    expect(screen.getByText("trialing").className).toContain("mint");
  });

  it("renders past_due status in signal", () => {
    render(<StatusBadge status="past_due" />);
    expect(screen.getByText("past_due").className).toContain("signal");
  });

  it("renders paused status in signal", () => {
    render(<StatusBadge status="paused" />);
    expect(screen.getByText("paused").className).toContain("signal");
  });

  it("renders canceled status in slate", () => {
    render(<StatusBadge status="canceled" />);
    expect(screen.getByText("canceled").className).toContain("slate");
  });

  it("renders an unrecognized status in slate as a safe default", () => {
    render(<StatusBadge status="some_future_status" />);
    expect(screen.getByText("some_future_status").className).toContain("slate");
  });
});
```

Create `packages/ui/test/CadencePulse.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { CadencePulse } from "../src/CadencePulse.js";

describe("CadencePulse", () => {
  it("renders 8 ticks for a subscription mid-period", () => {
    const now = new Date("2026-07-08T00:00:00Z");
    const periodSeconds = 30 * 86400; // 30-day period
    const currentPeriodEnd = new Date(now.getTime() + 15 * 86400 * 1000).toISOString(); // 15 days remaining, so ~50% elapsed

    const { container } = render(<CadencePulse periodSeconds={periodSeconds} currentPeriodEnd={currentPeriodEnd} now={now} />);
    const ticks = container.querySelectorAll("[data-tick]");
    expect(ticks.length).toBe(8);
  });

  it("marks a tick near the midpoint as active when the period is ~50% elapsed", () => {
    const now = new Date("2026-07-08T00:00:00Z");
    const periodSeconds = 30 * 86400;
    const currentPeriodEnd = new Date(now.getTime() + 15 * 86400 * 1000).toISOString();

    const { container } = render(<CadencePulse periodSeconds={periodSeconds} currentPeriodEnd={currentPeriodEnd} now={now} />);
    const activeTick = container.querySelector('[data-tick-state="active"]');
    expect(activeTick).not.toBeNull();
    const activeIndex = Number(activeTick?.getAttribute("data-tick"));
    // With 8 ticks and ~50% elapsed, the active tick should land roughly in the middle (index 3 or 4).
    expect(activeIndex).toBeGreaterThanOrEqual(2);
    expect(activeIndex).toBeLessThanOrEqual(5);
  });

  it("marks the last tick as the next-charge tick", () => {
    const now = new Date("2026-07-08T00:00:00Z");
    const periodSeconds = 30 * 86400;
    const currentPeriodEnd = new Date(now.getTime() + 15 * 86400 * 1000).toISOString();

    const { container } = render(<CadencePulse periodSeconds={periodSeconds} currentPeriodEnd={currentPeriodEnd} now={now} />);
    const nextTick = container.querySelector('[data-tick-state="next"]');
    expect(nextTick?.getAttribute("data-tick")).toBe("7");
  });

  it("marks the active tick at index 0 when the period just started", () => {
    const now = new Date("2026-07-08T00:00:00Z");
    const periodSeconds = 30 * 86400;
    const currentPeriodEnd = new Date(now.getTime() + 30 * 86400 * 1000).toISOString(); // full period remaining, 0% elapsed

    const { container } = render(<CadencePulse periodSeconds={periodSeconds} currentPeriodEnd={currentPeriodEnd} now={now} />);
    const activeTick = container.querySelector('[data-tick-state="active"]');
    expect(activeTick?.getAttribute("data-tick")).toBe("0");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/ui && npx vitest run` (after Step 3's config exists — see note below).
Expected: FAIL — `../src/StatusBadge.js` and `../src/CadencePulse.js` do not exist.

- [ ] **Step 3: Scaffold the package**

Create `packages/ui/package.json`:

```json
{
  "name": "@cadence/ui",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "peerDependencies": {
    "react": "^18.3.0"
  },
  "devDependencies": {
    "@types/node": "^20.10.0",
    "@types/react": "^18.3.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "typescript": "^5.7.3",
    "vitest": "^2.1.0",
    "@testing-library/react": "^16.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "jsdom": "^25.0.0"
  }
}
```

Note `packages/ui` exports raw `.tsx`/`.ts` source directly (`main`/`types` point at `src/index.ts`, not a `dist/` build) — since its only consumer, `apps/web`, is a Next.js app that already compiles TypeScript/JSX itself via its own bundler. This deliberately differs from `packages/db`/`packages/shared`/`packages/sdk`'s compiled-`dist/` pattern, because those are consumed by plain Node processes (`apps/worker`, `apps/api`) that need pre-compiled JS, while `apps/web`'s Next.js toolchain handles TS/JSX compilation for anything in its dependency graph natively.

Create `packages/ui/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "esnext"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "test/**/*.tsx"],
  "exclude": ["node_modules"]
}
```

Create `packages/ui/vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
  },
});
```

Run: `pnpm install` (from repo root).

- [ ] **Step 4: Implement `StatusBadge`**

Create `packages/ui/src/StatusBadge.tsx`:

```tsx
// Full class strings, not interpolated fragments — Tailwind's static analyzer
// only extracts whole utility-class literals from source, so a template
// literal like `bg-${color}/10` never emits any CSS for the class it builds.
const STATUS_CLASSES: Record<string, string> = {
  active: "bg-mint/10 text-mint",
  trialing: "bg-mint/10 text-mint",
  past_due: "bg-signal/10 text-signal",
  paused: "bg-signal/10 text-signal",
  canceled: "bg-slate/10 text-slate",
};
const DEFAULT_CLASSES = "bg-slate/10 text-slate";

export interface StatusBadgeProps {
  status: string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const classes = STATUS_CLASSES[status] ?? DEFAULT_CLASSES;
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${classes}`}>{status}</span>;
}
```

- [ ] **Step 5: Implement `CadencePulse`**

Create `packages/ui/src/CadencePulse.tsx`:

```tsx
const TICK_COUNT = 8;

export interface CadencePulseProps {
  periodSeconds: number;
  currentPeriodEnd: string;
  /** Injectable for deterministic testing; defaults to the real current time. */
  now?: Date;
}

export function CadencePulse({ periodSeconds, currentPeriodEnd, now = new Date() }: CadencePulseProps) {
  const periodEnd = new Date(currentPeriodEnd);
  const periodStart = new Date(periodEnd.getTime() - periodSeconds * 1000);
  const elapsedMs = now.getTime() - periodStart.getTime();
  const elapsedFraction = Math.min(1, Math.max(0, elapsedMs / (periodSeconds * 1000)));

  const activeIndex = Math.round(elapsedFraction * (TICK_COUNT - 1));
  const nextIndex = TICK_COUNT - 1;

  return (
    <div className="flex items-center gap-1" role="img" aria-label="billing cadence">
      {Array.from({ length: TICK_COUNT }, (_, i) => {
        const state = i === activeIndex ? "active" : i === nextIndex ? "next" : "idle";
        const color = state === "active" ? "bg-sapphire" : state === "next" ? "bg-signal" : "bg-slate/25";
        const height = state === "idle" ? "h-2" : state === "next" ? "h-4.5" : "h-6";
        return <div key={i} data-tick={i} data-tick-state={state} className={`flex-1 rounded-sm ${color} ${height}`} />;
      })}
    </div>
  );
}
```

Note when `activeIndex === nextIndex` (a subscription at or past its period end), the tick at that position is marked `"active"` by the ternary's evaluation order — `i === activeIndex` is checked first, so the last tick would show as `"active"`, not `"next"`, in that edge case. This is acceptable: a subscription past its period end (overdue) showing its rhythm's final tick as "currently active" rather than "next" is a reasonable degenerate-case rendering, not a bug the tests need to cover, since no test in this task exercises `elapsedFraction >= 1`.

- [ ] **Step 6: Create the public entrypoint**

Create `packages/ui/src/index.ts`:

```typescript
export { CadencePulse, type CadencePulseProps } from "./CadencePulse.js";
export { StatusBadge, type StatusBadgeProps } from "./StatusBadge.js";
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd packages/ui && npx vitest run`
Expected: PASS (10/10 tests).

- [ ] **Step 8: Typecheck**

Run: `cd packages/ui && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add packages/ui/
git commit -m "Add packages/ui with CadencePulse and StatusBadge components"
```

---

### Task 3: SIWE sign-in flow + merchant onboarding

**Files:**
- Create: `apps/web/lib/apiFetch.ts`
- Create: `apps/web/lib/wagmi-config.ts`
- Create: `apps/web/app/providers.tsx`
- Create: `apps/web/app/(dashboard)/layout.tsx`
- Create: `apps/web/components/SignInButton.tsx`
- Create: `apps/web/components/CreateMerchantPrompt.tsx`
- Modify: `apps/web/app/layout.tsx`
- Test: `apps/web/test/SignInButton.test.tsx`
- Test: `apps/web/test/apiFetch.test.ts`

**Interfaces:**
- Consumes: `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_CHAIN_ID`, `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` (Task 1's `.env.local.example`).
- Produces: `apiFetch(path: string, options?: RequestInit): Promise<unknown>` (throws a typed error on non-2xx, mirroring `@cadence/sdk`'s `CadenceError` shape but as a standalone implementation — NOT imported from the SDK, per this phase's Global Constraint); the `(dashboard)` route group's layout, which gates all child routes behind a signed-in session (redirects to a sign-in prompt otherwise) AND behind having a merchant account (shows `CreateMerchantPrompt` otherwise). Consumed by every subsequent task's routes.

- [ ] **Step 1: Write the failing test for `apiFetch`**

Create `apps/web/test/apiFetch.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, ApiError } from "../lib/apiFetch.js";

describe("apiFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends credentials: 'include' and the configured base URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await apiFetch("/v1/merchants/me");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/v1/merchants/me");
    expect(init.credentials).toBe("include");
    expect(result).toEqual({ ok: true });
  });

  it("throws an ApiError with the parsed envelope on a non-2xx response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "merchant_not_found", message: "No merchant account exists for this session yet." } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiFetch("/v1/merchants/me")).rejects.toMatchObject({ code: "merchant_not_found", status: 400 });
    await expect(apiFetch("/v1/merchants/me")).rejects.toBeInstanceOf(ApiError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run test/apiFetch.test.ts`
Expected: FAIL — `../lib/apiFetch.js` does not exist.

- [ ] **Step 3: Implement `apiFetch`**

Create `apps/web/lib/apiFetch.ts`:

```typescript
export class ApiError extends Error {
  readonly type: string;
  readonly code: string;
  readonly param?: string;
  readonly status: number;

  constructor(params: { type: string; code: string; message: string; param?: string; status: number }) {
    super(params.message);
    this.name = "ApiError";
    this.type = params.type;
    this.code = params.code;
    this.param = params.param;
    this.status = params.status;
  }
}

const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000";

export async function apiFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...options.headers },
  });

  const text = await response.text();
  const parsed: unknown = text.length > 0 ? JSON.parse(text) : undefined;

  if (!response.ok) {
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const envelope = (parsed as { error: { type: string; code: string; message: string; param?: string } }).error;
      throw new ApiError({ ...envelope, status: response.status });
    }
    throw new ApiError({ type: "api_error", code: "unknown_error", message: `Request failed with status ${response.status}`, status: response.status });
  }

  return parsed;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run test/apiFetch.test.ts`
Expected: PASS (2/2 tests).

- [ ] **Step 5: Create the wagmi/ConnectKit config**

Create `apps/web/lib/wagmi-config.ts`:

```typescript
import { createConfig, http } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import { getDefaultConfig } from "connectkit";

export const wagmiConfig = createConfig(
  getDefaultConfig({
    chains: [baseSepolia],
    transports: {
      [baseSepolia.id]: http(),
    },
    walletConnectProjectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "",
    appName: "Cadence",
  }),
);
```

- [ ] **Step 6: Create the client-side providers wrapper**

Create `apps/web/app/providers.tsx`:

```tsx
"use client";

import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectKitProvider } from "connectkit";
import { useState } from "react";
import { wagmiConfig } from "../lib/wagmi-config.js";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ConnectKitProvider>{children}</ConnectKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
```

- [ ] **Step 7: Wire `Providers` into the root layout**

Modify `apps/web/app/layout.tsx`:

```tsx
import type { Metadata } from "next";
import { Providers } from "./providers.js";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cadence",
  description: "Merchant dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

- [ ] **Step 8: Write the failing test for `SignInButton`**

Create `apps/web/test/SignInButton.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SignInButton } from "../components/SignInButton.js";

const mockSignMessageAsync = vi.fn();
const mockUseAccount = vi.fn();

vi.mock("wagmi", () => ({
  useAccount: () => mockUseAccount(),
  useSignMessage: () => ({ signMessageAsync: mockSignMessageAsync }),
}));

describe("SignInButton", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mockSignMessageAsync.mockReset();
    mockUseAccount.mockReset();
  });

  it("fetches a nonce, signs the SIWE message, and calls verify on click", async () => {
    mockUseAccount.mockReturnValue({ address: "0xabc0000000000000000000000000000000abc0", isConnected: true, chainId: 84532 });
    mockSignMessageAsync.mockResolvedValue("0xsignature");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ nonce: "abc123" }), { status: 201, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ address: "0xabc0000000000000000000000000000000abc0" }), { status: 201, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const onSignedIn = vi.fn();
    render(<SignInButton onSignedIn={onSignedIn} />);

    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockSignMessageAsync).toHaveBeenCalledOnce();
  });

  it("shows a connect prompt instead of a sign-in button when no wallet is connected", () => {
    mockUseAccount.mockReturnValue({ address: undefined, isConnected: false, chainId: undefined });

    render(<SignInButton onSignedIn={vi.fn()} />);

    expect(screen.queryByRole("button", { name: /sign in/i })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 9: Run it to verify it fails**

Run: `cd apps/web && npx vitest run test/SignInButton.test.tsx`
Expected: FAIL — `../components/SignInButton.js` does not exist.

- [ ] **Step 10: Implement `SignInButton`**

Create `apps/web/components/SignInButton.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { SiweMessage } from "siwe";
import { apiFetch } from "../lib/apiFetch.js";
import { ConnectKitButton } from "connectkit";

export interface SignInButtonProps {
  onSignedIn: (address: string) => void;
}

export function SignInButton({ onSignedIn }: SignInButtonProps) {
  const { address, isConnected, chainId } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isConnected || !address) {
    return <ConnectKitButton />;
  }

  async function handleSignIn() {
    setIsSigningIn(true);
    setError(null);
    try {
      const { nonce } = (await apiFetch("/v1/auth/nonce", { method: "POST" })) as { nonce: string };

      const siweMessage = new SiweMessage({
        domain: window.location.host,
        address,
        statement: "Sign in to Cadence.",
        uri: window.location.origin,
        version: "1",
        chainId: chainId ?? 84532,
        nonce,
      });
      const messageToSign = siweMessage.prepareMessage();
      const signature = await signMessageAsync({ message: messageToSign });

      const { address: verifiedAddress } = (await apiFetch("/v1/auth/verify", {
        method: "POST",
        body: JSON.stringify({ message: messageToSign, signature }),
      })) as { address: string };

      onSignedIn(verifiedAddress);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setIsSigningIn(false);
    }
  }

  return (
    <div>
      <button onClick={handleSignIn} disabled={isSigningIn} className="rounded-md bg-sapphire px-4 py-2 text-paper font-body">
        {isSigningIn ? "Signing in…" : "Sign in"}
      </button>
      {error && <p className="text-signal text-sm mt-2">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 11: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run test/SignInButton.test.tsx`
Expected: PASS (2/2 tests).

- [ ] **Step 12: Implement `CreateMerchantPrompt`**

Create `apps/web/components/CreateMerchantPrompt.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { apiFetch } from "../lib/apiFetch.js";

export interface CreateMerchantPromptProps {
  onCreated: () => void;
}

export function CreateMerchantPrompt({ onCreated }: CreateMerchantPromptProps) {
  const { address } = useAccount();
  const [name, setName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!address) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await apiFetch("/v1/merchants", { method: "POST", body: JSON.stringify({ name, ownerAddress: address }) });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create merchant account.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-sm mx-auto mt-24 p-6 rounded-lg border border-slate/20">
      <h2 className="font-display text-lg mb-2">Set up your merchant account</h2>
      <p className="font-body text-slate text-sm mb-4">This is a one-time step to link your wallet to a Cadence merchant profile.</p>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Business name"
        required
        className="w-full rounded-md border border-slate/30 px-3 py-2 mb-3 font-body"
      />
      <button type="submit" disabled={isSubmitting || name.length === 0} className="w-full rounded-md bg-sapphire px-4 py-2 text-paper font-body">
        {isSubmitting ? "Creating…" : "Create account"}
      </button>
      {error && <p className="text-signal text-sm mt-2">{error}</p>}
    </form>
  );
}
```

- [ ] **Step 13: Wire the `(dashboard)` layout to gate on session + merchant existence**

Create `apps/web/app/(dashboard)/layout.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { SignInButton } from "../../components/SignInButton.js";
import { CreateMerchantPrompt } from "../../components/CreateMerchantPrompt.js";
import { apiFetch, ApiError } from "../../lib/apiFetch.js";

type AuthState = "checking" | "signed-out" | "no-merchant" | "ready";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [authState, setAuthState] = useState<AuthState>("checking");

  async function checkMerchant() {
    try {
      await apiFetch("/v1/merchants/me");
      setAuthState("ready");
    } catch (err) {
      if (err instanceof ApiError && err.code === "merchant_not_found") {
        setAuthState("no-merchant");
      } else {
        setAuthState("signed-out");
      }
    }
  }

  useEffect(() => {
    checkMerchant();
  }, []);

  if (authState === "checking") {
    return <div className="p-8 font-body text-slate">Loading…</div>;
  }

  if (authState === "signed-out") {
    return (
      <div className="flex flex-col items-center mt-24 gap-4">
        <h1 className="font-display text-2xl">Sign in to Cadence</h1>
        <SignInButton onSignedIn={() => checkMerchant()} />
      </div>
    );
  }

  if (authState === "no-merchant") {
    return <CreateMerchantPrompt onCreated={() => checkMerchant()} />;
  }

  return <div className="flex min-h-screen">{children}</div>;
}
```

Note `checkMerchant`'s `catch` branch treats every `ApiError` OTHER than `merchant_not_found` (including `authentication_error`/`missing_session`, which `GET /v1/merchants/me` throws for a signed-out visitor per `AuthContextService`) as `"signed-out"` — this is intentional: any auth-layer failure should fall back to showing the sign-in prompt, not silently break, and `merchant_not_found` is the one specific, expected "you're signed in but not fully onboarded yet" case that gets its own state.

- [ ] **Step 14: Run the full apps/web test suite to confirm no regression**

Run: `cd apps/web && npx vitest run`
Expected: all tests pass (2 from apiFetch + 2 from SignInButton = 4 total so far).

- [ ] **Step 15: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 16: Commit**

```bash
git add apps/web/lib/ apps/web/app/providers.tsx apps/web/app/layout.tsx "apps/web/app/(dashboard)" apps/web/components/ apps/web/test/
git commit -m "Add SIWE sign-in flow and merchant onboarding gate"
```

---

### Task 4: `/dashboard` overview + `/dashboard/plans`

**Files:**
- Create: `apps/web/components/DashboardNav.tsx`
- Create: `apps/web/app/(dashboard)/dashboard/page.tsx`
- Create: `apps/web/app/(dashboard)/dashboard/plans/page.tsx`
- Create: `apps/web/lib/hooks/useAnalyticsSummary.ts`
- Create: `apps/web/lib/hooks/usePlans.ts`
- Test: `apps/web/test/useAnalyticsSummary.test.ts`
- Test: `apps/web/test/usePlans.test.ts`

**Interfaces:**
- Consumes: `apiFetch` (Task 3); `StatusBadge` (Task 2, used for plan `active`/inactive display — a `boolean`, not the `Subscription.status` string enum, so this task maps `active: true`→`"active"`/`active: false`→`"canceled"` string before passing to `StatusBadge`, reusing its existing color mapping rather than inventing a new one).
- Produces: `useAnalyticsSummary(): {data, isLoading, error}` (TanStack Query wrapping `GET /v1/analytics/summary`); `usePlans(): {data, isLoading, error}` (wrapping `GET /v1/plans`). Both follow the identical hook shape later tasks (5, 6, 7) replicate for their own resources.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/useAnalyticsSummary.test.ts`:

```typescript
import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAnalyticsSummary } from "../lib/hooks/useAnalyticsSummary.js";

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useAnalyticsSummary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches GET /v1/analytics/summary and returns the parsed data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ mrr_usd: "1000.000000", active_subscriptions: 5 }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useAnalyticsSummary(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual({ mrr_usd: "1000.000000", active_subscriptions: 5 });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("/v1/analytics/summary");
  });
});
```

Create `apps/web/test/usePlans.test.ts`:

```typescript
import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { usePlans } from "../lib/hooks/usePlans.js";

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("usePlans", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches GET /v1/plans and returns the data array", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ onchain_plan_id: "1", name: "Pro" }], has_more: false, next_cursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => usePlans(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual([{ onchain_plan_id: "1", name: "Pro" }]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && npx vitest run test/useAnalyticsSummary.test.ts test/usePlans.test.ts`
Expected: FAIL — neither hook module exists.

- [ ] **Step 3: Implement `useAnalyticsSummary`**

Create `apps/web/lib/hooks/useAnalyticsSummary.ts`:

```typescript
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../apiFetch.js";

export interface AnalyticsSummary {
  mrr_usd: string;
  arr_usd: string;
  active_subscriptions: number;
  arpu_usd: string;
  gross_volume_30d_usd: string;
  fee_revenue_30d_usd: string;
  churn_rate_30d: number;
}

export function useAnalyticsSummary() {
  return useQuery({
    queryKey: ["analytics", "summary"],
    queryFn: () => apiFetch("/v1/analytics/summary") as Promise<AnalyticsSummary>,
  });
}
```

- [ ] **Step 4: Implement `usePlans`**

Create `apps/web/lib/hooks/usePlans.ts`:

```typescript
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../apiFetch.js";

export interface Plan {
  onchain_plan_id: string;
  name: string | null;
  description: string | null;
  image_url: string | null;
  amount: string;
  token: string;
  period_seconds: number;
  trial_seconds: number;
  active: boolean;
  payout_split: string;
  dunning_ladder: string[];
  created_at: string | null;
  livemode: boolean;
}

interface PageEnvelope<T> {
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export function usePlans() {
  const query = useQuery({
    queryKey: ["plans"],
    queryFn: () => apiFetch("/v1/plans") as Promise<PageEnvelope<Plan>>,
  });
  return { ...query, data: query.data?.data };
}
```

Note this file redefines `Plan`/`PageEnvelope` rather than importing them from `@cadence/sdk`, even though `packages/sdk/src/types.ts` already has byte-identical definitions — this is deliberate per this phase's Global Constraint that `apps/web` never imports `@cadence/sdk` at all (the SDK's `RequestFn`/`Cadence` class assumes Bearer-token auth; importing only its `types.ts` re-introduces a coupling to a package whose primary export is the wrong auth model for this app, and risks a future SDK refactor silently changing types this app depends on for a reason unrelated to its own auth boundary). The duplication is small (one interface, transcribed once) and matches this project's own established precedent of accepting small, explained duplication over cross-boundary coupling (e.g., the churn-formula duplication between `apps/worker` and `apps/api` from Phase 1i).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run test/useAnalyticsSummary.test.ts test/usePlans.test.ts`
Expected: PASS (2/2 tests).

- [ ] **Step 6: Build the dashboard nav shell**

Create `apps/web/components/DashboardNav.tsx`:

```tsx
import Link from "next/link";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/plans", label: "Plans" },
  { href: "/dashboard/subscriptions", label: "Subscriptions" },
  { href: "/dashboard/analytics", label: "Analytics" },
  { href: "/dashboard/developers", label: "Developers" },
];

export function DashboardNav() {
  return (
    <nav className="w-56 shrink-0 border-r border-slate/15 p-4">
      <div className="font-display text-lg mb-6">Cadence</div>
      <ul className="flex flex-col gap-1">
        {NAV_ITEMS.map((item) => (
          <li key={item.href}>
            <Link href={item.href} className="block rounded-md px-3 py-2 text-sm font-body hover:bg-sapphire/10">
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
```

Modify `apps/web/app/(dashboard)/layout.tsx` — replace the final `return <div className="flex min-h-screen">{children}</div>;` line with:

```tsx
  return (
    <div className="flex min-h-screen">
      <DashboardNav />
      <div className="flex-1 p-8">{children}</div>
    </div>
  );
```

And add the import at the top: `import { DashboardNav } from "../../components/DashboardNav.js";`

- [ ] **Step 7: Build the overview page**

Create `apps/web/app/(dashboard)/dashboard/page.tsx`:

```tsx
"use client";

import { useAnalyticsSummary } from "../../../lib/hooks/useAnalyticsSummary.js";

export default function DashboardOverviewPage() {
  const { data, isLoading, error } = useAnalyticsSummary();

  if (isLoading) return <p className="font-body text-slate">Loading…</p>;
  if (error) return <p className="font-body text-signal">Could not load analytics summary.</p>;
  if (!data) return null;

  return (
    <div>
      <h1 className="font-display text-2xl mb-6">Overview</h1>
      <div className="grid grid-cols-4 gap-4">
        <div className="rounded-lg border border-slate/15 p-4">
          <div className="text-xs text-slate font-body">MRR</div>
          <div className="font-data text-xl tabular-nums">${data.mrr_usd}</div>
        </div>
        <div className="rounded-lg border border-slate/15 p-4">
          <div className="text-xs text-slate font-body">ARR</div>
          <div className="font-data text-xl tabular-nums">${data.arr_usd}</div>
        </div>
        <div className="rounded-lg border border-slate/15 p-4">
          <div className="text-xs text-slate font-body">Active subscriptions</div>
          <div className="font-data text-xl tabular-nums">{data.active_subscriptions}</div>
        </div>
        <div className="rounded-lg border border-slate/15 p-4">
          <div className="text-xs text-slate font-body">ARPU</div>
          <div className="font-data text-xl tabular-nums">${data.arpu_usd}</div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Build the plans list page**

Create `apps/web/app/(dashboard)/dashboard/plans/page.tsx`:

```tsx
"use client";

import { usePlans } from "../../../../lib/hooks/usePlans.js";
import { StatusBadge } from "@cadence/ui";

export default function PlansPage() {
  const { data, isLoading, error } = usePlans();

  if (isLoading) return <p className="font-body text-slate">Loading…</p>;
  if (error) return <p className="font-body text-signal">Could not load plans.</p>;

  return (
    <div>
      <h1 className="font-display text-2xl mb-6">Plans</h1>
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

Modify `apps/web/package.json` — add `@cadence/ui` to `dependencies`:

```json
"@cadence/ui": "workspace:*",
```

Run: `pnpm install` (from repo root, to link the new workspace dependency).

- [ ] **Step 9: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 10: Run the full apps/web suite to confirm no regression**

Run: `cd apps/web && npx vitest run`
Expected: all tests pass (4 from Task 3 + 2 from this task = 6 total).

- [ ] **Step 11: Commit**

```bash
git add apps/web/components/DashboardNav.tsx "apps/web/app/(dashboard)" apps/web/lib/hooks/ apps/web/test/ apps/web/package.json
git commit -m "Add dashboard overview and plans list pages"
```

---

### Task 5: `/dashboard/subscriptions` list + detail

**Files:**
- Create: `apps/web/app/(dashboard)/dashboard/subscriptions/page.tsx`
- Create: `apps/web/app/(dashboard)/dashboard/subscriptions/[id]/page.tsx`
- Create: `apps/web/lib/hooks/useSubscriptions.ts`
- Create: `apps/web/lib/hooks/useSubscription.ts`
- Test: `apps/web/test/useSubscriptions.test.ts`
- Test: `apps/web/test/useSubscription.test.ts`

**Interfaces:**
- Consumes: `apiFetch` (Task 3), `StatusBadge`/`CadencePulse` (Task 2).
- Produces: `useSubscriptions(): {data, isLoading, error}` (wraps `GET /v1/subscriptions`); `useSubscription(onchainId: string): {data, isLoading, error}` (wraps `GET /v1/subscriptions/:onchainId`, includes `plan`/`charges` per the detail response shape).

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/useSubscriptions.test.ts`:

```typescript
import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSubscriptions } from "../lib/hooks/useSubscriptions.js";

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useSubscriptions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches GET /v1/subscriptions and returns the data array", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ onchain_sub_id: "1", status: "active" }], has_more: false, next_cursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useSubscriptions(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual([{ onchain_sub_id: "1", status: "active" }]);
  });
});
```

Create `apps/web/test/useSubscription.test.ts`:

```typescript
import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSubscription } from "../lib/hooks/useSubscription.js";

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useSubscription", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches GET /v1/subscriptions/:id and returns the detail shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ onchain_sub_id: "1", status: "active", plan: { name: "Pro" }, charges: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useSubscription("1"), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data?.plan).toEqual({ name: "Pro" });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("/v1/subscriptions/1");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && npx vitest run test/useSubscriptions.test.ts test/useSubscription.test.ts`
Expected: FAIL — neither hook module exists.

- [ ] **Step 3: Implement `useSubscriptions`**

Create `apps/web/lib/hooks/useSubscriptions.ts`:

```typescript
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../apiFetch.js";

export interface Subscription {
  id: string;
  onchain_sub_id: string;
  onchain_plan_id: string;
  subscriber: string;
  status: string;
  current_period_end: string;
  created_at: string | null;
}

interface PageEnvelope<T> {
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export function useSubscriptions() {
  const query = useQuery({
    queryKey: ["subscriptions"],
    queryFn: () => apiFetch("/v1/subscriptions") as Promise<PageEnvelope<Subscription>>,
  });
  return { ...query, data: query.data?.data };
}
```

- [ ] **Step 4: Implement `useSubscription`**

Create `apps/web/lib/hooks/useSubscription.ts`:

```typescript
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../apiFetch.js";
import type { Subscription } from "./useSubscriptions.js";

export interface ChargeSummary {
  id: string;
  status: string;
  amount: string | null;
  platform_fee: string | null;
  net: string | null;
  tx_hash: string;
  charged_at: string;
}

export interface PlanSummary {
  onchain_plan_id: string;
  name: string | null;
  amount: string;
  token: string;
  period_seconds: number;
}

export interface SubscriptionDetail extends Subscription {
  plan: PlanSummary;
  charges: ChargeSummary[];
}

export function useSubscription(onchainId: string) {
  return useQuery({
    queryKey: ["subscriptions", onchainId],
    queryFn: () => apiFetch(`/v1/subscriptions/${onchainId}`) as Promise<SubscriptionDetail>,
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run test/useSubscriptions.test.ts test/useSubscription.test.ts`
Expected: PASS (2/2 tests).

- [ ] **Step 6: Build the subscriptions list page**

Create `apps/web/app/(dashboard)/dashboard/subscriptions/page.tsx`:

```tsx
"use client";

import Link from "next/link";
import { useSubscriptions } from "../../../../lib/hooks/useSubscriptions.js";
import { StatusBadge, CadencePulse } from "@cadence/ui";

export default function SubscriptionsPage() {
  const { data, isLoading, error } = useSubscriptions();

  if (isLoading) return <p className="font-body text-slate">Loading…</p>;
  if (error) return <p className="font-body text-signal">Could not load subscriptions.</p>;

  return (
    <div>
      <h1 className="font-display text-2xl mb-6">Subscriptions</h1>
      <table className="w-full text-sm font-body">
        <thead>
          <tr className="text-left text-slate border-b border-slate/15">
            <th className="py-2">Subscriber</th>
            <th className="py-2">Status</th>
            <th className="py-2">Cadence</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((sub) => (
            <tr key={sub.onchain_sub_id} className="border-b border-slate/10">
              <td className="py-2">
                <Link href={`/dashboard/subscriptions/${sub.onchain_sub_id}`} className="text-sapphire hover:underline font-data">
                  {sub.subscriber}
                </Link>
              </td>
              <td className="py-2"><StatusBadge status={sub.status} /></td>
              <td className="py-2 w-40">
                {/* GET /v1/subscriptions has no per-plan period_seconds (only the detail
                    endpoint does), so this hardcodes a 30-day period rather than fetching
                    each row's plan separately (would be N+1). The detail page uses the
                    real plan.period_seconds value. */}
                <CadencePulse periodSeconds={30 * 86400} currentPeriodEnd={sub.current_period_end} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

Note the list page hardcodes `periodSeconds={30 * 86400}` for every row's `CadencePulse` — the list endpoint (`GET /v1/subscriptions`) does NOT include the plan's real `period_seconds` (confirmed: `SubscriptionSummary`, the list response shape, has no `plan` field; only `SubscriptionDetail`, the single-subscription response, includes `plan.period_seconds`). This is a real, deliberate simplification: the list view's cadence pulse is illustrative of rhythm/urgency, not a precise per-plan period render — the detail page (Step 7) uses the real value. Do not attempt to fetch each row's plan separately to get the exact value; that would mean N+1 requests for a list view, which is out of scope for this phase.

- [ ] **Step 7: Build the subscription detail page**

Create `apps/web/app/(dashboard)/dashboard/subscriptions/[id]/page.tsx`:

```tsx
"use client";

import { useParams } from "next/navigation";
import { useSubscription } from "../../../../../lib/hooks/useSubscription.js";
import { StatusBadge, CadencePulse } from "@cadence/ui";

export default function SubscriptionDetailPage() {
  const params = useParams<{ id: string }>();
  const { data, isLoading, error } = useSubscription(params.id);

  if (isLoading) return <p className="font-body text-slate">Loading…</p>;
  if (error) return <p className="font-body text-signal">Could not load subscription.</p>;
  if (!data) return null;

  return (
    <div>
      <h1 className="font-display text-2xl mb-2">{data.plan.name ?? "Untitled plan"}</h1>
      <div className="flex items-center gap-3 mb-6">
        <StatusBadge status={data.status} />
        <span className="font-data text-sm text-slate">{data.subscriber}</span>
      </div>
      <div className="mb-6 max-w-md">
        <CadencePulse periodSeconds={data.plan.period_seconds} currentPeriodEnd={data.current_period_end} />
      </div>
      <h2 className="font-display text-lg mb-3">Charge history</h2>
      <table className="w-full text-sm font-body">
        <thead>
          <tr className="text-left text-slate border-b border-slate/15">
            <th className="py-2">Date</th>
            <th className="py-2">Amount</th>
            <th className="py-2">Status</th>
            <th className="py-2">Tx</th>
          </tr>
        </thead>
        <tbody>
          {data.charges.map((charge) => (
            <tr key={charge.id} className="border-b border-slate/10">
              <td className="py-2 font-data tabular-nums">{new Date(charge.charged_at).toLocaleDateString()}</td>
              <td className="py-2 font-data tabular-nums">{charge.amount}</td>
              <td className="py-2"><StatusBadge status={charge.status} /></td>
              <td className="py-2 font-data text-xs truncate max-w-32">{charge.tx_hash}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 8: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 9: Run the full apps/web suite to confirm no regression**

Run: `cd apps/web && npx vitest run`
Expected: all tests pass (6 from Tasks 3-4 + 2 from this task = 8 total).

- [ ] **Step 10: Commit**

```bash
git add "apps/web/app/(dashboard)/dashboard/subscriptions" apps/web/lib/hooks/useSubscriptions.ts apps/web/lib/hooks/useSubscription.ts apps/web/test/useSubscriptions.test.ts apps/web/test/useSubscription.test.ts
git commit -m "Add subscriptions list and detail pages"
```

---

### Task 6: `/dashboard/analytics`

**Files:**
- Create: `apps/web/app/(dashboard)/dashboard/analytics/page.tsx`
- Create: `apps/web/lib/hooks/useMrr.ts`
- Create: `apps/web/lib/hooks/useChurn.ts`
- Create: `apps/web/lib/hooks/useCohorts.ts`
- Test: `apps/web/test/useMrr.test.ts`

**Interfaces:**
- Consumes: `apiFetch` (Task 3), Recharts (Task 1's dependency).
- Produces: `useMrr(): {data, isLoading, error}` (wraps `GET /v1/analytics/mrr`); `useChurn(): {data, isLoading, error}` (wraps `GET /v1/analytics/churn`); `useCohorts(): {data, isLoading, error}` (wraps `GET /v1/analytics/cohorts`). No filter/range params in this phase — every hook fetches the endpoint's own default range (each endpoint already defaults to trailing 30 days per `apps/api`'s own `daysAgo(30)` fallback, confirmed in `analytics.controller.ts`), matching the design spec's explicit "date range" being the one interactive element PRD §8.4 lists for this route, deferred here as YAGNI for a first read-only pass.

- [ ] **Step 1: Write the failing test for `useMrr`**

Create `apps/web/test/useMrr.test.ts`:

```typescript
import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMrr } from "../lib/hooks/useMrr.js";

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useMrr", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches GET /v1/analytics/mrr and returns the time series", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ date: "2026-06-01", mrr_usd: "1000.000000", arr_usd: "12000.000000" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useMrr(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual([{ date: "2026-06-01", mrr_usd: "1000.000000", arr_usd: "12000.000000" }]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run test/useMrr.test.ts`
Expected: FAIL — `../lib/hooks/useMrr.js` does not exist.

- [ ] **Step 3: Implement the three analytics hooks**

Create `apps/web/lib/hooks/useMrr.ts`:

```typescript
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../apiFetch.js";

export interface MrrPoint {
  date: string;
  mrr_usd: string;
  arr_usd: string;
}

export function useMrr() {
  const query = useQuery({
    queryKey: ["analytics", "mrr"],
    queryFn: () => apiFetch("/v1/analytics/mrr") as Promise<{ data: MrrPoint[] }>,
  });
  return { ...query, data: query.data?.data };
}
```

Create `apps/web/lib/hooks/useChurn.ts`:

```typescript
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../apiFetch.js";

export interface ChurnResult {
  churn_rate: number;
  revenue_churn: number;
}

export function useChurn() {
  return useQuery({
    queryKey: ["analytics", "churn"],
    queryFn: () => apiFetch("/v1/analytics/churn") as Promise<ChurnResult>,
  });
}
```

Create `apps/web/lib/hooks/useCohorts.ts`:

```typescript
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../apiFetch.js";

export interface CohortOffset {
  month: number;
  retention_pct: number;
}

export interface CohortRow {
  cohort: string;
  cohort_size: number;
  offsets: CohortOffset[];
}

export function useCohorts() {
  const query = useQuery({
    queryKey: ["analytics", "cohorts"],
    queryFn: () => apiFetch("/v1/analytics/cohorts") as Promise<{ data: CohortRow[] }>,
  });
  return { ...query, data: query.data?.data };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run test/useMrr.test.ts`
Expected: PASS (1/1 test).

- [ ] **Step 5: Build the analytics page**

Create `apps/web/app/(dashboard)/dashboard/analytics/page.tsx`:

```tsx
"use client";

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { useMrr } from "../../../../lib/hooks/useMrr.js";
import { useChurn } from "../../../../lib/hooks/useChurn.js";
import { useCohorts } from "../../../../lib/hooks/useCohorts.js";

export default function AnalyticsPage() {
  const mrr = useMrr();
  const churn = useChurn();
  const cohorts = useCohorts();

  return (
    <div>
      <h1 className="font-display text-2xl mb-6">Analytics</h1>

      <section className="mb-8">
        <h2 className="font-display text-lg mb-3">MRR</h2>
        {mrr.isLoading && <p className="font-body text-slate">Loading…</p>}
        {mrr.error && <p className="font-body text-signal">Could not load MRR.</p>}
        {mrr.data && (
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={mrr.data}>
              <XAxis dataKey="date" tick={{ fontFamily: "var(--font-data)", fontSize: 11 }} />
              <YAxis tick={{ fontFamily: "var(--font-data)", fontSize: 11 }} />
              <Tooltip contentStyle={{ fontFamily: "var(--font-data)" }} />
              <Line type="monotone" dataKey="mrr_usd" stroke="#2F5BFF" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </section>

      <section className="mb-8">
        <h2 className="font-display text-lg mb-3">Churn (30d)</h2>
        {churn.isLoading && <p className="font-body text-slate">Loading…</p>}
        {churn.error && <p className="font-body text-signal">Could not load churn.</p>}
        {churn.data && (
          <div className="flex gap-6">
            <div className="font-data text-xl tabular-nums">{(churn.data.churn_rate * 100).toFixed(1)}% subscriber churn</div>
            <div className="font-data text-xl tabular-nums">{(churn.data.revenue_churn * 100).toFixed(1)}% revenue churn</div>
          </div>
        )}
      </section>

      <section>
        <h2 className="font-display text-lg mb-3">Cohort retention</h2>
        {cohorts.isLoading && <p className="font-body text-slate">Loading…</p>}
        {cohorts.error && <p className="font-body text-signal">Could not load cohorts.</p>}
        {cohorts.data && (
          <table className="text-sm font-data tabular-nums">
            <thead>
              <tr className="text-left text-slate">
                <th className="pr-4 py-1">Cohort</th>
                <th className="pr-4 py-1">Size</th>
                {cohorts.data[0]?.offsets.map((o) => (
                  <th key={o.month} className="pr-4 py-1">M{o.month}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cohorts.data.map((row) => (
                <tr key={row.cohort}>
                  <td className="pr-4 py-1">{row.cohort}</td>
                  <td className="pr-4 py-1">{row.cohort_size}</td>
                  {row.offsets.map((o) => (
                    <td key={o.month} className="pr-4 py-1">{(o.retention_pct * 100).toFixed(0)}%</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 6: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Run the full apps/web suite to confirm no regression**

Run: `cd apps/web && npx vitest run`
Expected: all tests pass (8 from Tasks 3-5 + 1 from this task = 9 total).

- [ ] **Step 8: Commit**

```bash
git add "apps/web/app/(dashboard)/dashboard/analytics" apps/web/lib/hooks/useMrr.ts apps/web/lib/hooks/useChurn.ts apps/web/lib/hooks/useCohorts.ts apps/web/test/useMrr.test.ts
git commit -m "Add analytics page with MRR chart, churn, and cohort retention"
```

---

### Task 7: `/dashboard/developers` — API keys + webhooks

**Files:**
- Create: `apps/web/app/(dashboard)/dashboard/developers/page.tsx`
- Create: `apps/web/lib/hooks/useApiKeys.ts`
- Create: `apps/web/lib/hooks/useWebhookEndpoints.ts`
- Create: `apps/web/lib/hooks/useWebhookDeliveries.ts`
- Create: `apps/web/components/ApiKeyManager.tsx`
- Create: `apps/web/components/WebhookEndpointForm.tsx`
- Test: `apps/web/test/useApiKeys.test.ts`
- Test: `apps/web/test/ApiKeyManager.test.tsx`

**Interfaces:**
- Consumes: `apiFetch` (Task 3), `StatusBadge` (Task 2, for webhook delivery status).
- Produces: `useApiKeys(): {data, isLoading, error, createKey, revokeKey}` (wraps `GET/POST /v1/api-keys`, `DELETE /v1/api-keys/:id` — the only resource this phase gives write access to, since the whole point of a "developers" page is managing keys/webhooks, and both are off-chain metadata writes via already-real endpoints, matching this phase's "off-chain writes are in scope, on-chain writes are not" boundary already established for merchant onboarding in Task 3). This is the FINAL task of this phase.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/useApiKeys.test.ts`:

```typescript
import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useApiKeys } from "../lib/hooks/useApiKeys.js";

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useApiKeys", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches GET /v1/api-keys and returns the list", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ id: "k1", type: "secret", prefix: "ck_test_sec_abc" }]), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useApiKeys(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual([{ id: "k1", type: "secret", prefix: "ck_test_sec_abc" }]);
  });

  it("createKey() POSTs to /v1/api-keys with the given type", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "k2", key: "ck_test_sec_new", prefix: "ck_test_sec_new" }), { status: 201, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useApiKeys(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let createdKey: string | undefined;
    await act(async () => {
      createdKey = (await result.current.createKey("secret")).key;
    });

    expect(createdKey).toBe("ck_test_sec_new");
    const [, secondCallInit] = fetchMock.mock.calls[1];
    expect(secondCallInit.method).toBe("POST");
    expect(JSON.parse(secondCallInit.body)).toEqual({ type: "secret" });
  });
});
```

Create `apps/web/test/ApiKeyManager.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ApiKeyManager } from "../components/ApiKeyManager.js";

describe("ApiKeyManager", () => {
  it("shows the newly created raw key once after creation, then a masked prefix", async () => {
    const createKey = vi.fn().mockResolvedValue({ id: "k1", key: "ck_test_sec_rawvalue", prefix: "ck_test_sec_rawv" });
    render(<ApiKeyManager apiKeys={[]} createKey={createKey} revokeKey={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /create secret key/i }));

    const rawKey = await screen.findByText("ck_test_sec_rawvalue");
    expect(rawKey).toBeInTheDocument();
  });

  it("renders existing keys by their prefix only, never a full key value", () => {
    render(
      <ApiKeyManager
        apiKeys={[{ id: "k1", type: "secret", prefix: "ck_test_sec_abc", livemode: false, lastUsedAt: null, createdAt: "2026-07-01T00:00:00Z" }]}
        createKey={vi.fn()}
        revokeKey={vi.fn()}
      />,
    );

    expect(screen.getByText("ck_test_sec_abc")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && npx vitest run test/useApiKeys.test.ts test/ApiKeyManager.test.tsx`
Expected: FAIL — neither module exists.

- [ ] **Step 3: Implement `useApiKeys`**

Create `apps/web/lib/hooks/useApiKeys.ts`:

```typescript
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../apiFetch.js";

export interface ApiKey {
  id: string;
  type: "secret" | "publishable";
  prefix: string;
  livemode: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

export function useApiKeys() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["api-keys"],
    queryFn: () => apiFetch("/v1/api-keys") as Promise<ApiKey[]>,
  });

  async function createKey(type: "secret" | "publishable"): Promise<{ id: string; key: string; prefix: string }> {
    const result = (await apiFetch("/v1/api-keys", { method: "POST", body: JSON.stringify({ type }) })) as { id: string; key: string; prefix: string };
    await queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    return result;
  }

  async function revokeKey(id: string): Promise<void> {
    await apiFetch(`/v1/api-keys/${id}`, { method: "DELETE" });
    await queryClient.invalidateQueries({ queryKey: ["api-keys"] });
  }

  return { ...query, createKey, revokeKey };
}
```

- [ ] **Step 4: Run the hook test to verify it passes**

Run: `cd apps/web && npx vitest run test/useApiKeys.test.ts`
Expected: PASS (2/2 tests).

- [ ] **Step 5: Implement `ApiKeyManager`**

Create `apps/web/components/ApiKeyManager.tsx`:

```tsx
"use client";

import { useState } from "react";
import type { ApiKey } from "../lib/hooks/useApiKeys.js";

export interface ApiKeyManagerProps {
  apiKeys: ApiKey[];
  createKey: (type: "secret" | "publishable") => Promise<{ id: string; key: string; prefix: string }>;
  revokeKey: (id: string) => Promise<void>;
}

export function ApiKeyManager({ apiKeys, createKey, revokeKey }: ApiKeyManagerProps) {
  const [revealedKey, setRevealedKey] = useState<string | null>(null);

  async function handleCreate(type: "secret" | "publishable") {
    const result = await createKey(type);
    setRevealedKey(result.key);
  }

  return (
    <div>
      <div className="flex gap-2 mb-4">
        <button onClick={() => handleCreate("secret")} className="rounded-md bg-sapphire px-3 py-1.5 text-paper text-sm font-body">
          Create secret key
        </button>
        <button onClick={() => handleCreate("publishable")} className="rounded-md border border-sapphire px-3 py-1.5 text-sapphire text-sm font-body">
          Create publishable key
        </button>
      </div>
      {revealedKey && (
        <div className="mb-4 p-3 rounded-md bg-signal/10 border border-signal/30">
          <p className="text-xs font-body text-slate mb-1">Copy this key now — it won't be shown again.</p>
          <code className="font-data text-sm break-all">{revealedKey}</code>
        </div>
      )}
      <table className="w-full text-sm font-body">
        <thead>
          <tr className="text-left text-slate border-b border-slate/15">
            <th className="py-2">Key</th>
            <th className="py-2">Type</th>
            <th className="py-2"></th>
          </tr>
        </thead>
        <tbody>
          {apiKeys.map((key) => (
            <tr key={key.id} className="border-b border-slate/10">
              <td className="py-2 font-data">{key.prefix}…</td>
              <td className="py-2">{key.type}</td>
              <td className="py-2">
                <button onClick={() => revokeKey(key.id)} className="text-signal text-xs">
                  Revoke
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 6: Run the component test to verify it passes**

Run: `cd apps/web && npx vitest run test/ApiKeyManager.test.tsx`
Expected: PASS (2/2 tests).

- [ ] **Step 7: Implement `useWebhookEndpoints` and `useWebhookDeliveries`**

Create `apps/web/lib/hooks/useWebhookEndpoints.ts`:

```typescript
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../apiFetch.js";

export interface WebhookEndpoint {
  id: string;
  merchantId: string;
  url: string;
  enabledEvents: string[];
  status: "enabled" | "disabled";
  livemode: boolean;
  createdAt: string;
  updatedAt: string;
}

interface PageEnvelope<T> {
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export function useWebhookEndpoints() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["webhook-endpoints"],
    queryFn: () => apiFetch("/v1/webhook-endpoints") as Promise<PageEnvelope<WebhookEndpoint>>,
  });

  async function createEndpoint(url: string, enabledEvents?: string[]): Promise<WebhookEndpoint & { signingSecret: string }> {
    const result = (await apiFetch("/v1/webhook-endpoints", { method: "POST", body: JSON.stringify({ url, enabledEvents }) })) as WebhookEndpoint & {
      signingSecret: string;
    };
    await queryClient.invalidateQueries({ queryKey: ["webhook-endpoints"] });
    return result;
  }

  return { ...query, data: query.data?.data, createEndpoint };
}
```

Create `apps/web/lib/hooks/useWebhookDeliveries.ts`:

```typescript
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../apiFetch.js";

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  status: "pending" | "succeeded" | "failed" | "dead";
  attempts: number;
  nextAttemptAt: string | null;
  responseCode: number | null;
  responseBody: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PageEnvelope<T> {
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export function useWebhookDeliveries() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["webhook-deliveries"],
    queryFn: () => apiFetch("/v1/webhook-deliveries") as Promise<PageEnvelope<WebhookDelivery>>,
  });

  async function replay(id: string): Promise<void> {
    await apiFetch(`/v1/webhook-deliveries/${id}/replay`, { method: "POST" });
    await queryClient.invalidateQueries({ queryKey: ["webhook-deliveries"] });
  }

  return { ...query, data: query.data?.data, replay };
}
```

- [ ] **Step 8: Implement `WebhookEndpointForm`**

Create `apps/web/components/WebhookEndpointForm.tsx`:

```tsx
"use client";

import { useState } from "react";

export interface WebhookEndpointFormProps {
  onSubmit: (url: string) => Promise<void>;
}

export function WebhookEndpointForm({ onSubmit }: WebhookEndpointFormProps) {
  const [url, setUrl] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setIsSubmitting(true);
    try {
      await onSubmit(url);
      setUrl("");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2 mb-4">
      <input
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://example.com/webhook"
        required
        className="flex-1 rounded-md border border-slate/30 px-3 py-1.5 text-sm font-data"
      />
      <button type="submit" disabled={isSubmitting} className="rounded-md bg-sapphire px-3 py-1.5 text-paper text-sm font-body">
        Add endpoint
      </button>
    </form>
  );
}
```

- [ ] **Step 9: Build the developers page**

Create `apps/web/app/(dashboard)/dashboard/developers/page.tsx`:

```tsx
"use client";

import { useApiKeys } from "../../../../lib/hooks/useApiKeys.js";
import { useWebhookEndpoints } from "../../../../lib/hooks/useWebhookEndpoints.js";
import { useWebhookDeliveries } from "../../../../lib/hooks/useWebhookDeliveries.js";
import { ApiKeyManager } from "../../../../components/ApiKeyManager.js";
import { WebhookEndpointForm } from "../../../../components/WebhookEndpointForm.js";
import { StatusBadge } from "@cadence/ui";

export default function DevelopersPage() {
  const apiKeys = useApiKeys();
  const endpoints = useWebhookEndpoints();
  const deliveries = useWebhookDeliveries();

  return (
    <div>
      <h1 className="font-display text-2xl mb-6">Developers</h1>

      <section className="mb-8">
        <h2 className="font-display text-lg mb-3">API keys</h2>
        {apiKeys.isLoading && <p className="font-body text-slate">Loading…</p>}
        {apiKeys.data && <ApiKeyManager apiKeys={apiKeys.data} createKey={apiKeys.createKey} revokeKey={apiKeys.revokeKey} />}
      </section>

      <section className="mb-8">
        <h2 className="font-display text-lg mb-3">Webhook endpoints</h2>
        <WebhookEndpointForm onSubmit={async (url) => { await endpoints.createEndpoint(url); }} />
        {endpoints.isLoading && <p className="font-body text-slate">Loading…</p>}
        <ul className="text-sm font-data">
          {endpoints.data?.map((ep) => (
            <li key={ep.id} className="flex items-center gap-2 py-1">
              <span>{ep.url}</span>
              <StatusBadge status={ep.status === "enabled" ? "active" : "canceled"} />
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="font-display text-lg mb-3">Delivery log</h2>
        {deliveries.isLoading && <p className="font-body text-slate">Loading…</p>}
        <table className="w-full text-sm font-body">
          <thead>
            <tr className="text-left text-slate border-b border-slate/15">
              <th className="py-2">Event</th>
              <th className="py-2">Status</th>
              <th className="py-2">Attempts</th>
              <th className="py-2"></th>
            </tr>
          </thead>
          <tbody>
            {deliveries.data?.map((d) => (
              <tr key={d.id} className="border-b border-slate/10">
                <td className="py-2 font-data">{d.eventType}</td>
                <td className="py-2"><StatusBadge status={d.status === "succeeded" ? "active" : d.status === "dead" ? "canceled" : "past_due"} /></td>
                <td className="py-2 font-data tabular-nums">{d.attempts}</td>
                <td className="py-2">
                  {(d.status === "failed" || d.status === "dead") && (
                    <button onClick={() => deliveries.replay(d.id)} className="text-sapphire text-xs">
                      Replay
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
```

Note the `StatusBadge status={...}` calls for webhook endpoint/delivery status remap onto the four colors `StatusBadge` already knows (`active`/`past_due`/`canceled`) rather than extending `StatusBadge`'s own `STATUS_COLOR` map with webhook-specific keys (`enabled`/`succeeded`/`pending`/`dead`) — this is a deliberate reuse choice: introducing webhook-specific status strings into `packages/ui`'s shared `StatusBadge` would couple that component's vocabulary to one specific domain (webhooks) rather than the general subscription-lifecycle vocabulary it already models, so the page-level remapping keeps `StatusBadge` itself unchanged and reusable.

- [ ] **Step 10: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 11: Run the full apps/web suite one final time**

Run: `cd apps/web && npx vitest run`
Expected: all tests pass (9 from Tasks 3-6 + 4 from this task = 13 total).

- [ ] **Step 12: Run the full packages/ui suite one final time**

Run: `cd packages/ui && npx vitest run`
Expected: all tests pass (10/10, unchanged from Task 2 — this task doesn't modify `packages/ui`).

- [ ] **Step 13: Manual smoke check**

Run: `pnpm --filter @cadence/api dev` in the background, `pnpm --filter @cadence/web dev` in the background, then visit `http://localhost:3001/dashboard` in a browser (or `curl -s http://localhost:3001/dashboard | grep -o "Sign in to Cadence"` for a headless check) and confirm the sign-in gate renders (full wallet-connect interaction is out of scope for an automated check in this phase, but confirming the page boots and the auth gate shows is a cheap, meaningful smoke test). Stop both dev servers after confirming.

- [ ] **Step 14: Commit**

```bash
git add "apps/web/app/(dashboard)/dashboard/developers" apps/web/lib/hooks/useApiKeys.ts apps/web/lib/hooks/useWebhookEndpoints.ts apps/web/lib/hooks/useWebhookDeliveries.ts apps/web/components/ApiKeyManager.tsx apps/web/components/WebhookEndpointForm.tsx apps/web/test/useApiKeys.test.ts apps/web/test/ApiKeyManager.test.tsx
git commit -m "Add developers page: API key management and webhook endpoints/deliveries"
```

---

## Plan Self-Review Notes

**Spec coverage check:**
- `apps/web` Next.js 15 scaffold + Tailwind v4 design tokens → Task 1. ✓
- `apps/api` CORS fix (a gap discovered during planning, not in the original spec text, but a hard blocker for the spec's own architecture — added to Global Constraints and Task 1) → Task 1. ✓
- `packages/ui` bootstrap with `CadencePulse`/`StatusBadge` → Task 2. ✓
- SIWE sign-in (wagmi + viem + ConnectKit, direct `apiFetch`, not the SDK) → Task 3. ✓
- Merchant onboarding for the first-sign-in-no-merchant-account case (a gap discovered during planning, resolved via a fresh question, documented in Global Constraints) → Task 3. ✓
- `/dashboard` overview, `/dashboard/plans` → Task 4. ✓
- `/dashboard/subscriptions` list + detail → Task 5. ✓
- `/dashboard/analytics` (MRR chart, churn, cohorts) → Task 6. ✓
- `/dashboard/developers` (API keys + webhooks CRUD + delivery replay) → Task 7. ✓
- No `SplitFlow`, no create-plan wizard, no payouts/settings routes, no portal, no marketing, no SDK import, no Playwright e2e → confirmed nowhere in this plan does any task build these. ✓

**Placeholder scan:** No "TBD"/"TODO"/vague requirements found. Every step has complete, concrete code.

**Type consistency check:** `apiFetch`'s signature (Task 3: `apiFetch(path: string, options?: RequestInit): Promise<unknown>`, throwing `ApiError`) is used identically by every hook across Tasks 4-7 — every hook calls `apiFetch(path) as Promise<SpecificType>`. `Plan`/`Subscription`/`SubscriptionDetail`/`ChargeSummary`/`PlanSummary`/`AnalyticsSummary`/`MrrPoint`/`CohortRow`/`ApiKey`/`WebhookEndpoint`/`WebhookDelivery` types are each defined exactly once (in their owning hook file) and imported by any consuming page — never redefined inline in a page component. `StatusBadge`/`CadencePulse` (Task 2) are imported via the `@cadence/ui` package export identically in Tasks 4, 5, and 7 — no task reaches into `packages/ui/src/*` directly.

**Gap found and fixed during self-review:** an initial draft of Task 5's subscriptions list page passed `periodSeconds={undefined}` to `CadencePulse` for each row, since the list endpoint's response shape has no `plan.period_seconds` field (only the detail endpoint does) — this would have been a runtime `NaN`/broken-render bug (`CadencePulse`'s `periodEnd.getTime() - periodSeconds * 1000` becomes `NaN` when `periodSeconds` is `undefined`). Fixed by hardcoding a documented placeholder `30 * 86400` (30 days) for the list view specifically, with an explicit code comment in Task 5 Step 6 explaining why this is a deliberate simplification (avoiding N+1 requests) rather than an oversight, and confirming the detail page (Step 7) correctly uses the real per-plan value it does have access to.

**Response-shape verification:** every hook's response `interface` across Tasks 4-7 was transcribed from `packages/sdk/src/types.ts` (Phase 1j, already verified correct across 5 task reviews and one whole-branch review) for the snake_case resources (`plans`/`subscriptions`/`analytics`), and from the same file's camelCase interfaces for `webhookEndpoints`/`webhookDeliveries` — with the sole addition of `ApiKey` (not in the SDK's types, since `cadence.apiKeys` was excluded from the SDK entirely; transcribed fresh from `apps/api/src/api-keys/api-keys.service.ts`'s `ApiKeyRow`/`Omit<ApiKeyRow, "keyHash">` types and `packages/db/src/schema.ts`'s `apiKey` table definition during this plan's own research). None of these types are imported from `@cadence/sdk` itself, per this phase's Global Constraint — they are independently transcribed, small, and duplicated by design (documented explicitly in Task 4 Step 4's note).
