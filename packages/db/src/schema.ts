import { pgTable, pgEnum, uuid, text, boolean, timestamp, unique, index, jsonb, numeric, smallint } from "drizzle-orm/pg-core";
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

export const planMeta = pgTable("plan_meta", {
  onchainPlanId: text("onchain_plan_id").primaryKey(),
  merchantId: uuid("merchant_id").notNull().references(() => merchant.id),
  name: text("name").notNull(),
  description: text("description"),
  imageUrl: text("image_url"),
  dunningLadder: jsonb("dunning_ladder").notNull().default(sql`'["1d","3d","5d","7d"]'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const customer = pgTable(
  "customer",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    merchantId: uuid("merchant_id").notNull().references(() => merchant.id),
    address: text("address").notNull(),
    email: text("email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("customer_merchant_id_address_unique").on(table.merchantId, table.address)],
);

export const dunningState = pgTable("dunning_state", {
  onchainSubId: numeric("onchain_sub_id", { precision: 78, scale: 0 }).primaryKey(),
  attempt: smallint("attempt").notNull().default(1),
  nextRetryAt: timestamp("next_retry_at", { withTimezone: true }).notNull(),
  exhausted: boolean("exhausted").notNull().default(false),
  ladder: jsonb("ladder").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
