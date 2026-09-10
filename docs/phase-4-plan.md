# Phase 4 Plan — Backtest the screen (H1)

Planning session 2026-09-10. Builds on the shipped picker (Phase 1–3).
Purpose per architecture-v1 §9–10: the screening rules are a *hypothesis*
(H1, pinned in `packages/quant-core/src/screening.ts` SCREEN_PARAMS);
Phase 4 tests it and iterates with out-of-sample discipline (Days 11/15/23).

## Locked decisions (2026-09-10, user)

| Fork | Decision |
|---|---|
| Backtest target | **Deterministic screen only.** The LLM deep-dive layer is not backtested (no historical verdicts; model non-stationary; cost absurd). LLM verdicts are validated *prospectively* from persisted AgentDecision rows — separate, free, later. |
| Portfolio rule | **Rank-hysteresis hold.** Buy when a name enters top-N; hold until its rank falls past a buffer rank or it fails an eligibility gate; cap N concurrent positions. Mirrors real manual use of a daily watchlist. |
| OOS machinery | **Walk-forward folds** with purged boundaries + Day-23 plateau-seeking on a coarse grid. CPCV+PBO deferred — it becomes the audit tool only if walk-forward results look suspiciously good. |
| Survivorship bias | **Accept & label.** The store holds today's universe (555 US + 131 HK) with ~5y history — survivorship and universe-selection look-ahead are inherent. Results are an upper bound; every claim is made *relative* (vs equal-weight same-universe benchmark and index), never absolute. Recorded as an explicit limitation in every report. |

## Carried recommendations (accepted unless vetoed)

- **Fill & cost discipline (Day 21, verbatim):** signal at close of T → fill
  at T+1 **open**; per-market cost model; Day-15 sensitivity sweep as a
  standard output (fees 0.05%→0.20%, slippage 0.02%→0.10%).
- **Tuning scope (Day-11 governor):** tune ONLY score weights, topN, buffer
  rank — coarse grid, heatmap/plateau inspection. Gates (minBars, advFloor,
  volMax, mddMin) stay fixed: they are risk/liquidity constraints with an
  economic rationale, not alpha parameters.
- **Success bar pre-registered below, before any run.**
- **Build shape:** pure `backtest` module in `packages/quant-core` (no I/O) +
  `backtest:screen` CLI in `apps/api` reading the store. All TypeScript.

## Why the screen replays cleanly

`runScreen` is a pure function of bars-up-to-day-T. The backtest is: for
each historical day T, slice each symbol's series to ≤ T, run the same
screen, record the ranked output; then measure forward outcomes. Signal
logic is single-source — no reimplementation, no divergence from production.

**Point-in-time adjustment correctness:** `deriveAdjustedBars` must be
applied per T using only corporate actions with ex-date ≤ T (using future
dividends to adjust past prices is look-ahead). The replay slices CAs the
same way it slices bars.

**Warmup:** minBars=252 consumes the first ~year of the 5y window ⇒ ~4
usable replay years (~1000 trading days), spanning 2022 bear / 2023–24
recovery / 2025–26 regimes.

### Measured facts (2026-09-10, from the store — replaces estimates above)

```
Bar coverage          HK 2021-09-09 … 2026-09-09  (1227 distinct sessions)
                      US 2021-09-09 … 2026-09-08  (1254 distinct sessions)
Screenable names      US 552, HK 131  (>=252 bars)
Banked warmup         first date a full-history symbol reaches bar 252 = 2022-09-08
REPLAY WINDOW         2022-09-08 … 2026-09-09  =  1031 sessions (~4.1y, ~21/month)
```

**Correction to the claim above:** the replay window starts **2022-09-08**, and
the 2022 bear market bottomed in mid-October 2022 — so the window captures only
about **one month** of the bear, not a bear regime. Treat fold 1 as
"late-2022 chop + 2023 recovery" rather than a bear test; the honest regime
claim is *one* clean stress period (late 2022) plus a long up-market.

**Fold arithmetic (the flagged thinness).** Anchored walk-forward, 3 test blocks
of ~250 sessions with a 63-session embargo each:

| fold | train (sessions) | ≈ | test block |
|---|---|---|---|
| 1 | 218 | 10.5 mo | 2023-09 → 2024-09 |
| 2 | 531 | 25 mo | 2024-09 → 2025-09 |
| 3 | 781 | 37 mo | 2025-09 → 2026-09 |

So the whole cost lands on **fold 1's ~218-session train block**, against an
81-combo grid — 218 daily cross-sections to select from 81 candidates. Two
blocks of 2y instead would give train1 ≈ 468 sessions (~1.9y) but only 2 OOS
looks ("majority of folds" becomes 2 of 2). This is the trade to settle.

## Validation gates, in order

### Gate 1 — ranking power (is the score informative at all?)

Replay the screen daily over the full window; per day, over the eligible
set, compute Spearman IC of score vs forward returns at 5d / 20d / 60d
horizons, plus top-15-vs-rest spread. Report mean IC, ICIR, spread per
horizon, per lane, per fold. **If the score has no ranking power, stop —
no portfolio rule rescues an uninformative score.**

### Gate 2 — tradability (would trading it survive costs?)

Portfolio simulation on the Gate-1 replay: rank-hysteresis rule, equal-weight
sizing, T+1 open fills, base costs (US: ~0 commission + 5bp slippage; HK:
0.1% stamp duty + ~0.03% fees + 10bp slippage). Metrics per Day 15:
cumulative/annualized return, max drawdown + duration, Sharpe, win rate,
P/L ratio, trade count, avg holding period, turnover. Benchmarks:
equal-weight same-universe (the like-for-like baseline — shares the same
universe bias) and index ETF from the store where present (SPY / 2800.HK
or lane equivalent). Then the Day-15 cost-sensitivity sweep.

## Walk-forward protocol

- ~4 usable years → **3 anchored folds**: tune on all data before the fold's
  test block, validate on the test block, roll forward. Test blocks ~1y each.
- **Portfolio resets flat at each fold boundary** — no positions carried
  across; this is the purge (a position entered in train can never leak its
  return into test). Embargo of 63 trading days between tune/test blocks for
  the daily-score IC pass (forward-60d labels must not straddle).
- Test-block data is used for validation **only, never re-tuned** (Day 23's
  absolute rule). One look; if H1 fails OOS, the iteration goes back to
  hypothesis revision, not parameter nudging.

## Parameter grid (coarse, plateau-seeking)

- weights: mom60 ∈ {0.40, 0.50, 0.60}, mom20 ∈ {0.15, 0.25, 0.35},
  sharpe252 = 1 − mom60 − mom20 (simplex preserved) → 9 combos
- topN ∈ {10, 15, 20}; buffer rank ∈ {20, 25, 30} → 9 combos
- 81 total. Selection: top-tier return AND acceptable MDD AND Sharpe on the
  *plateau* (neighbors within a few %), never an isolated peak (Day 23
  heatmap method).

**Performance note:** indicators, gates and score components are
param-independent — precompute the per-symbol per-day indicator matrix once
per fold; each of the 81 combos is then just cross-sectional z-scoring +
ranking + portfolio sim. No 81× indicator recomputation.

## Pre-registered success bar for H1

H1 is judged to **hold** if, OOS across a majority of folds, per lane:
1. mean 20d IC > 0 with ICIR > 0 (ranking power present), AND
2. the top-N portfolio beats the equal-weight universe benchmark after base
   costs, AND
3. portfolio Sharpe ≥ benchmark Sharpe, AND
4. the edge survives the Day-15 cost sweep at ≥ 2× base costs.

Anything less = H1 revised (hypothesis level — Day 15's flow), not retuned.

## Explicit non-goals (Phase 4)

- No LLM-layer backtesting; no changes to the chat/deep-dive paths.
- No new data sources (Databento archive stays a loose end); no intraday.
- No CPCV+PBO unless triggered as the audit tool.
- No production parameter changes — the output is a *recommendation*;
  changing SCREEN_PARAMS is a separate, user-approved step.
- No portfolio-tracking / live paper-trading module.

## Build order (Phase 4)

1. **quant-core `backtest` module** (pure): replay driver (PIT-correct
   slicing of bars + CAs), portfolio accounting (hysteresis rule, T+1 fills,
   cost model), metrics (IC/ICIR/spread + Day-15 list). Synthetic-series
   unit tests, incl. a look-ahead tripwire test (mutating a future bar must
   not change day-T output).
2. **`backtest:screen` CLI** (apps/api): store → replay → indicator
   precompute → Gate-1 + Gate-2 runs → JSON + human report under
   `apps/api/reports/backtest/`. Store is read-only for this CLI.
3. **Walk-forward grid run** on real data; heatmaps; the verdict against the
   pre-registered bar; architecture §8/§9 status note + PROGRESS.
