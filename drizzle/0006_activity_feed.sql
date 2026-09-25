-- The activity feed: one row per user-visible event, with everything the frontend
-- renders in the `data` jsonb column.
--
-- No backfill here. Existing deposits need token symbol and decimals, which an ERC-20
-- Transfer log never carried, so they have to be read from each token contract - not
-- something SQL can do. That runs as a one-off script instead.
CREATE TYPE "public"."activity_type" AS ENUM('deposit');--> statement-breakpoint
CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"privy_address" text NOT NULL,
	"type" "activity_type" NOT NULL,
	"status" "tx_status" DEFAULT 'pending' NOT NULL,
	"source_key" text NOT NULL,
	"data" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "activities_feed_idx" ON "activities" USING btree ("privy_address","occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "activities_source_key" ON "activities" USING btree ("type","source_key");
