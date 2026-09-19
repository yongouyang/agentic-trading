# North Star metric lock

**Status: DRAFT — requires an explicit user lock.** Written 2026-09-18.

Source: `docs/project-direction.html` §2.3 ("The objective that actually
distinguishes this project" → **North Star metric: time-to-verdict at pre-registered
power — days / daysNeeded**) and §2.4 (the three success levels). The metric is listed
as *proposed, not user-locked*, and it is the item **K4 is built on**: K4's
2027-06-30 horizon was derived from this metric's denominator (the ~157-day H2
requirement), so K4 is unreadable without it. K5's own charter text does not name the
metric — the relationship is weaker than "K5 reads it", and worth stating precisely
rather than loosely (an earlier message of mine put it as "K4 and K5 both read it",
which overstated it): **K5 is the "should this continue" gate, and the North Star
metric is the project's declared measure of success, so K5 must publish it** — as one
input among the measured nulls, the realised cost and the alternative's return, not as
a substitute for them.

---

## 1. What is actually being locked, and why the one-liner is not enough

The charter's phrasing is right in intent and **dimensionally ambiguous in form**:
`days / daysNeeded` reads as one ratio, but the two quantities in this repo are in
different currencies.

| where | what it computes | units | printed as |
|---|---|---|---|
| `verdictReadiness` (`packages/quant-core/src/verdict-ic.ts`) | `days / daysNeeded` | labelled observation-days ÷ labelled observation-days | `0 / 157 days` (a **progress fraction**) |
| `phase4c:accrual` (`apps/api/src/cli/accrual.ts`) | `requiredDays − observedDays`, ÷ supply | observation-days, then months | `~1,191 more sessions (~4.7 years)` (a **projected duration**) |

Calendar-days ÷ observation-days is not a fraction of anything, so a single "days /
daysNeeded" number cannot be both. Two coherent readings exist, they answer different
questions, and **the lock pins both and forbids reporting one as the other.**

Also measured, and part of the definition rather than a detail: the two live
hypotheses already project from **different bases** — H2 uses the *theoretical*
`1/√(breadth−1−controls)` per-day sd until 20 labelled days exist, then the *measured*
one; Track B's accrual scales the *observed* NW SE from the start. Both already declare
their basis (`seSource`, and accrual's "Projections scale the OBSERVED … measured, not
assumed"), and the lock makes declaring it mandatory rather than incidental.

**L2 is the level this metric measures.** §2.4: `L1 — It runs` is MET, `L2 — It can
decide` is IN PROGRESS ("machinery built and exercised once; no verdict on the
differentiator yet"), `L3 — It makes money` is NOT PROVEN. So the North Star metric
measures progress toward **L2**, and must not be read as progress toward L3.

---

## 2. The definition to lock

**Observation-day (the unit).** One session for which a hypothesis's deciding
statistic has a computable value — an IC point. Not calendar days, not names, not
runs. Every quantity below is in this unit unless it says otherwise.

**`daysNeeded` (the denominator).** Locked as the formula the repo already implements
(`verdictReadiness`), so it cannot be renegotiated by prose:

```
seMax      = targetIc / Z          Z = POWER_Z = 1.6449 + 0.8416 (80 % power,
                                   one-sided α = 0.05), which the plans round to 2.487
sdBasis    = measured sd   when ≥ 20 labelled observation-days exist
             theoretical 1/√(breadth − 1 − controls)  otherwise
daysNeeded = ceil( horizon × (sdBasis / seMax)² )
```

`daysNeeded ∝ sd²` and `∝ 1/breadth`, so a 2× error in the assumed sd stretches the
horizon ~4× — which is why the basis must be printed beside the number, and why
`targetIc`, `Z`, `horizon`, `breadth` and `controls` are all part of the lock rather
than inputs a later session may retune. All of them are already exported constants at
their single source (`POWER_Z`, `theoreticalSdDay`, and the accrual CLI's
`GATE1_BAR` / `GATE1_T` / `SESSIONS_PER_MONTH = 21`), which is what makes this
lockable by reference instead of by restatement.

**Reading A — progress.** `observedDays / daysNeeded`, both in observation-days.
Reaches 1.0 at the *forecast* readiness point — **which is not readiness.** Readiness
requires a **measured** SE `≤ seMax`; progress is a projection and may read 1.0 while
the gate still refuses. This distinction is the one most likely to be lost in a
summary line, so the lock states it here.

**Reading B — projected verdict date.** `today + (daysNeeded − observedDays) / supply`,
where `supply` is **measured** observation-days per week over a stated window. Refused
rather than rounded when the supply measurement is stale (§4).

**Per hypothesis, never pooled across hypotheses.** A hypothesis is a
(statistic, universe, treatment, window) tuple with a bar locked before outcomes. The
register as of this lock:

| hypothesis | bar, locked pre-outcome | class | state |
|---|---|---|---|
| **H1 — the screen** (picker window) | 0.02 (Phase 4) | `insufficient_evidence` (4b) | **RETIRED** by K1 |
| **H1 — vendor generality** (design half) | 0.0486 | `underpowered` (4c) | **RETIRED** by K1; test half unspent |
| **H1-class — formulaic alphas** (6A) | floor 0.0297 / 0.0493 + FDR q=0.05 | no US shortlist | **RETIRED** by K1's extended scope |
| **H2 — the LLM deep-dive** | readiness rule: SE(mean) ≤ 0.0402 | — | **LIVE**: 0 / 157 |
| **Track B — prospective differential** | t = 2 on the differential | — | live but **not a clock** (D3 of the K-lock) |

---

## 3. The decisions

### D1 — Carry both readings, or one?

- **(a) Both, units always stated (recommended).** Progress answers "how far along is
  this?"; the projected date answers "when will I know?". They fail differently:
  progress is robust to supply and silent about the calendar; the date is what a human
  plans around and is the first thing to rot.
- **(b) Progress only.** Immortal as a fraction; never answers "when?", which is the
  question K4's horizon is made of.
- **(c) Projected date only.** Human-legible; hides *why* it moved (a bar, a breadth,
  a supply change all move it, and only the fraction separates them).

**Decision: ☐ (a) ☐ (b) ☐ (c) —**

### D2 — What is the project-level reading?

- **(a) The last live hypothesis's projected date, and L2 completes when no hypothesis
  is live (recommended).** Makes "time-to-verdict" a project-level fact rather than a
  per-hypothesis curiosity, and makes L2's completion falsifiable: the register has no
  live entries. It also cannot be improved by *adding* hypotheses (each addition can
  only move the maximum later), which is the anti-Goodhart property the metric needs.
- **(b) Per hypothesis only, no aggregate.** Honest and simple; leaves "are we done?"
  unanswerable, which is the question L2 exists to answer.
- **(c) A count of resolved hypotheses.** Immortal in the same direction as (a), but it
  *can* be improved by opening cheap hypotheses that resolve fast — the failure mode
  §8 forbids elsewhere.

**Decision: ☐ (a) ☐ (b) ☐ (c) —**

### D3 — Does a class other than `supported` count as success?

This is the most consequential item, and the project's recent history scores very
differently under the two readings.

- **(a) Any class emitted at pre-registered power counts, with the class distribution
  published beside the metric (recommended).** This is the charter's own wording —
  "how fast it converts a hypothesis into a verdict class it can trust" — and §8's:
  `insufficient_evidence` is a legitimate resting state and `underpowered` is an
  answer. It also means 4c's `underpowered` and 6A's empty shortlist **count as the
  metric working**: three hypotheses moved from open to decided in eight days.
- **(b) Only `supported` counts.** Then the metric is a disguised return metric, it
  cannot be improved by any amount of discipline, and every other class reads as
  failure — which is precisely the reading §8 calls out as wrong.
- **(c) Any class counts, but `supported` is weighted separately in the summary.**
  A refinement of (a); costs a definition of the weighting, which is where a metric
  like this usually dies.

**Decision: ☐ (a) ☐ (b) ☐ (c) —**

---

## 4. Recorded with the lock (no decision needed unless you object)

**The anti-Goodhart clause.** The metric may be improved **only** by supplying
observation-days or by a design change made *before* outcomes. It may **never** be
improved by changing `targetIc`, `Z` (the power level or α), the horizon, the breadth
used in `daysNeeded`, the definition of an observation-day, or the basis declared for
the sd — and §8's firewall already forbids loosening a bar, a cap or a floor because a
lane turned out underpowered. Two specific traps the clause names:

- **Re-basing the sd on a stale measurement.** `seSource` must be printed, and a
  measured basis older than the current sample is not a measurement.
- **Stopping a clock by declaring a class early.** A hypothesis's clock stops only on
  a class emitted at its pre-registered power — which is the same rule the K-lock
  established for gates ("a class only counts once its gate's precondition is
  satisfied"), applied to the metric.

**Staleness rule.** Reading B is published only if the supply rate was measured within
**4 weeks** and the reporting artifact is at most **7 days** old; otherwise the metric
prints `date withheld — supply not measured since <date>`. A projected date computed
from an unmeasured supply is the one number here that can be wrong without looking
wrong.

**Reporting home and cadence.** Existing readouts already compute the pieces
(`verdict:validate` → H2 progress; `phase4c:accrual` → Track B duration; the weekly
validation digest → both on a clock). What does not exist is a single readout across
**the register**, with the basis, the class distribution and the staleness rule
attached. Proposed home: a `north-star` artifact + one line in the weekly digest,
reporting per hypothesis `{progress, projected date, basis, class-or-live}` and the
project-level reading from D2. **Deliberately not implemented speculatively** — the
definition comes first, and a metric built before its definition is a number looking
for a justification.

**What the metric is not.** Not return, not Sharpe, not paper PnL, not the number of
alphas tested, not tokens spent, and not a measure of whether a claim is *true*. It
measures whether this project can decide — L2, not L3.

---

## 5. Lock record

| item | decision | date |
|---|---|---|
| D1 — both readings, units stated | | |
| D2 — project-level = last live hypothesis; L2 completes when none live | | |
| D3 — any class at pre-registered power counts, distribution published | | |
| §4 — anti-Goodhart clause, staleness rule, reporting home | | |

On completion: `docs/project-direction.html` §2.3's metric line is marked `LOCKED`
with a pointer here, the §2.4 L2 row gains its falsifiable completion condition, and
the decisions are recorded as an entry in `PROGRESS.md`.