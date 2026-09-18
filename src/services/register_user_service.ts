import {eq} from "drizzle-orm";
import {db} from "../db";
import {user, users} from "../db";

export interface register_user_result {
    user?: user;
    created: boolean;
}

export const register_user = async (
    privy_user_id: string,
    privy_address: string,
    privy_wallet_id: string
): Promise<register_user_result> => {
    const [created] = await db
        .insert(users)
        .values({
            id: privy_user_id,
            privy_wallet_id: privy_wallet_id,
            privy_address: privy_address.toLowerCase(),
        })
        .onConflictDoNothing()
        .returning();

    if (created) {
        return {user: created, created: true};
    }

    const [existing] = await db
        .select()
        .from(users)
        .where(eq(users.id, privy_user_id))
        .limit(1);

    return {user: existing, created: false};
};
