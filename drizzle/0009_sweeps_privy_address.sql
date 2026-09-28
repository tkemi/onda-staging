-- sweeps gains privy_address, denormalised from users the way deposits already carries
-- both identifiers, so a sweep can be found by address without a join.
--
-- Hand-written because drizzle emits `ADD COLUMN ... NOT NULL` with no default, which
-- cannot succeed on a table that already has rows. Added nullable, backfilled, then
-- constrained. drizzle runs the file in one transaction, so a failure changes nothing.

ALTER TABLE "sweeps" ADD COLUMN "privy_address" text;--> statement-breakpoint

-- Every existing sweep belongs to a wallet still present in users, so this resolves all
-- of them. Lowercased to match how users, deposits and activities store addresses.
UPDATE "sweeps" s
SET "privy_address" = lower(u."privy_address")
FROM "users" u
WHERE u."privy_wallet_id" = s."privy_wallet_id"
  AND s."privy_address" IS NULL;--> statement-breakpoint

-- A sweep whose wallet is no longer in users would otherwise fail the SET NOT NULL below
-- with a generic constraint violation. Say what actually went wrong instead.
DO $$
DECLARE
    orphans integer;
BEGIN
    SELECT count(*) INTO orphans FROM "sweeps" WHERE "privy_address" IS NULL;

    IF orphans > 0 THEN
        RAISE EXCEPTION
            'cannot set sweeps.privy_address NOT NULL: % sweep(s) reference a privy_wallet_id with no row in users', orphans;
    END IF;
END $$;--> statement-breakpoint

ALTER TABLE "sweeps" ALTER COLUMN "privy_address" SET NOT NULL;
