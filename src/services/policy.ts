import type {setup_event} from "./lifecycle";

// The policy layer: projects one canonical setup into a single user's plan, according to
// their settings. Pure and user-facing-shaped - the UI renders this, and (later) the
// execution layer acts on it. It never mutates the setup.

export type exit_style = "conservative" | "balanced" | "aggressive";
export type entry_style = "exact" | "zone" | "dca";
export type breakeven_trigger = "off" | "after_tp1" | "at_1r";

export interface user_settings {
    exit_style: exit_style;
    entry_style: entry_style;
    move_to_breakeven: breakeven_trigger;
    trailing_enabled: boolean;
    trailing_pct: number | null;
}

export const DEFAULT_SETTINGS: user_settings = {
    exit_style: "balanced",
    entry_style: "zone",
    move_to_breakeven: "after_tp1",
    trailing_enabled: true,
    trailing_pct: null,
};

// How much of the position to scale out at each TP, and what is left as a runner. Values
// are fractions of the full position and are provisional - the trading-style tuning is a
// product decision. A runner is whatever is not scaled out at the TPs.
const EXIT_ALLOCATIONS: Record<exit_style, {tp1: number; tp2: number; tp3: number}> = {
    conservative: {tp1: 0.4, tp2: 0.3, tp3: 0.3},   // fully exits at the TPs, no runner
    balanced: {tp1: 0.3, tp2: 0.3, tp3: 0.2},        // 20% runner
    aggressive: {tp1: 0.2, tp2: 0.2, tp3: 0.1},      // 50% runner
};

// default trailing distance for the runner when the user has not set one
const DEFAULT_TRAILING_PCT = 5;

export interface planned_exit {
    label: "tp1" | "tp2" | "tp3";
    price: number | null;
    size_pct: number;
}

export interface planned_runner {
    enabled: boolean;
    size_pct: number;
    trailing_pct: number;
}

export interface user_plan {
    entry_style: entry_style;
    entry_zone: {low: number; high: number};
    stop: number | null;
    exits: planned_exit[];
    runner: planned_runner;
    breakeven: breakeven_trigger;
}

export interface setup_levels {
    entry_low: number;
    entry_high: number;
    sl: number | null;
    tp1: number | null;
    tp2: number | null;
    tp3: number | null;
}

// Build the per-user plan for a setup. The runner size is whatever the TP allocations do
// not cover; when trailing is off, that remainder simply exits at TP3 instead of running.
export const plan_for_user = (setup: setup_levels, settings: user_settings): user_plan => {
    const alloc = EXIT_ALLOCATIONS[settings.exit_style];
    const runner_pct = Math.max(0, parseFloat((1 - (alloc.tp1 + alloc.tp2 + alloc.tp3)).toFixed(6)));
    const runner_enabled = settings.trailing_enabled && runner_pct > 0;

    const exits: planned_exit[] = [
        {label: "tp1", price: setup.tp1, size_pct: alloc.tp1},
        {label: "tp2", price: setup.tp2, size_pct: alloc.tp2},
        // if no runner, the remainder is taken at TP3
        {label: "tp3", price: setup.tp3, size_pct: runner_enabled ? alloc.tp3 : alloc.tp3 + runner_pct},
    ];

    return {
        entry_style: settings.entry_style,
        entry_zone: {low: setup.entry_low, high: setup.entry_high},
        stop: setup.sl,
        exits,
        runner: {
            enabled: runner_enabled,
            size_pct: runner_enabled ? runner_pct : 0,
            trailing_pct: settings.trailing_pct ?? DEFAULT_TRAILING_PCT,
        },
        breakeven: settings.move_to_breakeven,
    };
};

// Whether a given lifecycle event should notify this user. Everyone gets the decisive
// events; "armed" is a heads-up that only the exact-entry style benefits from.
export const should_notify = (event: setup_event, settings: user_settings): boolean => {
    if (event === "armed") {
        return settings.entry_style === "exact";
    }

    return true;
};
