import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM's recommended nonce length
const SALT = "cadence-webhook-signing-secret"; // fixed salt: WEBHOOK_SIGNING_ROTATION_KEY is already a high-entropy secret managed out-of-band (KMS/env), not a user password — a fixed salt here is standard practice for key-derivation-from-a-secret (not key-derivation-from-a-password, which is what a random-per-use salt would defend against).

function deriveKey(key: string): Buffer {
  return scryptSync(key, SALT, 32);
}

export function encryptSecret(plaintext: string, key: string): string {
  const derivedKey = deriveKey(key);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, derivedKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptSecret(ciphertext: string, key: string): string {
  const derivedKey = deriveKey(key);
  const buf = Buffer.from(ciphertext, "base64");
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + 16);
  const encrypted = buf.subarray(IV_LENGTH + 16);
  const decipher = createDecipheriv(ALGORITHM, derivedKey, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}
