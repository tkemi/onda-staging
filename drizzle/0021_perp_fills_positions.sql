-- Hyperliquid perps: fill ledger, derived positions, live snapshots, resume cursor.
--
-- There is no contract to index. Perp matching happens inside HyperCore's state
-- transition, so a fill is not a transaction and emits no event - a HyperCore block
-- carries orders and cancels only, and a perp trader's evm nonce stays 0 for life. Fills
-- come from the per-user api, triggered by the PUBLIC trades firehose: one subscription
-- per market (~178) rather than per user, because every public trade carries both
-- counterparties.
--
-- `fills` is the only source of truth. `positions` and the activity rows are replayed from
-- it, so both can be dropped and rebuilt without refetching anything.
--
-- Activity types: open-position, close-position, liquidate-position (a forced close is its
-- own type, not a reason code) and open-limit-order (the only type with a lifecycle, which
-- is what activities.status is for).
--
-- EVERY statement is guarded. These objects were created on the shared database before
-- this file existed - under earlier numbering that collided with 0020_backtest_tables -
-- so an unguarded re-run would fail the release-phase migrate. Guarded, this file is a
-- no-op there and the full creation on a fresh clone.
-- postgres has no CREATE TYPE IF NOT EXISTS, so the re-run guard is a DO block
DO $$ BEGIN
	CREATE TYPE "public"."position_close_reason" AS ENUM('closed', 'liquidation', 'backstop', 'flip');
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
ALTER TYPE "public"."activity_type" ADD VALUE IF NOT EXISTS 'open-position';--> statement-breakpoint
ALTER TYPE "public"."activity_type" ADD VALUE IF NOT EXISTS 'close-position';--> statement-breakpoint
ALTER TYPE "public"."activity_type" ADD VALUE IF NOT EXISTS 'liquidate-position';--> statement-breakpoint
ALTER TYPE "public"."activity_type" ADD VALUE IF NOT EXISTS 'open-limit-order';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fills" (
	"id" serial PRIMARY KEY NOT NULL,
	"privy_address" text NOT NULL,
	"tid" numeric(78, 0) NOT NULL,
	"coin" text NOT NULL,
	"dir" text NOT NULL,
	"side" text NOT NULL,
	"px" numeric(38, 10) NOT NULL,
	"sz" numeric(38, 10) NOT NULL,
	"start_position" numeric(38, 10) NOT NULL,
	"closed_pnl" numeric(38, 10) NOT NULL,
	"fee" numeric(38, 10) NOT NULL,
	"builder_fee" numeric(38, 10),
	"fee_token" text NOT NULL,
	"oid" numeric(78, 0),
	"liquidation_method" text,
	"twap_id" numeric(78, 0),
	"tx_hash" text,
	"filled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hl_accounts" (
	"privy_address" text PRIMARY KEY NOT NULL,
	"account_value" numeric(38, 10) NOT NULL,
	"total_ntl_pos" numeric(38, 10) NOT NULL,
	"total_raw_usd" numeric(38, 10) NOT NULL,
	"total_margin_used" numeric(38, 10) NOT NULL,
	"withdrawable" numeric(38, 10) NOT NULL,
	"positions_digest" text DEFAULT '' NOT NULL,
	"snapshot_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hl_cursors" (
	"privy_address" text PRIMARY KEY NOT NULL,
	"last_fill_time" numeric(78, 0) DEFAULT '0' NOT NULL,
	"is_backfilled" boolean DEFAULT false NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "position_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"privy_address" text NOT NULL,
	"coin" text NOT NULL,
	"szi" numeric(38, 10) NOT NULL,
	"direction" text NOT NULL,
	"size" numeric(38, 10) NOT NULL,
	"entry_px" numeric(38, 10) NOT NULL,
	"position_value" numeric(38, 10) NOT NULL,
	"unrealized_pnl" numeric(38, 10) NOT NULL,
	"liquidation_px" numeric(38, 10),
	"margin_used" numeric(38, 10) NOT NULL,
	"leverage_type" text NOT NULL,
	"leverage_value" integer NOT NULL,
	"max_leverage" integer NOT NULL,
	"cum_funding_all_time" numeric(38, 10) NOT NULL,
	"cum_funding_since_open" numeric(38, 10) NOT NULL,
	"cum_funding_since_change" numeric(38, 10) NOT NULL,
	"snapshot_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "positions" (
	"id" serial PRIMARY KEY NOT NULL,
	"privy_address" text NOT NULL,
	"coin" text NOT NULL,
	"direction" text NOT NULL,
	"open_tid" numeric(78, 0) NOT NULL,
	"close_tid" numeric(78, 0),
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"close_reason" "position_close_reason",
	"entry_px" numeric(38, 10) NOT NULL,
	"exit_px" numeric(38, 10),
	"max_size" numeric(38, 10) NOT NULL,
	"open_size" numeric(38, 10) NOT NULL,
	"gross_pnl" numeric(38, 10) DEFAULT '0' NOT NULL,
	"fees" numeric(38, 10) DEFAULT '0' NOT NULL,
	"realized_pnl" numeric(38, 10) DEFAULT '0' NOT NULL,
	"leverage_value" integer,
	"leverage_type" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fills_address_tid_key" ON "fills" USING btree ("privy_address","tid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fills_replay_idx" ON "fills" USING btree ("privy_address","coin","filled_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fills_user_time_idx" ON "fills" USING btree ("privy_address","filled_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "position_snapshots_address_coin_key" ON "position_snapshots" USING btree ("privy_address","coin");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "position_snapshots_user_idx" ON "position_snapshots" USING btree ("privy_address");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "positions_open_tid_key" ON "positions" USING btree ("privy_address","coin","open_tid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "positions_user_idx" ON "positions" USING btree ("privy_address","opened_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "positions_still_open_idx" ON "positions" USING btree ("closed_at","privy_address");

-- --------------------------------------------------------------------------------------
-- Reconciliation for the shared database only.
--
-- A `CREATE TABLE IF NOT EXISTS` is a no-op where the table already exists, which means it
-- cannot bring an EXISTING table up to the shape above. hl_cursors was created earlier
-- with a per-user polling schedule, for a backfill cron that has since been removed; the
-- table is now just a resume point. These statements converge it either way - on a fresh
-- clone the table was created correctly a moment ago and all four are no-ops.
-- --------------------------------------------------------------------------------------

ALTER TABLE "hl_cursors" ADD COLUMN IF NOT EXISTS "last_synced_at" timestamp with time zone;--> statement-breakpoint
DROP INDEX IF EXISTS "hl_cursors_due_idx";--> statement-breakpoint
ALTER TABLE "hl_cursors" DROP COLUMN IF EXISTS "next_poll_at";--> statement-breakpoint
ALTER TABLE "hl_cursors" DROP COLUMN IF EXISTS "interval_seconds";--> statement-breakpoint
ALTER TABLE "hl_cursors" DROP COLUMN IF EXISTS "consecutive_empty";--> statement-breakpoint
ALTER TABLE "hl_cursors" DROP COLUMN IF EXISTS "last_polled_at";
