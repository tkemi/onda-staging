import express from "express"
import {create_wallet} from "../controllers/create_wallet_controller";

const create_wallet_router = express.Router()

create_wallet_router.post("/", create_wallet );

export { create_wallet_router }