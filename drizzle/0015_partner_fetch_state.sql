CREATE TABLE "partner_fetch_state" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" "hl_market_kind" NOT NULL,
	"base_coin" text NOT NULL,
	"symbol" text NOT NULL,
	"supported" boolean DEFAULT true NOT NULL,
	"last_fetch_at" timestamp with time zone,
	"last_status" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "partner_fetch_state_key" ON "partner_fetch_state" USING btree ("kind","base_coin");--> statement-breakpoint
CREATE INDEX "partner_fetch_state_due_idx" ON "partner_fetch_state" USING btree ("kind","supported","last_fetch_at");