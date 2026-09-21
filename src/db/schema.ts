import {
    boolean,
    index,
    integer,
    numeric,
    pgEnum,
    pgTable,
    text,
    timestamp,
    uniqueIndex,
    uuid
} from "drizzle-orm/pg-core";

export const tx_status = pgEnum("tx_status", ["pending", "failed", "confirmed"]);

export const users = pgTable("users", {
    id: text("id").primaryKey(),
    privy_wallet_id: text("privy_wallet_id").notNull().unique(),
    privy_address: text("privy_address").notNull().unique(),
    created_at: timestamp("created_at", {withTimezone: true}).notNull().defaultNow(),
});

export type user = typeof users.$inferSelect;
export type new_user = typeof users.$inferInsert;

export const deposits = pgTable(
    "deposits",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        privy_wallet_id: text("privy_wallet_id").notNull(),
        privy_address: text("privy_address").notNull(),
        asset: text("asset").notNull(),
        chain_caip2: text("chain_caip2").notNull(),
        amount: numeric("amount", {precision: 78, scale: 0}).notNull(),
        tx_hash: text("tx_hash").notNull(),
        sender: text("sender"),
        block_number: numeric("block_number", {precision: 78, scale: 0}),
        idempotency_key: text("idempotency_key").notNull(),
        status: tx_status("status").notNull().default("pending"),
        is_sent: boolean("is_sent").notNull().default(false),
        attempts: integer("attempts").notNull().default(0),
        created_at: timestamp("created_at", {withTimezone: true}).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("deposits_idempotency_key_key").on(table.idempotency_key),
        index("deposits_tx_hash_idx").on(table.tx_hash),
        index("deposits_sweepable_idx").on(table.is_sent, table.privy_wallet_id),
    ]
);

export type deposit = typeof deposits.$inferSelect;
export type new_deposit = typeof deposits.$inferInsert;

export const sweeps = pgTable(
    "sweeps",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        privy_wallet_id: text("privy_wallet_id").notNull(),
        asset: text("asset").notNull(),
        chain_caip2: text("chain_caip2").notNull(),
        amount: numeric("amount", {precision: 78, scale: 0}).notNull(),
        privy_transaction_id: text("privy_transaction_id"),
        tx_hash: text("tx_hash"),
        status: tx_status("status").notNull().default("pending"),
        error: text("error"),
        created_at: timestamp("created_at", {withTimezone: true}).notNull().defaultNow(),
    },
    (table) => [
        index("sweeps_tx_hash_idx").on(table.tx_hash),
        index("sweeps_wallet_idx").on(table.privy_wallet_id),
    ]
);

export type sweep = typeof sweeps.$inferSelect;
export type new_sweep = typeof sweeps.$inferInsert;
