import {setMaxListeners} from "events";
import {config} from "dotenv";
import {WebSocket as ws_impl} from "ws";
import {check_db_connection, close_db} from "./db";
import {start_hl_trades_stream, stop_hl_trades_stream} from "./ws/hl_trades_stream";

config();

// The hyperliquid sdk reaches for a global WebSocket, which only exists from node 22.
// `engines` already pins >=22.12 (the version where `require()` of an ESM package also
// became unflagged, which the sdk needs too), so production is fine - but a dev on an
// older node gets "No WebSocket implementation found" at startup instead of anything
// useful. `ws` is already a dependency for the trading-analysis socket, so borrowing it
// here costs nothing and makes the process runtime-agnostic.
// This process opens one subscription per perp market - ~180 of them - and each one
// attaches a listener to shared event targets inside the sdk (the message dispatcher, and
// an AbortSignal). Node warns past 10 listeners, so without this every start prints a
// MaxListenersExceededWarning that reads like a leak and is not one: the listeners ARE the
// subscriptions and they are released with the transport. Raised at the entrypoint rather
// than by reaching into the sdk's private fields, which would break on an upgrade. Safe to
// do process-wide here because this process does nothing else.
setMaxListeners(256);

if (typeof globalThis.WebSocket === "undefined") {
    (globalThis as {WebSocket?: unknown}).WebSocket = ws_impl;
    console.log("[hl-stream] polyfilled global WebSocket from `ws` (node < 22)");
}

// Its own process type on purpose, not part of `web`.
//
// A web deploy restarts the web dyno, and the trades feed has no replay - every restart
// is a gap the backfill cron then has to close. Running it separately means shipping an
// api change does not interrupt ingestion, and the feed only goes down when its own code
// changes.
//
// Running two of these is safe and is the cheap way to survive a single failure: both see
// the same trades, and every write is keyed on hyperliquid's own ids, so the duplicate
// delivery is a no-op insert. Hyperliquid allows 10 connections and 1000 subscriptions per
// IP, and one instance uses 178.

check_db_connection()
    .then(async () => {
        await start_hl_trades_stream();

        const shutdown = (signal: string) => {
            console.log(`[hl-stream] received ${signal}, shutting down`);

            void stop_hl_trades_stream()
                .then(() => close_db())
                .then(() => process.exit(0))
                .catch(() => process.exit(1));

            setTimeout(() => process.exit(1), 10_000).unref();
        };

        process.on("SIGTERM", () => shutdown("SIGTERM"));
        process.on("SIGINT", () => shutdown("SIGINT"));
    })
    .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`[hl-stream] startup failed: ${reason}`);
        process.exit(1);
    });

process.on("unhandledRejection", (reason) => {
    console.error("[hl-stream] unhandledRejection", reason);
});

process.on("uncaughtException", (error) => {
    console.error("[hl-stream] uncaughtException", error);
});
