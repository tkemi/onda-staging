CREATE TABLE "deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"asset" text NOT NULL,
	"chain_caip2" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"tx_hash" text NOT NULL,
	"sender" text,
	"block_number" numeric(78, 0),
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'detected' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"privy_user_id" text NOT NULL,
	"privy_address" text NOT NULL,
	"user_address" text NOT NULL,
	"user_private_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_privy_user_id_unique" UNIQUE("privy_user_id"),
	CONSTRAINT "users_privy_address_unique" UNIQUE("privy_address"),
	CONSTRAINT "users_user_address_unique" UNIQUE("user_address")
);
--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deposits_idempotency_key_key" ON "deposits" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "deposits_tx_hash_idx" ON "deposits" USING btree ("tx_hash");