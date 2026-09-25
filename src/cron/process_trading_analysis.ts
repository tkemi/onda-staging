import {asc, eq, inArray, sql} from "drizzle-orm";
import {close_db, db} from "../db";
import {
    trading_analysis,
    trading_analysis_stream,
    type new_trading_analysis_result,
    type trading_analysis_stream_message,
} from "../db";
import dotenv from "dotenv";
dotenv.config();

// how many raw stream rows we drain per run
export const BATCH_SIZE = 200;

// stable advisory-lock key so two runs can never process the same rows at once
const ANALYSIS_LOCK_KEY = 728412;

// Turn one raw partner delivery into a finished analysis row. This is the ONE place
// the real logic goes once we know the partner's data shape. For now it passes the
// payload straight through so the whole pipeline is exercised end to end; replace the
// body with real parsing / scoring / aggregation. Returning null skips the row (it is
// still marked processed, so a message we can't use never blocks the queue).
export const build_analysis = (
    row: trading_analysis_stream_message
): new_trading_analysis_result | null => {
    const payload = row.payload as Record<string, unknown> | null;

    if (!payload) {
        // not JSON — nothing to analyse yet
        return null;
    }

    // TODO: real analysis. Placeholder echoes the payload through unchanged.
    const symbol = typeof payload.symbol === "string" ? payload.symbol : null;

    return {
        partner: row.partner,
        source_id: row.id,
        symbol,
        analysis: payload,
    };
};

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

    const results = rows
        .map(build_analysis)
        .filter((result): result is new_trading_analysis_result => result !== null);

    const processed_ids = rows.map((row) => row.id);

    // insert the analyses and mark the source rows processed atomically, so a crash
    // never leaves a stream row flagged processed without its analysis written.
    await db.transaction(async (tx) => {
        if (results.length > 0) {
            await tx.insert(trading_analysis).values(results);
        }

        await tx
            .update(trading_analysis_stream)
            .set({is_processed: true})
            .where(inArray(trading_analysis_stream.id, processed_ids));
    });

    console.log(`[analysis] processed ${rows.length} stream rows, produced ${results.length} analyses`);
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
