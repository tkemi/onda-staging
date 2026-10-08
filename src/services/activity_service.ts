import {SQL, and, desc, eq} from "drizzle-orm";
import {z} from "zod";
import {activities, activity_type, db, type activity, type activity_data_by_type} from "../db";

// Every activity type the enum knows about. Tied to activity_data_by_type rather than
// spelled out, so nothing here can fall behind a newly added type.
export type activity_type_name = keyof activity_data_by_type;

// The enum's values as a plain tuple, for validating a query string against them.
// Derived from the pgEnum so a new type needs no second edit.
export const activity_type_names = activity_type.enumValues;

// What the feed can be narrowed by. Every field optional: absent means "no filter".
export interface activity_filter {
    type?: activity_type_name;
}

// --- the response contract -------------------------------------------------

// What EVERY activity carries, whatever its kind.
const base_event = z.object({
    id: z.string(),
    status: z.enum(["pending", "failed", "confirmed"]),
    // epoch SECONDS, not milliseconds and not an ISO string. The client multiplies by
    // 1000 for new Date(); a value near 1.79e9 is seconds, near 1.79e12 is milliseconds.
    created_at: z.number().int(),
});

// Movements of an ERC-20 across a chain: they have a token, and an amount in that token's
// smallest unit. Perp events below do NOT - a perp is not a token and there is no contract
// to read decimals from - so they build on base_event instead.
const base_activity = base_event.extend({
    amount_wei: z.string(),
    token_address: z.string(),
    token_decimals: z.number().int(),
    token_symbol: z.string(),
    tx_hash: z.string().nullable(),
});

// Shared by both perp events. Amounts here are DECIMAL strings exactly as hyperliquid
// quotes them ("0.0194" ETH, "2567.7" USD), not base units - but still strings, because a
// JSON number is a double and would lose digits. The client renders them as-is.
const base_perp = base_event.extend({
    // the market as hyperliquid names it: "BTC", "ETH", "HYPE". A HIP-3 builder market is
    // prefixed with its dex, e.g. "xyz:SP500"
    coin: z.string(),
    direction: z.enum(["long", "short"]),
    // absolute, never negative - `direction` carries the sign
    size: z.string(),
    // the leverage the position was opened at: 10 for a 10x long. Null when it was never
    // observed - leverage lives only in clearinghouseState and only while the position is
    // open, so anything that closed before we were watching has none, permanently.
    leverage: z.number().int().nullable(),
    // a HyperCore transaction hash. It resolves on hyperliquid's explorer and on NO evm
    // explorer, so this must not be rendered as an etherscan/arbiscan link
    tx_hash: z.string().nullable(),
});

// A discriminated union, not one flat object: each type carries its own fields, and the
// client switches on `type`. A deposit names who sent it; a withdrawal names where it went.
export const activity_schema = z.discriminatedUnion("type", [
    base_activity.extend({
        type: z.literal("deposit-on-chain"),
        sender: z.string().nullable(),
    }),
    base_activity.extend({
        type: z.literal("withdraw-on-chain"),
        destination: z.string(),
        // optional here, unlike a deposit's, per the shape the frontend consumes
        tx_hash: z.string().nullish(),
    }),
    base_perp.extend({
        type: z.literal("open-position"),
        // size-weighted average over every fill that built the position
        entry_price: z.string(),
        // collateral committed at entry: (size x entry_price) / leverage. Null when the
        // leverage was never observed
        margin: z.string().nullable(),
        // what the OPENING fills cost; the close row's `fees` is the position total
        fees: z.string(),
    }),
    base_perp.extend({
        type: z.literal("close-position"),
        // both ends of the trade on one row
        entry_price: z.string(),
        exit_price: z.string(),
        // fees paid over this position's fills, positive
        fees: z.string(),
        // gross_pnl - fees, and THE number to show the user. Every one of our first four
        // real trades was a net loss while three were gross wins - taker fees decide small
        // trades, so these cannot be collapsed into one figure.
        realized_pnl: z.string(),
        // the same figure as a percentage of the ENTRY NOTIONAL (size x entry_price), to
        // 4 decimals: "-0.1103". Leverage-free, so present on every close. NOT the figure
        // hyperliquid's own ui shows - that divides by margin, so at 10x it reads ten
        // times larger; derive that client-side from `leverage` if you want to match.
        realized_pnl_pct: z.string(),
    }),
    // A FORCED close. Identical fields to close-position: the type is the whole
    // difference, so the feed renders it differently with no flag to read. Covers both of
    // hyperliquid's liquidation methods, market and backstop.
    base_perp.extend({
        type: z.literal("liquidate-position"),
        entry_price: z.string(),
        exit_price: z.string(),
        fees: z.string(),
        realized_pnl: z.string(),
        realized_pnl_pct: z.string(),
    }),
]);

export const activity_response_schema = z.object({
    status: z.literal("ok"),
    activities: z.array(activity_schema),
});

export type activity_item = z.infer<typeof activity_schema>;
export type activity_response = z.infer<typeof activity_response_schema>;

// --- reading ---------------------------------------------------------------

// No per-field mapping: `data` is stored under the names the frontend reads, so a row
// becomes a response item by spreading it over the four columns the feed owns. A new
// activity type needs nothing here - whatever its `data` holds is what it serves.
//
// The cast is the one place the type/data correlation is asserted: every writer sets them
// together, but a jsonb column cannot tell the compiler which shape goes with which type.
export const to_activity_item = (row: activity): activity_item => ({
    // the id column is a numeric auto-increment; the feed contract keeps it a string
    id: row.id.toString(),
    type: row.type,
    status: row.status,
    // seconds, floored - occurred_at is a millisecond-precision timestamp and the API
    // contract is seconds
    created_at: Math.floor(row.occurred_at.getTime() / 1000),
    ...row.data,
} as activity_item);

export const get_activity = async (
    privy_address: string,
    filter: activity_filter = {}
): Promise<activity_item[]> => {
    // Optional filters in drizzle are a list of conditions spread into and(): push the
    // ones that apply, skip the ones that do not. No string building, and each push is
    // type-checked against the column it compares.
    const conditions: SQL[] = [
        eq(activities.privy_address, privy_address.toLowerCase()),
    ];

    if (filter.type) {
        conditions.push(eq(activities.type, filter.type));
    }

    // id breaks ties so the order is deterministic when two events share a timestamp
    const rows = await db
        .select()
        .from(activities)
        .where(and(...conditions))
        .orderBy(desc(activities.occurred_at), desc(activities.id));

    return rows.map(to_activity_item);
};
