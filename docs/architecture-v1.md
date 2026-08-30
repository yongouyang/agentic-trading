# Architecture v1: Agentic Trading Platform — Stock Picker First

**Date:** 2026-08-30 · **Status:** Agreed design, pre-implementation
**Inputs:** 24 days of quant fundamentals (`docs/day_*.html`), landscape research
(`docs/research-agentic-trading-landscape.md`), TradingAgents framework review
(v0.3.x), and a decision session with the user (all forks below are confirmed).

> 🔎 **Follow-up audit:** [`research-github-skills-reuse.md`](./research-github-skills-reuse.md)
> (§15) reconciles this design against a source-level audit of 9 top trading
> repos. It confirms most v1 decisions. Its one conflict — §4's "silently
> excluded from screening" vs the three-way `DataOutcome` taxonomy — was
> **resolved 2026-08-31**: the loud taxonomy was adopted (see §4), along with
> dual signal representation (5-tier rating + continuous conviction + explicit
> abstain, see §7).

---

## 1. Objective

An agentic trading platform for personal investing. **v1 is a stock picker**:
a daily, agent-assisted research pipeline that produces a ranked watchlist of
candidates with evidence and risks. The user reads the output and **trades
manually** — no broker execution in v1.

Design principle (from the landscape research): **agents propose, the quant
core disposes.** The LLM layer never touches authoritative state; the
deterministic quant core (from the 24-day course) is the trusted layer.

## 2. Confirmed decisions

| Fork | Decision |
|---|---|
| Markets | HK stocks/ETFs + US stocks/ETFs + Irish-domiciled UCITS ETFs (LSE-listed; 15% vs 30% dividend withholding tax lane) |
| Picker mode | **Screen then deep-dive**: quant filters narrow the universe, LLM pipeline deep-dives survivors |
| Stack | **Pure TypeScript.** Nest.js backend, Next.js frontend. No Python service (no akshare; TradingAgents *pattern* reimplemented, code not reused) |
| Output | Interactive chat/session in a local web UI, with charts, tables, signals; plus a daily report view |
| Brokers (later) | Futu/moomoo + IBKR. Not integrated in v1 (manual trading); IBKR covers all three markets for the future paper→live path |
| Screening style | **Technical first** — trend/momentum/volume/volatility, directly from Days 3/12/18 |
| Cadence | **Daily after close** — two runs: ~16:45 HKT (HK), ~06:00 HKT (post US close) |
| LLM providers | Kimi (Moonshot) as workhorse; budget/open models (DeepSeek/Qwen) optional for cheap summarization. OpenAI-compatible client, swappable via env vars |
| Universe | **Large/liquid only (~800 tickers)**: S&P 500 + Nasdaq 100 + ~50 major US ETFs; HSI + HS Tech constituents + liquid HK ETFs |
| Agent depth | **Lean pipeline** (~6–8 LLM calls/stock): News/Sentiment Analyst + Fundamentals Analyst → Bull vs Bear debate → structured verdict |
| UI stack | Next.js (React) app + Nest.js API; TradingView lightweight-charts |

## 3. Repository layout

```
agentic-trading/
├── apps/
│   ├── api/            Nest.js — scheduler, data ingestion, screening,
│   │                   agent orchestration, persistence, REST/SSE for UI
│   └── web/            Next.js — chat session + dashboard + charts
└── packages/
    ├── quant-core/     The 24-day course in TS: Bar, incremental indicators
    │                   (Day 18), signals (Day 19), risk metrics (Day 12/13),
    │                   screening rules, data-quality checks (Day 17)
    └── agents/         LLM layer — lean TradingAgents-inspired pipeline,
                        provider-agnostic (OpenAI-compatible endpoint →
                        Kimi / DeepSeek / Qwen via env config)
```

Monorepo via pnpm workspaces. Storage: SQLite via Prisma (zero-ops, personal
scale) — scans, screen scores, debate transcripts, verdicts, watchlists.

## 4. Data layer

- Primary: `yahoo-finance2` (npm) — covers US, HK (`.HK`), LSE-listed UCITS
  (`.L`). Fallback: Alpha Vantage.
- Behind the Day-17 two-layer design (Reader parses / Loader fetches) so a
  broker feed (Futu OpenAPI, IBKR) can slot in later without touching
  downstream code.
- Every daily ingest runs the Day-17 7-category data-quality checklist
  (missing bars, stale dates, zero volume, price spikes, duplicates, bad
  adjustments, halted days). Failures are **typed and loud, never silent**
  (amended 2026-08-31 per `research-github-skills-reuse.md` §15.2):

  ```typescript
  enum DataOutcome {
    OK,               // clean → eligible for screening
    GENUINELY_ABSENT, // delisted, halted all-day, no such symbol →
                      //   exclude, log at info, no alarm
    FETCH_FAILED,     // 429, timeout, 5xx, schema break → exclude from
                      //   TODAY's screen, alert loudly, retry next run
  }
  ```

  `FETCH_FAILED` must never look like "this ticker has no opportunity." A run
  with non-trivial fetch failures is marked **degraded**, and the daily report
  leads with a data-integrity header (e.g. *"782/800 screened; 11 Yahoo 429s
  retried; 7 halted; 3 excluded for bad adjustments"*).
- Source selection is declarative: a **data-routing table** (source → markets →
  auth env key → constraints) with a test asserting it matches the loader
  registry — no per-module hard-coded provider choices. Fallbacks if the
  Phase 0 gate finds Yahoo HK/LSE insufficient: **tencent** (HK/US, reported
  "never-banned"), **longbridge** (HK/US OHLCV, key-based).
- Known weakness: HK small-cap Yahoo data quality (adjusted close, halts) and
  HK-specific news depth. Phase 0 gate validates this before we build on it.

## 5. Daily pipeline

```
~16:45 HKT (HK close) / ~06:00 HKT (US close)
  1. Update OHLCV for ~800 tickers
  2. Data-quality gate (Day 17 checklist) → typed DataOutcome per ticker;
     non-trivial FETCH_FAILED count marks the run degraded (see §4)
  3. Technical screen (deterministic, quant-core):
       trend structure (MA alignment, Day 3/18), momentum, volume
       confirmation, volatility/Sharpe bounds (Day 12)
     → ranked shortlist, top ~10–15 per market
  4. Lean LLM deep-dive per candidate (~6–8 calls each):
       News/Sentiment Analyst + Fundamentals Analyst (parallel)
       → Bull vs Bear debate (2 rounds)
       → structured verdict: 5-tier rating + continuous conviction
         ∈ [-1,1] (abstain tracked separately from neutral), thesis,
         key risks, invalidation conditions
  5. Persist report → chat UI / daily report view, led by a
     data-integrity header (screened/excluded/degraded counts)
```

Cost estimate: 20–30 deep-dives/day × 6–8 calls ≈ pennies/day at Moonshot
pricing. Multi-model split: cheap model for analyst summaries, stronger model
for debate + verdict.

## 6. The three market lanes

- **US stocks/ETFs** — full pipeline (screen + deep-dive). Best data/news
  coverage; TradingAgents' native vendors all apply.
- **HK stocks/ETFs** — full pipeline, with thinner news sources in v1 (Yahoo
  news, Google News RSS, HKEX announcements where feasible). Kimi's Chinese
  strength is an asset here.
- **Irish UCITS ETFs** — separate, simpler lane: curated list (~15 tickers,
  CSPX/VUAA class), **weekly** review. The question is allocation and
  tax-wrapper selection, not stock debate — no debate tokens spent on index
  trackers.

## 7. Agent layer (packages/agents)

Reimplements the TradingAgents org-chart *pattern* in TS, lean variant:

- Structured outputs (JSON schema) for every agent — verdicts are
  machine-readable and persistable.
- **Dual signal representation** (adopted 2026-08-31, from ai-hedge-fund's
  `AlphaModel` contract): every verdict carries both a **5-tier rating**
  (human-facing, UI/report) and a **continuous conviction ∈ [-1, +1]** (kept
  so Phase 4 can backtest signals without losing resolution to bucketing).
  **Abstain ≠ neutral**: an abstained signal is excluded from any blend's
  numerator *and* denominator; a genuine 0.0 conviction is a real neutral vote.
- Persistent decision log keyed by `hash(agent|model|system|user)`
  (PromptCache pattern): one artifact serving as **cache** (unchanged snapshot
  = $0 rerun), **audit record** (exact prompt + response behind every verdict),
  and **debug trail**. The chat UI can answer "why did you rank X on Aug 28?"
  and we can score the agents' historical accuracy later.
- Provider-agnostic client (OpenAI-compatible): `LLM_ANALYST_MODEL`,
  `LLM_DEBATE_MODEL`, `LLM_VERDICT_MODEL` env vars.

## 8. UI (apps/web)

- **Chat session as centerpiece**: drill into candidates, challenge theses,
  compare tickers, request charts — tool-calling into the Nest.js API, with
  charts/tables rendered inline.
- **Daily report view**: ranked watchlist per market with ratings, one-line
  theses, and links into full debate transcripts.

## 9. Explicitly out of v1

- Broker integration / order execution (manual trading)
- Backtesting engine and portfolio tracking
- Intraday/real-time data (daily bars only)

**Phase 4 commitment:** per Days 15/23, the screening rules are a *hypothesis*.
Once the picker has run for a while, backtest the screen itself and iterate —
the backtest module from Days 21–23 gets built there.

## 10. Build order

- **Phase 0** — monorepo scaffold; data ingestion + quality report.
  *Gate: Yahoo data verified good enough for HK/US/LSE before building on it.*
- **Phase 1** — quant-core indicators + screening engine + daily CLI shortlist
  (no LLM yet). Validates the trusted core end-to-end.
- **Phase 2** — lean agent pipeline + persisted daily reports (CLI-readable).
- **Phase 3** — Next.js chat UI + dashboard.
- **Phase 4** — backtest the screening rules; iterate on parameters with
  out-of-sample discipline (Days 11/23).

## 11. Risks carried forward (from landscape research)

1. Backtest overfitting — Phase 4 uses train/OOS splits, plateau-seeking.
2. LLM non-determinism — structured outputs + persisted decision log make
   decisions auditable; temperature pinned low for verdicts.
3. Data quality asymmetry across markets — Phase 0 gate + Day-17 checks.
4. HK news depth — accept asymmetry in v1; revisit sources in Phase 2.
