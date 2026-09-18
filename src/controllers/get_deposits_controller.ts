import {z} from "zod"
import {Request, Response} from "express"
import {db} from "../db"
import {deposits} from "../db"
import {desc, eq} from "drizzle-orm";
import {isAddress} from "viem";

const paramsSchema = z.object({
    privyWallet: z.string().refine(isAddress,{message:"Not a valid address"}),
})

export const get_deposits = async (req: Request, res: Response) => {

    const validateParams = paramsSchema.safeParse(req.params)

    if (!validateParams.success) {
        return res.status(400).json({
            status: "error",
            message: validateParams.error.issues,
        });
    }

    const { privyWallet } = validateParams.data

    const user_deposits = await db
        .select({
            id: deposits.id,
            privy_wallet_id: deposits.privy_wallet_id,
            privy_address: deposits.privy_address,
            amount: deposits.amount,
            tx_hash: deposits.tx_hash,
            sender: deposits.sender,
            status: deposits.status,
        })
        .from(deposits)
        .where(eq(deposits.privy_address, privyWallet.toLowerCase()))
        .orderBy(desc(deposits.created_at));

    return res.status(200).json({
        status: "ok",
        deposits: user_deposits
    });
}
