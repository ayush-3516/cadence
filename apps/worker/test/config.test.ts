import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";

const REQUIRED_ENV = {
  DATABASE_URL: "postgres://cadence:cadence@localhost:5432/cadence",
  REDIS_URL: "redis://localhost:6379",
  RELAYER_PRIVATE_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  RPC_URL_HTTP: "http://localhost:8545",
  CHAIN_ID: "84532",
};

describe("loadConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads all required fields with a default scheduler interval", () => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) vi.stubEnv(key, value);
    vi.stubEnv("CHARGE_SCHEDULER_INTERVAL_MS", undefined);

    const config = loadConfig();
    expect(config.databaseUrl).toBe(REQUIRED_ENV.DATABASE_URL);
    expect(config.chainId).toBe(84532);
    expect(config.schedulerIntervalMs).toBe(300_000);
  });

  it("respects a custom scheduler interval", () => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) vi.stubEnv(key, value);
    vi.stubEnv("CHARGE_SCHEDULER_INTERVAL_MS", "60000");

    expect(loadConfig().schedulerIntervalMs).toBe(60_000);
  });

  it("throws a clear error when RELAYER_PRIVATE_KEY is missing", () => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      if (key !== "RELAYER_PRIVATE_KEY") vi.stubEnv(key, value);
    }
    expect(() => loadConfig()).toThrow(/RELAYER_PRIVATE_KEY/);
  });
});
