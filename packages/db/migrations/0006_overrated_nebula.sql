CREATE TABLE "analytics_daily" (
	"merchant_id" uuid NOT NULL,
	"date" date NOT NULL,
	"mrr_usd" numeric(20, 6) NOT NULL,
	"arr_usd" numeric(20, 6) NOT NULL,
	"active_subs" integer NOT NULL,
	"trialing_subs" integer NOT NULL,
	"past_due_subs" integer NOT NULL,
	"new_subs" integer NOT NULL,
	"canceled_subs" integer NOT NULL,
	"gross_volume_usd" numeric(20, 6) NOT NULL,
	"fee_revenue_usd" numeric(20, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analytics_daily_merchant_id_date_pk" PRIMARY KEY("merchant_id","date")
);
--> statement-breakpoint
ALTER TABLE "analytics_daily" ADD CONSTRAINT "analytics_daily_merchant_id_merchant_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchant"("id") ON DELETE no action ON UPDATE no action;