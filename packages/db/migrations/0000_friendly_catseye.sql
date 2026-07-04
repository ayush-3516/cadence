CREATE TYPE "public"."api_key_type" AS ENUM('publishable', 'secret');--> statement-breakpoint
CREATE TABLE "api_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"type" "api_key_type" NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"livemode" boolean NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_key_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "merchant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"owner_address" text NOT NULL,
	"livemode" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_owner_address_livemode_unique" UNIQUE("owner_address","livemode")
);
--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_merchant_id_merchant_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_key_merchant_id_idx" ON "api_key" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "api_key_key_hash_idx" ON "api_key" USING btree ("key_hash");