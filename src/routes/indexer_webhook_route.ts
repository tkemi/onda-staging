import express from "express"
import {indexer_webhook} from "../controllers/indexer_webhook_controller";

const indexer_webhook_router = express.Router()

indexer_webhook_router.post("/", indexer_webhook );

export { indexer_webhook_router }
