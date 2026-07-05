import { defineConfig } from "drizzle-kit";

// Generates migration DDL for the read-only on-chain mirror tables, for
// use ONLY in test database setup (apps/api/test/setup.ts). Never run
// `migrate` with this config against a real dev/prod database — Ponder
// owns and creates these tables itself at indexer startup.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/onchain-schema.ts",
  out: "./migrations-onchain",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://cadence:cadence@localhost:5432/cadence",
  },
});
