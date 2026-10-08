import {
    boolean,
    date,
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

export const activity_type = pgEnum("activity_type", [
    "deposit-on-chain",
    "withdraw-on-chain",
    "open-position",
    "close-position",
    "liquidate-position",
    "open-limit-order",
]);

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

// A perp position being opened or closed on hyperliquid. Written by the fills pipeline -
// see src/services/fills_service.ts - from the fills the trades firehose and the backfill
// cron both feed into.
//
// NOTE the amounts here break the _wei convention the on-chain shapes above use, on
// purpose: hyperliquid quotes everything as a DECIMAL string ("0.0194" ETH, "2567.7" USD),
// not in base units, and there is no token contract to read decimals from - a perp is not
// an ERC-20. They are still strings for the same reason as everywhere else: a JSON number
// is a double and would lose digits. The client renders them as-is.
export interface perp_activity_data {
    // the market, as hyperliquid names it: "ETH", "BTC", "HYPE"
    coin: string;
    direction: "long" | "short";
    // absolute size in coin units, never negative - `direction` carries the sign
    size: string;
    // The leverage the position was opened at, e.g. 10 for a 10x long. Observed from
    // clearinghouseState WHILE THE POSITION IS OPEN - that is the only place it exists, a
    // fill does not carry it, and the live snapshot is deleted the moment the position
    // flattens. Null on any position that closed before we were watching, and NOT
    // recoverable from fill history afterwards.
    leverage: number | null;
    // the HyperCore transaction hash. It resolves on hyperliquid's own explorer and on
    // NO evm explorer - perps never touch an evm chain, so this is not an etherscan link
    tx_hash: string | null;
}

export interface open_position_activity_data extends perp_activity_data {
    // size-weighted average over every fill that built the position. NOT the price on the
    // signed order - a frontend market order pads its limit for slippage, so the signed
    // price and the fill price differ
    entry_price: string;
    // the collateral committed at entry: (size x entry_price) / leverage. Null when the
    // leverage was never observed. Note this is the margin AT ENTRY - hyperliquid's live
    // `marginUsed` can exceed it if the user tops up an isolated position afterwards
    margin: string | null;
    // what the OPENING fills cost. The close row's `fees` is the position's total
    fees: string;
}

export interface close_position_activity_data extends perp_activity_data {
    // both ends of the trade on one row, so the client needs no lookup back to the open
    entry_price: string;
    exit_price: string;
    // realized_pnl as a percentage, to 4 decimals, e.g. "-0.4170".
    //
    // The denominator is the ENTRY NOTIONAL (size x entry_price), not the margin, which
    // makes it leverage-free and computable for every position we will ever hold. Note
    // this is NOT the percentage hyperliquid's own ui shows - that one divides by margin,
    // so at 10x it reads ten times larger. `leverage` is on the row if you want to derive
    // it client-side.
    realized_pnl_pct: string;
    // fees paid on the fills that closed this position, as a positive number
    fees: string;
    // gross_pnl - fees. This is the number a user should see; a small winning trade is
    // routinely a net loss once taker fees are in, so the two cannot be collapsed
    realized_pnl: string;
}

// A limit order placed on hyperliquid's book.
//
// The only activity type with a real LIFECYCLE, which is what `activities.status` exists
// for: `pending` while it rests, `confirmed` once fully filled, `failed` when cancelled or
// rejected. One row that changes, not three rows accumulating.
//
// It needs no websocket to observe. A privy server wallet has no exportable key, so the
// only way one of our users can place an order at all is through this backend - we are the
// originator, and the row is written in the same request that calls the exchange. The
// trades firehose then reports the FILL like any other (a resting order that fills is a
// trade, and the public message carries both counterparties, maker included), and the
// fill's `oid` joins it straight back to this row.
export interface open_limit_order_activity_data {
    coin: string;
    direction: "long" | "short";
    // the order's full size, in coin units
    size: string;
    // how much of it has filled so far: the sum of `sz` over fills carrying this `oid`.
    // Equals `size` once status is "confirmed". A partially filled order stays "pending"
    // with this below `size`, because status has no "partial" value and a number says
    // more than an extra enum label would.
    filled_size: string;
    // the price the order rests at - NOT a fill price. A market order's signed limit is
    // padded for slippage and never matches its fill.
    limit_price: string;
    leverage: number | null;
    // collateral the order would commit if it filled: (size x limit_price) / leverage
    margin: string | null;
    // a reduce-only order cannot open or increase a position, only close one
    reduce_only: boolean;
    // hyperliquid's order id. Unique per order, so it is this row's handle: the fill that
    // closes the loop carries the same oid, and advancing the status is an exact join
    // rather than a match on price and time.
    oid: string;
    // null at placement: hyperliquid's order response returns {resting: {oid}}, not a
    // hash. The HyperCore hash only appears later, via historicalOrders.
    tx_hash: string | null;
}

// Keyed by the enum so the two cannot drift: a new activity_type has no valid
// `data` shape until it is added here.
export interface activity_data_by_type {
    "deposit-on-chain": deposit_activity_data;
    "withdraw-on-chain": withdraw_activity_data;
    "open-position": open_position_activity_data;
    "close-position": close_position_activity_data;
    // same fields as a close; the TYPE is what says it was forced
    "liquidate-position": close_position_activity_data;
    "open-limit-order": open_limit_order_activity_data;
}

export type activity_data = activity_data_by_type[keyof activity_data_by_type];

// A limit order placed on hyperliquid's book.
//
// The only activity type with a real LIFECYCLE, which is what `activities.status` exists
// for: `pending` while it rests, `confirmed` once fully filled, `failed` when cancelled or
// rejected. One row that changes, not three rows accumulating.
//
// It needs no websocket to observe. A privy server wallet has no exportable key, so the
// only way one of our users can place an order at all is through this backend - we are the
// originator, and the row is written in the same request that calls the exchange. The
// trades firehose then reports the FILL like any other (a resting order that fills is a
// trade, and the public message carries both counterparties, maker included), and the
// fill's `oid` joins it straight back to this row.
export interface open_limit_order_activity_data {
    coin: string;
    direction: "long" | "short";
    // the order's full size, in coin units
    size: string;
    // how much of it has filled so far: the sum of `sz` over fills carrying this `oid`.
    // Equals `size` once status is "confirmed". A partially filled order stays "pending"
    // with this below `size`, because status has no "partial" value and a number says
    // more than an extra enum label would.
    filled_size: string;
    // the price the order rests at - NOT a fill price. A market order's signed limit is
    // padded for slippage and never matches its fill.
    limit_price: string;
    leverage: number | null;
    // collateral the order would commit if it filled: (size x limit_price) / leverage
    margin: string | null;
    // a reduce-only order cannot open or increase a position, only close one
    reduce_only: boolean;
    // hyperliquid's order id. Unique per order, so it is this row's handle: the fill that
    // closes the loop carries the same oid, and advancing the status is an exact join
    // rather than a match on price and time.
    oid: string;
    // null at placement: hyperliquid's order response returns {resting: {oid}}, not a
    // hash. The HyperCore hash only appears later, via historicalOrders.
    tx_hash: string | null;
}

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

// ---------------------------------------------------------------------------
// Hyperliquid perps: fills, positions, and the ingest cursor
// ---------------------------------------------------------------------------
//
// There is no contract to index. Perp matching happens inside HyperCore's state
// transition, so a fill is not a transaction and emits no event - a HyperCore block
// carries orders and cancels only. The two places fills exist are a node's own output
// and the per-user API, so `fills` below is populated from `userFillsByTime`, triggered by
// the public trades firehose. `tid` makes a redelivery free. See src/ws/hl_trades_stream.ts.

export const position_close_reason = pgEnum("position_close_reason", [
    "closed",
    "liquidation",
    "backstop",
    "flip",
]);

// Append-only, the source of truth. One row per fill, exactly as hyperliquid reported it.
// Nothing is derived here - `positions` is rebuilt from these rows, so a bad derivation
// is always re-runnable without re-fetching anything.
export const fills = pgTable(
    "fills",
    {
        id: serial("id").primaryKey(),
        privy_address: text("privy_address").notNull(),
        // hyperliquid's unique id for a partial fill of an order. THE idempotency key:
        // the firehose path, the backfill cron and a websocket snapshot replay all insert
        // the same fill, and only one row may survive. Scoped by address because a single
        // match has two sides and both could be our users.
        tid: numeric("tid", {precision: 78, scale: 0}).notNull(),
        // market name for perps ("ETH"), or a pair/index for spot ("PURR/USDC", "@157")
        coin: text("coin").notNull(),
        // hyperliquid's own label: "Open Long", "Close Short", "Long > Short", and for
        // spot just "Buy"/"Sell". Kept raw rather than parsed into an enum - a new value
        // must not break ingestion, and the reconstruction works off sizes anyway.
        dir: text("dir").notNull(),
        // "B" = buy, "A" = sell
        side: text("side").notNull(),
        px: numeric("px", {precision: 38, scale: 10}).notNull(),
        sz: numeric("sz", {precision: 38, scale: 10}).notNull(),
        // the position size BEFORE this fill, signed. With `side` and `sz` this gives the
        // size after, which is what the position state machine replays.
        start_position: numeric("start_position", {precision: 38, scale: 10}).notNull(),
        // hyperliquid's closedPnl: gross, before fees, and 0 on a fill that only opens
        closed_pnl: numeric("closed_pnl", {precision: 38, scale: 10}).notNull(),
        // negative means a maker rebate
        fee: numeric("fee", {precision: 38, scale: 10}).notNull(),
        // charged by the UI builder; ours if we ever enable one, and it comes out of the
        // user's pnl just like `fee` does
        builder_fee: numeric("builder_fee", {precision: 38, scale: 10}),
        fee_token: text("fee_token").notNull(),
        oid: numeric("oid", {precision: 78, scale: 0}),
        // null unless the fill was forced: "market" is a normal liquidation, "backstop" is
        // the backstop liquidator taking over. The feed should read differently for each.
        liquidation_method: text("liquidation_method"),
        // a TWAP arrives as many small fills sharing one id. Without this, one TWAP entry
        // looks like fifty separate position changes in the feed.
        twap_id: numeric("twap_id", {precision: 78, scale: 0}),
        // the HyperCore transaction hash. Resolves on hyperliquid's explorer only.
        tx_hash: text("tx_hash"),
        // when the fill happened on hyperliquid, not when we stored it
        filled_at: timestamp("filled_at", {withTimezone: true}).notNull(),
        created_at: timestamp("created_at", {withTimezone: true}).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("fills_address_tid_key").on(table.privy_address, table.tid),
        // the replay reads one market's fills for one user, in order
        index("fills_replay_idx").on(table.privy_address, table.coin, table.filled_at),
        // the daily pnl rollup reads a user's fills over a date range
        index("fills_user_time_idx").on(table.privy_address, table.filled_at.desc()),
    ]
);

export type fill = typeof fills.$inferSelect;
export type new_fill = typeof fills.$inferInsert;

// One row per position, from open to close - the round trip, with everything the UI
// needs about it. Derived entirely from `fills` by replaying them per (address, coin),
// so this table can be dropped and rebuilt at any time.
export const positions = pgTable(
    "positions",
    {
        id: serial("id").primaryKey(),
        privy_address: text("privy_address").notNull(),
        coin: text("coin").notNull(),
        direction: text("direction").notNull(),
        // the tid of the fill that opened this position. Makes the replay idempotent:
        // re-running it upserts the same rows instead of duplicating them.
        open_tid: numeric("open_tid", {precision: 78, scale: 0}).notNull(),
        // the tid of the fill that flattened it; null while still open
        close_tid: numeric("close_tid", {precision: 78, scale: 0}),
        opened_at: timestamp("opened_at", {withTimezone: true}).notNull(),
        closed_at: timestamp("closed_at", {withTimezone: true}),
        close_reason: position_close_reason("close_reason"),
        // size-weighted average of the fills that built the position, and of the fills
        // that unwound it
        entry_px: numeric("entry_px", {precision: 38, scale: 10}).notNull(),
        exit_px: numeric("exit_px", {precision: 38, scale: 10}),
        // the largest absolute size the position ever reached, and what is open right
        // now (0 once closed)
        max_size: numeric("max_size", {precision: 38, scale: 10}).notNull(),
        open_size: numeric("open_size", {precision: 38, scale: 10}).notNull(),
        // summed over this position's fills. gross_pnl is hyperliquid's closedPnl;
        // realized_pnl is gross_pnl - fees, which is what the user actually made.
        gross_pnl: numeric("gross_pnl", {precision: 38, scale: 10}).notNull().default("0"),
        fees: numeric("fees", {precision: 38, scale: 10}).notNull().default("0"),
        realized_pnl: numeric("realized_pnl", {precision: 38, scale: 10}).notNull().default("0"),
        // Observed from clearinghouseState WHILE THE POSITION IS OPEN, because that is the
        // only place it exists - a fill does not carry leverage, and the live snapshot is
        // deleted the moment the position flattens. Null on any position that closed before
        // this was captured, and not recoverable from fill history afterwards.
        leverage_value: integer("leverage_value"),
        leverage_type: text("leverage_type"),
        updated_at: timestamp("updated_at", {withTimezone: true}).notNull().defaultNow(),
        created_at: timestamp("created_at", {withTimezone: true}).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("positions_open_tid_key").on(table.privy_address, table.coin, table.open_tid),
        // a user's trade history, newest first
        index("positions_user_idx").on(table.privy_address, table.opened_at.desc()),
        // "who has something open" - the set the sentinel and gap recovery poll
        index("positions_still_open_idx").on(table.closed_at, table.privy_address),
    ]
);

export type position = typeof positions.$inferSelect;
export type new_position = typeof positions.$inferInsert;

// Where fill ingestion got to, per user, so a sync resumes exactly instead of refetching
// everything: `last_fill_time` is passed straight back as the next `startTime`.
//
// NOTE the trades firehose has no replay on reconnect. The stream re-syncs users with an
// open position when it reconnects, which covers a dropped socket inside a live process -
// but a process that is down entirely (a deploy, a crash) has no scheduled sweep behind it
// any more, so a trade made during that window is only picked up when that user next
// trades. There is deliberately no cron.
export const hl_cursors = pgTable(
    "hl_cursors",
    {
        privy_address: text("privy_address").primaryKey(),
        // ms since epoch of the newest fill we hold. The next request asks for
        // startTime = this value, and `tid` discards the boundary fill we already have.
        last_fill_time: numeric("last_fill_time", {precision: 78, scale: 0}).notNull().default("0"),
        // set once the first full history sweep has completed for this user, so the
        // backfill can tell "new user, fetch everything" from "caught up, fetch the tail"
        is_backfilled: boolean("is_backfilled").notNull().default(false),
        last_synced_at: timestamp("last_synced_at", {withTimezone: true}),
        last_error: text("last_error"),
    }
);

export type hl_cursor = typeof hl_cursors.$inferSelect;
export type new_hl_cursor = typeof hl_cursors.$inferInsert;

// ---------------------------------------------------------------------------
// Live state, straight from clearinghouseState
// ---------------------------------------------------------------------------
//
// `fills` and `positions` above are the HISTORY - what happened, derived from fills,
// exact, and the basis for realized pnl. These two tables are the PRESENT: hyperliquid's
// own view of the account right now, including the one number fills can never give us,
// unrealized pnl on a position that is still open.
//
// Both are overwritten on every poll, never appended to. One clearinghouseState call
// (weight 2, the cheapest request on the api) refreshes a user's account row and all of
// their position rows at once.

// Account-level state. One row per user, replaced on each poll.
export const hl_accounts = pgTable("hl_accounts", {
    privy_address: text("privy_address").primaryKey(),
    // total equity: cash plus unrealized pnl on every open position. This is the number
    // the daily pnl calendar diffs - see src/cron/pnl_snapshot.ts.
    account_value: numeric("account_value", {precision: 38, scale: 10}).notNull(),
    // notional of all open positions, and the cash leg
    total_ntl_pos: numeric("total_ntl_pos", {precision: 38, scale: 10}).notNull(),
    total_raw_usd: numeric("total_raw_usd", {precision: 38, scale: 10}).notNull(),
    total_margin_used: numeric("total_margin_used", {precision: 38, scale: 10}).notNull(),
    // what the user could withdraw right now
    withdrawable: numeric("withdrawable", {precision: 38, scale: 10}).notNull(),
    // hash of every open position's coin:szi. `szi` moves ONLY on a fill - mark price
    // changes unrealizedPnl and positionValue but never the size - so a change in this
    // digest means the user traded. That makes the weight-2 call a fill detector, and
    // it is what the sentinel in the backfill cron compares against.
    positions_digest: text("positions_digest").notNull().default(""),
    // hyperliquid's own timestamp on the response, not our clock
    snapshot_at: timestamp("snapshot_at", {withTimezone: true}).notNull(),
    updated_at: timestamp("updated_at", {withTimezone: true}).notNull().defaultNow(),
});

export type hl_account = typeof hl_accounts.$inferSelect;
export type new_hl_account = typeof hl_accounts.$inferInsert;

// Every currently open position, with the live metrics only hyperliquid can compute.
// A row exists while the position does and is deleted once it is flat, so this table is
// always "what is open right now" with no filtering needed.
export const position_snapshots = pgTable(
    "position_snapshots",
    {
        id: serial("id").primaryKey(),
        privy_address: text("privy_address").notNull(),
        coin: text("coin").notNull(),
        // signed size as hyperliquid reports it: negative is short. `direction` and
        // `size` below are the same thing split up, for a feed that should not do maths.
        szi: numeric("szi", {precision: 38, scale: 10}).notNull(),
        direction: text("direction").notNull(),
        size: numeric("size", {precision: 38, scale: 10}).notNull(),
        entry_px: numeric("entry_px", {precision: 38, scale: 10}).notNull(),
        // current notional at mark price
        position_value: numeric("position_value", {precision: 38, scale: 10}).notNull(),
        // THE field that does not exist anywhere in fill history: mark-to-market on an
        // open position. A day where a position moved but nothing closed shows 0 realized
        // pnl and a large unrealized one.
        unrealized_pnl: numeric("unrealized_pnl", {precision: 38, scale: 10}).notNull(),
        // null when hyperliquid cannot compute one (no position risk)
        liquidation_px: numeric("liquidation_px", {precision: 38, scale: 10}),
        margin_used: numeric("margin_used", {precision: 38, scale: 10}).notNull(),
        // "cross" or "isolated"
        leverage_type: text("leverage_type").notNull(),
        leverage_value: integer("leverage_value").notNull(),
        max_leverage: integer("max_leverage").notNull(),
        // funding is a real cost of carry and is NOT in closedPnl, so a position held
        // through funding has pnl that fills alone cannot explain
        cum_funding_all_time: numeric("cum_funding_all_time", {precision: 38, scale: 10}).notNull(),
        cum_funding_since_open: numeric("cum_funding_since_open", {precision: 38, scale: 10}).notNull(),
        cum_funding_since_change: numeric("cum_funding_since_change", {precision: 38, scale: 10}).notNull(),
        snapshot_at: timestamp("snapshot_at", {withTimezone: true}).notNull(),
        updated_at: timestamp("updated_at", {withTimezone: true}).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("position_snapshots_address_coin_key").on(table.privy_address, table.coin),
        index("position_snapshots_user_idx").on(table.privy_address),
    ]
);

export type position_snapshot = typeof position_snapshots.$inferSelect;
export type new_position_snapshot = typeof position_snapshots.$inferInsert;
