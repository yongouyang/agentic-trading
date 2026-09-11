# Phase 4b Plan — repair the test's calibration (no new hypothesis)

Planning session 2026-09-11. Follows the executed Phase 4
(`docs/phase-4-plan.md`, ARTIFACT `apps/api/reports/backtest/2026-09-10.txt`).

**Status: LOCKED** — all four forks decided by the user on 2026-09-11.

## Locked decisions

| Fork | Decision |
|---|---|
| **A. Purpose** | **Repair the two power numbers + report the intervals + take the census, and pre-register a replacement statistic for FUTURE data only.** No new hypothesis is tested on this window; Phase 4's verdict is not revisited. |
| **B. Gate 2 after measuring** | **Report the interval, keep Gate 2 falsification-only, keep the verdict.** The *role* is fixed, not the *claim*: promoting a gate after seeing its value is goalpost movement, so this round only withdraws the unsupported "Gate 2 can never confirm" (Finding 2). A powered differential test becomes a legitimate deciding gate in **Phase 4c**, which has not yet seen its data. |
| **C. Census output** | **Descriptive only** — which gate binds, by lane and year. No `SCREEN_PARAMS` change; a breadth hypothesis is a later, separately-approved step. |
| **D. Verdict language** | **Annotate the 2026-09-10 artifact, add an explicit `insufficient_evidence` outcome class.** The stored result is never rewritten: the record stays append-only while the vocabulary stops conflating "no evidence" with "evidence of no". |

Consequence of Fork A for D4: the proportional spread and the Gate-2 interval are
reported **descriptively here**, and become gates only under a Phase-4c
pre-registration spent on data this window does not contain.

## Amendments (2026-09-11, pre-execution)

This document was locked, then reviewed adversarially before anything was run.
Eleven defects were found and fixed here. Nothing had been executed, so amending
a locked document is legitimate — but *visibly*, by the same rule that made
"annotate, don't rewrite" the right answer for Fork D.

| # | Where | Amendment | Reason |
|---:|---|---|---|
| 1 | Finding 2 | HK's Gate-2 result split into *the pre-registered rule firing* vs *the inference that HK has no edge* | the doc asserted an unmeasured power claim about the very quantity it declared unmeasured — the exact error this round exists to fix |
| 2 | Finding 2 | "Gate 2 can never confirm" **withdrawn**; the epistemic status of the US non-falsification stated explicitly | the doc falsified the premise (IR ≥ 0.985) but kept the conclusion drawn from it, leaving US Gate 2 uninterpretable |
| 3 | D2 | specifies the **daily arithmetic** differential and prints it beside the compounded differential | the artifact's `+38.03 %` is a difference of *compounded* returns; a NW t on the daily series tests a different statistic |
| 4 | D4 | cutoff pinned: `max(ceil(0.10 × breadth), 5)`; Phase-4c may change it only *before* spending new data | an unspecified rule in a lane where a decile is 2–3 names pre-registers nothing |
| 5 | Finding 1, methodology | "cannot be predicted" → "observed to miss in both directions in two lanes" | n = 2 supports the operational rule (measure it), not a universal claim |
| 6 | preamble, cannot-claim 1 | "cannot confirm H1 **as pre-registered**" ≠ "carries no evidence"; D2's support for *tradability* stated | the doc was arguing itself out of its most useful output |
| 7 | new Finding 5 | two lanes tested at t = 2 with no correction → family-wise error ≈ 10 %; Phase 4c must correct or nominate a primary lane | an unrecorded consequence of the locked per-lane design |
| 8 | Finding 1 | intervals recomputed as `mean ± 2.01·SE` at the effective df, and labelled approximate | 1.96 is the wrong quantile at df ≈ 48, and NW + normality is an approximation |
| 9 | cannot-claim 1 | the count of Phase 4's published statistics (≈ 150) | "the window is spent" was asserted rather than measured |
| 10 | non-goals | production behaviour stated to be unchanged | a reader could otherwise infer the shipped picker is being altered |
| 11 | Finding 3 | the product implication of `topN = 15` (8 % of US breadth, 60 % of HK's) stated | it is a product fact, not only a reporting artefact |

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

The heuristic's **two error sources have opposite signs**, which is why its net
error is not predictable *in advance*: per-day SE is understated when names are
correlated (HK's 25 names are nowhere near independent), while the overlap
penalty is overstated (2.8× realized vs 4.5× assumed). In these two lanes the net
went **both ways** — US landed 1.40× worse than the heuristic, HK 0.81×
*better* — which is why the plan's own arithmetic said HK's floor was 0.0247 and
the realized floor is 0.0493. Two lanes are two observations, not a law: the
operational conclusion is *measure the realized SE*, not that it is
unpredictable in principle.

**Consequence for the bar.** With the realized SE, `IC = 0.02` gives US t = 1.34
and HK t = 0.81. There is no threshold that rescues this: to be reachable at
t = 2 the bar must be ≥ 0.0298 (US) / 0.0493 (HK), and at that size the test only
speaks about large effects.

**Measured intervals (what the window actually established):**

| lane | mean 20d IC | 95 % CI | verdict the interval supports |
|---|---|---|---|
| US | 0.0145 | **−0.016 … +0.045** | uninformative — 0 and 0.03 are both inside |
| HK | −0.0192 | **−0.069 … +0.030** | uninformative — 0 and even a negative edge are inside |

The intervals are `mean ± 2.01·SE`, using the *t*-quantile at the effective
degrees of freedom (≈ T/20 − 1 ≈ 48) rather than 1.96, and they are
**approximate**: Newey-West corrects the standard error, but the normal
approximation still ignores the skew and fat tails of a daily IC series.

Both gates read `FAIL`; the honest label is **insufficient evidence**, not
"hypothesis revised" (see Fork D).

## Finding 2 — Gate 2's power has never been measured, and the claim built on it must be withdrawn

Phase 4 conflated two different things: the **decision rule** and the
**inference** drawn from it.

**For HK, the rule fired — and that is power-independent.** Gate 2's
falsification criteria only ask whether the differential is ≤ 0, so the rule needs
no interval: the HK portfolio lost to its own equal-weight universe by 27.45 % at
base costs and 50.08 % at 2×, negative in 3 of 5 calendar years, and the
pre-registered falsification **fired**. That is a decision, and it stands.

**The inference is a separate claim, and it is not measured.** "HK's screen has
no edge" needs the same interval this round computes for US, because a loss in
one window is not by itself evidence of a negative edge. Both lanes get an
interval in D2; neither is pre-judged here. (The magnitudes −27 % and −50 % are
large enough that the interval will *probably* exclude 0 — and "probably" is
exactly what this document is not allowed to trade on.)

**For US, Phase 4 was careful to call non-falsification "not a confirmation".**
The caution was right; the *reason* given for it was not. "Gate 2 can never
confirm, because portfolio alpha needs IR ≥ 0.985" is a statement about a
*hypothetical* IR (0.3–0.7), and it is hereby **withdrawn as unsupported**. What
replaces it:

> Gate 2's *pre-registered* role cannot be changed retroactively — that is what
> pre-registration means, and Fork B locks it. But the *epistemic status* of the
> US non-falsification is now explicit: if the measured differential t ≥ 2, it is
> **the only adequately-powered evidence in the project**. It is reported as
> such, labelled "not pre-registered as a confirming gate", and it does not
> change Phase 4's verdict — while **Phase 4c must make a powered differential
> test the deciding gate**, because the asymmetry that shaped Phase 4 has lost
> its justification.

## Finding 3 — the reported "top-15 spread" is not the same statistic in the two lanes

`spreadSeries` splits on `rank <= topN` with the shipped `topN = 15`:

| lane | eligible breadth | top-15 share | what the number actually measures |
|---|---|---|---|
| US | 180 | 8.3 % | roughly a top-decile vs rest contrast |
| HK | 25 | **60 %** | top 60 % vs bottom 40 % — not a decile effect |

The artifact prints both under one label (`top-15-vs-rest spread`) and the
Phase-4 review read US +0.83 % @20d against HK +0.09 % as comparable. They are
not. The same asymmetry is a **product** fact, not just a reporting one: the HK
watchlist is 15 of 25 eligible names — 60 % of that lane's universe, against 8 %
in US. Concretely, `SCREEN_PARAMS.topN = 15` is *two different rules* wearing one
name: buy the top 8 % of the universe in US, and buy 60 % of it in HK. Recording
it is in scope; changing it is not (Fork C locks any `SCREEN_PARAMS` edit out of
this round). It is also a candidate explanation, for Phase 4c, of why the HK
spread (+0.09 % @20d) is indistinguishable from zero.

## Finding 4 — breadth is the binding constraint and its cause has never been measured

552 → 180 (US, 33 %) and 131 → 25 (HK, 19 %) after the eligibility gates.
`replayScreen` keeps only `excludedCount` (`replay.ts`), discarding the
per-reason breakdown that `runScreen` already computes. So the project has never
known *which* gate does the cutting — and breadth is the entire reason the
power is where it is.

This matters because the census is **clean**: it describes the screen's inputs,
not returns, so it consumes no return-information and cannot contaminate a
return-based hypothesis. (It could still *select*: using the census to choose
which gate to relax and then re-testing IC on this window would be a selection
step. Fork C locks it to description for exactly that reason.)

## Finding 5 — two lanes, two tests, no correction

Both lanes were tested against t = 2, reported separately, with no conjunction
and no multiplicity correction — a locked Phase-4 decision. The unrecorded
consequence: the chance of at least one spurious "pass" across the pair is
**≈ 10 %, not 5 %**. With both lanes failing this is moot for Phase 4, but it is
not moot going forward: Phase 4c should either correct for multiplicity
(two lanes at Bonferroni → t ≈ 2.24) or nominate one **primary** lane and treat
the other as descriptive. Recorded so that choice is made deliberately instead of
inherited.

## Forks — options considered, decided 2026-09-11

See the decision table at the top. The options and the reasoning rejected on the
way to each decision are kept below, because the *rejected* option is usually the
one a future reader will wonder about.

| Fork | Question | Options | Recommendation |
|---|---|---|---|
| **A. Purpose** | What is this round allowed to produce? | (1) Repair the two power numbers + report intervals; no new hypothesis; no verdict change. (2) (1) **plus** pre-register a replacement statistic (proportional spread and/or the Gate-2 differential interval) for **future data only**. (3) Re-specify H1's score itself. | **(1) + (2)**. (2) costs nothing and leaves a usable test behind. (3) is barred — new hypothesis, needs fresh data. |
| **B. Gate 2 after measurement** | If the measured differential t ≥ 2, does Gate 2 stop being falsification-only? | (1) No — report the interval, keep the role and the verdict; correct only the *justification*. (2) Yes — promote it to deciding when its own t ≥ 2. (3) Leave it unmeasured. | **(1)**. (2) is moving the goalposts after seeing the number. But (1) is **narrower than it looks**: it fixes the role, not the *claim*. "Gate 2 can never confirm" is withdrawn as unsupported (Finding 2), and Phase 4c — which has not yet seen its data — is where a powered differential test becomes a legitimate deciding gate. |
| **C. Census output** | What may the eligibility census be used for? | (1) Descriptive only — document which gate binds. (2) (1) + pre-register a breadth hypothesis for fresh data. (3) (1) + change `SCREEN_PARAMS` now. | **(1)**. (3) is barred by the Phase-4 plan. (2) is the natural follow-on if one gate dominates. |
| **D. Verdict language** | Phase 4 stored `h1_revised` for both lanes, which reads as "hypothesis revised". | (1) Annotate the artifact + add an `insufficient_evidence` outcome class for future runs; leave the stored result unchanged. (2) Relabel the stored result. (3) Leave as-is. | **(1)**. The record stays append-only, but the vocabulary stops conflating "no evidence" with "evidence of no". |

## What this round will do

All of it is **additive diagnostics on an already-published result**, on the same
window. Nothing here may change Phase 4's verdict, and nothing here can confirm
**H1 as pre-registered**.

That last clause is narrower than it may look, and the difference matters. D2 can
produce *strong evidence about tradability* — the picker's differential against
its own universe, with an interval — which is a claim the product actually makes.
What it cannot do is convert that into a confirmation of H1, because H1's
confirming gate was pre-registered as Gate 1, and Gate 1 failed.

- **D1 — the Gate-1 power statement, corrected.** Recomputed from published
  numbers (no re-run): show the naive / heuristic / realized SE triple, the
  realized floor per lane, and the 95 % intervals. Print the power note
  *unconditionally* (today it is gated behind `gate1.passed`, so the single most
  important context — "this lane could only detect 0.0298" — is suppressed
  exactly when it matters).
- **D2 — the Gate-2 interval.** `neweyWestT` on the **daily arithmetic
  differential** `p_t − b_t` (`result.dailyReturns` vs `benchReturns`), per lane
  per cost level; report the mean daily differential, its annualised tracking
  error, IR = mean/TE and the NW t. Pre-registered lag = **20** (consistent with
  the IC gate and the ~15d average hold); lags 5 and 60 are reported as
  *descriptive* sensitivity, and if the sensitivity changes the conclusion that
  is reported rather than resolved by picking a lag.

  **Which statistic this is, precisely.** The artifact's headline `+38.03 %` is
  `totalReturn_p − totalReturn_b` — a difference of **compounded** returns —
  while the NW t tests the mean of the **arithmetic** daily difference. The two
  agree only to first order, so the report prints the daily mean × T and the
  compounded differential side by side and labels the interval as belonging to
  the former. Otherwise the artifact's headline and D2's t read as one number
  when they are two.
- **D3 — the eligibility census.** Retain `excluded` reasons in `ReplayDay` as
  an additive tally; report rejections by gate, lane, and year, plus the
  reject-share of the 552/131 screenable universe. Explains breadth 180/25.
- **D4 — the proportional spread.** Report the top-vs-rest spread with a
  **proportional** cutoff instead of the fixed `topN = 15`, at all three
  horizons, with a NW t on the daily spread series.

  **The cutoff is specified here, not deferred.** In HK a decile is 2–3 names,
  so the rule *is* the statistic, and an unspecified rule pre-registers nothing:
  `cutoff = max(ceil(0.10 × breadth), 5)` per lane per day — a decile wherever
  the lane is wide enough, floored at 5 names on thin days. **Descriptive only**
  for this window (it is spent for this statistic too — Finding 1); it becomes a
  gate only under a Phase-4c pre-registration, which may revise the rule provided
  it does so *before* spending new data.
- **D5 — verdict vocabulary.** `insufficient_evidence` added as an explicit
  outcome class alongside `h1_holds` / `ranking_power_but_not_tradable` /
  `h1_revised`; the 2026-09-10 artifact is annotated, not rewritten.

## Build order (fast tier once locked)

1. `packages/quant-core` — additive only: `spreadSeries` gains the proportional
   cutoff `max(ceil(0.10 × breadth), 5)`; `neweyWestT` applied to the differential;
   `ReplayDay.excludedByReason`; the power note emitted unconditionally; the
   `insufficient_evidence` verdict class. Tests: the proportional cutoff at
   HK-scale breadth (including the 5-name floor), NW on a synthetic differential
   with a known t, and the census tally against a hand-built day.
2. `apps/api` `backtest:screen` — report the new columns, including the
   compounded differential printed beside the arithmetic one (D2) and the census
   by gate/lane/year (D3); artifact `reports/backtest/2026-09-11.{json,txt}` with
   the 09-10 artifact preserved.
3. Docs: architecture §9 status, this plan's outcome section, PROGRESS —
   including the fact that this planning session ran on the fast-tier model at
   high effort rather than the policy's deep tier.

Cost: one session, one ~2-minute re-run, no new data source, no dependency.

## Explicit non-goals

- **No tuning, no `SCREEN_PARAMS` change, no weight/gate search** — Phase 4's
  ban stands; the descriptive weight sweep remains barred from influencing the
  ship.
- **No production behaviour change.** The picker keeps shipping exactly what it
  ships today — unvalidated and unmodified. This round adds diagnostics to a
  research path (`quant-core` backtest modules + `backtest:screen`); it touches
  no screen parameter, no API route, no report, no schedule, no chart. If it
  concludes anything about the product, that conclusion is a **recommendation
  requiring its own decision**, exactly as Phase 4 stipulated.
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
> test half: compute breadth, NW SE and the power floor on the design half, lock
> the bar, then spend the test half once. The realized SE cannot be *assumed*
> from universe size, breadth, or horizon — in the two lanes observed it missed
> in opposite directions — so it is **measured** on the design half. That
> measurement is what makes the split load-bearing rather than ceremonial.

## What this round cannot claim

1. Nothing here confirms or refutes H1 **as pre-registered**. Every statistic is
   computed on the window that produced Phase 4's numbers, so that window is
   spent for these quantities — including the proportional spread (D4) and the
   differential interval (D2). *Spent* is measurable, not rhetorical: the
   2026-09-10 artifact published roughly **150 statistics** (2 lanes × 3 horizons
   × 5 metrics, plus 9 weight combos × 2 lanes, plus yearly IC and yearly
   portfolio differentials, plus both cost levels). That is the size of the
   garden whose paths have already been walked.
   It does **not** follow that D2 carries no evidence: an interval excluding 0
   would be real evidence about *tradability*, which is a different and larger
   claim than "Gate 1 passed" (see the preamble to "What this round will do").
2. An interval that excludes 0 would still be one window, one universe snapshot,
   and one regime (~1 month of bear).
3. Survivorship and universe look-ahead are unchanged; all claims stay relative.
4. The census (D3) describes *inputs* only. It cannot show that a wider universe
   would have produced a different IC.
5. Gate 2's interval, whatever it says, changes no verdict (Fork B, option 1).
   If it excludes 0 for US, it is reported as the project's only
   adequately-powered evidence **and explicitly not as a confirmation** — while
   the Phase-4 plan's blanket "Gate 2 can never confirm" is withdrawn, because it
   rested on an IR that was assumed rather than measured (Finding 2).
