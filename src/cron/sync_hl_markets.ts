import {sql} from "drizzle-orm";
import {close_db, db, hyperliquid_markets} from "../db";
import {fetch_all_hl_markets} from "../services";
import dotenv from "dotenv";
dotenv.config();

// stable advisory-lock key so two syncs can never run at once
const HL_SYNC_LOCK_KEY = 728413;

export const sync_hl_markets = async (): Promise<void> => {
    const lock = await db.execute(sql`select pg_try_advisory_lock(${HL_SYNC_LOCK_KEY}) as locked`);
    const locked = (lock.rows[0] as {locked: boolean} | undefined)?.locked;

    if (!locked) {
        console.log("[hl-markets] another sync is already running, skipping this round");

        return;
    }

    try {
        const markets = await fetch_all_hl_markets();

        // a transient API hiccup returning nothing must not wipe the table the rest of
        // the pipeline depends on
        if (markets.length === 0) {
            console.error("[hl-markets] fetched 0 markets, leaving the table untouched");

            return;
        }

        // full replace inside a transaction: readers see the old set until commit, and
        // markets Hyperliquid has dropped disappear rather than lingering as stale rows
        await db.transaction(async (tx) => {
            await tx.delete(hyperliquid_markets);
            await tx.insert(hyperliquid_markets).values(markets);
        });

        console.log(`[hl-markets] synced ${markets.length} markets`);
    } finally {
        await db.execute(sql`select pg_advisory_unlock(${HL_SYNC_LOCK_KEY})`);
    }
};

if (require.main === module) {
    sync_hl_markets()
        .then(() => close_db())
        .then(() => process.exit(0))
        .catch((error: unknown) => {
            console.error("[hl-markets] failed:", error);
            void close_db().finally(() => process.exit(1));
        });
}
