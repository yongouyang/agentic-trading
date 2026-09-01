# Research: openalgo as a Reference Architecture — What to Borrow for agentic-trading

**Date:** 2026-09-01 · **Scope:** Source-level analysis of the local
`~/projects/openalgo` checkout (v2.0.1.4, Flask + React 19, 36 broker plugins,
500 HTTP endpoints, 6 data stores). Method: their own `DISCOVERY_MAP.md` /
`CLAUDE.md` / `docs/` (an unusually well-documented tree) plus four targeted
source explorations: data stores & Historify, sandbox/analyzer, MCP server,
frontend.

**Framing decisions (user, 2026-09-01):** emphasize what maps to our v1–v3;
execution/broker design summarized as Phase 4+ reference; deep-mine the four
subsystems above; we do **not** need openalgo's multi-OS / multi-SDK /
multi-broker generality — single user, HK+US equities, daily bars, pure
TypeScript, manual execution in v1.

---

## 1. TL;DR

- openalgo is a **production multi-tenant execution platform**; we are a
  **single-user research pipeline**. Most of its complexity budget —
  realtime ticks, order state machines, margin accounting, 36 broker
  adapters, OAuth-for-hosted-clients — exists for constraints we don't have.
  The borrow rate is therefore lower than the code quality suggests, but the
  borrowable ideas are high-leverage.
- **Top five borrowable ideas** (details in §4–§7):
  1. **Coverage-ledger table** (`data_catalog`) driving incremental ingestion
     — compute missing head/tail per series instead of blind full rewrites.
  2. **Single service-layer fork** for paper vs live, with the mode carried
     per-run — the Phase 4 paper-trading seam.
  3. **Daily equity snapshot table** — the entire reporting backbone a
     daily-cadence system needs.
  4. **LLM tool-design discipline** from their MCP layer: one decorator = one
     metadata source, structured errors, truncation metadata, server-side
     compute with compact returns + `legend` fields.
  5. **jsdom test-setup file + chart theming via CSS-token rasterization** —
     lift nearly verbatim for Phase 3.
- **Two things openalgo gets *wrong* for our use case that we already get
  right:** no corporate-action handling anywhere (their equity backtests over
  splits are silently wrong; our R1–R4 + local adjustment is ahead), and no
  transaction-cost model in their sandbox (paper results are flattering
  fiction). Our Phase 4 design must keep both.
- **Their sandbox lacks the two properties an honest daily-bar paper system
  needs** — next-bar-open fills (no lookahead) and a per-market cost model.
  Borrow their structure, not their fill realism.

## 2. What openalgo is (context for reading the rest)

Several products in one self-hosted Flask instance sharing one broker session:
a unified broker REST API (`/api/v1`, 57 RESTX endpoints) for external
platforms, an in-browser Python strategy host, a no-code flow builder, an
options suite, a charting terminal, and a scalping terminal — all backed by 36
broker plugins (`broker/<name>/plugin.json` + lazy-loaded modules) and six
physical data stores. Backend: Flask 3.1 + Flask-RESTX + SocketIO +
APScheduler + SQLAlchemy + DuckDB + ZeroMQ + a separate asyncio WS proxy.
Frontend: React 19 SPA (Vite 8) served from Flask.

The instructive contrast for us is **where the complexity lives**: almost all
of it is in realtime execution and multi-broker normalization — neither of
which our picker has.

## 3. Data stores & Historify

**The 6-store split** (`.sample.env:54-61`, rationale in
`docs/design/18-database-structure/README.md`): main `openalgo.db` (~25
modules), `logs.db` (HTTP traffic + IP bans, 30-day retention),
`latency.db` (order RTT percentiles), `health.db` (FD/memory/thread metrics),
`sandbox.db` (paper state — "no live broker order call belongs in this
layer"), `historify.duckdb` (OHLCV). The rationale is operational: workload
isolation, retention-pruned telemetry kept out of the valuable main DB, and
write-lock shunting for a file shared by gunicorn + the WS proxy. No
cross-store joins — that's what makes the split viable.

**Historify** (`database/historify_db.py`, `services/historify_service.py`):
DuckDB columnar store; `market_data` PK `(symbol, exchange, interval,
timestamp)` with upsert-on-conflict and **deliberately zero secondary
indexes** (zone maps serve symbol-led range scans; resident ART indexes OOM'd
large 1m backfills — issue #1779). Only `1m` and `D` are physically stored;
all coarser intervals are SQL aggregation on read. A **`data_catalog` row per
series** (`first/last_timestamp`, `record_count`) is read before every
download to compute the missing head/tail — full backfill only when no
catalog row exists. Jobs are resumable (`download_jobs` + `job_items`,
checkpoint resume, zombie reaping). **No corporate-action handling at all.**

**SQLite engineering** (their hardest-won lessons, mostly irrelevant to us):
WAL + `synchronous=NORMAL` + 100ms busy_timeout on every connection
(`database/__init__.py:164-187`), all engines on `NullPool`, and a
monkey-patched *cooperative* busy-retry because SQLite's C-level busy-wait
freezes the eventlet hub (measured 16s stall; issues #1402/#1473/#1569).
This whole problem class is eventlet+gunicorn-specific — a single Nest.js
process with one Prisma client doesn't have it.

**Master contract** (`utils/auth_utils.py:35-136`): full symbol-master
download on broker login, skipped iff already fetched today after the
source's publish cutoff (08:00 IST for Indian brokers); delete-and-reload of
the `symtoken` table rather than diffing.

### Verdict

- **Borrow:** the `data_catalog` coverage ledger (but maintain it
  incrementally — they recompute MIN/MAX/COUNT over the whole series per
  upsert, wasteful); smart-cutoff rule for universe refresh;
  delete-and-reload for the universe snapshot; store-base-granularity /
  derive-on-read (we already do this for adjusted series — extends to W/M
  bars); WAL + busy_timeout pragmas on our SQLite (Prisma: set on connect).
- **Selectively:** a second physical DB *only* for disposable high-churn
  telemetry, if we ever add request logging — one extra file, not five. At
  daily-batch scale a retention-pruned table inside the main DB is enough.
- **Skip:** DuckDB itself (SQLite range scans over ~1M daily rows are
  milliseconds; DuckDB pays off at their 1m-bar scale), the NullPool/FD-leak/
  cooperative-cursor machinery, the job-engine UI machinery (pause/resume,
  SocketIO progress) — a cron CLI doesn't need it.
- **Noted blind spot (do not copy):** zero corporate-action handling —
  re-download overwrites are their only "adjustment."

## 4. Sandbox / Analyzer (paper trading)

Architecture: **one global boolean, checked at the service layer** just
before the broker call (`services/place_order_service.py:165-199`), with a
`force_live` per-run escape hatch so a strategy mid-flight can't be diverted
by an operator toggle. Fill simulation (`sandbox/execution_engine.py`):
market fills at ask/bid from the *live broker feed*, limits fill at limit
when crossed, SL/SL-M mirror the exchange "trigger pending" book, **no
partial fills, no slippage beyond spread, no fees**, plus a stale-quote guard
(LTP outside the quote's own day range defers the fill). Account model:
per-user virtual capital, leverage-division margin with **exact-amount
`margin_blocked` bookkeeping** (reserve on fill, release exactly on close —
fixed a whole bug class), MIS square-off crons per exchange, T+1 settlement
to holdings, **no corporate actions**. State: 10 tables in `sandbox.db`
incl. `sandbox_daily_pnl` EOD snapshots written by a 23:59 cron. The
"analyzer report" is an API-request inspector (debugging strategy behavior),
not portfolio performance — no win-rate/drawdown/Sharpe anywhere.

### Verdict — the Phase 4 paper-trading design

- **Borrow:** the single service-layer fork with per-run mode (our
  signal→order pipeline carries `mode: paper|live` on the run, not a global
  toggle); a separate disposable store for paper state; exact-amount ledger
  discipline (for cash-only this degenerates to append-only fills + derived
  positions — still the right rule: never mutable running totals); the
  **daily equity snapshot table** (the whole reporting backbone at daily
  cadence); the stale-fill guard philosophy → the next-bar-open rule.
- **Skip:** the tick engine, bid/ask fills, trigger-pending book, MIS
  leverage/square-off, GTT state machines, T+1 semantics, margin
  reconciliation sweeps — all realtime/multi-broker emulation.
- **Must add (openalgo lacks both):** (1) **next-bar-open fills** — a signal
  from day T's close fills at T+1 open, else lookahead-biased fiction;
  (2) a **per-market cost model** — HK: commission + 0.1% stamp duty +
  exchange/SFC levies; US: commission + SEC/FINRA fees — plus a configurable
  bps slippage haircut. Flag signals whose size exceeds a set % of ADV
  instead of modeling partial fills.
- **The transferable architectural lesson:** keep the paper path behind the
  *same interface* a live path would use, so promoting a validated flow is a
  routing change, not a rewrite. (This is already how our
  `MarketDataProvider` seam works — apply the same pattern to execution.)

## 5. MCP server (agent tool surface)

Three files: `mcp/mcpserver.py` (~49 FastMCP tools in toolsets
orders/account/marketdata/research/utility), `blueprints/mcp_http.py`
(streamable-HTTP JSON-RPC + SSE keepalive), `blueprints/mcp_oauth.py` (full
OAuth 2.1 AS: DCR, PKCE, RS256 JWTs, TOTP-gated `write:orders` consent).
Layering is MCP tool → bundled SDK → loopback HTTP → their own REST →
services (they pay an HTTP round-trip per call to reuse REST
validation/auth).

**The borrowable part is LLM-facing tool design, which is excellent:**

- One decorator (`openalgo_tool(toolset, write, destructive, risk)`) is the
  single metadata source; a CI test + boot audit fail on annotation↔scope
  drift.
- **Structured errors**: `{error: {message, error_type, retry_safe,
  verify_first, verify_with}}` — the timeout-on-write branch teaches
  verify-before-retry because orders have no idempotency key.
- **Truncation metadata**: `{count, returned, truncated, data}` plus a hint
  naming the tool that gets you more.
- **Server-side compute with compact returns**: indicator tools return latest
  value + summary stats + a `legend` field decoding tuple outputs — never raw
  OHLCV. Their `research` toolset (trend/momentum/volatility snapshots,
  `screen_instruments`, `multi_timeframe_analysis`) is the closest analog to
  our Phase 3 chat tools: bundle related indicators into one call rather than
  exposing 80 primitives. Maps naturally onto quant-core.
- **Docstring-as-prompt discipline**: tool descriptions carry valid enum
  values, examples, and call-choreography hints ("don't hardcode lot size,
  call X first"). Tool descriptions *are* the model's API docs.
- Security posture for writes: scope enforcement per call, read-only server
  kill switch, per-JTI rate limits, JSONL audit of every call, coarse error
  text to the client (details stay server-side).

**Skip for our first-party read-only chat UI:** the entire OAuth/DCR/PKCE
stack (exists for arbitrary hosted clients connecting over the internet), the
trust-envelope/prompt-injection wrapper (matters when relaying adversarial
broker text to an agent that can place orders), the SDK-loopback layering (in
Nest.js, tools call the service layer in-process — REST and tools as two thin
adapters over one service, not chained), and MCP approval annotations (we
control both ends; one internal read/write flag suffices). Since we control
both ends, tool granularity can also be coarser and responses pre-shaped for
the charts/tables the UI renders.

## 6. Frontend

Stack: React 19 + Vite 8 + TS, **Zustand for session/UI state + TanStack
Query for server state** (single configured `QueryClient`; per-domain axios
modules over one interceptor'd client), Tailwind 4 + Radix, React Router with
every page lazy. Charting split by surface: their own `openalgo-charts`
package for the trading terminal (3k-line terminal lib — skip entirely),
**lightweight-charts 5 used directly in ~10 analytics pages** with
hand-rolled resize (no reusable wrapper to borrow), Plotly via **partial
factory builds** (`Plot2D.tsx`/`Plot3D.tsx` — avoid shipping the 3MB dist)
for options analytics. Serving: every SPA route explicitly registered in
Flask (feeds their 404 IP-ban tracker), index `no-cache` + immutable hashed
assets with pre-compressed `.br/.gz`. Realtime: one shared Socket.IO
connection via a provider (polling-only transport — WS upgrade fails under
Flask threading), plus a ref-counted `MarketDataManager` with
REST-polling fallback and pause-on-tab-hidden.

### Verdict

- **Borrow:** `frontend/src/test/setup.ts` jsdom mock set verbatim
  (matchMedia/ResizeObserver-as-real-class/IntersectionObserver — Radix
  `new`s them); chart theming by rasterizing Tailwind CSS tokens through a
  1×1 canvas (`lib/trading/chartTheme.ts`) so lightweight-charts follows dark
  mode; the Zustand/Query split with per-domain API modules; the Plotly
  factory pattern if backtest-report charts ever want it; the cache-header
  policy (Next.js gives most of it free); the single-shared-stream provider
  pattern → applied to our SSE chat connection.
- **Skip:** the whole charting terminal, all options pages/math, Socket.IO
  machinery (SSE replaces it — our agent chat *is* the stream), the
  Flask-route whitelist (their multi-install upgrade constraint, not ours),
  WS↔REST failover (no live ticks).
- **Structural caution:** their layer-based `pages/ + api/ + lib/` layout
  produced 1k–3k-line files (ChartPane 1180, strategy Detail 2500+). For our
  smaller app, use **feature folders** (`chat/`, `report/`, `watchlist/`).

## 7. Cross-cutting

**Where we're already ahead:** corporate-action correctness (R1–R4 + local
multiplicative adjustment vs their nothing), typed loud data outcomes
(DataOutcome vs silent re-downloads), and a cost-aware paper-trading plan.
openalgo's edge over us is operational maturity in exactly the dimensions we
don't need (multi-broker, realtime, multi-tenant).

**Phase impact map:**

| Finding | Lands in |
|---|---|
| `data_catalog` coverage ledger + smart-cutoff refresh | Phase 1 follow-up (ingestion hardening) |
| Service-layer `paper|live` fork + 4-table minimal paper design + cost model | Phase 4 |
| LLM tool-design discipline (decorator, structured errors, truncation, legend) | Phase 3 (chat tools) |
| jsdom setup, chart theming, feature folders, SSE pattern | Phase 3 (web app) |
| WAL/busy_timeout pragmas, telemetry retention table | Any next data-layer touch |

**Explicitly not borrowed (recap):** DuckDB, the 5-way DB split, NullPool/
eventlet machinery, the OAuth-MCP stack, trust envelopes, the charting
terminal, Socket.IO, Flask-route whitelists, all 36-broker normalization, and
their fill model (no costs, no next-bar rule).

**Also noted:** their docs can drift from code (a stale index list in
`docs/prd/historify-data-model.md` vs the code comment that removed the
indexes; a `HISTORIFY_DATABASE_URL` vs `HISTORIFY_DATABASE_PATH` config-name
mismatch tracked in their own CONFLICTS.md). Even a well-documented repo
needs source-level verification — which is why this audit read the code.
