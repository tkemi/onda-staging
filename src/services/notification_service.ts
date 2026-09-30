import type {trade_setup} from "../db";
import type {setup_event} from "./lifecycle";
import {escape_html, send_setup_message} from "./telegram_service";

// Processed, user-facing messages -> the setups Telegram channel. Two kinds:
//   - notify_new_setup: a fresh setup, formatted the way a user would see it in the UI
//   - notify_setup_event: a lifecycle transition (entry hit, invalidated, ...)
// Per-user routing (only the users following a setup, shaped by their settings) is future.

const SOURCE_LABEL: Record<trade_setup["source_type"], string> = {
    filter_mix: "Filter Mix",
    liquidity_hunt: "Liquidity Hunt",
    signal_hub: "Signal Hub",
    futures_plan: "Futures Plan",
};

const EVENT_HEADER: Record<setup_event, string> = {
    armed: "⏳ <b>Approaching entry</b>",
    triggered: "🎯 <b>Entry hit — time to enter</b>",
    invalidated: "❌ <b>Invalidated</b>",
    expired: "⌛ <b>Expired</b>",
};

// strip the numeric(40,20) trailing zeros for display, keeping full decimal form
const trim = (value: string | null): string => {
    if (value === null) {
        return "—";
    }

    return value.includes(".")
        ? value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")
        : value;
};

const dot = (direction: string): string => (direction === "long" ? "🟢" : "🔴");

const entry_str = (setup: trade_setup): string =>
    setup.entry_low === setup.entry_high
        ? trim(setup.entry_low)
        : `${trim(setup.entry_low)} – ${trim(setup.entry_high)}`;

const header = (setup: trade_setup): string =>
    `${dot(setup.direction)} ${setup.direction.toUpperCase()} · <b>${escape_html(setup.base_coin)}</b> (${escape_html(setup.hl_symbol)})`;

// a TP line with its partner/derived provenance
const tp_line = (label: string, price: string | null, source: string | null): string =>
    `${label} ${trim(price)}${source ? ` <i>(${source})</i>` : ""}`;

// small type-specific context line (confidence/score, timeframe, ...)
const context_line = (setup: trade_setup): string | null => {
    const d = (setup.data ?? {}) as Record<string, unknown>;
    const parts: string[] = [];

    if (d.confidence) {
        parts.push(`Confidence ${escape_html(String(d.confidence))}${d.score != null ? ` (score ${escape_html(String(d.score))})` : ""}`);
    }

    if (d.signalType && setup.source_type === "signal_hub") {
        parts.push(escape_html(String(d.signalType)));
    }

    if (d.timeframe) {
        parts.push(`TF ${escape_html(String(d.timeframe))}`);
    }

    if (d.strength) {
        parts.push(escape_html(String(d.strength)));
    }

    return parts.length ? parts.join(" · ") : null;
};

// Format a setup the way a user sees it: entry, stop, the full TP ladder (with which
// levels are the partner's vs our derived ones), and RR.
export const notify_new_setup = async (setup: trade_setup): Promise<void> => {
    const lines = [
        `📋 <b>New ${SOURCE_LABEL[setup.source_type]} setup</b>`,
        header(setup),
        `Entry: <b>${entry_str(setup)}</b>`,
        `Stop: ${trim(setup.sl)}`,
        tp_line("TP1", setup.tp1, setup.tp1_source),
        tp_line("TP2", setup.tp2, setup.tp2_source),
        tp_line("TP3", setup.tp3, setup.tp3_source),
    ];

    if (setup.risk_reward !== null) {
        lines.push(`R:R ${trim(setup.risk_reward)}`);
    }

    const context = context_line(setup);

    if (context) {
        lines.push(context);
    }

    await send_setup_message(lines.join("\n"));
};

export const notify_setup_event = async (
    setup: trade_setup,
    event: setup_event,
    price: number
): Promise<void> => {
    const lines = [
        EVENT_HEADER[event],
        header(setup),
        `Price: ${price}`,
        `Entry: ${entry_str(setup)}`,
    ];

    if (event === "triggered") {
        lines.push(
            `Stop: ${trim(setup.sl)}`,
            `TP1 ${trim(setup.tp1)} · TP2 ${trim(setup.tp2)} · TP3 ${trim(setup.tp3)}`,
        );
    }

    await send_setup_message(lines.join("\n"));
};
