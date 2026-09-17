import {eq} from "drizzle-orm";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";
import {db} from "../db";
import {user, users} from "../db";
import {encrypt} from "../utils";

export interface register_user_result {
    user?: user;
    created: boolean;
}

export const register_user = async (
    privy_user_id: string,
    privy_address: string
): Promise<register_user_result> => {
    const private_key = generatePrivateKey();
    const account = privateKeyToAccount(private_key);

    const [created] = await db
        .insert(users)
        .values({
            privy_user_id: privy_user_id,
            privy_address: privy_address.toLowerCase(),
            user_private_key: encrypt(private_key),
            user_address: account.address.toLowerCase(),
        })
        .onConflictDoNothing()
        .returning();

    if (created) {
        return {user: created, created: true};
    }

    const [existing] = await db
        .select()
        .from(users)
        .where(eq(users.privy_user_id, privy_user_id))
        .limit(1);

    return {user: existing, created: false};
};
