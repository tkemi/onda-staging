import {and, eq, inArray} from "drizzle-orm";
import {db, hyperliquid_markets, type hyperliquid_market} from "../db";

export type market_kind = "perp" | "spot";

// Strip the quote off a partner symbol and upper-case the base.
// BNBUSDT -> BNB, 1000PEPEUSDT -> 1000PEPE, ETH/USDC -> ETH
export const to_base_coin = (symbol: string): string =>
    symbol.trim().toUpperCase().replace(/[-_/]?(USDT|USDC|USD|PERP)$/i, "");

// Hyperliquid renames high-supply coins with a k prefix (kPEPE == 1000 PEPE), while the
// partner may send PEPE, 1000PEPE or kPEPE. Generate the plausible venue names so a
// lookup matches regardless of which convention the signal used. Best-effort: refine the
// day we see a real mismatch in the unsupported-signal logs.
export const hl_name_candidates = (base: string): string[] => {
    const upper = base.toUpperCase();
    const candidates = new Set<string>([upper]);

    // PEPE -> kPEPE / 1000PEPE
    candidates.add(`k${upper}`);
    candidates.add(`1000${upper}`);

    // 1000PEPE -> kPEPE / PEPE
    if (upper.startsWith("1000")) {
        candidates.add(`k${upper.slice(4)}`);
        candidates.add(upper.slice(4));
    }

    // KPEPE (as sent) -> PEPE / 1000PEPE
    if (upper.startsWith("K") && upper.length > 1) {
        candidates.add(upper.slice(1));
        candidates.add(`1000${upper.slice(1)}`);
    }

    return [...candidates];
};

// The Hyperliquid market a partner symbol maps to, or null if the coin is not tradable
// there for the given kind. Delisted markets never match.
export const find_hl_market = async (
    symbol: string,
    kind: market_kind
): Promise<hyperliquid_market | null> => {
    const candidates = hl_name_candidates(to_base_coin(symbol));

    const rows = await db
        .select()
        .from(hyperliquid_markets)
        .where(and(
            eq(hyperliquid_markets.kind, kind),
            eq(hyperliquid_markets.is_delisted, false),
            inArray(hyperliquid_markets.base_coin, candidates),
        ))
        .limit(1);

    return rows[0] ?? null;
};

export const is_supported = async (symbol: string, kind: market_kind): Promise<boolean> =>
    (await find_hl_market(symbol, kind)) !== null;
