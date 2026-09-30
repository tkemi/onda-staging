import {eq} from "drizzle-orm";
import {db, user_trade_settings, type new_user_trade_setting, type user_trade_setting} from "../db";
import {DEFAULT_SETTINGS, type user_settings} from "./policy";

// Read a user's trade settings, falling back to the shared defaults when they have never
// opened the settings screen. Returns the plain policy shape the policy layer expects.
export const get_user_settings = async (user_id: string): Promise<user_settings> => {
    const [row] = await db
        .select()
        .from(user_trade_settings)
        .where(eq(user_trade_settings.user_id, user_id))
        .limit(1);

    if (!row) {
        return DEFAULT_SETTINGS;
    }

    return {
        exit_style: row.exit_style,
        entry_style: row.entry_style,
        move_to_breakeven: row.move_to_breakeven,
        trailing_enabled: row.trailing_enabled,
        trailing_pct: row.trailing_pct !== null ? Number(row.trailing_pct) : null,
    };
};

// Upsert a user's settings. Only the provided fields change.
export const save_user_settings = async (
    user_id: string,
    patch: Partial<Omit<new_user_trade_setting, "user_id" | "created_at" | "updated_at">>
): Promise<user_trade_setting> => {
    const now = new Date();
    const values: new_user_trade_setting = {user_id, ...patch, updated_at: now};

    const [row] = await db
        .insert(user_trade_settings)
        .values(values)
        .onConflictDoUpdate({
            target: user_trade_settings.user_id,
            set: {...patch, updated_at: now},
        })
        .returning();

    return row!;
};
