import type {new_hyperliquid_market} from "../db";

// Hyperliquid's public market metadata. No auth needed for the info endpoint.
const INFO_URL = "https://api.hyperliquid.xyz/info";

// index 0 is always USDC in spotMeta; we only care about USDC-quoted spot pairs since
// that is what our users trade.
const USDC_TOKEN_INDEX = 0;

interface perp_asset {
    name: string;
    szDecimals?: number;
    maxLeverage?: number;
    isDelisted?: boolean;
}

interface spot_token {
    name: string;
    index: number;
    szDecimals?: number;
}

interface spot_pair {
    name: string;
    tokens: [number, number];
    index: number;
}

const post_info = async <T>(body: object): Promise<T> => {
    const response = await fetch(INFO_URL, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        throw new Error(`[hyperliquid] info ${JSON.stringify(body)} failed: ${response.status}`);
    }

    return response.json() as Promise<T>;
};

export const fetch_perp_markets = async (): Promise<new_hyperliquid_market[]> => {
    const data = await post_info<{universe?: perp_asset[]}>({type: "meta"});

    return (data.universe ?? []).map((asset) => ({
        kind: "perp" as const,
        base_coin: asset.name,
        hl_symbol: asset.name,
        sz_decimals: asset.szDecimals ?? null,
        max_leverage: asset.maxLeverage ?? null,
        is_delisted: asset.isDelisted === true,
    }));
};

export const fetch_spot_markets = async (): Promise<new_hyperliquid_market[]> => {
    const data = await post_info<{tokens?: spot_token[]; universe?: spot_pair[]}>({type: "spotMeta"});

    const token_by_index = new Map((data.tokens ?? []).map((token) => [token.index, token]));

    return (data.universe ?? [])
        // USDC-quoted pairs only
        .filter((pair) => Array.isArray(pair.tokens) && pair.tokens[1] === USDC_TOKEN_INDEX)
        .map((pair) => {
            const base = token_by_index.get(pair.tokens[0]);

            return {
                kind: "spot" as const,
                // fall back to the pair name if the base token cannot be resolved
                base_coin: base?.name ?? pair.name,
                hl_symbol: pair.name,
                sz_decimals: base?.szDecimals ?? null,
                max_leverage: null,
                is_delisted: false,
            };
        });
};

export const fetch_all_hl_markets = async (): Promise<new_hyperliquid_market[]> => {
    const [perps, spot] = await Promise.all([fetch_perp_markets(), fetch_spot_markets()]);

    return [...perps, ...spot];
};

// Current mid price for every perp, keyed by coin name (BTC, kPEPE, ...). Used by the
// monitor to compare live price against setup entry/stop levels.
export const fetch_all_mids = async (): Promise<Map<string, number>> => {
    const data = await post_info<Record<string, string>>({type: "allMids"});
    const mids = new Map<string, number>();

    for (const [coin, mid] of Object.entries(data)) {
        const value = Number(mid);

        if (isFinite(value)) {
            mids.set(coin, value);
        }
    }

    return mids;
};
