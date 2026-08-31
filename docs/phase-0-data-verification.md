# Phase 0: Data Source Verification Plan

**Date:** 2026-08-31 · **Status:** Agreed plan, pre-execution
**Purpose:** Empirically verify that our planned free data stack can feed the
stock picker *before* scaffolding the monorepo. This is the Phase 0 gate from
`architecture-v1.md` §10, made concrete.

> **Revised 2026-08-31 (same day, after live probing):** gate **G2 was
> rewritten** — cross-provider *adjusted* closes cannot be compared at any
> tolerance (mean −12.3%, max **40%** divergence on HSBC); see §3.3, §4 and
> Appendix A. The routing table also lost its designated US fallback (stooq is
> proof-of-work gated). No change to the spike-first method or to G1/G3/G4/G5.

## 1. Context: what the design assumes

From `architecture-v1.md` §4: `yahoo-finance2` (npm, Yahoo v8 chart API) as
primary for US/HK/LSE, behind a Day-17 Reader/Loader interface with a typed
`DataOutcome` taxonomy (OK / GENUINELY_ABSENT / FETCH_FAILED) and a
declarative data-routing table.

**Decision (2026-08-31): free no-key sources only.** The routing table plans
for:

| Role | Source | Markets | Auth | Probed |
|---|---|---|---|---|
| Primary | `yahoo-finance2` (Yahoo v8 API) | US, HK (`.HK`), LSE (`.L`) | none | ✅ see A1–A3 |
| Repair only | eastmoney `push2his` | HK daily OHLCV | none | ✅ bars good · ⚠️ IP ban on bursts (A5) |
| Repair only | tencent `hkfqkline` | HK daily OHLCV | none | ✅ needs 5-digit code (A4) |
| ~~Repair only~~ | ~~stooq~~ | ~~US daily OHLCV~~ | none | ❌ PoW challenge page, not CSV (A6) |
| Later (Phase 2+) | Futu OpenD, IBKR | HK/US/LSE via user's brokers | local | — |

Explicitly dropped: Alpha Vantage as a bulk fallback (free tier ≈ 25
requests/day — per-ticker rescue at best), **stooq (HTTP 200 + JavaScript
proof-of-work challenge instead of CSV — see A6)**, akshare/tushare (A-share
scope excluded), any paid source for v1. **Decided: no free source is a
second daily feed** — Yahoo is the sole daily provider, the others are repair
and sentinel paths only (`architecture-v1.md` §4.3).

## 2. Known risks — status after probing (2026-08-31)

Source: `~/vendor/Vibe-Trading/agent/src/skills/{data-routing,yfinance}/SKILL.md`
plus the live probes in Appendix A.

1. **Yahoo is a weak HK source** — *partly refuted for bars, confirmed for
   corporate actions.* Vibe-Trading ranks yfinance last for HK, but that is
   Python `yfinance`'s scraping tier. The v8 chart API returned **1227 daily
   bars on `0005.HK` over 5y, raw closes within 0.27% of eastmoney, dates
   1226/1227 aligned** (A2). What is genuinely weak: Yahoo's HK **dividend
   amounts** are FX-converted (`0.783188`, `0.78378403` — 8 decimals, unequal
   between quarters, on an HKD stock) → risk re-scoped to CA data, measured by
   gate **G2c**.
2. **Yahoo IP-bans on aggressive loops** — *confirmed, and worse than "slow":*
   an immediate **429** on a long Chrome `User-Agent` where a short
   `Mozilla/5.0` returns 200 in ~130ms (A1). UA must be pinned inside the
   loader, not per call. Throughput still to be measured (§3.4, gate G4).
3. **HK ticker padding** — *confirmed and bidirectional*: Yahoo wants 4-digit
   `0005.HK`; **tencent wants 5-digit `hk00005`** and returns **HTTP 200 with an
   empty bar array** for the 4-digit form (A4) — a wrong request shape that
   looks like "no data exists". Per-source code normalizers, and this exact
   case mapped to `FETCH_FAILED` (bad request), never `GENUINELY_ABSENT`.
4. **Adjustment semantics** — *this was the biggest finding; it rewrote gate
   G2.* The issue is not `auto_adjust` on/off, it is that providers use
   different **arithmetic**: Yahoo is multiplicative (ratio-preserving, correct
   for returns), CN sources' 前复权 is additive (subtracts cash amounts, so it
   *inflates* returns — +590.8% vs +369.9% over 5y on HSBC — and can go
   negative on long windows). **Adjusted prices from different providers are
   not comparable at any tolerance.** Resolved by invariants **R1–R4**
   (`architecture-v1.md` §4.2): store raw + events, adjust locally, never
   compare or splice adjusted series across sources. The UCITS lane still needs
   dividend events (accumulating vs distributing) — see A3.
5. **LSE GBX trap** — *still open, but de-risked for our list:* `CSPX.L` comes
   back `currency: USD` (it is a USD-accumulating share class) with **0 dividend
   events**, so its adjustment is the identity. The trap mostly threatens
   GBP-quoted UK *ordinaries*, which are not in the UCITS lane. `meta.currency`
   must still be asserted per instrument (gate G3, 5 tickers).
6. **Error taxonomy correctness** — *unresolved by probing, and the probes
   surfaced a new hazard:* HTTP **200 + empty body** (tencent) is neither a 429
   nor an absent symbol, and eastmoney answers a 6th rapid request by dropping
   the connection outright (A5). Both must map to `FETCH_FAILED`; G5 gains those
   two probes.

## 3. Method: spike first, scaffold second

A throwaway single-file TS script (`tsx` + `yahoo-finance2`), run manually.
No monorepo, no Nest.js — answers in an afternoon. If gates pass, the spike's
check functions become the seed of `packages/quant-core`'s data-quality module.

**Decided (2026-08-31):** spike deps live in a **throwaway gitignored `spike/`
dir** with its own `package.json` — a root `package.json` must not become the
back door into monorepo scaffolding before the gates pass.

### 3.1 Stratified sample (~30 tickers)

| Stratum | Tickers | What it tests |
|---|---|---|
| US mega | AAPL, MSFT, NVDA | baseline quality |
| US ETF/index | SPY, QQQ, ^GSPC | ETF + index handling |
| US mid-liquidity | PKG, FDS, SLGN *(SLGN replaces RYL — RYL is defunct, Ryland merged 2015; found by the spike)* | adjustment consistency |
| HK blue chips | 0700.HK, 9988.HK, 0005.HK | 4-digit padding, HK calendar |
| HK ETF | 2800.HK (Tracker Fund) | HK ETF data |
| HK edge | 2 lowest-turnover HK names, picked by the spike at runtime from a small candidate list (choice logged in the report) | absence vs failure typing |
| LSE UCITS | CSPX.L, VUAA.L, VWRA.L, ISAC.L, EIMI.L | GBX/GBP trap, currency, adjustments |
| Invalid/delisted | `NOSUCHTICKER` (fake), `TWTR` (delisted 2022) | error taxonomy |

### 3.2 Automated checks per ticker (Day-17 checklist)

- Bar count vs expected trading days (per-market calendar, ~1y + ~5y windows)
- Date gaps (missing sessions), duplicate timestamps
- Zero-volume days (halted vs data hole)
- Stale last bar (last bar date vs market's last trading day)
- OHLC sanity: H ≥ L, H ≥ O,C; non-positive prices
- Single-day |return| > 20% outliers → flagged for manual eyeball
- Adjustment continuity (auto_adjust on vs off ratio is smooth except at
  dividend/split events)
- Currency field per instrument (catch GBX)

### 3.3 Cross-source validation — **convention-free quantities only** (R4)

Per the data-routing skill's "verify material figures across ≥2 sources"
discipline, but with the comparison restricted to things that are comparable.
**Do not compare adjusted closes across providers** (§2 item 4, A2): it fails
legitimately, on 86% of HSBC's bars, at any tolerance.

- **Raw close** — Yahoo vs eastmoney (HK) / Yahoo vs tencent (HK) / US has **no
  second source left** after stooq was dropped → US cross-check degrades to
  Yahoo-internal consistency plus the §4 G2d unit test. Tolerance: ≥99% of
  aligned bars within 0.1%, none beyond 0.5%; report max deviation + dates.
  (Measured baseline: mean 0.00%, max 0.27%.)
- **Session-date index** — identical trading dates ≥99.5%; every mismatch
  classified halt / typhoon closure / provider hole with a named reason. Also
  measure each source's **max window per call** (tencent capped at 1200 bars).
- **Corporate-action events** — ex-dates within ±2 sessions on ≥90% of events;
  amounts within 1% **only for USD names** (Yahoo FX-converts HK dividends, so
  a HKD amount comparison measures Yahoo's FX rounding, not the provider).
- Deviation beyond band → ⚠️ logged with both values; never silently pick one.
- **Our own adjustment code** is validated against Yahoo's `adjclose` (same
  provider ⇒ conventions do match): must agree ≤0.05%. This tests our math, not
  the feed.

### 3.4 Rate-limit probe

- Fetch 100 tickers sequentially with 200ms spacing; record per-request
  latency, 429/failure counts. Use the pinned short `User-Agent` (A1) — a long
  UA 429s immediately and would make the measurement meaningless.
- Extrapolate to the ~800-ticker universe: total wall time must be minutes,
  not hours, with zero 429 storms. This fixes the throttle defaults for the
  real ingestion module and the two daily run windows.
- Same probe for the repair paths, which are more fragile than the primary:
  eastmoney bans the IP after ~5 requests at 0.35s spacing (A5) → find the
  actual safe rate with ≥2s + jitter; tencent's 1200-bar cap per call → how many
  calls for a 5y backfill.

## 4. Acceptance gates

| Gate | Criterion | If failed |
|---|---|---|
| **G1** | ≥98% of liquid-universe sample fetches clean (OK) on a normal trading day, **and ≤1 failure per market lane** (decided 2026-08-31 — 1 failure in a 30-ticker sample is 96.7%, so a lane-specific problem must not hide in the overall average) | Yahoo demoted for that market; routing table promotes **eastmoney/tencent** (HK) to primary — and note that a demotion triggers R1's "adjust ourselves" clause immediately, since two providers must then coexist |
| ~~**G2**~~ | ~~cross-source adjusted-close deviation <1%~~ — **withdrawn 2026-08-31**: not a valid test (A2). Replaced by G2a–G2d | — |
| **G2a** | Raw close vs alternate source: ≥99% of aligned bars within 0.1%, none beyond 0.5% | Investigate the specific dates/bars before any screening code; a systematic offset means the wrong instrument or an unhandled currency/tick convention |
| **G2b** | Session-date index identical on ≥99.5% of bars, every mismatch explained | Fix the market-calendar / halt handling in the loader before screening |
| **G2c** | CA events: ex-dates within ±2 sessions on ≥90% of events; amounts within 1% for USD names | **No hard fail** — this *is* the measurement of Yahoo's HK corporate-action quality; a bad result promotes R1's local-adjustment dependency to a blocking item and may move the HK lane to eastmoney for events only |
| **G2d** | Our locally derived adjusted series matches Yahoo's `adjclose` within 0.05% | Bug in our adjustment code — fix before anything consumes a series |
| **G3** | LSE GBX/GBP detected and normalizable (scale + `meta.currency` confirmed for all 5 UCITS ETFs) | Normalizer gains explicit GBX handling; UCITS lane blocked until fixed |
| **G4** | 800-ticker extrapolated run fits rate limits without 429 storms | Reduce batch rate, add jitter/backoff, or split universe across sources (with no-splice R3 and whole-series re-derivation) |
| **G5** | Error taxonomy: invalid→GENUINELY_ABSENT, forced-429/timeout→FETCH_FAILED, **HTTP 200 + empty bar array→FETCH_FAILED (bad request shape)**, **connection-dropped→FETCH_FAILED**, 100% of probes | Fix typing before anything downstream is built |

## 5. Outputs

1. `docs/phase-0-verification-report.md` — per-stratum findings, gate
   pass/fail verdicts, measured throughput, cross-source deviation table.
2. The spike script kept at `scripts/data-probe.ts` (or deleted after its
   checks are ported into `packages/quant-core` — decide at Phase 1).
3. Updated data-routing table in `architecture-v1.md` §4 if any gate changes
   source priority.

## 6. Explicit non-goals

- No intraday data (v1 is daily bars only)
- No fundamentals/news ingestion (Phase 2 concern; noted that Yahoo
  quoteSummary covers basic fundamentals, EDGAR covers US filings)
- No monorepo scaffolding — that happens after the gates pass

## Appendix A — pre-spike probe results (2026-08-31)

Throwaway probes, now kept in-repo and reproducing every number below
(stdlib-only python3, no API key):
**[`probes/adjustment-convention.py`](./probes/adjustment-convention.py)** —
run `python3 docs/probes/adjustment-convention.py` (add `--no-eastmoney` while
eastmoney's IP ban is in effect). Verified 2026-08-31: it re-prints the A2/A3
figures exactly. The `tsx` spike inherits its check functions.

**A1 — reachability / UA.** `query1|query2.finance.yahoo.com/v8/finance/chart/
AAPL?range=5d` → **200 in 130ms** with `-A "Mozilla/5.0"`; the same request with
a full Chrome UA → **429 Too Many Requests** on the first call of a script.

**A2 — adjustment-convention divergence, `0005.HK` HSBC, 5y daily.**

| | 2021-08-31/10-18 | 2026-08-31 | mean dev | max dev | bars >1% |
|---|---|---|---|---|---|
| Yahoo raw | 41.45 | 161.00 | — | — | — |
| Yahoo `adjclose` (×Π(1−D/P)) | 30.74 | 161.00 | — | — | — |
| tencent `qfq` (additive) | 23.31 | 161.00 | **−12.31%** | **40.16%** | **86%** |
| eastmoney `qfq` (additive) | 18.91 | 161.00 | −12.96% | 44.72% | — |
| **eastmoney raw** | 41.80 | 161.00 | **−0.00%** | **0.27%** | 1 bar |

5y total return on the same stock: **Yahoo +369.9% vs tencent qfq +590.8%**
(220pp). Rolling 20d momentum error: median 0.97pp, p95 **10.84pp**, max 21.4pp.
Mechanism proof: Yahoo's Σ dividends = **22.89**/share and eastmoney's
`raw − qfq` at the oldest bar = **22.89** (exact) ⇒ additive; Yahoo's factor is
0.7417 ⇒ multiplicative. Reconstructing an additive series from Yahoo's own
event list predicted **−39.6%** divergence where eastmoney measured **−39.0%**
⇒ local derivation is feasible from Yahoo's event data.

**A3 — low-yield and UCITS controls.** `0700.HK`: cumulative div 3.9% of oldest
price, adj-vs-qfq mean −0.73%, **max 9.19%**, 40% of bars >1%, error peaking at
the 2022-10 price trough; total return agrees to 1.95pp. `MSFT`: 5.0% cumulative,
max 2.8%. `CSPX.L`: **currency USD**, 0 dividend events, adjustment is the
identity, 1261 bars.

**A4 — tencent HK.** `fqkline?param=hk0005,...` → HTTP 200, `day: []` (**empty,
looks like "no data"**). `hkfqkline?param=hk00005,day,,,1200,qfq` → 1200 bars, key
`qfqday`, fields `[date, open, close, high, low, volume]`, latest close 161.00.
So: 5-digit code, HK-specific endpoint, and `fq=""` yields a differently-shaped
response (`data: []`) rather than raw bars. ≤1200 bars per call.

**A5 — eastmoney throttling.** `push2his.eastmoney.com` returned excellent HK
bars (`fqt=0/1/2` = raw/前复权/后复权) for ~5 calls, then **closed the connection
without a response** (`RemoteDisconnected`) for the remainder of the session —
consistent with its skill's warning about per-IP burst bans. `fqt=2` (后复权) is
anchored at the *oldest* price (398.94 today vs 161.00 raw) — a third convention,
also unusable for signals.

**A6 — stooq is not usable.** `stooq.com/q/d/l/?s=msft.us&i=d[&a=1]` returns
**HTTP 200 + an HTML page** containing a JavaScript SHA-256 proof-of-work
challenge (`c="AAAA…"`, difficulty 4 leading hex zeros, `POST /__verify`, then
reload). No CSV without executing JS. Hence dropped from the routing table;
the US lane therefore has **no free second source for cross-checks** in v1, which
is the strongest argument for G2d + R1 rather than a substitute for them.
