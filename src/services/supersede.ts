import {and, desc, eq, inArray} from "drizzle-orm";
import {db, trade_setups} from "../db";

// When several signals describe more or less the SAME trade (same source, coin and
// direction, with entries within a small tolerance), we keep only the freshest one active
// and retire the rest as `superseded`, so the user is alerted once, on the latest. This is
// fuzzy on purpose - exact-identical re-sends are already collapsed by the dedup key; this
// handles near-identical entries.
//
// PROVISIONAL: the tolerance and the "same source_type" grouping are open for tuning.
export const SIMILAR_ENTRY_PCT = 0.005; // 0.5%

export interface setup_group {
    source_type: "filter_mix" | "liquidity_hunt" | "signal_hub" | "futures_plan";
    base_coin: string;
    direction: "long" | "short";
}

const entry_mid = (low: string | null, high: string | null): number => {
    const lo = Number(low);
    const hi = Number(high);

    return (lo + hi) / 2;
};

const similar = (a: number, b: number): boolean =>
    b !== 0 && Math.abs(a - b) / Math.abs(b) <= SIMILAR_ENTRY_PCT;

// For each distinct (source_type, base_coin, direction) group, walk the open setups newest
// first and keep one per entry cluster; the older members of each cluster are superseded.
export const apply_supersedence = async (groups: setup_group[]): Promise<number> => {
    const seen = new Set<string>();
    let total = 0;

    for (const group of groups) {
        const key = `${group.source_type}|${group.base_coin}|${group.direction}`;

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);

        const rows = await db
            .select()
            .from(trade_setups)
            .where(and(
                eq(trade_setups.source_type, group.source_type),
                eq(trade_setups.base_coin, group.base_coin),
                eq(trade_setups.direction, group.direction),
                inArray(trade_setups.status, ["pending", "armed"]),
            ))
            // newest analysis first, so the freshest of each cluster is the one we keep
            .orderBy(desc(trade_setups.generated_at), desc(trade_setups.id));

        const kept_mids: number[] = [];
        const to_supersede: number[] = [];

        for (const row of rows) {
            const mid = entry_mid(row.entry_low, row.entry_high);

            if (kept_mids.some((m) => similar(mid, m))) {
                to_supersede.push(row.id);
            } else {
                kept_mids.push(mid);
            }
        }

        if (to_supersede.length > 0) {
            await db
                .update(trade_setups)
                .set({status: "superseded"})
                .where(inArray(trade_setups.id, to_supersede));

            total += to_supersede.length;
        }
    }

    return total;
};

// The distinct groups touched by a set of freshly-built rows.
export const groups_of = (
    rows: Array<{source_type: string; base_coin: string; direction: string}>
): setup_group[] =>
    rows.map((row) => ({
        source_type: row.source_type as setup_group["source_type"],
        base_coin: row.base_coin,
        direction: row.direction as setup_group["direction"],
    }));
