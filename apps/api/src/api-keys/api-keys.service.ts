import { Inject, Injectable } from "@nestjs/common";
import { randomBytes, createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { schema } from "@cadence/db";
import type { DbClient } from "@cadence/db";
import { DB_CLIENT } from "../db/db.module.js";
import { AppException } from "../common/errors.js";

export type ApiKeyType = "secret" | "publishable";
export type ApiKeyRow = typeof schema.apiKey.$inferSelect;

const KEY_TYPE_SEGMENT: Record<ApiKeyType, string> = { secret: "sec", publishable: "pub" };
const LAST_USED_THROTTLE_MS = 60_000;

function generateRawKey(type: ApiKeyType, livemode: boolean): string {
  const mode = livemode ? "live" : "test";
  const random = randomBytes(24).toString("base64url");
  return `ck_${mode}_${KEY_TYPE_SEGMENT[type]}_${random}`;
}

function hashKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

@Injectable()
export class ApiKeysService {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async create(merchantId: string, type: ApiKeyType, livemode: boolean): Promise<{ id: string; key: string; prefix: string }> {
    const rawKey = generateRawKey(type, livemode);
    const prefix = rawKey.slice(0, 20);
    const keyHash = hashKey(rawKey);

    const [created] = await this.db
      .insert(schema.apiKey)
      .values({ merchantId, type, keyHash, prefix, livemode })
      .returning();

    return { id: created.id, key: rawKey, prefix: created.prefix };
  }

  async listForMerchant(merchantId: string): Promise<Omit<ApiKeyRow, "keyHash">[]> {
    const rows = await this.db.select().from(schema.apiKey).where(eq(schema.apiKey.merchantId, merchantId));
    return rows.map(({ keyHash: _keyHash, ...rest }) => rest);
  }

  async revoke(merchantId: string, keyId: string): Promise<void> {
    const [existing] = await this.db
      .select()
      .from(schema.apiKey)
      .where(and(eq(schema.apiKey.id, keyId), eq(schema.apiKey.merchantId, merchantId)));

    if (!existing) {
      throw new AppException({
        type: "invalid_request_error",
        code: "api_key_not_found",
        message: "No API key with that id exists for this merchant.",
        param: "id",
      });
    }

    await this.db.update(schema.apiKey).set({ revokedAt: new Date() }).where(eq(schema.apiKey.id, keyId));
  }

  async findActiveByRawKey(rawKey: string): Promise<ApiKeyRow | undefined> {
    const keyHash = hashKey(rawKey);
    const [found] = await this.db
      .select()
      .from(schema.apiKey)
      .where(and(eq(schema.apiKey.keyHash, keyHash), isNull(schema.apiKey.revokedAt)));
    return found;
  }

  async touchLastUsed(keyId: string, currentLastUsedAt: Date | null): Promise<void> {
    const now = Date.now();
    if (currentLastUsedAt && now - currentLastUsedAt.getTime() < LAST_USED_THROTTLE_MS) {
      return;
    }
    await this.db.update(schema.apiKey).set({ lastUsedAt: new Date() }).where(eq(schema.apiKey.id, keyId));
  }
}
