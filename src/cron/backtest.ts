import {gte, ne, and} from "drizzle-orm";
import {
    backtest_results,
    backtest_runs,
    backtest_summary,
    close_db,
    db,
    trade_setups,
    type new_backtest_result,
    type new_backtest_summary_row,
    type trade_setup,
} from "../db";
import {
    DEFAULT_OPTS,
    fetch_candles,
    simulate,
    type bt_mode,
    type candle,
    type sim_result,
} from "../services";
import dotenv from "dotenv";
dotenv.config();

const WINDOW_DAYS = Number(process.env.BACKTEST_WINDOW_DAYS ?? 7);
const INTERVAL = process.env.BACKTEST_INTERVAL ?? "1m";
const PERSIST = process.env.BACKTEST_PERSIST !== "false";
const MODES: bt_mode[] = ["as_traded", "take_all"];
const POLICIES = ["tp1", "tp2", "tp3", "scaleout"] as const;

const num = (v: number | null): string | null => (v === null ? null : String(Number(v.toFixed(6))));
const pct = (hit: number, total: number): number => (total > 0 ? hit / total : 0);

interface sim_row {
    setup: trade_setup;
    mode: bt_mode;
    result: sim_result;
}

// --- concurrency: max & time-weighted average open positions over the window ------------
const concurrency = (
    intervals: Array<[number, number]>,
    window_start: number,
    window_end: number
): {max: number; avg: number} => {
    const events: Array<[number, number]> = [];
    for (const [a, b] of intervals) {
        events.push([a, 1], [Math.max(a, b), -1]);
    }
    events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);

    let running = 0;
    let max = 0;
    let area = 0;
    let last = window_start;

    for (const [t, delta] of events) {
        area += running * (t - last);
        last = t;
        running += delta;
        max = Math.max(max, running);
    }
    area += running * (window_end - last);

    const span = Math.max(1, window_end - window_start);
    return {max, avg: area / span};
};

// --- aggregate one (source_type, mode) group into a summary row -------------------------
const summarize = (
    run_id: number,
    source_type: string,
    mode: bt_mode,
    rows: sim_row[],
    window_start: number,
    window_end: number
): new_backtest_summary_row => {
    const total = rows.length;
    const entered = rows.filter((r) => r.result.entered);
    const inv = rows.filter((r) => r.result.outcome === "invalidated").length;
    const exp = rows.filter((r) => r.result.outcome === "expired").length;
    const no_entry = rows.filter((r) => r.result.outcome === "no_entry").length;
    const open = entered.filter((r) => r.result.outcome === "open").length;

    const cnt_sl = entered.filter((r) => r.result.outcome === "sl").length;
    const cnt_tp1 = entered.filter((r) => r.result.max_tp >= 1).length;
    const cnt_tp2 = entered.filter((r) => r.result.max_tp >= 2).length;
    const cnt_tp3 = entered.filter((r) => r.result.max_tp >= 3).length;
    const tps_hit = entered.reduce((s, r) => s + r.result.max_tp, 0);

    // partner vs derived: count hit TPs by the source of each hit level
    let partner_hits = 0;
    let derived_hits = 0;
    for (const r of entered) {
        const src = [r.setup.tp1_source, r.setup.tp2_source, r.setup.tp3_source];
        const hit = [r.result.tp1_at_ms, r.result.tp2_at_ms, r.result.tp3_at_ms];
        for (let i = 0; i < 3; i++) {
            if (hit[i] !== null) {
                if (src[i] === "partner") partner_hits++;
                else if (src[i] === "derived") derived_hits++;
            }
        }
    }

    const times = entered
        .map((r) => (r.result.entry_at_ms! - r.setup.generated_at.getTime()) / 60000)
        .filter((m) => isFinite(m));
    const avg_tte = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;

    // per-policy aggregates
    const policies: Record<string, unknown> = {};
    for (const p of POLICIES) {
        const vals = entered.map((r) => r.result.policies[p]);
        const usd = vals.reduce((s, v) => s + v.usd, 0);
        const rs = vals.map((v) => v.r).filter((x): x is number => x !== null);
        const r_total = rs.reduce((a, b) => a + b, 0);
        const pct_total = vals.reduce((s, v) => s + v.pct, 0);
        const wins = vals.filter((v) => v.usd > 0).length;
        const gross_win = vals.filter((v) => v.usd > 0).reduce((s, v) => s + v.usd, 0);
        const gross_loss = Math.abs(vals.filter((v) => v.usd < 0).reduce((s, v) => s + v.usd, 0));

        // partner/derived split by the target TP's source (tp1/2/3 policies only)
        let usd_partner = 0;
        let usd_derived = 0;
        if (p !== "scaleout") {
            const idx = p === "tp1" ? 0 : p === "tp2" ? 1 : 2;
            for (const r of entered) {
                const src = [r.setup.tp1_source, r.setup.tp2_source, r.setup.tp3_source][idx];
                if (src === "partner") usd_partner += r.result.policies[p].usd;
                else if (src === "derived") usd_derived += r.result.policies[p].usd;
            }
        }

        policies[p] = {
            total_r: Number(r_total.toFixed(4)),
            avg_r: rs.length ? Number((r_total / rs.length).toFixed(4)) : null,
            total_pct: Number(pct_total.toFixed(2)),
            total_usd: Number(usd.toFixed(2)),
            avg_usd: entered.length ? Number((usd / entered.length).toFixed(2)) : 0,
            win_rate: Number(pct(wins, entered.length).toFixed(4)),
            profit_factor: gross_loss > 0 ? Number((gross_win / gross_loss).toFixed(3)) : null,
            usd_partner: Number(usd_partner.toFixed(2)),
            usd_derived: Number(usd_derived.toFixed(2)),
        };
    }

    const intervals: Array<[number, number]> = entered
        .filter((r) => r.result.entry_at_ms !== null)
        .map((r) => [r.result.entry_at_ms!, r.result.resolved_at_ms ?? window_end]);
    const conc = concurrency(intervals, window_start, window_end);

    return {
        run_id, source_type, mode,
        total, entered: entered.length, invalidated: inv, expired: exp, no_entry, open_trades: open,
        entry_rate: num(pct(entered.length, total)),
        avg_time_to_entry_min: num(avg_tte),
        cnt_sl, cnt_tp1, cnt_tp2, cnt_tp3,
        avg_tps_hit: num(entered.length ? tps_hit / entered.length : 0),
        partner_tp_hits: partner_hits,
        derived_tp_hits: derived_hits,
        max_concurrent: conc.max,
        avg_concurrent: num(conc.avg),
        implied_capital_usd: num(conc.max * DEFAULT_OPTS.margin_usd),
        policies,
    };
};

const to_detail = (run_id: number, row: sim_row): new_backtest_result => {
    const {setup, mode, result} = row;
    return {
        run_id, setup_id: setup.id, source_type: setup.source_type, mode, direction: setup.direction,
        entered: result.entered,
        entry_at: result.entry_at_ms ? new Date(result.entry_at_ms) : null,
        time_to_entry_min: result.entry_at_ms
            ? num((result.entry_at_ms - setup.generated_at.getTime()) / 60000) : null,
        sl_hit: result.sl_at_ms !== null,
        tp1_hit: result.tp1_at_ms !== null,
        tp2_hit: result.tp2_at_ms !== null,
        tp3_hit: result.tp3_at_ms !== null,
        sl_at: result.sl_at_ms ? new Date(result.sl_at_ms) : null,
        tp1_at: result.tp1_at_ms ? new Date(result.tp1_at_ms) : null,
        tp2_at: result.tp2_at_ms ? new Date(result.tp2_at_ms) : null,
        tp3_at: result.tp3_at_ms ? new Date(result.tp3_at_ms) : null,
        max_tp: result.max_tp,
        mae_r: num(result.mae_r),
        mfe_r: num(result.mfe_r),
        outcome: result.outcome,
        resolved_at: result.resolved_at_ms ? new Date(result.resolved_at_ms) : null,
        tp1_source: setup.tp1_source,
        tp2_source: setup.tp2_source,
        tp3_source: setup.tp3_source,
        policies: result.policies,
    };
};

const report = (summaries: new_backtest_summary_row[]): void => {
    for (const s of summaries) {
        const p = s.policies as Record<string, {total_usd: number; win_rate: number}>;
        const usd = (k: string): string => (p[k]?.total_usd ?? 0).toString();
        const win1 = ((p.tp1?.win_rate ?? 0) * 100).toFixed(0);
        console.log(
            `\n[${s.source_type} · ${s.mode}] total ${s.total} | entered ${s.entered} ` +
            `(inv ${s.invalidated}, exp ${s.expired}, no-entry ${s.no_entry}, open ${s.open_trades})`);
        console.log(
            `  SL ${s.cnt_sl} · TP1 ${s.cnt_tp1} · TP2 ${s.cnt_tp2} · TP3 ${s.cnt_tp3} | avg TPs ${s.avg_tps_hit}` +
            ` | partner/derived TP hits ${s.partner_tp_hits}/${s.derived_tp_hits}`);
        console.log(
            `  PnL $ (100@5x): TP1 ${usd("tp1")} · TP2 ${usd("tp2")} · TP3 ${usd("tp3")} ` +
            `· scale ${usd("scaleout")} | win% TP1 ${win1}`);
        console.log(
            `  concurrency: max ${s.max_concurrent} (≈$${s.implied_capital_usd} margin), avg ${s.avg_concurrent}`);
    }
};

export const run_backtest = async (): Promise<void> => {
    const now = Date.now();
    const window_start = now - WINDOW_DAYS * 86_400_000;

    // all setups generated in the window, excluding superseded (they are near-duplicates of
    // a kept setup, so backtesting them would double-count)
    const setups = await db
        .select()
        .from(trade_setups)
        .where(and(gte(trade_setups.generated_at, new Date(window_start)), ne(trade_setups.status, "superseded")));

    console.log(`[backtest] ${setups.length} setups in last ${WINDOW_DAYS}d`);

    // group by coin so candles are fetched once per coin
    const by_coin = new Map<string, trade_setup[]>();
    for (const s of setups) {
        const list = by_coin.get(s.hl_symbol) ?? [];
        list.push(s);
        by_coin.set(s.hl_symbol, list);
    }

    const sim_rows: sim_row[] = [];

    for (const [coin, list] of by_coin) {
        let candles: candle[];
        try {
            candles = await fetch_candles(coin, INTERVAL, window_start, now);
        } catch (error: unknown) {
            console.error(`[backtest] candles failed for ${coin}, skipping:`, error);
            continue;
        }

        if (candles.length === 0) {
            continue;
        }

        for (const setup of list) {
            const gen = setup.generated_at.getTime();
            const slice = candles.filter((c) => c.t >= gen);
            const sim_setup = {
                direction: setup.direction,
                entry_low: Number(setup.entry_low),
                entry_high: Number(setup.entry_high),
                sl: setup.sl !== null ? Number(setup.sl) : null,
                tp1: setup.tp1 !== null ? Number(setup.tp1) : null,
                tp2: setup.tp2 !== null ? Number(setup.tp2) : null,
                tp3: setup.tp3 !== null ? Number(setup.tp3) : null,
                generated_at_ms: gen,
                expires_at_ms: setup.expires_at ? setup.expires_at.getTime() : null,
            };

            for (const mode of MODES) {
                sim_rows.push({setup, mode, result: simulate(sim_setup, slice, mode, DEFAULT_OPTS)});
            }
        }
    }

    // group by (source_type, mode) for summaries
    const groups = new Map<string, sim_row[]>();
    for (const row of sim_rows) {
        const key = `${row.setup.source_type}|${row.mode}`;
        const list = groups.get(key) ?? [];
        list.push(row);
        groups.set(key, list);
    }

    let run_id = 0;
    if (PERSIST) {
        const [run] = await db.insert(backtest_runs).values({
            window_start: new Date(window_start),
            window_end: new Date(now),
            params: {...DEFAULT_OPTS, interval: INTERVAL, window_days: WINDOW_DAYS},
        }).returning();
        run_id = run!.id;
    }

    const summaries: new_backtest_summary_row[] = [];
    for (const [key, rows] of groups) {
        const [source_type, mode] = key.split("|") as [string, bt_mode];
        summaries.push(summarize(run_id, source_type, mode, rows, window_start, now));
    }

    if (PERSIST) {
        // detail rows in chunks
        const details = sim_rows.map((r) => to_detail(run_id, r));
        for (let i = 0; i < details.length; i += 500) {
            await db.insert(backtest_results).values(details.slice(i, i + 500));
        }
        if (summaries.length > 0) {
            await db.insert(backtest_summary).values(summaries);
        }
        console.log(`[backtest] run ${run_id} stored: ${details.length} detail rows, ${summaries.length} summaries`);
    }

    report(summaries);
};

if (require.main === module) {
    run_backtest()
        .then(() => close_db())
        .then(() => process.exit(0))
        .catch((error: unknown) => {
            console.error("[backtest] failed:", error);
            void close_db().finally(() => process.exit(1));
        });
}
