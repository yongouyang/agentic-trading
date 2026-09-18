# Kill criteria lock — K1–K5

**Status: LOCKED 2026-09-18.** All five decisions taken; the lock record is §6.
Every recommendation below was accepted as written. `docs/project-direction.html`
§7 has been amended to match, including its status line, which now reads `LOCKED`.

Source: `docs/project-direction.html` §7 ("Decision gates & kill criteria", currently
`Status: PROPOSED`) and §8 ("Working rules"). This document exists because the
charter says to lock the criteria "before Stage 1's verdicts arrive, not after" —
and they have arrived.

---

## 1. Why this is late, and what has to be decided

Three of the five criteria have something to bite on today:

| track | what happened | when |
|---|---|---|
| **Track A — vendor lane (G1)** | emitted **`underpowered`** — the design-half bar 0.0486 exceeds the 0.03 cap, declared *before* any test-half number was computed. The **test half is unspent**. | 2026-09-13 |
| **Phase 6A — formulaic alphas** | closed with an **empty US shortlist**: 0 of 436 US rows survive FDR, and no US alpha reaches its own noise ceiling (max luck ratio **0.78**). A7 is blocked by its own pre-registered promotion rule. | 2026-09-18 |
| **H2 (Phase 5, the LLM layer)** | accruing. `verdict:validate` on 2026-09-18: **0 labelled verdicts over 0 days**, 125 verdicts awaiting a 20d label, readiness **0/157 days** (raw) and **0/159** (\|rank) pooled. Re-baselined to `deepseek-flash` ×3 on 2026-09-16, which restarted the clock: 151 verdicts excluded for a different model stack, 87 as legacy-unverifiable. | ongoing |
| **Track B — prospective differential** | 4/4 and 5/5 lane-days collected. The rank-IC path needs **4.7 y (US) / 18.1 y (HK)**; the differential needs ~7 y. | ongoing |

Two of the three tracks have emitted; H2's clock is the only one still moving, and its
soonest *measurement* is ~2 months out while its verdict is ~9 months out.

Five decisions were needed. Four were accept/amend/reject; **D3 needed a number the
charter never states.** All five are now taken — see §6.

---

## 2. The decisions

*(Written as proposals; each is now ACCEPTED. The reasoning is kept because it is
what the lock rests on, and a lock without its reasons is a rule nobody can revise
later.)*

### D1 — Does K1 fire on a *design-half* `underpowered` declaration?

**Charter says.** G1's exit condition is "a verdict class is emitted **from the test
half**, spent once". K1's trigger is "**falsified or underpowered** → the screen is
retired as an alpha claim permanently, and no further tuning of it is permitted. It
may survive only as a filter."

**Reality.** `underpowered` was emitted from the **design half**; the test half was
never spent. So the literal *exit condition* is unmet while the literal *trigger
class* matches. The two clauses were written assuming the test half would be the
thing that produced a class.

**Why it cannot be left ambiguous.** If K1 only fires on a test-half verdict, then K1
is a dead letter on the only instance it was built for: a lane declared underpowered
by design, by construction, never gets to spend its test half — spending it cannot
add information the design already lacks. A criterion that cannot fire is not a
criterion, and the whole point of §7 is that the moment of honesty arrives on
schedule.

**The symmetric case, which is what makes this principled rather than convenient.**
G2 has a `readiness` precondition for exactly this reason: the harness prints
`insufficient_evidence` from day 0 (it does today, at 0/157 days), and the charter's
Stage-2 table conditions its entry on "insufficient_evidence **after readiness was
met**". So a class emitted before the precondition is not authoritative — otherwise
the criterion would fire on the first run. For G1 the precondition is the
design-half power determination, and **it was met**: the bar was locked numerically
(0.0486) before any outcome. So G1's class is authoritative and K1 fires. For G2 it
is not met, so today's printed `insufficient_evidence` is not a verdict. One rule,
applied the same way both ways: **a class only counts once its gate's precondition is
satisfied.**

**Recommendation — K1 fires.** With two amendments for precision:

- **(a)** G1's exit reads: "a verdict class is emitted — from the test half when it
  is spent, otherwise from the design-half power determination, which is final for
  that lane and that window." Record that the test half remains **unspent**, and that
  this is not an extension: §8's own vocabulary says a FAIL cannot falsify an effect
  the lane could never have detected, so `underpowered` *is* the honest class.
- **(b)** Spell out what "may survive only as a filter" means for the shipped
  product, because otherwise it is a sentence with no consequence: the dashboard list
  (displayTopN 10 US / 5 HK) is a **candidate funnel**, the rule-provenance line must
  say the ranking carries **no validated alpha claim**, and no future change to
  `SCREEN_PARAMS` may be justified by any statistic on a spent window.

**Decision: ☐ accept ☐ amend ☐ reject —**

---

### D2 — What does Phase 6A's null do to the project?

**Charter says.** §7's table has entries for H1 (G1→K1) and H2 (G2→K2) only. Phase 6A
was opened on 2026-09-17 as a *third* thing — an exploratory family — so the table
does not cover its outcome. This is a genuine gap, not a reading.

**Options.**

- **(a) Extend K1's scope to the price/volume cross-sectional selection class** — the
  screen *and* formulaic alphas on price history are retired as alpha claims on the
  windows already examined; only a pre-registered test on **fresh data** may revisit
  them. Supports: two independent nulls now agree on this class (Phase 4's screen:
  20d IC +0.0145, t 0.97, `insufficient_evidence`; Phase 6A: max luck ratio 0.78,
  0 survivors), and the 166 alphas evaluated in *both* markets gave opposite signs on
  the standouts — which is not what a working factor looks like.
- **(b) Information only** — 6A informs, triggers nothing.
- **(c) Map it onto K4** — two of three tracks spent (4c underpowered, 6A null) is a
  restructuring trigger ("reduce the objective to one layer").

**Recommendation: (a), with (c) recorded as an *input* to K4 rather than an automatic
trigger.** (a) is the honest reading of two independent nulls on one class. (c) taken
automatically would pre-empt H2, which is still the only live clock and the thing the
charter calls the differentiator — and §8's discipline is that the decision rule
cannot be written by disappointment.

**One thing this option must NOT do:** it retires claims on *examined windows*, not on
the class in principle. It must not license the opposite error either — the "clearly
the answer is fundamentals/news" move, made from a null rather than from evidence.

**Decision: ☐ (a) ☐ (b) ☐ (c) ☐ amend —**

---

### D3 — K4's horizon: the number the charter never states

**Charter says.** "If neither layer has produced a verdict at target power **within
the pre-agreed horizon**, the project is restructured rather than extended." The
horizon is **not defined anywhere in the charter**. As written, K4 cannot fire, and
§7's own status note names it as the criterion most personal projects never act on.

**The clocks.**

| clock | measured requirement | honest date |
|---|---|---|
| H2 readiness | ~157 pooled labelled lane-days at ~21/month | **first label ≈ mid-Oct 2026** (20 sessions after the re-baseline), **measurement checkpoint ≈ mid-Nov 2026** (the projection watch at 20 labelled days), **readiness ≈ mid-2027** |
| Track B rank-IC | 4.7 y (US) / 18.1 y (HK) | not a clock |
| Track B differential | ~7 y, t = 1.20 at 3.98 y | not a clock |

**Recommendation — a date derived from the measured supply, not a vibe:**

- **Restructure K4 fires if H2 has not reached readiness by 2027-06-30.**
- **2026-11-15 is a measurement checkpoint, not a kill point:** the projection watch
  prints the observed/assumed per-day sd ratio at 20 labelled days, with the
  pre-agreed response at ≥1.5× being to change breadth or target *then*, while the
  sample is still unlabelled. That is the earliest moment this project can learn
  anything useful about H2, and it is ~7 months before the verdict.
- **No rolling extensions.** One amendment of the date is permitted, and only while
  the sample is unlabelled; after that the date stands.
- **Track B is recorded as not-a-clock.** It may keep accruing, but a criterion whose
  soonest trigger is 4.7 years out cannot gate anything, and pretending otherwise is
  how §7 becomes decoration.

**Decision: ☐ accept 2027-06-30 ☐ accept with a different date ☐ gate-based, no date —**

---

### D4 — K5 is now due, and needs an evidence standard

**Charter says.** "Evaluated at every G1/G2 exit. Is this platform's expected value
greater than (a dull index portfolio) + (a written monthly watchlist)? If not, stop
building and keep using it as a monitor. This is a legitimate, successful end state."

**Reality.** If D1 is accepted, **G1 has exited**, so K5 is due now — not at some
future H2 exit. But K5 as written is qualitative and names no evidence standard, so it
can be argued either way indefinitely.

**Recommendation — fix the admissible evidence *before* reading the comparison, and
record the outcome now:**

Admissible: (i) the three measured nulls (4c `underpowered`; 6A US 0/436 with max
luck ratio 0.78; Phase 4 `insufficient_evidence` on both lanes); (ii) realised cost,
**$1.81 measured against a $10 cap** for 2026-09, computed not modelled; (iii) that
the alternative's return over the tested window was **SPY +101.82 %** against the
screen portfolio's +88.95 % — the screen beat its like-for-like benchmark and lost to
the index; (iv) what the platform actually ships and does nightly (chain at 20:30 HKT,
dashboard with data-integrity and rule-provenance headers, cost tracking, manual
`journal:link` attribution, a chat surface over the decision log).

Outcomes, to be recorded explicitly: **continue** / **continue as monitor only** /
**stop building**. And a re-evaluation rule: K5 is re-read at an H2 verdict, not on a
timer.

**Decision: ☐ continue ☐ monitor only ☐ stop building ☐ amend the standard —**

---

### D5 — Two definitions that nothing else can settle

**(a) G2's clock after the re-baseline.** The charter's G2 text reads "currently
0 / 157 days (controlled 0 / 159) at breadth 40/lane" — confirmed *current* by the
2026-09-18 validator run, so the numbers need no correction; its implied *history*
does. Record: the model stack was re-baselined to `deepseek-flash` ×3 on
**2026-09-16** because the Kimi weekly quota made k3-256k unable to produce another
observation; the accrued k3 verdicts (151 post-gate + 87 pre-gate) are closed as an
**excluded sub-sample**, never pooled, at a recorded cost of ~8–10 lane-days of the
157-day pooled horizon; the 157-day figure stands; and only a **measured** SE
(SE(mean IC) ≤ 0.10 / 2.487) may authorise a decision.

**(b) What "twice" means in K2.** K2 fires on "`h2_falsified`, or **inconclusive twice
under the 1.5× guard**". "Twice" is undefined, and it is the only path to K2 short of
an outright falsification — so leaving it open leaves K2 half-defined. Proposed
definition: **two consecutive weekly validation digests in which the guard trips**,
which makes it a two-week observation rather than whatever the reader prefers.

**Decision: ☐ accept ☐ amend —**

---

## 3. Current state, for the record

| gate | entered? | exited? | class emitted | what is unspent |
|---|---|---|---|---|
| **G1** vendor generality | ✅ loader built; design-half bar locked numerically (0.0486) | **on D1** | `underpowered` (2026-09-13) | the vendor **test half** — never spent |
| **G2** deep-dive layer | ❌ readiness rule: only a measured SE may authorise; 0 of ~157 pooled labelled days | ❌ | — | the whole H2 sample |
| **G3** cost realism | ❌ nothing has been claimed `supported` | n/a | — | — |
| **G4** paper trading | ❌ needs G1/G2 `supported` **and** L6 wired as a live state gate (L6 is not wired; the sector cap is unwired) | n/a | — | — |
| **G5** real capital | ❌ | n/a | — | — |
| **K1** screen as alpha claim | **on D1** | — | — | — |
| **K2** agent layer | ❌ | ❌ | — | — |
| **K3** budget | continuous — **$1.81 of $10.00** (2026-09, measured) | ❌ under cap | — | — |
| **K4** time | continuous | **needs D3** | — | — |
| **K5** opportunity cost | **due on D1** | — | — | — |

---

## 4. What this lock does not do

- **It changes no bar, cap, floor, window or statistic.** §8's firewall stands:
  outcome statistics may inform *design* (nuisance parameters — SE, breadth, IR) but
  may never set, loosen, or justify a bar. Nothing here may be used to re-bar Phase 4,
  4b, 4c, 5 or 6A.
- **It neither spends nor unspends anything.** The vendor test half stays unspent; the
  picker window stays spent for the screen and for the formulaic-alpha family.
- **It does not take the Stage-2 objective decision** (`h2_holds` /
  `IC | rank ≈ 0` / `falsified on both` / `insufficient_evidence` /
  `underpowered`) — that stays deferred until H2 emits a class, which is what the
  charter's pre-commitment is for.
- **It does not lock the other three items §7 lists as unlocked**: the Stage-2
  decision table, the North Star metric ("time-to-verdict at pre-registered power —
  days / daysNeeded"), and the §5.3 self-audit. K4 and K5 both *read* the North Star
  metric, so that lock is the natural next one.

---

## 5. The five-class vocabulary (unchanged, restated for the lock)

`supported` · `falsified` · `insufficient_evidence` · `underpowered` ·
`inconclusive`.

- Only `supported` requires a claim; only `falsified` supports a negative.
- **`insufficient_evidence` is the default reading, not a failure to explain.**
- A FAIL cannot falsify an effect the lane could never have detected — that
  distinction is the difference between `falsified` and `insufficient_evidence`.
- `underpowered` is what a *design* emits, before outcomes; it is an answer.

---

## 6. Lock record

| item | decision | date |
|---|---|---|
| **D1** — K1 fires on the design-half `underpowered` | **ACCEPTED as recommended.** K1 has **FIRED**. G1's exit wording amended (D1a); the vendor test half stays unspent and that is recorded as *not* an extension. D1b's product meaning is now implemented: `SCREEN_RULES_CAVEAT` says the list is a candidate funnel with no validated alpha claim. | 2026-09-18 |
| **D2** — what 6A's null does | **ACCEPTED as recommended.** K1's scope extended to the **price/volume cross-sectional selection class** (screen + formulaic alphas on price history), retired on the windows already examined; only a pre-registered test on data those windows do not contain may revisit. Recorded as an *input* to K4, not an automatic K4 trigger — taken automatically it would pre-empt H2, the only live clock. | 2026-09-18 |
| **D3** — K4 horizon | **ACCEPTED: fires if H2 has not reached readiness by 2027-06-30.** 2026-11-15 is a measurement checkpoint, not a kill point. One amendment permitted, only while the sample is unlabelled. Track B recorded as not-a-clock (4.7 y US / 18.1 y HK). | 2026-09-18 |
| **D4** — K5 evaluation (due because G1 exited) | **ACCEPTED: CONTINUE**, on an evidence standard fixed before the comparison was read. Re-read at an H2 verdict, not on a timer. | 2026-09-18 |
| **D5** — two definitions | **ACCEPTED.** (a) G2's post-re-baseline clock recorded: restarted 2026-09-16, k3 verdicts an excluded sub-sample, 157-day figure stands, only a measured SE authorises. (b) "Inconclusive twice" = **two consecutive weekly validation digests** in which the 1.5× guard trips. | 2026-09-18 |

**Landed with the lock:** `docs/project-direction.html` §7 (status line, G1's exit,
K1's action with scope and the meaning of "filter", G2's verified state, K2's
"twice", K4's horizon, K5's evaluation, the locked-items table and the footer), and
`SCREEN_RULES_CAVEAT` in `apps/api/src/reports/reports.service.ts` — the dashboard's
one honest sentence about its own list, which D1b makes a requirement rather than a
nicety.

**Still open, and not implied by this lock:** the Stage-2 decision table, the North
Star metric ("time-to-verdict at pre-registered power — days / daysNeeded"), and the
§5.3 self-audit's residual MEDIUM items. K4 and K5 both *read* the North Star metric,
so locking that is the natural next item.