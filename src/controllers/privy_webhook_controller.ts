import {z} from "zod"
import {Request, Response} from "express"
import {db} from "../db"
import {deposits, users} from "../db"
import {eq} from "drizzle-orm";

const depositSchema = z.object({
    type: z.literal("wallet.funds_deposited"),
    wallet_id: z.string(),
    idempotency_key: z.string().optional(),
    caip2: z.string(),
    asset: z.object({
        type: z.string(),
        address: z.string().nullable(),
    }),
    amount: z.string().regex(/^\d+$/, "amount must be base units as an integer string"),
    transaction_hash: z.string(),
    sender: z.string().optional(),
    recipient: z.string(),
    block: z
        .object({
            number: z.number(),
            timestamp: z.number(),
        })
        .optional(),
})

export const privy_webhook = async (req: Request, res: Response) => {

    const validateBody = depositSchema.safeParse(req.body)

    if (!validateBody.success) {
        console.log(`[webhook] ignoring payload:`, validateBody.error.issues);

        return res.status(200).json({
            status: "ok",
            handled: false,
        });
    }

    const {
        caip2, asset, amount, transaction_hash, sender, recipient, block, idempotency_key
    } = validateBody.data

    const [user] = await db
        .select({id: users.id})
        .from(users)
        .where(eq(users.privy_address, recipient.toLowerCase()))
        .limit(1);

    if (!user) {
        console.error(`[webhook] deposit for unknown wallet ${recipient}, tx ${transaction_hash}`);

        return res.status(200).json({
            status: "ok",
            handled: false,
        });
    }

    const [deposit] = await db
        .insert(deposits)
        .values({
            user_id: user.id,
            asset: asset.address ? asset.address.toLowerCase() : asset.type,
            chain_caip2: caip2,
            amount: amount,
            tx_hash: transaction_hash,
            sender: sender ? sender.toLowerCase() : null,
            block_number: block ? String(block.number) : null,
            idempotency_key: idempotency_key ?? transaction_hash,
        })
        .onConflictDoNothing()
        .returning();

    if (!deposit) {
        console.log(`[webhook] deposit ${transaction_hash} already recorded`);

        return res.status(200).json({
            status: "ok",
            duplicate: true,
        });
    }

    console.log(`[webhook] recorded deposit ${transaction_hash} of ${amount} for user ${user.id}`);

    return res.status(200).json({
        status: "ok",
        handled: true,
    });
}
