CREATE TABLE "dunning_state" (
	"onchain_sub_id" numeric(78, 0) PRIMARY KEY NOT NULL,
	"attempt" smallint DEFAULT 1 NOT NULL,
	"next_retry_at" timestamp with time zone NOT NULL,
	"exhausted" boolean DEFAULT false NOT NULL,
	"ladder" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
