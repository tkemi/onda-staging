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

const header = (setup: trade_setup): string => {
    // only show the venue symbol when it differs from the coin (e.g. spot "PURR/USDC")
    const venue = setup.hl_symbol !== setup.base_coin ? ` (${escape_html(setup.hl_symbol)})` : "";

    return `${dot(setup.direction)} <b>${escape_html(setup.base_coin)}</b> · ${setup.direction.toUpperCase()}${venue}`;
};

// a TP line with its partner/derived provenance
const tp_line = (label: string, price: string | null, source: string | null): string =>
    `${label}: ${trim(price)}${source ? ` <i>(${source})</i>` : ""}`;

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

// The shared message body used by both new-setup and lifecycle-event messages, so every
// message looks the same: coin/direction, price, entry, stop, the full TP ladder (with each
// level tagged partner/derived), and an RR + context footer. Blank strings render as blank
// lines for breathing room in Telegram.
const setup_detail = (
    setup: trade_setup,
    price_label: string,
    price?: number
): string[] => {
    const lines = [header(setup)];

    if (price !== undefined) {
        lines.push(`💰 ${price_label}: <b>${price}</b>`);
    }

    lines.push(
        "",
        `🎯 Entry: <b>${entry_str(setup)}</b>`,
        `🛑 Stop: ${trim(setup.sl)}`,
        "",
        "📈 Targets:",
        `   • ${tp_line("TP1", setup.tp1, setup.tp1_source)}`,
        `   • ${tp_line("TP2", setup.tp2, setup.tp2_source)}`,
        `   • ${tp_line("TP3", setup.tp3, setup.tp3_source)}`,
    );

    const footer: string[] = [];

    if (setup.risk_reward !== null) {
        footer.push(`R:R ${trim(setup.risk_reward)}`);
    }

    const context = context_line(setup);

    if (context) {
        footer.push(context);
    }

    if (footer.length > 0) {
        lines.push("", footer.join(" · "));
    }

    return lines;
};

// A freshly-created setup, the way a user sees it in the UI.
export const notify_new_setup = async (
    setup: trade_setup,
    current_price?: number
): Promise<void> => {
    const lines = [
        `📋 <b>New Setup</b> · ${SOURCE_LABEL[setup.source_type]}`,
        "",
        ...setup_detail(setup, "Current price", current_price),
    ];

    await send_setup_message(lines.join("\n"));
};

// A lifecycle transition (entry hit, invalidated, expired) - same full body as a new setup,
// with the event and the strategy in the header.
export const notify_setup_event = async (
    setup: trade_setup,
    event: setup_event,
    price: number
): Promise<void> => {
    const lines = [
        `${EVENT_HEADER[event]} · ${SOURCE_LABEL[setup.source_type]}`,
        "",
        ...setup_detail(setup, "Price", price),
    ];

    await send_setup_message(lines.join("\n"));
};
