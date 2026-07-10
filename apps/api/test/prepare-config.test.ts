import { describe, expect, it, afterEach } from "vitest";
import { loadPrepareConfig } from "../src/config/prepare-config.js";

describe("loadPrepareConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("throws when CHAIN_ID is missing", () => {
    delete process.env.CHAIN_ID;
    process.env.RPC_URL_HTTP = "http://localhost:8545";
    expect(() => loadPrepareConfig()).toThrow("Missing required environment variable: CHAIN_ID");
  });

  it("throws when RPC_URL_HTTP is missing", () => {
    process.env.CHAIN_ID = "84532";
    delete process.env.RPC_URL_HTTP;
    expect(() => loadPrepareConfig()).toThrow("Missing required environment variable: RPC_URL_HTTP");
  });

  it("loads chainId, rpcUrlHttp, and the deployment's subscriptionManager address for chain 84532", () => {
    process.env.CHAIN_ID = "84532";
    process.env.RPC_URL_HTTP = "http://localhost:8545";

    const config = loadPrepareConfig();

    expect(config.chainId).toBe(84532);
    expect(config.rpcUrlHttp).toBe("http://localhost:8545");
    expect(config.subscriptionManagerAddress).toBe("0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9");
  });
});
