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

### Amendments of 2026-09-12 (pre-label — the verified `labelled` count is 0)

Four things the plan did not state, added while no forward label exists so that no
outcome could have informed them. No locked value is changed by any of them.

**A1 — HK cannot supply 40 names, so the pooled projection overshoots.** HK's
post-gate eligible breadth is ~25 (`docs/phase-4b-plan.md` Finding 4: 131 → 25),
and the lane is in fact delivering ~2–3 verdicts per run (6 runs → 14 awaiting,
14 late-excluded) against US's ~17 (3 runs → 50 awaiting, 10 late-excluded).
`topN.HK = 40` therefore truncates a list that never reaches 40. The pooled row of
the power table — which is what the "318 d ≈ 15 months" figure stands on — assumes
40 per lane and is unreachable on the HK half. The correct reading is: **the pooled
clock is bounded below by the US lane, and HK's contribution is ~25/day minus its
own promptness losses.** This does not change the bar, the statistic, or the
pooling decision; it changes the *stated* horizon, and it may not be papered over by
a projection that assumes names the lane cannot supply.

**A2 — measured slot supply is 56 %.** 5 of 9 expected slots per lane have fired
since 2026-09-01, re-pricing readiness from 157 sessions at full supply to ~280
sessions ≈ **13.3 months**, and Phase 4c's US screen clock from 1,194 to ~2,132
sessions ≈ 8.4 y. Both clocks are quoted at measured supply from here on; the
full-supply figures are projections, not schedules.

**A3 — the target IC's provenance: a knowing departure from 4b's rule, RATIFIED by
the user 2026-09-12.** `docs/phase-4b-plan.md` §"Methodology rule to carry
forward" requires: *"Set a bar from a power calculation on a design subset, never
from a plausible effect size."* Fork B does the inverse — it fixes
`IC_target = 0.10` on product grounds ("roughly the smallest edge that would change
which names you act on") and lets the clock follow. The plan's own gloss — "No magic
threshold is invented" — is true of the *readiness* rule and not of `IC_target`
itself.

Three reasons it stands, recorded so the ratification is a decision rather than a
preference:

1. **The rule presupposes a design subset that does not exist here.** 4b wrote it
   for a retrospective test on a spent window; Phase 5 is prospective and has
   `labelled: 0` — there is no half to derive from. The only pre-data substitute is
   the theoretical `1/√(N−1)` formula that 4b itself measured as biased (2.16× US,
   1.31× HK), so literal compliance was unavailable, not merely inconvenient.
2. **The departure runs toward the harder test, not the easier one.** The dangerous
   version of this error is a *large* target, which makes the bar easy and the test
   short — this plan labelled 0.15 "an easy bar" (141 d) and 0.05 "ambitious"
   (1,269 d). 0.10 is ~7× the only IC this project has ever measured (the screen's
   0.0145). A bar from a plausible effect size reproduces the Phase-4 failure only
   when it lands *below* what the design can detect.
3. **`t ≥ 2` is redundant at readiness, so `IC_target` *is* the bar.** Readiness
   requires `SE(mean) ≤ target/2.4865`, so a mean reaching the target implies
   `t ≥ 2.4865`. That is why its provenance is written down here instead of being
   left in a fork table.

**It may not be re-set now that labels are accruing.** The default lives in
`DEFAULT_TARGET_IC` and every artifact stamps the `targetIc` it computed against,
so a non-default run is self-identifying — a safeguard, not a licence.

**Cap scoping, stated rather than inferred.** Phase 4c's **0.03 cap governs the
vendor lane's derived bar** — a retrospective archive lane, where the derivation
itself could drift upward and an underpowered lane could otherwise be rescued by
quietly raising the claim. It is **not a project-wide ceiling on bar magnitudes**.
Applying it here would give `daysNeeded = 20 · (0.1601 / (0.03/2.4865))² ≈ 3,520
days` — roughly **25 years at the measured 56 % supply** — so the lane could never
decide, which is the opposite of what a cap is for. The two documents disagreed by
silence; they do not now.

**A4 — the readiness projection's SE depends on a formula 4b measured as failing.**
Phase 4b Finding 1 measured the per-day `1/√(N−1)` approximation to be off by
2.16× (US) and 1.31× (HK), which is why 4c caps its bar at 0.03 and measures its SE
on a design half. Phase 5's power table and the entire breadth fork rest on that
same approximation, with nothing absorbing the error until a measured SE exists.
The readiness rule's insistence that *only a measured SE may authorise a decision*
is the mitigation and it is the right one — but until enough days accrue to measure
it, `daysNeeded` is a projection computed from a formula already known to be biased,
and the run report must say so (it does: `seSource: "theoretical"`).

**The watch (user-locked 2026-09-12).** Because `daysNeeded ∝ sd²`, the assumed sd
is the one number that decides whether the projected horizon is a floor or a fiction,
and it becomes **measurable at 20 days** — long before the test can decide anything.
The run report therefore prints a **projection-watch** line the moment `seSource`
flips to `measured`: the observed per-day IC sd, the assumed value, and the ratio,
with a warning at ≥ 1.5× (4b's observed range was 1.31–2.16×). The reading is
pre-agreed: ratio near 1 → proceed; ratio near or above the 4b range → change
breadth or target **then**, while the sample is still unlabelled, rather than
discover it in a decade. `daysNeeded` already rescales itself to the measured sd;
the watch line exists so that rescaling is *seen* rather than inferred.

**A5 — the candidate universe was corrected while unlabelled (2026-09-12).** The
HSI half of `apps/api/data/universe.hk.json` had been compiled from a constituent
list frozen at ~January 2026, so it carried the pre-2026-02-13 membership:
**14 verified index members were missing** (incl. CATL `3750`, WuXi AppTec `2359`,
China Resources Power `0836`, JD Logistics `2618`, CMOC `3993`, Chalco `2600`,
J&T Express `1519`, Laopu Gold `6181`, Weichai Power `2338`, and the HSTECH names
`0100` MiniMax, `2513` Z.AI, `1698` TME, `9863` Leapmotor, `9903` Iluvatar CoreX)
and **4 names an official notice removes were still present** (Zhongsheng `0881`,
HSI eff. 2026-03-09; Kingdee `0268` and Kingsoft `3888`, HSTECH eff. 2026-06-08;
Tongcheng Travel `0780`, HSTECH eff. 2026-09-07). Universe **131 → 141**
(+14 / −4); every added symbol probe-verified against Yahoo v8 before committing,
the convention the 2026-09-02 HSCEI expansion set.

**Why this is recorded here and not filed as a data fix: the universe is an input
to H1 and to this lane's candidate pool.** Adding names changes what the screen
ranks and therefore which verdicts enter H2's sample — a pre-registered change, not
housekeeping. It is legitimate **only** because this lane has `labelled: 0`: no
forward label has matured, so nothing could have selected it. Applied once labels
exist it would be goalpost movement of exactly the kind §8 forbids, which is why the
window is now explicitly closed — any further universe change is a new
pre-registration.

**Root cause, recorded so it does not recur.** The HSI half was taken from a
Wikipedia constituent table that lists **85** names against its own stated **88**,
so it silently omits members; the HSCEI half was pulled live from the hsi.com.hk
feed and was current. `_meta` now forbids the Wikipedia table as an HSI source and
names the factsheet + quarterly-review-notice path instead.

**Effect on H2's arithmetic: none on the statistic, the bar, or the readiness
rule.** Candidate breadth is still bounded by `topN` (40/lane). But HK's post-gate
eligible set was ~25 (amendment A1), so this may raise HK's *realised* per-day
breadth toward its 40-name cap — the direction A1 said the lane could not reach.
Re-read the projection-watch line as usual. Three additions (`0100`, `2513`,
`9903`) have < 252 sessions and will screen as `INSUFFICIENT_HISTORY` until roughly
2027-01 — expected, not a defect.

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
| 40 | 1268 d ≈ 60 mo | 318 d ≈ **15 mo** | 141 d ≈ **7 mo** |
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

**Verdict vocabulary — mapped onto the project's fixed five-class set.** Phase 4
coined `h1_holds`/`h1_revised`; 4b introduced `insufficient_evidence`; this phase
coined `h2_holds`/`h2_falsified`. Three vocabularies for one project is drift, so
the H2 outputs are restated as the fixed classes
(`docs/project-direction.html` §8, R4), with the phase-specific name kept as a
reading aid rather than a second taxonomy:

- `supported` (H2: `h2_holds`) — IC ≥ target **and** NW t ≥ 2, at the readiness
  threshold.
- `falsified` (H2: `h2_falsified`) — IC ≤ 0 with t ≤ −2, at the readiness
  threshold.
- `insufficient_evidence` — readiness not met, **or** met with the interval
  spanning zero. The expected outcome for months; the *default* reading, not a
  failure to explain.
- `underpowered` — the design could not have detected the target at the breadth the
  lane can actually supply, declared **before** any outcome is read. This is the
  class HK is heading for under amendment A1 unless its breadth or its treatment
  changes, and declaring it late is exactly what the class exists to prevent.
- `inconclusive` — the 1.5× SE-stability guard tripped (below).

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

## Locked: the treatment must freeze (decision 2026-09-11)

Fork A's breadth question was about power. This one is about **validity**, and it
was decided the same day: the sample is accrued against **one** treatment, so
`PROMPT_VERSION` stays **v1** until the read. The harness enforces it
(`verdict:validate` excludes any other version and counts it), which means the
cost of a prompt change is visible rather than silent: the excluded count jumps.

That is a real cost, not a formality — a bump **resets a ~7.5-month clock** and
discards the verdicts accrued under v1. So the decision also specifies how prompt
work coexists with measurement.

### The excluded experiment track

Prompt improvements do **not** have to wait, but they must not touch the sample.
The mechanism needs no new code, because both halves already exist: the version
tag travels inside `verdictJson`, and the harness excludes anything that is not
v1.

```bash
# from the production tree — the sample keeps accruing on v1
git worktree add ../at-prompt-exp -b prompt-exp
cd ../at-prompt-exp
# edit packages/agents/src/prompts.ts, bump PROMPT_VERSION to v2 there
pnpm -C apps/api screen:deep-dive -- --market us --symbol AAPL,MSFT,NVDA
pnpm -C apps/api verdict:validate        # the v2 verdicts appear as EXCLUDED
```

Three properties make this honest rather than convenient:

1. **The tag cannot lie.** The rule in `prompts.ts` is that the version changes
   when *any* prompt text changes, so a v2 run genuinely is a different treatment.
   An override that retagged the same text would be a false label, which is why
   the mechanism is a worktree rather than a `--prompt-version` flag.
2. **Production is untouched.** The launchd jobs run from the production tree, so
   a separate worktree is what stops an experiment from silently *becoming* the
   sample. This is the only real hazard of the workflow.
3. **Both versions can be run on the same names** (v1 from the production tree,
   v2 from the worktree, `--symbol` for each), which is what makes the comparison
   a comparison rather than an impression.

**Known footgun, pre-existing and now more likely to be hit:** an ad-hoc
`--symbol` run still creates a `DeepDiveRun`, and the dashboard shows the latest
complete run per lane — so an experiment can become what the dashboard displays.
The run picker goes back, and the verdicts are excluded from the sample, but this
is worth knowing before it happens.

**When v2 ships**, production moves to v2, the sample restarts deliberately, and
the Phase-5 clock resets from that date. That is the cost of having a better
prompt, and it is the right trade — but it should be made on purpose.

## Sibling instrument: `journal:link` (2026-09-11)

Not part of Phase 5 — it measures a different question — but built in the same
session because it is the only instrument that measures the **decision** rather
than a signal, and because building it *before* any trade history exists is what
keeps it unfitted to a result.

**What it answers.** For each buy: was the symbol on the screen list within N
trading sessions of the trade, at what rank, and with what LLM conviction; what did
it actually return; and what would the list's own top-N have returned over the
**same window**. That last number is the point — the question is not "did the trade
make money" but "did the trade beat the list it was chosen from".

**Why it is built now, with no data.** Investing is manual here, and nothing else
in the project can see the trades. An analysis written after seeing the outcomes
would be fitted to them, which is the same reason Phase 4b's two amendments were
only legitimate because no label existed yet.

**Ingestion is a normalized CSV, deliberately.** Guessing a broker's headers from
memory would produce a parser that needs rewriting on first contact. The schema is
one we control:

```csv
date,symbol,side,quantity,price,fee
2026-09-14,US.AAPL,buy,10,230.50,1.99
2026-09-15,HK.02269,buy,500,45.20,28.00
```

The broker-specific part then reduces to **one documented rename plus the symbol
codes**, and the codes are stable knowledge that is already implemented:
`US.AAPL → AAPL`, `HK.700 → 00700.HK`. The target broker for going forward is
**Futu/Moomoo** (HK and US EQ/ETF), so a first export needs only its column names
mapped onto the five above.

**Two deliberate design choices**, both to stop the report flattering the reader:

1. A row that cannot be parsed is **reported with a reason**, never dropped —
   silently skipping a trade would make coverage look better than it is, the same
   failure as a silently excluded verdict in the Phase-5 harness.
2. A matched sell **folds into the buy row it closes**, so the row count is
   *decisions*, not executions. An open position is **marked to market** and
   labelled `(open, marked)` rather than being counted as a completed outcome.

**Data dependency, stated plainly because it is the current limitation.** The
linkage needs `ScreenRun.sessionDate` (added 2026-09-11) to place a list in time,
and forward returns to score a trade. Right now the store holds session dates for
**one** session and bars only up to it, so a run against a sample file reports
`—` for every return and `OFF-LIST` for every symbol. That is data starvation, not
a defect: the instrument becomes useful after a few weeks of sessionDate-bearing
runs. Verified meanwhile against a stub store (`journal-link.cli.spec.ts`) and 16
pure tests in `packages/quant-core/tests/journal.test.ts`.

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
