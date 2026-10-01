import {and, asc, eq, inArray, or, sql} from "drizzle-orm";
import {close_db, db} from "../db";
import {
    hyperliquid_markets,
    trade_setups,
    trading_analysis_stream,
    type hyperliquid_market,
    type new_trade_setup,
    type trading_analysis_stream_message,
} from "../db";
import {
    announce_new_setups,
    apply_supersedence,
    build_perp_setup_row,
    fetch_all_mids,
    groups_of,
    hl_name_candidates,
    meets_quality,
    parse_signal,
    to_base_coin,
} from "../services";
import type {trade_setup} from "../db";
import dotenv from "dotenv";
dotenv.config();

// how many raw stream rows we drain per run
export const BATCH_SIZE = 500;

// stable advisory-lock key so two runs can never process the same rows at once
const ANALYSIS_LOCK_KEY = 728412;

// All pushed partner signals are futures (LONG/SHORT), so they map to perp markets.
const MARKET_KIND = "perp" as const;

export const get_unprocessed = async (
    limit = BATCH_SIZE
): Promise<trading_analysis_stream_message[]> => {
    return db
        .select()
        .from(trading_analysis_stream)
        .where(eq(trading_analysis_stream.is_processed, false))
        .orderBy(asc(trading_analysis_stream.received_at))
        .limit(limit);
};

// Load the tradable perp markets once per run and index them by base coin, so resolving
// each signal is an in-memory lookup rather than a query per row.
const load_perp_index = async (): Promise<Map<string, hyperliquid_market>> => {
    const rows = await db
        .select()
        .from(hyperliquid_markets)
        .where(eq(hyperliquid_markets.kind, MARKET_KIND));

    return new Map(rows.filter((row) => !row.is_delisted).map((row) => [row.base_coin, row]));
};

const resolve_market = (
    index: Map<string, hyperliquid_market>,
    symbol: string
): hyperliquid_market | null => {
    for (const candidate of hl_name_candidates(to_base_coin(symbol))) {
        const market = index.get(candidate);

        if (market) {
            return market;
        }
    }

    return null;
};

// Turn one raw stream row into a canonical trade setup, or null when it cannot become one
// (unusable payload, or a market that is not tradable on Hyperliquid).
export const build_setup = (
    row: trading_analysis_stream_message,
    market_index: Map<string, hyperliquid_market>
): new_trade_setup | null => {
    const signal = parse_signal(row.payload);

    if (!signal) {
        return null;
    }

    // strategy-specific quality gate (e.g. Liquidity Hunt: A/A+ confidence, score > 9)
    if (!meets_quality(signal)) {
        return null;
    }

    const market = resolve_market(market_index, signal.symbol);

    if (!market) {
        return null;
    }

    return build_perp_setup_row({
        source_type: signal.source_type,
        stream_id: row.id,
        symbol: signal.symbol,
        direction: signal.direction,
        entry_low: signal.entry,
        entry_high: signal.entry,
        entry_ref: signal.entry,
        sl: signal.sl,
        raw_tps: signal.raw_tps,
        data: signal.data,
        generated_at: signal.generated_at,
    }, market);
};

export const process_trading_analysis = async (): Promise<void> => {
    // pg_try_advisory_lock returns immediately; the lock is held by this connection,
    // so a crashed run releases it when the connection drops.
    const lock = await db.execute(sql`select pg_try_advisory_lock(${ANALYSIS_LOCK_KEY}) as locked`);
    const locked = (lock.rows[0] as {locked: boolean} | undefined)?.locked;

    if (!locked) {
        console.log("[analysis] another run is already in progress, skipping this round");

        return;
    }

    try {
        await run();
    } finally {
        await db.execute(sql`select pg_advisory_unlock(${ANALYSIS_LOCK_KEY})`);
    }
};

const run = async (): Promise<void> => {
    const rows = await get_unprocessed();

    if (rows.length === 0) {
        console.log("[analysis] nothing to process");

        return;
    }

    const market_index = await load_perp_index();

    if (market_index.size === 0) {
        // without the markets table we cannot decide what is tradable; wait for the
        // sync_hl_markets cron rather than dropping every signal as unsupported.
        console.error("[analysis] no hyperliquid markets loaded, skipping this round");

        return;
    }

    const setups = rows
        .map((row) => build_setup(row, market_index))
        .filter((setup): setup is new_trade_setup => setup !== null);

    const processed_ids = rows.map((row) => row.id);
    let inserted: trade_setup[] = [];

    // insert the setups and mark the source rows processed atomically. onConflictDoNothing
    // collapses byte-identical re-sends via the (source_type, dedup_key) unique index, and
    // returning() gives us only the rows that were actually new.
    await db.transaction(async (tx) => {
        if (setups.length > 0) {
            inserted = await tx.insert(trade_setups).values(setups).onConflictDoNothing().returning();
        }

        await tx
            .update(trading_analysis_stream)
            .set({is_processed: true})
            .where(inArray(trading_analysis_stream.id, processed_ids));
    });

    // retire older near-identical setups so only the freshest of each cluster stays live
    const superseded = setups.length > 0 ? await apply_supersedence(groups_of(setups)) : 0;

    // announce freshly-created setups that are still live (not immediately superseded) to
    // the user-facing setups channel, suppressing near-identical repeats
    let sent = 0;

    if (inserted.length > 0) {
        const live = await db
            .select({id: trade_setups.id})
            .from(trade_setups)
            .where(and(
                inArray(trade_setups.id, inserted.map((row) => row.id)),
                or(eq(trade_setups.status, "pending"), eq(trade_setups.status, "armed")),
            ));
        const live_ids = new Set(live.map((row) => row.id));
        const live_setups = inserted.filter((setup) => live_ids.has(setup.id));

        if (live_setups.length > 0) {
            const mids = await fetch_all_mids();
            sent = await announce_new_setups(live_setups, mids);
        }
    }

    console.log(
        `[analysis] processed ${rows.length} stream rows, produced ${setups.length} setups` +
        (superseded > 0 ? `, superseded ${superseded}` : "") +
        (sent > 0 ? `, announced ${sent}` : "")
    );
};

if (require.main === module) {
    process_trading_analysis()
        .then(() => close_db())
        .then(() => process.exit(0))
        .catch((error: unknown) => {
            console.error("[analysis] failed:", error);
            void close_db().finally(() => process.exit(1));
        });
}
