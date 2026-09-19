import express from "express"
import {quicknode_webhook} from "../controllers/quicknode_webhook_controller";

const quicknode_webhook_router = express.Router()

quicknode_webhook_router.post("/quicknode", quicknode_webhook );

export { quicknode_webhook_router }
