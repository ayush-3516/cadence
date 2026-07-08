import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySignature } from "../src/webhooks.js";

function sign(rawBody: string, secret: string, timestamp: number): string {
  const sig = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

describe("verifySignature", () => {
  it("accepts a signature genuinely produced with the correct secret", () => {
    const rawBody = JSON.stringify({ id: "evt_1", type: "subscription.created" });
    const secret = "whsec_test_abc123";
    const header = sign(rawBody, secret, 1751990400);

    expect(verifySignature(rawBody, header, secret)).toBe(true);
  });

  it("rejects a signature produced with the wrong secret", () => {
    const rawBody = JSON.stringify({ id: "evt_1", type: "subscription.created" });
    const header = sign(rawBody, "whsec_correct", 1751990400);

    expect(verifySignature(rawBody, header, "whsec_wrong")).toBe(false);
  });

  it("rejects when the raw body has been tampered with after signing", () => {
    const secret = "whsec_test_abc123";
    const header = sign(JSON.stringify({ id: "evt_1", type: "subscription.created" }), secret, 1751990400);
    const tamperedBody = JSON.stringify({ id: "evt_1", type: "subscription.deleted" });

    expect(verifySignature(tamperedBody, header, secret)).toBe(false);
  });

  it("rejects a malformed header", () => {
    const rawBody = JSON.stringify({ id: "evt_1" });
    expect(verifySignature(rawBody, "not-a-valid-header", "whsec_test_abc123")).toBe(false);
  });
});
