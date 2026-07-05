CREATE TABLE "onchain_charge" (
	"id" text PRIMARY KEY NOT NULL,
	"onchain_sub_id" numeric(78, 0) NOT NULL,
	"onchain_plan_id" numeric(78, 0) NOT NULL,
	"status" text NOT NULL,
	"reason" smallint,
	"amount" numeric(78, 0),
	"platform_fee" numeric(78, 0),
	"net" numeric(78, 0),
	"token" text,
	"usd_value" numeric(20, 6),
	"tx_hash" text NOT NULL,
	"block_number" bigint,
	"chain_id" integer,
	"charged_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onchain_plan" (
	"onchain_plan_id" numeric(78, 0) PRIMARY KEY NOT NULL,
	"merchant_address" text NOT NULL,
	"payout_split" text NOT NULL,
	"token" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"period_seconds" bigint NOT NULL,
	"trial_seconds" bigint NOT NULL,
	"active" boolean NOT NULL,
	"chain_id" integer NOT NULL,
	"created_block" bigint,
	"created_tx" text,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "onchain_subscription" (
	"onchain_sub_id" numeric(78, 0) PRIMARY KEY NOT NULL,
	"onchain_plan_id" numeric(78, 0) NOT NULL,
	"subscriber_address" text NOT NULL,
	"status" text NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"paused_remaining" bigint NOT NULL,
	"pending_cancel" boolean NOT NULL,
	"canceled_at" timestamp with time zone,
	"chain_id" integer NOT NULL,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone
);
