import {close_db, db} from "../db";
import {users} from "../db";
import {add_watched_addresses, get_watched_addresses} from "../services";
import dotenv from "dotenv";
dotenv.config();

export const sync_wallets = async (): Promise<void> => {
    const rows = await db.select({privy_address: users.privy_address}).from(users);
    const ours = rows.map((row) => row.privy_address.toLowerCase());

    if (ours.length === 0) {
        console.log("[sync] no users to watch");

        return;
    }

    const watched = new Set(await get_watched_addresses());
    const missing = ours.filter((address) => !watched.has(address));

    if (missing.length === 0) {
        console.log(`[sync] all ${ours.length} addresses already watched`);

        return;
    }

    const added = await add_watched_addresses(missing);

    console.log(`[sync] added ${added} of ${ours.length} addresses to the watch list`);
};

if (require.main === module) {
    sync_wallets()
        .then(() => close_db())
        .then(() => process.exit(0))
        .catch((error: unknown) => {
            console.error("[sync] failed:", error);
            void close_db().finally(() => process.exit(1));
        });
}
