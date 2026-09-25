-- Rename the raw ingestion table to trading_analysis_stream (keeps existing data),
-- then create a fresh trading_analysis table for the processed output.
ALTER TABLE "trading_analysis" RENAME TO "trading_analysis_stream";--> statement-breakpoint
ALTER TABLE "trading_analysis_stream" RENAME CONSTRAINT "trading_analysis_pkey" TO "trading_analysis_stream_pkey";--> statement-breakpoint
ALTER INDEX "trading_analysis_partner_idx" RENAME TO "trading_analysis_stream_partner_idx";--> statement-breakpoint
ALTER INDEX "trading_analysis_unprocessed_idx" RENAME TO "trading_analysis_stream_unprocessed_idx";--> statement-breakpoint
CREATE TABLE "trading_analysis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner" text NOT NULL,
	"source_id" uuid,
	"symbol" text,
	"analysis" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "trading_analysis_partner_idx" ON "trading_analysis" USING btree ("partner");--> statement-breakpoint
CREATE INDEX "trading_analysis_symbol_idx" ON "trading_analysis" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX "trading_analysis_created_idx" ON "trading_analysis" USING btree ("created_at");
