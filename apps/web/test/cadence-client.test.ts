import { describe, expect, it, vi, beforeEach } from "vitest";

describe("cadence client", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("constructs a Cadence client with the publishable key and base URL from env", async () => {
    vi.stubEnv("NEXT_PUBLIC_PORTAL_PUBLISHABLE_KEY", "ck_test_pub_abc123");
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://localhost:3000");

    const { cadence } = await import("../lib/cadence-client.js");

    expect(cadence).toBeDefined();
    expect(cadence.customers).toBeDefined();
    expect(cadence.subscriptions).toBeDefined();
    expect(cadence.invoices).toBeDefined();
  });
});
