-- Withdrawals from hyperliquid back to an address the user chose, recorded by the indexer
-- webhook from Bridge2's FinalizedWithdrawal.
--
-- IF NOT EXISTS so a re-run is a no-op. ADD VALUE rather than recreating the type, which
-- would require rewriting every activities row.
ALTER TYPE "public"."activity_type" ADD VALUE IF NOT EXISTS 'withdraw-on-chain';
