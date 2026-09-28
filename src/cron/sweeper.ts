import {and, asc, eq, inArray, lt, or, sql} from "drizzle-orm";
import {close_db, db} from "../db";
import {activities, deposit, deposits, sweeps, type new_activity} from "../db";
import dotenv from "dotenv";
import {PrivyClient} from "@privy-io/node";
import {createPublicClient, encodeFunctionData, erc20Abi, http} from "viem";
import {arbitrum} from "viem/chains";
import {get_token_metadata} from "../services";
dotenv.config();

export const MAX_DEPOSITS = 100;

// one arbitrary but stable key, so two sweeps can never run against the same database
const SWEEP_LOCK_KEY = 728411;

// a failed sweep is retried, because the balance check makes a retry safe: if the
// transfer actually went through, the wallet is empty and the retry skips it.
// the cap stops a permanently broken deposit from being retried every minute forever.
export const MAX_ATTEMPTS = 5;

export const get_deposits = async (limit = MAX_DEPOSITS): Promise<deposit[]> => {
    return db
        .select()
        .from(deposits)
        .where(and(
            eq(deposits.is_sent, false),
            or(eq(deposits.status, "pending"), eq(deposits.status, "failed")),
            lt(deposits.attempts, MAX_ATTEMPTS)
        ))
        .orderBy(asc(deposits.created_at))
        .limit(limit);
};

export interface grouped_deposit {
    privy_wallet_id: string;
    privy_address: string;
    deposit_ids: number[];
    // the rows themselves: the activity feed shows a per-deposit amount and sender,
    // which the ids alone cannot supply
    rows: deposit[];
}

export const group_deposits = (rows: deposit[]): grouped_deposit[] => {
    const grouped = rows.reduce((acc, row) => {
        const key = row.privy_wallet_id;
        const existing = acc.get(key);

        if (existing) {
            existing.deposit_ids.push(row.id);
            existing.rows.push(row);
        } else {
            acc.set(key, {
                privy_wallet_id: row.privy_wallet_id,
                privy_address: row.privy_address,
                deposit_ids: [row.id],
                rows: [row],
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

    // pg_try_advisory_lock returns immediately: either we hold the lock or someone else does.
    // it is held by this connection, so a crashed sweep releases it when the connection drops.
    const lock = await db.execute(sql`select pg_try_advisory_lock(${SWEEP_LOCK_KEY}) as locked`);
    const locked = (lock.rows[0] as {locked: boolean} | undefined)?.locked;

    if (!locked) {
        console.log("[sweeper] another sweep is already running, skipping this round");

        return;
    }

    try {
        await run_sweep();
    } finally {
        await db.execute(sql`select pg_advisory_unlock(${SWEEP_LOCK_KEY})`);
    }
};

// The feed row's status follows the sweep, because the sweep is what actually delivers
// the money: until it confirms, the deposit is sitting in an intermediate wallet.
const set_activity_status = async (deposit_ids: number[], status: "confirmed" | "failed") => {
    await db
        .update(activities)
        .set({status: status})
        .where(and(
            eq(activities.type, "deposit-on-chain"),
            // source_key is a generic text key across activity types, so a deposit's
            // numeric id is stored and matched as its string form
            inArray(activities.source_key, deposit_ids.map(String))
        ));
};

const run_sweep = async () => {

    const groups = group_deposits(await get_deposits());

    if (groups.length === 0) {
        console.log("[sweeper] nothing to sweep");

        return;
    }

    const balances = await get_usdc_balances(groups.map((group) => group.privy_address));

    // Token metadata comes from whatever the deposits actually reference, never a constant,
    // so a new token needs no change here. Resolved once per distinct address per run:
    // symbol and decimals never change for a contract.
    const assets = [...new Set(
        groups.flatMap((group) => group.rows.map((row) => row.asset.toLowerCase()))
    )];

    const token_by_address = new Map(await Promise.all(
        assets.map(async (asset) => [asset, await get_token_metadata(asset)] as const)
    ));

    console.log(`[sweeper] checking ${groups.length} wallets`);

    for (const group of groups) {

        const balance = balances.get(group.privy_address) ?? 0n;

        if (balance < MIN_AMOUNT) {
            console.log(`[sweeper] skipping ${group.privy_address}: balance ${balance} under ${MIN_AMOUNT}`);

            continue;
        }

        await db
            .update(deposits)
            .set({attempts: sql`${deposits.attempts} + 1`})
            .where(inArray(deposits.id, group.deposit_ids));

        const [sweep] = await db
            .insert(sweeps)
            .values({
                privy_wallet_id: group.privy_wallet_id,
                privy_address: group.privy_address,
                asset: USDC.toLowerCase(),
                chain_caip2: CAIP2,
                amount: balance.toString(),
            })
            .returning();

        // One feed row per deposit, not per sweep: a sweep empties the whole wallet in a
        // single transfer, so it has no one sender or amount to show. The deposit supplies
        // both, the sweep supplies the status. onConflictDoNothing keeps a retried sweep
        // from inserting a second row for the same deposit.
        const activity_rows: new_activity[] = group.rows.map((row) => {
            const token = token_by_address.get(row.asset.toLowerCase())!;

            return {
                privy_address: row.privy_address,
                type: "deposit-on-chain" as const,
                source_key: row.id.toString(),
                data: {
                    amount_wei: row.amount,
                    token_address: row.asset,
                    token_symbol: token.symbol,
                    token_decimals: token.decimals,
                    tx_hash: row.tx_hash,
                    sender: row.sender,
                },
                // when the transfer landed on chain, not when we swept it
                occurred_at: row.created_at,
            };
        });

        await db.insert(activities).values(activity_rows).onConflictDoNothing();

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

                await set_activity_status(group.deposit_ids, "failed");

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

            await set_activity_status(group.deposit_ids, "confirmed");

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

            await set_activity_status(group.deposit_ids, "failed");

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