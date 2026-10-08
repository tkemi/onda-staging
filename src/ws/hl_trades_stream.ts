import {SubscriptionClient, WebSocketTransport} from "@nktkas/hyperliquid";
import {db, users} from "../db";
import {
    addresses_with_cursors,
    addresses_with_open_positions,
    get_perp_markets,
    sync_state,
    sync_user,
} from "../services";

// The fast path: hyperliquid's PUBLIC trades feed, filtered against our own addresses.
//
// Why this and not a subscription per user. Every public trade carries
// `users: [buyer, seller]`, so one subscription per MARKET sees every trade our users
// make. That is ~180 subscriptions no matter how many users we have - 50 or 50,000 cost
// the same, and a registered user who never trades costs nothing at all. A subscription
// per user would instead be capped by hyperliquid's 1000-subscriptions-per-IP limit and
// would grow with the user base.
//
// Measured on mainnet: 178 markets, ~24 messages/sec, ~208 trades/sec, ~57 KB/sec,
// ~5 GB/day. One connection.
//
// What this feed does NOT carry is the private half of a fill - closedPnl, fee,
// startPosition, dir, liquidation. So a match here is a TRIGGER: it tells us which user
// traded, and `sync_user` then fetches that one user's fills. End to end that is roughly
// two seconds.
//
// And what it cannot do is replay. Unlike the per-user userFills subscription, the trades
// channel sends no snapshot on reconnect, so a gap is a silent gap. That is what the
// backfill cron is for, and why a reconnect here schedules a recovery sweep.

const STALL_MS = 15_000;
const WATCHDOG_MS = 5_000;
const ADDRESS_REFRESH_MS = 60_000;
const MARKET_REFRESH_MS = 15 * 60 * 1000;

// Trades by one user arrive as separate fills - a TWAP or a large market order can be
// dozens. Waiting a moment collapses the burst into a single fills request instead of one
// per fill, which is the difference between 1 and 50 weight-20 calls.
const DEBOUNCE_MS = 1_500;

// Cap on users being synced at once, so a busy market cannot open hundreds of concurrent
// requests and blow through the shared weight budget in one go.
const MAX_CONCURRENT_SYNCS = 4;

// The event type, taken from the SDK rather than restated, so an upgrade that changes
// the trade shape is a compile error here instead of a silent undefined at runtime.
type trades_listener = Parameters<SubscriptionClient["trades"]>[1];
type trades_event = Parameters<trades_listener>[0];

let ours = new Set<string>();
let transport: WebSocketTransport | null = null;
let client: SubscriptionClient | null = null;
let last_message_at = 0;
let watchdog: NodeJS.Timeout | null = null;
let address_timer: NodeJS.Timeout | null = null;
let market_timer: NodeJS.Timeout | null = null;
let restarting = false;
let connections = 0;

const pending = new Map<string, NodeJS.Timeout>();
const in_flight = new Set<string>();
const queue: string[] = [];

// --- the address set --------------------------------------------------------

const refresh_addresses = async (): Promise<void> => {
    const rows = await db.select({privy_address: users.privy_address}).from(users);
    const next = new Set(rows.map((row) => row.privy_address.toLowerCase()));

    if (next.size !== ours.size) {
        console.log(`[hl-stream] watching ${next.size} addresses`);
    }

    ours = next;
};

// --- the sync queue ---------------------------------------------------------

const drain = (): void => {
    while (in_flight.size < MAX_CONCURRENT_SYNCS && queue.length > 0) {
        const address = queue.shift();

        if (!address || in_flight.has(address)) {
            continue;
        }

        in_flight.add(address);

        // Fire and forget by design: a failed sync must not stall the socket, and the
        // backfill cron will retry the same user from the same cursor regardless.
        void sync_user(address)
            .then((result) => {
                if (result.inserted > 0) {
                    console.log(
                        `[hl-stream] ${address}: +${result.inserted} fills, ` +
                        `${result.positions} positions, ${result.activities} activities`
                    );

                    // refresh unrealized pnl / leverage right away, so the position
                    // snapshot matches the activity row the user just received
                    return sync_state(address).then(() => undefined);
                }

                return undefined;
            })
            .catch((error: unknown) => {
                console.error(`[hl-stream] sync failed for ${address}:`, error);
            })
            .finally(() => {
                in_flight.delete(address);
                drain();
            });
    }
};

const schedule_sync = (address: string): void => {
    const existing = pending.get(address);

    if (existing) {
        clearTimeout(existing);
    }

    pending.set(
        address,
        setTimeout(() => {
            pending.delete(address);

            if (!queue.includes(address)) {
                queue.push(address);
            }

            drain();
        }, DEBOUNCE_MS)
    );
};

// --- gap recovery -----------------------------------------------------------

// Called on every reconnect after the first. We know the stream was down but not who
// traded while it was, so re-check the users whose state can actually change - anyone
// with an open position - and let the cron sweep the rest on its normal schedule.
const recover_gap = async (down_for_ms: number, cold_start: boolean): Promise<void> => {
    // On a reconnect, the users whose state can have changed are the ones holding
    // something. On a COLD start we do not know how long the process was down - a deploy,
    // a crash - so everyone who has ever traded is re-checked once. There is no cron
    // behind this any more; if it is skipped, the gap is never closed.
    const candidates = cold_start
        ? await addresses_with_cursors()
        : await addresses_with_open_positions();

    const mine = candidates.filter((address) => ours.has(address));

    console.log(
        cold_start
            ? `[hl-stream] cold start - re-checking ${mine.length} addresses that have traded before`
            : `[hl-stream] gap of ${Math.round(down_for_ms / 1000)}s - recovering ${mine.length} addresses with open positions`
    );

    for (const address of mine) {
        if (!queue.includes(address)) {
            queue.push(address);
        }
    }

    drain();
};

// --- the stream -------------------------------------------------------------

const on_trades = (trades: trades_event): void => {
    last_message_at = Date.now();

    for (const trade of trades) {
        // A trade has two counterparties and either, neither, or both can be ours. Note
        // the other side is frequently a system account - hyperliquid's own HIP-2 spot
        // market maker, the backstop liquidator - so nothing here may be treated as a
        // user of ours unless it is in the set.
        for (const party of trade.users) {
            const address = party.toLowerCase();

            if (ours.has(address)) {
                schedule_sync(address);
            }
        }
    }
};

const stop_timers = (): void => {
    if (watchdog) {
        clearInterval(watchdog);
        watchdog = null;
    }
};

const start = async (): Promise<void> => {
    const markets = await get_perp_markets();

    // autoResubscribe re-establishes every subscription after a drop, so the ordinary
    // reconnect needs no help from us. The watchdog below is for the failure the library
    // cannot see: a half-open socket that never errors and never closes.
    transport = new WebSocketTransport({
        // the library's own ping/pong watchdog and reconnect policy; `resubscribe`
        // re-establishes all 178 subscriptions after a drop without us tracking them
        resubscribe: true,
        keepAlive: {interval: 20_000},
        reconnect: {maxRetries: Infinity, reconnectionDelay: (attempt) => Math.min(30_000, 500 * 2 ** attempt)},
    });

    client = new SubscriptionClient({transport: transport});

    await Promise.all(
        markets.map((coin) =>
            client!.trades({coin: coin}, on_trades)
        )
    );

    connections += 1;
    last_message_at = Date.now();

    console.log(`[hl-stream] connected (#${connections}), ${markets.length} markets, ${ours.size} addresses`);

    stop_timers();

    // A feed doing ~200 trades/sec is self-monitoring: silence is a fault, not a quiet
    // market. Detecting it in seconds is the whole reason this is cheaper to trust than a
    // per-user subscription, where an idle user looks exactly like a dead socket.
    watchdog = setInterval(() => {
        const quiet = Date.now() - last_message_at;

        if (quiet > STALL_MS) {
            console.warn(`[hl-stream] no data for ${Math.round(quiet / 1000)}s - restarting`);
            void restart();
        }
    }, WATCHDOG_MS);
};

const restart = async (): Promise<void> => {
    if (restarting) {
        return;
    }

    restarting = true;
    const down_since = last_message_at;

    try {
        stop_timers();

        try {
            await transport?.close();
        } catch {
            // already gone; nothing to do
        }

        transport = null;
        client = null;

        await start();
        await recover_gap(Date.now() - down_since, false);
    } catch (error: unknown) {
        console.error("[hl-stream] restart failed, retrying in 5s:", error);
        setTimeout(() => void restart(), 5_000);
    } finally {
        restarting = false;
    }
};

export const start_hl_trades_stream = async (): Promise<void> => {
    await refresh_addresses();
    await start();

    // A deploy or a crash is a gap nothing else closes - the cron that used to sweep is
    // gone - so catch up once on boot before settling into the live feed.
    await recover_gap(0, true).catch((error: unknown) => {
        console.error("[hl-stream] cold-start recovery failed:", error);
    });

    // new users must start being watched without a redeploy
    address_timer = setInterval(() => {
        void refresh_addresses().catch((error: unknown) => {
            console.error("[hl-stream] address refresh failed:", error);
        });
    }, ADDRESS_REFRESH_MS);

    // new markets list often enough that a long-lived process has to re-subscribe
    market_timer = setInterval(() => {
        void (async () => {
            const markets = await get_perp_markets();

            if (!client) {
                return;
            }

            await Promise.all(
                markets.map((coin) =>
                    client!.trades({coin: coin}, on_trades)
                )
            );
        })().catch((error: unknown) => {
            console.error("[hl-stream] market refresh failed:", error);
        });
    }, MARKET_REFRESH_MS);
};

export const stop_hl_trades_stream = async (): Promise<void> => {
    stop_timers();

    if (address_timer) {
        clearInterval(address_timer);
        address_timer = null;
    }

    if (market_timer) {
        clearInterval(market_timer);
        market_timer = null;
    }

    for (const timer of pending.values()) {
        clearTimeout(timer);
    }

    pending.clear();

    try {
        await transport?.close();
    } catch {
        // already closed
    }

    transport = null;
    client = null;
};
