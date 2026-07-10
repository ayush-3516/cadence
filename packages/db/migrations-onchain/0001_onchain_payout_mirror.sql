CREATE TABLE "onchain_payout" (
	"id" text PRIMARY KEY NOT NULL,
	"split_address" text NOT NULL,
	"recipient" text NOT NULL,
	"token" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"usd_value" numeric(20, 6),
	"tx_hash" text,
	"block_number" bigint,
	"chain_id" integer,
	"distributed_at" timestamp with time zone NOT NULL
);
