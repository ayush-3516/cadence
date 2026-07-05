import { defineConfig } from "drizzle-kit";

// Generates migration DDL for the read-only on-chain mirror tables, for
// use ONLY in test database setup (apps/api/test/setup.ts). Never run
// `migrate` with this config against a real dev/prod database — Ponder
// owns and creates these tables itself at indexer startup.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/onchain-schema.ts",
  out: "./migrations-onchain",
  // Distinct migrations-tracking table from the main config (which uses the
  // default `drizzle.__drizzle_migrations`). Without this, both `drizzle-kit
  // migrate` runs in apps/api/test/setup.ts share one tracking table, and once
  // the main journal accumulates enough entries, drizzle-kit's dedup logic can
  // treat the onchain migration as already-applied and silently skip it —
  // leaving onchain_plan/onchain_subscription/onchain_charge missing from a
  // freshly migrated test database.
  migrations: {
    table: "__drizzle_migrations_onchain",
    schema: "drizzle",
  },
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://cadence:cadence@localhost:5432/cadence",
  },
});
