import { onchainTable } from "ponder";

// subscription_status: none | trialing | active | past_due | paused | canceled
// charge_status: success | failed
// Stored as plain text (not a Postgres native enum) — Ponder/Drizzle's
// onchainTable doesn't expose a first-class pgEnum helper as cleanly as
// text columns, and a text column with app-level validation is simpler to
// evolve without a migration. The API layer (a later sub-project) is the
// enforcement point for valid values on read.

export const onchainPlan = onchainTable("onchain_plan", (t) => ({
  onchainPlanId: t.numeric("onchain_plan_id").primaryKey(),
  merchantAddress: t.text("merchant_address").notNull(),
  payoutSplit: t.text("payout_split").notNull(),
  token: t.text("token").notNull(),
  amount: t.numeric("amount", { precision: 78, scale: 0 }).notNull(),
  periodSeconds: t.bigint("period_seconds").notNull(),
  trialSeconds: t.bigint("trial_seconds").notNull(),
  active: t.boolean("active").notNull(),
  chainId: t.integer("chain_id").notNull(),
  createdBlock: t.bigint("created_block"),
  createdTx: t.text("created_tx"),
  createdAt: t.timestamp("created_at", { withTimezone: true }),
}));

export const onchainSubscription = onchainTable("onchain_subscription", (t) => ({
  onchainSubId: t.numeric("onchain_sub_id").primaryKey(),
  onchainPlanId: t.numeric("onchain_plan_id").notNull(),
  subscriberAddress: t.text("subscriber_address").notNull(),
  status: t.text("status").notNull(),
  currentPeriodEnd: t.timestamp("current_period_end", { withTimezone: true }).notNull(),
  pausedRemaining: t.bigint("paused_remaining").notNull().default(0n),
  pendingCancel: t.boolean("pending_cancel").notNull().default(false),
  canceledAt: t.timestamp("canceled_at", { withTimezone: true }),
  chainId: t.integer("chain_id").notNull(),
  createdAt: t.timestamp("created_at", { withTimezone: true }),
  updatedAt: t.timestamp("updated_at", { withTimezone: true }),
}));

export const onchainCharge = onchainTable("onchain_charge", (t) => ({
  id: t.text("id").primaryKey(), // `${txHash}:${logIndex}`
  onchainSubId: t.numeric("onchain_sub_id").notNull(),
  onchainPlanId: t.numeric("onchain_plan_id").notNull(),
  status: t.text("status").notNull(), // charge_status: success | failed
  reason: t.smallint("reason"), // set when status = failed
  amount: t.numeric("amount", { precision: 78, scale: 0 }),
  platformFee: t.numeric("platform_fee", { precision: 78, scale: 0 }),
  net: t.numeric("net", { precision: 78, scale: 0 }),
  token: t.text("token"),
  usdValue: t.numeric("usd_value", { precision: 20, scale: 6 }),
  txHash: t.text("tx_hash").notNull(),
  blockNumber: t.bigint("block_number"),
  chainId: t.integer("chain_id"),
  chargedAt: t.timestamp("charged_at", { withTimezone: true }).notNull(),
}));

export const onchainPayout = onchainTable("onchain_payout", (t) => ({
  id: t.text("id").primaryKey(), // `${txHash}:${logIndex}`
  splitAddress: t.text("split_address").notNull(),
  recipient: t.text("recipient").notNull(),
  token: t.text("token").notNull(),
  amount: t.numeric("amount", { precision: 78, scale: 0 }).notNull(),
  usdValue: t.numeric("usd_value", { precision: 20, scale: 6 }),
  txHash: t.text("tx_hash"),
  blockNumber: t.bigint("block_number"),
  chainId: t.integer("chain_id"),
  distributedAt: t.timestamp("distributed_at", { withTimezone: true }).notNull(),
}));
