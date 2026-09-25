import express from "express"
import {get_activity_feed} from "../controllers/get_activity_controller";

const get_activity_router = express.Router()

get_activity_router.get("/:privyWallet", get_activity_feed );

export { get_activity_router }
