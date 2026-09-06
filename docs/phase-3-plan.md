# Phase 3 Plan — Report UI first, tool-calling chat second

Planning session 2026-09-06 (deep tier). All forks decided by the user;
this document is the execution spec. Architecture: `architecture-v1.md` §2
(Output row), §5 step 5, §8. Phases 0–2 are complete and accepted; the daily
chain + weekly jobs run under launchd (architecture §5.1).

## Locked decisions (2026-09-06)

| Fork | Decision |
|---|---|
| Surface order | **Report-first, chat second.** Phase 3a = read-only report UI on a new read API; Phase 3b = chat on the same API. |
| Chat scope (3b) | **Full tool-calling chat** (free-form questions, LLM tool-calls into the Nest API, composes answers). Artifact-only Q&A rejected — user wants real reasoning. 3b gets its own short planning pass before implementation. |
| Charts | **Yes, in 3a** — per-name price chart, TradingView lightweight-charts (already the decided stack). |
| Access | **Localhost only.** No auth, no CORS — the browser never calls the API directly; all data flows through Next server components (`API_INTERNAL_URL`, the existing `ApiHealth` pattern). |

## What exists (do not rebuild)

- `apps/web`: Next 15 / React 19 scaffold, Vitest + Playwright smoke wired.
- `apps/api`: Nest; `HealthController`, `MarketDataController`
  (`/instruments/:symbol/bars` — provider seam, live fetch). No read/report
  endpoints yet.
- Persisted data: `ScreenRun`/`ScreenResult` (rank, score, metricsJson),
  `DeepDiveRun`/`DeepDiveReport` (verdictJson, decisionHashesJson),
  `AgentDecision` (full transcripts, content-addressed), `Bar` +
  `CorporateAction`, and `deriveAdjustedBars(bars, cas)` in quant-core
  (the R1 derivation the screen itself uses — the chart must show the same
  adjusted series, not a second convention).
- Verdict JSON shape (packages/agents `verdict.ts`): `rating`
  (strong_sell…strong_buy), `conviction` ∈ [-1,1], `thesis`, `keyRisks`,
  `invalidationConditions`.

## 3a — Read API (apps/api, new `reports` module)

Route style follows the existing controllers (`@Controller`, `@Get`, typed
service returns). All endpoints are read-only SQL — **no provider calls, ever**
(unlike `/instruments/:symbol/bars`, which is a live-fetch seam).

| Endpoint | Returns |
|---|---|
| `GET /reports/daily?market=US\|HK` | Latest DeepDiveRun for the lane joined to its ScreenRun (`screenRunId`): integrity header (universeSize, ok, genuinelyAbsent, fetchFailed, degraded, warningsJson) + ranked rows: rank, symbol, score, metrics summary, and verdict overlay (rating, conviction, thesis) from DeepDiveReport. Names screened but not deep-dived (rank > topN) appear with no verdict. |
| `GET /reports/deep-dive/:runId/:symbol` | Full verdict JSON + ordered transcript: AgentDecision rows resolved from `decisionHashesJson` in pipeline order (news-analyst, fundamentals-analyst, bull, bear ×rounds, verdict), each with model, promptVersion, usage. 404 on unknown pair. |
| `GET /instruments/:symbol/price-history?days=250` | Stored raw bars + CorporateActions → `deriveAdjustedBars` → `[{date, close, volume}]` + CA markers `[{date, type}]` for chart overlays. Served from the store only — no fetch. |

LLM-cost invariant: **the UI can never trigger an LLM call.** No endpoint
touches packages/agents' pipeline; 3b's chat is the only LLM path and gets
its own guardrails.

## 3a — Web UI (apps/web)

Two routes, server components fetching `API_INTERNAL_URL`; client components
only where interactivity requires (chart).

- **`/` daily dashboard** — two lane sections (HK, US), each with:
  - data-integrity header (architecture §5 step 5): screened/excluded/
    degraded counts; red banner when `degraded`;
  - ranked watchlist table: rank · symbol · score · rating badge ·
    conviction bar · one-line thesis; row links to the detail page.
- **`/symbol/[symbol]?run=`** deep-dive detail:
  - verdict card (rating badge, conviction, thesis, keyRisks,
    invalidationConditions);
  - price chart: adjusted close + volume, split/dividend markers
    (lightweight-charts client component; data passed as props from the RSC);
  - transcript accordion: each agent call (role, model, tokens; system prompt
    collapsed by default, response expanded for verdict, collapsed for the
    rest).

Styling: plain CSS, no framework (repo has none; adding one for two pages is
not justified). Dark-on-light, information-dense, no branding work.

New dependency: `lightweight-charts` in `apps/web` — the decided stack.

## 3a — Tests

- **api**: service-level tests with seeded Prisma rows (the existing suite's
  idiom) — daily join shape, transcript ordering, 404s, price-history
  adjustment matching `deriveAdjustedBars` exactly, CA marker extraction.
- **web**: Vitest component tests (rating badge, conviction bar, integrity
  banner, table rendering from fixture JSON). Playwright smoke stays green —
  extend it to assert `/` renders the dashboard shell with the api down
  (graceful "api: unreachable" per the ApiHealth precedent, not a 500).

## 3a — Explicit non-goals

- No chat, no LLM calls, no streaming.
- No writes from the UI (no "rerun this name" button — CLI stays the only
  trigger).
- No auth, no CORS, no LAN, no deploy work.
- No intraday data; charts are daily bars only.
- No historical-run browsing UI in 3a (latest run per lane only; the join
  keeps `runId`s so a date picker is a later, additive change).

## 3b — Chat (deferred, outline only)

Full tool-calling chat per the locked decision. When scheduled, its planning
pass must cover: tool schema (read-only wrappers over the 3a endpoints +
`compareSymbols`), per-session LLM-call caps, cost display per session,
streaming (SSE), and prompt-injection posture (tool outputs are data, never
instructions). Implementation is a separate session after 3a ships and proves
useful.

## Build order (3a)

1. `reports` module + 3 endpoints, service tests green.
2. `/` dashboard (fixture-driven component tests first).
3. `/symbol/[symbol]` verdict card + transcript.
4. Price chart + `/price-history` endpoint, marker overlay.
5. Playwright smoke extended; docs (architecture §8 status note) + PROGRESS.
