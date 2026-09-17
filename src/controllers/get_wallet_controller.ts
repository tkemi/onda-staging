import {z} from "zod"
import {Request, Response} from "express"
import {db} from "../db"
import {users} from "../db/schema"
import {eq} from "drizzle-orm";
import {isAddress} from "viem";

const paramsSchema = z.object({
    privyWallet: z.string().refine(isAddress,{message:"Not a valid address"}),
})

export const get_wallet = async (req: Request, res: Response) => {

    const validateParams = paramsSchema.safeParse(req.params)

    if (!validateParams.success) {
        return res.status(400).json({
            status: "error",
            message: validateParams.error.issues,
        });
    }

    const { privyWallet } = validateParams.data

    const [user] = await db
        .select({user_address: users.user_address})
        .from(users)
        .where(eq(users.privy_address, privyWallet.toLowerCase()))
        .limit(1);

    if (!user) {
        return res.status(404).json({
            status: "error",
            message: "No wallet registered for this Privy wallet",
        });
    }

    return res.status(200).json({
        status: "ok",
        address: user.user_address
    });
}
