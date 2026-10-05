import {and, eq, inArray} from "drizzle-orm";
import {db, trade_setups, type hyperliquid_market, type trade_setup} from "../db";
import {build_perp_setup_row, type setup_row_input} from "./setup_row";

// Futures-plan zones are handled differently from pushed signals. The partner regenerates
// the same zones on every scheduled sweep, so instead of superseding older copies we COUNT
// them: a re-seen zone bumps `seen_count` (strength) and refreshes its validity, while a
// genuinely different entry becomes a new zone. Matching is on the entry price.

// how close two entries must be to count as "the same zone"
export const FUTURES_ZONE_MATCH_PCT = Number(process.env.FUTURES_ZONE_MATCH_PCT ?? 0.005); // 0.5%

const mid_of = (low: string | null, high: string | null): number =>
    (Number(low) + Number(high)) / 2;

const matches = (a: number, b: number): boolean =>
    b !== 0 && Math.abs(a - b) / Math.abs(b) <= FUTURES_ZONE_MATCH_PCT;

export interface merge_result {
    setup: trade_setup;
    created: boolean;   // true = brand-new zone, false = an existing zone seen again
}

// Either strengthen the matching open zone (count++) or create a new one.
export const merge_or_create_futures_setup = async (
    input: setup_row_input,
    market: hyperliquid_market
): Promise<merge_result | null> => {
    const now = new Date();

    // open zones for this coin/direction we might be re-seeing
    const open = await db
        .select()
        .from(trade_setups)
        .where(and(
            eq(trade_setups.source_type, "futures_plan"),
            eq(trade_setups.base_coin, market.base_coin),
            eq(trade_setups.direction, input.direction),
            inArray(trade_setups.status, ["pending", "armed"]),
        ));

    const match = open.find((s) => matches(input.entry_ref, mid_of(s.entry_low, s.entry_high)));

    if (match) {
        // same zone, seen again: strengthen it, leave levels untouched. No expiry to refresh
        // - futures zones live until price invalidates or triggers them.
        const [updated] = await db
            .update(trade_setups)
            .set({seen_count: match.seen_count + 1, last_seen_at: now})
            .where(eq(trade_setups.id, match.id))
            .returning();

        return updated ? {setup: updated, created: false} : null;
    }

    // genuinely new zone
    const row = build_perp_setup_row(input, market);
    const [inserted] = await db
        .insert(trade_setups)
        .values({...row, last_seen_at: now})
        .onConflictDoNothing()
        .returning();

    if (inserted) {
        return {setup: inserted, created: true};
    }

    // exact dedup_key already exists (e.g. a closed row with identical levels): treat as a
    // re-sighting of that row rather than losing the signal
    const [existing] = await db
        .select()
        .from(trade_setups)
        .where(and(
            eq(trade_setups.source_type, "futures_plan"),
            eq(trade_setups.dedup_key, row.dedup_key),
        ))
        .limit(1);

    if (!existing) {
        return null;
    }

    const [bumped] = await db
        .update(trade_setups)
        .set({seen_count: existing.seen_count + 1, last_seen_at: now})
        .where(eq(trade_setups.id, existing.id))
        .returning();

    return bumped ? {setup: bumped, created: false} : null;
};
