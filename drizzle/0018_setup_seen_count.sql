ALTER TABLE "trade_setups" ADD COLUMN "seen_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "trade_setups" ADD COLUMN "last_seen_at" timestamp with time zone;