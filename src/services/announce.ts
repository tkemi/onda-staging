import {and, eq, gt, isNotNull, ne} from "drizzle-orm";
import {db, trade_setups, type trade_setup} from "../db";
import {notify_new_setup} from "./notification_service";
import {SIMILAR_ENTRY_PCT} from "./supersede";

// Announce freshly-created setups to the setups channel, suppressing near-identical
// repeats so the channel does not get spammed. A setup is only sent if no similar setup
// (same source, coin, direction, entry within SIMILAR_ENTRY_PCT) was already announced in
// the recent window. Either way the new setup is stamped notified_at, so the next refresh
// of the same trade stays silent.
//
// This complements supersedence: supersedence keeps one live row per cluster; this keeps
// one *notification* per cluster.

const RECENT_MS = 24 * 3_600_000;

const entry_mid = (setup: trade_setup): number =>
    (Number(setup.entry_low) + Number(setup.entry_high)) / 2;

const similar = (a: number, b: number): boolean =>
    b !== 0 && Math.abs(a - b) / Math.abs(b) <= SIMILAR_ENTRY_PCT;

// Has a near-identical setup already been announced recently?
const already_announced = async (setup: trade_setup): Promise<boolean> => {
    const since = new Date(Date.now() - RECENT_MS);

    const rows = await db
        .select({
            entry_low: trade_setups.entry_low,
            entry_high: trade_setups.entry_high,
        })
        .from(trade_setups)
        .where(and(
            eq(trade_setups.source_type, setup.source_type),
            eq(trade_setups.base_coin, setup.base_coin),
            eq(trade_setups.direction, setup.direction),
            isNotNull(trade_setups.notified_at),
            gt(trade_setups.notified_at, since),
            ne(trade_setups.id, setup.id),
        ));

    const mid = entry_mid(setup);

    return rows.some((row) => similar(mid, (Number(row.entry_low) + Number(row.entry_high)) / 2));
};

// Announce the given (live, freshly-created) setups, skipping repeats. `mids` supplies the
// current Hyperliquid price per hl_symbol for the message.
export const announce_new_setups = async (
    setups: trade_setup[],
    mids: Map<string, number>
): Promise<number> => {
    let sent = 0;

    for (const setup of setups) {
        const now = new Date();
        const repeat = await already_announced(setup);

        // stamp notified_at regardless, so later refreshes of this trade are recognised as
        // repeats and stay silent
        await db.update(trade_setups).set({notified_at: now}).where(eq(trade_setups.id, setup.id));

        if (repeat) {
            continue;
        }

        try {
            await notify_new_setup(setup, mids.get(setup.hl_symbol));
            sent++;
        } catch (error: unknown) {
            console.error(`[announce] notify failed for setup ${setup.id}:`, error);
        }
    }

    return sent;
};
