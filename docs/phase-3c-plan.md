# Phase 3c Plan — Historical-run browsing + indicator overlays

Planning session 2026-09-08. Builds on the shipped 3a (read API + report UI)
and 3b (chat). Invariants carried forward: read-only everything, no provider
calls from the read API, the UI can only reach the one guarded chat LLM path,
localhost-only via `API_INTERNAL_URL`.

## Locked decisions (2026-09-08, user)

| Fork | Decision |
|---|---|
| Browsable runs | **Deep-dive runs only** (runs with verdicts — what `ReportsService.listRuns` already returns). Screen-only days stay invisible in the UI. |
| Picker placement | **Dashboard + symbol page.** Per-lane picker on `/`; run picker on `/symbol/[symbol]` bound to the existing `?run=` param. |
| Indicator visuals | **All four**: SMA50 + SMA200 overlays on the price pane; sub-panels for momentum (mom20/mom60), drawdown (mdd252), volatility (vol60). |
| Chat tool cards | **Same chart component** — the `getPriceHistory` card in chat renders the full overlaid/panel chart. |

## API changes (apps/api, reports module — read-only SQL + derivation only)

1. **`GET /reports/runs?market=&limit=&symbol=`** — exposes the existing
   `listRuns` service method. `market` optional (US|HK, validated);
   `limit` default 20, clamp [1, 50]; **`symbol` optional filter — only runs
   that have a DeepDiveReport for that symbol** (powers the symbol-page
   picker; see decided detail below). Returns `RunSummary[]`
   (id, runAt, market, screenRunId, topN, llmCalls, cacheHits, failed),
   newest first.
2. **`GET /instruments/:symbol/price-history?days=` — additive `indicators`
   field.** Alongside `bars`/`markers`, return
   `indicators: { sma50, sma200, mom20, mom60, mdd252, vol60 }`, each
   `[{ date, value }]`. Computed by rolling the existing quant-core point
   functions (`sma`, `momentum`, `maxDrawdown`, `annualizedVol`) over the
   FULL adjusted series (the same `deriveAdjustedBars` output the bars come
   from), then sliced to the requested window. Points where the indicator
   is null (insufficient lookback) are omitted, not zeroed. Additive only —
   the 3a contract (`bars`, `markers`) is byte-unchanged; chat's
   `getPriceHistory` tool inherits the new field for free.

## Web changes (apps/web)

1. **Chart upgrade** (`app/components/price-chart.tsx`, lightweight-charts
   v5 panes via `addSeries(def, opts, paneIndex)`):
   - Pane 0 (tallest): adjusted close area (unchanged), **SMA50 + SMA200
     line series**, volume histogram overlay (unchanged), CA markers
     (unchanged).
   - Pane 1: momentum — mom20 + mom60 as two lines, rendered as %.
   - Pane 2: drawdown — mdd252 as an area series (≤ 0), %.
   - Pane 3: volatility — vol60 line, %.
   - Small static CSS legend row above the chart (color key); no chart-API
     legend work. Component gains an optional `indicators` prop; absent →
     renders exactly as today (keeps existing tests meaningful).
   - Used by both `/symbol/[symbol]` and the chat `getPriceHistory` tool
     card (locked decision 4 — one component, both surfaces).
2. **Run picker component** (`app/components/run-picker.tsx`, client):
   dropdown of RunSummary rows, newest first, label
   `run {id} · {runAt local} · topN {n}`. On select, navigates with the run
   in the URL (shareable).
3. **Dashboard** (`/`): per-lane picker above each lane section; selection
   reflected as `?hkRun=<id>&usRun=<id>`; absent param = latest (current
   behavior). `fetchDailyReport` gains an optional runId passthrough;
   `fetchRuns` added to `lib/api.ts` (never-throw idiom).
4. **Symbol page**: run picker listing only runs containing THIS symbol
   (the `symbol` filter above); selection rewrites `?run=`. The current
   hard requirement of `?run=` stays (dashboard rows already link with it).

### Decided detail (flagged, not user-asked)

The symbol-page picker lists **only runs where the symbol has a
DeepDiveReport**, not all lane runs — otherwise the picker would frequently
land on the "no deep-dive found" notice (only top-10 per lane per day get
dived). Cost: the optional `symbol` filter on `/reports/runs`. Veto this if
you'd rather see all lane runs with the empty state.

## Tests

- **api**: indicators series correctness (hand-computed SMA/momentum/dd/vol
  values over a seeded series; null-lookback points omitted; window slicing
  matches bars slicing); `/reports/runs` (ordering, market filter, limit
  clamp, symbol filter incl. symbol-with-no-reports → empty list, 400s).
- **web**: run-picker rendering + selection navigation; dashboard per-lane
  wiring from fixture runs; chart data plumbing (indicators → series inputs;
  the canvas itself stays mock-tested per the existing price-chart idiom);
  chat tool card passes indicators through.
- **e2e**: dashboard renders pickers with the api up; api-down posture
  unchanged (picker degrades with the lane, never a 500).

## Explicit non-goals (3c)

- No new indicators, no parameter changes (screen params untouched).
- No intraday data; no chart exports; no cross-run comparison view.
- No backtesting — that's Phase 4.
- No changes to the chat loop, tools, or guardrails.

## Build order (3c)

1. API: `/reports/runs` endpoint + price-history `indicators` + tests.
2. Web: chart pane upgrade + run-picker + dashboard/symbol wiring + tests.
3. e2e + architecture §8 status note + PROGRESS.
