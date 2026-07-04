import { pgTable, pgEnum, uuid, text, boolean, timestamp, unique, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const apiKeyType = pgEnum("api_key_type", ["publishable", "secret"]);

export const merchant = pgTable(
  "merchant",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    ownerAddress: text("owner_address").notNull(),
    livemode: boolean("livemode").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("merchant_owner_address_livemode_unique").on(table.ownerAddress, table.livemode)],
);

export const apiKey = pgTable(
  "api_key",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    merchantId: uuid("merchant_id").notNull().references(() => merchant.id),
    type: apiKeyType("type").notNull(),
    keyHash: text("key_hash").notNull(),
    prefix: text("prefix").notNull(),
    livemode: boolean("livemode").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("api_key_key_hash_unique").on(table.keyHash),
    index("api_key_merchant_id_idx").on(table.merchantId),
    index("api_key_key_hash_idx").on(table.keyHash),
  ],
);
