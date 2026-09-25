import {z} from "zod"
import {Request, Response} from "express"
import {isAddress} from "viem";
import {activity_type_names, get_activity} from "../services";

const paramsSchema = z.object({
    privyWallet: z.string().refine(isAddress,{message:"Not a valid address"}),
})

const querySchema = z.object({
    // ?type=deposit - validated against the enum, so an unknown type is a 400 rather
    // than a query that quietly matches nothing
    type: z.enum(activity_type_names).optional(),
})

export const get_activity_feed = async (req: Request, res: Response) => {

    const validateParams = paramsSchema.safeParse(req.params)

    if (!validateParams.success) {
        return res.status(400).json({
            status: "error",
            message: validateParams.error.issues,
        });
    }

    const validateQuery = querySchema.safeParse(req.query)

    if (!validateQuery.success) {
        return res.status(400).json({
            status: "error",
            message: validateQuery.error.issues,
        });
    }

    const { privyWallet } = validateParams.data
    const { type } = validateQuery.data

    const activities = await get_activity(privyWallet, {type: type})

    return res.status(200).json({
        status: "ok",
        activities: activities,
    });
}
