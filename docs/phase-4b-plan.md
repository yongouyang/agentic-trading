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

## Amendments round 2 (2026-09-11, post-execution) — corrections found by review

The executed round was then reviewed adversarially by an independent
multi-model pass. It confirmed the SE/interval arithmetic and the implemented
code, and found **fifteen further defects** — several of them wrong numbers in
*this document*, in the paragraphs written to correct wrong numbers. They are
recorded here rather than silently patched; the superseded text of the earlier
round-2 edits is recoverable from commit `d6e558f`, and the pre-review locked
text from `25aa8cd`.

The three that mattered most:

| # | What it said | What is true |
|---:|---|---|
| R1 | *"would clear t = 2 with a tracking error ≤ 4.6 %/yr"* | **Dropped √years.** `t = (μ/TE)·√y`, so `TE ≤ μ·√y/2` — ≈ **9.2 %/yr** for the simple-annualized compounded differential, against a per-lane horizon of **3.98 y (US) / 3.87 y (HK)**, not the 4.12 y pre-run estimate. My 4.6 %/yr silently re-imposed `IR ≥ 2` — the exact confusion this phase exists to remove, inside the paragraph that removes it. |
| R7 | *"≈ 10 %, not 5 %"*, correct to *"t ≈ 2.24"* | **Both wrong, and the answer inverts.** Gate 1 requires `IC ≥ 0.02 AND t ≥ 2`, so the rejection region is one-sided: p = 0.0228 per lane → FWER = **4.5 %**, already below 5 %. "10 %" assumed α = 0.05; "2.24" is the two-sided value. **No correction is needed, and Phase 4c must not raise the bar on these grounds.** |
| R9 | *"the project has never known which gate does the cutting"* | **False of production.** `cli/daily-screen.ts` already tallies and persists `excludedCounts[reason]`. D3 restores a field the *replay* dropped — and, worse, it reports **first-failure**, not marginal bindingness (see R10), so it cannot support "relaxing a gate raises breadth". |

The rest:

| # | Amendment |
|---:|---|
| R2 | Finding 2's `+38.03 %` is a difference of **compounded** returns while D2's t tests the mean **arithmetic** daily difference — the draft used one estimand's magnitude to motivate another's threshold, contradicting its own amendment 3. |
| R3 | Finding 1's mechanism corrected by exact decomposition: the per-day factor is 2.16× (US) / 1.31× (HK) and the overlap factor 0.65× / 0.62× — the sampling formula fails **worse in the US**, the opposite of the "correlated HK names" story. |
| R4 | "Cannot be predicted" narrowed: the **time-series** factor is stable across lanes (2.90 vs 2.77, within 5 %) and predictable; only the cross-sectional factor is not. Motivated the SE-stability guard in D6. |
| R5 | D1's `2·nwSe` is a **detection floor at 50 % power**, not a power curve. Added the curve: true IC 0.02 → power 0.26 (US) / 0.12 (HK); 0.05 → 0.91 / 0.51. |
| R6 | "The bar is unpassable" is **false** (IC = 0.05 → US t = 3.36, HK t = 2.03, both pass). The correct statement is that the magnitude requirement is **vacuous**, so Gate 1 is a pure significance test. |
| R8 | "≈ 150 statistics" did not sum; the census is **≈ 84** — in the one sentence claiming "spent is measurable". |
| R10 | D3's first-failure limitation stated (it cannot support a gate-relaxation inference). |
| R11 | D4's `f = 0.10` is **post hoc**; and its "a decile wherever the lane is wide enough" is **false for HK**, where the floor binds every day and the contrast is the top **20 %**, not a decile. HK's D4 is pre-declared uninformative (±4 % at 20d). |
| R12 | D5's predicate pinned before reading results (it was chosen during implementation, i.e. post hoc). |
| R13 | The Gate-2 headline (`+38.03 %`) and the D2 `t` are **different statistics** and are now printed side by side; and the reported `IR` (i.i.d. TE) is distinguished from the HAC `t`, since `IR·√y ≠ nwT`. |
| R14 | The **index** differential was missing — `phase-4-plan.md` pre-registered SPY / 2800.HK alongside the equal-weight universe. Added. |
| R15 | Fork A's second clause had **no deliverable** (every D-item was diagnostic). Added **D6**, the Phase-4c pre-registration skeleton. |
| R16 | The **central premise was overstated**: "the run's verdict rested on two power numbers". The mechanical verdict is `meanIc >= 0.02 && nwT >= 2` and `detectableIc` fed only prose — no power number was a decision input, and both lanes fail on *magnitude* under any N. Reframed as an **interpretation** repair, not the repair of a broken verdict. |

One correction in the other direction: the review called the locked text unrecoverable. It is not — the pre-review version is commit `25aa8cd` and the round-1-amended version is `d6e558f`, so the audit trail survives in git even though the working file was edited in place.

## Why this round exists

Phase 4 returned `h1_revised` on both lanes and reached the correct *surface*
conclusion (the pre-registered Gate 1 bar cannot be passed). But the run's
**published reading** rested on two power numbers, and neither is sound:

| | how Phase 4 obtained it | status |
|---|---|---|
| Gate 1's bar (`IC ≥ 0.02`) | computed from universe size 552/131 | **wrong N** — the gates leave breadth 180/25 |
| Gate 2's role (`IR ≥ 0.985`) | *asserted* from a "realistic screen IR of 0.3–0.7" | **never measured** |

The first is the calibration error already recorded in PROGRESS. The second is
the same error class and has not been noticed: the plan argues Gate 2 can never
confirm anything because portfolio alpha needs IR ≥ 0.985 — but that is a
statement about a *hypothetical* IR, while nothing anywhere measures the realized
one. **Whether the realized TE is that small has never been computed**: `simulatePortfolio` returns the daily return series, and
`neweyWestT` already exists, but nothing in the codebase puts a standard error
on the differential. Gate 2 is a point estimate with no interval, and the claim
that built the whole asymmetric gate design was an assumption.

So this round does **not** re-test the screen. It repairs the two numbers the
*reading* was built on, and states what the window can actually answer.

**Scope, stated precisely, because it is easy to overstate.** The mechanical
verdict was `meanIc >= 0.02 && nwT >= 2`; `detectableIc` fed only the prose note and
one report line, and both lanes failed the *magnitude* requirement under any N
(US 0.0145, HK −0.0192). So **no power number was a decision input**, and this
round is an **interpretation and Gate-2-justification repair** — not the repair of
a broken verdict. The precise defect is: one asserted magnitude bar, one asserted
power claim, and a mis-calibrated power table. The remedy is D1's own rule (a bar
must be *derived*), not "fix N".

## Finding 1 — Gate 1's bar cannot be fixed by re-thresholding

Three different estimates of the same quantity, all from published numbers:

| lane | naive SE (T independent days) | heuristic SE (breadth, `(1/√(N−1))·√h/√T`) | **realized NW SE** | realized floor at t = 2 |
|---|---|---|---|---|
| US | 0.00514 | 0.01066 (N = 180) | **0.01495** | **0.0298** |
| HK | 0.00890 | 0.03046 (N = 25) | **0.02462** | **0.0493** |

(Derived from the artifact: `sd_ic = mean / ICIR` → US 0.1611, HK 0.2667;
realized SE = mean / nwT; the NW inflation is 2.91× US and 2.76× HK versus the
4.47× = √20 the heuristic assumes.)

The heuristic's two error sources can be separated exactly,
`realized/heuristic = [sd_ic / (1/√(N−1))] × [NW inflation / √h]`:

| lane | per-day factor | overlap factor | product |
|---|---|---|---|
| US | 0.16116 / 0.07474 = **2.16×** | 2.897 / 4.472 = **0.65×** | 1.40× |
| HK | 0.26771 / 0.20412 = **1.31×** | 2.762 / 4.472 = **0.62×** | 0.81× |

**The per-day approximation fails in both lanes — and it fails *worse* in the US,
which is the opposite of the intuitive story** (one would expect HK's correlated
25 names to break `1/√(N−1)` hardest; they break it least). Meanwhile the √h
overlap penalty is overstated in both, by a similar factor. So the two error
sources are on opposite sides of 1 *within each lane*, but their sign is
consistent *across* lanes, and the net sign (US 1.40× worse, HK 0.81× better) is
driven by which factor dominates — not by any mechanism this document can name.

The consequence for the methodology rule is sharper than "measure it": the
time-series factor is **stable across lanes (2.90 vs 2.77, within 5 %) and therefore
predictable**, while only the cross-sectional factor is not. The deeper reason
`sd_ic` (0.1611) is 2.16× the sampling-only per-day SE (0.0747) is that most of
the daily IC variance is **regime instability, not cross-sectional noise** — which
is exactly the quantity that can shift between a design half and a test half.
That is why D1's rule needs an SE-stability guard (§ D6), not merely a design-half
measurement.

Two lanes are still two observations: the operational conclusion is *measure the
realized SE on a design half*, not that it is unpredictable in principle.

**Consequence for the bar.** With the realized SE, `IC = 0.02` gives US t = 1.34
and HK t = 0.81.

**Two things this does and does not say.** It does not say the bar was "unpassable"
— IC = 0.05 would give US t = 3.36 and HK t = 2.03, and both lanes would pass.
What it says is that the **magnitude requirement is vacuous**: because
`2·nwSe` exceeds 0.02 in both lanes, any IC large enough to clear t = 2 has
already cleared the 0.02, so Gate 1 degenerates into a pure significance test
with no effect-size content. The remedied form of the bar is "passable only for
mean 20d IC ≥ 0.0298 / 0.0493, i.e. saturated by the significance requirement".

**And `detectableIc` is a *detection floor*, not a power calculation.** At an IC
equal to the floor the test has **50 % power** by construction. Reported properly
it is a power *curve*: against a true IC of 0.02 the power is ≈ **0.26 (US) / 0.12
(HK)**; against 0.05 it is ≈ **0.91 / 0.51** (normal approximation, SE fixed).
Calling D1 "the power statement" overstates it; it is the significance constraint
restated as an IC magnitude, and the 50 %-power point is the one that matters for
reading a FAIL.

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
`replayScreen` keeps only `excludedCount`, discarding the per-reason breakdown
that `runScreen` already computes. **Production does not have this blind spot** —
`cli/daily-screen.ts` already tallies `excludedCounts[e.reason]` and persists it in
`ScreenResult`. It is the *replay path* that drops it, so D3 restores a field the
backtest threw away rather than inventing a capability.

**One limitation must be stated up front, because it bounds what D3 can support.**
`runScreen` records only the **first** failing reason per name (an `if/else if`
chain), so the census answers *"which gate rejects first"* — not *"which gate
binds"*. It therefore **cannot** support "relaxing gate X raises breadth by Y": a
name rejected first for `BEARISH_ALIGNMENT` would simply be rejected next for
whatever it also fails. A marginal (order-independent) count is a different,
larger change and is not in this round.

This matters because the census is **clean**: it describes the screen's inputs,
not returns, so it consumes no return-information and cannot contaminate a
return-based hypothesis. (It could still *select*: using the census to choose
which gate to relax and then re-testing IC on this window would be a selection
step. Fork C locks it to description for exactly that reason.)

## Finding 5 — two lanes, and a multiplicity correction that is NOT needed

Both lanes were tested against t = 2, reported separately, with no conjunction —
a locked Phase-4 decision. The first draft of this finding claimed the pair's
family-wise error was "≈ 10 %, not 5 %" and that Phase 4c should correct to
Bonferroni t ≈ 2.24. **Both figures were wrong**, and in a way worth leaving on
the record, because the corrected answer is the opposite of the draft's:

- Gate 1's rule requires `IC ≥ 0.02 AND t ≥ 2`. Because the magnitude is positive,
the rejection region is **one-sided**: p = 0.0228 per lane at t = 2, giving
FWER = 1 − (1 − 0.0228)² = **4.5 %** for the pair — already *below* 5 %.
- "≈ 10 %" is the nominal α = 0.05 figure (t = 1.645 one-sided); "2.24" is the
two-sided 0.025 value. The draft mixed two conventions and matched neither.

So **no multiplicity correction is required, and Phase 4c must not raise the bar
on these grounds** — a 2.24 threshold would be strictly stricter than the current
rule with no power calculation behind it, which is the original sin re-committed.
What Phase 4c *should* do is state the family explicitly (which lanes and which
statistics are in it) and nominate a primary lane, so the choice is deliberate
rather than inherited.

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
- **D3 — the first-failure census.** Retain `excluded` reasons in `ReplayDay` as
  an additive, **per-market** tally; report rejections by gate, lane, and year,
  with an exact denominator (Σ ranked observations) rather than a static universe
  size — names invisible at T are skipped before counting, so a share against
  552/131 is not well defined over time. It reports *which gate rejects first*
  (see Finding 4) and may not be read as marginal bindingness.
- **D4 — the proportional spread.** Report the top-vs-rest spread with a
  **proportional** cutoff instead of the fixed `topN = 15`, at all three
  horizons, with a NW t on the daily spread series.

  `cutoff = max(ceil(0.10 × breadth), 5)` per lane per day, computed on the count
  of names with a computable forward return. Two things must be said plainly
  rather than buried:

  1. **`f = 0.10` is post hoc.** It was chosen *after* Finding 3 observed that a
     fixed 15 is 8.3 % of US breadth but 60 % of HK's — and it leaves US almost
     unchanged while moving only the lane the finding objects to. The whole of D4
     is therefore **descriptive for this window**; `f` becomes pre-registered only
     when Phase 4c fixes it before seeing data.
  2. **In HK the floor *is* the rule, so HK's contrast is the top 20 %, not a
     decile.** HK breadth is ~25, so the decile is 2–3 names and `max(3, 5) = 5`
     — top 5 of 25. The floor binds on every HK day, so the earlier draft's claim
     that the rule is "a decile wherever the lane is wide enough" is false for the
     lane it was written for. HK's D4 number is **not comparable** to US's, and
     the report prints the mean realized cutoff and the floor-bind share so this
     is visible rather than inferable.

  Per the same arithmetic, HK's D4 precision is roughly ±4 % at 20d (k ≈ 5 vs
  rest, single-name 20d SD ~20–30 %), so HK's D4 result is pre-declared
  **uninformative**, not a null to be explained.
- **D5 — verdict vocabulary.** `insufficient_evidence` added as an explicit
  outcome class alongside `h1_holds` / `ranking_power_but_not_tradable` /
  `h1_revised`, with the **predicate pinned before the run**: it fires per lane
  when `gate1 failed AND GATE1_MIN_IC < detectableIc`, i.e. when the lane's own
  detection floor sits above the bar it failed. `h1_revised` is reserved for a
  FAIL on a bar the lane could have detected. The 2026-09-10 artifact is
  annotated, never rewritten.

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
   2026-09-10 artifact published roughly **84 statistics** (2 lanes × 3 horizons
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

---

# Outcome (executed 2026-09-11)

All five deliverables ran. Artifact:
`apps/api/reports/backtest/2026-09-11.{json,txt}`; the 09-10 artifact is
annotated by `2026-09-10.ANNOTATION.md`, never rewritten.

**Window caveat first.** The run covers **2022-09-12 … 2026-09-11** — the same
1003 sessions as Phase 4, shifted two sessions later, because the store holds a
rolling ~5-year window refreshed by `screen:daily`. So the D2/D3/D4 numbers below
are computed on a *shifted* window: US mean 20d IC reads +0.0141 against the
artifact's +0.0145, and the equal-weight benchmark +48.07 % against +50.92 %.
The 09-10 artifact remains the reference for the pre-registered verdict.

## D5 — the verdict class (the headline)

| lane | stored 09-10 | 4b verdict | why |
|---|---|---|---|
| US | `h1_revised` | **`insufficient_evidence`** | floor 0.0298 > bar 0.02 |
| HK | `h1_revised` | **`insufficient_evidence`** | floor 0.0493 > bar 0.02 |

Both lanes' detection floor exceeds the bar's own magnitude, so neither FAIL can
falsify the effect. `h1_revised` is now reserved for a FAIL on a bar the lane
*could* have detected.

## D1 — the power statement, now unconditional

| lane | naive SE | heuristic SE | realized NW SE | floor | 95 % CI | quantile |
|---|---|---|---|---|---|---|
| US | 0.00514 | 0.01066 | 0.01488 | 0.0298 | −0.0158 … +0.0440 | 2.010 (df 48.1) |
| HK | 0.00893 | 0.03014 | 0.02465 | 0.0493 | −0.0696 … +0.0298 | 2.015 (df 44.0) |

The naive/heuristic/realized triple is now printed on **every** run, pass or
fail — it was previously emitted only when Gate 1 passed, i.e. suppressed in
exactly the case that needed it.

## D2 — the Gate-2 interval: the assumption, now measured

| lane | daily arithmetic mean | TE (i.i.d.) | IR | NW t (lag 20) | implied t from IR | years |
|---|---|---|---|---|---|---|
| US | +0.03 % | 15.85 %/yr | **0.49** | **1.19** | 0.99 | 3.98 |
| HK | −0.02 % | 9.28 %/yr | −0.59 | −1.20 | −1.16 | 3.87 |

The **implied t from the IR (0.99) and the HAC t (1.19) legitimately differ**, and both
are printed: the HAC factor adjusts the standard error of the *mean*, not a
per-period quantity, so `ir·√years ≠ nwT`. Printing one without the other invites
reading the gap as an error.

The **index** comparison the Phase-4 plan also pre-registered now prints too, and
it is the less flattering one: **US portfolio − SPY = −5.36 pp** (portfolio
+89.17 %, SPY +94.53 %) and **HK portfolio − 2800.HK = −42.80 pp** (+11.28 % vs
+54.08 %). The equal-weight benchmark is the *screen's own eligible set*, so the
Gate-2 differential is mostly a statement about portfolio construction
(concentration, hysteresis, T+1 fills, costs) rather than about the screen's
selection. That is why a non-falsification there could never have been a
confirmation of H1 — an argument that survives any interval D2 produces.

**Cost drag explains most of HK's differential.** Turnover is already defined
both-sides, so the drag is turnover × per-side rate: US 30.9 × 5 bp ≈ **1.5 %/yr**,
HK 26.1 × 23 bp ≈ **6.0 %/yr** — against a −27.14 pp differential. (The “~12 %/yr”
figure in `architecture-v1.md` and the Phase-4 PROGRESS entry double-counts the
round trip and is corrected.) HK's Gate-2 falsification therefore falsifies the
*portfolio rule and cost model*, which routes to `phase-4-plan.md`'s “iterate on
the portfolio rule / costs / liquidity, not on the score” — not to a score
revision.

**Neither reaches t = 2, and the lag sensitivity agrees.** So Fork B's
conditional never fired: there is no adequately-powered evidence to promote, and
Gate 2 stays falsification-only.

The important nuance is *how* Finding 2 resolves. The withdrawn claim was
"portfolio alpha needs IR ≥ 0.985"; the realized IR is **0.49** — inside the
0.3–0.7 the original assumption guessed. So Phase 4's *conclusion* was right
while its *reason* was an assumption. Phase 4b replaces the assumption with the
measurement and the claim is now supported. That is the difference between
"unjustified" and "false": only the first was true.

Also confirmed: the artifact's `+41.11 %` differential and the `t = 1.19` are
**different statistics** — a difference of compounded returns versus the mean of
the daily arithmetic difference (amendment 3). They are printed side by side.

## D3 — the census: the trend filter rejects first, but this is not marginal bindingness

| lane | first-failures | reject share | gate that rejects first | its share |
|---|---|---|---|---|
| US | 371,941 | **67.3 %** | `BEARISH_ALIGNMENT` | **81.2 %** (301 names/day) |
| HK | 100,954 | **81.1 %** | `BEARISH_ALIGNMENT` | 43.9 % (45/day) |

`BEARISH_ALIGNMENT` (`close > sma50 > sma200`) is the gate that rejects first in
**every calendar year** in both lanes, and US `LOW_LIQUIDITY` accounts for just
**0.5 %** — the $20 M adv floor is effectively not binding. HK is closer to split
(`BEARISH_ALIGNMENT` 43.9 %, `LOW_LIQUIDITY` 29.4 %).

**The limitation is load-bearing and is printed in the report:** `runScreen`
records only the *first* failing reason, so this census answers “which gate
rejects first” — **not** “which gate binds”. It therefore cannot support
“relaxing `BEARISH_ALIGNMENT` would raise US breadth from 180 toward 552”: a name
rejected first for that would simply be rejected next for `HIGH_VOLATILITY`,
`NEGATIVE_MOMENTUM`, or `NON_POSITIVE_SHARPE`, which together reject another 16 %.
An order-independent marginal count is the change that would answer it, and it is
not in this round. The field is typed `basis="first_failure"` so the limitation
travels with the data rather than with this paragraph.

What the census *does* establish is narrower and still useful: the trend filter is
the gate that stands between the universe and the shortlist. Per Fork C it is
**documentation only** — no gate was relaxed and `SCREEN_PARAMS` is untouched.

## D4 — the proportional spread

| lane | cutoff | 5d | 20d | 60d |
|---|---|---|---|---|
| US | 18 of 180 (decile binds) | +0.16 % (t 1.47) | +0.64 % (t **1.66**) | +1.47 % (t 1.14) |
| HK | **5 of 25 (floor binds — top 20 %, not a decile)** | +0.09 % (t 0.50) | **+0.76 %** (t 1.34) | +2.45 % (t 1.56) |

Finding 3 is confirmed materially rather than cosmetically. HK's 20d spread goes
from **+0.07 %** (fixed top-15 = 60 % of its universe) to **+0.76 %** (top 5 of
25) — the old number was diluted into nothing, and the two were never comparable.
US moves the other way (+0.82 % → +0.64 %) because its decile is 18 names rather
than 15, so the extra three names are weaker.

US 20d `t = 1.66` is the **largest statistic the project has produced**, and it is
still below 2. That is the honest state of the top-decile hypothesis: the best
available framing, on a spent window, is not significant.

**Two caveats that must travel with HK's row.** (1) The floor binds on every HK
day, so HK's contrast is the top **20 %**, not a decile — HK and US are still not
comparable, just less incomparably so. (2) HK's precision here is roughly
**±4 %** at 20d (k ≈ 5 vs rest, single-name 20d SD ~20–30 %), so HK's D4 result is
pre-declared **uninformative** rather than a null to be explained. And `f = 0.10`
was chosen *after* Finding 3, which is why D4 is descriptive for this window and
`f` becomes pre-registered only when Phase 4c fixes it before seeing data.

## D6 — Phase-4c pre-registration skeleton (Fork A's second clause)

Fork A locked "pre-register a replacement statistic for **future data only**", and
D1–D5 did not implement it — every one of them was diagnostic. This is that
skeleton, written **before any Phase-4c data exists**, so Phase 4c cannot be
designed after reading its own numbers. Nothing below may be informed by this
window's D2/D4 values.

- **Deciding statistic:** the differential test of Finding 2 — a Newey–West t on
  the daily arithmetic difference — **not** rank IC. Finding 1 established that
  rank IC cannot carry an effect-size bar at this breadth, and Finding 2 that the
  differential is the only statistic whose power can be computed *before* spending
  data. Gate 1 (rank IC) demotes to descriptive.
- **Data:** prospective sessions accumulated from the already-emitted daily picker
  output. The alternative fresh cross-section (Databento/XNYS — 16,777 symbols in
  `VendorBar`) needs an as-of adjustment and CA-degrade layer first, so it stays a
  **data project**, not a prerequisite.
- **Bar derivation (the D1 rule):** split history into a design half and a test
  half; measure breadth, `nwSe` and the power curve on the **design** half; choose
  the bar at a stated **target power (0.8 by default — not the 50 %-power detection
  floor)**; lock it; spend the test half **once**.
- **SE-stability guard** (new, from amendment R4): the time-series SE factor is
  stable across lanes (2.90 / 2.77) but the cross-sectional one is not, and about
  two-thirds of daily IC variance is regime instability rather than sampling noise.
  So: *if the test-half realized SE exceeds the design-half's by more than a
  pre-stated factor, declare the lane **inconclusive** rather than failed.* Without
  this, the design-half rule can fail a lane for a regime it never saw.
- **Family and lanes:** state the family explicitly (which lanes, which statistics)
  and nominate a **primary** lane. Per Finding 5 the one-sided t ≥ 2 rule already
  sits at ≈ 4.5 % family-wise for two lanes, so **no Bonferroni inflation is
  warranted** — the choice is about pre-committing the family, not a stricter bar.
- **HK's options, priced now:** a design-half power calculation returns a floor
  near 0.05 IC for a 25-name lane, so the realistic choices are *drop HK from the
  deciding test* (keep it as a reported lane) or *pool the lanes*. Decide this
  **before** the design-half measurement, because the measured number will make the
  choice for anyone who has not.
- **Firewall:** this window's D2 and D4 values (US t 1.19 / 1.66, HK 1.34) may not
  enter Phase 4c's bar derivation. That 1.66 is the project's largest statistic is
  not evidence, and must not be used to justify a looser bar.

## What changed in the code

`packages/quant-core/src/ic.ts` — `tQuantile975` (exact table below df 10, since
the Cornish–Fisher expansion *understates* the quantile there and would produce an
overconfident interval), `icPower`, `proportionalCutoff`,
`spreadSeriesProportional`. `replay.ts` — `ReplayDay.excludedByReason` per market,
`exclusionCensus`. `backtest.ts` — the unconditional power note, the D2
interval, the `insufficient_evidence` class, the census, and the withdrawal of the
IR ≥ 0.985 claim in its own header. `apps/api` — the report.

**Non-goals honoured:** no `SCREEN_PARAMS` change, no tuning, no new data source,
no production behaviour change. Suites: quant-core 90, api 437 + 1 skipped,
agents 43, web 102, `tsc` clean.
