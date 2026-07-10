import { defineConfig } from "vitest/config";
import path from "node:path";

// Ponder's "ponder:registry" and "ponder:schema" specifiers are virtual
// modules that only resolve inside Ponder's own dev/build runtime. Handler
// files (e.g. src/SplitsWarehouse.ts) import them at module scope to
// register `ponder.on(...)` callbacks. To unit-test the plain exported
// handler functions under vitest, alias those specifiers to lightweight
// test doubles rather than pulling in a live Ponder runtime.
export default defineConfig({
  resolve: {
    alias: {
      "ponder:registry": path.resolve(__dirname, "test/mocks/ponder-registry.ts"),
      "ponder:schema": path.resolve(__dirname, "test/mocks/ponder-schema.ts"),
    },
  },
});
