import type {candle} from "./backtest_sim";

// Historical OHLC candles from Hyperliquid's candleSnapshot endpoint, with paging (the API
// caps each response at ~5000 candles) and a small in-memory cache so a backtest re-run does
// not refetch the same coin.

const INFO_URL = "https://api.hyperliquid.xyz/info";

const INTERVAL_MS: Record<string, number> = {
    "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const cache = new Map<string, candle[]>();

interface raw {t: number; o: string; h: string; l: string; c: string}

const post = async (coin: string, interval: string, start: number, end: number): Promise<raw[]> => {
    for (let attempt = 0; ; attempt++) {
        const response = await fetch(INFO_URL, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({type: "candleSnapshot", req: {coin, interval, startTime: start, endTime: end}}),
        });

        if (response.ok) {
            return await response.json() as raw[];
        }

        // back off and retry on rate limit (429) or transient 5xx, up to 5 times
        if ((response.status === 429 || response.status >= 500) && attempt < 5) {
            await sleep(2000 * (attempt + 1));
            continue;
        }

        throw new Error(`[candles] ${coin} ${interval} ${response.status}`);
    }
};

// Fetch candles for [start, end], paged. Returns ascending, de-duplicated by open time.
export const fetch_candles = async (
    coin: string,
    interval: string,
    start: number,
    end: number
): Promise<candle[]> => {
    const key = `${coin}:${interval}:${start}:${end}`;
    const cached = cache.get(key);

    if (cached) {
        return cached;
    }

    const step = (INTERVAL_MS[interval] ?? 60_000) * 4900; // under the ~5000 cap per page
    const by_time = new Map<number, candle>();

    for (let from = start; from < end; from += step) {
        const to = Math.min(from + step, end);
        const page = await post(coin, interval, from, to);

        for (const k of page) {
            by_time.set(k.t, {t: k.t, o: Number(k.o), h: Number(k.h), l: Number(k.l), c: Number(k.c)});
        }

        await sleep(120); // be polite to the API
    }

    const out = [...by_time.values()].sort((a, b) => a.t - b.t);
    cache.set(key, out);

    return out;
};
