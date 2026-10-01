import {and, eq, inArray, or, sql} from "drizzle-orm";
import {
    accumulation_plans,
    close_db,
    db,
    hyperliquid_markets,
    partner_fetch_state,
    trade_setups,
    type hyperliquid_market,
    type new_accumulation_plan,
    type new_partner_fetch_row,
    type new_trade_setup,
    type partner_fetch_row,
} from "../db";
import {
    announce_ondemand_setups,
    apply_supersedence,
    build_perp_setup_row,
    fetch_all_mids,
    fetch_futures_plan,
    fetch_spot_zones,
    groups_of,
    hl_name_candidates,
    parse_futures_plan,
    parse_spot_zones,
    to_base_coin,
    to_numeric,
    type api_result,
} from "../services";
import dotenv from "dotenv";
dotenv.config();

const ON_DEMAND_LOCK_KEY = 728414;

// Runs every 30 min. Each run only fetches coins whose last successful fetch is older than
// FRESH_MS (24h), oldest first, up to a call budget - and stops early if the partner
// rate-limits us (429). Over many runs this refreshes every supported coin within 24h while
// staying under the partner's limit. Coins the partner does not cover (400) are flagged and
// never queried again.
const FUTURES_TIMEFRAME = process.env.PARTNER_FUTURES_TIMEFRAME ?? "4H";
const FRESH_MS = 24 * 3_600_000;
const SPOT_PLAN_TTL_HOURS = 24 * 7;
const MAX_CALLS_PER_RUN = Number(process.env.ONDEMAND_MAX_CALLS ?? 40);
const CALL_DELAY_MS = Number(process.env.ONDEMAND_CALL_DELAY_MS ?? 500);

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

// Candidates due for a fetch: supported, and stale beyond the freshness window; oldest
// first (never-fetched sort first). Honours an explicit ONDEMAND_SYMBOLS override.
const due_candidates = (
    index: Map<string, hyperliquid_market>,
    state: Map<string, partner_fetch_row>
): candidate[] => {
    const configured = process.env.ONDEMAND_SYMBOLS;
    const now = Date.now();

    const all: candidate[] = configured
        ? configured.split(",").map((s) => s.trim()).filter(Boolean).flatMap((symbol) => {
            const market = resolve(index, symbol);

            return market ? [{base_coin: market.base_coin, symbol}] : [];
        })
        : [...index.values()].map((market) => ({
            base_coin: market.base_coin,
            symbol: to_partner_symbol(market.base_coin),
        }));

    return all
        .filter((c) => {
            const st = state.get(c.base_coin);

            if (st && !st.supported) {
                return false;
            }

            const last = st?.last_fetch_at ? st.last_fetch_at.getTime() : 0;

            return now - last >= FRESH_MS;
        })
        .sort((a, b) => {
            const la = state.get(a.base_coin)?.last_fetch_at?.getTime() ?? 0;
            const lb = state.get(b.base_coin)?.last_fetch_at?.getTime() ?? 0;

            return la - lb;
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

interface run_ctx {
    budget: number;
    rate_limited: boolean;
}

// Apply the common status handling; returns true when the caller should process res.data.
const handle_status = async (
    ctx: run_ctx,
    kind: "perp" | "spot",
    c: candidate,
    res: api_result
): Promise<boolean> => {
    if (res.status === 429) {
        ctx.rate_limited = true;
        await record_state(kind, c.base_coin, c.symbol, {last_status: 429});

        return false;
    }

    if (res.status === 400) {
        // partner does not cover this coin - flag it so we never query it again
        await record_state(kind, c.base_coin, c.symbol, {supported: false, last_status: 400});

        return false;
    }

    if (!res.ok) {
        // transient (5xx / network): leave it due, just note the status
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

const sync_futures = async (ctx: run_ctx, index: Map<string, hyperliquid_market>): Promise<void> => {
    const state = await load_state("perp");
    const due = due_candidates(index, state);
    const rows: new_trade_setup[] = [];
    let fetched = 0;

    for (const c of due) {
        if (ctx.rate_limited || ctx.budget <= 0) {
            break;
        }

        ctx.budget--;
        const res = await fetch_futures_plan(c.symbol, FUTURES_TIMEFRAME);
        await sleep(CALL_DELAY_MS);

        if (!(await handle_status(ctx, "perp", c, res))) {
            continue;
        }

        fetched++;

        for (const input of parse_futures_plan(res.data)) {
            const market = resolve(index, input.symbol);

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

    let announced = 0;

    if (rows.length > 0) {
        const inserted = await db.insert(trade_setups).values(rows).onConflictDoNothing().returning();
        await apply_supersedence(groups_of(rows));

        // announce the newly-created, still-live futures setups to the on-demand channel,
        // suppressing near-identical repeats (no-op if TELEGRAM_ONDEMAND_CHAT_ID is unset)
        if (inserted.length > 0) {
            const live = await db
                .select({id: trade_setups.id})
                .from(trade_setups)
                .where(and(
                    inArray(trade_setups.id, inserted.map((r) => r.id)),
                    or(eq(trade_setups.status, "pending"), eq(trade_setups.status, "armed")),
                ));
            const live_ids = new Set(live.map((r) => r.id));
            const live_setups = inserted.filter((r) => live_ids.has(r.id));

            if (live_setups.length > 0) {
                const mids = await fetch_all_mids();
                announced = await announce_ondemand_setups(live_setups, mids);
            }
        }
    }

    console.log(`[on-demand] futures: ${due.length} due, ${fetched} fetched -> ${rows.length} setups` +
        (announced > 0 ? `, announced ${announced}` : ""));
};

const sync_spot = async (ctx: run_ctx, index: Map<string, hyperliquid_market>): Promise<void> => {
    const state = await load_state("spot");
    const due = due_candidates(index, state);
    let stored = 0;

    for (const c of due) {
        if (ctx.rate_limited || ctx.budget <= 0) {
            break;
        }

        ctx.budget--;
        const res = await fetch_spot_zones(c.symbol);
        await sleep(CALL_DELAY_MS);

        if (!(await handle_status(ctx, "spot", c, res))) {
            continue;
        }

        const plan = parse_spot_zones(res.data);
        const market = plan ? resolve(index, plan.symbol) : null;

        if (!plan || !market) {
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

        await db
            .insert(accumulation_plans)
            .values(row)
            .onConflictDoUpdate({target: accumulation_plans.base_coin, set: row});

        stored++;
    }

    console.log(`[on-demand] spot: ${due.length} due, ${stored} plans`);
};

export const sync_on_demand = async (): Promise<void> => {
    const lock = await db.execute(sql`select pg_try_advisory_lock(${ON_DEMAND_LOCK_KEY}) as locked`);
    const locked = (lock.rows[0] as {locked: boolean} | undefined)?.locked;

    if (!locked) {
        console.log("[on-demand] another run is already in progress, skipping");

        return;
    }

    try {
        const [perp_index, spot_index] = await Promise.all([load_markets("perp"), load_markets("spot")]);

        if (perp_index.size === 0) {
            console.error("[on-demand] no hyperliquid markets loaded, skipping");

            return;
        }

        // shared call budget across both kinds, since the partner rate-limit is shared
        const ctx: run_ctx = {budget: MAX_CALLS_PER_RUN, rate_limited: false};

        await sync_futures(ctx, perp_index);
        await sync_spot(ctx, spot_index);

        if (ctx.rate_limited) {
            console.log("[on-demand] stopped early: partner rate limit (429) - remaining coins resume next run");
        }
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
