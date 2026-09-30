// Client for the partner's on-demand analysis APIs (Supabase edge functions): the
// futures-plan and spot-zones endpoints, plus the OAuth token endpoint that mints the
// short-lived bearer they require.
//
// Auth: client-credentials. We exchange PARTNER_API_CLIENT_ID / PARTNER_API_CLIENT_SECRET
// for an access token (~10 min lifetime) via HTTP Basic auth, cache it in memory, and
// refresh it shortly before it expires. A static PARTNER_API_TOKEN still works as an
// override for quick tests. Everything degrades gracefully: missing config -> no calls,
// logged, nothing else affected.

const TOKEN_PATH = "api-oauth-token";
const FUTURES_PATH = "api-futures-plan-v1";
const SPOT_PATH = "api-spot-zones-v1";

// refresh this many ms before the stated expiry, to avoid using a just-expired token
const EXPIRY_MARGIN_MS = 30_000;

interface credentials {
    base: string;
    client_id: string;
    client_secret: string;
}

let cached_token: {token: string; expires_at: number} | null = null;

const get_base = (): string | null =>
    process.env.PARTNER_API_BASE ? process.env.PARTNER_API_BASE.replace(/\/$/, "") : null;

const get_credentials = (): credentials | null => {
    const base = get_base();
    const client_id = process.env.PARTNER_API_CLIENT_ID;
    const client_secret = process.env.PARTNER_API_CLIENT_SECRET;

    if (!base || !client_id || !client_secret) {
        return null;
    }

    return {base, client_id, client_secret};
};

const mint_token = async (creds: credentials): Promise<string | null> => {
    const basic = Buffer.from(`${creds.client_id}:${creds.client_secret}`).toString("base64");

    try {
        const response = await fetch(`${creds.base}/${TOKEN_PATH}`, {
            method: "POST",
            headers: {
                "Authorization": `Basic ${basic}`,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: "grant_type=client_credentials",
        });

        if (!response.ok) {
            console.error(`[partner-api] token mint failed: ${response.status}`);

            return null;
        }

        const data = await response.json() as {access_token: string; expires_in: number};
        const ttl_ms = (data.expires_in ?? 600) * 1000;
        cached_token = {token: data.access_token, expires_at: Date.now() + ttl_ms - EXPIRY_MARGIN_MS};

        return data.access_token;
    } catch (error: unknown) {
        console.error("[partner-api] token mint error:", error);

        return null;
    }
};

// A valid bearer: the static override, the cached token, or a freshly-minted one.
const get_token = async (): Promise<string | null> => {
    const creds = get_credentials();

    if (!creds) {
        // no client credentials - fall back to a static token if one is set
        return process.env.PARTNER_API_TOKEN ?? null;
    }

    if (cached_token && Date.now() < cached_token.expires_at) {
        return cached_token.token;
    }

    return mint_token(creds);
};

// The status is surfaced so callers can tell "symbol not supported" (400) from "rate
// limited" (429) from a transient failure, and act accordingly. status 0 = not configured,
// -1 = network/parse error.
export interface api_result {
    ok: boolean;
    status: number;
    data: unknown | null;
}

const request = async (path: string, body: object, retry = true): Promise<api_result> => {
    const base = get_base();
    const token = await get_token();

    if (!base || !token) {
        console.warn("[partner-api] not configured (base/credentials missing), not calling");

        return {ok: false, status: 0, data: null};
    }

    try {
        const response = await fetch(`${base}/${path}`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        });

        // token may have expired mid-run: drop the cache and retry once with a fresh one
        if (response.status === 401 && retry) {
            cached_token = null;

            return request(path, body, false);
        }

        if (!response.ok) {
            return {ok: false, status: response.status, data: null};
        }

        return {ok: true, status: response.status, data: await response.json()};
    } catch (error: unknown) {
        console.error(`[partner-api] ${path} error:`, error);

        return {ok: false, status: -1, data: null};
    }
};

export const fetch_futures_plan = (symbol: string, timeframe: string): Promise<api_result> =>
    request(FUTURES_PATH, {symbol, timeframe});

export const fetch_spot_zones = (symbol: string): Promise<api_result> =>
    request(SPOT_PATH, {symbol});
