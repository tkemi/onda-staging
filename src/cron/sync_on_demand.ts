import {eq, sql} from "drizzle-orm";
import {
    accumulation_plans,
    close_db,
    db,
    hyperliquid_markets,
    partner_fetch_state,
    type hyperliquid_market,
    type new_accumulation_plan,
    type new_partner_fetch_row,
    type partner_fetch_row,
    type trade_setup,
} from "../db";
import {
    announce_ondemand_setups,
    fetch_all_mids,
    fetch_futures_plan,
    fetch_spot_zones,
    hl_name_candidates,
    merge_or_create_futures_setup,
    notify_spot_plan,
    parse_futures_plan,
    parse_spot_zones,
    to_base_coin,
    to_numeric,
    type api_result,
} from "../services";
import dotenv from "dotenv";
dotenv.config();

// separate locks so a futures run and a spot run never block each other
const FUTURES_LOCK_KEY = 728414;
const SPOT_LOCK_KEY = 728415;

// Scheduled a few times a day (see app.json). Each run does a FULL SWEEP of every
// partner-supported coin: it fetches the latest futures plan and compares each zone to what
// we already hold — a re-seen zone bumps its strength count, a new entry becomes a new zone
// (see merge_or_create_futures_setup). Coins the partner doesn't cover (400) are flagged and
// skipped forever. Spot zones are refreshed the same way.
//
// The partner rate limit is 30 req/min, shared across the whole API, so every call is paced
// (>= ONDEMAND_CALL_DELAY_MS apart) and a 429 backs off rather than hammering.
const FUTURES_TIMEFRAME = process.env.PARTNER_FUTURES_TIMEFRAME ?? "4H";
const SPOT_PLAN_TTL_HOURS = 24 * 7;
// ~27 req/min, safely under the 30/min limit
const CALL_DELAY_MS = Number(process.env.ONDEMAND_CALL_DELAY_MS ?? 2200);
const RATE_BACKOFF_MS = 60_000;
const MAX_429_RETRIES = 3;
// zones shift with price, so spot plans post to the channel at most once per coin per day
const SPOT_NOTIFY_MS = 24 * 3_600_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// HL base coin (e.g. kPEPE) -> the partner's Binance-style symbol (PEPEUSDT). Best-effort
// reverse of the k/1000 renaming; when wrong the partner returns 400 and we flag the coin.
const to_partner_symbol = (hl_base: string): string => `${hl_base.replace(/^k/, "")}USDT`;

const load_markets = async (kind: "perp" | "spot"): Promise<Map<string, hyperliquid_market>> => {
    const rows = await db.select().from(hyperliquid_markets).where(eq(hyperliquid_markets.kind, kind));

    return new Map(rows.filter((row) => !row.is_delisted).map((row) => [row.base_coin, row]));
};

const load_state = async (kind: "perp" | "spot"): Promise<Map<string, partner_fetch_row>> => {
    const rows = await db.select().from(partner_fetch_state).where(eq(partner_fetch_state.kind, kind));

    return new Map(rows.map((row) => [row.base_coin, row]));
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

interface candidate {
    base_coin: string;
    symbol: string;
}

// Every supported coin (plus any not-yet-seen coin, to discover coverage); unsupported
// coins are skipped. Honours an explicit ONDEMAND_SYMBOLS override.
const supported_candidates = (
    index: Map<string, hyperliquid_market>,
    state: Map<string, partner_fetch_row>
): candidate[] => {
    const configured = process.env.ONDEMAND_SYMBOLS;

    const all: candidate[] = configured
        ? configured.split(",").map((s) => s.trim()).filter(Boolean).flatMap((symbol) => {
            const market = resolve(index, symbol);

            return market ? [{base_coin: market.base_coin, symbol}] : [];
        })
        : [...index.values()].map((market) => ({
            base_coin: market.base_coin,
            symbol: to_partner_symbol(market.base_coin),
        }));

    return all.filter((c) => {
        const st = state.get(c.base_coin);

        return !(st && !st.supported);
    });
};

const record_state = async (
    kind: "perp" | "spot",
    base_coin: string,
    symbol: string,
    patch: Partial<Pick<new_partner_fetch_row, "supported" | "last_fetch_at" | "last_status">>
): Promise<void> => {
    const set = {...patch, symbol, updated_at: new Date()};

    await db
        .insert(partner_fetch_state)
        .values({kind, base_coin, symbol, ...patch})
        .onConflictDoUpdate({target: [partner_fetch_state.kind, partner_fetch_state.base_coin], set});
};

// Pace a partner call to stay under 30 req/min and retry a 429 after backing off, so a
// momentary throttle doesn't drop the coin from this sweep.
let last_call_at = 0;

const paced = async (fn: () => Promise<api_result>): Promise<api_result> => {
    const gap = CALL_DELAY_MS - (Date.now() - last_call_at);

    if (gap > 0) {
        await sleep(gap);
    }

    let res = await fn();
    last_call_at = Date.now();

    for (let i = 0; res.status === 429 && i < MAX_429_RETRIES; i++) {
        console.warn("[on-demand] 429 rate-limited, backing off 60s");
        await sleep(RATE_BACKOFF_MS);
        res = await fn();
        last_call_at = Date.now();
    }

    return res;
};

// Record fetch state from a response; returns true when res.data should be processed.
const handle_status = async (kind: "perp" | "spot", c: candidate, res: api_result): Promise<boolean> => {
    if (res.status === 400) {
        await record_state(kind, c.base_coin, c.symbol, {supported: false, last_status: 400});

        return false;
    }

    if (!res.ok) {
        // transient (429 after retries, 5xx, network): leave supported, note the status
        await record_state(kind, c.base_coin, c.symbol, {last_status: res.status});

        return false;
    }

    await record_state(kind, c.base_coin, c.symbol, {
        supported: true,
        last_fetch_at: new Date(),
        last_status: res.status,
    });

    return true;
};

const sync_futures = async (index: Map<string, hyperliquid_market>): Promise<void> => {
    const state = await load_state("perp");
    const due = supported_candidates(index, state);
    const new_setups: trade_setup[] = [];
    let fetched = 0;
    let created = 0;
    let strengthened = 0;

    for (const c of due) {
        const res = await paced(() => fetch_futures_plan(c.symbol, FUTURES_TIMEFRAME));

        if (!(await handle_status("perp", c, res))) {
            continue;
        }

        fetched++;

        for (const input of parse_futures_plan(res.data)) {
            const market = resolve(index, input.symbol);

            if (!market) {
                continue;
            }

            const result = await merge_or_create_futures_setup({
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
            }, market);

            if (!result) {
                continue;
            }

            if (result.created) {
                created++;
                new_setups.push(result.setup);
            } else {
                strengthened++;
            }
        }
    }

    // announce only the genuinely new zones (repeats/strengthened ones stay silent)
    let announced = 0;

    if (new_setups.length > 0) {
        const mids = await fetch_all_mids();
        announced = await announce_ondemand_setups(new_setups, mids);
    }

    console.log(`[on-demand] futures: ${due.length} supported, ${fetched} fetched -> ` +
        `${created} new, ${strengthened} strengthened, announced ${announced}`);
};

const sync_spot = async (index: Map<string, hyperliquid_market>): Promise<void> => {
    const state = await load_state("spot");
    const due = supported_candidates(index, state);
    let stored = 0;
    let announced = 0;

    for (const c of due) {
        const res = await paced(() => fetch_spot_zones(c.symbol));

        if (!(await handle_status("spot", c, res))) {
            continue;
        }

        const plan = parse_spot_zones(res.data);
        const market = plan ? resolve(index, plan.symbol) : null;

        if (!plan || !market) {
            continue;
        }

        // read the previous notify time before upserting (the upsert preserves notified_at,
        // since `row` does not set it)
        const [prev] = await db
            .select({notified_at: accumulation_plans.notified_at})
            .from(accumulation_plans)
            .where(eq(accumulation_plans.base_coin, market.base_coin))
            .limit(1);

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

        await db
            .insert(accumulation_plans)
            .values(row)
            .onConflictDoUpdate({target: accumulation_plans.base_coin, set: row});

        stored++;

        const last = prev?.notified_at ? prev.notified_at.getTime() : 0;

        if (Date.now() - last >= SPOT_NOTIFY_MS) {
            await notify_spot_plan(market.base_coin, plan);
            await db
                .update(accumulation_plans)
                .set({notified_at: new Date()})
                .where(eq(accumulation_plans.base_coin, market.base_coin));
            announced++;
        }
    }

    console.log(`[on-demand] spot: ${due.length} supported, ${stored} plans` +
        (announced > 0 ? `, announced ${announced}` : ""));
};

const with_lock = async (key: number, label: string, fn: () => Promise<void>): Promise<void> => {
    const lock = await db.execute(sql`select pg_try_advisory_lock(${key}) as locked`);
    const locked = (lock.rows[0] as {locked: boolean} | undefined)?.locked;

    if (!locked) {
        console.log(`[on-demand] another ${label} run is already in progress, skipping`);

        return;
    }

    try {
        await fn();
    } finally {
        await db.execute(sql`select pg_advisory_unlock(${key})`);
    }
};

// Futures sweep (scheduled a few times a day).
export const run_futures_sync = (): Promise<void> =>
    with_lock(FUTURES_LOCK_KEY, "futures", async () => {
        const index = await load_markets("perp");

        if (index.size === 0) {
            console.error("[on-demand] no hyperliquid perp markets loaded, skipping");

            return;
        }

        await sync_futures(index);
    });

// Spot sweep (scheduled once a day).
export const run_spot_sync = (): Promise<void> =>
    with_lock(SPOT_LOCK_KEY, "spot", async () => {
        const index = await load_markets("spot");

        if (index.size === 0) {
            console.error("[on-demand] no hyperliquid spot markets loaded, skipping");

            return;
        }

        await sync_spot(index);
    });

if (require.main === module) {
    // `node dist/cron/sync_on_demand.js spot` runs spot; anything else runs futures
    const run = process.argv[2] === "spot" ? run_spot_sync : run_futures_sync;

    run()
        .then(() => close_db())
        .then(() => process.exit(0))
        .catch((error: unknown) => {
            console.error("[on-demand] failed:", error);
            void close_db().finally(() => process.exit(1));
        });
}
