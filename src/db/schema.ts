import {
    boolean,
    index,
    integer,
    jsonb,
    numeric,
    pgEnum,
    pgTable,
    serial,
    text,
    timestamp,
    uniqueIndex
} from "drizzle-orm/pg-core";

export const tx_status = pgEnum("tx_status", ["pending", "failed", "confirmed"]);

export const users = pgTable("users", {
    id: text("id").primaryKey(),
    privy_wallet_id: text("privy_wallet_id").notNull().unique(),
    privy_address: text("privy_address").notNull().unique(),
    created_at: timestamp("created_at", {withTimezone: true}).notNull().defaultNow(),
});

export type user = typeof users.$inferSelect;
export type new_user = typeof users.$inferInsert;

export const deposits = pgTable(
    "deposits",
    {
        id: serial("id").primaryKey(),
        privy_wallet_id: text("privy_wallet_id").notNull(),
        privy_address: text("privy_address").notNull(),
        asset: text("asset").notNull(),
        chain_caip2: text("chain_caip2").notNull(),
        amount: numeric("amount", {precision: 78, scale: 0}).notNull(),
        tx_hash: text("tx_hash").notNull(),
        sender: text("sender"),
        block_number: numeric("block_number", {precision: 78, scale: 0}),
        idempotency_key: text("idempotency_key").notNull(),
        status: tx_status("status").notNull().default("pending"),
        is_sent: boolean("is_sent").notNull().default(false),
        attempts: integer("attempts").notNull().default(0),
        created_at: timestamp("created_at", {withTimezone: true}).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("deposits_idempotency_key_key").on(table.idempotency_key),
        index("deposits_tx_hash_idx").on(table.tx_hash),
        index("deposits_sweepable_idx").on(table.is_sent, table.privy_wallet_id),
    ]
);

export type deposit = typeof deposits.$inferSelect;
export type new_deposit = typeof deposits.$inferInsert;

export const sweeps = pgTable(
    "sweeps",
    {
        id: serial("id").primaryKey(),
        privy_wallet_id: text("privy_wallet_id").notNull(),
        // the wallet's LOWERCASE address. Denormalised from users alongside
        // privy_wallet_id, the same way deposits carries both, so a sweep can be
        // looked up by address without a join
        privy_address: text("privy_address").notNull(),
        asset: text("asset").notNull(),
        chain_caip2: text("chain_caip2").notNull(),
        amount: numeric("amount", {precision: 78, scale: 0}).notNull(),
        privy_transaction_id: text("privy_transaction_id"),
        tx_hash: text("tx_hash"),
        status: tx_status("status").notNull().default("pending"),
        error: text("error"),
        created_at: timestamp("created_at", {withTimezone: true}).notNull().defaultNow(),
    },
    (table) => [
        index("sweeps_tx_hash_idx").on(table.tx_hash),
        index("sweeps_wallet_idx").on(table.privy_wallet_id),
    ]
);

export type sweep = typeof sweeps.$inferSelect;
export type new_sweep = typeof sweeps.$inferInsert;

// Raw, append-only capture of everything partners stream over the trading-analysis-stream
// websocket. We store deliveries untouched so no data is lost before we know the shape;
// the process_trading_analysis cron reads from here. See src/ws/trading_analysis_stream.ts.
export const trading_analysis_stream = pgTable(
    "trading_analysis_stream",
    {
        id: serial("id").primaryKey(),
        // which partner sent this, derived from the token used to connect
        partner: text("partner").notNull(),
        // the parsed message when it was valid JSON, otherwise null
        payload: jsonb("payload"),
        // the exact bytes we received, always kept as a fallback / audit trail
        raw: text("raw").notNull(),
        // false until the process_trading_analysis cron has handled it (for backfills)
        is_processed: boolean("is_processed").notNull().default(false),
        received_at: timestamp("received_at", {withTimezone: true}).notNull().defaultNow(),
    },
    (table) => [
        index("trading_analysis_stream_partner_idx").on(table.partner),
        index("trading_analysis_stream_unprocessed_idx").on(table.is_processed, table.received_at),
    ]
);

export type trading_analysis_stream_message = typeof trading_analysis_stream.$inferSelect;
export type new_trading_analysis_stream_message = typeof trading_analysis_stream.$inferInsert;

// The canonical, user-agnostic trade setup: the processed output the whole pipeline is
// built around. The process_trading_analysis cron turns each raw partner delivery into
// one of these (filtered to Hyperliquid-tradable markets), completing a full TP ladder
// and tagging every level partner/derived. Per-user policy (which TPs to take, runner,
// move-to-breakeven, entry style) is applied on top of this at presentation/execution
// time - it never touches this row, which is the single "truth" of the setup.

// perp or spot, shared by trade_setups and the hyperliquid_markets table below
export const hl_market_kind = pgEnum("hl_market_kind", ["perp", "spot"]);

// which partner signal family this setup came from
export const setup_source = pgEnum("setup_source", [
    "filter_mix",
    "liquidity_hunt",
    "signal_hub",
    "futures_plan",
]);

export const trade_direction = pgEnum("trade_direction", ["long", "short"]);

// where a price level came from: sent by the partner, or derived by us (R-multiples)
export const level_source = pgEnum("level_source", ["partner", "derived"]);

export const setup_status = pgEnum("setup_status", [
    "pending",      // created, waiting for price to approach entry
    "armed",        // price is near the entry zone
    "triggered",    // price hit entry - user notified to enter (execution is UI-side)
    "active",       // reserved (position tracking is not done backend-side)
    "closed",       // reserved
    "invalidated",  // SL hit, or invalidated before entry was ever reached
    "expired",      // went stale unfilled
    "superseded",   // a newer signal with a similar entry replaced this one
]);

// prices span BTC (~80k) down to sub-cent memecoins (0.00000829), so we keep generous
// precision and many decimals rather than a display-oriented scale.
const price = (name: string) => numeric(name, {precision: 40, scale: 20});

export const trade_setups = pgTable(
    "trade_setups",
    {
        id: serial("id").primaryKey(),
        source_type: setup_source("source_type").notNull(),
        // the raw trading_analysis_stream row this came from (null for on-demand sources)
        stream_id: integer("stream_id"),

        // --- market (normalised to Hyperliquid) ---
        // the partner's original symbol, e.g. BNBUSDT
        symbol: text("symbol").notNull(),
        // normalised base coin, e.g. BNB
        base_coin: text("base_coin").notNull(),
        market_kind: hl_market_kind("market_kind").notNull(),
        // what Hyperliquid calls the market, e.g. BNB or kPEPE or "PURR/USDC"
        hl_symbol: text("hl_symbol").notNull(),
        hl_market_id: integer("hl_market_id"),

        // --- the setup ---
        direction: trade_direction("direction").notNull(),
        // entry as a zone; single-price signals set low == high
        entry_low: price("entry_low").notNull(),
        entry_high: price("entry_high").notNull(),
        sl: price("sl"),
        tp1: price("tp1"),
        tp1_source: level_source("tp1_source"),
        tp2: price("tp2"),
        tp2_source: level_source("tp2_source"),
        tp3: price("tp3"),
        tp3_source: level_source("tp3_source"),
        // risk:reward to TP1, when computable
        risk_reward: numeric("risk_reward", {precision: 20, scale: 6}),

        // everything type-specific: confidence, score, liquidationSide, EMAs, signalType,
        // confluence factors, timeframe, ... - shaped per source_type
        data: jsonb("data").notNull(),

        status: setup_status("status").notNull().default("pending"),
        // collapses byte-identical re-sends of the same setup (partner resends heavily);
        // distinct entries stay distinct
        dedup_key: text("dedup_key").notNull(),
        generated_at: timestamp("generated_at", {withTimezone: true}).notNull(),
        expires_at: timestamp("expires_at", {withTimezone: true}),
        // when price first reached the entry zone - the key field for backtesting
        // (time-to-entry, and whether TPs/SL were hit afterwards)
        triggered_at: timestamp("triggered_at", {withTimezone: true}),
        // when the setup became terminal (invalidated / expired) and why - for backtesting
        // "how many invalidated, and for what reason". close_reason is a short code, e.g.
        // 'stop_before_entry' or 'expired'.
        closed_at: timestamp("closed_at", {withTimezone: true}),
        close_reason: text("close_reason"),
        // when this setup was announced to the setups channel; also used to suppress
        // telegram spam for near-identical repeats
        notified_at: timestamp("notified_at", {withTimezone: true}),
        // how many times the partner has generated this same zone (futures plans). A higher
        // count = a stronger, repeatedly-confirmed entry zone. Starts at 1.
        seen_count: integer("seen_count").notNull().default(1),
        // the most recent time this zone was seen again (extends its validity window)
        last_seen_at: timestamp("last_seen_at", {withTimezone: true}),
        created_at: timestamp("created_at", {withTimezone: true}).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("trade_setups_dedup_key").on(table.source_type, table.dedup_key),
        // the monitor scans open setups; the feed lists by recency
        index("trade_setups_status_idx").on(table.status, table.base_coin),
        index("trade_setups_generated_idx").on(table.generated_at),
    ]
);

export type trade_setup = typeof trade_setups.$inferSelect;
export type new_trade_setup = typeof trade_setups.$inferInsert;

// Spot / swing accumulation plans (the on-demand spot-zones API). A different primitive
// from trade_setups: not one entry+SL+TP, but a laddered buy/sell plan with allocation
// percentages, for patient accumulation. One current plan per coin, refreshed daily.
export const accumulation_plans = pgTable(
    "accumulation_plans",
    {
        id: serial("id").primaryKey(),
        symbol: text("symbol").notNull(),
        base_coin: text("base_coin").notNull(),
        hl_symbol: text("hl_symbol").notNull(),
        hl_market_id: integer("hl_market_id"),
        current_price: price("current_price"),
        // arrays of {percent, price, allocationPct}
        buy_zones: jsonb("buy_zones").notNull(),
        sell_zones: jsonb("sell_zones").notNull(),
        // {deployedPct, reservePct, profitTargetPct, runnerPct}
        summary: jsonb("summary").notNull(),
        generated_at: timestamp("generated_at", {withTimezone: true}).notNull(),
        expires_at: timestamp("expires_at", {withTimezone: true}),
        // last time this plan was posted to the spot channel; zones shift every refresh, so
        // we throttle to at most one message per coin per day
        notified_at: timestamp("notified_at", {withTimezone: true}),
        created_at: timestamp("created_at", {withTimezone: true}).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("accumulation_plans_base_coin_key").on(table.base_coin),
    ]
);

export type accumulation_plan = typeof accumulation_plans.$inferSelect;
export type new_accumulation_plan = typeof accumulation_plans.$inferInsert;

// Per-market state for the on-demand pull. The partner covers only a subset of the coins
// HL lists (it returns 400 for the rest) and rate-limits us (429), so we:
//   - flag unsupported coins (supported=false) and never query them again,
//   - record last_fetch_at so each run only fetches coins stale beyond the freshness window
//     and resumes where the previous run stopped.
// Kept in its own table so the daily hyperliquid_markets full-refresh can't wipe it.
export const partner_fetch_state = pgTable(
    "partner_fetch_state",
    {
        id: serial("id").primaryKey(),
        // perp = futures plan, spot = spot zones
        kind: hl_market_kind("kind").notNull(),
        base_coin: text("base_coin").notNull(),
        // the partner symbol we query, e.g. BNBUSDT
        symbol: text("symbol").notNull(),
        // false once the partner has told us (400) it does not cover this coin
        supported: boolean("supported").notNull().default(true),
        // last SUCCESSFUL fetch; null = never fetched
        last_fetch_at: timestamp("last_fetch_at", {withTimezone: true}),
        // last HTTP status seen, for debugging (400 unsupported, 429 rate-limited, ...)
        last_status: integer("last_status"),
        updated_at: timestamp("updated_at", {withTimezone: true}).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("partner_fetch_state_key").on(table.kind, table.base_coin),
        index("partner_fetch_state_due_idx").on(table.kind, table.supported, table.last_fetch_at),
    ]
);

export type partner_fetch_row = typeof partner_fetch_state.$inferSelect;
export type new_partner_fetch_row = typeof partner_fetch_state.$inferInsert;

// ---------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------
//
// One table for every kind of user-visible event. The feed will span wildly
// different things - an on-chain deposit, a card purchase, a perp fill, a
// liquidation - that share almost no fields, so only what the feed itself needs
// to sort, page and update is a real column. Everything specific to the event
// kind goes in `data`, shaped per type by activity_data_by_type below.
//
// Adding a type is: one enum value, one entry in activity_data_by_type, one
// formatter. No migration.
//
// `privy_address` holds a LOWERCASE 0x address. There is no foreign key to
// `users`, matching deposits/sweeps: the ingest paths must not depend on a
// user lookup succeeding.

export const activity_type = pgEnum("activity_type", ["deposit-on-chain", "withdraw-on-chain"]);

// What lives in `data`, per activity type.
//
// These are stored under the exact names the frontend reads, so serving the feed is a
// spread of `data` with no mapping layer in between. Operational fields
// stay in the table that owns them - a deposit's chain_caip2, block_number, attempts
// and idempotency_key live in `deposits`, which is still the source of truth for the
// webhook and the sweeper. The feed is a view for the UI, not a second ledger.
//
// Amounts are ALWAYS strings. JSON numbers are IEEE-754 doubles, so an 18-decimal
// token amount would silently lose precision the moment it round-trips through
// jsonb - "5000000" is the exact digits, in the token's smallest unit, and the
// client divides by token_decimals to display it. Hence the _wei suffix: it is a
// reminder at every call site that this is never a display value.
//
// The token fields are snapshotted per row, not looked up on read. token_address is
// whatever the Transfer log was emitted by, so a new token needs no code change. An
// ERC-20 Transfer log does not carry symbol or decimals, so those are read from the
// contract once per token when the deposit is recorded - see the webhook controller.
export interface deposit_activity_data {
    amount_wei: string;
    token_address: string;
    token_symbol: string;
    token_decimals: number;
    // null on a reconciliation row: USDC that was swept but had no deposit of its own,
    // so there is no single transfer to name
    tx_hash: string | null;
    sender: string | null;
}

// Money leaving hyperliquid back to an address the user chose. Written by the indexer
// webhook from Bridge2's FinalizedWithdrawal, whose indexed `user` is the privy address
// and whose `usd` is already in the token's base units.
export interface withdraw_activity_data {
    amount_wei: string;
    token_address: string;
    token_symbol: string;
    token_decimals: number;
    // optional in the frontend contract, so absent and null both have to be tolerated.
    // FinalizedWithdrawal always carries one, so a row written from the indexer has it.
    tx_hash?: string | null;
    // where the money went, which is not one of our wallets
    destination: string;
}

// Keyed by the enum so the two cannot drift: a new activity_type has no valid
// `data` shape until it is added here.
export interface activity_data_by_type {
    "deposit-on-chain": deposit_activity_data;
    "withdraw-on-chain": withdraw_activity_data;
}

export type activity_data = activity_data_by_type[keyof activity_data_by_type];

export const activities = pgTable(
    "activities",
    {
        id: serial("id").primaryKey(),
        privy_address: text("privy_address").notNull(),
        type: activity_type("type").notNull(),
        // status stays a real column, not a `data` field: it is the one thing that
        // changes after insert, and updating it should not mean rewriting the blob
        status: tx_status("status").notNull().default("pending"),
        // the source event's own id - deposits.id for a deposit. Unique per type, so
        // replaying a webhook or a backfill cannot create a second feed row, and the
        // writer can find this row later to move `status` along.
        source_key: text("source_key").notNull(),
        // everything specific to this event kind
        data: jsonb("data").$type<activity_data>().notNull(),
        // when the event HAPPENED, not when we recorded it. A card settlement or a
        // fill predates our insert, and the feed must be ordered by event time.
        occurred_at: timestamp("occurred_at", {withTimezone: true}).notNull(),
        created_at: timestamp("created_at", {withTimezone: true}).notNull().defaultNow(),
    },
    (table) => [
        // the one index the feed reads: a user's page, newest first. `id` is the
        // tiebreaker so a keyset cursor stays stable when timestamps collide.
        index("activities_feed_idx").on(table.privy_address, table.occurred_at.desc(), table.id.desc()),
        uniqueIndex("activities_source_key").on(table.type, table.source_key),
    ]
);

export type activity = typeof activities.$inferSelect;
export type new_activity = typeof activities.$inferInsert;

// ---------------------------------------------------------------------------
// Hyperliquid markets
// ---------------------------------------------------------------------------
//
// Every market tradable on Hyperliquid, refreshed daily by the sync_hl_markets cron
// from the venue's own meta/spotMeta endpoints. Partner signals quote in USDT (e.g.
// BNBUSDT) but Hyperliquid trades everything against USDC, so signal processing
// normalises a symbol to its base coin and looks it up here to decide whether the
// signal is tradable at all - an untradeable coin never becomes a trade setup.

export const hyperliquid_markets = pgTable(
    "hyperliquid_markets",
    {
        id: serial("id").primaryKey(),
        kind: hl_market_kind("kind").notNull(),
        // the base coin as Hyperliquid names it: BTC, ETH, kPEPE, ... (the perp universe
        // name, or the base token of a spot pair)
        base_coin: text("base_coin").notNull(),
        // what the venue calls the market: the coin for a perp, the pair for spot ("PURR/USDC")
        hl_symbol: text("hl_symbol").notNull(),
        // order-size decimals, needed later to size executable orders
        sz_decimals: integer("sz_decimals"),
        // perps only
        max_leverage: integer("max_leverage"),
        is_delisted: boolean("is_delisted").notNull().default(false),
        updated_at: timestamp("updated_at", {withTimezone: true}).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("hyperliquid_markets_kind_symbol_key").on(table.kind, table.hl_symbol),
        index("hyperliquid_markets_lookup_idx").on(table.kind, table.base_coin),
    ]
);

export type hyperliquid_market = typeof hyperliquid_markets.$inferSelect;
export type new_hyperliquid_market = typeof hyperliquid_markets.$inferInsert;

// ---------------------------------------------------------------------------
// Per-user trade settings (the policy layer)
// ---------------------------------------------------------------------------
//
// A canonical trade_setup is user-agnostic. These settings are the overlay that projects
// one setup into a given user's experience: how much to scale out vs let run, whether to
// move the stop to breakeven, how to treat the entry, and the trailing distance for the
// runner. Nothing here ever changes a stored setup - it only shapes what that user is
// notified about and (later) how their position is managed. Defaults cover users who
// never open the settings screen.

// how much a user scales out at the TPs vs leaves running
export const exit_style = pgEnum("exit_style", ["conservative", "balanced", "aggressive"]);

// how a user treats the entry zone
export const entry_style = pgEnum("entry_style", ["exact", "zone", "dca"]);

// when (if ever) to move the stop to the entry price
export const breakeven_trigger = pgEnum("breakeven_trigger", ["off", "after_tp1", "at_1r"]);

export const user_trade_settings = pgTable("user_trade_settings", {
    // references users.id (the Privy user id); no FK, matching the rest of the schema
    user_id: text("user_id").primaryKey(),
    exit_style: exit_style("exit_style").notNull().default("balanced"),
    entry_style: entry_style("entry_style").notNull().default("zone"),
    move_to_breakeven: breakeven_trigger("move_to_breakeven").notNull().default("after_tp1"),
    trailing_enabled: boolean("trailing_enabled").notNull().default(true),
    // trailing distance for the runner, as a percent; null = use the default
    trailing_pct: numeric("trailing_pct", {precision: 10, scale: 4}),
    updated_at: timestamp("updated_at", {withTimezone: true}).notNull().defaultNow(),
    created_at: timestamp("created_at", {withTimezone: true}).notNull().defaultNow(),
});

export type user_trade_setting = typeof user_trade_settings.$inferSelect;
export type new_user_trade_setting = typeof user_trade_settings.$inferInsert;

// ---------------------------------------------------------------------------
// Backtesting
// ---------------------------------------------------------------------------
//
// A backtest replays historical Hyperliquid candles against stored trade_setups to measure
// how they would have performed. One run computes every source_type x mode:
//   - mode "as_traded": respects our live rules (invalidated / expired = no trade)
//   - mode "take_all":  ignores invalidation & expiry (take every setup that reaches entry)
// Results: per-setup detail (backtest_results) + per type x mode summary (backtest_summary).

const metric = (name: string) => numeric(name, {precision: 20, scale: 6});

export const backtest_runs = pgTable("backtest_runs", {
    id: serial("id").primaryKey(),
    started_at: timestamp("started_at", {withTimezone: true}).notNull().defaultNow(),
    window_start: timestamp("window_start", {withTimezone: true}).notNull(),
    window_end: timestamp("window_end", {withTimezone: true}).notNull(),
    // {margin_usd, leverage, trailing_pct, alloc, interval, ...}
    params: jsonb("params").notNull(),
    notes: text("notes"),
});

export type backtest_run = typeof backtest_runs.$inferSelect;
export type new_backtest_run = typeof backtest_runs.$inferInsert;

export const backtest_results = pgTable(
    "backtest_results",
    {
        id: serial("id").primaryKey(),
        run_id: integer("run_id").notNull(),
        setup_id: integer("setup_id").notNull(),
        source_type: text("source_type").notNull(),
        mode: text("mode").notNull(),
        direction: text("direction").notNull(),

        entered: boolean("entered").notNull(),
        entry_at: timestamp("entry_at", {withTimezone: true}),
        time_to_entry_min: metric("time_to_entry_min"),

        sl_hit: boolean("sl_hit").notNull().default(false),
        tp1_hit: boolean("tp1_hit").notNull().default(false),
        tp2_hit: boolean("tp2_hit").notNull().default(false),
        tp3_hit: boolean("tp3_hit").notNull().default(false),
        sl_at: timestamp("sl_at", {withTimezone: true}),
        tp1_at: timestamp("tp1_at", {withTimezone: true}),
        tp2_at: timestamp("tp2_at", {withTimezone: true}),
        tp3_at: timestamp("tp3_at", {withTimezone: true}),

        max_tp: integer("max_tp").notNull().default(0),
        mae_r: metric("mae_r"),
        mfe_r: metric("mfe_r"),
        // invalidated | expired | no_entry | sl | tp1 | tp2 | tp3 | open
        outcome: text("outcome").notNull(),
        // when the position fully closed (for concurrency), null if never entered/still open
        resolved_at: timestamp("resolved_at", {withTimezone: true}),

        tp1_source: text("tp1_source"),
        tp2_source: text("tp2_source"),
        tp3_source: text("tp3_source"),

        // per-policy pnl for this trade: {tp1,tp2,tp3,scaleout} -> {r, pct, usd}
        policies: jsonb("policies").notNull(),
    },
    (table) => [
        index("backtest_results_run_idx").on(table.run_id, table.source_type, table.mode),
        uniqueIndex("backtest_results_unique").on(table.run_id, table.setup_id, table.mode),
    ]
);

export type backtest_result = typeof backtest_results.$inferSelect;
export type new_backtest_result = typeof backtest_results.$inferInsert;

export const backtest_summary = pgTable(
    "backtest_summary",
    {
        id: serial("id").primaryKey(),
        run_id: integer("run_id").notNull(),
        source_type: text("source_type").notNull(),
        mode: text("mode").notNull(),

        total: integer("total").notNull(),
        entered: integer("entered").notNull(),
        invalidated: integer("invalidated").notNull(),
        expired: integer("expired").notNull(),
        no_entry: integer("no_entry").notNull(),
        open_trades: integer("open_trades").notNull(),
        entry_rate: metric("entry_rate"),
        avg_time_to_entry_min: metric("avg_time_to_entry_min"),

        // counts among entered trades
        cnt_sl: integer("cnt_sl").notNull(),
        cnt_tp1: integer("cnt_tp1").notNull(),
        cnt_tp2: integer("cnt_tp2").notNull(),
        cnt_tp3: integer("cnt_tp3").notNull(),
        avg_tps_hit: metric("avg_tps_hit"),
        partner_tp_hits: integer("partner_tp_hits").notNull().default(0),
        derived_tp_hits: integer("derived_tp_hits").notNull().default(0),

        // concurrency (capital sizing), per this type x mode
        max_concurrent: integer("max_concurrent").notNull().default(0),
        avg_concurrent: metric("avg_concurrent"),
        implied_capital_usd: metric("implied_capital_usd"),

        // per-policy aggregates: {tp1,tp2,tp3,scaleout} ->
        //   {total_r, avg_r, total_pct, total_usd, avg_usd, win_rate, profit_factor,
        //    usd_partner, usd_derived}
        policies: jsonb("policies").notNull(),
    },
    (table) => [
        uniqueIndex("backtest_summary_unique").on(table.run_id, table.source_type, table.mode),
    ]
);

export type backtest_summary_row = typeof backtest_summary.$inferSelect;
export type new_backtest_summary_row = typeof backtest_summary.$inferInsert;
