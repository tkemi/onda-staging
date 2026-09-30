-- Replace the empty placeholder trading_analysis table with the canonical trade_setups.
-- drizzle runs the file in one transaction, so a failure changes nothing.

DROP TABLE "trading_analysis";--> statement-breakpoint

CREATE TYPE "public"."setup_source" AS ENUM('filter_mix', 'liquidity_hunt', 'signal_hub', 'futures_plan');--> statement-breakpoint
CREATE TYPE "public"."trade_direction" AS ENUM('long', 'short');--> statement-breakpoint
CREATE TYPE "public"."level_source" AS ENUM('partner', 'derived');--> statement-breakpoint
CREATE TYPE "public"."setup_status" AS ENUM('pending', 'armed', 'triggered', 'active', 'closed', 'invalidated', 'expired');--> statement-breakpoint

CREATE TABLE "trade_setups" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_type" "setup_source" NOT NULL,
	"stream_id" integer,
	"symbol" text NOT NULL,
	"base_coin" text NOT NULL,
	"market_kind" "hl_market_kind" NOT NULL,
	"hl_symbol" text NOT NULL,
	"hl_market_id" integer,
	"direction" "trade_direction" NOT NULL,
	"entry_low" numeric(40, 20) NOT NULL,
	"entry_high" numeric(40, 20) NOT NULL,
	"sl" numeric(40, 20),
	"tp1" numeric(40, 20),
	"tp1_source" "level_source",
	"tp2" numeric(40, 20),
	"tp2_source" "level_source",
	"tp3" numeric(40, 20),
	"tp3_source" "level_source",
	"risk_reward" numeric(20, 6),
	"data" jsonb NOT NULL,
	"status" "setup_status" DEFAULT 'pending' NOT NULL,
	"dedup_key" text NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "trade_setups_dedup_key" ON "trade_setups" USING btree ("source_type","dedup_key");--> statement-breakpoint
CREATE INDEX "trade_setups_status_idx" ON "trade_setups" USING btree ("status","base_coin");--> statement-breakpoint
CREATE INDEX "trade_setups_generated_idx" ON "trade_setups" USING btree ("generated_at");
