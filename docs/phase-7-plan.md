# Phase 7 plan — quality-first compounder framework (fundamentals + trend gate + valuation ceiling)

Status: **LOCKED 2026-09-19** (user approved execution of P1→P6; executed starting 2026-09-20).
Predecessors: K1 (price/volume selection retired), Phase 6A (formulaic alphas null),
H2 abandoned 2026-09-19. This phase adds the *fundamental* leg the platform has
never had.

## 0. Mandate (user, 2026-09-19)

Low-frequency investing: holding periods of months to years. Target profile:
**positive/strong fundamentals + strong technicals + large future growth
potential**, US and HK lanes. Decisions taken this session:

- **D1 — Both modes supported**: a systematic, backtested evaluation *and* the
  decision-support product built on the same machinery.
- **D2 — The trend gate has exit authority** (not advisory).
- **D3 — HK leans quality/valuation; trend is a weaker filter there**
  (evidence: momentum is weak-to-absent in China-adjacent markets — A-shares
  show reversal; Griffin-Ji-Martin 2005, Hameed-Kusnadi 2002 for HK).
- **D4 — Guardrailed exploration**: the family of variants and subgroups is
  declared *here, before any run*; every result carries an exploratory label;
  promotion of any "works for group X" claim happens only through **one**
  pre-registered confirmation on data the exploration did not touch (K1's scope
  wording already permits exactly one such revisit).
- **D5 — Two trend-gate variants are declared and tested** (priced in the FDR):
  - **G1**: weekly close < 200-day MA → exit next session.
  - **G2**: trailing-12-month total return ≤ 0 → exit next session.
- **D6 — Quarterly fundamental re-rank** (semi-annual cadence is all HK
  reporting supports); the trend gate is *evaluated* nightly by the existing
  screen leg, which is free.

## 1. Design principles (from the evidence review, 2026-09-19)

The three legs are a **hierarchy, not a blend**:

1. **Quality/profitability is the selection base** — slow, cheap, robust,
   transfers to China (Novy-Marx 2013; QMJ 2019; Liu-Stambaugh-Yuan 2019).
2. **Trend/momentum is a gate, not an engine** — real but decays in months and
   crashes (Daniel-Moskowitz 2016); used as entry filter + exit authority (D2).
3. **Valuation is a ceiling, never a target** — removes the worst decile of
   hope-priced growth (LSV 1994; GMO 2021 growth traps −13%/yr). Earnings yield
   (E/P), not book-based value — the China evidence says B/M does not transfer
   (LSY 2019). PEG is misspecified (Easton 2004) and is not used.
4. **"Huge future growth" is a qualitative overlay, not a factor** — growth
   does not persist beyond chance (CKL 2003); analyst LTG forecasts carry no
   predictive power; ~1 in 10 firms sustains value-creating growth over a
   decade (Mauboussin base rates). It lives in the written thesis per survivor
   (thesis-tracker skill), with pessimistic base rates stated.

## 2. Data layer (the one real build)

| # | Item | Source | PIT property | Exit criterion |
|---|------|--------|--------------|----------------|
| E1 | **US fundamentals store** | SEC EDGAR companyfacts (free, ~555 calls, IP-throttled) | PIT-safe: every fact carries `end` + accession → `filing_date`; "known at T" reconstructible | New Prisma table(s); coverage report: ≥95% of the 555 stored US names with ≥8 quarters of revenue/net-income/equity |
| E2 | **HK fundamentals store** | eastmoney F10 `RPT_HKF10_FN_*`, columns=ALL | **Probe first** (E2a): does the response expose an announcement/notice date? If yes → near-PIT. If no → anchor at period-end + 90d conservative lag, declared as limitation | Probe result recorded as an amendment here; ≥90% of 145 HK names with ≥4 semi-annual periods |

> **Amendment E2a (2026-09-20) — probe result: NEGATIVE.** Probed
> `RPT_HKF10_FN_MAININDICATOR` (89 columns), `RPT_HKF10_FN_INCOME` (22),
> `RPT_HKF10_FN_BALANCE` (21) for 00700 with `columns=ALL`: the only date fields
> anywhere are `REPORT_DATE` / `STD_REPORT_DATE` (period end), `START_DATE`,
> and `FISCAL_YEAR` — **no announcement/notice date exists**. HK fundamentals
> are therefore anchored at **period-end + 90 days** (synthetic `filedAt`,
> flagged `filedAtSynthetic=1` in the store so the anchor is never mistaken for
> a measured filing date). Limitation 1 stands. Bonus from the probe: the
> main-indicator table alone carries everything the composite needs
> (OPERATE_INCOME, GROSS_PROFIT, HOLDER_PROFIT, GROSS_PROFIT_RATIO, ROE_AVG,
> DEBT_ASSET_RATIO, TOTAL_ASSETS, TOTAL_LIABILITIES, ISSUED_COMMON_SHARES) — the
> 3-statement tables are not required. Its `PE_TTM`/`PB_TTM`/`TOTAL_MARKET_CAP`
> fields are NOT trusted as PIT (recompute provenance unknown); E4 computes
> valuation from statements × stored prices instead.

> **Amendment E1b (2026-09-20) — two build-time findings.**
> (a) *Tag migration*: registrants move between us-gaap revenue tags over time
> (measured: AMD's `Revenues` holds only the 4 most recent quarters while
> `SalesRevenueNet` holds the full 78-fact history). The extractor therefore
> picks, per metric, the fallback tag with the **most** points — not the first
> non-empty one. (b) *Coverage denominator*: the §2 bars (US ≥95%, HK ≥90%)
> apply to **reporting entities** — names with ≥1 stored fundamental point.
> ETFs and delisted names have no statements by nature (US: `no-cik` /
> `http-404` from EDGAR; HK: empty F10 report) and can never meet the bar;
> they are listed in the coverage report but excluded from the denominator.
| E3 | **Sector/industry metadata** | EDGAR SIC (US) · eastmoney industry (HK) | Static attributes; no PIT concern for grouping | Every stored name carries a sector label; the subgroup list for §5 is frozen from this table |
| E4 | **PIT valuation inputs** | shares outstanding + earnings (EDGAR) × stored prices (US); eastmoney PE history for HK if exposed, else declared gap | Derived, same anchor as E1/E2 | E/P series reproducible per name per quarter |

Non-goal: yfinance / kimi-datasource snapshots — current-view only, fine for
live display, **never** for the backtest.

## 3. The quality composite (declared, equal-weighted z-scores)

All components PIT-computable from E1/E2 statements; signs flipped so higher =
better; winsorized cross-sectionally per quarter:

1. **Gross profitability** — (revenue − COGS) / total assets (Novy-Marx).
2. **ROE** — net income / equity (TTM).
3. **Margin stability** — negative of the 3-year std of gross margin.
4. **Safety** — negative leverage (debt / assets).
5. **Growth-of-quality** — 3-year revenue CAGR, capped at the 95th percentile
   (the *realized* kind, not the forecast kind).

HK composite: same five, but the composite weight is quality 60% / valuation
40% with trend demoted per D3; US: quality 70% / valuation 30%. (Declared here
so the weights cannot be tuned post-outcome.)

## 4. The strategy under test (pre-registered family)

**Universe**: the stored panels — US 555 names, 2021-09-20…2026-09-17 (1,254
sessions); HK 145 names, 2021-09-13…2026-09-18 (1,232 sessions). Fundamental
warmup ≥ 4 quarters before first ranking.

**Entry**: quarterly re-rank by composite; buy the **top 20, equal weight**
(charter's portfolio rule), only names passing (a) the valuation ceiling —
E/P above the universe's bottom quintile, i.e. *exclude the most expensive
20%* — and (b) the active trend-gate variant at entry.

**Exit (D2, authority)**: the gate is evaluated nightly; on a gate break the
position exits next session at that day's close (the conservative side of the
bar). Re-entry only at a quarterly re-rank. Fundamental exit: falling out of
the top 40 at a re-rank (buffer-rank hysteresis, the existing convention).

**Declared family** (the FDR scope, fixed now):
`{US, HK}` × `{G1, G2}` × `{composite}` = **4 strategy variants**, plus the
**sector subgroups** frozen by E3 (analysis only, labels not verdicts).

> **Amendment E3 (2026-09-20) — frozen subgroup list.** Both taxonomies map
> onto one shared 12-bucket scheme (`apps/api/src/fundamentals/sectors.ts`;
> US from EDGAR SIC with a `6798 → Real Estate` REIT override, HK from
> eastmoney `BELONG_INDUSTRY` keywords). Labelled: US 505/564 (59 non-reporting
> ETFs/delisted, expected absence), HK 145/145. Subgroups are the buckets with
> **≥15 labelled names** in a lane, `Other` excluded:
> **US** — Technology (96), Industrials (89), Financials (73), Consumer
> Discretionary (55), Healthcare (41), Utilities (38), Materials (35),
> Real Estate (24), Consumer Staples (22). **HK** — Consumer Discretionary (24),
> Technology (17), Financials (15). US Energy (14) and Communication
> Services (14) miss the bar; HK Real Estate (13) and below likewise.

## 5. Statistics and governance

- **Screening statistic**: mean 20d rank IC of the composite, NW t (lag 20),
  BH FDR q = 0.05 across the declared family, luck benchmark — the Phase-6A
  machinery, unchanged. Labels `alive`/`reversed`/`dead` are **labels**.
- **Portfolio statistic**: gated portfolio vs (a) ungated composite portfolio
  and (b) the equal-weight universe benchmark — daily differential with NW t.
  **Falsification-only** (Phase-6B's honest ceiling: ~5y cannot confirm at the
  observed IRs); a *supported* claim can only come from the IC path.
- **Subgroup claims**: exploratory labels only (D4). Promotion path: exactly
  one pre-registered confirmation on untouched data — candidates are the
  **unspent vendor test half** (US, 2024-09-03 onward, with its survivor-bias
  limitation restated at promotion time) or prospective accrual.
- **Power honesty**: effective independent observations on 5y of
  quarterly-rebalanced slow signals are few; floors are computed from measured
  SEs at build time and recorded as an amendment *before* the sweep runs
  (the 6A pattern). `insufficient_evidence` is a legitimate outcome.

> **Amendment P5 (2026-09-20) — power floors, recorded before interpretation.**
> Measurement run (`backtest:fundamental`, panel end 2026-09-17/18) gave
> primary-horizon NW SEs: US/G1 0.01124, US/G2 0.01087, HK/G1 0.02763,
> HK/G2 0.02480. Floors = 2 × the lane's worst SE (the 6A convention):
> **US 0.0225, HK 0.0553**. Below these, |IC| — however clean statistically —
> is *undetectable on this window*, never "no edge".

## 6. Product wiring (decision-support mode)

- Nightly: the existing screen leg gains a **trend-gate column** (G1/G2 state
  per name) — free, no LLM.
- Quarterly: a `fundamentals:refresh` + re-rank job (Sunday slot beside the
  existing weekly jobs); the dashboard report gains the composite rank,
  sector, valuation-ceiling pass/fail, and gate state.
- Per survivor of the current quarter: a written thesis via the
  `thesis-tracker` skill (5-sentence core, falsifiable assumptions, red lines,
  valuation anchors) — this is where the growth overlay (principle 4) lives,
  with its quarterly re-check as the operating cadence.
- `SCREEN_RULES_CAVEAT` updated to describe the new funnel honestly.

## 7. Pre-registered limitations

1. HK fundamentals PIT status depends on the E2a probe; worst case is a
   period-end + 90d anchor, which lags reality.
2. Sector labels come from two different taxonomies (SIC vs eastmoney industry)
   and are not mapped onto each other.
3. 5 years of bars × slow signals = few independent bets; subgroup cells will
   be small and noisy by construction.
4. The vendor test half is survivor-biased; it can *disconfirm* more cheaply
   than it can confirm.
5. EDGAR covers US-listed names; HK-listed US trackers (3195.HK etc.) have no
   statements — they stay technical-only members of the HK lane.
6. Survivorship: the stored universes are today's index lists; delisted names
   are absent. Stated, not fixed (same as Phases 4–6).

## 8. Non-goals

- No LLM in the evaluation path (D-session consensus: the test must run
  without any AI model).
- No new paid data source.
- No claim that the composite *ranks* with alpha — the funnel language of K1
  stands until a confirmation says otherwise.
- No intraday or weekly rebalancing; no shorting.

## 9. Build order (fast tier)

| Step | Deliverable | Exit criterion |
|------|-------------|----------------|
| P1 | E2a probe + E1/E2 ingest + Prisma migration | Coverage reports per §2; probe amendment recorded |
| P2 | E3 sector metadata + frozen subgroup list | Every stored name labelled; list committed here as amendment |
| P3 | Quality composite + E/P + both gates in quant-core | Known-answer tests per component; look-ahead invariant test (recompute at T equals prefix) |
| P4 | `backtest:fundamental` CLI over the declared family | Report renders per variant: IC + FDR + gated/ungated/benchmark differentials + subgroup table, all labelled exploratory |
| P5 | Power-floor amendment recorded **before** P4's first full run | Floors in this document, dated |
| P6 | Product wiring per §6 | Dashboard + nightly column + quarterly job armed |

P5 sits before P4's full run on purpose: the floors must exist before the
numbers do.
