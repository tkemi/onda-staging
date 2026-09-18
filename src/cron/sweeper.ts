import {and, asc, eq, inArray} from "drizzle-orm";
import {close_db, db} from "../db";
import {deposit, deposits, sweeps} from "../db";
import dotenv from "dotenv";
import {PrivyClient} from "@privy-io/node";
import {createPublicClient, encodeFunctionData, erc20Abi, http} from "viem";
import {arbitrum} from "viem/chains";
dotenv.config();

export const get_deposits = async (): Promise<deposit[]> => {
    return db
        .select()
        .from(deposits)
        .where(and(eq(deposits.is_sent, false), eq(deposits.status, "confirmed")))
        .orderBy(asc(deposits.created_at));
};

export interface grouped_deposit {
    privy_wallet_id: string;
    privy_address: string;
    deposit_ids: string[];
}

export const group_deposits = (rows: deposit[]): grouped_deposit[] => {
    const grouped = rows.reduce((acc, row) => {
        const key = row.privy_wallet_id;
        const existing = acc.get(key);

        if (existing) {
            existing.deposit_ids.push(row.id);
        } else {
            acc.set(key, {
                privy_wallet_id: row.privy_wallet_id,
                privy_address: row.privy_address,
                deposit_ids: [row.id],
            });
        }

        return acc;
    }, new Map<string, grouped_deposit>());

    return [...grouped.values()];
};

export const get_usdc_balance = async (privy_address: string): Promise<bigint> => {
    return public_client.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [privy_address as `0x${string}`],
    });
};

const privy = new PrivyClient({
    appId: process.env.PRIVY_APP_ID!,
    appSecret: process.env.PRIVY_APP_SECRET!,
});

const public_client = createPublicClient({
    chain: arbitrum,
    transport: http(process.env.ARBITRUM_RPC_URL),
});

const authorization_context = {
    authorization_private_keys: [process.env.AUTHORIZATION_KEY!],
};

const USDC: `0x${string}` = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const BRIDGE2: `0x${string}` = "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7";
const CAIP2 = "eip155:42161";
const USDC_DECIMALS = 6n;
const MIN_AMOUNT = 5n * 10n ** USDC_DECIMALS;

export const sendTx = async () => {

    const rows = await get_deposits();

    for (const group of group_deposits(rows)) {

        const balance = await get_usdc_balance(group.privy_address);

        if (balance < MIN_AMOUNT) {
            console.log(`[sweeper] skipping ${group.privy_address}: balance ${balance} under ${MIN_AMOUNT}`);

            continue;
        }

        const [sweep] = await db
            .insert(sweeps)
            .values({
                privy_wallet_id: group.privy_wallet_id,
                asset: USDC.toLowerCase(),
                chain_caip2: CAIP2,
                amount: balance.toString(),
            })
            .returning();

        try {
            const tx = await privy.wallets().ethereum().sendTransaction(group.privy_wallet_id, {
                sponsor: true,
                caip2: CAIP2,
                authorization_context: authorization_context,
                params: { transaction: {
                        to: USDC,
                        data: encodeFunctionData({
                            abi: erc20Abi, functionName: 'transfer',
                            args: [BRIDGE2, balance],
                        }),
                    }},
            });

            await db
                .update(sweeps)
                .set({tx_hash: tx.hash})
                .where(eq(sweeps.id, sweep!.id));

            const receipt = await public_client.waitForTransactionReceipt({
                hash: tx.hash as `0x${string}`,
            });

            if (receipt.status !== "success") {
                await db
                    .update(sweeps)
                    .set({status: "failed", error: "transaction reverted"})
                    .where(eq(sweeps.id, sweep!.id));

                console.error(`[sweeper] reverted for ${group.privy_wallet_id}: ${tx.hash}`);

                continue;
            }

            await db
                .update(sweeps)
                .set({status: "confirmed"})
                .where(eq(sweeps.id, sweep!.id));

            await db
                .update(deposits)
                .set({is_sent: true})
                .where(inArray(deposits.id, group.deposit_ids));

            console.log(`[sweeper] swept ${balance} for ${group.privy_wallet_id}: ${tx.hash}`);
        } catch (error: unknown) {
            const reason = error instanceof Error ? error.message : String(error);

            await db
                .update(sweeps)
                .set({status: "failed", error: reason})
                .where(eq(sweeps.id, sweep!.id));

            console.error(`[sweeper] failed for ${group.privy_wallet_id}: ${reason}`);
        }
    }
}

if (require.main === module) {
    sendTx()
        .then(() => close_db())
        .then(() => process.exit(0))
        .catch((error: unknown) => {
            console.error("[sweeper] failed:", error);
            void close_db().finally(() => process.exit(1));
        });
}