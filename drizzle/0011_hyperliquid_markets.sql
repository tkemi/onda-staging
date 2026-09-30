CREATE TYPE "public"."hl_market_kind" AS ENUM('perp', 'spot');--> statement-breakpoint
CREATE TABLE "hyperliquid_markets" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" "hl_market_kind" NOT NULL,
	"base_coin" text NOT NULL,
	"hl_symbol" text NOT NULL,
	"sz_decimals" integer,
	"max_leverage" integer,
	"is_delisted" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "hyperliquid_markets_kind_symbol_key" ON "hyperliquid_markets" USING btree ("kind","hl_symbol");--> statement-breakpoint
CREATE INDEX "hyperliquid_markets_lookup_idx" ON "hyperliquid_markets" USING btree ("kind","base_coin");