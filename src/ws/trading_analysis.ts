import type {IncomingMessage, Server} from "http";
import type {Duplex} from "stream";
import {WebSocket, WebSocketServer, type RawData} from "ws";
import {db, trading_analysis, type new_trading_analysis_message} from "../db";

// Path partners connect to, e.g. wss://<host>/ws/trading-analysis?token=...
const WS_PATH = "/ws/trading-analysis";

// How often we ping idle clients; a client that misses a round trip is dropped.
const HEARTBEAT_MS = 30_000;

// Shared tokens partners authenticate with. Format: "partner_a:tokenA,partner_b:tokenB".
// A bare token with no partner name is also accepted and labelled "unknown".
const load_partner_tokens = (): Map<string, string> => {
    const raw = process.env.TRADING_ANALYSIS_STREAM_TOKEN ?? "";
    const by_token = new Map<string, string>();

    for (const entry of raw.split(",")) {
        const trimmed = entry.trim();

        if (!trimmed) {
            continue;
        }

        const parts = trimmed.split(":");

        if (parts.length >= 2) {
            const partner = (parts[0] ?? "").trim();
            const token = (parts[1] ?? "").trim();

            if (token) {
                by_token.set(token, partner || "unknown");
            }
        } else {
            by_token.set(trimmed, "unknown");
        }
    }

    return by_token;
};

// Pull the token from either ?token=... or an Authorization: Bearer <token> header.
const extract_token = (request: IncomingMessage): string | null => {
    try {
        const url = new URL(request.url ?? "", "http://localhost");
        const query_token = url.searchParams.get("token");

        if (query_token) {
            return query_token;
        }
    } catch {
        // malformed URL, fall through to the header
    }

    const auth = request.headers["authorization"];

    if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
        return auth.slice(7).trim();
    }

    return null;
};

// The single place processing lives. Today it only records the delivery; once we
// have seen real data, add parsing / validation / downstream writes here.
const process_trading_analysis = async (partner: string, raw: string): Promise<void> => {
    let payload: unknown = null;

    try {
        payload = JSON.parse(raw);
    } catch {
        // not JSON (yet) — keep the raw text, leave payload null
    }

    const row: new_trading_analysis_message = {
        partner,
        payload: payload as new_trading_analysis_message["payload"],
        raw,
    };

    await db.insert(trading_analysis).values(row);
};

interface live_socket extends WebSocket {
    is_alive: boolean;
    partner: string;
}

export const attach_trading_analysis_stream = (server: Server): WebSocketServer => {
    const partner_tokens = load_partner_tokens();

    if (partner_tokens.size === 0) {
        console.warn(
            "[ws] TRADING_ANALYSIS_STREAM_TOKEN is not set — the trading-analysis socket will reject every connection"
        );
    }

    // noServer so we can authenticate during the HTTP upgrade, before accepting.
    const wss = new WebSocketServer({noServer: true});

    server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        let pathname = "";

        try {
            pathname = new URL(request.url ?? "", "http://localhost").pathname;
        } catch {
            pathname = "";
        }

        // let other upgrade handlers (if any) deal with paths that are not ours
        if (pathname !== WS_PATH) {
            return;
        }

        const token = extract_token(request);
        const partner = token ? partner_tokens.get(token) : undefined;

        if (!partner) {
            console.warn(`[ws] rejected unauthenticated upgrade from ${request.socket.remoteAddress}`);
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();

            return;
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
            (ws as live_socket).partner = partner;
            wss.emit("connection", ws, request);
        });
    });

    wss.on("connection", (raw_ws: WebSocket) => {
        const ws = raw_ws as live_socket;
        ws.is_alive = true;

        console.log(`[ws] ${ws.partner} connected to trading-analysis`);
        ws.send(JSON.stringify({type: "connected", partner: ws.partner}));

        ws.on("pong", () => {
            ws.is_alive = true;
        });

        ws.on("message", (data: RawData, is_binary: boolean) => {
            const raw = is_binary ? data.toString("base64") : data.toString("utf8");

            void process_trading_analysis(ws.partner, raw)
                .then(() => {
                    ws.send(JSON.stringify({type: "ack"}));
                })
                .catch((error: unknown) => {
                    // never let a storage failure kill the socket — log and tell the sender
                    console.error(`[ws] failed to store message from ${ws.partner}:`, error);

                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({type: "error", message: "could not store message"}));
                    }
                });
        });

        ws.on("close", () => {
            console.log(`[ws] ${ws.partner} disconnected from trading-analysis`);
        });

        ws.on("error", (error: Error) => {
            console.error(`[ws] socket error for ${ws.partner}:`, error.message);
        });
    });

    // drop clients that stopped answering pings so they do not leak
    const heartbeat = setInterval(() => {
        for (const client of wss.clients) {
            const ws = client as live_socket;

            if (!ws.is_alive) {
                ws.terminate();

                continue;
            }

            ws.is_alive = false;
            ws.ping();
        }
    }, HEARTBEAT_MS);

    wss.on("close", () => {
        clearInterval(heartbeat);
    });

    console.log(`[ws] trading-analysis socket listening on ${WS_PATH}`);

    return wss;
};
