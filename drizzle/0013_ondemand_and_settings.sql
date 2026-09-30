CREATE TYPE "public"."breakeven_trigger" AS ENUM('off', 'after_tp1', 'at_1r');--> statement-breakpoint
CREATE TYPE "public"."entry_style" AS ENUM('exact', 'zone', 'dca');--> statement-breakpoint
CREATE TYPE "public"."exit_style" AS ENUM('conservative', 'balanced', 'aggressive');--> statement-breakpoint
CREATE TABLE "accumulation_plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"base_coin" text NOT NULL,
	"hl_symbol" text NOT NULL,
	"hl_market_id" integer,
	"current_price" numeric(40, 20),
	"buy_zones" jsonb NOT NULL,
	"sell_zones" jsonb NOT NULL,
	"summary" jsonb NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_trade_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"exit_style" "exit_style" DEFAULT 'balanced' NOT NULL,
	"entry_style" "entry_style" DEFAULT 'zone' NOT NULL,
	"move_to_breakeven" "breakeven_trigger" DEFAULT 'after_tp1' NOT NULL,
	"trailing_enabled" boolean DEFAULT true NOT NULL,
	"trailing_pct" numeric(10, 4),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "accumulation_plans_base_coin_key" ON "accumulation_plans" USING btree ("base_coin");