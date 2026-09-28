import {z} from "zod"
import {Request, Response} from "express"
import {timingSafeEqual} from "crypto"
import {db} from "../db"
import {activities, users, type new_activity} from "../db"
import {inArray} from "drizzle-orm";
import {get_token_metadata} from "../services";

// The token USDC withdrawals are paid in. Bridge2 only ever pays this one, and the event
// does not name a token, so the address is fixed here - but the symbol and decimals are
// still read off the contract rather than assumed.
const USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831"

// Bridge2's FinalizedWithdrawal. `user` is the hyperliquid account that withdrew, which is
// our privy wallet; `destination` is the address the user chose to receive it.
const WITHDRAW_EVENT = "FinalizedWithdrawal"

// uint64/uint256 come back as decimal strings, because the indexer serialises bigints to
// strings before they reach jsonb. Anything else in the payload we do not need.
const eventSchema = z.object({
    chain: z.string(),
    txHash: z.string(),
    logIndex: z.number().int(),
    // unix SECONDS, the block timestamp
    blockTime: z.number().int(),
    eventName: z.string().nullable(),
    args: z.object({
        user: z.string(),
        destination: z.string(),
        usd: z.string(),
    }).passthrough(),
})

const bodySchema = z.object({
    events: z.array(eventSchema),
})

// Constant-time compare, so a wrong key cannot be discovered a character at a time.
const token_matches = (given: string, expected: string): boolean => {
    const a = Buffer.from(given)
    const b = Buffer.from(expected)

    if (a.length !== b.length) {
        return false
    }

    return timingSafeEqual(a, b)
}

export const indexer_webhook = async (req: Request, res: Response) => {

    const expected = process.env.INDEXER_KEY

    if (!expected) {
        console.error("[indexer] INDEXER_KEY is not set, cannot verify delivery")

        return res.status(503).json({
            status: "error",
            message: "Webhook not configured",
        });
    }

    const given = req.header("x-indexer-key")

    if (!given || !token_matches(given, expected)) {
        console.error("[indexer] rejected delivery: bad or missing X-Indexer-Key")

        return res.status(401).json({
            status: "error",
            message: "Invalid key",
        });
    }

    const validateBody = bodySchema.safeParse(req.body)

    if (!validateBody.success) {
        console.error("[indexer] rejected delivery: unexpected payload shape")

        return res.status(400).json({
            status: "error",
            message: validateBody.error.issues,
        });
    }

    const withdrawals = validateBody.data.events.filter((event) => event.eventName === WITHDRAW_EVENT)

    if (withdrawals.length === 0) {
        // Acknowledge anyway. The forwarder holds everything behind an unacked event, so
        // refusing a delivery we simply have no use for would stall the whole queue.
        return res.status(200).json({
            status: "ok",
            recorded: 0,
        });
    }

    // Only withdrawals belonging to a wallet we know. The indexer already narrows to our
    // watchlist, but a stale watchlist entry must not become an activity for a user that
    // no longer exists - the feed is keyed by address, so an orphan row is invisible noise.
    const addresses = [...new Set(withdrawals.map((w) => w.args.user.toLowerCase()))]

    const known = await db
        .select({address: users.privy_address})
        .from(users)
        .where(inArray(users.privy_address, addresses))

    const ours = new Set(known.map((row) => row.address.toLowerCase()))

    const mine = withdrawals.filter((w) => ours.has(w.args.user.toLowerCase()))

    if (mine.length === 0) {
        console.log(`[indexer] ${withdrawals.length} withdrawals, none for our wallets`)

        return res.status(200).json({
            status: "ok",
            recorded: 0,
        });
    }

    // read before the insert, and cached per process, so a chunk costs one rpc call at most
    const token = await get_token_metadata(USDC)

    const rows: new_activity[] = mine.map((event) => ({
        privy_address: event.args.user.toLowerCase(),
        type: "withdraw-on-chain" as const,
        // FinalizedWithdrawal is emitted once the bridge has paid out, so there is no
        // pending state to model here
        status: "confirmed" as const,
        // the same key the indexer identifies the log by, so a redelivery cannot duplicate
        source_key: `${event.chain}:${event.txHash.toLowerCase()}:${event.logIndex}`,
        data: {
            // `usd` is already in the token's base units: 4000000 is 4 USDC
            amount_wei: event.args.usd,
            token_address: USDC,
            token_symbol: token.symbol,
            token_decimals: token.decimals,
            tx_hash: event.txHash.toLowerCase(),
            destination: event.args.destination.toLowerCase(),
        },
        // the block timestamp, in seconds; this is when the withdrawal actually landed
        occurred_at: new Date(event.blockTime * 1000),
    }))

    const inserted = await db
        .insert(activities)
        .values(rows)
        .onConflictDoNothing()
        .returning();

    console.log(`[indexer] recorded ${inserted.length} of ${mine.length} withdrawals`)

    return res.status(200).json({
        status: "ok",
        recorded: inserted.length,
    });
}
