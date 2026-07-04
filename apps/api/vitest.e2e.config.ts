import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";

export default defineConfig({
  plugins: [
    // Vitest transpiles TS via esbuild, which does not emit the
    // `design:paramtypes` decorator metadata that Nest's DI container
    // relies on for constructor-based (type-inferred) injection. Swapping
    // in the SWC transform (Nest's officially recommended Vitest setup)
    // restores that metadata so `@Injectable`/`@Controller` classes with
    // plain typed constructor params — e.g. `AuthController`, `AuthService`,
    // `SessionGuard` — resolve correctly instead of injecting `undefined`.
    swc.vite({ module: { type: "es6" } }),
  ],
  test: {
    include: ["test/**/*.e2e-spec.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
