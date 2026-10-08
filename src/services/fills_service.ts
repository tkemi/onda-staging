import {and, asc, eq, inArray, isNull, like, notInArray, sql} from "drizzle-orm";
import {
    activities,
    db,
    fills,
    hl_accounts,
    position_snapshots,
    positions,
    type new_activity,
    type new_fill,
    type new_position,
    type new_position_snapshot,
    type close_position_activity_data,
    type open_position_activity_data,
} from "../db";
import {positions_digest, type hl_clearinghouse_state, type hl_fill} from "./hl_api_service";

// Turns hyperliquid fills into the three things the product needs: a fill ledger, the
// position round trips derived from it, and the activity rows the feed renders.
//
// The whole module is idempotent. Fills dedupe on (privy_address, tid); positions upsert
// on (privy_address, coin, open_tid); activities upsert on (type, source_key). So the
// trades firehose, the backfill cron and a replayed websocket snapshot can all deliver
// the same fill and the result is identical - which is what makes a dropped socket a
// non-event rather than a data loss.

// Spot fills ("PURR/USDC", "@157") have no position to reconstruct: `dir` is just
// Buy/Sell, there is no szi, and closedPnl is always 0. They are still stored in `fills`,
// they just do not produce positions or perp activities.
const is_perp = (coin: string): boolean => !coin.includes("/") && !coin.startsWith("@");

// Amounts arrive as decimal strings and are summed as doubles here, then normalised back
// to a string. Hyperliquid quotes at most 8 decimals on values far below 2^53, so a
// double is exact enough for sizes and usd; toPrecision(12) strips the artifacts a sum of
// doubles leaves behind (0.30000000000000004 -> 0.3). Same approach as telegram_service.
const num = (value: string | null | undefined): number => {
    const parsed = Number(value ?? "0");

    return isFinite(parsed) ? parsed : 0;
};

const dec = (value: number): string => {
    if (!isFinite(value)) {
        return "0";
    }

    return String(parseFloat(value.toPrecision(12)));
};

// --- storing fills ---------------------------------------------------------

const to_fill_row = (address: string, fill: hl_fill): new_fill => ({
    privy_address: address.toLowerCase(),
    tid: String(fill.tid),
    coin: fill.coin,
    dir: fill.dir,
    side: fill.side,
    px: fill.px,
    sz: fill.sz,
    start_position: fill.startPosition,
    closed_pnl: fill.closedPnl,
    fee: fill.fee,
    builder_fee: fill.builderFee ?? null,
    fee_token: fill.feeToken,
    oid: String(fill.oid),
    // "market" is a normal liquidation, "backstop" is the backstop liquidator stepping in
    liquidation_method: fill.liquidation?.method ?? null,
    twap_id: fill.twapId === null ? null : String(fill.twapId),
    tx_hash: fill.hash,
    filled_at: new Date(fill.time),
});

// Stores fills and returns the perp markets that actually gained a row, so the caller
// only replays what changed. An empty list means every fill was already known - the
// common case when the firehose and the cron overlap.
export const store_fills = async (
    address: string,
    incoming: hl_fill[]
): Promise<{inserted: number; coins: string[]}> => {
    if (incoming.length === 0) {
        return {inserted: 0, coins: []};
    }

    const rows = incoming.map((fill) => to_fill_row(address, fill));

    const stored = await db
        .insert(fills)
        .values(rows)
        .onConflictDoNothing()
        .returning({coin: fills.coin});

    const coins = [...new Set(stored.map((row) => row.coin).filter(is_perp))];

    return {inserted: stored.length, coins: coins};
};

// --- the position state machine --------------------------------------------

interface segment {
    open_tid: string;
    close_tid: string | null;
    direction: "long" | "short";
    opened_at: Date;
    closed_at: Date | null;
    close_reason: "closed" | "liquidation" | "backstop" | "flip" | null;
    // size-weighted price of the fills that built it, and of those that unwound it
    entry_notional: number;
    entry_size: number;
    exit_notional: number;
    exit_size: number;
    max_size: number;
    open_size: number;
    gross_pnl: number;
    // split, because an open row must report only what the OPENING fills cost - the
    // position's total fees are not known until it closes
    entry_fees: number;
    exit_fees: number;
    fill_count: number;
    // kept for the activity rows: the fill that opened it, and the one that closed it
    open_px: number;
    open_size_first: number;
    open_tx_hash: string | null;
    close_tx_hash: string | null;
}

const total_fees = (seg: segment): number => seg.entry_fees + seg.exit_fees;

const close_reason_for = (liquidation_method: string | null): "closed" | "liquidation" | "backstop" =>
    liquidation_method === "backstop" ? "backstop" : liquidation_method === "market" ? "liquidation" : "closed";

// Sizes compare as doubles, so equality needs a tolerance. Hyperliquid quotes at most 8
// decimals, well inside this.
const SIZE_EPSILON = 1e-9;

const signed_delta = (side: string, sz: string): number => (side === "B" ? num(sz) : -num(sz));

// Puts fills into true EXECUTION order.
//
// This is not the same as sorting. Fills that match in one block share a millisecond, and
// `tid` is NOT monotonic within that millisecond - observed on mainnet, `tid` ascending was
// the exact REVERSE of execution order on two separate orders. Sorting by (time, tid) made
// a 2-fill close look like "close, then open a new position", leaving a phantom position
// open that hyperliquid said was flat.
//
// `start_position` is the authority: it states the size before that fill, so the fills in a
// tie group chain head-to-tail. Within each group we repeatedly take the fill whose
// start_position matches the size we are currently at.
const order_fills = <T extends {start_position: string; side: string; sz: string; filled_at: Date}>(
    rows: T[]
): T[] => {
    const ordered: T[] = [];
    // signed size after the last applied fill; null until the first group is seeded
    let running: number | null = null;
    let i = 0;

    while (i < rows.length) {
        const at = rows[i]!.filled_at.getTime();
        let j = i;

        while (j < rows.length && rows[j]!.filled_at.getTime() === at) {
            j += 1;
        }

        const group = rows.slice(i, j);

        if (group.length === 1) {
            const only = group[0]!;
            ordered.push(only);
            running = num(only.start_position) + signed_delta(only.side, only.sz);
        } else {
            const remaining = [...group];
            let cursor: number | null = running;

            while (remaining.length > 0) {
                let index = -1;

                if (cursor !== null) {
                    index = remaining.findIndex(
                        (row) => Math.abs(num(row.start_position) - cursor!) < SIZE_EPSILON
                    );
                }

                if (index === -1 && cursor === null) {
                    // first group of this market's history: the fill that starts flat opens
                    // the sequence; failing that, the biggest position starts the unwind
                    index = remaining.findIndex((row) => num(row.start_position) === 0);

                    if (index === -1) {
                        index = remaining.reduce(
                            (best, row, at_index) =>
                                Math.abs(num(row.start_position)) > Math.abs(num(remaining[best]!.start_position))
                                    ? at_index
                                    : best,
                            0
                        );
                    }
                }

                if (index === -1) {
                    // the chain is broken (a fill we never fetched) - keep the given order
                    // rather than inventing one
                    index = 0;
                }

                const [picked] = remaining.splice(index, 1);
                ordered.push(picked!);
                cursor = num(picked!.start_position) + signed_delta(picked!.side, picked!.sz);
            }

            running = cursor;
        }

        i = j;
    }

    return ordered;
};

// Replays one market's fills in order and returns every position, open or closed.
//
// The signed size before each fill comes from the fill itself (`start_position`), not
// from a running total we keep. That is what makes this self-healing: if a fill was ever
// missed, the next fill's start_position states the truth and the replay snaps back to
// it instead of drifting forever.
export const replay_positions = (
    rows: {
        tid: string;
        side: string;
        sz: string;
        px: string;
        start_position: string;
        closed_pnl: string;
        fee: string;
        builder_fee: string | null;
        liquidation_method: string | null;
        tx_hash: string | null;
        filled_at: Date;
    }[]
): segment[] => {
    const done: segment[] = [];
    let open: segment | null = null;

    // (time, tid) is not execution order - see order_fills
    rows = order_fills(rows);

    const begin = (tid: string, at: Date, size: number, px: number, tx_hash: string | null): segment => ({
        open_tid: tid,
        close_tid: null,
        direction: size > 0 ? "long" : "short",
        opened_at: at,
        closed_at: null,
        close_reason: null,
        entry_notional: Math.abs(size) * px,
        entry_size: Math.abs(size),
        exit_notional: 0,
        exit_size: 0,
        max_size: Math.abs(size),
        open_size: Math.abs(size),
        gross_pnl: 0,
        entry_fees: 0,
        exit_fees: 0,
        fill_count: 0,
        open_px: px,
        open_size_first: Math.abs(size),
        open_tx_hash: tx_hash,
        close_tx_hash: null,
    });

    for (const row of rows) {
        const px = num(row.px);
        const size = num(row.sz);
        const start = num(row.start_position);
        // "B" is a buy, which raises the signed position; "A" lowers it
        const delta = row.side === "B" ? size : -size;
        const end = start + delta;
        const cost = num(row.fee) + num(row.builder_fee);

        // A fill whose start_position disagrees with what we have open means the history
        // before it was never fetched - a backfill window that began mid-position. Close
        // the stale segment rather than carrying a wrong entry price into it.
        if (open && Math.sign(start) !== 0 && Math.sign(start) !== (open.direction === "long" ? 1 : -1)) {
            open.closed_at = row.filled_at;
            open.close_reason = "flip";
            done.push(open);
            open = null;
        }

        // Opening from flat, or picking up a position whose opening fills we never saw.
        if (!open) {
            if (end === 0) {
                // a close with no known open: record the pnl against nothing we can model
                continue;
            }

            open = begin(row.tid, row.filled_at, start !== 0 ? start : end, px, row.tx_hash);

            // mid-position pickup: the size we inherited was not bought at this price
            if (start !== 0) {
                open.entry_notional = Math.abs(start) * px;
                open.entry_size = Math.abs(start);
                open.max_size = Math.abs(start);
                open.open_size = Math.abs(start);
            }
        }

        open.fill_count += 1;
        open.gross_pnl += num(row.closed_pnl);

        const grew = Math.abs(end) > Math.abs(start);
        const flipped = end !== 0 && Math.sign(end) !== Math.sign(start) && start !== 0;

        // a flipping fill both closes and opens; its cost is charged to the close, so the
        // new segment starts with no entry fee of its own
        if (grew && !flipped) {
            open.entry_fees += cost;
        } else {
            open.exit_fees += cost;
        }

        if (flipped) {
            // one fill closed the position and opened the opposite side. The part that
            // closed is |start|; the remainder |end| is a brand new position.
            open.exit_notional += Math.abs(start) * px;
            open.exit_size += Math.abs(start);
            open.open_size = 0;
            open.closed_at = row.filled_at;
            open.close_tid = row.tid;
            open.close_tx_hash = row.tx_hash;
            open.close_reason = "flip";
            done.push(open);

            open = begin(row.tid, row.filled_at, end, px, row.tx_hash);
            open.fill_count = 1;

            continue;
        }

        if (grew) {
            open.entry_notional += size * px;
            open.entry_size += size;
        } else {
            open.exit_notional += size * px;
            open.exit_size += size;
        }

        open.open_size = Math.abs(end);
        open.max_size = Math.max(open.max_size, Math.abs(end));

        if (end === 0) {
            open.closed_at = row.filled_at;
            open.close_tid = row.tid;
            open.close_tx_hash = row.tx_hash;
            open.close_reason = close_reason_for(row.liquidation_method);
            done.push(open);
            open = null;
        }
    }

    return open ? [...done, open] : done;
};

// --- persisting positions and activities ------------------------------------

const to_position_row = (address: string, coin: string, seg: segment): new_position => ({
    privy_address: address.toLowerCase(),
    coin: coin,
    direction: seg.direction,
    open_tid: seg.open_tid,
    close_tid: seg.close_tid,
    opened_at: seg.opened_at,
    closed_at: seg.closed_at,
    close_reason: seg.closed_at ? (seg.close_reason ?? "closed") : null,
    entry_px: dec(seg.entry_size > 0 ? seg.entry_notional / seg.entry_size : seg.open_px),
    exit_px: seg.exit_size > 0 ? dec(seg.exit_notional / seg.exit_size) : null,
    max_size: dec(seg.max_size),
    open_size: dec(seg.open_size),
    gross_pnl: dec(seg.gross_pnl),
    fees: dec(total_fees(seg)),
    // what the user actually made. A small winning trade is routinely a net loss once
    // taker fees are counted, so these two can never be collapsed into one number.
    realized_pnl: dec(seg.gross_pnl - total_fees(seg)),
    updated_at: new Date(),
});

const to_activity_rows = (
    address: string,
    coin: string,
    seg: segment,
    leverage: number | null
): new_activity[] => {
    const owner = address.toLowerCase();
    const rows: new_activity[] = [];

    const avg_entry = seg.entry_size > 0 ? seg.entry_notional / seg.entry_size : seg.open_px;

    // the position as it stands, not just its first fill, so an open row and its close row
    // describe the same position with the same size
    const entry_notional_open = seg.max_size * avg_entry;
    const open_margin = leverage !== null && leverage > 0 ? entry_notional_open / leverage : null;

    const open_data: open_position_activity_data = {
        coin: coin,
        direction: seg.direction,
        size: dec(seg.max_size),
        entry_price: dec(avg_entry),
        leverage: leverage,
        margin: open_margin === null ? null : dec(open_margin),
        // only what the opening fills cost
        fees: dec(seg.entry_fees),
        tx_hash: seg.open_tx_hash,
    };

    rows.push({
        privy_address: owner,
        type: "open-position",
        // a fill is final the moment hyperliquid reports it; there is no pending state
        status: "confirmed",
        // the opening fill's tid - unique per position, so a replay cannot duplicate it
        source_key: `${owner}:${coin}:${seg.open_tid}`,
        data: open_data,
        occurred_at: seg.opened_at,
    });

    if (seg.closed_at && seg.close_tid) {
        const exit_px = seg.exit_size > 0 ? seg.exit_notional / seg.exit_size : 0;
        const entry_px = seg.entry_size > 0 ? seg.entry_notional / seg.entry_size : seg.open_px;
        const realized = seg.gross_pnl - total_fees(seg);

        // what the position was worth when it was entered. The percentage denominator:
        // leverage-free, so it is available for every position, including every one
        // already closed.
        const entry_notional = seg.max_size * entry_px;

        const close_data: close_position_activity_data = {
            coin: coin,
            direction: seg.direction,
            size: dec(seg.max_size),
            entry_price: dec(entry_px),
            exit_price: dec(exit_px),
            leverage: leverage,
            tx_hash: seg.close_tx_hash,
            fees: dec(total_fees(seg)),
            realized_pnl: dec(realized),
            realized_pnl_pct: entry_notional > 0 ? (realized / entry_notional * 100).toFixed(4) : "0",
        };

        // A forced close is its own activity TYPE rather than a reason code on a close, so
        // the feed renders it differently without the client reading a flag. Hyperliquid
        // tells a market liquidation from a backstop one; both are "liquidated" to a user,
        // so both land here. A "flip" - one fill closing this position and opening the
        // opposite side - becomes an ordinary close plus its own open row, which is what it
        // actually is.
        const forced = seg.close_reason === "liquidation" || seg.close_reason === "backstop";

        rows.push({
            privy_address: owner,
            type: forced ? "liquidate-position" : "close-position",
            status: "confirmed",
            source_key: `${owner}:${coin}:${seg.close_tid}`,
            data: close_data,
            occurred_at: seg.closed_at,
        });
    }

    return rows;
};

// Rebuilds every position in one market for one user from the stored fills, then writes
// the activity rows. Full replay rather than an incremental update: a user's fills in one
// market are few, and a replay that reads the whole history can never be left in a state
// an incremental update corrupted.
export const rebuild_market = async (address: string, coin: string): Promise<{positions: number; activities: number}> => {
    const owner = address.toLowerCase();

    const rows = await db
        .select({
            tid: fills.tid,
            side: fills.side,
            sz: fills.sz,
            px: fills.px,
            start_position: fills.start_position,
            closed_pnl: fills.closed_pnl,
            fee: fills.fee,
            builder_fee: fills.builder_fee,
            liquidation_method: fills.liquidation_method,
            tx_hash: fills.tx_hash,
            filled_at: fills.filled_at,
        })
        .from(fills)
        .where(and(eq(fills.privy_address, owner), eq(fills.coin, coin)))
        .orderBy(asc(fills.filled_at), asc(fills.tid));

    const segments = replay_positions(rows);

    if (segments.length === 0) {
        return {positions: 0, activities: 0};
    }

    // Leverage per position, as observed from clearinghouseState while it was open. The
    // replay cannot derive it - a fill does not carry leverage - so it is read back here
    // and deliberately NOT written in the upsert below, which is what lets a rebuild keep
    // it instead of wiping it.
    const observed = await db
        .select({open_tid: positions.open_tid, leverage_value: positions.leverage_value})
        .from(positions)
        .where(and(eq(positions.privy_address, owner), eq(positions.coin, coin)));

    const leverage_by_open_tid = new Map(
        observed.map((row) => [row.open_tid, row.leverage_value])
    );

    for (const seg of segments) {
        const row = to_position_row(owner, coin, seg);

        await db
            .insert(positions)
            .values(row)
            .onConflictDoUpdate({
                target: [positions.privy_address, positions.coin, positions.open_tid],
                set: {
                    close_tid: row.close_tid,
                    closed_at: row.closed_at,
                    close_reason: row.close_reason,
                    entry_px: row.entry_px,
                    exit_px: row.exit_px,
                    max_size: row.max_size,
                    open_size: row.open_size,
                    gross_pnl: row.gross_pnl,
                    fees: row.fees,
                    realized_pnl: row.realized_pnl,
                    updated_at: new Date(),
                },
            });
    }

    const activity_rows = segments.flatMap((seg) =>
        to_activity_rows(owner, coin, seg, leverage_by_open_tid.get(seg.open_tid) ?? null)
    );

    // onConflictDoUpdate, not DoNothing. The replay is authoritative, so when it corrects
    // a position - a fix to fill ordering changed HYPE's realized pnl from -0.065 to
    // -0.074 - the feed row has to move with it. DoNothing left the old numbers in the
    // feed while `positions` held the right ones, which is worse than either alone.
    const written = await db
        .insert(activities)
        .values(activity_rows)
        .onConflictDoUpdate({
            target: [activities.type, activities.source_key],
            set: {
                data: sql`excluded.data`,
                occurred_at: sql`excluded.occurred_at`,
                status: sql`excluded.status`,
            },
        })
        .returning({id: activities.id});

    // The replay is AUTHORITATIVE, not additive. A rebuild after a logic fix has to be
    // able to remove rows the old logic got wrong - we shipped a phantom open position
    // once, from mis-ordered fills, and an upsert-only rebuild would have left it and its
    // activity row in the feed forever. So anything for this market that the current
    // replay did not produce is deleted.
    const valid_open_tids = segments.map((seg) => seg.open_tid);

    await db
        .delete(positions)
        .where(
            and(
                eq(positions.privy_address, owner),
                eq(positions.coin, coin),
                notInArray(positions.open_tid, valid_open_tids)
            )
        );

    const valid_keys = activity_rows.map((row) => row.source_key);

    // source_key is `<address>:<coin>:<tid>`, so the prefix scopes the delete to this
    // market. A HIP-3 coin contains a colon itself ("xyz:SP500"); the prefix still holds.
    const stale = await db
        .delete(activities)
        .where(
            and(
                eq(activities.privy_address, owner),
                inArray(activities.type, ["open-position", "close-position", "liquidate-position"]),
                like(activities.source_key, `${owner}:${coin}:%`),
                notInArray(activities.source_key, valid_keys)
            )
        )
        .returning({id: activities.id});

    if (stale.length > 0) {
        console.log(`[fills] ${owner} ${coin}: removed ${stale.length} stale activity rows`);
    }

    return {positions: segments.length, activities: written.length};
};

// --- the one entry point the stream and the cron both call ------------------

export const ingest_fills = async (
    address: string,
    incoming: hl_fill[]
): Promise<{inserted: number; positions: number; activities: number}> => {
    const {inserted, coins} = await store_fills(address, incoming);

    let position_count = 0;
    let activity_count = 0;

    for (const coin of coins) {
        const result = await rebuild_market(address, coin);
        position_count += result.positions;
        activity_count += result.activities;
    }

    return {inserted: inserted, positions: position_count, activities: activity_count};
};

// --- live snapshots ---------------------------------------------------------

// Overwrites a user's account row and their open positions with hyperliquid's current
// view. This is where unrealized pnl, leverage, liquidation price and funding come from -
// none of which exist anywhere in fill history, because a position that has not been
// closed has produced no closedPnl.
export const store_clearinghouse_state = async (
    address: string,
    state: hl_clearinghouse_state
): Promise<{open_positions: number; digest: string}> => {
    const owner = address.toLowerCase();
    const snapshot_at = new Date(state.time);
    const digest = positions_digest(state);

    const account = {
        privy_address: owner,
        account_value: state.marginSummary.accountValue,
        total_ntl_pos: state.marginSummary.totalNtlPos,
        total_raw_usd: state.marginSummary.totalRawUsd,
        total_margin_used: state.marginSummary.totalMarginUsed,
        withdrawable: state.withdrawable,
        positions_digest: digest,
        snapshot_at: snapshot_at,
        updated_at: new Date(),
    };

    await db
        .insert(hl_accounts)
        .values(account)
        .onConflictDoUpdate({target: hl_accounts.privy_address, set: account});

    const rows: new_position_snapshot[] = state.assetPositions.map((entry) => {
        const p = entry.position;
        const szi = num(p.szi);

        return {
            privy_address: owner,
            coin: p.coin,
            szi: p.szi,
            direction: szi >= 0 ? "long" : "short",
            size: dec(Math.abs(szi)),
            entry_px: p.entryPx,
            position_value: p.positionValue,
            unrealized_pnl: p.unrealizedPnl,
            liquidation_px: p.liquidationPx,
            margin_used: p.marginUsed,
            leverage_type: p.leverage.type,
            leverage_value: p.leverage.value,
            // only isolated positions carry a per-position usd figure
            max_leverage: p.maxLeverage,
            cum_funding_all_time: p.cumFunding.allTime,
            cum_funding_since_open: p.cumFunding.sinceOpen,
            cum_funding_since_change: p.cumFunding.sinceChange,
            snapshot_at: snapshot_at,
            updated_at: new Date(),
        };
    });

    const live = rows.map((row) => row.coin);

    // Positions that vanished since the last poll are gone, not stale: this table is
    // "what is open right now", so the feed never has to filter it.
    if (live.length === 0) {
        await db.delete(position_snapshots).where(eq(position_snapshots.privy_address, owner));
    } else {
        await db.delete(position_snapshots).where(
            and(eq(position_snapshots.privy_address, owner), notInArray(position_snapshots.coin, live))
        );
    }

    for (const row of rows) {
        await db
            .insert(position_snapshots)
            .values(row)
            .onConflictDoUpdate({
                target: [position_snapshots.privy_address, position_snapshots.coin],
                set: row,
            });

        // Stamp the leverage onto the OPEN position row now, while clearinghouseState
        // still reports it. The moment the position flattens it is gone from the api and
        // no fill carries it, so a position closed without this has no recoverable margin
        // and therefore no ROE - ever. This is the only window.
        await db
            .update(positions)
            .set({leverage_value: row.leverage_value, leverage_type: row.leverage_type})
            .where(
                and(
                    eq(positions.privy_address, owner),
                    eq(positions.coin, row.coin),
                    isNull(positions.closed_at)
                )
            );
    }

    return {open_positions: rows.length, digest: digest};
};
