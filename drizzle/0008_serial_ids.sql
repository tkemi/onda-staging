-- Convert every uuid primary key to a serial (int4 auto-increment), preserving all
-- existing rows. Each table gets a fresh sequential id ordered by its own time column;
-- the two soft references (activities.source_key -> deposits.id and
-- trading_analysis.source_id -> trading_analysis_stream.id) are re-pointed to the new
-- ids BEFORE the old uuid columns are dropped. drizzle runs this whole file in one
-- transaction, so a failure leaves the database untouched.

-- 1. Stage new integer ids on the two tables that are referenced elsewhere ----------
ALTER TABLE "deposits" ADD COLUMN "new_id" integer;--> statement-breakpoint
WITH ordered AS (SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn FROM "deposits")
UPDATE "deposits" SET "new_id" = ordered.rn FROM ordered WHERE "deposits".id = ordered.id;--> statement-breakpoint

ALTER TABLE "trading_analysis_stream" ADD COLUMN "new_id" integer;--> statement-breakpoint
WITH ordered AS (SELECT id, row_number() OVER (ORDER BY received_at, id) AS rn FROM "trading_analysis_stream")
UPDATE "trading_analysis_stream" SET "new_id" = ordered.rn FROM ordered WHERE "trading_analysis_stream".id = ordered.id;--> statement-breakpoint

-- 2. Re-point the soft references to the staged ids (old uuids still present) --------
UPDATE "activities" a SET "source_key" = d."new_id"::text
FROM "deposits" d
WHERE a."type" = 'deposit-on-chain' AND a."source_key" = d."id"::text;--> statement-breakpoint

ALTER TABLE "trading_analysis" ADD COLUMN "new_source_id" integer;--> statement-breakpoint
UPDATE "trading_analysis" ta SET "new_source_id" = s."new_id"
FROM "trading_analysis_stream" s WHERE ta."source_id" = s."id";--> statement-breakpoint

-- 3. Finalize deposits --------------------------------------------------------------
ALTER TABLE "deposits" DROP CONSTRAINT "deposits_pkey";--> statement-breakpoint
ALTER TABLE "deposits" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "deposits" RENAME COLUMN "new_id" TO "id";--> statement-breakpoint
ALTER TABLE "deposits" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
CREATE SEQUENCE "deposits_id_seq" OWNED BY "deposits"."id";--> statement-breakpoint
SELECT setval('deposits_id_seq', (SELECT COALESCE(max("id"), 0) FROM "deposits") + 1, false);--> statement-breakpoint
ALTER TABLE "deposits" ALTER COLUMN "id" SET DEFAULT nextval('deposits_id_seq');--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_pkey" PRIMARY KEY ("id");--> statement-breakpoint

-- 4. Finalize trading_analysis_stream -----------------------------------------------
ALTER TABLE "trading_analysis_stream" DROP CONSTRAINT "trading_analysis_stream_pkey";--> statement-breakpoint
ALTER TABLE "trading_analysis_stream" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "trading_analysis_stream" RENAME COLUMN "new_id" TO "id";--> statement-breakpoint
ALTER TABLE "trading_analysis_stream" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
CREATE SEQUENCE "trading_analysis_stream_id_seq" OWNED BY "trading_analysis_stream"."id";--> statement-breakpoint
SELECT setval('trading_analysis_stream_id_seq', (SELECT COALESCE(max("id"), 0) FROM "trading_analysis_stream") + 1, false);--> statement-breakpoint
ALTER TABLE "trading_analysis_stream" ALTER COLUMN "id" SET DEFAULT nextval('trading_analysis_stream_id_seq');--> statement-breakpoint
ALTER TABLE "trading_analysis_stream" ADD CONSTRAINT "trading_analysis_stream_pkey" PRIMARY KEY ("id");--> statement-breakpoint

-- 5. Finalize sweeps ----------------------------------------------------------------
ALTER TABLE "sweeps" ADD COLUMN "new_id" integer;--> statement-breakpoint
WITH ordered AS (SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn FROM "sweeps")
UPDATE "sweeps" SET "new_id" = ordered.rn FROM ordered WHERE "sweeps".id = ordered.id;--> statement-breakpoint
ALTER TABLE "sweeps" DROP CONSTRAINT "sweeps_pkey";--> statement-breakpoint
ALTER TABLE "sweeps" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "sweeps" RENAME COLUMN "new_id" TO "id";--> statement-breakpoint
ALTER TABLE "sweeps" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
CREATE SEQUENCE "sweeps_id_seq" OWNED BY "sweeps"."id";--> statement-breakpoint
SELECT setval('sweeps_id_seq', (SELECT COALESCE(max("id"), 0) FROM "sweeps") + 1, false);--> statement-breakpoint
ALTER TABLE "sweeps" ALTER COLUMN "id" SET DEFAULT nextval('sweeps_id_seq');--> statement-breakpoint
ALTER TABLE "sweeps" ADD CONSTRAINT "sweeps_pkey" PRIMARY KEY ("id");--> statement-breakpoint

-- 6. Finalize activities (feed index includes id, so drop and rebuild it) ------------
ALTER TABLE "activities" ADD COLUMN "new_id" integer;--> statement-breakpoint
WITH ordered AS (SELECT id, row_number() OVER (ORDER BY occurred_at, created_at, id) AS rn FROM "activities")
UPDATE "activities" SET "new_id" = ordered.rn FROM ordered WHERE "activities".id = ordered.id;--> statement-breakpoint
DROP INDEX "activities_feed_idx";--> statement-breakpoint
ALTER TABLE "activities" DROP CONSTRAINT "activities_pkey";--> statement-breakpoint
ALTER TABLE "activities" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "activities" RENAME COLUMN "new_id" TO "id";--> statement-breakpoint
ALTER TABLE "activities" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
CREATE SEQUENCE "activities_id_seq" OWNED BY "activities"."id";--> statement-breakpoint
SELECT setval('activities_id_seq', (SELECT COALESCE(max("id"), 0) FROM "activities") + 1, false);--> statement-breakpoint
ALTER TABLE "activities" ALTER COLUMN "id" SET DEFAULT nextval('activities_id_seq');--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_pkey" PRIMARY KEY ("id");--> statement-breakpoint
CREATE INDEX "activities_feed_idx" ON "activities" USING btree ("privy_address","occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint

-- 7. Finalize trading_analysis (own id, plus swap in the re-pointed source_id) -------
ALTER TABLE "trading_analysis" ADD COLUMN "new_id" integer;--> statement-breakpoint
WITH ordered AS (SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn FROM "trading_analysis")
UPDATE "trading_analysis" SET "new_id" = ordered.rn FROM ordered WHERE "trading_analysis".id = ordered.id;--> statement-breakpoint
ALTER TABLE "trading_analysis" DROP CONSTRAINT "trading_analysis_pkey";--> statement-breakpoint
ALTER TABLE "trading_analysis" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "trading_analysis" RENAME COLUMN "new_id" TO "id";--> statement-breakpoint
ALTER TABLE "trading_analysis" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
CREATE SEQUENCE "trading_analysis_id_seq" OWNED BY "trading_analysis"."id";--> statement-breakpoint
SELECT setval('trading_analysis_id_seq', (SELECT COALESCE(max("id"), 0) FROM "trading_analysis") + 1, false);--> statement-breakpoint
ALTER TABLE "trading_analysis" ALTER COLUMN "id" SET DEFAULT nextval('trading_analysis_id_seq');--> statement-breakpoint
ALTER TABLE "trading_analysis" ADD CONSTRAINT "trading_analysis_pkey" PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "trading_analysis" DROP COLUMN "source_id";--> statement-breakpoint
ALTER TABLE "trading_analysis" RENAME COLUMN "new_source_id" TO "source_id";
