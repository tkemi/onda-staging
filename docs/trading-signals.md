# Trading Signals Pipeline

How partner trading analysis becomes actionable, Hyperliquid-tradable setups that we can
notify users about and (later) execute for them.

> Status: the data + monitoring pipeline is built and tested. **Execution is UI-side** —
> users place trades from our UI, connected directly to Hyperliquid. The backend's job ends
> at producing setups, monitoring them, and notifying; it never places orders.

---

## 1. The big picture

```
                       partner
                          │
   push (websocket)       │        pull (daily cron, on demand)
   ┌──────────────────────┴───────────────────────┐
   │                                               │
FILTER_MIX / LIQUIDITY_HUNT / SIGNAL_HUB      FUTURES_PLAN / SPOT_ZONES
   │                                               │
   ▼                                               ▼
trading_analysis_stream  (raw, append-only)   (fetched on the fly)
   │                                               │
   └──────────────┬────────────────────────────────┘
                  ▼
        process_trading_analysis  +  sync_on_demand   (crons)
          - parse & normalise
          - filter to Hyperliquid-tradable markets  ──►  hyperliquid_markets
          - complete the TP ladder (R-multiples)
          - dedup
                  │
                  ▼
            trade_setups            (canonical, user-agnostic "truth")
            accumulation_plans      (spot/swing ladders)
                  │
                  ▼
             monitor (worker)        - polls Hyperliquid mid prices
          - pending → armed → triggered
          - invalidated / expired
                  │
                  ▼
          notify  ──►  Telegram        (per-user routing: future)
                  │
                  ▼
    per-user policy (plan_for_user) + user_trade_settings
          - which TPs to scale out, runner, breakeven, entry style
                  │
                  ▼
    UI renders the plan ──► user executes on Hyperliquid  (NOT backend-side)
```

The guiding principle: **one canonical setup, computed the same for everyone, plus a
per-user policy overlay applied at presentation/execution time.** A stored `trade_setups`
row is never shaped by any user's preferences.

---

## 2. Signal sources

Three are **pushed** over the websocket (`/trading-analysis-stream`); two are **pulled**
from the partner's on-demand HTTP APIs.

| Source | Type | Shape |
|---|---|---|
| `FILTER_MIX_SIGNAL` | pushed | direction, entry, SL, TP1–3 (TPs often missing) |
| `LIQUIDITY_HUNT_SIGNAL` | pushed | `signalType` (dir), confidence, score, liquidationSide, entry/SL/TP |
| `SIGNAL_HUB_SIGNAL` | pushed | indicator (`signalType`), price, EMA10/20, now also direction/entry/SL/TP1 |
| Futures Plan | pulled | per-symbol/timeframe plan with multiple long/short **zones** |
| Spot Zones | pulled | laddered buy/sell **accumulation** plan with allocation % |

**Missing TPs arrive as `0` or `null`** — both are treated as "not provided".

---

## 3. Database tables

| Table | Purpose |
|---|---|
| `trading_analysis_stream` | raw, append-only capture of every pushed delivery |
| `hyperliquid_markets` | every perp/spot market on HL, refreshed daily |
| `trade_setups` | **the canonical processed output** (the star of the pipeline) |
| `accumulation_plans` | spot/swing ladders (a different primitive from trade_setups) |
| `user_trade_settings` | per-user policy (exit style, entry style, breakeven, trailing) |
| `partner_fetch_state` | per-coin on-demand fetch state (supported? last fetched when?) |

### `trade_setups` (the important one)

Every directional setup — from all four perp sources — normalises to one row:

- **Market**: `symbol` (partner's, e.g. `BNBUSDT`), `base_coin` (normalised, `BNB`),
  `market_kind`, `hl_symbol` (what HL calls it), `hl_market_id`.
- **Setup**: `direction`, `entry_low`/`entry_high` (a zone; single-price signals set them
  equal), `sl`, `tp1/tp2/tp3` each with a `*_source` tag of `partner` or `derived`,
  `risk_reward`.
- **Type-specific** context in `data` jsonb (confidence, score, EMAs, confluence, …).
- **Lifecycle**: `status`, `generated_at`, `expires_at`, `dedup_key`.

Prices are `numeric(40, 20)` — generous enough for BTC (~80k) and sub-cent memecoins
(`0.00000829`) alike.

---

## 4. Processing

### Pushed signals — `process_trading_analysis` cron

`src/cron/process_trading_analysis.ts`, every minute (when scheduled):

1. Drains a batch of unprocessed `trading_analysis_stream` rows (oldest first).
2. `parse_signal` extracts symbol / direction / entry / SL / raw TPs (and type-specific
   context), or skips the row if it isn't a usable directional setup.
3. **Quality gate** (`meets_quality`) — strategy-specific. Currently **Liquidity Hunt only
   passes with confidence A/A+ and score ≥ 9**; the weaker, noisier ones are dropped. Other
   sources always pass.
4. Resolves the Hyperliquid market (see [§6](#6-hyperliquid-market-filtering)); **drops
   the signal if the coin isn't tradable on HL** (the raw row is still kept & marked
   processed). This is how we guarantee only Hyperliquid pairs become setups.
5. Completes the TP ladder (see [§5](#5-the-tp-ladder--r-multiples)).
6. Inserts into `trade_setups` with `onConflictDoNothing` on the dedup key.
7. Marks the stream rows processed — all in one transaction.
8. Announces the fresh, still-live setups to the setups channel, suppressing repeats
   (see [§10](#10-notifications--two-telegram-channels)).

Validated on real data: **15,674 raw messages → 865 distinct setups.**

### On-demand — `sync_on_demand` cron

`src/cron/sync_on_demand.ts`, **every 30 minutes**. It builds:

- **Futures plans** → each response expands into **one `trade_setups` row per zone**
  (long[] + short[]), `source_type = futures_plan`, dedup keyed also by timeframe.
- **Spot zones** → one `accumulation_plans` row per coin, upserted (latest replaces the
  previous).

Two realities shape how it runs: the partner **covers only a subset** of the coins HL lists
(it returns **400** for the rest), and it **rate-limits** us (**429**). So the cron is
stateful, via `partner_fetch_state` (one row per coin per kind):

- **Unsupported coins are flagged** — a 400 sets `supported = false`, and that coin is never
  queried again (until the flag is cleared manually).
- **Each run only fetches stale coins** — `last_fetch_at` older than **24h** (`FRESH_MS`) —
  **oldest first**, up to a per-run call budget (`ONDEMAND_MAX_CALLS`, default 40).
- **On a 429 it stops early**; the coins it didn't reach stay "due" and are picked up by the
  next run. Across the 48 runs a day, every supported coin refreshes within 24h while staying
  under the partner's limit.
- Transient errors (5xx / network) leave the coin due to retry; a success stamps
  `last_fetch_at = now`.

The budget is **shared across futures + spot** in a run, since the partner's rate limit is
shared. Symbol set: `ONDEMAND_SYMBOLS` (explicit list) or, by default, derived from the HL
markets we support. Timeframe: `PARTNER_FUTURES_TIMEFRAME` (default `4H`).

> **To re-enable a coin** the partner later starts covering, clear its flag:
> `UPDATE partner_fetch_state SET supported = true, last_fetch_at = NULL WHERE base_coin = '…';`

---

## 5. The TP ladder — R-multiples

Whatever the partner sends, we complete a full three-rung ladder and **tag every level**
`partner` or `derived`. `complete_ladder` (in `src/services/setup_builder.ts`):

1. **All 3 TPs given** → use them (`partner`).
2. **Some TPs given** → extend using the distance of the highest-index provided TP, so the
   rungs stay monotonic. (Signal Hub sends TP1 at ~10% → TP2/TP3 become −20%/−30%.)
3. **No TPs but an SL** → **2R / 4R / 6R** from entry, where `R = |entry − SL|`. For a
   typical ~5% SL this lands on ~10/20/30%, matching the partner's own house template.
4. **Nothing** → fixed 10/20/30% from entry.

We never overwrite the partner's levels and never present a computed level as theirs. A
lopsided partner setup (e.g. a Liquidity Hunt with TP1 at +0.2% and SL at −10%, RR 0.02)
is preserved and surfaced, not "fixed".

> This is deliberately structural. The partner's philosophy is that rigid TPs cap the big
> moves — which is why the exit model keeps a **trailing runner** (see [§9](#9-per-user-policy))
> so winners can run.

---

## 6. Hyperliquid market filtering

Users can only trade what Hyperliquid lists, and **HL quotes everything in USDC** while the
partner quotes in USDT. So:

- `sync_hl_markets` cron (`src/cron/sync_hl_markets.ts`, daily) pulls HL's `meta` (perps)
  and `spotMeta` (spot) and full-replaces `hyperliquid_markets` in a transaction.
- At processing, `to_base_coin` strips the quote (`BNBUSDT → BNB`), and `hl_name_candidates`
  handles HL's `k`/`1000` renames (`PEPE`, `1000PEPE` and `kPEPE` all resolve to `kPEPE`).
- Coins not on HL (e.g. `XTZ`) are dropped — no setup is created.

Verified live: 234 perps, 313 USDC-spot markets; delisted markets are flagged and ignored.

---

## 7. Dedup & supersedence

Two layers collapse the partner's heavy re-sending, so the user is alerted **once, on the
freshest** version of a setup.

**Exact dedup** — each setup gets a `dedup_key` = `base_coin | direction | entry | sl |
tp1 | tp2 | tp3` (+ timeframe for futures plans). A unique index on
`(source_type, dedup_key)` with `onConflictDoNothing` drops byte-identical re-sends.

**Supersedence** (`src/services/supersede.ts`) — handles *near-identical* setups, not just
exact ones. After each processing run, for every touched `(source_type, base_coin,
direction)` group, the open setups are walked newest-first and clustered by entry
similarity (`SIMILAR_ENTRY_PCT`, default **0.5%**). The freshest setup in each cluster stays
live; the older ones are marked **`superseded`** and never fire. So when we get, say, five
Liquidity Hunt longs on SOL within half a percent of each other, only the latest survives to
alert the user — while a genuinely different SOL long at another price, or a SOL short, or a
Filter Mix SOL long, are each kept separate.

Raw rows are always retained regardless.

---

## 8. Monitoring & lifecycle

`src/worker/monitor.ts` is a **long-running worker** (a Procfile `worker` process, not a
cron). It polls Hyperliquid mid prices (`allMids`, ~1,100 markets) every
`MONITOR_INTERVAL_MS` (default 5s) and advances each open setup:

```
pending ──approaching──► armed ──price in entry zone──► triggered
   │                        │
   └──── past the stop before entry ───► invalidated
   └──── past expires_at (unfilled) ───► expired
   └──── a newer similar signal arrived ───► superseded   (set at processing time)
```

Rules live in the **pure, tested** `evaluate_setup` (`src/services/lifecycle.ts`):

- **armed**: price within `ARM_THRESHOLD` (0.5%) of the entry zone's near edge.
- **triggered**: price inside `[entry_low, entry_high]` → the "enter now" moment, which the
  user acts on in the UI. The monitor stamps **`triggered_at`** here — the key field for
  backtesting (time-to-entry, and whether TPs/SL were hit afterwards).
- **invalidated**: price passed the stop side before entry was ever reached.
- **expired**: `now > expires_at`.
- **armed** transitions still happen internally but are **not notified** (no "approaching"
  spam).
- **superseded** is set by the processing crons (see [§7](#7-dedup--supersedence)), not the
  monitor; the monitor only ever acts on `pending`/`armed` setups, so a superseded one can
  never fire.

Status is persisted **before** notifying, so a crash can't double-fire a transition. A
`triggered` notification is the signal to the user to enter; managing the position
afterwards (partial TPs, breakeven, trailing) happens in the UI per their settings.

---

## 9. Per-user policy

A canonical setup is projected into each user's plan by `plan_for_user`
(`src/services/policy.ts`, pure) using their `user_trade_settings`:

- **`exit_style`** — how much scales out at the TPs vs runs:
  - `conservative`: 40/30/30, no runner
  - `balanced`: 30/30/20, **20% runner**
  - `aggressive`: 20/20/10, **50% runner**
- **`entry_style`** — `exact` / `zone` / `dca`.
- **`move_to_breakeven`** — `off` / `after_tp1` / `at_1r`.
- **`trailing_enabled` + `trailing_pct`** — the runner's trailing stop.

`should_notify(event, settings)` decides which lifecycle events reach a given user (e.g.
the `armed` heads-up only matters for `exact` entries). Defaults (`DEFAULT_SETTINGS`) cover
users who never open the settings screen; `get_user_settings` / `save_user_settings`
(`src/services/user_settings_service.ts`) read/write them.

**This plan is what the UI renders and the user acts on.** The backend computes it; the
user executes it on Hyperliquid through the UI. The backend places no orders.

> The allocation percentages and thresholds are provisional — they're the natural place to
> tune trading behaviour once we're live.

---

## 10. Notifications — two Telegram channels

| Channel | Env | Content |
|---|---|---|
| Raw signals | `TELEGRAM_CHAT_ID` | every incoming partner delivery (ops/debug view) |
| Setups | `TELEGRAM_SETUPS_CHAT_ID` | processed, user-facing setups + lifecycle events |

- **Raw** (`send_analysis_signal`): the three pushed signal types formatted per type;
  **never echoes the partner's `authToken`**.
- **Setups** (`notify_new_setup`): each freshly-created, still-live setup, the way a user
  sees it — **strategy**, **current price** (the live HL mid at send time), entry zone, stop,
  the full TP ladder with each level tagged *partner*/*derived*, RR, and type-specific context
  (confidence/score, timeframe, strength).
- **Lifecycle events** (`notify_setup_event`): `🎯 Entry hit`, `❌ Invalidated`,
  `⌛ Expired`. **The "approaching entry" heads-up is NOT sent** — only the actual entry and
  the terminal outcomes, to keep the channel quiet.

**Repeat suppression** (`announce_new_setups`): the partner re-sends near-identical setups
constantly. Beyond exact dedup and supersedence, a new setup is only *messaged* if no similar
one (same source, coin, direction, entry within 0.5%) was announced in the last 24h. Every
announced/suppressed setup is stamped `notified_at`, so the next refresh of the same trade
stays silent. Net effect: **one notification per distinct trade, not per re-send.**

The setups channel falls back to `TELEGRAM_CHAT_ID` when `TELEGRAM_SETUPS_CHAT_ID` is unset,
so one channel still works. **Per-user routing** (only the users following a setup, shaped by
their settings) is future; for now the setups channel is the shared user-facing feed.

---

## 11. Processes, crons & commands

| What | Command | Cadence | Notes |
|---|---|---|---|
| Web + websocket | `npm run serve` (`web`) | always | ingests pushed signals |
| Monitor | `npm run monitor` (`worker`) | always | polls prices, fires events |
| HL markets sync | `npm run hl:markets` | daily | populate before first processing |
| Signal processing | `npm run analysis` | ~1 min | raw → trade_setups |
| On-demand pull | `npm run ondemand` | every 30 min | futures plans + spot zones (stateful) |
| Migrations | `npm run db:migrate` | on deploy | runs automatically (Procfile `release`) |

`*:dev` variants run from source via `tsx`.

Procfile:
```
release: npm run db:migrate
web:     npm run serve
worker:  npm run monitor
```

Crons are added to `app.json` (alongside the existing sweeper/sync) when wiring them up:
```json
{ "command": "node dist/cron/sync_hl_markets.js",          "schedule": "0 3 * * *" },
{ "command": "node dist/cron/process_trading_analysis.js", "schedule": "* * * * *" },
{ "command": "node dist/cron/sync_on_demand.js",           "schedule": "*/30 * * * *" }
```

First deploy: after migrations, run `npm run hl:markets` once so the markets table is
populated before the processing cron runs.

---

## 12. Environment variables

| Var | Used by | Notes |
|---|---|---|
| `TRADING_ANALYSIS_STREAM_TOKEN` | websocket | `partner:token,partner2:token2` |
| `TELEGRAM_BOT_TOKEN` | notifications | from @BotFather; bot must be channel admin |
| `TELEGRAM_CHAT_ID` | notifications | raw-signals channel |
| `TELEGRAM_SETUPS_CHAT_ID` | notifications | processed-setups channel (falls back to above) |
| `PARTNER_API_BASE` | on-demand cron | e.g. `https://xxxx.supabase.co/functions/v1` |
| `PARTNER_API_CLIENT_ID` / `PARTNER_API_CLIENT_SECRET` | on-demand cron | client credentials |
| `PARTNER_API_TOKEN` | on-demand cron | optional static-bearer override for tests |
| `PARTNER_FUTURES_TIMEFRAME` | on-demand cron | default `4H` |
| `ONDEMAND_SYMBOLS` | on-demand cron | optional explicit symbol list |
| `ONDEMAND_MAX_CALLS` | on-demand cron | max partner calls per run; default `40` |
| `ONDEMAND_CALL_DELAY_MS` | on-demand cron | delay between calls; default `500` |
| `MONITOR_INTERVAL_MS` | monitor | default `5000` |

**Partner API auth**: the on-demand client exchanges `PARTNER_API_CLIENT_ID` /
`PARTNER_API_CLIENT_SECRET` (HTTP Basic) for a short-lived bearer at `api-oauth-token`,
caches it in memory, and refreshes ~30s before it expires (and on a 401). Tested live.

Every integration degrades gracefully: missing config logs a warning and skips, never
breaking the rest of the pipeline.

---

## 13. Provisional decisions (to discuss)

These are implemented with sensible defaults but are explicitly **open for tuning**:

- **On-demand cadence & freshness** — runs every 30 min; a coin is re-fetched when its last
  success is older than 24h (`FRESH_MS`), up to `ONDEMAND_MAX_CALLS` per run. Unsupported
  coins (partner 400) are flagged off permanently until reset. `TTL_HOURS` /
  `SPOT_PLAN_TTL_HOURS` set setup/plan validity windows.
- **Invalidation** — a pending setup is invalidated when price crosses the stop before
  entry. We may also want to honour the Futures Plan's explicit invalidation price, or add
  a "too far from entry" rule.
- **How long setups stay active** — `expires_at` is `generated_at + 24h` for pushed
  signals and futures plans, 7 days for spot plans. Easy to change per source in
  `TTL_HOURS`.
- **Supersedence tolerance** — `SIMILAR_ENTRY_PCT` (default 0.5%) and grouping by
  `source_type` (a newer Liquidity Hunt supersedes only older Liquidity Hunts, not a Filter
  Mix at the same price). Both are open for tuning; supersedence could be made cross-source
  if desired.
- **Exit allocations & arm threshold** — the `EXIT_ALLOCATIONS` and `ARM_THRESHOLD`
  constants.
- **Liquidity Hunt quality gate** — `meets_quality`: confidence A/A+ and score ≥
  `MIN_LIQUIDITY_HUNT_SCORE` (9). Adjust to let more/fewer through.
- **Repeat-notification window** — 0.5% entry similarity over 24h in `announce.ts`.

---

## 14. What's not built yet

Execution is **intentionally not** on the backend — users trade from the UI, connected to
Hyperliquid. The backend produces setups, monitors them, and notifies. What remains:

- **Per-user setup subscriptions & routing** — which users follow which setups, so
  notifications are per-user (shaped by `should_notify` + their settings) rather than
  broadcast to the shared Telegram channel.
- **The UI** — rendering `plan_for_user` and wiring the "enter" / "manage" actions to
  Hyperliquid from the client.
- **Symbol reverse-mapping polish** — HL `base → partner symbol` for on-demand pulls is
  best-effort (`kPEPE → PEPEUSDT`); refine once we see which symbols the partner accepts.

Partner API auth (client-credentials → token) is **done and tested live** ([§12](#12-environment-variables)).

---

## Key files

```
src/
  db/schema.ts                         tables & enums
  services/
    setup_builder.ts                   parse + R-multiple ladder (pure)
    setup_row.ts                       input → trade_setups row (shared)
    market_service.ts                  symbol normalisation + HL lookup
    hyperliquid_service.ts             HL meta/spotMeta/allMids
    partner_api_service.ts             on-demand futures/spot API client
    lifecycle.ts                       evaluate_setup (pure)
    supersede.ts                       retire older near-identical setups
    announce.ts                        notify new setups, suppress repeats
    policy.ts                          plan_for_user + defaults (pure)
    user_settings_service.ts           read/write user settings
    notification_service.ts            setup-event Telegram messages
    telegram_service.ts                raw-signal Telegram messages
  cron/
    process_trading_analysis.ts        pushed signals → setups
    sync_on_demand.ts                  futures plans + spot zones
    sync_hl_markets.ts                 HL markets refresh
  worker/
    monitor.ts                         live price monitor + lifecycle
```
