# onda-backend

Backend for Onda, a perps DEX on Hyperliquid, using Privy for user wallets.

## Requirements

- Node.js >= 18.18 (currently v18.20.8 — end-of-life; Node 22 LTS recommended)
- Postgres 14+

## Setup

```bash
npm install
cp .env.example .env          # then fill in the values below
createdb -T template0 onda_dev
npm run db:migrate
npm run dev
```

> `-T template0` matters on this machine: `template1` in the local Postgres install contains Laravel
> tables, so a plain `createdb` inherits them and collides with our `users` table.

### Environment

| Variable | What it is |
| --- | --- |
| `DATABASE_URL` | Postgres connection string |
| `ENCRYPTION_KEY` | 32 bytes hex (`openssl rand -hex 32`). Encrypts stored private keys. **Losing it makes every wallet unrecoverable** — back it up somewhere other than the database. |
| `PRIVY_WEBHOOK_SIGNING_KEY` | Svix signing key, Privy dashboard → Configuration → Webhooks |
| `PORT` | defaults to 3002 |

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | build, then serve |
| `npm run build` / `npm run serve` | compile to `dist/` / run it |
| `npm run typecheck` | type-check only |
| `npm run db:generate` | generate a migration after editing `src/db/schema.ts` |
| `npm run db:migrate` | apply migrations |
| `npm run db:studio` | Drizzle Studio |

## API

All responses use `{"status": "ok" | "error", ...}`.

### `POST /api/create-wallet`
Registers a user. Generates an internal wallet with viem, encrypts the private key, stores it.
Idempotent — a repeat call returns the existing address.

```json
{"privyWallet": "0x71C7...", "privyUserId": "did:privy:..."}
→ {"status": "ok", "address": "0x9b28..."}
```

`400` invalid address or empty user id · `400` if that Privy wallet already belongs to another user.

### `GET /api/wallet/:privyWallet`
Returns the internal address for a Privy wallet address. `404` if unknown.

### `POST /api/webhooks/privy`
Privy webhook receiver. Verifies the Svix signature, records the delivery, and on
`wallet.funds_deposited` writes a `deposits` row.

`401` on a bad signature — the only non-2xx. Everything past verification answers 2xx, because Svix
retries non-2xx for days and an unparseable payload will never parse on a retry. The raw body is
kept in `webhook_events` either way, so nothing is lost.

Mounted **before** `express.json()` in `index.ts`: Svix signs the exact bytes sent, and a
parsed-then-reserialized body produces a different signature.

## Schema

**`users`** — `privy_user_id`, `privy_address` (the user's Privy wallet, where they deposit),
`user_address` + `user_private_key` (the internal viem wallet; key is AES-256-GCM encrypted,
stored as `v1:<iv>:<tag>:<ciphertext>`). All three identifiers unique.

**`deposits`** — `user_id`, `asset`, `chain_caip2`, `amount`, `tx_hash`, `sender`, `block_number`,
`idempotency_key`, `status` (`detected` → `forwarding` → `forwarded` | `failed`).
`amount` is `numeric(78,0)`: exact base units as a string, never a float.
**Unique on `(tx_hash, user_id, asset)`** — the guarantee that a retried webhook cannot record the
same money twice.

**`webhook_events`** — `svix_id` primary key plus the raw payload. Written before processing, so a
retry short-circuits and an unparsed payload stays replayable.

Addresses are stored lowercased. EVM addresses are case-insensitive and get compared constantly.

## Hyperliquid notes

The Hyperliquid bridge credits **whichever address sent the USDC** — there is no per-user HL
address and nothing to register. So the address that forwards to the bridge *is* the user's
Hyperliquid account.

| | |
| --- | --- |
| Bridge2 (Arbitrum) | `0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7` |
| Native USDC (Arbitrum) | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| Minimum deposit | **5 USDC** — less is not credited |
| Arbitrum CAIP-2 | `eip155:42161` |

## Open items

1. **`PRIVY_WEBHOOK_SIGNING_KEY` in `.env` is a placeholder.** Replace it with the real key from the
   dashboard or every genuine delivery returns 401.
2. **Register USDC as a tracked asset** in the Privy dashboard, or `wallet.funds_deposited` never
   fires. Production webhooks are Enterprise-gated; dev testing is free.
3. **The forwarder does not exist.** Deposits stop at `detected`. When it is built it must filter on
   `chain_caip2 = 'eip155:42161'` — a deposit on Ethereum mainnet must not trigger an Arbitrum
   transfer — and must never send below 5 USDC.
4. **Privy's real `wallet_id` is not stored.** It arrives on every deposit webhook and is what Privy's
   API needs to sign from that wallet. Worth capturing before building the forwarder.
5. **No auth on the endpoints.** `privyUserId` comes from the request body, so anyone can register a
   wallet under any user id. Replace with Privy access-token verification before launch.
6. **Error logs can contain secrets.** The 500 handler logs the full error; Drizzle errors include
   SQL params. Private keys are encrypted now, so this is much reduced, but worth a redaction pass.

## Layout

```
src/
  index.ts                 app, mounts, error handler, startup db check, shutdown
  controllers/             create_wallet, get_wallet, privy_webhook
  routes/                  one *_route.ts per controller, barrel in index.ts
  db/                      drizzle client + schema
  utils/                   crypto (encrypt/decrypt), errors, webhook verification
drizzle/                   generated SQL migrations
```
