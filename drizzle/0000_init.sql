CREATE TYPE "public"."tx_status" AS ENUM('pending', 'failed', 'confirmed');--> statement-breakpoint
CREATE TABLE "deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"privy_wallet_id" text NOT NULL,
	"asset" text NOT NULL,
	"chain_caip2" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"tx_hash" text NOT NULL,
	"sender" text,
	"block_number" numeric(78, 0),
	"idempotency_key" text NOT NULL,
	"status" "tx_status" DEFAULT 'pending' NOT NULL,
	"is_sent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sweeps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"privy_wallet_id" text NOT NULL,
	"asset" text NOT NULL,
	"chain_caip2" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"tx_hash" text,
	"status" "tx_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"privy_wallet_id" text NOT NULL,
	"privy_address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_privy_wallet_id_unique" UNIQUE("privy_wallet_id"),
	CONSTRAINT "users_privy_address_unique" UNIQUE("privy_address")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "deposits_idempotency_key_key" ON "deposits" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "deposits_tx_hash_idx" ON "deposits" USING btree ("tx_hash");--> statement-breakpoint
CREATE INDEX "deposits_sweepable_idx" ON "deposits" USING btree ("is_sent","privy_wallet_id");--> statement-breakpoint
CREATE INDEX "sweeps_tx_hash_idx" ON "sweeps" USING btree ("tx_hash");--> statement-breakpoint
CREATE INDEX "sweeps_wallet_idx" ON "sweeps" USING btree ("privy_wallet_id");