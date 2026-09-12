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
| Cadence | **Daily after close** — installed **16:50 HKT** (HK) and **06:10 HKT** (post US close), plus a guarded 20:30 HKT catch-up slot (§5.1) |
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
  *(2026-09-02: that rejection was host-attributed wrongly — the ban lives on
  `push2his`, while eastmoney's F10 host `datacenter.eastmoney.com` answers
  normally and publishes per-event **declaring-currency amount + HKD equivalent +
  ex/pay dates**, 94 rows back to 1999 for 0005.HK. The Phase-2 revisit now has a
  concrete, measured candidate; the defer-with-flag decision is unchanged.
  `docs/research-akshare-tickdb.md`.)*
  *(2026-09-06: revisited and DECIDED — F10 is adopted as a **correction
  overlay**, not a primary source: Yahoo stays the primary CA feed; F10's HKD
  equivalents overwrite stored DIVIDEND amounts only on `CA_DEGRADED` names
  (and set the flag when a non-HKD declaration is newly detected), and F10's
  `特别分配` rows import distributions-in-specie as a new CorporateAction type
  `IN_SPECIE` (ratio + HKD equivalent when published). US names and HK ETFs
  stay Yahoo-only — F10 has neither (measured: no ETF records, no US dividend
  history). The refresh is a weekly, non-blocking CLI
  (`pnpm -C apps/api ca:f10-refresh`): its failure never degrades
  screen:daily.)*
  HK small-cap halts and HK-specific news depth remain unvalidated.

### 4.1 Routing table (free, no-key) — revised 2026-08-31, extended 2026-09-02 after live probing

| Role | Source | Markets | Auth | Probed status |
|---|---|---|---|---|
| **Primary — sole daily feed** | `yahoo-finance2` (v8 chart API) | US, HK (`.HK`) | none | ✅ 1227 daily bars on `0005.HK` / 5y; raw closes within **0.27%** of eastmoney; 100% of bars aligned by date. (LSE (`.L`) was also verified clean, but the lane was dropped 2026-09-01.) |
| Repair / rescue (raw bars only) | eastmoney `push2his` kline | HK | none | ✅ good bars (`fqt=0` raw) · ⚠️ **hard-drops the TCP connection** (temp IP ban) after ~5 requests at 0.35s spacing → ≥2s + jitter |
| Repair / rescue (raw bars only) | tencent `hkfqkline` | HK | none | ✅ works · ⚠️ code is **5-digit** (`hk00005`) where Yahoo is **4-digit** (`0005.HK`); ≤1200 bars per call; a wrong-but-plausible code shape returns **HTTP 200 + empty bar array** |
| ~~US fallback~~ | ~~stooq~~ | — | — | ❌ **dropped**: the CSV endpoint serves a JavaScript proof-of-work challenge page (HTTP 200 + HTML, `__verify` SHA-256 leading-zero mine) instead of data — unusable headless |
| Cross-source validation **lead — not adopted** | sina daily bars (`hkstock/<5digit>/klc2_kl.js`, `staticdata/us/<T>`) | HK + US, stocks **and ETFs** | none | Researched 2026-09-02 (`docs/research-akshare-tickdb.md`): ✅ 131/131 HK + 40/40 US store instruments, 0 failures, full history in one request (00005 → 6,965 bars since 1998; SPY since 2001), no ban in ~250 calls · ❌ payload is an obfuscated blob needing a vendored ~18 KB reverse-engineered decoder; **as-traded** prices, so not level-comparable to our store across splits (§4.2 R3); ETF universe absent from its list endpoint |
| Phase 2 events/fundamentals **candidate — not adopted** | eastmoney **F10** `datacenter.eastmoney.com` (a *different* host from the banned `push2his`) | HK + US (ETFs: no) | none | ✅ reachable today: 12/12 calls at ~1 s, ~0–100 ms, 200 from Node too. Gives HK dividend events with **declaring-currency amount + HKD equivalent + ex/pay dates** (00005: 94 rows back to 1999 — the `CA_DEGRADED` case) and HK/US three-statement history (00700: 1,124/585/966 rows). ❌ no ETF records, no US dividend history |
| **Bulk historical archive (one-off, paid)** | **Databento** XNAS.ITCH + XNYS.PILLAR `ohlcv-1d` batch | US — Nasdaq-feed universe (all consolidated-tape names) + NYSE-listed names via the NYSE feed | API key (paid; batch download) | ✅ XNAS imported 2026-09-05, XNYS 2026-09-06 (`docs/research-databento-import.md`): 20,623 files → 11.33M bars (XNAS, all plain symbols incl. delisted) + 1,254 day-files → 3.99M bars / 5,333 symbols (XNYS, **restricted to NYSE/Arca-listed** per listing reference — NASDAQ names arrive on the NYSE tape at ~4% volume, excluded by decision) 2021-09→2026-09 into **`VendorBar`** (as-traded, **not** R1-normalized — adjusted series derived on read via the **`SplitEvent`** registry: 2,642 Yahoo v8 + 594 verified in-band = 3,236 events after echo dedupe). Ticker reuse handled by the **`VendorSegment`** pass (19 genuine stitches). NYSE space notation normalized to dot at storage (`BRK B`→`BRK.B`). ⚠️ XNAS feed is **not NASDAQ-only**: NYSE/Arca names arrive via ADF at *partial* volume and `publisher_id` cannot classify them — use `VendorInstrument` (nasdaqtraded.txt join). ⚠️ Reference/corporate-actions API 403s without a free portal subscribe — that's why split events came from Yahoo, not Databento |
| Later (Phase 4 / broker era) | Futu OpenD, **IBKR** | HK / US (IBKR also LSE, if ever re-added) | local | Researched 2026-09-01 (`docs/research-broker-market-data.md`): **neither is free** — IBKR historical bars need paid per-exchange subscriptions; Futu is quota-capped (100–1000 tickers/7d by asset tier) so it's repair-tier at best, and has no LSE coverage. §4.2 storage rules make the migration a re-fetch, not a rewrite |
| ~~Evaluated, rejected~~ | ~~**TickDB** (tickdb.ai)~~ | — | key | Researched 2026-09-02: coverage is real (HK 3,543 + US 14,169 catalogue products, ETFs included, 131/131 HK + 562/564 US store names present) and its closes match ours to 0.0000 % median — but **the API exposes no dividend or split endpoint and no `adjust` parameter**, so §4.2 R1 (store raw **+ events**) is unsatisfiable at any tier; free = 72 symbols / 1 calendar year / 30 req-min on a *globally shared* trial key; 5y history ⇒ $899/mo. Also: daily bars stamped at exchange-local midnight, and `kline` serves a still-forming bar despite its "completed periods" doc |

Dropped as bulk fallbacks: **Alpha Vantage** (free tier ≈25 req/day — per-ticker
rescue at best), **stooq** (PoW-gated, above), **TickDB** (no CA events, paid),
and any paid **live feed** in v1 (the Databento archive above is a one-off batch
*purchase* — a backtest input, never a daily dependency, which is why it does not
contradict this line). **tushare** stays excluded (key + credit points). The
earlier "akshare (A-share scope excluded)" line was *wrong about scope* —
measured 2026-09-02, akshare covers HK and US stocks and ETFs with history far
deeper than Yahoo's; it is excluded because it is a Python wrapper (stack
constraint, §3) over the two hosts already listed above, not because it lacks
coverage (`docs/research-akshare-tickdb.md`).

**Yahoo is the only source whose *adjusted* prices we may use.** CN adjusted
series are unusable — but *not* for one uniform reason (measured 2026-09-02,
`docs/research-akshare-tickdb.md` §2.4): tencent/eastmoney `qfq` is additive
(the §4.2 table); sina's **HK** `qfq` is *multiplicative* (5-y TR 420.2 % vs our
428.6 % derivation — right convention, still not our numbers); sina's **US**
`qfq` is additive cash; and sina publishes **no factor file at all for HK ETFs**
(`02800`/`03032`/`03195` → HTTP 404, so `qfq` silently equals raw: ETF 5-y TR
−2.8 % vs our +14.5 %). Conventions vary *inside* one provider — the rule is
"derive locally, always", not "CN means additive". Operational constraint: the
request `User-Agent` must be pinned in the loader (a long Chrome UA drew an
immediate 429; a short `Mozilla/5.0` returns 200 in ~130ms), with ~200ms/request
spacing — throttling is a design element, not a retry policy.

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

  **Scope of that invariant (clarified 2026-09-12).** It binds the **Yahoo store**
  (`Bar`). The vendor store is the documented exception: `VendorBar` holds
  **as-traded** prices, because the Databento archive carries no corporate-action
  columns and its reference endpoint is paywalled (§4.1), so its split factor is
  applied at *read* time from the `SplitEvent` registry. The vendor store's
  contract is therefore "as-traded **plus** a split registry", not "already
  normalized" — and no code may ratio a vendor price against a split-adjusted one
  (the same basis-mixing that produced the `SOXS` 645 %/yr artifact).
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
- **R3a — "raw" is not a shared quantity across providers (measured 2026-09-02,
  `docs/research-akshare-tickdb.md`).** Yahoo v8 `close` is split- **and
  distribution-in-specie-adjusted**; every alternative measured here (sina,
  eastmoney `fqt=0`, tencent, TickDB) is **as-traded**. A 131-instrument × 5-year
  HK audit: 130/131 names agree at median |deviation| **0.0000%**, 95 have at
  least one bar off by >0.5 %, 13 have >3 bars off by >0.5 %, and **5 carry a
  persistent >2 % block** — while a 45-name US sample flags 10 names (≈22%) the
  same way. Exact measured factors: `1211.HK` 0.3333 across BYD's 2025-06-10
  bonus (`WMT` 0.3333 for its 3:1, `SMCI` 0.1, `UNG` 4.0, `NFLX` 10.0),
  `0700.HK` 0.92186 → 0.94978 → 1.0 across the JD and Meituan in-specie
  ex-dates — **which appear in no event row Yahoo publishes**, so this class is
  invisible to any event-based check. *(2026-09-06: no longer invisible —
  eastmoney F10 `RPT_HKF10_MAIN_DIVBASIC` publishes these as `特别分配` rows,
  e.g. 00700 `特殊说明:每10股分派1股美团B类普通股股份(相当于每股派18.13港元)`
  (ex 2023/01/05) and `特殊说明:每21股腾讯股份分派1股京东集团A类普通股股份`
  (ex 2022/01/20); they are now imported as `IN_SPECIE` CorporateAction rows by
  the weekly F10 enrichment, and the sentinel's eastmoney level window starts
  after the latest in-specie ex-date on such names.)* Two consequences: the
  rescue guard's
  "agree to tick precision on the surrounding closes" test (§A.4) is what makes
  R3 safe and must not be relaxed to an order-of-magnitude check; and any
  cross-source **level** validation must be split-aware (compare day-over-day
  returns, or exclude CA ex-dates) or it will fire on convention, not on
  corruption.
- **R4 — cross-source validation compares convention-free quantities only**
  (raw closes, session-date index, CA event sets). **Never** adjusted prices.
  *(Qualification from R3a: raw closes are convention-free only within a
  corporate-action-free window — outside one, they are not. Half-day and
  year-end sessions are a second, date-correlated noise source: single days where
  7–11 of 15 sampled HK names differ from Yahoo by 0.15–0.7%.)*

Rejected alternative: "trust Yahoo's `adjclose` and defer local adjustment to
Phase 4" — rejected because it leaves the signal layer dependent on a provider
factor table we cannot inspect (and, per §4.1's HK dividend finding, one that
silently FX-converts), and because it makes every fallback unusable under R3.

**Vendor-archive identity (agreed 2026-09-05, `docs/research-databento-import.md`
§6.8):** the Databento `VendorBar` archive is keyed on the raw ticker *string*,
and tickers get recycled — measured stitches: META (Roundhill ETF → Meta
Platforms, +1404% phantom return), BNY, FB (Meta → ProShares ETF), plus 627
detector false positives from the same cause. The archive therefore carries an
**empirical segmentation layer**: nullable `segment_id` on `VendorBar` +
`VendorSegment(symbol, segment_id, first_date, last_date, evidence)`, populated
by a post-import stitch-detection pass (calendar gap > 10 sessions AND price
jump outside 1/2.5–2.5× AND no `SplitEvent` on the date AND no rational split
match). Raw bars are never altered; consumers of vendor series must group by
(symbol, segment_id). This is archive-scoped only — the Yahoo store needs no
identity concept because its series are continuous through renames.

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
(`apps/api/src/cli/sentinel.ts`, read-only; scheduled weekly via launchd since
2026-09-06, see §5.1) over a
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
16:50 HKT (HK close) / 06:10 HKT (US close)   ← installed times per §5.1
  1. Update **raw** OHLCV + corporate actions for ~800 tickers (Yahoo; rescue
     paths per §4.1) → re-derive the adjusted series locally (R1/R3)
  2. Data-quality gate (Day 17 checklist) → typed DataOutcome per ticker;
     two independent **degraded** triggers (see §5.2): FETCH_FAILED > 2 % of the
     lane, or one date accounting for null-close drops across > 50 % of it
     (a whole-universe session gap)
  3. Technical screen (deterministic, quant-core):
       trend structure (MA alignment, Day 3/18), momentum, volume
       confirmation, volatility/Sharpe bounds (Day 12)
     → ranked shortlist, top N per market (`SCREEN_PARAMS.topN` = 40 US / 40 HK
       measurement breadth; the dashboard presents `displayTopN` = 10 US / 5 HK)
  4. Lean LLM deep-dive per candidate (~6–8 calls each):
       News/Sentiment Analyst + Fundamentals Analyst (parallel)
       → Bull vs Bear debate (2 rounds)
       → structured verdict: 5-tier rating + continuous conviction
         ∈ [-1,1] (abstain tracked separately from neutral), thesis,
         key risks, invalidation conditions
  5. Persist report → chat UI / daily report view, led by a
     data-integrity header (screened/excluded/degraded counts plus the
     **effective data cutoff** — the newest bar date the lane holds)

     *Added 2026-09-11 (Phase 4b item 6): the header also carries a **rule
     provenance** line.* It previously vouched only for the *data* — how much was
     screened and how fresh it was — while the list's ranked conviction came from
     ranking rules nobody has validated (Gate 1's pre-registered power bar was
     unreachable at both lanes' breadth, so its FAIL is insufficient evidence
     rather than evidence of no edge). The line is deliberately qualitative plus a
     dated pointer to `docs/phase-4b-plan.md`: the measured detection floors are
     window-specific and would silently rot in the UI after the next backtest.
```

Cost estimate: 20–30 deep-dives/day × 6–8 calls ≈ pennies/day at Moonshot
pricing. Multi-model split: cheap model for analyst summaries, stronger model
for debate + verdict.

### 5.1 Scheduling (launchd, installed 2026-09-06)

Six user LaunchAgents (`scripts/launchd/`, installed into
`~/Library/LaunchAgents` by `scripts/launchd/install.sh`; stdout/stderr →
`logs/` at the repo root). launchd, not cron, because macOS cron silently
skips jobs missed while asleep; StartCalendarInterval catches up after wake.

**The catch-up guarantee stops at power-off** (measured 2026-09-11). launchd
keeps no memory of calendar slots that elapsed while the machine was shut down:
on a day booted at 19:44, both the US 06:10 and the HK 16:50 slots were gone with
no replay, and `ops:health` read them as missed runs. Catch-up-on-wake is real
for *sleep* (observed 2026-09-10: a 06:10 slot caught up at 08:35), which is why
the health model treats one missed slot as `warn` rather than `alert` — but a
laptop that is off during its slots loses those sessions outright. That is an
accepted limitation of the local profile, not a defect: the gaps appear in
`ops:health` and the dashboard banner, and the store heals on the next run.
The per-job notes live in the plist headers (`scripts/launchd/`); note that the
installed copies under `~/Library/LaunchAgents` only pick up comment changes on
the next `install.sh`.

**A guarded catch-up slot was added on 2026-09-11** once the cost of the gaps
changed from "a stale report" to "a lost observation". Measured supply was **56 %**
(5 of 9 expected slots per lane since 2026-09-01), which against the measured
validation clocks meant ~13.3 months instead of 7.5 for Phase 5's verdict IC and
~8.4 years instead of 4.7 for Phase 4c's screen rank IC. `daily-catchup` runs at
**20:30 HKT** — after the HK close and deliberately *before* the US open, so the US
lane's newest bar is always a completed session (screening a partially formed bar
would poison the sample it protects) — and does nothing unless `ops:catchup` finds
a session newer than the newest `ScreenRun.sessionDate`. Exit 10 from the guard
means "behind"; any other non-zero means the guard failed and the script **does not
run**, because a blind run duplicates a session and inflates the accrual.

| Label | Runs | Schedule (HKT) |
|---|---|---|
| `daily-hk` | `scripts/daily-chain.sh hk` — `screen:daily --market hk` then `screen:deep-dive` (candidate breadth from `SCREEN_PARAMS.topN`) | Mon–Fri 16:50 |
| `daily-us` | `scripts/daily-chain.sh us` — same, US lane | Tue–Sat 06:10 |
| `weekly-sentinel` | `screen:sentinel --eastmoney` | Sun 08:47 |
| `weekly-f10` | `ca:f10-refresh` (F10 overlay for CA_DEGRADED / IN_SPECIE) | Sun 09:17 |
| `daily-catchup` | `scripts/daily-catchup.sh` — per lane, runs `daily-chain.sh` **only if** a session is unscreened (`ops:catchup`) | **20:30 daily** |
| `ops-health` | `scripts/ops-health.sh` → `ops:health` (health artifact + log; the user-facing signal is the dashboard banner, `GET /ops/health`) | 07:15, 17:30 daily |

### 5.2 Failure visibility (R0, 2026-09-10)

Built after three defects were found where the pipeline reported success while
work was silently lost — the 09-10 US deep-dive made 40 live calls, completed 4
of 10 verdicts, was killed, and left no trace at all.

**Exit codes.** `daily-chain.sh` reports the **worst** of its legs:
`0` clean · `2` screen failed · `3` deep-dive skipped (auth preflight) · `4`
deep-dive failed or partial · `5` post-condition health failed. Both legs always
run before the verdict, so a degraded screen never skips the deep-dive. The
CLIs back this up: `screen:daily` exits non-zero on a degraded lane, and
`screen:deep-dive` on **any** name failure (it previously required a 100 % lane
failure).

**Crashed runs are visible.** `DeepDiveRun.status` is `running` while a lane's
name pool is in flight and `complete` only after its reports are written. Every
read path filters to `complete`, so a crashed run can never render as a report
or appear in the picker — but the stale `running` row is what `ops:health`
alerts on (older than 2 h).

**The post-condition.** The chain ends with `ops:health --lane <L>`, the only
check that can catch a **killed** process, which reports no exit code of its own.
It is lane-scoped so a stale HK lane cannot fail the US chain.

**Health model.** Per lane: newest complete run, newest screen run, store data
cutoff, missed scheduled runs, and stale `running` rows. Cadence is
weekday-arithmetic from the plists (HK Mon–Fri 16:50, US Tue–Sat 06:10 HKT) with
**no** market-holiday calendar; 1 missed slot is **warn** (runs are
catch-up-on-wake by design, so "late" must not read as "broken") and 2+, a stale
`running` row, or an overdue weekly job is **alert**. Weekly jobs are judged from
dated artifacts (`sentinel-<date>.json`, `f10-refresh-<date>.json`), and when no
artifact exists yet the check is anchored on **when the job was installed** —
read from the plist's mtime, which `install.sh`'s `cp` makes the install instant.
Without that anchor "no artifact" cannot be told apart from "has never been
due": on 2026-09-11 the f10 job (installed 09-10 23:21, first slot Sun 09-13
09:17) reported ALERT, and since any job alert pins the whole report, the banner
was red for a job that had not yet been due and could not go green before 09-13.

**Arming.** `install.sh` uses `bootout`/`bootstrap`/`enable` and then runs
`scripts/launchd/verify.sh`, which **asserts each job's calendar stream is
`watching`** and fails the install otherwise. The deprecated `unload`/`load -w`
pair left the jobs loaded-but-unarmed on 2026-09-06 (no registration is logged at
install time; the first arming was an incidental domain event on 09-08), which
is why exactly one scheduled run fired in four days. A loaded-but-unarmed job is
invisible: `launchctl list` shows it and the plist is valid.

Caveat carried forward: the 2026-09-10 kill was **not** sleep (`pmset -g log`
shows a true wake at 08:31:22 and no sleep until 21:29:01) and left no crash
report; the user reports powering the machine off mid-run, which fits that. The
lesson does not depend on the cause: a killed process emits no exit code, so
detection has to come from the store (W1's post-condition) and the `running` row
(W2).

Caveat: the deep-dive LLM credential prefers the durable `LLM_API_KEY` from
`.env` (Moonshot platform key, added 2026-09-09) and falls back to the Kimi CLI's
**rotating OAuth token**. `daily-chain.sh` runs a cheap auth preflight first; on
failure it **skips the deep-dive leg loudly and exits 3** — never as success
(see §5.2). The deploy profile pinned `deepseek-v4-flash` until 2026-09-11, when it was
corrected to the catalog's current id `deepseek-flash` ("DeepSeek V4.1 Flash")
— see §7. The id is a deploy-time value, so it is re-checked at deploy rather
than assumed to hold.

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

*(Phase-2 planning 2026-09-06, spec in `docs/phase-2-plan.md` — all forks
locked: fundamentals analyst = eastmoney F10 statements, stocks only (ETFs
skip it); news = Google News RSS both lanes (CN+EN for HK) + Yahoo
supplement; structured output = prompt + strict validate + 1 repair round,
never `response_format`-dependent; breadth = the full candidate list + `--symbol`;
models = Kimi all-roles local, DeepSeek `deepseek-flash` on deploy —
`api.moonshot.cn` is measured-blackholed from AWS ap-east-1. Decision log =
`AgentDecision` table keyed by sha256(agent|model|promptVersion|system|user)
with byte-deterministic prompt builders as a tested invariant; reports =
`DeepDiveRun`/`DeepDiveReport`; orchestration = separate `screen:deep-dive`
CLI over the latest ScreenRun, per-name failure isolation, `--max-calls`
budget guard.)*

## 8. UI (apps/web)

*Status 2026-09-09: **3c shipped.** Historical-run browsing + indicator
overlays: `GET /reports/runs?market=&limit=&symbol=` (DeepDiveRun summaries,
symbol filter = runs with a DeepDiveReport for that name) and an additive
`indicators` field on `price-history` (sma50/sma200/mom20/mom60/mdd252/vol60
rolled over the full adjusted series, null-lookback points omitted). Web:
4-pane price chart (SMA overlays + momentum/drawdown/volatility sub-panes,
static legend) shared by `/symbol/[symbol]` and the chat `getPriceHistory`
card, and a shareable run-picker on the dashboard (`?hkRun`/`?usRun`) and
symbol page (`?run=`). Read-only everything; no new LLM surface.*

*Status 2026-09-08: **3b shipped.** Full tool-calling chat is live: Nest
`chat` module (in-process tools over `ReportsService`), persisted
`ChatSession`/`ChatMessage` (SQLite), event-level SSE
(`status`/`chunk`/`usage`/`done`/`error`), `AgentDecision agent="chat"`
audit logging ($0 exact-repeat cache hits). Web: `/chat` (session
picker/resume, markdown assistant text, inline tool cards — metrics table /
verdict card / mini price chart — cost header, cap notice) and SSE proxy
route handlers under `app/api/chat/` (the browser still never sees the api
origin). The 3a "no LLM path" invariant flips to **exactly one guarded LLM
path**: 20 LLM calls/session hard cap, 5-round tool-loop guard, read-only
tools, and 503-when-unconfigured isolation (chat env missing → only the two
LLM-touching routes 503; history and reports stay up).*

*Status 2026-09-07: **3a shipped.** Read API live: `GET /reports/daily`,
`GET /reports/deep-dive/:runId/:symbol` (apps/api `reports` module),
`GET /instruments/:symbol/price-history` (store-only read controller).
Web: `/` daily dashboard (HK + US lanes, integrity header, ranked
watchlist) and `/symbol/[symbol]?run=` (verdict card, lightweight-charts
adjusted-close + volume + CA markers, transcript accordion). All data via
server components + `API_INTERNAL_URL`; per-lane graceful degradation when
the api is down. 3b chat planned same day — spec in
`docs/phase-3b-plan.md` (Nest chat module, SQLite sessions, event-level
SSE, 20-call session cap, 5-round loop guard, read-only tools).*

*Ordering amended 2026-09-06 (phase-3-plan.md): **report-first, chat
second** — 3a ships the read-only report UI on a new read API; the chat
session (3b) lands on the same API afterwards, as full tool-calling chat.
Localhost-only in v1: the browser never calls the API directly — all data
flows through Next server components (`API_INTERNAL_URL`), so no auth and no
CORS. Until 3a the UI could never trigger an LLM call; 3b adds exactly one
guarded LLM path (see status note above).*

- **Daily report view** (3a): ranked watchlist per market with ratings,
  conviction, one-line theses, data-integrity header, per-name verdict card +
  price chart (adjusted close via `deriveAdjustedBars`, CA markers) + full
  debate transcripts.
- **Chat session** (3b): drill into candidates, challenge theses, compare
  tickers — tool-calling into the Nest.js API, with charts/tables rendered
  inline. Read-only tools, per-session call caps, cost display.

## 9. Explicitly out of v1

- Broker integration / order execution (manual trading)
- Intraday/real-time data (daily bars only)

*Carve-outs (2026-09-12).* Two entries were removed from this list because the code
outgrew them, and the list is a scope claim rather than a history:

- The **backtest engine** is no longer out of v1 — it shipped in Phase 4 (see the
  status note below), which is why it is no longer a bullet here.
- **"Portfolio tracking" excludes manual trade-journal attribution.** `journal:link`
  (`packages/quant-core/src/journal.ts`) reads an operator-supplied CSV, matches
  lots FIFO, marks open positions to market and reports each decision against the
  list it came from. That is analytics over recorded trades — no orders, no broker,
  no capital — so it does not open the execution line above. The distinction is
  narrow and deliberate: the moment code can *place* something, it belongs back on
  this list.

**Phase 4 commitment:** per Days 15/23, the screening rules are a *hypothesis*.
Once the picker has run for a while, backtest the screen itself and iterate —
the backtest module from Days 21–23 gets built there.

*Status 2026-09-10: **built and run.** Result: **H1 NOT SUPPORTED** — `h1_revised`
on both lanes. `docs/phase-4-plan.md`; runner `pnpm -C apps/api
backtest:screen` (`packages/quant-core/src/{replay,ic,portfolio,backtest}.ts`).*

*Design: the screen is tested **as shipped** (no tuning, no split) over
2022-09-08…2026-09-08 (US, 1003 sessions) and 2022-09-19…2026-09-09 (HK, 976),
replaying production `runScreen` point-in-time. Gate 1 (mean 20d rank IC ≥ 0.02
with Newey–West t ≥ 2) **decides**; Gate 2 (portfolio vs equal-weight benchmark,
cost sweep) only **falsifies**.*

*Measured:*

| lane | mean 20d IC | NW t | days | breadth | power floor | Gate 1 | Gate 2 |
|---|---|---|---|---|---|---|---|
| US | **+0.0145** | 0.97 | 983 | 180 | 0.0298 | FAIL | not falsified |
| HK | **−0.0192** | −0.78 | 898 | 25 | 0.0493 | FAIL | falsified |

*US portfolio +88.95 % vs equal-weight eligible benchmark +50.92 % (not
falsified; survives 2× costs at +24.98 %), but SPY returned +101.82 % — the
screen beat its like-for-like baseline and lost to simply holding the index.
HK portfolio +12.65 % vs benchmark +40.10 %, and −9.98 % at 2× costs, with
26.1× annual turnover against a 46 bp round trip — and since `turnover` already
counts both sides, the drag is turnover × per-side rate ≈ 6.0 %/yr (US 1.5 %/yr),
most of the differential on its own. (An earlier version said ~12 %/yr, which
double-counted the round trip.)*

***The bar's magnitude requirement is vacuous in both lanes, not "unpassable".***
Its power floor (US 0.0298, HK 0.0493) *exceeds* its own 0.02 requirement, because
the power analysis was calibrated against universe size (552/131) instead of the
actual **eligible breadth** after the gates (180/25). A true IC of exactly 0.02
gives US t = 1.34. The bar is *passable* — IC 0.05 would give US t = 3.36 and
HK t = 2.03 — but only at sizes that the 0.02 magnitude is irrelevant to, so Gate 1
degenerates into a pure significance test. (An earlier version of this section
said "unpassable", which was wrong.) So the FAIL is a statement about the *bar*,
not about H1 — the informative numbers are the measured IC and t. Correcting the
calibration and re-testing is a **new** pre-registration, not an edit to this one.*

***Also corrected 2026-09-11:*** *the cost drag quoted below as "~12 %/yr" for HK
double-counted the round trip. `turnover` is already defined both-sides
(`portfolio.ts`), so the drag is turnover × per-side rate: US 30.9 × 5 bp ≈ 1.5 %/yr,
HK 26.1 × 23 bp ≈ 6.0 %/yr. That is still most of HK's −27 pp differential, and it
routes to the portfolio rule and cost model, not to a score revision.*

*Reported, not gated:* US IC was +0.0185 / +0.0316 / +0.0343 in 2023/24/25 and
−0.0469 / −0.0208 in 2022/26 — regime-dependent, positive in the middle years.
US top-N-vs-rest spread was +0.83 % at 20d (60 % of days positive) and +2.19 % at
60d. **Retracted as stated (2026-09-11):** an earlier version of this paragraph
called that "economically meaningful while rank IC is weak". It is a *point
estimate with no interval*, and 60 % of days positive over ~49 effectively
independent days is a **z of about 1.4** — suggestive, not established, and judged
by the standard this same section applies to everything else. The direction is
consistent with a signal concentrated at the extremes rather than monotone across
the ranking, which is precisely why Phase 4b re-reported it with a proportional
cutoff and a Newey-West t (US 20d `t = 1.66` — still below 2).
The descriptive 9-combo weight sweep is monotone in both lanes: IC *falls* as the
mom60 weight rises (US 0.40 → 0.0199/0.0203/0.0190 vs 0.60 → 0.0103/0.0096/0.0078),
shipped ranks 5/9 (US) and 6/9 (HK), and the surface is a smooth plateau with no
isolated spike. **It may not be used to change `SCREEN_PARAMS`** without a new
pre-registered test on data excluding this window.*

***Changed 2026-09-11 (Phase 5 Fork A + the HK lane decision), and what it does
and does not invalidate.*** *`SCREEN_PARAMS.topN` became per-market and moved
15 → **40**, and a new `displayTopN` { US 10, HK 5 } decouples what the dashboard
presents from what is measured.*

*Why: at ~10 verdicts/day the LLM layer's per-day conviction IC has SE ≈ 0.33 and
20d labels overlap, so a modest IC of 0.10 was ~65 months of accrual away. At 40
per lane it is ~15. Measurement breadth is a **token-cost** decision (~18k tokens
and 7.7 calls per name, measured) while display length is a **product** decision,
and tying them forced a trade that did not exist. HK's display of 5 replaces a
fixed 15 that was **60 % of its ~25-name eligible universe** — not a ranking, which
is why its measured spread was indistinguishable from its own breadth.*

*What this does NOT change — stated because `SCREEN_PARAMS` is hypothesis H1:*
*`topN` truncates the **output**, not the score, so every Gate-1 ranking statistic
is identical at any value, and the backtest replays with the truncation lifted
entirely. The Phase-4/4b artifacts therefore still describe the shipped ranking.
Two things do change: the dashboard now shows 5 HK / 10 US rather than 10/10, and
the **HK Gate-2 falsification describes a 15-name portfolio** (`PORTFOLIO_TOP_N`,
an independent backtest constant) — so it falsifies that rule, not the 5-name list
now displayed. Re-testing the portfolio rule at topN 5 would be a new
pre-registration. `advFloor` is unchanged: the "widen HK's universe" option was
declined in favour of shrinking the list.*

*Status 2026-09-11 (Phase 4b, `docs/phase-4b-plan.md`): **the calibration was
repaired and the verdict re-labelled — `insufficient_evidence` on both lanes.**
No re-test: the window is spent for anything Phase 4's artifact already printed,
and Phase 4b only characterises it. Three results matter.*

***Both lanes are `insufficient_evidence`, not `h1_revised`.*** *Each lane's
detection floor (US 0.0298, HK 0.0493) exceeds the bar's own 0.02 magnitude, so
its FAIL cannot falsify the effect. The measured 95 % intervals are US
−0.016…+0.045 and HK −0.069…+0.030 — both contain 0 **and** the pre-registered
effect size. `h1_revised` is now reserved for a FAIL on a bar the lane could have
detected.*

***Gate 2's justification was an assumption, and is now a measurement.*** *The
claim "Gate 2 can never confirm (IR ≥ 0.985)" was withdrawn as unsupported and
then measured: the realized differential IR is **US 0.49** (NW t 1.19) and
**HK −0.59** (t −1.20) — neither reaches t = 2. So the asymmetric gate design
survives on evidence rather than assertion. The differential's interval is now
reported alongside the headline differential, which is a **different statistic**
(a difference of compounded returns, not the mean daily arithmetic difference).*

***Breadth is limited by the trend filter, not by liquidity — but the census
cannot price a gate relaxation.*** *`BEARISH_ALIGNMENT` (`close > sma50 > sma200`)
is the gate that **rejects first** for **81.2 % of US rejections** (301 names/day)
and 43.9 % of HK's; the US liquidity floor accounts for just 0.5 %. Post-gate
breadth of 180/552 (US) and 25/131 (HK) is therefore overwhelmingly a consequence
of the trend filter — the fact that determines both lanes' statistical power.
`LOW_LIQUIDITY` does bite in HK (29.4 %). **Limitation:** `runScreen` records only
the first failing reason, so this is "which gate rejects first", not "which gate
binds", and it cannot support "relaxing `BEARISH_ALIGNMENT` would raise US breadth
toward 552" — three other signal gates reject a further 16 %. The census field is
typed `basis="first_failure"` so the limit travels with the data.*

*Also re-reported descriptively: the top-N-vs-rest spread with a **proportional**
cutoff (`max(ceil(0.10 × breadth), 5)`) rather than a fixed top-15, since a fixed
15 is 8 % of US breadth but 60 % of HK's. HK's 20d spread moves +0.07 % → +0.76 %
(NW t 1.34) and US +0.82 % → +0.64 % (t 1.66 — the largest statistic in the
project, still below 2). **Descriptive only**; a gate needs a Phase-4c
pre-registration on data this window does not contain.*

***Reproducibility note:*** *re-running does not reproduce the 09-10 numbers
exactly — the store holds a rolling ~5-year window refreshed by `screen:daily`,
so the replay's warmup boundary advances with the run date (1003 sessions, shifted
two sessions). The 2026-09-10 artifact stays the reference for the pre-registered
verdict; `2026-09-10.ANNOTATION.md` records the re-labelling.*

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
   §4.3 weekly sentinel. *Limit found 2026-09-02: same-provider diffing also
   cannot see a defect that is stable inside one fetch — `3195.HK`'s stored
   series carries a +677 % seam (USD-counter prices written into the HKD
   history) that passes `yahoo-rewrite` because nothing changed between runs.
   That class needs an intra-series check (flat + zero-volume + local level
   break), which no provider choice substitutes for.*
6. **Free-source fragility** — the no-key sources we depend on throttle by IP,
   return 200-with-empty-body on bad request shapes, and change anti-bot rules
   (stooq is already PoW-gated). Mitigated by single-provider routing, loud
   typed outcomes, and the §4.1 probed-status table kept current. *Measured
   2026-09-02: the `push2his` refusal is burst- **and client-fingerprint** based
   (one `curl` of our exact provider URL returned 200 + 464 KB while `requests`
   and Node `fetch` were refused within the same minutes, and re-armed for all
   clients after ~12 more probes) — so a re-check must be a single request from
   the loader we actually ship, not a curl convenience.*
