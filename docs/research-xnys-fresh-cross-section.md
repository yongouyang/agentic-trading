# Is the Databento/XNYS archive a "fresh cross-section" for H1?

Scoping session 2026-09-11, prompted by Phase 4b/5 both concluding that the only
remaining route to validating the screen is a **fresh cross-section** rather than
more time (`phase4c:accrual` projects 4.7 y for US and 18.1 y for HK). Read-only
investigation; nothing was run or changed.

**Verdict: (b) — a bounded data project, gated on a corporate-action layer. It is
NOT the "same universe plus a tail" collapse (c), and it is NOT ready to build (a).**

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

**4b. Splits are neither applied nor recorded for ~97 % of the liquid universe.**
`VendorBar` is **as-traded**, and R1 means splits are never applied locally (the
picker's Yahoo bars arrive pre-adjusted). So every split is a phantom jump in a
vendor series. Measured:

| | value |
|---|---|
| liquid vendor series with a split-like jump (≥ +50 % or ≤ −40 % in one session) | **247 of 1,844** |
| survivor symbols with **any** `SplitEvent` row | **39 of 1,490 (2.6 %)** |
| reverse-split rows on symbols the *picker* holds | **5** (of 2,666 reverse events on 1,789 symbols) |

That last row is the revealing one: the split registry's mass sits on symbols the
picker does not hold, so it was swept over a different population and tells us
nothing about the 939 new names. **~97 % of the liquid vendor universe would carry
unadjusted discontinuities into the screen.**

**4c. `adv20` is venue-distorted.** Neither feed has consolidated volume (XNAS
carries full consolidated volume only for Nasdaq-listed names; XNYS carries Nasdaq
names at ~3–5 % of tape), so the $20 M floor is not the same filter as
production's, and the §2 breadth figure inherits that imprecision.

Two further gaps: **delisting returns are undefined** (a series just stops — no
MASH/M&A settlement, no terminal flag), and there is a **~18 bp/day convention
wedge** against the store's series (only 37.8 % of 680,775 cross-validated daily
returns agreed within 0.1 %), which is not noise for SMA50/SMA200 alignment.

## 5. The risk, stated as one sentence

**Every defect above biases a momentum/trend screen in the same direction — up.**
A missing reverse split prints as a large positive jump and *guarantees* the name
passes `close > SMA50 > SMA200` and `mom60 > 0`; missing dividends flatter the
differential; venue-distorted volume distorts the gate that selects the universe.
So **the failure mode is a confident false positive, not a noisy null** — the exact
outcome this project has spent a week learning to distrust.

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
2. **Run the existing detectors over the 1,844 liquid vendor series and re-measure
   how many of the 247 jumps they explain.** This is the go/no-go for a screen run:
   if the residual is large, no vendor IC is interpretable. Cheap — the tools exist.
3. **Decide delisting returns.** A design question no document in this repo
   addresses, and it silently determines what happens to the ~20 % of the universe
   that stops trading.
4. **Dividends are a purchasing decision**, not a coding one: either buy vendor CA
   data or accept a *price-return* test and pre-register it as such (with the
   upward-biased differential declared in advance).
5. **Then** the loader + CLI, and a Phase-4c pre-registration that says
   "new population, spent regime" in its first sentence.
