# Phase 5 Plan — the LLM deep-dive layer (H2), validated prospectively

Planning session 2026-09-11. Follows Phase 4/4b, which spent the deterministic
screen's only window and found its Gate 1 bar unreachable at both lanes' breadth
(`docs/phase-4b-plan.md`).

**Status: LOCKED** (forks decided 2026-09-11). The harness is built and refuses to
emit a verdict until the readiness rule below is satisfied.

## Locked decisions

| Fork | Decision |
|---|---|
| **A. Breadth** | **Decoupled: measure 40, display 10.** The fork as posed offered a false trade — a longer list versus a validatable layer — because measurement breadth and display breadth need not be the same number. `SCREEN_PARAMS.topN` → `{US: 40, HK: 40}` (candidates persisted, which feeds the deep-dive) and a new `SCREEN_PARAMS.displayTopN` → `{US: 10, HK: 5}` (what the dashboard presents). Horizon to a read: ~65 months → **~15 months**; cost ~4× (360k → ~1.44M tokens/day, measured at ~18k tokens/name). The validated claim becomes "conviction orders outcomes within the top 40", which is where the daily list is drawn from anyway. `--top` was removed from `daily-chain.sh` so the CLI default is the single source of truth. |
| **B. Target IC** | **0.10**, as recommended. |
| **C. Pooling** | **Pooled primary**, per lane reported. |
| **D. Secondary** | **Reported** — the benchmark-free conviction split, with its own NW t. |

Post-lock amendment (the review discipline of 4b applied to this plan): the
**HK display decision** (below) landed in the same session and set
`displayTopN.HK = 5`, which supersedes the plan's implicit "display 10" for HK.

## Why this round

Phases 4 and 4b established that the **deterministic screen is not resolvable**
on the available data: its 0.02 rank-IC bar needs 4.7 more years for US and 18.1
for HK (`phase4c:accrual`), and the window it was tested on is now spent.

The **LLM deep-dive layer has never been scored at all.** It is also the part of
the product that is not a commodity — a momentum/Sharpe ranking is reproducible by
anyone, whereas a grounded, risk-enumerating verdict is the thing this project
actually built. So the layer with zero evidence is the layer with the most value
at stake.

Unlike the screen, its sample **accrues for free**: every run writes
`DeepDiveRun` + `DeepDiveReport`, and the verdicts, convictions and forward
returns are all already in the store. 45 reports exist from 4 decision days.

## The power problem, priced before designing anything

Primary statistic: per-day Spearman IC of **conviction** vs **forward return**,
pooled over the day's non-abstain verdicts, Newey–West lag = horizon (the same
overlap correction as Phase 4). Per-day IC SE ≈ 1/√(N−1) for N verdicts in that
day's set, so effective N ≈ T/h and:

> sessions needed = h · (SE_day · 2.487 / IC_target)² — 80 % power, one-sided α = 0.05

| verdicts per day | IC 0.05 | IC 0.10 | IC 0.15 |
|---|---|---|---|
| 10 (today) | 5496 d ≈ **262 mo** | 1374 d ≈ **65 mo** | 611 d ≈ **29 mo** |
| 20 | 2603 d ≈ 124 mo | 651 d ≈ 31 mo | 289 d ≈ 14 mo |
| 40 | 1268 d ≈ 60 mo | 317 d ≈ **15 mo** | 141 d ≈ **7 mo** |
| 120 | 416 d ≈ 20 mo | 104 d ≈ **5 mo** | 46 d ≈ 2 mo |

**Two conclusions, and the second is the actionable one.**

1. **At today's breadth the layer is not testable either.** 10 verdicts/day puts a
   modest IC 0.10 about 5.4 years away — the same disease as the screen, from a
   different cause (tiny cross-section instead of a tiny effect).
2. **But here breadth is a *cost* decision, not a *time* decision.** The screen
   cannot buy power: its universe is what it is. The deep-dive can, because each
   extra name is ~7 LLM calls at pennies. Going 10 → 40 names/lane cuts the
   required horizon **4.3×** (65 → 15 months) for ~4× the tokens, which the
   Phase-2 budget already called pennies-class (140 → 560 calls/day).

**This is the round's central fork.** It is a genuine product trade: deepening 40
names instead of 10 produces a longer watchlist than a human wants to read, in
exchange for a layer that can be validated inside a year.

## Design

- **Statistic (primary):** mean per-day Spearman IC of conviction vs h-day forward
  return, `h = 20` primary, Newey–West lag 20. This is deliberately the *same*
  machinery as Phase 4 Gate 1 — one implementation, one overlap correction, one set
  of conventions.
- **The benchmark question is moot for the IC, and this is worth stating rather
  than deciding.** A per-day rank correlation is invariant to adding the same
  constant to every name's forward return that day, so "excess vs the lane's
  equal-weight universe" and "absolute" give *identical* ICs. The benchmark only
  matters for the secondary statistic, which is therefore defined
  independently of it (see below). One fork removed by arithmetic.
- **Statistic (secondary, benchmark-free):** within-day high-conviction minus
  low-conviction mean forward return (median split), reported with a NW t on the
  daily spread series. This is the product-shaped question — *does the conviction
  ordering sort outcomes?* — and it needs no universe definition.
- **Conviction, not rating, is primary.** Conviction is continuous and already in
  [−1, 1]; the 5-tier rating is coarser and clusters (Phase-2 smoke produced 8 of
  20 names at neutral ±0.15). Rating is reported as a robustness view only.
- **Abstain is excluded from the IC, counted in coverage.** An abstain is a
  deliberate non-opinion; scoring it as a zero-conviction opinion would import a
  decision nobody made.
- **Per lane, then pooled.** HK and US are reported separately (as in Phase 4) and
  *also* pooled, because pooling is the cheapest legitimate power gain: two lanes
  double the per-day breadth for the same calendar time.
- **Sample:** `DeepDiveRun.status = 'complete'` only — the W2 invariant means a
  crashed run can never contribute a verdict. Entry date = newest bar date at or
  before the run's HKT date; forward return computed from the adjusted series, so
  dividends are included and the return is total.

## Readiness rule (the pre-registered bar)

No magic threshold is invented. The harness **refuses to decide** until the
accrued sample satisfies the power condition for a stated target effect:

> decide only when `SE(mean IC) ≤ IC_target / 2.487`, i.e. **80 % power at
> one-sided α = 0.05** for that IC_target; report `days / daysNeeded` until then.

`IC_target` defaults to **0.10** and is a fork (see below). `SE(mean)` is measured
from the accrued series — never assumed — and until enough days exist to measure
it, the projection uses the theoretical `1/√(N−1)` per-day SE and says so.

**Verdict vocabulary** (reusing Phase 4b's D5 class, because the same distinction
bites here):
- `h2_holds` — IC ≥ target **and** NW t ≥ 2, at the readiness threshold.
- `h2_falsified` — IC ≤ 0 with t ≤ −2, at the readiness threshold.
- `insufficient_evidence` — readiness not met, **or** met with the interval
  spanning zero. This is the expected outcome for months and must be the *default*
  reading, not a failure to explain.

**SE-stability guard** (inherited from Phase-4b D6, where the cross-sectional SE
factor proved unstable): if the second half's realized per-day SE exceeds the
first half's by more than 1.5×, report the lane **inconclusive** rather than
letting a regime shift masquerade as a signal.

## Forks to lock

| Fork | Question | Options | Recommendation |
|---|---|---|---|
| **A. Breadth** | How many names per lane does the deep-dive cover? | (1) Keep 10 — product-shaped, but ~5.4 y to a read at IC 0.10. (2) Widen to **30–40** — a longer list than you want to read, ~15 mo to a read, ~4× tokens (still pennies). (3) Widen only for a fixed 6-month measurement window, then revert. | **(2)**. The layer is the differentiator and it is currently unmeasurable; a list you skim and discard costs less than a permanently unvalidated product. (3) is seductive but changes the treatment partway through. |
| **B. Target IC** | What effect is the bar set to detect? | (1) **0.10** — a modest within-shortlist ordering. (2) 0.15 — robust, but ~4.3× fewer days needed, i.e. an easy bar. (3) 0.05 — ambitious; 4× the days of 0.10. | **(1) 0.10**. It is roughly the smallest edge that would change which names you act on, and the readiness rule makes the horizon follow from it. |
| **C. Pooling** | Is the primary read per lane or pooled? | (1) Per lane, pooled reported as secondary. (2) **Pooled primary**, per lane descriptive. | **(2)**. Pooling halves the horizon and the two lanes are the same hypothesis applied to two universes; per-lane reads stay reported so a bad lane cannot hide. |
| **D. Secondary** | Is the conviction-split reported? | (1) Yes, as a benchmark-free descriptive with its own NW t. (2) Omit. | **(1)**. It is the product-shaped question and costs nothing. |

## Pre-registration amendment (2026-09-11, **before any label existed**)

A confound was found and fixed the same day the harness was built. It is recorded
as an amendment rather than a new round because of *when* it was found.

**Finding.** Across the 45 stored verdicts, Spearman(screen rank, conviction) =
**0.319** pooled (0.34 / 0.31 / 0.57 / 0.40 per run over 40 non-abstain verdicts).
Two consequences:

- The layer is **not** an echo of the screen — 0.32 is nowhere near 1 — so H2 is a
  genuinely distinct hypothesis and the round's premise holds.
- But they share ~10 % of variance (0.32²), so a positive **raw** conviction IC
  could partly be the screen's own unvalidated ranking leaking through, and the
  round could not say whether the LLM added information or merely restated it.

**Why this is legitimate to fix now rather than after the read.** The measurement
used **no forward returns at all** — only conviction and rank, both known at
verdict time. So the amendment cannot have been informed by any outcome, and there
is no label yet for it to have been selected against. Fixing it later, once
returns exist, would have been the goalpost movement the project forbids.

**Amendment.** A second statistic is pre-registered alongside the raw one, and it
is the one that **decides H2**:

> `IC | rank` — the per-day Spearman partial correlation of conviction against
> forward return, controlling for the screen rank.

Both are reported on every run, with their own readiness rules and the same
SE-stability guard. The reading is pre-registered as:

| raw IC | IC \| rank | conclusion |
|---|---|---|
| ≥ target, t ≥ 2 | ≥ target, t ≥ 2 | **the layer adds information** — H2 holds |
| ≥ target, t ≥ 2 | ~0 | **the layer restates the screen** — H2 does *not* hold, and the raw IC was rank leakage |
| ~0 | any | no ordering information either way — insufficient, as usual |

The controlled series is slightly noisier by construction (theoretical per-day SE
`1/√(N−2)` against `1/√(N−1)`, one covariate), so its required horizon is ~2 %
longer — 326 days against 318 at breadth 40. Reported, not silently absorbed.

**Test evidence that the statistic can do its job:** a synthetic universe whose
conviction is a noisy function of rank and nothing else produces a **raw IC > 0.4
while `IC | rank` stays under 0.25**; add genuine conviction-carried information and
the controlled IC rises above 0.3. Without this the layer could be credited with
information it does not have.

## Pre-registration amendment 2 (2026-09-11) — the promptness gate

Found while answering an operational question about the weekend schedule, and
fixed the same day. **There are no forward labels yet**, so as with amendment 1
this cannot have been selected against an outcome.

**Finding.** Nothing in the harness cared *when* a run happened relative to the
session it screened. That matters because the two differ legitimately for one lane
and illegitimately for any other: `daily-us` runs at 06:10 HKT on the morning
after the US close, so `runDate = entry + 1` is its normal convention — while the
evening catch-up slot (20:30 daily, weekends included) can run a session **two or
more days late**. A verdict formed in a Sunday catch-up about Friday's session used
**weekend news**: information the Friday close did not have. That is look-ahead in
the X variable, which is the one thing the prospective design exists to avoid.

**Measured on the existing rows:** the harness now reports **24 of 45 verdicts
(53 %) excluded as late** — every run from Sunday **2026-09-06**, which screened
Friday **2026-09-04** and ran two days later. They were flagged before any label
existed, so nothing downstream was ever computed from them.

**Amendment.** A verdict counts as a prospective observation only if the run
happened within `MAX_PROMPT_LAG_DAYS = 1` calendar day of the session it screened.
The threshold is the pipeline's own convention, not a taste: 1 is what the US lane
requires by construction, and it also admits a Saturday catch-up of a missed Friday
HK session (the same tolerance the US lane already lives with). Anything later is a
different information set. Excluded verdicts are **counted and reported**, never
silently dropped — a silent drop would be indistinguishable from data that never
arrived.

**An asymmetry worth recording:** this applies to the **verdict** sample only. A
late *screen* is PIT-clean, because it is a deterministic function of bars and
actions dated at or before the session it screens — so the Phase-4c accrual is
robust to late runs and needs no such gate. Only the layer that reads *news* has
this failure mode.

## What this round will not do

- **No prompt or pipeline changes.** `PROMPT_VERSION` stays v1; changing the
  treatment mid-accumulation invalidates the sample it was accruing.
- **No re-scoring of the 4 existing decision days as a verdict.** 45 reports over
  4 days is not a sample; that is the point of the readiness rule.
- **No changing `SCREEN_PARAMS`** (Fork C of Phase 4b stands), and no claim about
  H1 from this round.
- No live trading; no new data source.

## Build order

1. `packages/quant-core` — pure scoring core: per-day conviction IC series, NW
   stats, benchmark-free conviction split, and the readiness/power rule. Tests
   pin the power arithmetic, the abstain exclusion, single-name days, and that a
   zero-variance day is skipped rather than counted as 0.
2. `apps/api` — `verdict:validate` CLI over `DeepDiveRun`/`DeepDiveReport` +
   `bar`, reusing `buildForwardSeries` so forward returns stay total-return and
   PIT-consistent. Emits a report + dated artifact; exits 0 while undecidable.
3. Docs: architecture §9, PROGRESS, and this plan's outcome section.

Cost: one session to build the harness (which then accrues for free), plus the
LLM cost of whatever breadth Fork A chooses.
