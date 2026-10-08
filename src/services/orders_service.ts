import {and, eq, inArray, sql} from "drizzle-orm";
import {
    activities,
    db,
    fills,
    type new_activity,
    type open_limit_order_activity_data,
} from "../db";
import {fetch_historical_orders, type hl_fill} from "./hl_api_service";

// Limit orders, as activity rows.
//
// There is no websocket here and none is needed. A privy server wallet has no exportable
// key, so the only way one of our users can place an order is through this backend - we
// are always the originator, and `record_limit_order` writes the row in the same request
// that places it. Instant, exact, and O(1) in users.
//
// Three things then move the row along:
//
//   advance_from_fills   a fill carrying this order's `oid` arrives -> filled_size grows,
//                        and status flips to confirmed once it is complete. The trades
//                        firehose already delivers these: a resting order that fills IS a
//                        trade, and the public message carries both counterparties.
//   record_cancellation  we cancelled it, so we know at the moment we do it
//   reconcile            hyperliquid cancelled it without us - margin, liquidation, a
//                        delisting, a scheduled cancel. The only case needing a poll.

const SOURCE_PREFIX_PARTS = 3;

// `<address>:<coin>:<oid>` - oid is unique per order, so a replay or a double delivery
// cannot create a second row. Note a HIP-3 coin contains a colon itself ("xyz:SP500"), so
// never split this on ":" expecting three parts.
const source_key_for = (address: string, coin: string, oid: string | number): string =>
    `${address.toLowerCase()}:${coin}:${oid}`;

const dec = (value: number): string =>
    isFinite(value) ? String(parseFloat(value.toPrecision(12))) : "0";

const num = (value: string | null | undefined): number => {
    const parsed = Number(value ?? "0");

    return isFinite(parsed) ? parsed : 0;
};

// --- placement ---------------------------------------------------------------

export interface limit_order_record {
    privy_address: string;
    coin: string;
    direction: "long" | "short";
    size: string;
    limit_price: string;
    oid: string | number;
    leverage?: number | null;
    reduce_only?: boolean;
    // ms epoch; defaults to now. Hyperliquid's own order timestamp when we have it.
    placed_at?: number;
}

// Call this straight after the exchange accepts the order, with the `oid` from its
// response. Writes the feed row as `pending`.
export const record_limit_order = async (order: limit_order_record): Promise<{id: number} | null> => {
    const owner = order.privy_address.toLowerCase();
    const leverage = order.leverage ?? null;
    const notional = num(order.size) * num(order.limit_price);

    const data: open_limit_order_activity_data = {
        coin: order.coin,
        direction: order.direction,
        size: order.size,
        // nothing has filled yet; the fills path grows this
        filled_size: "0",
        limit_price: order.limit_price,
        leverage: leverage,
        margin: leverage !== null && leverage > 0 ? dec(notional / leverage) : null,
        reduce_only: order.reduce_only ?? false,
        oid: String(order.oid),
        // hyperliquid returns {resting: {oid}}, not a hash - reconcile fills it in later
        tx_hash: null,
    };

    const row: new_activity = {
        privy_address: owner,
        type: "open-limit-order",
        // resting on the book, outcome unknown
        status: "pending",
        source_key: source_key_for(owner, order.coin, order.oid),
        data: data,
        occurred_at: new Date(order.placed_at ?? Date.now()),
    };

    const [written] = await db
        .insert(activities)
        .values(row)
        .onConflictDoNothing()
        .returning({id: activities.id});

    return written ?? null;
};

// --- fills move it along -----------------------------------------------------

// Given the fills just ingested for one user, advance any limit order row they belong to.
//
// The join is `oid`, which is exact - no matching on price or timestamp. filled_size is
// recomputed from the fills table rather than incremented, so a redelivered fill cannot
// double-count it.
export const advance_from_fills = async (
    address: string,
    incoming: hl_fill[]
): Promise<number> => {
    const owner = address.toLowerCase();

    // one row per (coin, oid) the fills touched
    const touched = new Map<string, {coin: string; oid: string}>();

    for (const fill of incoming) {
        const key = `${fill.coin}:${fill.oid}`;

        if (!touched.has(key)) {
            touched.set(key, {coin: fill.coin, oid: String(fill.oid)});
        }
    }

    if (touched.size === 0) {
        return 0;
    }

    const keys = [...touched.values()].map((t) => source_key_for(owner, t.coin, t.oid));

    const orders = await db
        .select({id: activities.id, source_key: activities.source_key, data: activities.data})
        .from(activities)
        .where(
            and(
                eq(activities.privy_address, owner),
                eq(activities.type, "open-limit-order"),
                inArray(activities.source_key, keys)
            )
        );

    let advanced = 0;

    for (const order of orders) {
        const data = order.data as open_limit_order_activity_data;

        // recomputed from the ledger, not incremented - idempotent under redelivery
        const [summed] = await db
            .select({filled: sql<string>`coalesce(sum(${fills.sz}), 0)`})
            .from(fills)
            .where(and(eq(fills.privy_address, owner), eq(fills.oid, data.oid)));

        const filled = num(summed?.filled);
        const size = num(data.size);
        // a hair of tolerance: sizes are decimal strings and the sum is a numeric
        const complete = size > 0 && filled >= size - 1e-9;

        await db
            .update(activities)
            .set({
                status: complete ? "confirmed" : "pending",
                data: {...data, filled_size: dec(filled)},
            })
            .where(eq(activities.id, order.id));

        advanced += 1;
    }

    return advanced;
};

// --- cancellation ------------------------------------------------------------

// We cancelled it ourselves, so no poll is needed to find out.
export const record_cancellation = async (
    address: string,
    coin: string,
    oid: string | number
): Promise<boolean> => {
    const owner = address.toLowerCase();

    const updated = await db
        .update(activities)
        .set({status: "failed"})
        .where(
            and(
                eq(activities.privy_address, owner),
                eq(activities.type, "open-limit-order"),
                eq(activities.source_key, source_key_for(owner, coin, oid)),
                // a filled order is finished; a late cancel must not undo it
                eq(activities.status, "pending")
            )
        )
        .returning({id: activities.id});

    return updated.length > 0;
};

// --- reconciliation ----------------------------------------------------------

// Statuses that mean the order is over and we did NOT cause it: margin shortfalls,
// liquidation, a delisting, a scheduled cancel, an oracle or risk rejection. These are the
// only order outcomes a poll is actually required for.
const TERMINAL_WITHOUT_US = new Set([
    "canceled",
    "rejected",
    "marginCanceled",
    "vaultWithdrawalCanceled",
    "openInterestCapCanceled",
    "selfTradeCanceled",
    "reduceOnlyCanceled",
    "siblingFilledCanceled",
    "delistedCanceled",
    "liquidatedCanceled",
    "outcomeSettledCanceled",
    "scheduledCancel",
    "internalCancel",
    "tickRejected",
    "minTradeNtlRejected",
    "perpMarginRejected",
    "reduceOnlyRejected",
    "badAloPxRejected",
    "iocCancelRejected",
    "badTriggerPxRejected",
    "marketOrderNoLiquidityRejected",
    "positionIncreaseAtOpenInterestCapRejected",
    "positionFlipAtOpenInterestCapRejected",
    "tooAggressiveAtOpenInterestCapRejected",
    "openInterestIncreaseRejected",
    "insufficientSpotBalanceRejected",
    "oracleRejected",
    "perpMaxPositionRejected",
    "tooManyOpenOrdersRejected",
]);

// Closes out any order row still `pending` that hyperliquid has already finished with.
// Costs one weight-20 request per user, so it belongs on the same cursor cadence as the
// fills sweep - never in the hot path.
export const reconcile_orders = async (address: string): Promise<{resolved: number}> => {
    const owner = address.toLowerCase();

    const pending = await db
        .select({id: activities.id, source_key: activities.source_key, data: activities.data})
        .from(activities)
        .where(
            and(
                eq(activities.privy_address, owner),
                eq(activities.type, "open-limit-order"),
                eq(activities.status, "pending")
            )
        );

    if (pending.length === 0) {
        return {resolved: 0};
    }

    const history = await fetch_historical_orders(owner);
    const by_oid = new Map(history.map((entry) => [String(entry.order.oid), entry]));

    let resolved = 0;

    for (const row of pending) {
        const data = row.data as open_limit_order_activity_data;
        const entry = by_oid.get(data.oid);

        if (!entry) {
            // not in the window hyperliquid returns; leave it alone rather than guess
            continue;
        }

        if (entry.status === "filled") {
            // the fills path owns this transition and carries filled_size with it
            continue;
        }

        if (!TERMINAL_WITHOUT_US.has(entry.status)) {
            continue;
        }

        await db
            .update(activities)
            .set({status: "failed", data: {...data, tx_hash: data.tx_hash}})
            .where(eq(activities.id, row.id));

        resolved += 1;
    }

    return {resolved: resolved};
};
