CREATE TABLE "invoice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"pdf_url" text,
	"tx_hash" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"platform_fee" numeric(78, 0) NOT NULL,
	"net" numeric(78, 0) NOT NULL,
	"onchain_sub_id" numeric(78, 0) NOT NULL,
	"onchain_plan_id" numeric(78, 0) NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_merchant_id_number_unique" UNIQUE("merchant_id","number")
);
--> statement-breakpoint
ALTER TABLE "merchant" ADD COLUMN "invoice_sequence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_merchant_id_merchant_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_merchant_id_created_at_idx" ON "invoice" USING btree ("merchant_id","created_at");--> statement-breakpoint
CREATE INDEX "invoice_onchain_sub_id_idx" ON "invoice" USING btree ("onchain_sub_id");