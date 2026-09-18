ALTER TABLE "deposits" ADD COLUMN "privy_address" text;--> statement-breakpoint
UPDATE "deposits" SET "privy_address" = '0xc453b69a98cf00f6e715dbc4ba92d92d65c55cc6' WHERE "privy_wallet_id" = 'tn3w1ah8ld7ala6qww4jpl83' AND "privy_address" IS NULL;--> statement-breakpoint
UPDATE "deposits" SET "privy_address" = '0x0000000000000000000000000000000000000000' WHERE "privy_address" IS NULL;--> statement-breakpoint
ALTER TABLE "deposits" ALTER COLUMN "privy_address" SET NOT NULL;
