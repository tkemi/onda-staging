import {z} from "zod"
import {Request, Response} from "express"
import {db} from "../db"
import {deposits} from "../db"
import {desc, eq} from "drizzle-orm";

const paramsSchema = z.object({
    privyWalletId: z.string().min(1),
})

export const get_deposits = async (req: Request, res: Response) => {

    const validateParams = paramsSchema.safeParse(req.params)

    if (!validateParams.success) {
        return res.status(400).json({
            status: "error",
            message: validateParams.error.issues,
        });
    }

    const { privyWalletId } = validateParams.data

    const user_deposits = await db
        .select()
        .from(deposits)
        .where(eq(deposits.privy_wallet_id, privyWalletId))
        .orderBy(desc(deposits.created_at));

    return res.status(200).json({
        status: "ok",
        deposits: user_deposits
    });
}
