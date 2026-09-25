CREATE TABLE "trading_analysis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner" text NOT NULL,
	"payload" jsonb,
	"raw" text NOT NULL,
	"is_processed" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "trading_analysis_partner_idx" ON "trading_analysis" USING btree ("partner");--> statement-breakpoint
CREATE INDEX "trading_analysis_unprocessed_idx" ON "trading_analysis" USING btree ("is_processed","received_at");