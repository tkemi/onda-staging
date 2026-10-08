import {eq, isNull, sql} from "drizzle-orm";
import {db, hl_accounts, hl_cursors, positions} from "../db";
import {fetch_clearinghouse_state, fetch_fills_since} from "./hl_api_service";
import {ingest_fills, store_clearinghouse_state} from "./fills_service";

// One user's fill sync, driven by the trades firehose.
//
// There is no scheduler here any more. The firehose is the only trigger: a public trade
// carrying one of our addresses means that user traded, and `sync_user` fetches their
// fills. `hl_cursors` is therefore a resume point, not a queue - it exists so a sync asks
// for what happened since last time instead of refetching a whole history.

// How far back a brand new cursor reaches. Hyperliquid keeps roughly the 10,000 most
// recent fills per account, so a user's first sync pulls everything it still has.
const BACKFILL_FROM_MS = 0;

// --- syncing ----------------------------------------------------------------

export interface sync_result {
    address: string;
    fills_seen: number;
    inserted: number;
    positions: number;
    activities: number;
    error: string | null;
}

// Fetches everything since the cursor, stores it, rebuilds the affected positions and
// writes the activity rows. Safe to call concurrently with itself for the same user -
// every write is an upsert keyed on hyperliquid's own ids.
export const sync_user = async (address: string): Promise<sync_result> => {
    const owner = address.toLowerCase();

    const empty: sync_result = {
        address: owner,
        fills_seen: 0,
        inserted: 0,
        positions: 0,
        activities: 0,
        error: null,
    };

    try {
        await db.insert(hl_cursors).values({privy_address: owner}).onConflictDoNothing();

        const [cursor] = await db
            .select({last_fill_time: hl_cursors.last_fill_time})
            .from(hl_cursors)
            .where(eq(hl_cursors.privy_address, owner))
            .limit(1);

        const since = Number(cursor?.last_fill_time ?? BACKFILL_FROM_MS);
        const incoming = await fetch_fills_since(owner, since);

        if (incoming.length === 0) {
            await db
                .update(hl_cursors)
                .set({last_synced_at: new Date(), last_error: null})
                .where(eq(hl_cursors.privy_address, owner));

            return empty;
        }

        const result = await ingest_fills(owner, incoming);
        const newest = incoming.reduce((max, fill) => (fill.time > max ? fill.time : max), since);

        await db
            .update(hl_cursors)
            .set({
                last_fill_time: String(newest),
                is_backfilled: true,
                last_synced_at: new Date(),
                last_error: null,
            })
            .where(eq(hl_cursors.privy_address, owner));

        return {
            address: owner,
            fills_seen: incoming.length,
            inserted: result.inserted,
            positions: result.positions,
            activities: result.activities,
            error: null,
        };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        console.error(`[hl] fill sync failed for ${owner}:`, message);

        await db
            .update(hl_cursors)
            .set({last_synced_at: new Date(), last_error: message})
            .where(eq(hl_cursors.privy_address, owner))
            .catch(() => undefined);

        return {...empty, error: message};
    }
};

// Refreshes the live view: account value, open positions, unrealized pnl, leverage,
// liquidation price, funding. Weight 2, the cheapest request hyperliquid serves.
//
// Returns whether the position fingerprint moved. `szi` changes only on a fill - mark
// price movement changes unrealizedPnl but never the size - so a changed digest is proof
// the user traded.
export const sync_state = async (address: string): Promise<{changed: boolean; open_positions: number}> => {
    const owner = address.toLowerCase();

    const [previous] = await db
        .select({positions_digest: hl_accounts.positions_digest})
        .from(hl_accounts)
        .where(eq(hl_accounts.privy_address, owner))
        .limit(1);

    const state = await fetch_clearinghouse_state(owner);
    const {open_positions, digest} = await store_clearinghouse_state(owner, state);

    return {changed: (previous?.positions_digest ?? null) !== digest, open_positions: open_positions};
};

// --- gap recovery -----------------------------------------------------------

// Who to re-check after the stream was down. The firehose has no replay, so a gap leaves
// us not knowing who traded during it. Users with something open are the ones whose state
// can change, and they are a small set, so this closes the common case in a handful of
// requests.
export const addresses_with_open_positions = async (): Promise<string[]> => {
    const rows = await db
        .selectDistinct({privy_address: positions.privy_address})
        .from(positions)
        .where(isNull(positions.closed_at));

    return rows.map((row) => row.privy_address);
};

// Every address we hold a cursor for - i.e. everyone who has ever traded. Used on a cold
// start, where there are no open positions to key recovery off yet.
export const addresses_with_cursors = async (): Promise<string[]> => {
    const rows = await db
        .select({privy_address: hl_cursors.privy_address})
        .from(hl_cursors)
        .orderBy(sql`${hl_cursors.last_synced_at} nulls first`);

    return rows.map((row) => row.privy_address);
};
