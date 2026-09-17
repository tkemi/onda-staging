import {z} from "zod"
import {Request, Response} from "express"
import {isAddress} from "viem";
import {register_user} from "../services";

const bodySchema = z.object({
    privyWallet: z.string().refine(isAddress,{message:"Not a valid address"}),
    privyUserId : z.string().min(1),
})

export const create_wallet = async (req: Request, res: Response) => {

    const validateBody = bodySchema.safeParse(req.body)

    if (!validateBody.success) {
        return res.status(400).json({
            status: "error",
            message: validateBody.error.issues,
        });
    }

    const { privyWallet, privyUserId } = validateBody.data

    const { user } = await register_user(privyUserId, privyWallet)

    if (!user) {
        return res.status(409).json({
            status: "error",
            message: "This Privy wallet is already registered to another user",
        });
    }

    return res.status(200).json({
        status: "ok",
        address: user.user_address
    });
}
