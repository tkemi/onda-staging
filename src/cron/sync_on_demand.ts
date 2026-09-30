import {eq, sql} from "drizzle-orm";
import {
    accumulation_plans,
    close_db,
    db,
    hyperliquid_markets,
    trade_setups,
    type hyperliquid_market,
    type new_accumulation_plan,
    type new_trade_setup,
} from "../db";
import {
    apply_supersedence,
    build_perp_setup_row,
    fetch_futures_plan,
    fetch_spot_zones,
    groups_of,
    hl_name_candidates,
    parse_futures_plan,
    parse_spot_zones,
    to_base_coin,
    to_numeric,
} from "../services";
import dotenv from "dotenv";
dotenv.config();

const ON_DEMAND_LOCK_KEY = 728414;

// Provisional: which timeframe to pull futures plans for, and how long a spot plan stays
// current. Both to be revisited in the cadence/invalidation discussion.
const FUTURES_TIMEFRAME = process.env.PARTNER_FUTURES_TIMEFRAME ?? "4H";
const SPOT_PLAN_TTL_HOURS = 24 * 7;

// be polite to the partner's API between calls
const CALL_DELAY_MS = 200;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// HL base coin (e.g. kPEPE) -> the partner's Binance-style symbol (PEPEUSDT). Best-effort
// reverse of the k/1000 renaming; refine once we see which symbols the partner accepts.
const to_partner_symbol = (hl_base: string): string =>
    `${hl_base.replace(/^k/, "")}USDT`;

const load_index = async (kind: "perp" | "spot"): Promise<Map<string, hyperliquid_market>> => {
    const rows = await db.select().from(hyperliquid_markets).where(eq(hyperliquid_markets.kind, kind));

    return new Map(rows.filter((row) => !row.is_delisted).map((row) => [row.base_coin, row]));
};

const resolve = (
    index: Map<string, hyperliquid_market>,
    symbol: string
): hyperliquid_market | null => {
    for (const candidate of hl_name_candidates(to_base_coin(symbol))) {
        const market = index.get(candidate);

        if (market) {
            return market;
        }
    }

    return null;
};

// Either an explicit ONDEMAND_SYMBOLS list, or derived from the HL markets we support.
const symbols_for = (index: Map<string, hyperliquid_market>): string[] => {
    const configured = process.env.ONDEMAND_SYMBOLS;

    if (configured) {
        return configured.split(",").map((s) => s.trim()).filter(Boolean);
    }

    return [...index.values()].map((market) => to_partner_symbol(market.base_coin));
};

const sync_futures = async (perp_index: Map<string, hyperliquid_market>): Promise<void> => {
    const symbols = symbols_for(perp_index);
    const rows: new_trade_setup[] = [];

    for (const symbol of symbols) {
        const response = await fetch_futures_plan(symbol, FUTURES_TIMEFRAME);
        await sleep(CALL_DELAY_MS);

        if (!response) {
            continue;
        }

        for (const input of parse_futures_plan(response)) {
            const market = resolve(perp_index, input.symbol);

            if (!market) {
                continue;
            }

            rows.push(build_perp_setup_row({
                source_type: "futures_plan",
                symbol: input.symbol,
                direction: input.direction,
                entry_low: input.entry_low,
                entry_high: input.entry_high,
                entry_ref: input.entry_ref,
                sl: input.sl,
                raw_tps: input.raw_tps,
                data: input.data,
                generated_at: input.generated_at,
                dedup_extra: FUTURES_TIMEFRAME,
            }, market));
        }
    }

    if (rows.length > 0) {
        await db.insert(trade_setups).values(rows).onConflictDoNothing();
        await apply_supersedence(groups_of(rows));
    }

    console.log(`[on-demand] futures: ${symbols.length} symbols -> ${rows.length} setups`);
};

const sync_spot = async (spot_index: Map<string, hyperliquid_market>): Promise<void> => {
    const symbols = symbols_for(spot_index);
    let stored = 0;

    for (const symbol of symbols) {
        const response = await fetch_spot_zones(symbol);
        await sleep(CALL_DELAY_MS);

        if (!response) {
            continue;
        }

        const plan = parse_spot_zones(response);

        if (!plan) {
            continue;
        }

        const market = resolve(spot_index, plan.symbol);

        if (!market) {
            continue;
        }

        const row: new_accumulation_plan = {
            symbol: plan.symbol,
            base_coin: market.base_coin,
            hl_symbol: market.hl_symbol,
            hl_market_id: market.id,
            current_price: plan.current_price !== null ? to_numeric(plan.current_price) : null,
            buy_zones: plan.buy_zones,
            sell_zones: plan.sell_zones,
            summary: plan.summary,
            generated_at: plan.generated_at,
            expires_at: new Date(plan.generated_at.getTime() + SPOT_PLAN_TTL_HOURS * 3_600_000),
        };

        // one current plan per coin: replace the previous day's
        await db
            .insert(accumulation_plans)
            .values(row)
            .onConflictDoUpdate({target: accumulation_plans.base_coin, set: row});

        stored++;
    }

    console.log(`[on-demand] spot: ${symbols.length} symbols -> ${stored} plans`);
};

export const sync_on_demand = async (): Promise<void> => {
    const lock = await db.execute(sql`select pg_try_advisory_lock(${ON_DEMAND_LOCK_KEY}) as locked`);
    const locked = (lock.rows[0] as {locked: boolean} | undefined)?.locked;

    if (!locked) {
        console.log("[on-demand] another run is already in progress, skipping");

        return;
    }

    try {
        const [perp_index, spot_index] = await Promise.all([load_index("perp"), load_index("spot")]);

        if (perp_index.size === 0) {
            console.error("[on-demand] no hyperliquid markets loaded, skipping");

            return;
        }

        await sync_futures(perp_index);
        await sync_spot(spot_index);
    } finally {
        await db.execute(sql`select pg_advisory_unlock(${ON_DEMAND_LOCK_KEY})`);
    }
};

if (require.main === module) {
    sync_on_demand()
        .then(() => close_db())
        .then(() => process.exit(0))
        .catch((error: unknown) => {
            console.error("[on-demand] failed:", error);
            void close_db().finally(() => process.exit(1));
        });
}
