# Phase 4c — pre-registration (LOCKED 2026-09-12)

Status: **LOCKED by the user 2026-09-12**, before any vendor-lane number exists.
Builds on the D6 skeleton (`docs/phase-4b-plan.md` §D6) and the XNYS scoping
work (`docs/research-xnys-fresh-cross-section.md`, plus the 2026-09-12 P2/P3
detector run). Nothing below was informed by any outcome statistic from the
spent window; where a measured *nuisance* parameter (breadth, variance, IR)
shaped a design choice, that is stated explicitly — nuisance parameters may
inform design, they may never set a bar.

## The two tracks

| | Track A — vendor lane | Track B — prospective differential |
|---|---|---|
| role | **deciding** | long clock, background |
| data | Databento archive, 2021-09→2026-09 (1,254 sessions) | daily picker output, accruing |
| deciding statistic | **mean 20d rank IC** (NW t, lag = horizon) | NW t on the daily differential |
| horizon | weeks (once the loader exists) | years (US ~7.2, HK sign-negative) |
| hypothesis | H1-**generality**: fresh names, spent regime | H1 as originally framed |

Track B follows the D6 skeleton verbatim — differential decides, US primary,
HK reported-only (power grounds: a 25-name lane floors near 0.05 IC), 1.5×
SE-stability guard, no Bonferroni inflation (two-lane one-sided t ≥ 2 sits at
≈ 4.5 % family-wise). It is restated here so this document is self-contained;
nothing in it changed on 2026-09-12.

## Track A — the vendor lane (deciding)

**Why this track exists.** R-d priced prospective accrual and it does not
rescue the question (US rank-IC bar reachable in ~4.7 y, HK in ~18 y). The
archive's premise is **fresh in NAMES, not in TIME**: its 1,254 sessions
overlap the spent window ~100 %, so this is a new-population test on an
already-looked-at regime. That is legitimate only as a **distinct hypothesis —
the screen's generality to names it has never ranked** — and it is
pre-registered as exactly that. It is never "validated on fresh data".

**Universe (fixed).** Vendor `VendorBar` series with ≥ 252 bars and adv20 ≥
$20 M on vendor volume: **1,844 series / 1,490 distinct symbols**, of which 939
are not in the picker universe. Loader rules, all measured prerequisites
already met:

1. **Quarantine the 27 gap-bearing series** (`scripts/databento/quarantine-gap-series.csv`,
   internal gap > 14 days — includes the META ticker-identity case).
2. **Apply split adjustments** from the `SplitEvent` registry **plus** the two
   detector-candidate rows (CDTX 1:19 reverse, QXO ≈ 16:3). The 2026-09-12
   P2/P3 run classified all 394 jumps in the liquid universe: 152
   registry-explained, 2 candidates, 240 repricing/news (146 fail the split
   factor band, 44 intraday, 47 volume gates) — residual unexplained-split risk
   ≈ 0.
3. **Dividends:** Yahoo-harvested dividend layer where covered; price returns
   elsewhere. Coverage and the residual are measured by the harvest and
   disclosed in the run report. Consequence: the Gate-2 differential carries a
   known **upward bias** (the equal-weight benchmark holds the payers; a
   trend-selected portfolio does not), bounded by the harvested coverage.
   *Measured 2026-09-12 (harvest, pre-bar-lock): 1,378 of 1,490 survivors
   (92.5 %) covered — 914 with dividends in-window (17,376 events), 464
   genuinely non-paying; 112 not-found (7.5 %, delisted/acquired/renamed
   skew). Harvested TTM yield across covered names ≈ 1.48 %/yr (excluding a
   SOXS split-basis artifact), so effectively all of the benchmark's
   ~1.5 %/yr yield is adjustable; residual bias ≤ ~0.1 %/yr, disclosed.
   Artifacts: `scripts/databento/yahoo-dividends.csv` (17,376 rows),
   `yahoo-dividends-residual.txt` (the 112). Loader caveat: amounts are
   Yahoo-nominal at ex-date — consistent with as-traded prices and SplitEvent
   factors, but never ratio them against split-adjusted prices.*
4. A symbol appearing under both vendor keys (≈ 354) is loaded from **one**
   feed (choose by bar count; record the choice) — never concatenated.

**Deciding statistic (locked 2026-09-12, reversing D6's demotion on changed
premise).** Mean 20d rank IC over the test half, Newey–West t with lag =
horizon. D6 demoted rank IC *at picker-lane breadth*; the vendor lane's
breadth (plausibly 2–3× the picker's ~180) restores its power — per-day SE ≈
1/√(N−1) ≈ 0.045 at N ≈ 500, so a ~2.5-y test half (≈ 31 effective days at lag
20) gives SE(mean) ≈ 0.008 and t ≈ 2.5 at IC 0.02. The differential cannot
decide on this window at any plausible IR (at the picker lane's measured IR
0.49 — a nuisance parameter used for *statistic selection*, not for any bar —
a 2.5-y half yields t ≈ 0.8), so it demotes to falsification-only Gate 2 with
the dividend upward-bias disclosed.

**Bar derivation (the D1 rule, with a cap).** Split the vendor window
chronologically: earlier half = **design**, later half = **test**. On the
design half, measure breadth and the NW SE of the 20d rank IC; the bar is the
IC magnitude that gives **target power 0.8** (one-sided α = 0.05) on the test
half. **Cap: 0.03.** If the 0.8-power bar exceeds 0.03, the lane is declared
**underpowered by design** — before any test-half number is computed. The cap
exists so an underpowered lane cannot be rescued by quietly raising the claim.

**SE-stability guard (1.5×, locked).** If the test-half realized SE exceeds the
design-half's by more than 1.5×, the lane is **inconclusive**, not failed —
the design half cannot fail a lane for a regime it never saw (amendment R4).
Same factor as the Phase-5 verdict-IC regime guard: one convention.

**Gate 2 (differential), falsification-only.** Top-N portfolio vs equal-weight
eligible benchmark, NW t, lag = horizon. A FAIL (differential < 0) falsifies
the *portfolio rule*, not the ranking; a pass is never cited as confirmation.
Reported with the dividend-bias and cost-model caveats. Top-decile spread is
descriptive only (firewall: the picker's t 1.66 may not inform anything here).

**Verdict classes:** `supported` (IC ≥ bar AND t ≥ 2 on the test half) ·
`falsified` (upper CI bound < 0) · `insufficient_evidence` (CI contains both 0
and the bar — the Phase-4b class, kept) · `underpowered` (0.8-power bar > cap,
declared pre-outcome) · `inconclusive` (SE guard tripped).

**Family.** One deciding test (one statistic, one lane, US-only archive) — no
multiplicity adjustment. HK does not participate (US-only data; and reported-
only per the Track-B decision).

## Firewall (restated)

The spent window's outcome statistics — US D2 t 1.19, D4 t 1.66, HK t 1.34,
IR 0.49, and every Gate-1 yearly value — may inform **design** (nuisance
parameters: SE, breadth, IR for statistic selection) but may **not** set,
loosen, or justify any bar. The bar's magnitude comes only from the design
half of the vendor window via the 0.8-power rule. After the bar is locked, the
following may not change: `SCREEN_PARAMS`, the universe rules above, the split
point, the cap, the guard factor, the statistic.

## Execution order

1. Yahoo dividend harvest + coverage report (running 2026-09-12).
2. Loader + vendor-screen CLI (quant-core is already pure over `SymbolSeries`;
   ~1 session, fast tier).
3. Design-half measurement → **the bar, locked numerically, appended to this
   document** (with the design-half breadth/SE it came from).
4. Test half spent **once** → verdict per the classes above.
5. Track B continues accruing in the background (no action).
