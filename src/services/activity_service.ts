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

const base_activity = z.object({
    id: z.string(),
    status: z.enum(["pending", "failed", "confirmed"]),
    amount_wei: z.string(),
    token_address: z.string(),
    token_decimals: z.number().int(),
    token_symbol: z.string(),
    // epoch milliseconds, not an ISO string: a number the client can hand straight to
    // new Date() or compare without parsing
    created_at: z.number().int(),
    tx_hash: z.string(),
    sender: z.string().nullable(),
});

// A discriminated union, not one flat object: the next types (card on-ramp, trade,
// liquidation) carry completely different fields, and the client switches on `type`.
export const activity_schema = z.discriminatedUnion("type", [
    base_activity.extend({type: z.literal("deposit-on-chain")}),
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
export const to_activity_item = (row: activity): activity_item => ({
    id: row.id,
    type: row.type,
    status: row.status,
    created_at: row.occurred_at.getTime(),
    ...row.data,
});

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
