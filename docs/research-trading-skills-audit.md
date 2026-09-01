# Research: staskh/trading_skills — Skill Audit & Reuse Verdict

**Date:** 2026-09-01 · **Scope:** Source-level review of
[staskh/trading_skills](https://github.com/staskh/trading_skills) (350★,
actively maintained — last push 2026-08-31): full file tree via GitHub API,
repo cloned to `~/vendor/trading_skills`, `SKILL.md` files and core modules
(`scanner_bullish.py`, `piotroski.py`, `risk.py`, `technicals.py`,
`correlation.py`) read directly. Question: *what can agentic-trading borrow
without re-inventing wheels — and what must it not?*

**Installation record:** the skill directory
(`~/vendor/trading_skills/.claude/skills`) is registered in both harnesses —
kimi-code `~/.kimi-code/config.toml` `extra_skill_dirs` (doctor-validated;
`/reload` to apply) and pi `~/.pi/agent/settings.json` `skills` array.

---

## 1. TL;DR

- The repo is an **options-seller's toolkit for IBKR users** (PMCCs, covered
  calls, rolls, Greeks) wrapped as 24 Agent Skills over a Python package
  (`yfinance` + `pandas-ta` + `ib-async` + `massive`). That center of gravity
  decides the reuse split.
- **11 of 24 skills are applicable** to our HK/US equity picker; 13 are
  IBKR-broker or options plumbing that v1 explicitly excludes.
- **Borrow four knowledge assets** (none as code): the scanner-bullish
  scoring rubric (→ Phase 4 hypothesis H2), the Piotroski F-score (→ Phase 2
  Fundamentals Analyst), beta/VaR risk metrics (→ Day-13 risk work), and the
  report template + md→pdf export (→ Phase 3).
- **Do not borrow the runtime or the data path.** Architecture pins pure
  TypeScript; their unschematized yfinance fetching has none of our L1–L4 /
  `DataOutcome` discipline and would bypass R1–R4. Our loader is strictly
  better.
- **HK coverage is not improved** — insider data is SEC Form 4 (US-only),
  news is yfinance US-centric. The known HK news-depth gap stands.

## 2. Repo anatomy

```
trading_skills/
├── .claude/skills/<name>/SKILL.md   24 skills: instructions + args,
│                     └── scripts/   thin CLI wrappers (uv run python …)
├── src/trading_skills/              the real implementation
│   ├── broker/                      12 IBKR/TWS modules (ib-async)
│   ├── massive/                     whale-hunting (Massive paid API)
│   └── *.py                         yfinance-based analytics
└── mcp_server/                      same 23 tools for Claude Desktop
```

Skills are thin: each `SKILL.md` tells the agent to run a script via `uv run`
and interpret the JSON. All logic lives in the Python package. Dependencies
(`pyproject.toml`): yfinance ≥0.2.50 (free, no key — Yahoo), pandas-ta,
ib-async (broker), massive (paid), pandas-market-calendars.

## 3. Skill inventory & applicability verdicts

| Skill | What it does | Verdict |
|---|---|---|
| scanner-bullish | Composite bullish score over SMA/RSI/MACD/EMA-cross/ADX + momentum | **Borrow rubric** (§4.1) |
| technical-analysis | RSI/MACD/BB/SMA/EMA via pandas-ta | Reference only (quant-core covers) |
| fundamentals | Financials/earnings/key metrics via yfinance | Pattern reference (§4.2) |
| piotroski (in fundamentals) | F-score 0–9, 9 criteria, quarterly+annual | **Borrow** (§4.2) |
| risk-assessment | Volatility, **beta, VaR**, drawdown | **Borrow beta/VaR** (§4.3) |
| correlation | N×N correlation matrix | Borrow later (§4.5) |
| news-sentiment | Recent headlines + sentiment via yfinance | Pattern reference; kimi-datasource overlaps |
| earnings-calendar | Next earnings date, BMO/AMC timing, EPS est. | **Borrow as agent input** (§4.2) |
| insider-trading | SEC Form 4 activity | US-only; pattern reference |
| report-stock | Full markdown report template | **Borrow structure** (§4.4) |
| markdown-to-pdf | mistune + reportlab export | **Borrow for export** (§4.4) |
| price-history, stock-quote | yfinance OHLCV / quote fetch | Not needed (our loader is better) |
| greeks, option-chain, spread-analysis, scanner-pmcc | Options analytics (Black-Scholes etc.) | Out of scope (no options in v1+) |
| ib-account, ib-portfolio, ib-trades-history, ib-stop-loss, ib-trailing-stop, ib-collar, ib-pmcc-advisor, ib-find-short-roll, ib-option-chain, ib-report-delta-adjusted-notional-exposure, ib-portfolio-action-report, ib-create-consolidated-report | Live IBKR/TWS portfolio management | Out of scope (manual trading in v1; IBKR data is paid anyway — see `research-broker-market-data.md`) |
| whale-hunting | Unusual options activity via Massive | Out of scope (paid API) |

## 4. What we borrow (knowledge, not code)

### 4.1 scanner-bullish rubric → Phase 4 hypothesis H2

A complete, documented composite scoring system (max ~9.5):

| Indicator | Condition | Points |
|---|---|---|
| SMA20 / SMA50 | price above | +1.0 each |
| RSI | 50–70 / 30–50 / <30 | +1.0 / +0.5 / +0.25 |
| MACD | above signal; histogram rising | +1.0; +0.5 |
| EMA9/21 cross | golden / death | +0.5 / −0.25 |
| Dual crossovers | same direction, both ≤10 days old | ±1.0 (±0.5 any age); conflict −0.5 |
| ADX | >25 with +DI>−DI / +DI>−DI only | +1.5 / +0.5 |
| Momentum | period return ÷ 20 | −1…+2 |

Contrast with our H1 (`docs/phase-1-spec.md` §4): H1 is *trend-alignment +
risk-adjusted momentum* (SMA50>200, mom60, Sharpe, z-score blend, monthly
horizon); H2 is *multi-oscillator confluence with crossover recency* on a
~3-month window. They will rank the same universe differently — exactly what
a Phase 4 backtest comparison needs. H2's point-additive form is also a
different scoring family (additive rules vs z-score blend), worth testing as
a form, not just as parameters.

### 4.2 Piotroski F-score + earnings calendar → Phase 2 analyst inputs

`piotroski.py` implements the full 9-criterion F-score (4 profitability from
trailing-4-quarter sums, 5 leverage/liquidity/efficiency from YoY annual
comparison) over yfinance statements. This is the deterministic,
auditable pre-computation our Phase 2 Fundamentals Analyst should receive —
the LLM interprets a scored fact table instead of raw filings (cheaper, less
hallucination surface). Earnings-calendar (date + BMO/AMC) is a practical
deep-dive input: "earnings in 3 days" is a first-class risk flag for a
verdict. Both re-implemented in TS against our own data sources in Phase 2.

### 4.3 beta & VaR → risk module gap-fillers

quant-core has vol/Sharpe/MDD; `risk.py` adds **beta vs a benchmark** and
**parametric/historical VaR** — both needed when Day-13 position sizing and
any portfolio view land (post-v1). Borrow the definitions and edge-case
handling, not the code.

### 4.4 report-stock template + markdown-to-pdf → Phase 3 report surface

The markdown report template (summary → trend → fundamentals → PMCC → risks)
is a solid skeleton for our daily report view, minus the options section.
md→pdf gives the export path. Phase 3 mines both.

### 4.5 correlation.py → Day-24 portfolio work

N×N return-correlation matrix — the diversification check from Day 24
(low-correlation profit/loss offset). Later-phase reference.

## 5. What we do NOT borrow, and why

- **The Python runtime.** Architecture §2 pins "Pure TypeScript — no Python
  service." Running their scripts would reintroduce exactly that. Everything
  borrowed above is re-implemented in TS or used as spec material.
- **The data path.** Raw yfinance calls with no schema validation, no typed
  outcomes, no L1–L4 rules, no raw-vs-adjusted discipline (they consume
  yfinance's auto-adjusted frames — the exact convention trap our R1–R4
  exist to avoid). Our `YahooMarketDataProvider` + Day-17 gate is strictly
  stronger; nothing here improves it.
- **All 13 IBKR/options skills.** v1 is manual trading, no options, and
  `research-broker-market-data.md` already established IBKR market data is
  paid-only. If a paper→live path ever opens (Phase 4+), their broker
  module boundaries (`connection.py`, `portfolio.py`) are worth a *look* as
  prior art — nothing more.
- **whale-hunting.** Massive is a paid API; excluded by the free-no-key
  constraint (§4.1 routing table).
- **insider-trading as coverage.** SEC Form 4 is US-only; it does not dent
  the HK news-depth gap (risk §11.4). Kimi's Chinese-language strength plus
  HKEX announcements remains the HK plan.
- **Redundancy watch:** `news-sentiment`/`fundamentals` overlap the
  `kimi-datasource` plugin's structured APIs — prefer whichever is live in
  the harness; the repo's value here is methodology, not plumbing.

## 6. Follow-ups

1. Phase 2: re-implement Piotroski F-score + earnings-calendar fetch in TS as
   deterministic inputs to the Fundamentals Analyst.
2. Phase 4: encode the scanner-bullish rubric as hypothesis H2; backtest
   H1 vs H2 on the seeded store with out-of-sample discipline.
3. Phase 3: mine `report-stock/templates/markdown-template.md` for the daily
   report layout; `markdown-to-pdf` for export.
4. Later: beta/VaR and correlation join quant-core when position sizing and
   portfolio work begin.
