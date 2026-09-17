import express from "express"
import {privy_webhook} from "../controllers/privy_webhook_controller";

const privy_webhook_router = express.Router()

privy_webhook_router.post("/privy", privy_webhook );

export { privy_webhook_router }
