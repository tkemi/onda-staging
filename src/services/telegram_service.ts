// Posts to private Telegram channels via the Bot API. The bot must be an ADMIN of each
// channel (with "Post Messages"). Three channels:
//   TELEGRAM_CHAT_ID           - raw incoming partner signals (ops/debug view)
//   TELEGRAM_SETUPS_CHAT_ID    - processed, user-facing pushed-signal setups + lifecycle
//   TELEGRAM_ONDEMAND_CHAT_ID  - on-demand (futures-plan) setups
//   TELEGRAM_SPOT_CHAT_ID      - spot / swing accumulation plans
// The setups channel falls back to TELEGRAM_CHAT_ID when unset, so one channel still works.
// The on-demand and spot channels do NOT fall back: if unset, those messages are simply not
// posted (the data still lands in the DB), so nothing appears until you configure them.

const API_BASE = "https://api.telegram.org";

const raw_chat = (): string | undefined => process.env.TELEGRAM_CHAT_ID;

const setups_chat = (): string | undefined =>
    process.env.TELEGRAM_SETUPS_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID;

const ondemand_chat = (): string | undefined => process.env.TELEGRAM_ONDEMAND_CHAT_ID;

const spot_chat = (): string | undefined => process.env.TELEGRAM_SPOT_CHAT_ID;

// Telegram's HTML parse_mode only treats & < > specially, so escaping those three is
// enough to keep arbitrary partner text from breaking the message.
const escape_html = (value: string): string =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

type json = Record<string, unknown>;

// Trim float artifacts (e.g. 9.959249999999999 -> 9.95925) without rounding away real
// precision - low-priced coins need many decimals, so we normalise to 12 significant
// figures and let JS drop trailing zeros.
const clean_number = (value: unknown): string => {
    if (typeof value !== "number" || !isFinite(value)) {
        return escape_html(String(value ?? ""));
    }

    return String(parseFloat(value.toPrecision(12)));
};

const num = (value: unknown): number | null =>
    typeof value === "number" && isFinite(value) ? value : null;

// A LONG/SHORT direction rendered with a colour dot; anything else passes through.
const direction_line = (direction: unknown): string => {
    const value = String(direction ?? "").toUpperCase();
    const emoji = value === "LONG" ? "🟢" : value === "SHORT" ? "🔴" : "";

    return `${emoji} ${escape_html(value || "SIGNAL")}`.trim();
};

// generatedAt (ISO) -> "2026-09-25 14:48 UTC"; empty when absent or unparseable.
const format_time = (iso: unknown): string => {
    if (typeof iso !== "string") {
        return "";
    }

    const at = new Date(iso);

    if (isNaN(at.getTime())) {
        return "";
    }

    const pad = (n: number) => String(n).padStart(2, "0");

    return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())} ` +
        `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`;
};

// Entry / stop / targets shared by the two trade-setup signals. A price of 0 means the
// partner did not set that level, so it is omitted rather than shown as "0".
const levels_block = (data: json): string => {
    const lines: string[] = [];
    const entry = num(data.entryPrice);
    const sl = num(data.slPrice);

    if (entry !== null) {
        lines.push(`Entry: <b>${clean_number(entry)}</b>`);
    }

    if (sl !== null && sl !== 0) {
        lines.push(`Stop loss: ${clean_number(sl)}`);
    }

    const targets = [data.tp1Price, data.tp2Price, data.tp3Price]
        .map((value, i) => {
            const price = num(value);

            return price !== null && price !== 0 ? ` • TP${i + 1}: ${clean_number(price)}` : null;
        })
        .filter((line): line is string => line !== null);

    if (targets.length > 0) {
        lines.push("Targets:", ...targets);
    }

    return lines.join("\n");
};

const symbol_of = (data: json): string => escape_html(String(data.symbol ?? "?"));

const format_filter_mix = (data: json): string =>
    [
        `${direction_line(data.direction)} · <b>${symbol_of(data)}</b>`,
        "<i>Filter Mix Signal</i>",
        "",
        levels_block(data),
    ].join("\n");

const format_liquidity_hunt = (data: json): string => {
    const meta: string[] = ["<i>Liquidity Hunt Signal</i>"];

    if (data.confidence) {
        const score = num(data.score);
        meta.push(`Confidence: <b>${escape_html(String(data.confidence))}</b>` +
            (score !== null ? ` (score ${clean_number(score)})` : ""));
    }

    if (data.liquidationSide) {
        meta.push(`Hunting ${escape_html(String(data.liquidationSide))} liquidity`);
    }

    return [
        `${direction_line(data.signalType)} · <b>${symbol_of(data)}</b>`,
        ...meta,
        "",
        levels_block(data),
    ].join("\n");
};

// An indicator alert, not a trade setup: no entry/stop/targets, just the reading.
const format_signal_hub = (data: json): string => {
    const lines = [
        `📡 <b>${symbol_of(data)}</b> · Signal Hub`,
        `<i>${escape_html(String(data.signalType ?? "Signal"))}</i>`,
        "",
    ];

    if (num(data.price) !== null) {
        lines.push(`Price: <b>${clean_number(data.price)}</b>`);
    }

    if (num(data.ema10) !== null) {
        lines.push(`EMA 10: ${clean_number(data.ema10)}`);
    }

    if (num(data.ema20) !== null) {
        lines.push(`EMA 20: ${clean_number(data.ema20)}`);
    }

    return lines.join("\n");
};

// Turn a raw delivery into a readable, per-type Telegram message. Only whitelisted
// fields are rendered, so the partner's authToken is never echoed into the channel. An
// unknown type still comes through, as its data pretty-printed, so a new signal type is
// visible immediately rather than silently dropped.
const format_signal = (partner: string, raw: string): string => {
    let payload: json | null = null;

    try {
        const parsed = JSON.parse(raw);
        payload = parsed && typeof parsed === "object" ? parsed as json : null;
    } catch {
        // handled below
    }

    if (!payload) {
        return `📊 <b>New signal</b> from <b>${escape_html(partner)}</b>\n<pre>${escape_html(raw)}</pre>`;
    }

    const type = String(payload.type ?? "");
    const data = payload.data && typeof payload.data === "object" ? payload.data as json : {};

    let body: string;

    switch (type) {
        case "FILTER_MIX_SIGNAL":
            body = format_filter_mix(data);
            break;
        case "LIQUIDITY_HUNT_SIGNAL":
            body = format_liquidity_hunt(data);
            break;
        case "SIGNAL_HUB_SIGNAL":
            body = format_signal_hub(data);
            break;
        default:
            body = `<b>${escape_html(type || "Signal")}</b>\n<pre>${escape_html(JSON.stringify(data, null, 2))}</pre>`;
    }

    const time = format_time(payload.generatedAt);

    return time ? `${body}\n\n🕒 ${time}` : body;
};

const post_message = async (text: string, chat_id: string | undefined): Promise<boolean> => {
    const token = process.env.TELEGRAM_BOT_TOKEN;

    if (!token || !chat_id) {
        console.warn("[telegram] TELEGRAM_BOT_TOKEN or chat id missing, not sending");

        return false;
    }

    try {
        const response = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                chat_id: chat_id,
                text: text,
                parse_mode: "HTML",
                // signals are one per line already; no link previews to clutter them
                disable_web_page_preview: true,
            }),
        });

        if (response.ok) {
            return true;
        }

        // Telegram returns a JSON body with a human description on failure (bad token,
        // bot not an admin, wrong chat_id), which is exactly what we want in the logs.
        console.error(`[telegram] sendMessage failed (${response.status}): ${await response.text()}`);

        return false;
    } catch (error: unknown) {
        console.error("[telegram] sendMessage error:", error);

        return false;
    }
};

// Fire-and-forget notification for a raw partner delivery -> the raw-signals channel.
// Never throws: a Telegram outage must not affect ingestion.
export const send_analysis_signal = async (partner: string, raw: string): Promise<void> => {
    await post_message(format_signal(partner, raw), raw_chat());
};

// Send a processed, user-facing message (a new setup, or a lifecycle event) -> the setups
// channel. Callers build their own HTML and escape dynamic parts with escape_html.
export const send_setup_message = (text: string): Promise<boolean> => post_message(text, setups_chat());

// Send an on-demand (futures-plan) setup -> the on-demand channel. No fallback: skipped
// when TELEGRAM_ONDEMAND_CHAT_ID is unset.
export const send_ondemand_message = (text: string): Promise<boolean> => post_message(text, ondemand_chat());

// Send a spot / swing accumulation plan -> the spot channel. No fallback: skipped when
// TELEGRAM_SPOT_CHAT_ID is unset.
export const send_spot_message = (text: string): Promise<boolean> => post_message(text, spot_chat());

export {escape_html};
