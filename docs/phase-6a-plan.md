# Phase 6A Plan — Factor backtests (borrowed alpha library, our statistics)

Plan written 2026-09-17. Follows the executed Phase 4/4b/4c (`docs/phase-4-plan.md`,
`phase-4b-plan.md`, `phase-4c-plan.md`) and the vendor review of
`vendor/Vibe-Trading` in the same session.

**Status: LOCKED** — all six forks decided by the user on 2026-09-17.

Purpose: the picker tests **one** hypothesis (H1's trend screen) and concluded
`insufficient_evidence` on both lanes. Phase 6A opens a *second, larger* hypothesis
family — formulaic cross-sectional alphas — without touching the picker, the LLM
deep-dive, or `SCREEN_PARAMS`, and without writing a second evaluation engine.

## Scope

In: cross-sectional **factor ranking** tests over the existing US/HK store, using
borrowed formula implementations and our own returns, IC math, gates and artifacts.

Out: strategy/position tests (Phase 6B), tuning, LLM-scored signals, new data
sources, production parameter changes, any change to the picker path.

## Locked decisions (the six forks)

| Fork | Decision |
|---|---|
| **1. Universe** | **Liquidity universe (U1) is primary** — PIT: ≥ 252 bars at T **and** `adv20(T) ≥ SCREEN_PARAMS.advFloor[market]`, with **no** volatility / drawdown / trend / momentum / Sharpe gate. **Screen-eligible (U2) is reported secondary** (the shipped gate set, i.e. `ReplayDay.ranked`). U1 is derived from the **same** `runScreen(..., {allFailures: true})` output — a name is U1-eligible iff its failure set contains neither `INSUFFICIENT_HISTORY` nor `LOW_LIQUIDITY`. No second indicator implementation exists anywhere in this phase. |
| **2. Windows** | **Exploratory sweep on the picker window** (`loadLane` windowStart … last stored session, per lane) carrying **screening labels only**. **Confirmation on the unspent vendor test half** (`--spend-test-half`, never yet passed), US-only, for a pre-registered promoted subset. The vendor lane's measured power floor is **0.0486**, stated in every artifact: it confirms large effects only. |
| **3. Multiple testing** | **BH FDR at q = 0.05** over the sweep's Newey-West t-stats (normal-approximation p, disclosed), **plus** the luck benchmark `E[max \|IC\|] ≈ SE · √(2 ln K)` reported alongside. Ported to `quant-core` (~40 lines + tests) so the deciding arithmetic lives in-repo; `quantlib/multipletesting.py` is the reference, not the runtime. |
| **4. Signal source** | **Python bridge produces signal panels only** (borrowed formulas verbatim). Porting 448 alphas to TypeScript is rejected: it would fork the formula from its source of truth. |
| **5. Statistics ownership** | **All returns, statistics and verdicts are TypeScript and single-source** (`ic.ts`, `replay.ts`). The bridge may not compute a return, an IC, a Sharpe or a t-stat. |
| **6. Deciding statistic** | **Mean 20d rank IC with Newey-West t (lag = horizon)** — the Phase-4 Gate-1 statistic, unchanged. 5d/60d are reported and may not override. The portfolio simulation is **descriptive only** in this phase. |

## What is borrowed and what stays ours

```
store (SQLite, PIT replay via loadLane) ──► wide panels (date × symbol, CSV)
        │                                          │
        │                              [Python bridge: Registry.compute only]
        │                                          │
        │                                  factor value panels
        ▼                                          ▼
forward returns, T+1 fills, costs, rank IC, NW-t, FDR, power floors, verdicts ── all TS
```

The picker window's Phase-4 firewall is unchanged: outcome statistics may inform
*design*, never a bar.

## Measured facts (established before any run)

**Zoo inventory** (`vendor/Vibe-Trading`, parsed from `__alpha_meta__` via `git grep`):

| fact | value |
|---|---|
| zoo modules carrying metadata | **462** (`alpha101` 101 · `gtja191` 191 · `qlib158` 154 · `academic` 12 · `fundamental` 4) |
| clean OHLCV-only **and** declaring `equity_us` | **222** |
| clean OHLCV-only **and** declaring `equity_hk` | **170** |
| blocked | `columns_required` needs `amount` 40 · needs `vwap` 30 · `requires_sector: True` 19 (6 sector-only, 13 sector+vwap) |

`amount` / `vwap` / `sector` alphas are **out of round 1**. Supplying an
`amount = close × volume` or `vwap = (h+l+c)/3` proxy is a separate, disclosed
decision — never a silent substitution.

**Runtime** (verified): the registry needs `numpy`, `pandas`, `pydantic` only
(`_backend` reaches `src.config.accessor` lazily, which itself needs pydantic only).
`/opt/homebrew/bin/python3.13` exists; the system `python3` is 3.14 **without pandas**.
Hence a pinned venv, dev-only.

**Power floors on the picker window** (from `reports/backtest/2026-09-13.txt`, the
lanes' own realized NW SE, t = 2):

| lane | realized NW SE (20d) | smallest detectable \|IC\| |
|---|---|---|
| US | 0.01486 | **0.0297** |
| HK | 0.02465 | **0.0493** |

Consequence, pre-registered: on the picker window a sweep can only distinguish
IC ≈ 0 from \|IC\| ≳ 0.03 (US) / 0.05 (HK). Everything below is
`insufficient_evidence`, **not** evidence of no edge. The sweep's real output is a
shortlist for the confirmation stage, and it is labelled as such.

**Vendor lane power** (from `reports/backtest/vendor-2026-09-13.txt`): design-half
NW SE 0.019558 (df 24.1) → 0.8-power bar = 2.4865 × SE = **0.0486**, above the
0.03 cap → the *screen* lane was declared `underpowered by design` and Track A
closed with the test half unspent. Phase 6A spends that half on a **different
hypothesis family**, from a preserved half, which is exactly why it was never spent.

## Test design

- **Replay:** unchanged (`replayScreen`) — bars and dividends sliced to ≤ T, the
  production screen run per day. Phase 6A adds one opt-in field to `ReplayDay`
  carrying each excluded name's full failure set (`excludedReasons`), default off
  and asserted byte-identical, mirroring the existing `allFailures` opt-in. U1 and
  U2 both read from that single output.
- **Panel:** dividend-adjusted OHLC (`deriveAdjustedBars`), volume as stored
  (provider series are split-consistent per R1; no local split adjustment anywhere).
- **Warmup / truncation:** `REPLAY_TRUNCATION_BARS` (252) unchanged. An alpha's own
  `min_warmup_bars` is honoured on top, and the *first* session an alpha can be
  evaluated is recorded per alpha in the bridge manifest.
- **Breadth floor:** `MIN_IC_BREADTH` (5) unchanged; a day with fewer valid names is
  dropped from that alpha's series only.
- **Horizons:** 20d decides; 5d and 60d reported.
- **Label availability:** the last `h` sessions have no h-day forward return
  (`forwardReturn` returns `null`), which also excludes a delisting's catastrophic
  tail from every IC observation. Inherited, conservative direction disclosed.

## Deciding statistic and bar

**Statistic (fixed):** mean 20d rank IC per alpha per lane, Newey-West t with
lag = horizon, proportional top-decile spread (`spreadSeriesProportional`:
`max(ceil(0.10 × breadth), 5)`), IC by calendar year.

**Screen stage (picker window, exploratory):** labels only —

| label | rule |
|---|---|
| `alive` | mean 20d IC > 0 **and** BH-FDR survivor at q = 0.05 **and** \|IC\| ≥ its lane's power floor |
| `reversed` | mean 20d IC < 0 **and** BH-FDR survivor **and** \|IC\| ≥ power floor |
| `dead` | not an FDR survivor, or \|mean IC\| < the lane's power floor (an *uninformative* label, not a claim of no edge) |

**Confirmation stage (vendor test half, US only, promoted subset):** the Phase-4c
rule, re-derived per promoted alpha and locked before spending —
bar = 2.4865 × (design-half NW SE of *that alpha*), **cap 0.03**, SE-stability
guard **1.5×**, FDR across the promoted set at q = 0.05. Verdict vocabulary reused
from 4b/4c: `supported` (IC ≥ bar **and** t ≥ 2) · `falsified` (upper CI < 0) ·
`insufficient_evidence` (CI contains 0 and the bar) · `underpowered` (bar > cap,
declared pre-outcome) · `inconclusive` (SE guard tripped).

**Promotion rule (pre-registered):** the FDR-surviving, power-floor-clearing US
alphas, ranked by mean 20d IC, capped at the top **K = 20**; no post-hoc addition.
The design half is thereby spent for this family and that is recorded, not hidden.
**HK has no confirmation stage** — the vendor archive is US-only, so HK alphas can
never exceed `insufficient_evidence` in this phase, whatever the sweep prints.

## Build order (fast tier once locked)

| # | Step | Deliverable | Exit criterion |
|---|---|---|---|
| **A1** | Vendor zoo + runtime (ops) | `git -C vendor/Vibe-Trading sparse-checkout add agent/src/factors agent/src/config`; venv on python3.13 with `pandas numpy pydantic` (+ optional `bottleneck`, disabled is a pure-pandas no-op path) | `Registry.health()` lists the zoo with 0 load errors |
| **A2** | Panel export — `apps/api/src/backtest/panel-export.ts` | `apps/api/reports/factor-panels/<lane>-<fingerprint>/{close,open,high,low,volume,eligible,manifest}.{csv,json}`; fingerprint = lane + window + symbol/bar counts | re-export is a no-op; U1/U2 masks reconcile with a stored `ScreenRun` day |
| **A3** | Bridge — `apps/api/scripts/alpha-bridge.py` | one `date × symbol` CSV per alpha (float32, NaN preserved) + `bridge-manifest.json` (alpha id, zoo id, zoo revision, warmup, `columns_required`, skipped + `SkipAlpha`/`RegistryError` reason) | no network; re-run is byte-identical; a deliberately broken alpha is skipped with a reason, not a crash |
| **A4** | Consumer — `quant-core/src/replayFromPanel.ts` + `multipleTesting.ts` | panel + mask + dates → `ReplayDay[]`; BH FDR + `E[\|IC\|]` by luck | unit tests: FDR monotonicity/known small case; **look-ahead invariant** — recomputing alpha `f` on a panel truncated at T equals the prefix of the full run to 1e-9, and a hand-written look-ahead alpha fails the test |
| **A5** | CLI — `pnpm -C apps/api backtest:factor` | `--market us\|hk\|all --zoo … --alpha <ids> --from/--to --json` → `reports/backtest/factor-<date>.{json,txt}` with per-alpha rows (IC, ICIR, NW t, spread, by-year, breadth/day, warmup, label, p, FDR) | artifact renders; a `--alpha` list of 3 runs end-to-end on both lanes |
| **A6** | The sweep | full US + HK sweep over the 222 / 170 clean alphas | every alpha has a label; the luck benchmark and both power floors are printed; artifacts for record |
| **A7** | Confirmation + PROGRESS | promoted-subset run on the vendor test half (US), bar per alpha, capped, guarded | verdict per promoted alpha; `PROGRESS.md` records window, universe, alpha set, zoo revision, labels, verdicts, limitations |

**Cost of a false start, deliberately bounded:** A6 produces labels whatever the
outcome, and A7 is a single run over ≤ 20 alphas — a negative sweep costs one
session, not a rework.

## Pre-registered limitations

1. **Survivorship / universe look-ahead** — the store holds today's 555 US / 141 HK
   names over ~5y. All claims are relative and upper bounds.
2. **One regime** — the window starts 2022-09, so it is one short stress period plus
   a long up-market. No 2008, no 2020, no 2022-H1.
3. **The picker window is spent for the screen** (Phase 4) and becomes spent-for-this-
   family at A6; the vendor design half becomes spent at A7. Neither may be re-used
   to choose a bar afterwards.
4. **Correlated tests** — the FDR/luck numbers treat the sweep as K independent
   trials; real alphas are correlated, so the effective trial count is smaller. The
   printed `E[max |IC|]` is therefore **conservative** (harder to pass).
5. **Normal-approximation p-values** for FDR under a HAC t-stat, disclosed as such.
6. **Delisting tails excluded from IC** via `forwardReturn`'s null; true IC is
   plausibly worse than measured. Signs unchanged from Phase 4c.
7. **HK venue distortion** — `adv20` without a consolidated tape, inherited.
8. **Zoo provenance** — third-party formula implementations (MIT repo; per-zoo
   `LICENSE.md`). Formulae are published papers; the ported code is not ours, and a
   per-zoo provenance line travels in every artifact.
9. **No production impact** — nothing in this phase changes `SCREEN_PARAMS`, the
   chain, the dashboard, or the deep-dive.

## Explicit non-goals

- No tuning, no grid, no parameter sweeps of any kind.
- Their backtest engine, their loaders, their IC math (`factor_analysis_core`), or
  their `multipletesting.py` at runtime.
- No LLM anywhere in the factor path.
- Porting the zoo to TypeScript; no `amount`/`vwap`/`sector` alphas in round 1.
- No minute bars, options, forex, crypto, A-share or futures lanes.
- No scheduled job — `backtest:factor` is a manual, in-session CLI.