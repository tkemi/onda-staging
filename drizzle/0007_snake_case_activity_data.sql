-- Two renames the activity feed needs, and neither is DDL drizzle can infer.
--
-- 1. The activity type 'deposit' becomes 'deposit-on-chain', so a card on-ramp and any
--    other funding route stay distinguishable instead of all reading as "deposit".
-- 2. The jsonb `data` keys move from camelCase to snake_case, and amount -> amount_wei.
--    Postgres cannot enforce a jsonb shape, so rows written before this still carry the
--    old keys and would serve nothing for every renamed field.

-- Renaming the value keeps every existing row valid; adding a value and migrating rows
-- across would not. Guarded so the statement is skipped if it already happened.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'activity_type' AND e.enumlabel = 'deposit'
    ) THEN
        ALTER TYPE "public"."activity_type" RENAME VALUE 'deposit' TO 'deposit-on-chain';
    END IF;
END $$;--> statement-breakpoint

-- Rebuilt in one expression so no row is ever left holding a mix of old and new keys.
-- token_decimals uses -> rather than ->> to stay a JSON number instead of becoming a
-- string; everything else is text, and a null sender stays null.
-- `data ? 'amount'` makes this a no-op on already-converted rows, so re-running is safe.
UPDATE "activities"
SET "data" = jsonb_build_object(
    'amount_wei',     "data" ->> 'amount',
    'token_address',  "data" ->> 'tokenAddress',
    'token_symbol',   "data" ->> 'tokenSymbol',
    'token_decimals', "data" ->  'tokenDecimals',
    'tx_hash',        "data" ->> 'txHash',
    'sender',         "data" ->> 'sender'
)
WHERE "data" ? 'amount';
