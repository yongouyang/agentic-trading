# Is the Databento/XNYS archive a "fresh cross-section" for H1?

Scoping session 2026-09-11, prompted by Phase 4b/5 both concluding that the only
remaining route to validating the screen is a **fresh cross-section** rather than
more time (`phase4c:accrual` projects 4.7 y for US and 18.1 y for HK). Read-only
investigation; nothing was run or changed.

**Verdict: (b) — a bounded data project. NOT the "same universe plus a tail"
collapse (c), and NOT ready to build (a).** The corporate-action blocker is smaller
than the first pass claimed — the registry plus existing candidates already explain
39 % of the liquid universe's jumps, ticker identity is 1.5 % of series and
quarantinable, and the only money-gated item is **dividends**.

## 1. The premise is half true, and the half that fails is the important one

| | start | end | sessions |
|---|---|---|---|
| Spent window (Phase 4) | 2022-09-08 | 2026-09-09 | 1003 |
| Spent window (Phase 4b re-run) | 2022-09-12 | 2026-09-11 | 1003 |
| **VendorBar `databento-xnas`** | **2021-09-02** | **2026-09-01** | 1254 |
| **VendorBar `databento-xnys`** | **2021-09-03** | **2026-09-02** | 1254 |

The archive overlaps the spent window by **~100 %**, adding only ~251 leading
sessions and stopping 9 days short of its end.

So **it is fresh in *names* and not in *time***. Scoring it is a **new-population
test on the already-spent regime** — a test of the screen's *generality*, not of its
out-of-time robustness. Any write-up calling this "validated on fresh data" is
wrong.

It is nevertheless a *legitimate* test, and the distinction matters: what makes a
window spent is that its **outcome statistics were looked at**. Phase 4 scored the
picker's eligible set. The 939 new names below have never been scored, and the
screen's gates were never chosen against their returns. The honest framing is
therefore "the same 2022–2026 regime, scored on a population whose outcomes were
not examined", pre-registered as a **distinct hypothesis** from H1.

## 2. The measurement that decides the project (and it is good news)

Pre-gate breadth, computed from `VendorBar` on 2026-09-11 — symbols with ≥252 bars
and `adv20 ≥ $20M` (mean `close × volume` over the last 20 sessions, on **vendor**
volume — see §4):

| | value |
|---|---|
| survivor (vendor, symbol) pairs | 1,844 |
| **distinct survivor symbols** | **1,490** |
| **not present in the picker universe (`Instrument` US)** | **939** |
| already in the picker | 551 of the picker's 564 |

**939 new liquid names.** Production's post-gate eligible breadth is ~180, so a
vendor lane post-gate is plausibly **2–3×** that. Since the detection floor scales
as `2·nwSe ∝ 1/√(N−1)`, US's floor of **0.0298** would fall toward roughly
**0.018–0.020** — which means **the original 0.02 bar becomes borderline
*reachable* for the first time.** That is the prize, and it is why this is worth a
data project rather than abandonment.

So the (c) collapse is avoided: the extra breadth is real and above the liquidity
floor, not a microcap tail.

## 3. What the archive actually holds (and a correction to our own docs)

`VendorBar(vendor, symbol, date, open, high, low, close, volume, segmentId)` —
OHLCV only. Two **separate series under different vendor keys**, with no
consolidated-tape reconciliation: **16,565 XNAS symbols / 11.20 M rows** and
**5,333 XNYS symbols / 3.99 M rows**, 15.2 M rows total.

**Our docs say "VendorBar: 16,777 symbols, 15.3 M rows".** That figure is a
single-feed census and understates the archive: it is **~21.9k symbol-series across
two vendor keys**, and ~354 symbols appear under *both* keys (1,844 pairs vs 1,490
distinct symbols), so a loader must decide which feed to trust per name rather than
concatenating.

**Survivorship is genuinely clean** — the opposite of `Instrument`, which is a
hand-compiled current index list. Evidence: 3,365 of 16,781 XNAS plain symbols
(20 %) 404 on Yahoo, `symbol-listing-exchange.csv` matches only 11,875 as currently
listed, and the manifest's tail shows series ending mid-2026 (`AAA … 142 bars, last
2026-06-09`). A delisting tail is present by construction.

## 4. The blocker: corporate actions, in three parts

**4a. No dividends exist for this universe — anywhere in the stack.** `VendorBar`
has no CA columns; there is no vendor CA table; the Databento reference CA endpoint
is **paywalled** (`403 no_subscription`); Yahoo 404s ~20 % of the names; eastmoney
F10 is HK-only. Consequences, in order of severity:

1. The derived series is a **price-return** series while Phase 4's outcome variable
   is **total-return**, so a vendor IC is not the same statistic as the published
   0.0145.
2. **The omission biases the Gate-2 differential *upward*** — the equal-weight
   benchmark holds the whole eligible set (including mature payers) while the
   trend-selected portfolio is generally non-paying. At a ~1.5 %/yr US yield that
   is ~6 % cumulative over four years, against a measured +38 % differential. A
   plausible-looking "alpha" could be manufactured by the adjustment layer alone.

**4b. Splits: the registry explains 39 % of the liquid universe's jumps — and the
rest could not be classified by the method I first tried.**

I ran the question this scoping session was for: extract every jump in the 1,844
liquid series, then ask what the **existing** artifacts explain. A "jump" is a
one-session move of ≥ +50 % or ≤ −40 % in adjusted-close terms.

| | events | share |
|---|---|---|
| total jumps in the liquid universe | **394** (247 series) | 100 % |
| explained by the `SplitEvent` registry | **152** | 39 % |
| explained by an existing detector candidate (`xnys-split-candidates.csv`, 3,119 rows; `detected-split-candidates-v4.csv`, 2,583 rows) | 2 | 1 % |
| **not explained by anything on disk** | **240** | **61 %** |

So the two detectors plus the registry already cover **39 % of the liquid
universe's jumps**, and the question is what the other 61 % are.

**I could not answer that with a lattice test, and the attempt is worth recording
because it produced a confident wrong answer twice.** Classifying each residue
ratio by the shipped `best_candidate` lattice gave "48 split-like" at the FAR tier
and "34 same-instrument split-like on 29 names" at the NEAR tier — and both are
meaningless. The lattice is built from every `n/d` with `n, d ≤ 32`, giving **702
points whose median log-gap is 0.0057 — four times smaller than its own
`LOG_TOL_NEAR = 0.025`** (88 % of gaps are below it). **Any** ratio therefore
matches some lattice point, and "missed splits on 29 names" was an artefact of a
classifier with no discriminating power. Left here rather than quietly deleted: it
is the same failure mode as reading a test count instead of a verdict.

The detectors' actual discrimination lives in **P2 (volume persistence) and P3
(price/plausibility floors)** — the module's own docstring says so — and those were
**not** run here.

**What the named cases do suggest** (interpretation, not measurement): the residue
is dominated by one-day repricings in biotech/pharma — ALNY +41 %, AMLX +79 %,
IMGN +85 % (AbbVie's acquisition), KDNY +65 % (Novartis'), RAPT −73 %, BBIO −57 %
— i.e. clinical readouts and M&A, which is exactly what a $20 M liquidity floor
selects for. Plus a small number of unmistakable **ticker-identity** breaks.

**Ticker identity is a real, bounded, measurable problem.** `META` is the clearest
case: the archive's META series is a **$12.29 shell whose last bar is 2022-01-28**,
then **Meta Platforms at a $196.00 open on 2022-06-09** (the FB→META rename date) —
a **132-day gap** and a phantom **+1,494 %** "return". Meta's history also exists
under `FB` (408 rows), so the archive keys on **ticker, not instrument**. Across the
liquid universe, **27 of 1,844 series (1.5 %) contain an internal gap > 14 days**
(24 above 45 days; worst 1,304 days). That is quarantinable rather than fatal.

**4c. `adv20` is venue-distorted.** Neither feed has consolidated volume (XNAS
carries full consolidated volume only for Nasdaq-listed names; XNYS carries Nasdaq
names at ~3–5 % of tape), so the $20 M floor is not the same filter as
production's, and the §2 breadth figure inherits that imprecision.

Two further gaps: **delisting returns are undefined** (a series just stops — no
MASH/M&A settlement, no terminal flag), and there is a **~18 bp/day convention
wedge** against the store's series (only 37.8 % of 680,775 cross-validated daily
returns agreed within 0.1 %), which is not noise for SMA50/SMA200 alignment.

## 5. The risk, restated after the measurement

The first version of this section asserted that a missing reverse split
"*guarantees*" a name passes the trend gates, on the strength of "247 of 1,844
liquid series carry a split-like jump". **That framing was wrong twice over**: the
lattice cannot tell a split from a large move (§4b), and the named residue is
dominated by genuine biotech repricings, not splits. The corrected risk ranking:

1. **Ticker identity** (measured, bounded): 27 of 1,844 liquid series contain a
   gap > 14 days, each a phantom return that a trend screen would rank at the top.
   `META` +1,494 % is the existence proof. Cheap to quarantine once listed.
2. **Missing dividends** (unmeasured, unbounded): the outcome variable becomes
   *price* return, and the omission biases the Gate-2 differential **upward**
   because the benchmark holds the payers and a trend-selected portfolio does not.
   This remains the **only** blocker that needs money rather than work.
3. **Venue-distorted `adv20`**: the $20 M floor is not production's filter.
4. **Delisting returns undefined**: a series simply stops.
5. **Unclassified jumps**: 240 of 394, which needs P2/P3 run to classify.

**The direction caveat survives, and is still the thing to keep in front:** dividend
omission and ticker-identity stitches both bias a momentum/trend screen **upward**.
The failure mode remains a confident false positive rather than a noisy null.

## 6. What is NOT hard

`runBacktest`, `replayScreen` and `runScreen` are **pure functions over
`SymbolSeries[]`**, so the whole gate/power/IC machinery is reusable verbatim. A
vendor lane needs a **loader + a CLI (~1 session)**: clone `loadLane`
(`apps/api/src/cli/backtest-screen.ts`) against `VendorBar`, a bar-level split
normalizer driven by `SplitEvent`, and reuse `deriveAdjustedBars` unchanged once a
dividend series exists. The archive is US-only, so there is no HK lane, and
`caDegraded` has no vendor analogue (default `false`, and say so).

## 7. What already exists (so the hard part is smaller than it looks)

The vendor-universe split work was **already started** and its tooling is in the
repo: `scripts/databento/xnys_split_detector.py`, `xnys_full_scan.py`,
`xnys_registry_crosscheck.py`, `split_candidate_detector.py`,
`split_persistence_filter.py`, plus an `xnys-yahoo-splits.csv` sweep and the
`audit:inband` CLI which corroborates in-band rows against `VendorBar`. The 51
NEAR-tier candidates were vetted on 2026-09-06 (2 appended). So "build a split
layer" means **running existing detectors over the liquid vendor set and resolving
the survivors**, not writing detection from scratch.

## 8. Recommended order

1. ~~Size the breadth~~ — **done here: 1,490 survivors, 939 new. The project is
   worth doing.**
2. **Done, and it moved the picture:** the registry + candidates explain **152 of
   394 jumps (39 %)**, and the unclassifiable 61 % needs the detector's P2/P3 gates
   rather than the lattice, which is degenerate (§4b). Next concrete step: **run
   P2/P3 over the 1,844 liquid series from the DB** (~1 session — the existing
   outputs came from the raw `.zst` archive via a pickle) and classify the residue
   properly. Also quarantine the 27 gap-bearing series.
3. **Decide delisting returns.** A design question no document in this repo
   addresses, and it silently determines what happens to the ~20 % of the universe
   that stops trading.
4. **Dividends are a purchasing decision**, not a coding one: either buy vendor CA
   data or accept a *price-return* test and pre-register it as such (with the
   upward-biased differential declared in advance).
5. **Then** the loader + CLI, and a Phase-4c pre-registration that says
   "new population, spent regime" in its first sentence.
