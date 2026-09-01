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
| Markets | **HK stocks/ETFs + US stocks/ETFs only** (LSE/UCITS lane dropped 2026-09-01). Tax-efficient US exposure via **HK-domiciled US-index trackers** (e.g. 3195.HK Hang Seng S&P 500) — no US estate tax; 30% WHT embedded at fund level (~0.2%/yr extra drag vs Irish UCITS, accepted for simplicity). ⚠️ HK cross-listings of *US-domiciled* funds (3455.HK = QQQ, ISIN `US…`) give **no** tax benefit: still US-situs + 30% WHT |
| Picker mode | **Screen then deep-dive**: quant filters narrow the universe, LLM pipeline deep-dives survivors |
| Stack | **Pure TypeScript.** Nest.js backend, Next.js frontend. No Python service (no akshare; TradingAgents *pattern* reimplemented, code not reused) |
| Market data | **One free no-key primary for both lanes: Yahoo v8** (via `yahoo-finance2`). Other sources are repair/rescue only, never a second daily feed. Store **raw OHLCV + corporate-action events**; derive adjusted series locally with the multiplicative convention (see §4.2) |
| Output | Interactive chat/session in a local web UI, with charts, tables, signals; plus a daily report view |
| Brokers (later) | Futu/moomoo + IBKR. Not integrated in v1 (manual trading); either covers both markets for the future paper→live path |
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
- Source selection stays declarative: a **data-routing table** (source →
  markets → auth env key → constraints, as in §4.1) with a test asserting it
  matches the loader registry — no per-module hard-coded provider choices.
- Known weakness, now measured: Yahoo HK **bars** are strong (above); Yahoo HK
  **corporate-action data** is broken for USD-declaring names — HSBC dividends
  come back FX-converted (`0.783188`, 8 decimals, on an HKD-quoted stock), and
  worse, Yahoo's *own* `adjclose` applies USD amounts unconverted against HKD
  prices (9988.HK: all 4 events, 5.45% error; 0005.HK's newest event; proven by
  implied-amount analysis in `docs/phase-0-verification-report.md`). HKD-native
  payers are exact (2800.HK: 0.0000%). ⇒ **Yahoo HK event amounts cannot drive
  local adjustment for USD-declaring HK names**. **Decided (2026-09-01): defer
  with a degraded flag** — v1 ships with Yahoo events; USD-declaring HK names
  carry a `CA_DEGRADED` flag and their long-window signals are annotated
  (short-window momentum is barely affected by a single event). A proper HK CA
  source is revisited in Phase 2; eastmoney-for-events was rejected as a
  blocking dependency after its per-IP ban proved to fire on the first request.
  HK small-cap halts and HK-specific news depth remain unvalidated.

### 4.1 Routing table (free, no-key) — revised 2026-08-31 after live probing

| Role | Source | Markets | Auth | Probed status |
|---|---|---|---|---|
| **Primary — sole daily feed** | `yahoo-finance2` (v8 chart API) | US, HK (`.HK`) | none | ✅ 1227 daily bars on `0005.HK` / 5y; raw closes within **0.27%** of eastmoney; 100% of bars aligned by date. (LSE (`.L`) was also verified clean, but the lane was dropped 2026-09-01.) |
| Repair / rescue (raw bars only) | eastmoney `push2his` kline | HK | none | ✅ good bars (`fqt=0` raw) · ⚠️ **hard-drops the TCP connection** (temp IP ban) after ~5 requests at 0.35s spacing → ≥2s + jitter |
| Repair / rescue (raw bars only) | tencent `hkfqkline` | HK | none | ✅ works · ⚠️ code is **5-digit** (`hk00005`) where Yahoo is **4-digit** (`0005.HK`); ≤1200 bars per call; a wrong-but-plausible code shape returns **HTTP 200 + empty bar array** |
| ~~US fallback~~ | ~~stooq~~ | — | — | ❌ **dropped**: the CSV endpoint serves a JavaScript proof-of-work challenge page (HTTP 200 + HTML, `__verify` SHA-256 leading-zero mine) instead of data — unusable headless |
| Later (Phase 4 / broker era) | Futu OpenD, **IBKR** | HK / US (IBKR also LSE, if ever re-added) | local | Researched 2026-09-01 (`docs/research-broker-market-data.md`): **neither is free** — IBKR historical bars need paid per-exchange subscriptions; Futu is quota-capped (100–1000 tickers/7d by asset tier) so it's repair-tier at best, and has no LSE coverage. §4.2 storage rules make the migration a re-fetch, not a rewrite |

Dropped as bulk fallbacks: **Alpha Vantage** (free tier ≈25 req/day — per-ticker
rescue at best), **stooq** (PoW-gated, above), akshare/tushare (A-share scope
excluded), and any paid source in v1.

**Yahoo is the only source whose *adjusted* prices we may use.** Every CN
source's adjusted series uses the additive convention that mis-states returns
(§4.2). Operational constraint: the request `User-Agent` must be pinned in the
loader (a long Chrome UA drew an immediate 429; a short `Mozilla/5.0` returns
200 in ~130ms), with ~200ms/request spacing — throttling is a design element,
not a retry policy.

### 4.2 Price-adjustment convention — four invariants (agreed 2026-08-31)

Providers do not agree on adjustment, and the disagreement is not a convention
nuance — it is a returns error. Measured on `0005.HK` (HSBC), 5y daily, which
cumulatively paid **55% of its oldest price** in dividends:

| Series | 2021 bar | today | implied 5y total return |
|---|---|---|---|
| raw | 41.45 | 161.00 | +288% |
| Yahoo `adjclose` (multiplicative) | 30.74 | 161.00 | **+369.9%** |
| tencent/eastmoney 前复权 `qfq` (additive) | 23.31 / 18.91 | 161.00 | **+590.8%** |

*(Window note: the "2021 bar" and raw +288% are measured from 2021-08-31; the
adjusted-vs-qfq return columns use the **common** oldest date 2021-10-18,
because tencent caps at 1200 bars. Same-direction either way; compare columns,
not rows.)*

Yahoo-adj vs tencent-qfq: mean **−12.3%**, max **40.2%**, **86% of bars** off by
>1%. Even on a low-yield mega-cap (`0700.HK`, 3.9% cumulative div) the max
deviation is **9.2%** and 40% of bars breach 1%, and the error **peaks at the
price trough** — precisely where RSI / reversal / dip signals fire. Additive
adjustment subtracts a fixed amount from depressed past prices, so it inflates
returns (and can go negative over long windows). Rolling 20d-momentum error on
HSBC: median 0.97pp, **p95 10.8pp** — enough to re-order a shortlist.

- **R1 — store raw, adjust locally.** Persist unadjusted OHLCV plus a
  corporate-action table (ex-date, amount, currency, type). The adjusted series
  is *derived* in `quant-core` by one documented multiplicative back-adjustment
  anchored at the latest bar: `adj_t = raw_t × Π_{i>t}(1 − D_i/P_prev,i)` where
  `P_prev` is the **previous session's close**. **No split factor is applied**:
  measured 2026-08-31 (verification report, Surprise 2), Yahoo v8 raw closes
  are *already split-adjusted* — applying a split factor double-counts (NVDA:
  +900% error). We store raw **as delivered** and adjust for dividend events
  only; if a future provider delivers split-unadjusted raw bars, that provider's
  loader must normalize before storage so the invariant "stored raw is
  split-adjusted" holds at the store boundary.
  No provider's convention is ever allowed into signal math; the series stays
  reproducible across provider history rewrites; dividend events are stored
  anyway for every lane that needs them; Phase 4 gets Day-17 total-return
  correctness. Feasibility verified: a provider's full adjusted series was
  reconstructed from Yahoo's own event list to within 0.6pp.
- **R2 — dual series, different jobs.** Signals and screening read the derived
  adjusted series; every displayed price, and everything the user types an
  order against, is the **raw** series (161.00, not an adjusted number).
- **R3 — never blend providers inside one instrument's series (no-splice
  rule).** Given ~40% divergence, splicing Yahoo→eastmoney at a mid-window hole
  injects a phantom ~12% jump that the momentum ranker reads as a breakout. A
  fallback may only supply **raw** bars, after which the whole series is
  re-derived locally.
- **R4 — cross-source validation compares convention-free quantities only**
  (raw closes, session-date index, CA event sets). **Never** adjusted prices.

Rejected alternative: "trust Yahoo's `adjclose` and defer local adjustment to
Phase 4" — rejected because it leaves the signal layer dependent on a provider
factor table we cannot inspect (and, per §4.1's HK dividend finding, one that
silently FX-converts), and because it makes every fallback unusable under R3.

### 4.3 Single-provider posture and the weekly sentinel

Yahoo is the only source whose free, no-key coverage spans US + HK
in one API, one response shape, and the one mathematically correct convention —
and probing showed every free alternative to be *more* fragile, not less
(stooq PoW wall, tencent silent-empty 200s, eastmoney IP bans). So: **one
provider for data, second sources for two narrow jobs only** —

1. **per-ticker repair** of `FETCH_FAILED` / `GENUINELY_ABSENT` bars (raw only,
   R3), and
2. a **weekly 10-ticker sentinel diff** — raw close + session dates + CA event
   count against eastmoney/tencent, ≈10 requests/week. (Scope: HK lane only —
   the repair sources have no US coverage, so the US lane relies on G2d's
   same-provider check plus Yahoo-internal consistency.)

Bulk cross-source validation is out of v1. What the single-provider posture
sacrifices is detection of a provider *silently rewriting history* between
runs; the sentinel is the cheap insurance for that **where a second source
exists**, and is not optional.

**Sentinel as built (2026-09-02):** `pnpm -C apps/api screen:sentinel`
(`apps/api/src/cli/sentinel.ts`, read-only, manual cadence ≈ weekly) over a
pinned 10-name HK sample — `0005 0700 0941 9988 0388 0001 0016 2318 2800 3195`
(liquid payers incl. the two USD-declaring CA_DEGRADED names, an ETF, and the
HK-domiciled US tracker). Four checks per name: **yahoo-rewrite** (fresh full
window vs store — same-provider revision, ALARM on any difference),
**tencent-dates** (independent session calendar; closes are never even fetched,
R4), **ca-revision** (dividend event date/amount delta, WARN), and
**eastmoney-raw** (cross-source raw closes) — built, but **opt-in via
`--eastmoney`** while that host's IP ban is unresolved, so a routine run never
probes it (≈12 requests/week normally, 22 with the leg on). Exit code 1 on any
ALARM (cron-ready); artifacts in `apps/api/reports/sentinel-<date>.json` are
the diff baseline. Scope stays HK-only: the second sources have no US coverage,
so the US lane keeps G2d's same-provider check (the yahoo-rewrite leg is
same-provider for both lanes when it runs on US names).

## 5. Daily pipeline

```
~16:45 HKT (HK close) / ~06:00 HKT (US close)
  1. Update **raw** OHLCV + corporate actions for ~800 tickers (Yahoo; rescue
     paths per §4.1) → re-derive the adjusted series locally (R1/R3)
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

## 6. The two market lanes

- **US stocks/ETFs** — full pipeline (screen + deep-dive). Best data/news
  coverage; TradingAgents' native vendors all apply.
- **HK stocks/ETFs** — full pipeline, with thinner news sources in v1 (Yahoo
  news, Google News RSS, HKEX announcements where feasible). Kimi's Chinese
  strength is an asset here. **HK-domiciled US-index trackers** (3195.HK etc.)
  are just members of this lane — the tax-efficient US-exposure vehicle
  (no US estate tax; 30% fund-level WHT accepted per §2). No separate
  allocation lane in v1.

*(Dropped 2026-09-01: the third lane — Irish UCITS ETFs via LSE — after
confirming HK-domiciled trackers capture most of the tax benefit (estate tax)
with acceptable drag, and that HK cross-listings of US-domiciled funds
(3455.HK) confer none. The GBX/GBP trap dies with the lane.)*

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
  *Gate: Yahoo data verified good enough for HK/US before building on it.*
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
5. **Silent provider revision** — Yahoo can rewrite history (dividends,
   adjustments) between runs, invisible from inside a single feed. Mitigated by
   R1 (history is derived, so re-derivation is free and inspectable) plus the
   §4.3 weekly sentinel.
6. **Free-source fragility** — the no-key sources we depend on throttle by IP,
   return 200-with-empty-body on bad request shapes, and change anti-bot rules
   (stooq is already PoW-gated). Mitigated by single-provider routing, loud
   typed outcomes, and the §4.1 probed-status table kept current.
