# Phase 6B Plan — Strategy backtests (borrowed rule-based engines)

Plan written 2026-09-17, alongside `docs/phase-6a-plan.md` (factor backtests) from the
same `vendor/Vibe-Trading` review.

**Status: LOCKED** — all six forks decided by the user on 2026-09-17.

Purpose: Phase 6A answers *"does this factor rank the cross-section?"*. Phase 6B
answers the other question — *"does this rule, with entry/exit/stop semantics, make
money?"* — with a **new** portfolio simulator, because the existing one
(`simulatePortfolio`) is a long-only rank-hysteresis book that cannot express a
borrowed engine's positions.

## Scope

In: deterministic, LLM-free, daily-bar rule engines borrowed from the vendored
skills, simulated on the existing US/HK store with the existing cost model, fills and
metrics.

Out: factor sweeps (6A), tuning, LLM-scored strategies, new data sources, minute
bars, and any promotion of a strategy into the picker (that is a separate,
user-approved step).

## Locked decisions (the six forks)

| Fork | Decision |
|---|---|
| **1. Universe** | Same as 6A: **liquidity universe U1 primary** (PIT ≥ 252 bars + `adv20 ≥ advFloor`, no trend/vol/MDD gates), screen-eligible U2 reported. One universe rule across both phases, so a 6A IC result and a 6B portfolio result for the same engine describe the same names. |
| **2. Windows** | Same as 6A: picker window for the run; the vendor test half is **not** spent by 6B (it is reserved for 6A's promoted factors). 6B results on the picker window are labelled *this window* and carry no confirmation claim. |
| **3. Multiple testing** | 6B runs **5 engines, not 448**: the family is small, so no FDR is applied. Instead, the engine set and each engine's parameters are **fixed in this document before any run** ("the defaults are the hypothesis"). Any later engine added to the family is a new pre-registration, and the record of how many engines have been tried on this window is cumulative and printed in every artifact. |
| **4. Signal source** | **Python bridge, engines verbatim** (`generate(data_map) -> {symbol: Series in [-1,1]}`). Porting to TS is deferred until a strategy is promoted toward production. |
| **5. Exposure** | **Long/short, net ≤ 1, no leverage**; shorts always reported separately from longs; **borrow cost assumed 0** (no data) and disclosed; per-engine stop-loss only where the engine itself defines one — we do not add stops the source does not have. |
| **6. Decider** | **IC decides where expressible.** An engine whose signal is a *continuous per-name score that varies cross-sectionally* is also run through the 6A harness, and that IC verdict is the deciding claim; the portfolio result is **falsification-only** (the Phase-4 Gate-2 role, kept). A portfolio differential on this window can never confirm anything (measured US IR 0.49 over ~4y). |

## The causality gate — the step that decides which engines exist

Every candidate engine is tested before it is used:

```
for sampled T:  assert generate(series[:T]) == generate(series)[:T]
```

A signal at T that changes when bars after T are appended is **look-ahead by
construction** — the classic failure of pivot-confirmed pattern engines, where a
zigzag pivot is only knowable later. Result classes:

| class | engines | handling |
|---|---|---|
| **trailing-only** (expected to pass) | `ichimoku`, `technical-basic` (EMA/ADX/RSI/BB/OBV), `candlestick` (per-bar patterns), `volatility` (rolling HV percentile), `seasonal` (calendar only) | **Round 1**, `--mode full` (one call on the full panel), invariant test result recorded in the artifact |
| **repainting** (expected to fail) | `harmonic`, `elliott-wave`, `smc` (BOS/OB/ChoCh), `chanlun` (czsc 笔/段) | **Round 2** at the earliest, and only `--mode walkforward` (per-T call on a truncated slice). A failure that cannot be fixed by walk-forward is excluded, not "adjusted" |
| **excluded, with reason** | `multi-factor/example` (near-duplicate of the shipped screen — no new information), `pair-trading` (pair *selection* is an unregistered fork), `cross-market-strategy` (no crypto lane), `minute-analysis` (no minute bars), `fundamental-filter` (no PIT fundamentals — the F10 snapshot lives inside prompt text, so using it would be look-ahead), `event-driven` (no PIT event-score panel), `smc`/`chanlun` external deps (`smartmoneyconcepts`, `czsc`) not installed | recorded in the artifact's engine manifest so the exclusions are auditable, not silent |

**Position mapping is part of the pre-registration.** Each engine's raw output is
mapped to `[-1,1]` by a rule fixed in this document before the run: the engine's own
documented threshold where it has one, otherwise `sign(score)` (0 when the score is
0). Raw signal distributions are recorded per engine; nothing is tuned against
outcomes.

## Position semantics, fills and costs

- **Signal at close of T → fill at T+1 open**, falling back to the close when the
  provider carries no open (`fillPrice`, reused unchanged).
- **Costs:** the existing `BASE_COSTS` (US 5 bp, HK 23 bp per side) plus the
  standing 2× sweep for the falsification check. Shorts: borrow 0 (disclosed).
- **Drift between rebalances**, no intraday mark; positions re-marked daily at close.
- **Metrics:** the existing `PortfolioMetrics` type, unchanged, plus short/long
  breakout and gross/net exposure.
- **Benchmarks:** equal-weight eligible (U1), cost-free, always invested; plus the
  pre-registered index (SPY / 2800.HK) where stored.
- **Last session:** open positions are closed at the final bar and the truncation is
  noted in the report, as Gate 2 already does.

## Verdict vocabulary

| verdict | rule |
|---|---|
| `falsified` | portfolio loses to the equal-weight U1 benchmark at base costs **or** at 2× costs **or** in a majority of covered years |
| `not_falsified` | none of the above — **never** a confirmation |
| `insufficient_evidence` | the engine's signal is cross-sectionally flat (IC undefined by construction, e.g. `seasonal`) **and** the portfolio result is inside noise |
| `supported` | **only** via the 6A IC path (mean 20d IC ≥ 2 × SE, t ≥ 2 on the picker window, BH-FDR-clearing when run as part of a set) |

## Build order (fast tier once locked)

| # | Step | Deliverable | Exit criterion |
|---|---|---|---|
| **B1** | Causality audit — `apps/api/src/backtest/causality.ts` + `packages/quant-core/tests/causality.test.ts` | the truncated-prefix invariant harness, runnable against any panel | the 5 round-1 engines pass; at least one repainting engine demonstrably fails on a synthetic fixture (the harness must be able to fail) |
| **B2** | Position bridge — `apps/api/scripts/strategy-bridge.py` | `positions.csv` (date × symbol), `--mode full\|walkforward`, engine id, its default parameters, and the B1 result in `strategy-manifest.json` | re-run byte-identical; walkforward output equals full output for a trailing-only engine (the two modes agree where they must) |
| **B3** | `simulatePositions()` in `packages/quant-core/src/portfolio.ts` (~200 lines) | long/short book, drift, T+1 open fills, per-side costs, optional engine-native stop, `PortfolioMetrics` + exposure breakout | unit tests: flat signal → no trades; +1 then −1 inverts correctly; costs reduce return monotonically; a known 3-day fixture reproduces hand arithmetic; `fillPrice` and `BASE_COSTS` are the *same* functions the screen backtest uses |
| **B4** | CLI — `pnpm -C apps/api backtest:strategy` | `--engine <id> --market us\|hk --json` → `reports/backtest/strategy-<engine>-<date>.{json,txt}`: metrics at 1×/2×, yearly differential, benchmark + index, trade summary, causality evidence, engine manifest, limitations | 5 engines × 2 lanes run end-to-end; every artifact carries its causality evidence |
| **B5** | IC side for score-shaped engines | the same engines' cross-sectional scores run through the 6A harness | each engine lands as `supported` / `insufficient_evidence`, never as a guess |
| **B6** | Strategy index + PROGRESS | `reports/backtest/index.json` — one row per (engine, lane, window, verdict, artifact), plus the cumulative engine count | "what have we tested" is answerable without reading this document |

## Pre-registered limitations

1. Every Phase-4 limitation travels: survivorship, universe look-ahead, one regime,
   spent window, HK venue distortion, delisting tails absent from IC.
2. **Falsification-only by construction** — a `not_falsified` portfolio on ~4 years
   cannot be evidence of profitability (measured US IR 0.49 vs the ~0.985 a t = 2
   would need).
3. **Engine-inherited parameterisation** — the borrowed engines' defaults were chosen
   by their authors, not tuned here. That is the point: it removes our selection bias
   but inherits theirs, unmeasured.
4. **Position mapping is ours** (threshold / `sign`), fixed pre-run; it is the one
   free choice in the phase, and it is recorded per engine.
5. **Shorts at borrow 0**, and HK short liquidity is unmodelled. Short-side P/L is
   reported separately, never folded into the headline.
6. **Third-party code** (MIT repo; per-engine provenance noted). A promoted strategy
   would need a port we own before it could touch production.
7. **No production impact** — no change to `SCREEN_PARAMS`, the chain, the dashboard
   or the deep-dive.

## Explicit non-goals

- No tuning, no parameter sweep, no stop-loss invention beyond what an engine defines.
- No verdict from the differential; no promotion of any engine into the picker.
- No round-2 (repainting) or walk-forward engines until round 1 has run and reported.
- No pair-trading until pair *selection* is pre-registered as its own fork.
- No LLM, no new data, no scheduled job — `backtest:strategy` is manual, in-session.