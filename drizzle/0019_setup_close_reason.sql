ALTER TABLE "trade_setups" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trade_setups" ADD COLUMN "close_reason" text;