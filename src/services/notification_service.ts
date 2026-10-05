import type {trade_setup} from "../db";
import type {setup_event} from "./lifecycle";
import {escape_html, send_ondemand_message, send_setup_message, send_spot_message} from "./telegram_service";
import {to_numeric} from "./setup_builder";

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

// An on-demand futures-plan setup -> its own channel, with a short plain-language
// explanation of what the message is and how to use it.
export const notify_ondemand_setup = async (
    setup: trade_setup,
    current_price?: number
): Promise<void> => {
    const strength = setup.seen_count >= 3 ? `  ⭐ strong (seen ${setup.seen_count}×)` : "";

    const lines = [
        `🧭 <b>On-Demand Futures Plan</b>${strength}`,
        "",
        ...setup_detail(setup, "Current price", current_price),
        "",
        "ℹ️ <i>A planned entry zone our partner generated on demand for this market and " +
        "timeframe. It is not live yet — wait for price to reach the entry zone before " +
        "entering. The targets marked <code>derived</code> are our own extension of the " +
        "partner's levels. The setup is invalid if price reaches the stop first.</i>",
    ];

    await send_ondemand_message(lines.join("\n"));
};

// A lifecycle transition (entry hit, invalidated, expired) - same full body as a new setup,
// with the event and the strategy in the header.
// --- spot / swing accumulation plans ---------------------------------------

interface spot_plan {
    current_price: number | null;
    buy_zones: unknown;
    sell_zones: unknown;
    summary: unknown;
}

const as_num = (value: unknown): number | null => {
    const n = typeof value === "number" ? value : Number(value);

    return isFinite(n) ? n : null;
};

const pct = (value: unknown): string => {
    const n = as_num(value);

    return n === null ? "?" : `${parseFloat(n.toPrecision(6))}%`;
};

const price_of = (value: unknown): string => {
    const n = as_num(value);

    return n === null ? "?" : to_numeric(n);
};

const zone_lines = (zones: unknown, sign: string): string[] => {
    const list = Array.isArray(zones) ? zones as Array<Record<string, unknown>> : [];

    return list.map((z) =>
        `   • ${sign}${pct(z.percent)} → ${price_of(z.price)}  <i>(${pct(z.allocationPct)} alloc)</i>`);
};

// A spot / swing accumulation plan -> the spot channel, with a plain-language explanation.
export const notify_spot_plan = async (base_coin: string, plan: spot_plan): Promise<void> => {
    const summary = (plan.summary && typeof plan.summary === "object"
        ? plan.summary : {}) as Record<string, unknown>;

    const lines = [`🌊 <b>Spot / Swing Plan</b> · ${escape_html(base_coin)}`, ""];

    if (plan.current_price !== null) {
        lines.push(`💰 Current price: <b>${price_of(plan.current_price)}</b>`, "");
    }

    const buys = zone_lines(plan.buy_zones, "−");
    const sells = zone_lines(plan.sell_zones, "+");

    if (buys.length > 0) {
        lines.push("🟢 <b>Buy zones</b> (ladder in as price dips):", ...buys, "");
    }

    if (sells.length > 0) {
        lines.push("🔴 <b>Sell zones</b> (scale out as price rises):", ...sells, "");
    }

    const plan_bits: string[] = [];
    if (summary.deployedPct != null) plan_bits.push(`deploy ${pct(summary.deployedPct)}`);
    if (summary.reservePct != null) plan_bits.push(`reserve ${pct(summary.reservePct)}`);

    if (plan_bits.length > 0) {
        lines.push(plan_bits.join("  ·  "));
    }

    lines.push(
        "",
        "ℹ️ <i>A longer-horizon accumulation plan, not a timed entry. Ladder into the buy " +
        "zones as price dips (allocate the shown % of your spot budget at each level), and " +
        "scale out into the sell zones as it rises. The reserve is kept for deeper dips.</i>",
    );

    await send_spot_message(lines.join("\n"));
};

export const notify_setup_event = async (
    setup: trade_setup,
    event: setup_event,
    price: number,
    reason?: string
): Promise<void> => {
    const lines = [`${EVENT_HEADER[event]} · ${SOURCE_LABEL[setup.source_type]}`];

    // explain why the setup was invalidated
    if (reason) {
        lines.push(`⚠️ ${reason}`);
    }

    lines.push("", ...setup_detail(setup, "Price", price));

    // keep each setup's events in the same channel its creation went to
    const send = setup.source_type === "futures_plan" ? send_ondemand_message : send_setup_message;
    await send(lines.join("\n"));
};
