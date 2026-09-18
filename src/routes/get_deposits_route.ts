import express from "express"
import {get_deposits} from "../controllers/get_deposits_controller";

const get_deposits_router = express.Router()

get_deposits_router.get("/:privyWalletId", get_deposits );

export { get_deposits_router }
