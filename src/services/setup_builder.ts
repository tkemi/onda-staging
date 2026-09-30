// Pure logic that turns a raw partner payload into the fields of a canonical trade
// setup: parsing, direction normalisation, and TP-ladder completion via R-multiples.
// No database or network here, so it is easy to test in isolation.

export type direction = "long" | "short";

export type pushed_source = "filter_mix" | "liquidity_hunt" | "signal_hub";

export interface parsed_signal {
    source_type: pushed_source;
    symbol: string;
    direction: direction;
    entry: number;
    sl: number | null;
    // tp1/tp2/tp3 exactly as sent, with 0 and null both normalised to "missing"
    raw_tps: [number | null, number | null, number | null];
    // type-specific context (confidence, score, EMAs, ...) - never levels, never authToken
    data: Record<string, unknown>;
    generated_at: Date;
}

const TYPE_MAP: Record<string, pushed_source> = {
    FILTER_MIX_SIGNAL: "filter_mix",
    LIQUIDITY_HUNT_SIGNAL: "liquidity_hunt",
    SIGNAL_HUB_SIGNAL: "signal_hub",
};

const finite = (value: unknown): number | null =>
    typeof value === "number" && isFinite(value) ? value : null;

// 0 and null/undefined all mean "not provided" for the stop and the targets
const level = (value: unknown): number | null => {
    const num = finite(value);

    return num !== null && num !== 0 ? num : null;
};

const to_direction = (value: unknown): direction | null => {
    const upper = String(value ?? "").toUpperCase();

    return upper === "LONG" ? "long" : upper === "SHORT" ? "short" : null;
};

// Extract the usable parts of a delivery, or null when it is not a directional setup we
// can act on (unknown type, no data, no symbol/direction/entry).
export const parse_signal = (payload: unknown): parsed_signal | null => {
    if (!payload || typeof payload !== "object") {
        return null;
    }

    const root = payload as Record<string, unknown>;
    const source_type = TYPE_MAP[String(root.type ?? "")];

    if (!source_type) {
        return null;
    }

    const d = root.data && typeof root.data === "object" ? root.data as Record<string, unknown> : null;

    if (!d) {
        return null;
    }

    const symbol = typeof d.symbol === "string" ? d.symbol : null;
    // filter_mix / signal_hub carry `direction`; liquidity_hunt carries `signalType`
    const direction = to_direction(d.direction) ?? to_direction(d.signalType);
    const entry = finite(d.entryPrice);

    if (!symbol || !direction || entry === null || entry <= 0) {
        return null;
    }

    const data: Record<string, unknown> = {};

    if (source_type === "liquidity_hunt") {
        if (d.confidence != null) data.confidence = d.confidence;
        if (d.score != null) data.score = d.score;
        if (d.liquidationSide != null) data.liquidationSide = d.liquidationSide;
        if (d.signalType != null) data.signalType = d.signalType;
    } else if (source_type === "signal_hub") {
        if (d.signalType != null) data.signalType = d.signalType;
        if (finite(d.price) !== null) data.price = d.price;
        if (finite(d.ema10) !== null) data.ema10 = d.ema10;
        if (finite(d.ema20) !== null) data.ema20 = d.ema20;
    }

    const generated = root.generatedAt ? new Date(String(root.generatedAt)) : new Date();

    return {
        source_type,
        symbol,
        direction,
        entry,
        sl: level(d.slPrice),
        raw_tps: [level(d.tp1Price), level(d.tp2Price), level(d.tp3Price)],
        data,
        generated_at: isNaN(generated.getTime()) ? new Date() : generated,
    };
};

export interface ladder_level {
    price: number;
    source: "partner" | "derived";
}

export interface completed_ladder {
    tp1: ladder_level;
    tp2: ladder_level;
    tp3: ladder_level;
}

// Fill in the full three-rung TP ladder, keeping partner levels and deriving the rest:
//   1. >=1 TP given  -> extend using the unit distance of the lowest-index given TP
//                       (tp1 given -> tp2/tp3 at 2x/3x that distance from entry)
//   2. no TP, has SL -> R-multiples 2R/4R/6R from entry (R = |entry - SL|)
//   3. nothing       -> fixed 10/20/30% from entry
// Targets always extend in the trade direction (above entry for long, below for short).
export const complete_ladder = (
    direction: direction,
    entry: number,
    sl: number | null,
    raw: [number | null, number | null, number | null]
): completed_ladder => {
    const sign = direction === "long" ? 1 : -1;
    const given = raw.map((value, index) => ({value, index})).filter(
        (item): item is {value: number; index: number} => item.value !== null
    );

    let unit: number;
    // use the highest-index provided target so extrapolated rungs stay monotonic even
    // when two irregularly-spaced TPs are given (futures-plan style)
    const anchor = given[given.length - 1];

    if (anchor) {
        unit = Math.abs(anchor.value - entry) / (anchor.index + 1);
    } else if (sl !== null) {
        // 2R per rung -> 2R / 4R / 6R
        unit = 2 * Math.abs(entry - sl);
    } else {
        // 10% per rung -> 10 / 20 / 30%
        unit = 0.1 * entry;
    }

    const rung = (index: number): ladder_level => {
        const provided = raw[index] ?? null;

        if (provided !== null) {
            return {price: provided, source: "partner"};
        }

        return {price: entry + sign * (index + 1) * unit, source: "derived"};
    };

    return {tp1: rung(0), tp2: rung(1), tp3: rung(2)};
};

export const risk_reward_to_tp1 = (
    entry: number,
    sl: number | null,
    tp1: number
): number | null => {
    if (sl === null) {
        return null;
    }

    const risk = Math.abs(entry - sl);

    return risk === 0 ? null : Math.abs(tp1 - entry) / risk;
};

// Collapse byte-identical re-sends: two signals with the same market, direction and raw
// levels produce the same key. Derived levels are deterministic from these, so they need
// not be in the key. Rounded to kill float noise.
const price_key = (value: number | null): string =>
    value === null ? "_" : String(parseFloat(value.toPrecision(12)));

export const make_dedup_key = (
    base_coin: string,
    direction: direction,
    entry_ref: number,
    sl: number | null,
    raw_tps: [number | null, number | null, number | null],
    extra = ""
): string =>
    [base_coin, direction, price_key(entry_ref), price_key(sl), ...raw_tps.map(price_key), extra]
        .join("|");

export const dedup_key_for = (signal: parsed_signal, base_coin: string): string =>
    make_dedup_key(base_coin, signal.direction, signal.entry, signal.sl, signal.raw_tps);

// --- validity windows (provisional; to be tuned) ---------------------------
// How long a setup stays actionable after it was generated, per source. These are
// starting points to be revisited - see the invalidation discussion in the docs.
export const TTL_HOURS: Record<string, number> = {
    filter_mix: 24,
    liquidity_hunt: 24,
    signal_hub: 24,
    futures_plan: 24,      // refreshed daily
};

export const expires_from = (generated_at: Date, source_type: string): Date | null => {
    const hours = TTL_HOURS[source_type];

    return hours ? new Date(generated_at.getTime() + hours * 3_600_000) : null;
};

// --- on-demand APIs: futures plan & spot zones -----------------------------

// A single directional setup carved out of a futures-plan zone. Shares the ladder and
// dedup machinery above; entry is a real zone (low/high) with a reference mid.
export interface futures_setup_input {
    symbol: string;
    direction: direction;
    entry_low: number;
    entry_high: number;
    entry_ref: number;
    sl: number | null;
    raw_tps: [number | null, number | null, number | null];
    data: Record<string, unknown>;
    generated_at: Date;
}

interface plan_zone {
    entryRange?: {low?: number; high?: number};
    mid?: number;
    stopLoss?: number;
    takeProfit?: number[];
    riskReward?: number;
    strength?: string;
    confluence?: string[];
}

const zone_to_input = (
    symbol: string,
    direction: direction,
    zone: plan_zone,
    generated_at: Date
): futures_setup_input | null => {
    const mid = finite(zone.mid);
    const low = finite(zone.entryRange?.low) ?? mid;
    const high = finite(zone.entryRange?.high) ?? mid;

    if (mid === null || low === null || high === null) {
        return null;
    }

    const tps = Array.isArray(zone.takeProfit) ? zone.takeProfit : [];

    return {
        symbol,
        direction,
        entry_low: Math.min(low, high),
        entry_high: Math.max(low, high),
        entry_ref: mid,
        sl: level(zone.stopLoss),
        raw_tps: [level(tps[0]), level(tps[1]), level(tps[2])],
        data: {
            strength: zone.strength ?? null,
            confluence: zone.confluence ?? [],
            risk_reward: finite(zone.riskReward),
        },
        generated_at,
    };
};

// Expand a futures-plan API response into one setup per zone (long + short).
export const parse_futures_plan = (response: unknown): futures_setup_input[] => {
    const root = response as {data?: Record<string, unknown>} | null;
    const data = root?.data;

    if (!data || typeof data.symbol !== "string") {
        return [];
    }

    const generated = data.generatedAt ? new Date(String(data.generatedAt)) : new Date();
    const at = isNaN(generated.getTime()) ? new Date() : generated;
    const zones = (data.zones ?? {}) as {long?: plan_zone[]; short?: plan_zone[]};

    const timeframe = typeof data.timeframe === "string" ? data.timeframe : null;

    const build = (list: plan_zone[] | undefined, direction: direction): futures_setup_input[] =>
        (list ?? [])
            .map((zone) => zone_to_input(data.symbol as string, direction, zone, at))
            .filter((input): input is futures_setup_input => input !== null)
            .map((input) => ({...input, data: {...input.data, timeframe}}));

    return [...build(zones.long, "long"), ...build(zones.short, "short")];
};

// --- spot / swing accumulation plans ---------------------------------------

export interface spot_plan_input {
    symbol: string;
    current_price: number | null;
    buy_zones: unknown;
    sell_zones: unknown;
    summary: unknown;
    generated_at: Date;
}

export const parse_spot_zones = (response: unknown): spot_plan_input | null => {
    const root = response as {data?: Record<string, unknown>} | null;
    const data = root?.data;

    if (!data || typeof data.symbol !== "string") {
        return null;
    }

    const generated = data.generatedAt ? new Date(String(data.generatedAt)) : new Date();

    return {
        symbol: data.symbol,
        current_price: finite(data.currentPrice),
        buy_zones: data.buyZones ?? [],
        sell_zones: data.sellZones ?? [],
        summary: data.summary ?? {},
        generated_at: isNaN(generated.getTime()) ? new Date() : generated,
    };
};

// numeric column values: kill float artifacts (12 sig figs - far beyond any venue tick)
// and avoid exponential notation so the stored text stays human-readable (Postgres would
// accept either).
export const to_numeric = (value: number): string =>
    parseFloat(value.toPrecision(12)).toLocaleString("en-US", {
        useGrouping: false,
        maximumFractionDigits: 20,
    });
