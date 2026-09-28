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

// The processed output: the actual trading analysis served to the frontend. The
// process_trading_analysis cron reads raw partner deliveries from trading_analysis_stream,
// turns them into analysis rows here, then marks the source rows processed.
export const trading_analysis = pgTable(
    "trading_analysis",
    {
        id: serial("id").primaryKey(),
        // the partner whose stream this analysis was derived from
        partner: text("partner").notNull(),
        // the raw stream row this came from, for traceability and backfills
        source_id: integer("source_id"),
        // optional coarse key the frontend can filter on, e.g. a market symbol
        symbol: text("symbol"),
        // the finished analysis the frontend renders; shape TBD once we see real data
        analysis: jsonb("analysis").notNull(),
        created_at: timestamp("created_at", {withTimezone: true}).notNull().defaultNow(),
    },
    (table) => [
        index("trading_analysis_partner_idx").on(table.partner),
        index("trading_analysis_symbol_idx").on(table.symbol),
        index("trading_analysis_created_idx").on(table.created_at),
    ]
);

export type trading_analysis_result = typeof trading_analysis.$inferSelect;
export type new_trading_analysis_result = typeof trading_analysis.$inferInsert;

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
    tx_hash: string;
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
