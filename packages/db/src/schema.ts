import { pgTable, pgEnum, uuid, text, boolean, timestamp, unique, index, jsonb, numeric, smallint, integer } from "drizzle-orm/pg-core";
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

export const webhookStatusEnum = pgEnum("webhook_status", ["enabled", "disabled"]);
export const deliveryStatusEnum = pgEnum("delivery_status", ["pending", "succeeded", "failed", "dead"]);

export const event = pgTable(
  "event",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    merchantId: uuid("merchant_id").notNull().references(() => merchant.id),
    type: text("type").notNull(),
    data: jsonb("data").notNull(),
    onchainTxHash: text("onchain_tx_hash"),
    livemode: boolean("livemode").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("event_merchant_id_created_at_idx").on(table.merchantId, table.createdAt),
    index("event_type_idx").on(table.type),
  ],
);

export const webhookEndpoint = pgTable(
  "webhook_endpoint",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    merchantId: uuid("merchant_id").notNull().references(() => merchant.id),
    url: text("url").notNull(),
    signingSecret: text("signing_secret").notNull(),
    enabledEvents: jsonb("enabled_events").notNull().default(sql`'["*"]'::jsonb`),
    status: webhookStatusEnum("status").notNull().default("enabled"),
    livemode: boolean("livemode").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("webhook_endpoint_merchant_id_idx").on(table.merchantId)],
);

export const webhookDelivery = pgTable(
  "webhook_delivery",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    endpointId: uuid("endpoint_id").notNull().references(() => webhookEndpoint.id),
    eventId: uuid("event_id").notNull().references(() => event.id),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    status: deliveryStatusEnum("status").notNull().default("pending"),
    attempts: smallint("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    responseCode: integer("response_code"),
    responseBody: text("response_body"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("webhook_delivery_endpoint_id_event_id_unique").on(table.endpointId, table.eventId),
    index("webhook_delivery_status_next_attempt_at_idx").on(table.status, table.nextAttemptAt),
  ],
);
