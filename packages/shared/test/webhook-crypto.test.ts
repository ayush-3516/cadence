import { describe, expect, it } from "vitest";
import { encryptSecret, decryptSecret } from "../src/webhook-crypto.js";

const TEST_KEY = "0123456789abcdef0123456789abcdef"; // 32 bytes as a utf-8 string, matching WEBHOOK_SIGNING_ROTATION_KEY's expected format

describe("webhook-crypto", () => {
  it("round-trips a secret through encrypt then decrypt", () => {
    const plaintext = "whsec_abcdefghijklmnopqrstuvwxyz0123456789";
    const ciphertext = encryptSecret(plaintext, TEST_KEY);
    expect(decryptSecret(ciphertext, TEST_KEY)).toBe(plaintext);
  });

  it("produces ciphertext that does not contain the plaintext", () => {
    const plaintext = "whsec_abcdefghijklmnopqrstuvwxyz0123456789";
    const ciphertext = encryptSecret(plaintext, TEST_KEY);
    expect(ciphertext).not.toContain(plaintext);
  });

  it("produces different ciphertext on each call for the same plaintext (random IV)", () => {
    const plaintext = "whsec_abcdefghijklmnopqrstuvwxyz0123456789";
    const a = encryptSecret(plaintext, TEST_KEY);
    const b = encryptSecret(plaintext, TEST_KEY);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, TEST_KEY)).toBe(plaintext);
    expect(decryptSecret(b, TEST_KEY)).toBe(plaintext);
  });

  it("throws when decrypting with the wrong key", () => {
    const plaintext = "whsec_abcdefghijklmnopqrstuvwxyz0123456789";
    const ciphertext = encryptSecret(plaintext, TEST_KEY);
    const wrongKey = "fedcba9876543210fedcba9876543210";
    expect(() => decryptSecret(ciphertext, wrongKey)).toThrow();
  });

  it("throws when decrypting tampered ciphertext", () => {
    const plaintext = "whsec_abcdefghijklmnopqrstuvwxyz0123456789";
    const ciphertext = encryptSecret(plaintext, TEST_KEY);
    const tampered = ciphertext.slice(0, -4) + "abcd";
    expect(() => decryptSecret(tampered, TEST_KEY)).toThrow();
  });
});
