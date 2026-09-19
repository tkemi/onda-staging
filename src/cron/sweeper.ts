import {and, asc, eq, inArray} from "drizzle-orm";
import {close_db, db} from "../db";
import {deposit, deposits, sweeps} from "../db";
import dotenv from "dotenv";
import {PrivyClient} from "@privy-io/node";
import {createPublicClient, encodeFunctionData, erc20Abi, http} from "viem";
import {arbitrum} from "viem/chains";
dotenv.config();

export const MAX_DEPOSITS = 100;

export const get_deposits = async (limit = MAX_DEPOSITS): Promise<deposit[]> => {
    return db
        .select()
        .from(deposits)
        .where(and(eq(deposits.is_sent, false), eq(deposits.status, "pending")))
        .orderBy(asc(deposits.created_at))
        .limit(limit);
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

const TERMINAL_OK = ["confirmed", "finalized"];
const TERMINAL_BAD = ["execution_reverted", "failed", "provider_error", "replaced"];

export interface tx_outcome {
    ok: boolean;
    hash: string | null;
    status: string;
}

export const wait_for_tx = async (transaction_id: string): Promise<tx_outcome> => {
    const deadline = Date.now() + 180_000;

    while (Date.now() < deadline) {
        const transaction = await privy.transactions().get(transaction_id);

        if (TERMINAL_OK.includes(transaction.status)) {
            return {ok: true, hash: transaction.transaction_hash, status: transaction.status};
        }

        if (TERMINAL_BAD.includes(transaction.status)) {
            return {ok: false, hash: transaction.transaction_hash, status: transaction.status};
        }

        await new Promise((resolve) => setTimeout(resolve, 3_000));
    }

    return {ok: false, hash: null, status: "timeout"};
};

export const get_usdc_balances = async (addresses: string[]): Promise<Map<string, bigint>> => {
    if (addresses.length === 0) {
        return new Map();
    }

    const results = await public_client.multicall({
        contracts: addresses.map((address) => ({
            address: USDC,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address as `0x${string}`],
        })),
    });

    return new Map(addresses.map((address, i) => {
        const result = results[i];

        if (!result || result.status !== "success") {
            console.error(`[sweeper] balance read failed for ${address}`);

            return [address, 0n] as const;
        }

        return [address, result.result as bigint] as const;
    }));
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

    const groups = group_deposits(await get_deposits());

    if (groups.length === 0) {
        console.log("[sweeper] nothing to sweep");

        return;
    }

    const balances = await get_usdc_balances(groups.map((group) => group.privy_address));

    console.log(`[sweeper] checking ${groups.length} wallets`);

    for (const group of groups) {

        const balance = balances.get(group.privy_address) ?? 0n;

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
                .set({privy_transaction_id: tx.transaction_id ?? null, tx_hash: tx.hash || null})
                .where(eq(sweeps.id, sweep!.id));

            if (!tx.transaction_id) {
                throw new Error(`privy returned no transaction_id (hash "${tx.hash}")`);
            }

            const outcome = await wait_for_tx(tx.transaction_id);

            if (!outcome.ok) {
                await db
                    .update(sweeps)
                    .set({status: "failed", tx_hash: outcome.hash, error: `privy status: ${outcome.status}`})
                    .where(eq(sweeps.id, sweep!.id));

                await db
                    .update(deposits)
                    .set({status: "failed"})
                    .where(inArray(deposits.id, group.deposit_ids));

                console.error(`[sweeper] ${outcome.status} for ${group.privy_wallet_id}: ${outcome.hash}`);

                continue;
            }

            await db
                .update(sweeps)
                .set({status: "confirmed", tx_hash: outcome.hash})
                .where(eq(sweeps.id, sweep!.id));

            await db
                .update(deposits)
                .set({is_sent: true, status: "confirmed"})
                .where(inArray(deposits.id, group.deposit_ids));

            console.log(`[sweeper] swept ${balance} for ${group.privy_wallet_id}: ${outcome.hash}`);
        } catch (error: unknown) {
            const reason = error instanceof Error ? error.message : String(error);

            await db
                .update(sweeps)
                .set({status: "failed", error: reason})
                .where(eq(sweeps.id, sweep!.id));

            await db
                .update(deposits)
                .set({status: "failed"})
                .where(inArray(deposits.id, group.deposit_ids));

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