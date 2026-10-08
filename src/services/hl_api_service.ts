import {HttpTransport, InfoClient} from "@nktkas/hyperliquid";

// Read-only access to hyperliquid. No wallet, no signing: everything here is an /info
// request, which needs nothing but an address.
//
// Why the api and not an indexer: perps execute on HyperCore, which is not an evm. A
// fill is a state transition inside a block, not a transaction, so it emits no event and
// there is no contract to subscribe to - a perp trader's evm nonce stays 0 for life. The
// only two sources of fills are a hyperliquid node's own output and this api.

const INFO_TIMEOUT_MS = 10_000;

// Hyperliquid's rate limit is an aggregated WEIGHT of 1200 per minute per IP, shared by
// every rest request the whole backend makes. Weights that matter to us:
//   clearinghouseState  2   (the cheapest request on the api)
//   userFillsByTime     20  (+ more per 20 fills returned)
// We budget below the real ceiling so a burst from the firehose cannot starve the crons
// or trip a 429 for everyone.
const WEIGHT_BUDGET_PER_MIN = 1000;
export const WEIGHT_CLEARINGHOUSE_STATE = 2;
export const WEIGHT_USER_FILLS = 20;

// userFillsByTime returns at most 2000 fills per response, so a backfill pages forward
// by time. The cap stops a pathological account from looping forever.
const FILLS_PAGE_SIZE = 2000;
const MAX_FILL_PAGES = 20;

// how long the market list is trusted before it is re-read; new perps list often enough
// that a long-lived process must not cache it forever
const MARKETS_TTL_MS = 10 * 60 * 1000;

const info = new InfoClient({
    transport: new HttpTransport({timeout: INFO_TIMEOUT_MS}),
});

// --- weight budget ---------------------------------------------------------

// Spend timestamps over the trailing minute. Not a token bucket: the limit is a sliding
// window, so this mirrors it exactly rather than approximating.
const spends: {at: number; weight: number}[] = [];

const spent_in_window = (now: number): number => {
    while (spends.length > 0 && now - (spends[0]?.at ?? 0) >= 60_000) {
        spends.shift();
    }

    return spends.reduce((total, spend) => total + spend.weight, 0);
};

// Waits until `weight` fits in the budget, then claims it. Every call in this file goes
// through here, so the budget holds no matter which caller is busy - the firehose, the
// backfill cron and the nightly snapshot all share one window.
const claim_weight = async (weight: number): Promise<void> => {
    for (;;) {
        const now = Date.now();

        if (spent_in_window(now) + weight <= WEIGHT_BUDGET_PER_MIN) {
            spends.push({at: now, weight: weight});

            return;
        }

        // sleep until the oldest spend leaves the window
        const oldest = spends[0]?.at ?? now;
        const wait = Math.max(50, 60_000 - (now - oldest));

        await new Promise((resolve) => setTimeout(resolve, wait));
    }
};

export const weight_used = (): number => spent_in_window(Date.now());

// --- types we hand to the rest of the codebase -----------------------------

// The SDK's own response types, narrowed to what the pipeline uses. Imported through
// ReturnType rather than restated, so an SDK upgrade that changes a field is a compile
// error here instead of a silent null at runtime.
export type hl_fill = Awaited<ReturnType<typeof info.userFillsByTime>>[number];
export type hl_clearinghouse_state = Awaited<ReturnType<typeof info.clearinghouseState>>;
export type hl_historical_order = Awaited<ReturnType<typeof info.historicalOrders>>[number];
export type hl_asset_position = hl_clearinghouse_state["assetPositions"][number]["position"];

const as_address = (address: string): `0x${string}` => address.toLowerCase() as `0x${string}`;

// --- markets ---------------------------------------------------------------

let markets_cache: {names: string[]; at: number} | null = null;

// Every perp market currently listed, which is what the trades firehose subscribes to.
// Delisted markets are dropped: they produce no trades, and a subscription to one just
// burns one of the 1000 per-IP subscription slots.
export const get_perp_markets = async (): Promise<string[]> => {
    const now = Date.now();

    if (markets_cache && now - markets_cache.at < MARKETS_TTL_MS) {
        return markets_cache.names;
    }

    await claim_weight(WEIGHT_USER_FILLS);

    const meta = await info.meta();
    const names = meta.universe
        .filter((asset) => !asset.isDelisted)
        .map((asset) => asset.name);

    markets_cache = {names: names, at: now};

    return names;
};

// --- fills -----------------------------------------------------------------

// Every fill at or after `since_ms`, oldest first, paged.
//
// `since_ms` is INCLUSIVE on hyperliquid's side, so the newest fill we already hold comes
// back again on every call. That is deliberate: passing `last_fill_time + 1` would skip a
// second fill that shares the same millisecond, and fills in the same block routinely do.
// The duplicate is discarded by the unique index on (privy_address, tid).
export const fetch_fills_since = async (address: string, since_ms: number): Promise<hl_fill[]> => {
    const user = as_address(address);
    const collected: hl_fill[] = [];
    let start = since_ms;

    for (let page = 0; page < MAX_FILL_PAGES; page++) {
        await claim_weight(WEIGHT_USER_FILLS);

        // aggregateByTime false: we want raw fills with their own tids, because tid is
        // the idempotency key. Aggregated fills would merge tids and break dedup.
        const batch = await info.userFillsByTime({
            user: user,
            startTime: start,
            aggregateByTime: false,
        });

        collected.push(...batch);

        if (batch.length < FILLS_PAGE_SIZE) {
            break;
        }

        // page forward from the newest fill in this batch. Same inclusive-boundary logic
        // as above, so the last fill repeats and is deduped rather than risking a skip.
        const newest = batch.reduce((max, f) => (f.time > max ? f.time : max), start);

        if (newest <= start) {
            // every fill in a full page shares one millisecond; paging further would spin
            break;
        }

        start = newest;
    }

    // oldest first - the position replay depends on fill order
    return collected.sort((a, b) => (a.time - b.time) || (a.tid - b.tid));
};

// --- live account state ----------------------------------------------------

// Weight 2, the cheapest request hyperliquid serves. Returns the margin summary plus
// every open position with its unrealized pnl, leverage, liquidation price and funding -
// the numbers that exist nowhere in fill history.
export const fetch_clearinghouse_state = async (address: string): Promise<hl_clearinghouse_state> => {
    await claim_weight(WEIGHT_CLEARINGHOUSE_STATE);

    return await info.clearinghouseState({user: as_address(address)});
};

// A fingerprint of the open positions, used to tell "this user traded" from "the market
// moved" without spending a weight-20 fills request.
//
// `szi` changes ONLY on a fill. Mark price movement changes unrealizedPnl, positionValue
// and returnOnEquity, but never the size. So a digest change means a fill happened; an
// unchanged digest with a changed accountValue means funding, a transfer, or mark drift.
export const positions_digest = (state: hl_clearinghouse_state): string =>
    state.assetPositions
        .map((entry) => `${entry.position.coin}:${entry.position.szi}`)
        .sort()
        .join("|");

// --- orders ------------------------------------------------------------------

// The last orders hyperliquid still remembers for this user, each with its processing
// status. The ONLY reason to call this: finding out that hyperliquid cancelled an order
// without us - a margin shortfall, a liquidation, a delisting, a scheduled cancel. Every
// other outcome we either caused ourselves or learn from a fill, so this stays on the
// cursor cadence and never in the hot path.
//
// Capped at the 2000 most recent orders, same as fills.
export const fetch_historical_orders = async (address: string): Promise<hl_historical_order[]> => {
    await claim_weight(WEIGHT_USER_FILLS);

    return await info.historicalOrders({user: as_address(address)});
};
