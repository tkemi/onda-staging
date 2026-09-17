import express from "express"
import {get_wallet} from "../controllers/get_wallet_controller";

const get_wallet_router = express.Router()

get_wallet_router.get("/:privyWallet", get_wallet );

export { get_wallet_router }
