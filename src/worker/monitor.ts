import {inArray, or, eq} from "drizzle-orm";
import {close_db, db, trade_setups, type trade_setup} from "../db";
import {evaluate_setup, fetch_all_mids, notify_setup_event, type setup_event} from "../services";
import dotenv from "dotenv";
dotenv.config();

// Long-running worker (a Procfile `worker` process, not a cron): polls Hyperliquid mids
// and advances pre-entry setups through their lifecycle, notifying on each transition.
// Polling (vs a websocket) keeps it simple and is fast enough for entry alerts; the
// interval is configurable.

const POLL_INTERVAL_MS = Number(process.env.MONITOR_INTERVAL_MS ?? 5000);

let running = true;

const load_open_setups = (): Promise<trade_setup[]> =>
    db
        .select()
        .from(trade_setups)
        .where(or(eq(trade_setups.status, "pending"), eq(trade_setups.status, "armed")));

const to_number = (value: string | null): number | null => {
    if (value === null) {
        return null;
    }

    const num = Number(value);

    return isFinite(num) ? num : null;
};

const tick = async (): Promise<void> => {
    const setups = await load_open_setups();

    if (setups.length === 0) {
        return;
    }

    const mids = await fetch_all_mids();
    const now = new Date();

    // collect status changes, applied in bulk grouped by target status
    const changes = new Map<string, number[]>();
    const notifications: Array<{setup: trade_setup; event: setup_event; price: number}> = [];

    for (const setup of setups) {
        const price = mids.get(setup.hl_symbol);
        const entry_low = to_number(setup.entry_low);
        const entry_high = to_number(setup.entry_high);

        // expiry does not need a price; everything else does
        if (entry_low === null || entry_high === null) {
            continue;
        }

        // when we have no live price, we can still expire but not evaluate levels
        if (price === undefined && !(setup.expires_at && now.getTime() > setup.expires_at.getTime())) {
            continue;
        }

        const result = evaluate_setup(
            {
                status: setup.status,
                direction: setup.direction,
                entry_low,
                entry_high,
                sl: to_number(setup.sl),
                expires_at: setup.expires_at,
            },
            price ?? entry_low, // price only unused when expiring
            now
        );

        if (result.status === setup.status && result.event === null) {
            continue;
        }

        if (result.status !== setup.status) {
            const ids = changes.get(result.status) ?? [];
            ids.push(setup.id);
            changes.set(result.status, ids);
        }

        // "armed" (approaching) is intentionally not notified - only the actual entry,
        // invalidation, and expiry are worth a message
        if (result.event && result.event !== "armed") {
            notifications.push({setup, event: result.event, price: price ?? entry_low});
        }
    }

    for (const [status, ids] of changes) {
        // stamp when the entry was first reached, for backtesting
        const extra = status === "triggered" ? {triggered_at: now} : {};

        await db
            .update(trade_setups)
            .set({status: status as trade_setup["status"], ...extra})
            .where(inArray(trade_setups.id, ids));
    }

    // notify after the status is persisted, so a crash cannot double-fire a transition
    for (const {setup, event, price} of notifications) {
        try {
            await notify_setup_event(setup, event, price);
        } catch (error: unknown) {
            console.error(`[monitor] notify failed for setup ${setup.id}:`, error);
        }
    }

    if (changes.size > 0) {
        const summary = [...changes.entries()].map(([s, ids]) => `${s}:${ids.length}`).join(" ");
        console.log(`[monitor] ${setups.length} open, transitions -> ${summary}`);
    }
};

const loop = async (): Promise<void> => {
    console.log(`[monitor] started, polling every ${POLL_INTERVAL_MS}ms`);

    while (running) {
        try {
            await tick();
        } catch (error: unknown) {
            console.error("[monitor] tick failed:", error);
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
};

const shutdown = (signal: string) => {
    console.log(`[monitor] received ${signal}, shutting down`);
    running = false;
    setTimeout(() => {
        void close_db().finally(() => process.exit(0));
    }, 200);
};

if (require.main === module) {
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    loop().catch((error: unknown) => {
        console.error("[monitor] fatal:", error);
        void close_db().finally(() => process.exit(1));
    });
}
