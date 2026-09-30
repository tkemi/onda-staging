import type {hyperliquid_market, new_trade_setup} from "../db";
import {
    complete_ladder,
    expires_from,
    make_dedup_key,
    risk_reward_to_tp1,
    to_numeric,
    type direction,
} from "./setup_builder";

export type setup_source_name = "filter_mix" | "liquidity_hunt" | "signal_hub" | "futures_plan";

// The venue-neutral inputs every setup source reduces to before becoming a row. Pushed
// signals set entry_low == entry_high == entry_ref; futures-plan zones carry a real
// range with a reference mid.
export interface setup_row_input {
    source_type: setup_source_name;
    stream_id?: number | null;
    symbol: string;
    direction: direction;
    entry_low: number;
    entry_high: number;
    entry_ref: number;
    sl: number | null;
    raw_tps: [number | null, number | null, number | null];
    data: Record<string, unknown>;
    generated_at: Date;
    // extra dedup discriminator, e.g. a futures-plan timeframe
    dedup_extra?: string;
}

// Build the canonical trade-setup row: complete the TP ladder, tag levels, compute RR,
// key for dedup, and set the validity window. Shared by every perp setup source.
export const build_perp_setup_row = (
    input: setup_row_input,
    market: hyperliquid_market
): new_trade_setup => {
    const ladder = complete_ladder(input.direction, input.entry_ref, input.sl, input.raw_tps);
    const rr = risk_reward_to_tp1(input.entry_ref, input.sl, ladder.tp1.price);

    return {
        source_type: input.source_type,
        stream_id: input.stream_id ?? null,
        symbol: input.symbol,
        base_coin: market.base_coin,
        market_kind: "perp",
        hl_symbol: market.hl_symbol,
        hl_market_id: market.id,
        direction: input.direction,
        entry_low: to_numeric(input.entry_low),
        entry_high: to_numeric(input.entry_high),
        sl: input.sl !== null ? to_numeric(input.sl) : null,
        tp1: to_numeric(ladder.tp1.price),
        tp1_source: ladder.tp1.source,
        tp2: to_numeric(ladder.tp2.price),
        tp2_source: ladder.tp2.source,
        tp3: to_numeric(ladder.tp3.price),
        tp3_source: ladder.tp3.source,
        risk_reward: rr !== null ? to_numeric(rr) : null,
        data: input.data,
        dedup_key: make_dedup_key(
            market.base_coin,
            input.direction,
            input.entry_ref,
            input.sl,
            input.raw_tps,
            input.dedup_extra ?? ""
        ),
        generated_at: input.generated_at,
        expires_at: expires_from(input.generated_at, input.source_type),
    };
};
