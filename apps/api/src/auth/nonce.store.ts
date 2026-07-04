import { Injectable } from "@nestjs/common";
import { generateNonce } from "siwe";

interface NonceRecord {
  expiresAt: number;
}

const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

@Injectable()
export class NonceStore {
  private readonly nonces = new Map<string, NonceRecord>();

  issue(): string {
    const nonce = generateNonce();
    this.nonces.set(nonce, { expiresAt: Date.now() + NONCE_TTL_MS });
    return nonce;
  }

  /** Consumes the nonce (single-use) if it exists and hasn't expired. Returns whether it was valid. */
  consume(nonce: string): boolean {
    const record = this.nonces.get(nonce);
    this.nonces.delete(nonce);
    if (!record) return false;
    return record.expiresAt > Date.now();
  }
}
