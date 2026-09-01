# Phase 1 Spec — Deterministic Core End-to-End (No LLM)

**Date:** 2026-09-01 · **Status:** Agreed implementation spec, ready for fast-tier execution
**Parent design:** `architecture-v1.md` §4, §5, §10. This doc pins every parameter
that Phase 1 implementation must not improvise. Where a number is a *hypothesis*
(not a verified fact), it is marked **[H1]** — Phase 4 backtests it.

**Deliverable:** `pnpm -C apps/api screen:daily` fetches both market lanes, runs
the Day-17 quality gate with typed outcomes, derives adjusted series, screens
deterministically, persists the run, and prints a ranked shortlist led by a
data-integrity header.

**Gate (all must hold):**
1. Store seeded with 5y of both lanes; seed quality report shows 0 failures and
   every warning enumerated (warnings are expected on edge names — they must be
   *explainable*, not absent).
2. `screen:daily` produces a ranked shortlist per market from the deterministic
   core only; `FETCH_FAILED` tickers are loudly excluded; `CA_DEGRADED` names
   are included but annotated.
3. All new quant-core modules have known-answer vitest coverage; the CLI runs
   end-to-end against the dummy provider in tests (real Yahoo never in CI).

---

## 1. Universe

Static, curated, committed JSON — no scraping in v1.

- `apps/api/data/universe.us.json` — S&P 500 + Nasdaq 100 + ~50 major US ETFs
  (deduped, ~550 symbols).
- `apps/api/data/universe.hk.json` — HSI + HS Tech constituents + liquid HK
  ETFs **including the HK-domiciled US-index trackers** (3195.HK etc.) (~140).
- Entry shape: `{ symbol, name, currency, kind: "stock" | "etf" }`.
  `symbol` is Yahoo-native (`AAPL`, `0700.HK` — 4-digit + `.HK`).
- Sourced once by hand from public constituent lists; a `### Refresh` note in
  each file's header comment block documents where the list came from and when.
  Index membership drift is accepted in v1 — the weekly sentinel (§4.3 of the
  architecture) and `GENUINELY_ABSENT` outcomes surface stale entries.
- Seeding upserts one `Instrument` row per entry (`market` from the file;
  `Instrument.market` stays `"US" | "HK"` — the LSE value in the schema comment
  is dead, removed in the Phase 1 migration).

## 2. Yahoo loader (`YahooMarketDataProvider`)

New dependency: `yahoo-finance2` in `apps/api` (proven in `spike/data-probe.ts`).

**Seam change:** the provider interface gains an optional window:

```typescript
fetchDailyBars(symbol: string, opts?: { period1?: string; period2?: string }):
  Promise<RawMarketDataResponse>
```

**Fetch policy (pinned):**
- **Always fetch the full 5-year window** (`period1 = today − 5y`,
  `interval=1d`, `events=div,split&includeAdjustedClose=true`) and upsert
  idempotently. No incremental fetch path in v1: 800 tickers × 1 call × 200ms
  ≈ 3 min/run, and a full-window rewrite is *self-healing* against silent
  provider history revision (architecture §11 risk 5). Revisit only if
  throttling proves this too slow.
- Headers: pinned `User-Agent: Mozilla/5.0` (short form — the long Chrome UA
  drew immediate 429s in probing).
- Throttle: strictly sequential, 200ms base + uniform 0–50% jitter (spike
  `jitter()`). Concurrency is a design element, not a retry policy: **1**.
- Retry: one in-run retry after 5s on 429/timeout/5xx; a second failure →
  `FETCH_FAILED`, move on, retry next run.
- `yahoo-finance2` schema validation can reject bars Yahoo actually served —
  on validation rejection, fall back to the raw v8 chart endpoint via plain
  `fetch` (spike `yahooBarsRaw` pattern) before classifying.
- Classification stays in `MarketDataService` via quant-core `classifyResponse`
  (L3 zombie-meta, L4 empty-200 → `FETCH_FAILED`; "No data found"/404 →
  `GENUINELY_ABSENT`). The provider never pre-judges.

**Loader rules applied on ingest (already implemented in quant-core):**
- **L1** `dropHolidayPhantomBars` — needs a holiday calendar: commit
  `packages/quant-core/src/calendars.ts` with static HKEX + NYSE full-day
  holiday date sets covering 2021-01-01 through 2027-12-31, header comment
  stating source and "refresh annually". (US half-days are irrelevant at daily
  granularity.)
- **L2** `clampOhlc` — repaired dates logged loudly into the run report.

**Corporate actions:**
- Dividend events → `CorporateAction` rows (`type: "DIVIDEND"`, amount,
  declared currency), upserted by `(instrumentId, date, type)`.
- **Split events are never stored and never applied** (R1: Yahoo raw is already
  split-adjusted). Count them per ticker and log the count in the run report
  for audit only.
- **CA_DEGRADED auto-detection at ingest:** flag an HK instrument when any
  dividend event has `currency ≠ "HKD"` **or an amount with >4 decimal
  places** (amended 2026-09-01 after live seeding: the originally-specified
  currency-mismatch rule can never fire — Yahoo's event `currency` field
  echoes `meta.currency` (HKD), while the *amounts* are FX-converted with a
  6–8-decimal fingerprint: 0005.HK `0.783188`, 9988.HK `0.9800875`, 2888.HK
  8dp; HKD-native payers are ≤4dp: 2800.HK 2dp, 1299.HK ≤4dp). Annotated in
  the shortlist, not excluded.

## 3. Indicators (`packages/quant-core/src/indicators.ts`)

**Batch pure functions, not Day-18 incremental.** Input: adjusted bars
(`deriveAdjustedBars`, R2); output: plain numbers. 800 × 1260 bars × ~6
indicators is sub-second (measured estimate in `research-github-skills-reuse.md`);
the O(1) incremental design is reserved for the Phase 4 backtest loop.
Every function returns `null` (not NaN, not an exception) on insufficient
history, and the screener treats `null` as ineligible.

| Function | Definition |
|---|---|
| `sma(closes, n)` | Simple moving average of the last `n` values |
| `momentum(closes, n)` | `c_t / c_{t−n} − 1` |
| `annualizedVol(closes, n)` | stdev of daily simple returns over last `n` bars × √252 |
| `sharpe(closes, n)` | annualized return over last `n` bars ÷ annualized vol over same window; **risk-free = 0** (Day 12's beginner approximation, pinned for v1) |
| `advDollar(bars, n)` | median of `close × volume` over last `n` bars, in instrument currency; null close/volume bars skipped, `null` only if fewer than ⌈n/2⌉ usable (tolerance pinned 2026-09-01: Yahoo sporadically serves null-volume bars, incl. the in-progress bar during market hours) |
| `maxDrawdown(closes, n)` | min over the window of `c_t / max(c_{≤t}) − 1` (≤ 0) |

Pinned windows: `SMA20, SMA50, SMA200`, `mom20, mom60`, `vol60`, `sharpe252`,
`adv20`, `mdd252`. All computed on the **adjusted** series except `adv20`,
which uses raw (liquidity is measured in traded dollars, R2).

## 4. Screening rules v1 — hypothesis **[H1]**

> ⚠️ Every number in this section is the *hypothesis* that Phase 4 backtests
> (architecture §9/§10). They are chosen to be conventional and defensible,
> not optimal. Do not tune them before Phase 4.

**Eligibility filter** (per ticker, per market — failing any ⇒ excluded from
ranking, with the reason recorded):

- ≥ 252 bars of adjusted history
- `adv20` ≥ **$20M** (US) / **HK$100M** (HK)  *(liquidity floor)*
- `vol60` ≤ **60%** annualized  *(Day 12 volatility bound)*
- `mdd252` ≥ **−50%**  *(tail-risk bound)*

**Signal conditions** (all must hold — long-bias trend picker):

- `close > SMA50` and `SMA50 > SMA200`  *(bullish alignment, Day 3)*
- `mom60 > 0`
- `sharpe252 > 0`

**Score and rank** — cross-sectional, per market, z-scored over the day's
eligible set:

```
score = 0.50 · z(mom60) + 0.25 · z(mom20) + 0.25 · z(sharpe252)
```

Top **15** per market; ties broken by higher `adv20`. Weights are arbitrary
v1 hypothesis values **[H1]**.

**Exclusion loudness (architecture §4):** `FETCH_FAILED` tickers never reach
the filter — they are listed in the integrity header. `CA_DEGRADED` tickers
that pass are included with a `⚠CA` annotation. Filter-excluded tickers are
counted per reason, not listed.

## 5. Daily CLI

- Entry: `pnpm -C apps/api screen:daily -- --market us|hk|all`
  → `apps/api/src/cli/daily-screen.ts`, run with `tsx`. A plain script
  constructing `PrismaService` + `MarketDataService` directly — the Nest app
  is not involved; no scheduling in Phase 1 (the 16:45/06:00 HKT cadence is a
  Phase 2/3 concern).
- Stages: universe load → ingest (§2) → quality gate (`runChecks` +
  `classifyResponse`, outcomes tallied) → derive adjusted (R1) → screen (§4)
  → persist → print.
- **Degraded rule:** `FETCH_FAILED` count > 2% of the lane's universe ⇒ run
  marked degraded.
- Persistence — two new Prisma models (one migration):
  - `ScreenRun { id, runAt, market, universeSize, ok, genuinelyAbsent,
    fetchFailed, degraded, warningsJson }`
  - `ScreenResult { runId, symbol, rank, score, metricsJson }` with all
    indicator values in `metricsJson` (Phase 4 needs them).
- Stdout format:
  ```
  == DATA INTEGRITY ==  US 2026-09-01: 542/550 screened · 5 fetch-failed
  (AAPL: 429×2, …) · 3 genuinely absent · 2 clamped bars · DEGRADED: no
  == SHORTLIST ==
   1  NVDA    score 2.41  mom60 +38.2%  sharpe 2.1  vol 41%  ⚠CA
  …
  ```
- Also writes the same report to `apps/api/reports/<ISO-date>-<market>.json`
  (directory gitignored) so Phase 2's report view has artifacts to read.

## 6. Testing

- quant-core indicators: known-answer tests on small hand-computed series
  (match the style of the existing `adjustment.test.ts`), plus a property test
  that `sma` batch output equals a naive recomputation.
- Screening: fixture series engineered to pass/fail each eligibility rule and
  each signal condition independently; z-score blend verified on a 3-name
  universe by hand-computed values.
- Loader: all 8 existing dummy behaviors must flow through the CLI's ingest
  stage with correct outcome tallies (integration test, dummy provider,
  throwaway SQLite — existing `tests/helpers/test-db.ts`).
- Real-Yahoo integration test exists but is gated behind
  `YAHOO_LIVE_TEST=1`; never runs in CI.

## 7. Explicit non-goals for Phase 1

- No LLM code, no agent layer (Phase 2).
- No scheduler/cron — manual CLI invocation only.
- No eastmoney/tencent repair paths (the §4.1 rescue loaders and the weekly
  sentinel are a follow-up task after the gate passes).
- No incremental Day-18 indicator machinery.
- No UI changes; existing Playwright smoke must simply stay green.
