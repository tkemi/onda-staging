import {Request, Response} from "express"
import {createHmac, timingSafeEqual} from "crypto"
import {db} from "../db"
import {deposits, users} from "../db"
import {inArray} from "drizzle-orm";
import {decodeEventLog, parseAbiItem} from "viem";

const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)")
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

const USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831"
const CAIP2 = "eip155:42161"

interface raw_log {
    address: string;
    topics: string[];
    data: string;
    transactionHash: string;
    blockNumber: string | number;
    logIndex: string | number;
}

const is_log = (value: any): value is raw_log =>
    value !== null &&
    typeof value === "object" &&
    Array.isArray(value.topics) &&
    typeof value.data === "string" &&
    typeof value.address === "string" &&
    typeof value.transactionHash === "string"

// the envelope shape varies by template, so walk the payload and pick out every log
export const collect_logs = (payload: unknown): raw_log[] => {
    const found: raw_log[] = []

    const walk = (value: any) => {
        if (Array.isArray(value)) {
            value.forEach(walk)

            return
        }

        if (value !== null && typeof value === "object") {
            if (is_log(value)) {
                found.push(value)

                return
            }

            Object.values(value).forEach(walk)
        }
    }

    walk(payload)

    return found
}

export const verify_signature = (
    raw_body: string,
    nonce: string,
    timestamp: string,
    signature: string
): boolean => {
    const security_token = process.env.QUICKNODE_SECURITY_TOKEN

    if (!security_token) {
        throw new Error("QUICKNODE_SECURITY_TOKEN is required")
    }

    const computed = createHmac("sha256", Buffer.from(security_token))
        .update(Buffer.from(nonce + timestamp + raw_body))
        .digest("hex")

    const given = Buffer.from(signature, "hex")
    const mine = Buffer.from(computed, "hex")

    if (given.length !== mine.length) {
        return false
    }

    return timingSafeEqual(mine, given)
}

export const quicknode_webhook = async (req: Request, res: Response) => {

    const nonce = req.header("x-qn-nonce")
    const timestamp = req.header("x-qn-timestamp")
    const signature = req.header("x-qn-signature")
    const raw_body = (req as any).rawBody as Buffer | undefined

    if (!nonce || !timestamp || !signature || !raw_body) {
        console.error("[quicknode] missing signature headers")

        return res.status(401).json({
            status: "error",
            message: "Missing signature headers",
        });
    }

    if (!verify_signature(raw_body.toString("utf8"), nonce, timestamp, signature)) {
        console.error("[quicknode] invalid signature")

        return res.status(401).json({
            status: "error",
            message: "Invalid signature",
        });
    }

    const transfers = collect_logs(req.body)
        .filter((log) =>
            log.address.toLowerCase() === USDC &&
            log.topics[0]?.toLowerCase() === TRANSFER_TOPIC
        )
        .map((log) => {
            const decoded = decodeEventLog({
                abi: [TRANSFER_EVENT],
                topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
                data: log.data as `0x${string}`,
            })

            return {
                from: decoded.args.from.toLowerCase(),
                to: decoded.args.to.toLowerCase(),
                value: decoded.args.value.toString(),
                tx_hash: log.transactionHash,
                block_number: String(Number(log.blockNumber)),
                log_index: Number(log.logIndex),
            }
        })

    if (transfers.length === 0) {
        return res.status(200).json({
            status: "ok",
            handled: 0,
        });
    }

    const owned = await db
        .select({id: users.privy_wallet_id, address: users.privy_address})
        .from(users)
        .where(inArray(users.privy_address, transfers.map((t) => t.to)));

    const wallet_by_address = new Map(owned.map((u) => [u.address, u.id]))

    const rows = transfers
        .filter((transfer) => wallet_by_address.has(transfer.to))
        .map((transfer) => ({
            privy_wallet_id: wallet_by_address.get(transfer.to)!,
            privy_address: transfer.to,
            asset: USDC,
            chain_caip2: CAIP2,
            amount: transfer.value,
            tx_hash: transfer.tx_hash,
            sender: transfer.from,
            block_number: transfer.block_number,
            idempotency_key: `${transfer.tx_hash}:${transfer.log_index}`,
            status: "pending" as const,
        }))

    if (rows.length === 0) {
        console.log(`[quicknode] ${transfers.length} transfers, none for our wallets`)

        return res.status(200).json({
            status: "ok",
            handled: 0,
        });
    }

    const inserted = await db
        .insert(deposits)
        .values(rows)
        .onConflictDoNothing()
        .returning();

    console.log(`[quicknode] recorded ${inserted.length} of ${rows.length} deposits`)

    return res.status(200).json({
        status: "ok",
        handled: inserted.length,
    });
}
