import express, {NextFunction, Request, Response} from "express";
import {createWriteStream} from "fs";
import {config} from "dotenv"
import {
    create_wallet_router,
    get_wallet_router,
    privy_webhook_router
} from "./routes";
import {check_db_connection, close_db} from "./db";
import {is_db_connection_error} from "./utils";

config()

const app = express();

const request_log = createWriteStream("requests.log", {flags: "a"});

app.use((request: Request, _response: Response, next: NextFunction) => {
    const svix = request.header("svix-id");
    const tag = svix ? ` svix-id=${svix}` : "";
    const line = `${new Date().toISOString()} ${request.method} ${request.originalUrl} ua=${request.header("user-agent") ?? "none"}${tag}`;
    console.log(`[req] ${line}`);
    request_log.write(line + "\n");
    next();
});

app.use(express.json());

app.use("/api/webhooks", privy_webhook_router);

app.use("/api/create-wallet", create_wallet_router);
app.use("/api/wallet", get_wallet_router);

app.use((_request: Request, response: Response) => {
    response.status(404).json({status: "error", message: "Route not found"});
});

app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    if (response.headersSent) {
        return;
    }

    if (is_db_connection_error(error)) {
        console.error(`[database unreachable] ${request.method} ${request.originalUrl}:`, error);

        return response.status(503).json({
            status: "error",
            message: "Database unavailable, please retry",
        });
    }

    console.error(`[request failed] ${request.method} ${request.originalUrl}:`, error);

    return response.status(500).json({
        status: "error",
        message: "Internal server error",
    });
});

const port = process.env.PORT || 3002;

check_db_connection()
    .then(() => {
        const server = app.listen(port, () => {
            console.log(`🚀  Running on the ${port} port.`);
        });

        const shutdown = (signal: string) => {
            console.log(`[shutdown] received ${signal}`);
            server.close(() => {
                void close_db().then(() => process.exit(0));
            });
            setTimeout(() => process.exit(1), 10_000).unref();
        };

        process.on("SIGTERM", () => shutdown("SIGTERM"));
        process.on("SIGINT", () => shutdown("SIGINT"));
    })
    .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`[startup] cannot reach the database: ${reason}`);
        process.exit(1);
    });

process.on("unhandledRejection", (reason) => {
    console.error("[unhandledRejection]", reason);
});

process.on("uncaughtException", (error) => {
    console.error("[uncaughtException]", error);
});
