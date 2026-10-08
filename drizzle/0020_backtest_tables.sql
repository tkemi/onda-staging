CREATE TABLE "backtest_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"setup_id" integer NOT NULL,
	"source_type" text NOT NULL,
	"mode" text NOT NULL,
	"direction" text NOT NULL,
	"entered" boolean NOT NULL,
	"entry_at" timestamp with time zone,
	"time_to_entry_min" numeric(20, 6),
	"sl_hit" boolean DEFAULT false NOT NULL,
	"tp1_hit" boolean DEFAULT false NOT NULL,
	"tp2_hit" boolean DEFAULT false NOT NULL,
	"tp3_hit" boolean DEFAULT false NOT NULL,
	"sl_at" timestamp with time zone,
	"tp1_at" timestamp with time zone,
	"tp2_at" timestamp with time zone,
	"tp3_at" timestamp with time zone,
	"max_tp" integer DEFAULT 0 NOT NULL,
	"mae_r" numeric(20, 6),
	"mfe_r" numeric(20, 6),
	"outcome" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"tp1_source" text,
	"tp2_source" text,
	"tp3_source" text,
	"policies" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backtest_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"params" jsonb NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "backtest_summary" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"source_type" text NOT NULL,
	"mode" text NOT NULL,
	"total" integer NOT NULL,
	"entered" integer NOT NULL,
	"invalidated" integer NOT NULL,
	"expired" integer NOT NULL,
	"no_entry" integer NOT NULL,
	"open_trades" integer NOT NULL,
	"entry_rate" numeric(20, 6),
	"avg_time_to_entry_min" numeric(20, 6),
	"cnt_sl" integer NOT NULL,
	"cnt_tp1" integer NOT NULL,
	"cnt_tp2" integer NOT NULL,
	"cnt_tp3" integer NOT NULL,
	"avg_tps_hit" numeric(20, 6),
	"partner_tp_hits" integer DEFAULT 0 NOT NULL,
	"derived_tp_hits" integer DEFAULT 0 NOT NULL,
	"max_concurrent" integer DEFAULT 0 NOT NULL,
	"avg_concurrent" numeric(20, 6),
	"implied_capital_usd" numeric(20, 6),
	"policies" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "backtest_results_run_idx" ON "backtest_results" USING btree ("run_id","source_type","mode");--> statement-breakpoint
CREATE UNIQUE INDEX "backtest_results_unique" ON "backtest_results" USING btree ("run_id","setup_id","mode");--> statement-breakpoint
CREATE UNIQUE INDEX "backtest_summary_unique" ON "backtest_summary" USING btree ("run_id","source_type","mode");