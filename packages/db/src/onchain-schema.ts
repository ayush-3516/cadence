import { pgTable, text, numeric, bigint, boolean, integer, timestamp, smallint } from "drizzle-orm/pg-core";

// Read-only mirrors of Ponder-owned tables (apps/indexer/ponder.schema.ts).
// Ponder creates and migrates these tables at indexer startup; this file
// exists only so apps/api can build type-safe queries/joins against them.
// It is NOT part of the app's real migration path — see
// drizzle.onchain.config.ts and the Global Constraints in this plan's
// implementation plan doc.

export const onchainPlan = pgTable("onchain_plan", {
  onchainPlanId: numeric("onchain_plan_id", { precision: 78, scale: 0 }).primaryKey(),
  merchantAddress: text("merchant_address").notNull(),
  payoutSplit: text("payout_split").notNull(),
  token: text("token").notNull(),
  amount: numeric("amount", { precision: 78, scale: 0 }).notNull(),
  periodSeconds: bigint("period_seconds", { mode: "bigint" }).notNull(),
  trialSeconds: bigint("trial_seconds", { mode: "bigint" }).notNull(),
  active: boolean("active").notNull(),
  chainId: integer("chain_id").notNull(),
  createdBlock: bigint("created_block", { mode: "bigint" }),
  createdTx: text("created_tx"),
  createdAt: timestamp("created_at", { withTimezone: true }),
});

export const onchainSubscription = pgTable("onchain_subscription", {
  onchainSubId: numeric("onchain_sub_id", { precision: 78, scale: 0 }).primaryKey(),
  onchainPlanId: numeric("onchain_plan_id", { precision: 78, scale: 0 }).notNull(),
  subscriberAddress: text("subscriber_address").notNull(),
  status: text("status").notNull(),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }).notNull(),
  pausedRemaining: bigint("paused_remaining", { mode: "bigint" }).notNull(),
  pendingCancel: boolean("pending_cancel").notNull(),
  canceledAt: timestamp("canceled_at", { withTimezone: true }),
  chainId: integer("chain_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
});

export const onchainCharge = pgTable("onchain_charge", {
  id: text("id").primaryKey(),
  onchainSubId: numeric("onchain_sub_id", { precision: 78, scale: 0 }).notNull(),
  onchainPlanId: numeric("onchain_plan_id", { precision: 78, scale: 0 }).notNull(),
  status: text("status").notNull(),
  reason: smallint("reason"),
  amount: numeric("amount", { precision: 78, scale: 0 }),
  platformFee: numeric("platform_fee", { precision: 78, scale: 0 }),
  net: numeric("net", { precision: 78, scale: 0 }),
  token: text("token"),
  usdValue: numeric("usd_value", { precision: 20, scale: 6 }),
  txHash: text("tx_hash").notNull(),
  blockNumber: bigint("block_number", { mode: "bigint" }),
  chainId: integer("chain_id"),
  chargedAt: timestamp("charged_at", { withTimezone: true }).notNull(),
});

export const onchainPayout = pgTable("onchain_payout", {
  id: text("id").primaryKey(),
  splitAddress: text("split_address").notNull(),
  recipient: text("recipient").notNull(),
  token: text("token").notNull(),
  amount: numeric("amount", { precision: 78, scale: 0 }).notNull(),
  usdValue: numeric("usd_value", { precision: 20, scale: 6 }),
  txHash: text("tx_hash"),
  blockNumber: bigint("block_number", { mode: "bigint" }),
  chainId: integer("chain_id"),
  distributedAt: timestamp("distributed_at", { withTimezone: true }).notNull(),
});
