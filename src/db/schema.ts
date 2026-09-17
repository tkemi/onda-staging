import {index, numeric, pgTable, text, timestamp, uniqueIndex, uuid} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
    id: uuid("id").primaryKey().defaultRandom(),
    privy_user_id: text("privy_user_id").notNull().unique(),
    privy_address: text("privy_address").notNull().unique(),
    user_address: text("user_address").notNull().unique(),
    user_private_key: text("user_private_key").notNull(),
    created_at: timestamp("created_at", {withTimezone: true}).notNull().defaultNow(),
});

export type user = typeof users.$inferSelect;
export type new_user = typeof users.$inferInsert;

export const deposits = pgTable(
    "deposits",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        user_id: uuid("user_id")
            .notNull()
            .references(() => users.id, {onDelete: "cascade"}),
        asset: text("asset").notNull(),
        chain_caip2: text("chain_caip2").notNull(),
        amount: numeric("amount", {precision: 78, scale: 0}).notNull(),
        tx_hash: text("tx_hash").notNull(),
        sender: text("sender"),
        block_number: numeric("block_number", {precision: 78, scale: 0}),
        idempotency_key: text("idempotency_key").notNull(),
        status: text("status").notNull().default("detected"),
        created_at: timestamp("created_at", {withTimezone: true}).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("deposits_idempotency_key_key").on(table.idempotency_key),
        index("deposits_tx_hash_idx").on(table.tx_hash),
    ]
);

export type deposit = typeof deposits.$inferSelect;
