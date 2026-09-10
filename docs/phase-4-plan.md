# Phase 4 Plan — Backtest the screen (H1)

Planning sessions 2026-09-10. Builds on the shipped picker (Phase 1–3).
Purpose per architecture-v1 §9–10: the screening rules are a *hypothesis*
(H1, pinned in `packages/quant-core/src/screening.ts` SCREEN_PARAMS); Phase 4
tests it (Days 11/15/23 discipline).

**Status: LOCKED** — all forks decided by the user on 2026-09-10.

## Locked decisions

### Session 1 (2026-09-10)

| Fork | Decision |
|---|---|
| Backtest target | **Deterministic screen only.** The LLM deep-dive layer is not backtested (no historical verdicts; model non-stationary; cost absurd). LLM verdicts are validated *prospectively* from persisted AgentDecision rows — separate, free, later. |
| Portfolio rule | **Rank-hysteresis hold.** Buy when a name enters top-N; hold until its rank falls past a buffer rank or it fails an eligibility gate; cap N concurrent positions. Mirrors real manual use of a daily watchlist. |
| Survivorship bias | **Accept & label.** The store holds today's universe (552 US + 131 HK) with ~5y history — survivorship and universe-selection look-ahead are inherent. Results are an upper bound; every claim is made *relative* (vs equal-weight same-universe benchmark and index), never absolute. Recorded as an explicit limitation in every report. |

### Session 2 (2026-09-10) — revised after the power analysis below

| Fork | Decision |
|---|---|
| Tuning | **None. Test the shipped `SCREEN_PARAMS` as-is.** No train/test split, no parameter selection, no grid search. The parameters are the hypothesis. |
| Bar shape | **Asymmetric.** Gate 1 (cross-sectional IC) decides H1 — it is the only gate with real power. Gate 2 (portfolio vs benchmark, Sharpe, cost sweep) is **falsification-only**: it can kill H1 on a reversal, and is never cited as confirmation. |
| Gate 1 threshold | mean 20d rank IC **≥ 0.02** AND **Newey-West t ≥ 2** (lag = horizon), per lane. |
| Lane handling | **Separate per-lane verdicts.** US and HK are distinct hypotheses with different universes, costs and very unequal power. |

**These supersede the earlier "Walk-forward folds + Day-23 plateau-seeking on an
81-combo grid" decision.** Why: the whole OOS apparatus existed to control
selection bias from tuning, and if there is no tuning there is no selection bias
to control — while the split itself cost 60 % of the evidence. Building the
tuning loop is now a *later* question (`§ Future: tuning`).

## Measured facts (from the store, 2026-09-10)

```
Bar coverage          HK 2021-09-09 … 2026-09-09  (1227 distinct sessions)
                      US 2021-09-09 … 2026-09-08  (1254 distinct sessions)
Screenable names      US 552, HK 131  (>=252 bars)
Banked warmup         first date a full-history symbol reaches bar 252 = 2022-09-08
REPLAY WINDOW         2022-09-08 … 2026-09-09  =  1031 sessions (~4.1y, ~21/month)
```

**Regime reality (corrects an earlier draft):** the window starts **2022-09-08**
and the 2022 bear bottomed mid-October 2022, so it captures about **one month**
of bear market, not a bear regime. The honest description is *one short stress
period + a long up-market*. There is no 2022-H1 bear, no 2020, no 2008.

## Statistical power — the constraint that shaped the design

Per-day cross-sectional rank IC has SE ≈ 1/√(N−1): ≈0.0426 for US (N≈552),
≈0.0877 for HK (N≈131). Overlapping forward labels inflate the series' effective
independence, so the IC t-stat requires **Newey-West, lag = horizon** (the draft's
plain t-stat would materially overstate significance). Effective N ≈ T/horizon:

| horizon | label-bearing days | effective N |
|---|---|---|
| 5d | 1026 | 205 |
| 20d | 1011 | 50.5 |
| 60d | 971 | 16.2 |

Smallest mean 20d IC detectable at t = 2, on the full 1031-session window:

| lane | SE(mean IC) | detectable at t=2 | the locked 0.02 bar |
|---|---|---|---|
| US | 0.0060 | **0.0120** | comfortably detectable |
| HK | 0.0123 | **0.0247** | **not reachable** |

**Consequence to be explicit about:** for HK the t-stat is the *binding*
constraint, so HK's effective Gate 1 requirement is **IC ≥ 0.025, not 0.02**.
That is the honest price of a 131-name universe with 4 years of data. It is
pre-registered here deliberately, so a HK failure at IC ≈ 0.02 is read as
*insufficient evidence*, not as evidence of no edge.

For portfolio-level alpha, t = IR·√years. Over 4.12 years, t = 2 requires
**IR ≥ 0.985**; IR 0.5 would need ~16 years and IR 0.3 ~44 years. Since a
realistic screen IR is 0.3–0.7, **Gate 2 can never confirm anything** — this is
why it is falsification-only rather than a passed/failed gate.

## Test design

- **Replay:** for each day T in the replay window, slice every symbol's series to
  ≤ T (bars **and** corporate actions by ex-date ≤ T), run the *production*
  `runScreen` unchanged, and record the ranked output. Signal logic stays
  single-source — no reimplementation, no divergence from what ships.
- **No split, no folds, no grid.** The full 1031 sessions are the test set. There
  is no fitted quantity, so there is nothing to overfit.
- **No embargo needed** (no train/test boundary), but the IC t-statistic must use
  Newey-West lag = horizon because 20d labels overlap.
- **Label availability:** the last `h` sessions have no h-day forward return, so
  the 20d IC series covers 1011 days, the 60d series 971. The portfolio
  simulation runs the whole window and marks to market, closing open positions at
  the final bar; that truncation is noted in the report.
- **Primary statistic, fixed in advance:** mean 20d rank IC, per lane. 5d and 60d
  results are reported but may not override the 20d verdict — otherwise the
  horizon becomes a free parameter after seeing results.

## Gate 1 — ranking power (DECIDES)

Per lane, over the eligible set each day: Spearman rank IC of score vs forward
return; report mean IC, ICIR, the Newey-West t-stat, and top-15-vs-rest spread
per horizon. Also reported by calendar year (descriptive stability, not a gate).

**H1 Gate 1 passes for a lane iff** mean 20d IC ≥ 0.02 **and** NW t ≥ 2.
(Restated for HK: effectively mean 20d IC ≥ 0.025, see above.)

If Gate 1 fails, **stop** — no portfolio rule rescues an uninformative score, and
the iteration returns to hypothesis revision (Day 15's flow), never parameter
nudging.

## Gate 2 — tradability (FALSIFIES ONLY)

Portfolio simulation on the same replay: rank-hysteresis rule, equal-weight
sizing, cap N concurrent, **signal at close of T → fill at T+1 open**, portfolio
starts flat at the window start. Base costs — US: ~0 commission + 5bp slippage;
HK: 0.1 % stamp duty + ~0.03 % fees + 10bp slippage — then the Day-15
cost-sensitivity sweep (fees 0.05 %→0.20 %, slippage 0.02 %→0.10 %). Metrics:
cumulative/annualised return, max drawdown + duration, Sharpe, win rate, P/L
ratio, trade count, average holding period, turnover. Benchmarks: **equal-weight
same-universe** (the like-for-like baseline — it shares the universe bias) and
the index ETF from the store where present (SPY / 2800.HK).

**Falsification criteria** (any one kills the *tradability* claim for that lane):
- F1: cumulative differential vs the equal-weight same-universe benchmark ≤ 0 at
  base costs, OR
- F2: differential ≤ 0 at 2× base costs, OR
- F3: differential ≤ 0 in a majority of the covered calendar years.

Passing Gate 2 means **"not falsified"**, never "confirmed".

## Pre-registered success bar and outcome matrix

| Gate 1 | Gate 2 | Verdict for that lane |
|---|---|---|
| pass | not falsified | **H1 holds** — ranking power, and a tradable implementation that does not lose to the universe |
| pass | falsified | **Ranking power present, tradability failed** — iterate on the portfolio rule / costs / liquidity, *not* on the score |
| fail | — (not consulted) | **H1 revised** — hypothesis-level revision of the score |

Both lanes are reported separately. There is no conjunction: a weak HK result
must not veto a strong US result, and an HK null is not evidence against H1.

## What this test cannot claim (pre-registered)

1. **Portfolio alpha is not statistically resolvable here** (needs IR ≥ 0.985).
   Gate 2 non-falsification is not evidence of profitability.
2. **HK power is materially lower** than US (detectable IC 0.025 vs 0.012).
3. **Survivorship / universe look-ahead** — results are upper bounds and all
   claims are relative.
4. **Informal in-sample influence.** `SCREEN_PARAMS` were designed in Aug 2026 by
   someone with knowledge of 2021–2026 market history. That is in-sample
   influence no split can remove, so this is *not* a clean prospective test. It
   is the best available test, and it is labeled as such.
5. **One regime, one universe snapshot.** ~1 month of bear, mostly up-market;
   552/131 names that exist today.

## Descriptive outputs (explicitly NOT gates)

- **Parameter-sensitivity heatmap** over the retired 81-combo grid, run
  unconditionally: report the distribution of mean 20d IC across combos and where
  the shipped default falls in it. This is *description*, not selection. **Rule:**
  it may not be used to change `SCREEN_PARAMS` — any change motivated by it is a
  new hypothesis requiring a new pre-registered test on data that does not
  include this window's results.
- IC by calendar year, IC by liquidity decile, spread at all three horizons,
  turnover and average holding period.

## Future: tuning (explicitly deferred, not cancelled)

If H1 holds and anyone wants better weights, that is a separate pre-registered
test. The geometry work is already done — for anchored walk-forward on 1031
sessions, `train_1 = 1031 − Σ(test) − embargo` depends on the **total** test
budget, not the fold count:

| geometry | fold 1 train | fold 2 | fold 3 | test each | pooled OOS |
|---|---|---|---|---|---|
| 3×250 | 218 (0.9y) | 468 | 718 | 250 | 750 (3.0y) |
| 3×165 | 473 (1.9y) | 638 | 803 | 165 | 495 (2.0y) |
| 2×250 | 468 (1.9y) | 718 | — | 250 | 500 (2.0y) |

So `3×165` is the best tuning geometry: it spends the same data as `2×250` but
buys three independent tune→test cycles. Fold 1 would need roughly 1.9y of
training to make grid selection meaningful rather than noise-fitting.

## Explicit non-goals

- No LLM-layer backtesting; no changes to the chat/deep-dive paths.
- No new data sources (Databento archive stays a loose end); no intraday.
- No CPCV+PBO (it was the audit tool for a tuning process that no longer exists).
- **No production parameter changes** — the output is a *recommendation*;
  changing `SCREEN_PARAMS` is a separate, user-approved step.
- No portfolio tracking / live paper trading.

## Build order

1. **quant-core `backtest` module** (pure, no I/O): PIT replay driver (bars + CAs
   sliced to ≤ T), IC/ICIR/spread with Newey-West, portfolio accounting
   (hysteresis rule, T+1 open fills, per-market cost model), metrics. Tests
   include a **look-ahead tripwire** (mutating a future bar must not change day-T
   output) and an IC/Newey-West correctness test on synthetic data with a known
   autocorrelated IC series.
2. **`backtest:screen` CLI** (apps/api): store → replay with the shipped
   `SCREEN_PARAMS` → Gate 1 + Gate 2 → JSON + human report under
   `apps/api/reports/backtest/`. Store is **read-only** for this CLI.
3. **The run on real data**, the descriptive heatmap, the verdict against the
   pre-registered bar, architecture §9 status note + PROGRESS.

All three are fast-tier execution now that the design is locked.
