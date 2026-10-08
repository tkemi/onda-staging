// Pure backtest simulation: replay candles against one setup and compute the outcome and
// per-policy PnL. No DB/network, so it is fully unit-testable.
//
// Assumptions (documented, standard for strategy evaluation):
//  - fill = price touching the level (no slippage/liquidity modelling);
//  - entry fills at the zone midpoint;
//  - within a single candle that touches both a TP and the SL, SL is assumed first;
//  - a trade still open at the window end is marked at the last close (resolved = false).

export type bt_mode = "as_traded" | "take_all";

export interface candle {
    t: number; // open time (ms)
    o: number;
    h: number;
    l: number;
    c: number;
}

export interface sim_setup {
    direction: "long" | "short";
    entry_low: number;
    entry_high: number;
    sl: number | null;
    tp1: number | null;
    tp2: number | null;
    tp3: number | null;
    generated_at_ms: number;
    expires_at_ms: number | null;
}

export interface sim_opts {
    margin_usd: number;    // e.g. 100
    leverage: number;      // e.g. 5
    trailing_pct: number;  // runner trailing distance, fraction (e.g. 0.05)
    alloc: {tp1: number; tp2: number; tp3: number; runner: number}; // e.g. 0.3/0.3/0.2/0.2
}

export const DEFAULT_OPTS: sim_opts = {
    margin_usd: 100,
    leverage: 5,
    trailing_pct: 0.05,
    alloc: {tp1: 0.3, tp2: 0.3, tp3: 0.2, runner: 0.2},
};

export interface policy_pnl {
    r: number | null;  // in R-multiples (null when risk/SL is unknown)
    pct: number;       // price-move %, position-weighted
    usd: number;       // $ at margin_usd x leverage notional
    resolved: boolean; // false = still open at window end (marked at last close)
}

export type bt_outcome =
    | "invalidated" | "expired" | "no_entry" | "sl" | "tp1" | "tp2" | "tp3" | "open";

export interface sim_result {
    entered: boolean;
    outcome: bt_outcome;
    entry_at_ms: number | null;
    sl_at_ms: number | null;
    tp1_at_ms: number | null;
    tp2_at_ms: number | null;
    tp3_at_ms: number | null;
    max_tp: 0 | 1 | 2 | 3;
    mae_r: number | null;  // worst adverse excursion in R
    mfe_r: number | null;  // best favourable excursion in R
    resolved_at_ms: number | null; // full close time (longest hold) for concurrency
    policies: {tp1: policy_pnl; tp2: policy_pnl; tp3: policy_pnl; scaleout: policy_pnl};
}

const ZERO: policy_pnl = {r: 0, pct: 0, usd: 0, resolved: false};

export const simulate = (setup: sim_setup, candles: candle[], mode: bt_mode, opts: sim_opts): sim_result => {
    const dir = setup.direction === "long" ? 1 : -1;
    const notional = opts.margin_usd * opts.leverage;
    const z_low = Math.min(setup.entry_low, setup.entry_high);
    const z_high = Math.max(setup.entry_low, setup.entry_high);
    const entry = (setup.entry_low + setup.entry_high) / 2;
    const {sl, tp1, tp2, tp3} = setup;
    const risk = sl !== null ? Math.abs(entry - sl) : null;

    const no_trade = (outcome: bt_outcome): sim_result => ({
        entered: false, outcome,
        entry_at_ms: null, sl_at_ms: null, tp1_at_ms: null, tp2_at_ms: null, tp3_at_ms: null,
        max_tp: 0, mae_r: null, mfe_r: null, resolved_at_ms: null,
        policies: {tp1: ZERO, tp2: ZERO, tp3: ZERO, scaleout: ZERO},
    });

    const past_stop = (c: candle): boolean => sl !== null && (dir === 1 ? c.l <= sl : c.h >= sl);
    const hit = (c: candle, level: number | null): boolean =>
        level !== null && (dir === 1 ? c.h >= level : c.l <= level);

    // --- find entry (and pre-entry invalidation / expiry in as_traded mode) ----
    let entry_idx = -1;

    for (let i = 0; i < candles.length; i++) {
        const c = candles[i]!;

        if (mode === "as_traded" && setup.expires_at_ms !== null && c.t > setup.expires_at_ms) {
            return no_trade("expired");
        }

        if (c.l <= z_high && c.h >= z_low) {
            entry_idx = i;
            break;
        }

        if (mode === "as_traded" && past_stop(c)) {
            return no_trade("invalidated");
        }
    }

    if (entry_idx === -1) {
        return no_trade("no_entry");
    }

    // --- walk post-entry: record first touches, SL (SL-first within a candle), excursions --
    let sl_at: number | null = null;
    let tp1_at: number | null = null;
    let tp2_at: number | null = null;
    let tp3_at: number | null = null;
    let tp3_idx = -1;
    let best = entry; // favourable extreme
    let worst = entry; // adverse extreme
    const last_close = candles[candles.length - 1]!.c;

    for (let j = entry_idx; j < candles.length; j++) {
        const c = candles[j]!;

        if (sl_at === null) {
            best = dir === 1 ? Math.max(best, c.h) : Math.min(best, c.l);
            worst = dir === 1 ? Math.min(worst, c.l) : Math.max(worst, c.h);

            if (past_stop(c)) {
                sl_at = c.t; // SL-first: ignore any TP touched in this same candle
            } else {
                if (tp1_at === null && hit(c, tp1)) tp1_at = c.t;
                if (tp2_at === null && hit(c, tp2)) tp2_at = c.t;
                if (tp3_at === null && hit(c, tp3)) {
                    tp3_at = c.t;
                    tp3_idx = j;
                }
            }
        }
    }

    const max_tp: 0 | 1 | 2 | 3 = tp3_at !== null ? 3 : tp2_at !== null ? 2 : tp1_at !== null ? 1 : 0;
    const outcome: bt_outcome = max_tp > 0 ? (`tp${max_tp}` as bt_outcome) : sl_at !== null ? "sl" : "open";

    // --- pnl helpers ----------------------------------------------------------
    const to_pnl = (exit_price: number, frac: number, resolved: boolean): policy_pnl => {
        const move = (dir * (exit_price - entry)) / entry; // fractional price move in trade dir
        return {
            r: risk !== null ? (dir * (exit_price - entry)) / risk : null,
            pct: move * 100,
            usd: frac * move * notional,
            resolved,
        };
    };

    // full-exit policy targeting a given TP level
    const full_exit = (tp_at: number | null, tp_level: number | null): policy_pnl => {
        if (tp_level === null) {
            return ZERO;
        }
        if (tp_at !== null) {
            return to_pnl(tp_level, 1, true);     // reached target before SL -> win
        }
        if (sl !== null && sl_at !== null) {
            return to_pnl(sl, 1, true);           // stopped out -> loss
        }
        return to_pnl(last_close, 1, false);      // still open -> mark at last close
    };

    // --- scale-out policy: 30/30/20 banked at the TPs, 20% runner trailing ----
    const scaleout = ((): policy_pnl => {
        const legs: Array<{frac: number; price: number; resolved: boolean}> = [];
        const taken: Array<[number | null, number | null, number]> = [
            [tp1_at, tp1, opts.alloc.tp1],
            [tp2_at, tp2, opts.alloc.tp2],
            [tp3_at, tp3, opts.alloc.tp3],
        ];

        for (const [at, level, frac] of taken) {
            if (at !== null && level !== null) {
                legs.push({frac, price: level, resolved: true});
            }
        }

        const banked = legs.reduce((s, l) => s + l.frac, 0);
        const remaining = Math.max(0, 1 - banked);

        if (tp3_at !== null && tp3_idx >= 0) {
            // runner trails the peak after TP3; also exits at SL if that comes first
            let peak = tp3!;
            let runner_price = last_close;
            let runner_resolved = false;

            for (let j = tp3_idx + 1; j < candles.length; j++) {
                const c = candles[j]!;
                peak = dir === 1 ? Math.max(peak, c.h) : Math.min(peak, c.l);
                const trail = dir === 1 ? peak * (1 - opts.trailing_pct) : peak * (1 + opts.trailing_pct);

                if (past_stop(c)) {
                    runner_price = sl!;
                    runner_resolved = true;
                    break;
                }
                if (dir === 1 ? c.l <= trail : c.h >= trail) {
                    runner_price = trail;
                    runner_resolved = true;
                    break;
                }
            }

            legs.push({frac: opts.alloc.runner, price: runner_price, resolved: runner_resolved});
        } else if (remaining > 0) {
            // TP3 not reached: the rest exits at SL (loss) or is still open
            if (sl !== null && sl_at !== null) {
                legs.push({frac: remaining, price: sl, resolved: true});
            } else {
                legs.push({frac: remaining, price: last_close, resolved: false});
            }
        }

        let pct = 0;
        let usd = 0;
        let r = 0;
        let resolved = true;

        for (const leg of legs) {
            const move = (dir * (leg.price - entry)) / entry;
            pct += leg.frac * move * 100;
            usd += leg.frac * move * notional;
            if (risk !== null) {
                r += leg.frac * ((dir * (leg.price - entry)) / risk);
            }
            resolved = resolved && leg.resolved;
        }

        return {r: risk !== null ? r : null, pct, usd, resolved};
    })();

    // full-close time (longest hold) for concurrency: SL, or runner exit, or last candle
    const resolved_at_ms = scaleout.resolved
        ? (sl_at ?? last_candle_time(candles))
        : last_candle_time(candles);

    return {
        entered: true,
        outcome,
        entry_at_ms: candles[entry_idx]!.t,
        sl_at_ms: sl_at,
        tp1_at_ms: tp1_at,
        tp2_at_ms: tp2_at,
        tp3_at_ms: tp3_at,
        max_tp,
        mae_r: risk !== null ? (dir * (worst - entry)) / risk : null,
        mfe_r: risk !== null ? (dir * (best - entry)) / risk : null,
        resolved_at_ms,
        policies: {
            tp1: full_exit(tp1_at, tp1),
            tp2: full_exit(tp2_at, tp2),
            tp3: full_exit(tp3_at, tp3),
            scaleout,
        },
    };
};

const last_candle_time = (candles: candle[]): number =>
    candles.length > 0 ? candles[candles.length - 1]!.t : 0;
