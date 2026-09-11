# Phase 4b Plan — repair the test's calibration (no new hypothesis)

Planning session 2026-09-11, deep tier. Follows the executed Phase 4
(`docs/phase-4-plan.md`, ARTIFACT `apps/api/reports/backtest/2026-09-10.txt`).

**Status: LOCKED** — all four forks decided by the user on 2026-09-11.

## Locked decisions

| Fork | Decision |
|---|---|
| **A. Purpose** | **Repair the two power numbers + report the intervals + take the census, and pre-register a replacement statistic for FUTURE data only.** No new hypothesis is tested on this window; Phase 4's verdict is not revisited. |
| **B. Gate 2 after measuring** | **Report the interval, keep Gate 2 falsification-only, keep the verdict.** Only the *justification* is corrected. Promoting a gate to deciding after seeing its value is goalpost movement; promotion is legitimate only for the next pre-registration (D4). |
| **C. Census output** | **Descriptive only** — which gate binds, by lane and year. No `SCREEN_PARAMS` change; a breadth hypothesis is a later, separately-approved step. |
| **D. Verdict language** | **Annotate the 2026-09-10 artifact, add an explicit `insufficient_evidence` outcome class.** The stored result is never rewritten: the record stays append-only while the vocabulary stops conflating "no evidence" with "evidence of no". |

Consequence of Fork A for D4: the proportional spread and the Gate-2 interval are
reported **descriptively here**, and become gates only under a Phase-4c
pre-registration spent on data this window does not contain.

## Why this round exists

Phase 4 returned `h1_revised` on both lanes and reached the correct *surface*
conclusion (the pre-registered Gate 1 bar cannot be passed). But the run's
verdict rested on **two power numbers, and neither is sound**:

| | how Phase 4 obtained it | status |
|---|---|---|
| Gate 1's bar (`IC ≥ 0.02`) | computed from universe size 552/131 | **wrong N** — the gates leave breadth 180/25 |
| Gate 2's role (`IR ≥ 0.985`) | *asserted* from a "realistic screen IR of 0.3–0.7" | **never measured** |

The first is the calibration error already recorded in PROGRESS. The second is
the same error class and has not been noticed: the plan argues Gate 2 can never
confirm anything because portfolio alpha needs IR ≥ 0.985 — but that is a
statement about a *hypothetical* IR, while the realized differential is
**+38.03 % over 4.12 y** (≈ 9.2 %/yr simple), which would clear t = 2 with a tracking
error ≤ 4.6 %/yr. Whether the realized TE is that small **has never been
computed**: `simulatePortfolio` returns the daily return series, and
`neweyWestT` already exists, but nothing in the codebase puts a standard error
on the differential. Gate 2 is a point estimate with no interval, and the claim
that built the whole asymmetric gate design was an assumption.

So this round does **not** re-test the screen. It repairs the two numbers the
verdict was built on, and states what the window can actually answer.

## Finding 1 — Gate 1's bar cannot be fixed by re-thresholding

Three different estimates of the same quantity, all from published numbers:

| lane | naive SE (T independent days) | heuristic SE (breadth, `(1/√(N−1))·√h/√T`) | **realized NW SE** | realized floor at t = 2 |
|---|---|---|---|---|
| US | 0.00514 | 0.01066 (N = 180) | **0.01495** | **0.0298** |
| HK | 0.00890 | 0.03046 (N = 25) | **0.02462** | **0.0493** |

(Derived from the artifact: `sd_ic = mean / ICIR` → US 0.1611, HK 0.2667;
realized SE = mean / nwT; the NW inflation is 2.91× US and 2.76× HK versus the
4.47× = √20 the heuristic assumes.)

The heuristic's **two error sources have opposite signs and do not cancel
predictably**: per-day SE is understated when names are correlated (HK's 25
names are nowhere near independent), while the overlap penalty is overstated
(2.8× realized vs 4.5× assumed). US lands 1.40× worse than the heuristic, HK
0.81× *better*. You cannot know the sign of the net error without measuring —
which is why the plan's own arithmetic said HK's floor was 0.0247 and the
realized floor is 0.0493.

**Consequence for the bar.** With the realized SE, `IC = 0.02` gives US t = 1.34
and HK t = 0.81. There is no threshold that rescues this: to be reachable at
t = 2 the bar must be ≥ 0.0298 (US) / 0.0493 (HK), and at that size the test only
speaks about large effects.

**Measured intervals (what the window actually established):**

| lane | mean 20d IC | 95 % CI | verdict the interval supports |
|---|---|---|---|
| US | 0.0145 | **−0.015 … +0.044** | uninformative — 0 and 0.03 are both inside |
| HK | −0.0192 | **−0.067 … +0.029** | uninformative — 0 and even a negative edge are inside |

Both gates read `FAIL`; the honest label is **insufficient evidence**, not
"hypothesis revised" (see Fork D).

## Finding 2 — Gate 2's power is assumed, and HK's falsification is not affected

Gate 2's falsification criteria only ask whether the differential is ≤ 0, so
**HK's falsification is real and power-independent**: the portfolio lost to its
own equal-weight universe by 27.45 % at base costs and 50.08 % at 2×, negative in
3 of 5 calendar years. No statistical subtlety rescues a loss.

US is the opposite problem: it was *not* falsified (+38.03 % / +24.98 %), and the
plan is careful to say that is not confirmation. That caution is right — but the
*reason* given for it is the unmeasured IR claim. This round replaces the
assertion with the measurement (Fork B governs what may be done with it).

## Finding 3 — the reported "top-15 spread" is not the same statistic in the two lanes

`spreadSeries` splits on `rank <= topN` with the shipped `topN = 15`:

| lane | eligible breadth | top-15 share | what the number actually measures |
|---|---|---|---|
| US | 180 | 8.3 % | roughly a top-decile vs rest contrast |
| HK | 25 | **60 %** | top 60 % vs bottom 40 % — not a decile effect |

The artifact prints both under one label (`top-15-vs-rest spread`) and the
Phase-4 review read US +0.83 % @20d against HK +0.09 % as comparable. They are
not. The same asymmetry is a **product** fact, not just a reporting one: the HK
watchlist is 15 of 25 eligible names — 60 % of that lane's universe.

## Finding 4 — breadth is the binding constraint and its cause has never been measured

552 → 180 (US, 33 %) and 131 → 25 (HK, 19 %) after the eligibility gates.
`replayScreen` keeps only `excludedCount` (`replay.ts`), discarding the
per-reason breakdown that `runScreen` already computes. So the project has never
known *which* gate does the cutting — and breadth is the entire reason the
power is where it is.

This matters because the census is **clean**: it describes the screen's inputs,
not returns, so it consumes no return-information and cannot contaminate a
return-based hypothesis.

## Locked decisions (forks, decided 2026-09-11)

See the table at the top. The options and the reasoning rejected on the way to
each decision are kept below, because the *rejected* option is usually the one a
future reader will wonder about.

| Fork | Question | Options | Recommendation |
|---|---|---|---|
| **A. Purpose** | What is this round allowed to produce? | (1) Repair the two power numbers + report intervals; no new hypothesis; no verdict change. (2) (1) **plus** pre-register a replacement statistic (proportional spread and/or the Gate-2 differential interval) for **future data only**. (3) Re-specify H1's score itself. | **(1) + (2)**. (2) costs nothing and leaves a usable test behind. (3) is barred — new hypothesis, needs fresh data. |
| **B. Gate 2 after measurement** | If the measured differential t ≥ 2, does Gate 2 stop being falsification-only? | (1) No — report the interval, keep the role and the verdict; correct only the *justification*. (2) Yes — promote it to deciding when its own t ≥ 2. (3) Leave it unmeasured. | **(1)**. (2) is moving the goalposts after seeing the number; it would also require re-deriving "realistic IR" post-hoc. (2) is legitimate for the *next* pre-registration (D4). |
| **C. Census output** | What may the eligibility census be used for? | (1) Descriptive only — document which gate binds. (2) (1) + pre-register a breadth hypothesis for fresh data. (3) (1) + change `SCREEN_PARAMS` now. | **(1)**. (3) is barred by the Phase-4 plan. (2) is the natural follow-on if one gate dominates. |
| **D. Verdict language** | Phase 4 stored `h1_revised` for both lanes, which reads as "hypothesis revised". | (1) Annotate the artifact + add an `insufficient_evidence` outcome class for future runs; leave the stored result unchanged. (2) Relabel the stored result. (3) Leave as-is. | **(1)**. The record stays append-only, but the vocabulary stops conflating "no evidence" with "evidence of no". |

## What this round will do

All of it is **additive diagnostics on an already-published result**, on the same
window. Nothing here can confirm H1, and no number here may change Phase 4's
verdict.

- **D1 — the Gate-1 power statement, corrected.** Recomputed from published
  numbers (no re-run): show the naive / heuristic / realized SE triple, the
  realized floor per lane, and the 95 % intervals. Print the power note
  *unconditionally* (today it is gated behind `gate1.passed`, so the single most
  important context — "this lane could only detect 0.0298" — is suppressed
  exactly when it matters).
- **D2 — the Gate-2 interval.** `neweyWestT` on the daily differential
  (`result.dailyReturns` vs `benchReturns`), per lane per cost level; report
  IR = mean/TE and the NW t. Pre-registered lag = **20** (consistent with the
  IC gate and the ~15d average hold), with lags 5 and 60 reported as
  sensitivity.
- **D3 — the eligibility census.** Retain `excluded` reasons in `ReplayDay` as
  an additive tally; report rejections by gate, lane, and year, plus the
  reject-share of the 552/131 screenable universe. Explains breadth 180/25.
- **D4 — the proportional spread.** Redefine the cutoff as a share of each
  lane's breadth (pre-registered: **top decile**, with a documented
  small-breadth rule, since HK's decile is 2–3 names) and report mean + NW t per
  lane at all three horizons. **Descriptive only** for this window; it becomes a
  gate only under a Phase-4c pre-registration.
- **D5 — verdict vocabulary.** `insufficient_evidence` added as an explicit
  outcome class alongside `h1_holds` / `ranking_power_but_not_tradable` /
  `h1_revised`; the 2026-09-10 artifact is annotated, not rewritten.

## Build order (fast tier once locked)

1. `packages/quant-core` — additive: `spreadSeries` gains a proportional cutoff;
   `neweyWestT` used on the differential; `ReplayDay.excludedByReason`; the
   unconditional power note; the new verdict class. Tests: the proportional
   cutoff at HK-scale breadth, NW on a synthetic differential with known t, and
   the census tally against a hand-built day.
2. `apps/api` `backtest:screen` — report the new columns; artifact
   `reports/backtest/2026-09-11.{json,txt}` (the 09-10 artifact is preserved).
3. Docs: architecture §9 status, this plan's outcome section, PROGRESS.

Cost: one session, one ~2-minute re-run, no new data source, no dependency.

## Explicit non-goals

- **No tuning, no `SCREEN_PARAMS` change, no weight/gate search** — Phase 4's
  ban stands; the descriptive weight sweep remains barred from influencing the
  ship.
- **No re-litigation of Phase 4's verdict.** This round corrects the *reasons*,
  not the result.
- **No XNYS / Databento universe work.** It is the only genuinely fresh
  cross-section available (VendorBar: 16,777 symbols, 15.3 M rows) but it has no
  as-of adjustment or CA-degrade layer, so it is a **data project**, not a
  statistics one. Recorded here as the Phase-4c candidate, not attempted.
- No CPVC/PBO, no intraday, no LLM-layer work (Round 3), no live trading.

## Methodology rule to carry forward

Phase 4 set a bar from an *assumed* effect size, then discovered the window
could not measure it. The reusable rule, to be applied to the next
pre-registration:

> **Set a bar from a power calculation on a design subset, never from a
> plausible effect size.** Split the available history into a design half and a
> test half: compute breadth, NW SE and the power floor on the design half,
> lock the bar, then spend the test half once. The realized SE cannot be
> predicted from universe size, breadth, or horizon — US and HK each missed it
> in the opposite direction.

## What this round cannot claim

1. Nothing here confirms or refutes H1. Every statistic is computed on the window
   that produced Phase 4's numbers, so **the window is spent** for these
   quantities — including the proportional spread (D4) and the differential
   interval (D2).
2. An interval that excludes 0 would still be one window, one universe snapshot,
   and one regime (~1 month of bear).
3. Survivorship and universe look-ahead are unchanged; all claims stay relative.
4. The census (D3) describes *inputs* only. It cannot show that a wider universe
   would have produced a different IC.
5. Gate 2's interval, whatever it says, changes no verdict (Fork B, option 1).
