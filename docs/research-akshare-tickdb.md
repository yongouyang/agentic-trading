# Research: AKShare and TickDB as HK/US market-data providers — 2026-09-02/03

**Question:** are AKShare and TickDB feasible market-data providers for the HK and
US stock + ETF lanes?

**Answer:** **neither is feasible for v1, for opposite reasons — and the probe
found a live defect in our own store on the way** (§4, root-caused and
confirmed four ways: `3195.HK`'s oldest 72 bars are USD-counter prices written
into an HKD series, giving the stored series a phantom **+677 %** one-day step).

| | verdict | decisive measured fact |
|---|---|---|
| **AKShare** | ❌ not a v1 dependency · ✅ valuable as an *endpoint map* | HK/US stocks **and ETFs**, free, no key, far deeper than Yahoo (HSBC from 1998, `AAPL` from 1984, `SPY` from 2001) — so §4.1's "A-share scope excluded" line was **wrong about coverage**. But every HK/US bar route is a host we already characterised: eastmoney `push2his` (refused 9/9 calls tonight) or sina (obfuscated payload, as-traded basis), and the library is Python in a pure-TS stack (§3) |
| **TickDB** | ❌ not feasible; do not pay | Free tier = 72 symbols + ~1 calendar year (`3007 … kline_history_years_limit: 1`) on a **globally shared** trial key; $99/299/899 mo⁻¹ for 1/3/10 y. **The API exposes no dividend or split endpoint and no `adjust` parameter** ⇒ §4.2 R1 (store raw **+ events**) is unsatisfiable at any tier. And where testable its closes match ours at **0.0000 % median** — same numbers, not a second opinion |
| **Yahoo (primary)** | unchanged, with one named hole | Still the only free, no-key, both-lane feed whose raw series is usable end-to-end for signal math. §4's counter-splice is a Yahoo-side artifact we must now detect ourselves |

Everything below was measured live from this machine. Re-runnable artifacts:
`/tmp/ak_test{,2,3,4}.py`, `/tmp/hk_audit.py`, `/tmp/convention.py`,
`/tmp/td_probe{2,3,4,5}.py`, `/tmp/reach2.mjs`, `/tmp/tsreach.mjs`; results in
`/tmp/ak_results*.json`, `/tmp/hk_audit.{csv,json}`, `/tmp/hk30_dev.json`,
`/tmp/level_vs_returns.csv`, `/tmp/td_quality*.json`, `/tmp/td_catalog.json`.

---

## 1. TickDB — measured, not just read

`tickdb.ai` / `api.tickdb.ai` / `docs.tickdb.ai`; repo
`TickDB/tickdb-unified-realtime-marketdata-api` (746★, MIT, created
**2026-01-11**, last push 2026-06-20) contains docs + Skill + a Python MCP
server; the data service itself is closed. Symbol forms `700.HK` / `AAPL.US`;
the catalogue itself uses bare `2800`, `SPY`, `5`.

**Coverage is real, and includes ETFs.** Catalogue (fetched completely, 19
pages): 42,303 products — HK **3,543**, US **14,169** (**5,479** US names contain
"ETF"; `SPY`/`VOO`/`QQQ` present), CN 9,183, GLOBAL 15,408. Matched against the
project's own instruments: **131/131 HK and 562/564 US** (misses `BRK-B`,
`BF-B`). HK ETFs `2800` 盈富基金, `3195` 恒生标普五百, `3032`, `3067` are all
catalogued — **so the "TickDB is HK-equities-only" reading of its docs is wrong;
ETFs are there, typed `stock`** (there is no `etf` product type, so
"is this an ETF" is not answerable from the API).

**The free tier cannot serve any part of v1** (all measured, trial key from
`GET /api/public/claw-keys`):

| probe | result |
|---|---|
| `interval=1d&limit=1000` | `3007` `Historical kline query exceeds your plan's time range limit` — `earliest_allowed: 2025-01-01`, `kline_history_years_limit: 1`, `plan: free`; a whole-request rejection, not a clamp |
| `limit=500` | succeeds → ~500 daily bars (2 y) |
| `SPY.US`, `VOO.US`, `2800.HK`, `3195.HK` | `3006 restricted_symbols` — **every ETF is plan-gated** |
| `99999.HK`, `0000XX.HK` (nonsense) | also `3006` ⇒ **existence is indistinguishable from gating**; ETF coverage is unverifiable without paying |
| rate limit | `3001 {"limit": 30, "plan": "free"}` — the trial key is **one global key shared by every agent** installing their Skill; ~10 calls saturated it, and 40 rapid calls returned 1 success / 11 throttles; ~50 probes drew `HTTP 403` from the edge |
| auth | no key → `429/3001` (not `401`); wrong key → `401 [1001] Invalid or expired token` |

**No corporate actions, anywhere.** All 13 paths enumerated from their
`openapi.yaml` (ticker, kline, kline/latest, depth, trades, symbols, intervals,
intraday, trading-sessions, trade-days, stock-info, calc-index, capital-flow):
**no dividend or split endpoint, no `adjust` parameter**; the only dividend data
is `dividend_yield` / `dividend_ratio_ttm` snapshots. Against §4.2 that is
disqualifying independently of price: R1 persists raw **+ events** and derives
adjusted locally, so a source with no events cannot *be* the store — it can only
dump bars, which R3 then forbids mixing in.

**Quality, where testable, equals Yahoo's exactly.** 19 trial symbols vs the
store's Yahoo-sourced bars (2024-08 → 2026-09), after fixing the timestamp
convention in §1.1: median |close deviation| **0.0000 %**, 98.8–100 % of bars
within 0.01 %, worst single-bar gap 0.30–0.67 % (HK) / ≤0.005 % (US), and
**volumes identical to the unit** (`0700.HK` 2024-08-20: 11,852,608 in both).
That is not a validation win — it says TickDB resells the same upstream, so
paying it duplicates the series we already distrust rather than checking it.
The one mismatch found is diagnostic of §2.3: `NFLX.US` sits at ratio **10.0**
before 2025-11-17 and **1.0** after — TickDB serves *as-traded* history, Yahoo's
`close` is retroactively split-adjusted.

### 1.1 Traps a TS integration would have to encode

- **Daily bars are stamped at exchange-local midnight, in UTC ms.** The HK bar
  `1788278400000` is 2026-09-01 16:00 UTC = **09-02 00:00 HKT**. Joined on the
  UTC date, *every HK bar lands one session early* — that is exactly the 1.9 %
  median "deviation" my first pass reported, which vanished under a +8 h relabel.
  `intraday` timestamps, by contrast, are true UTC (09:30 HKT → 01:30Z ✓). Mixed
  convention inside one API; their data spec says only "all timestamps are in ms,
  UTC-based". Any L1-style alignment gate must therefore know each market's zone.
- **`kline` serves a forming bar.** Docs say "completed periods … fixed and will
  not change"; measured at 14:27 UTC it returned an `AAPL.US 2026-09-02` bar with
  7,999,087 shares (final settled value: 53,167,388). A store write needs a
  session-closed clamp.
- **As-traded, not split-adjusted** (§2.3) — the opposite basis from our store.
- **Docs/impl drift:** `trade-days` rejects the documented `start_time/end_time`
  and demands `beg_day/end_day` (`2001`).

### 1.2 Price vs need

| tier | price | history | rate |
|---|---|---|---|
| Free trial | $0 | ~1 year (measured), 72 symbols | 30/min, globally shared |
| Starter | $99/mo | 1 year | 60/min |
| Professional | $299/mo | 3 years | 600/min |
| Enterprise | $899/mo | 10 years | 1800+/min |

A 5-year, ~695-instrument store ⇒ Enterprise ≈ **$10.8k/year** to obtain a
duplicate of Yahoo's numbers with no event data. Not a Phase-4 candidate either:
IBKR/Futu (§4.1) at least carry entitlements and events. **Recommendation: close
this line.**

---

## 2. AKShare — coverage is broad; the routes are hosts we already rejected

`akshare` 1.18.94 (MIT, 22,377★, pushed 2026-09-02, 5 releases in 3 weeks). Very
active — and that cadence *is* the fragility signal: it is a collection of
scrapers over public CN portals, and its interfaces break when those portals
change. It carries no licence for redistribution and no SLA.

### 2.1 HK/US bar routes, measured today

| route | underlying endpoint | result |
|---|---|---|
| `stock_hk_hist` / `stock_us_hist` / `fund_etf_hist_em` | `33./63.push2his.eastmoney.com` — **the banned host** | ❌ **9/9 `RemoteDisconnected`**, first request, ≥3 s spacing, browser UA. Same IP block as §4.1's repair row; akshare inherits it and adds nothing |
| `stock_hk_daily` / `stock_us_daily` | `finance.sina.com.cn` | ✅ **131/131 HK + 40/40 US store instruments, 0 failures**, ~1.2–1.9 s/name; one request returns the *entire* listed history |
| sina universe | `Market_Center.getHKStockData` | ⚠ 2,798 HK names in **99 paged requests**, **no ETFs** (`02800`/`03195` absent) → cannot drive ETF universe discovery. US equivalent (`get_us_stock_name`) needs **904** paged requests ≈ 15 min — impractical |

sina depth, one request each: HSBC `00005` **6,965 bars since 1998-06-01**;
`00700` 5,464 since 2004; `AAPL` 10,023 since 1984. **ETFs:** `02800` 6,583 bars
since 1999, `02828` since 2003, `03110`/`03188`/`03147`/`03032`/`03033`/`03067`/
`09633`/`03195` all present; `SPY` 6,453 since 2001 plus `QQQ`/`VOO`/`ARKK`/`TLT`/
`AGG`/`KWEB`/`EFA`/`SCHD`/`SOXX` — **21/21 ETF probes returned data**.

So the §4.1 dismissal "akshare/tushare (A-share scope excluded)" is **wrong about
scope**: HK and US stocks *and* ETFs are covered, with history far deeper than
Yahoo's. The exclusion holds for other reasons — stack constraint (§3),
convention mismatch (§2.3), and one of its two hosts being the already-banned
one. §4.1 corrected accordingly.

**Bulk shape:** ~1.5 s/name at ~1 s pacing ⇒ a 695-instrument pass ≈18 min, one
request per instrument for full history. Attractive — and the same shape Yahoo
already gives free, so it buys *redundancy*, which §4.3 explicitly rejects.

### 2.2 Portability to TypeScript is not the blocker; the dependency is

We do not need akshare. Probing its endpoints from Node `fetch` directly
(`/tmp/reach2.mjs`, no proxy): **7/7 reachable** — sina HK bars (200, 86 KB),
sina HK ETF bars (200, 77 KB), sina US bars incl. `SPY` (200, 75 KB), sina HK +
US factor files (200), eastmoney F10 dividends (200, 6.8 KB), eastmoney F10
balance sheet (200). Only `push2his` refused (`UND_ERR_SOCKET`).

The sina bar payload is obfuscated (`var KLC_K2_00005="K2/3L9/9…"`); akshare
decrypts it with an embedded ~18 KB reverse-engineered sina JS function. I
extracted that blob and ran it under Node `vm`: **6,965 bars decoded,
1998-06-01 → 2026-09-02, ~50 ms**. So a TS `sina.provider.ts` is a day's work —
vendoring an obfuscated third-party decoder whose rotation is out of our control.
Recorded as an escape hatch if Yahoo's free tier ever tightens; not adopted.

### 2.3 Where akshare earns its keep: F10 events and statements, on an unbanned host

`datacenter.eastmoney.com` is a **different service** from the banned kline host:
12/12 calls at ~1 s spacing, ~0–100 ms, 200 from Node too, no refusal observed.

- **HK dividend events with declaring currency *and* HKD equivalent.**
  `stock_hk_dividend_payout_em('00005')` → 94 rows back to 1999, latest
  `每股派美元0.1元(相当于港币0.784234元(计算值))`, ex `2026-08-13`, paid
  `2026-09-25` — vs the store's Yahoo row for that date (`0.784211 HKD`, 0.003 %
  apart, and Yahoo's value is the one that drifts run-to-run). `01211` carries
  RMB→HKD (`每股派人民币0.358元(相当于港币0.41141元)`) **and the bonus/conversion
  terms** (`每10股派送8股,每10股转12股`); `0941` 52 rows; `01810` 0 (pays none).
  → This is exactly the "HKD-native amount + visible declaring currency" §4.1
  defers to Phase 2, and it speaks to the two `CA_DEGRADED` names (`0005`,
  `1211`). **The 2026-09-01 rejection of "eastmoney for events" was aimed at the
  banned host, not this one** — re-open it on its merits.
- **HK/US three statements + indicators** (`stock_financial_{hk,us}_report_em`,
  `…_analysis_indicator_em`): `00700` balance/income/cash-flow = 1,124 / 585 /
  966 rows; `TSLA` 537/525/1,654; `NVDA` quarterly cash-flow 2,005. The
  Piotroski/earnings depth Phase 2 needs, free, no key.
- **Gaps:** **no ETF records at all** (`02800` → dividends 0 rows, indicators
  `TypeError`) → ETF distributions stay a Yahoo-only capability; no US
  dividend/split feed; xueqiu US profile needs a login token; baidu US valuation
  endpoint broken (`JSONDecodeError`).

### 2.4 sina's adjustment files, measured — and why §4.2's rule survives with a fix

- sina **HK `qfq` is multiplicative**: over 1,227 bars the store/sina pair yields
  53 stepwise-constant ratios vs 995 varying differences; 5-y TR
  **420.2 %** vs our raw+events derivation **428.6 %** (and raw price TR 293.2 %).
  So HK is *not* the additive convention §4.2 asserts for all CN sources.
- sina **US `qfq` is additive**: `AAPL` shows 20 distinct differences vs 1,114
  ratios; TR 119.9 % vs 113.2 % price. `hfq` is the CN hybrid
  (`close × factor + cash`, visible verbatim in akshare's source).
- **HK ETFs have no factor file at all** (`02800`/`03032`/`03195` → HTTP 404;
  akshare then silently returns raw): ETF `qfq` TR = price TR (−2.8 %) vs our
  +14.5 % from 10 Yahoo distribution events.

Net: §4.2's "never consume a CN adjusted series" is still right, but its stated
reason is wrong. **Conventions vary by market and asset class *inside one
provider*** — that is a stronger reason than "CN sources are additive", and it is
now recorded as such.

---

## 3. Cross-source quality: sina vs the store, whole HK lane + US sample

131 instruments × 1,226 bars = **154,895 comparisons** (sina raw close vs stored
Yahoo raw close, 5 y window):

| metric | value |
|---|---|
| date overlap ≥99.5 % | **124/131** |
| names with median \|deviation\| exactly 0 | **130/131** |
| name-days deviating >0.5 % | 2,082 / 154,895 (**1.34 %**) |
| names with **zero** deviating days | 36/131 |
| names with a **persistent >2 % block** | **5/131** (`0700` `1211` `2836` `3195` `7226`) |
| store bars with no sina counterpart | 345 (0.22 %) |
| US sample (45 names) flagged | **10/45** with >3 deviating bars |

Two exception classes, needing different handling:

1. **Basis difference at corporate actions (benign, systematic).** Yahoo back-
   adjusts `close` for splits, bonus issues and distributions-in-specie; sina,
   eastmoney `fqt=0`, tencent and TickDB serve **as-traded**. Exact measured
   factors: `1211.HK` 0.3333 for 921 bars ending at BYD's 2025-06-10 bonus ex-date
   (store 132.20 vs sina 396.60; both 135.60 from the next session);
   `WMT` 0.3333 before 2024-02-26; `ISRG` 0.3333; `SMCI` 0.1; `UNG` 4.0;
   `XLU`/`XLB`/`SMH` 0.5; `NFLX` 10.0 (TickDB); `0700` 0.92186 → 0.94978 → 1.0
   across Tencent's two in-specie distribution ex-dates (2022-01-20, 2023-01-05)
   — **which appear in no event row Yahoo publishes** (its event list for 0700 has
   5 cash dividends and no splits). Consequences: (a) §4.2 R3's no-splice rule now
   has a *raw-layer* justification, not just the adjusted-series one; (b) any
   cross-source **level** comparison will fire on ~4 % of HK and ~22 % of US
   names for convention, not corruption — so workstream B's `eastmoney-raw` check
   (ALARM at max |dev| > 1 %) needs to be **return-based or CA-excluded before
   its first live run**; (c) the return-mismatch rate after that change is
   measured: 259 of 23,125 name-days = **1.12 %**.
2. **Date-correlated session-boundary noise (real, predictable).** Even with no
   corporate action, the same dates deviate across many names: **2025-12-31
   11/15 names, 2024-12-31 8/15, 2026-02-16 8/15, 2025-01-28 7/15, 2024-12-24
   7/15, 2025-12-24 6/15** — HKEX pre-holiday half-day and year-end sessions,
   0.15–0.45 % each. A cross-source leg must carry a half-day exclusion or its
   mean-threshold will fire on calendar convention. (`2800.HK` was clean on
   every date — max 0.13 % — so the pinned sample's G2d baseline is unaffected.)

Freshness is **not** a Yahoo advantage: sina carried today's HK close
(`00005` 162.6 on 09-02) while the store still ended at 09-01, and both Yahoo
and sina showed the *same partial* US bar (store `AAPL` 09-01 = 321.695 / vol
7.46 M, vs sina and TickDB 325.13 / 53.17 M settled) — i.e. our own
mid-session write, not a provider gap. Value-comparing the last bar is what
catches that class.

---

## 4. Store defect, root-caused: `3195.HK`'s oldest 72 bars are USD-counter prices stored as HKD

Found while cross-checking; confirmed four independent ways. This is a *price*-
layer currency mix-up **inside the primary provider** — the same family as the
`adjclose` bug already recorded in §4.1, but in the raw series the store is
built on, so §4.2's R1 basis ("stored raw is split-adjusted as delivered") does
not currently hold at the store boundary for this instrument.

1. **The stored series has an 8× seam.** `2024-04-29 … 2024-08-07`: closes
   1.0298 → 1.0459, every row **flat** (`open = high = low = close`) with
   **`volume = 0`** — 72 rows. Then `2024-08-08` closes **8.13** with real volume
   (22,000): a **+677 % one-day jump inside our own series**, invisible to all
   four shipped checks.
2. **Two independent sources are continuous there.** sina `03195`: 8.725
   (08-01) → 8.175 (08-05) → 8.260 (08-07) → 8.130 (08-08). tencent `hk03195`:
   8.695 (07-19) → 8.725 (08-01). They agree with each other, and with Yahoo
   *after* 08-08; only Yahoo's pre-Aug block is ~8× low.
3. **The 8× is the HKD peg, not a unit consolidation.** Over exactly those 72
   rows, `sina / store` = **7.826 ± 0.058** (min 7.738, max 8.090) — USD→HKD.
4. **The USD counter exists and reconciles.** `9195.HK` (same fund, USD counter)
   returns `currency=USD`, close **1.552**, against `3195.HK` `currency=HKD`
   **12.17** — 12.17 / 7.85 = 1.55 ✓. Yahoo stitched the USD counter's early
   history into the HKD counter's series.

**Blast radius (local census, no network):**

- Flat rows (`O=H=L=C` **and** `volume=0`) in the store: **1,672 HK + 347 US**.
- Of those, only **7 rows across 5 instruments** also break the local level by
  >10 %: `3195.HK` (the 72-row prefix block, ×7.8 ⇒ this defect), `2836.HK`
  (2 rows, ×2.1, same shape, needs adjudication), `2269.HK` (2), `0020.HK` (1),
  `0881.HK` (1), `2846.HK` (1, ~10 %).
- Flat alone is **not** the signal: `2819.HK` has 363 flat rows (62 % of its
  history) and `3074.HK` 222, and both match sina at ratio **1.000** — genuine
  thin/halted sessions. The triage is `flat AND level-break`, never `flat`.
- 18 names hold a >40 % one-day jump (29 rows); some are real (`MRNA`, `GL`,
  `MNST`), the ETF seams are this class.
- Multi-counter HK ETFs are the exposed population: the `9xxx` (USD) and
  `83xxx`/`8xxx` counters of the same funds. `0066.HK`/`0012.HK` style
  dual-counters too. Worth a census before HSCEI/ETF universe work (§4.3 scope).

**Why nothing we ship sees it:** `yahoo-rewrite` is same-provider (a stable seam
passes); `tencent-dates` compares dates only; `ca-revision` compares event dates;
`eastmoney-raw` is opt-in and would fire, but its level rule would *also* fire on
the §3.1 convention cases. The detector that works is intra-series and cheap.

**Proposed fix (small, R1-aligned, no new dependency):**

1. **Sentinel check 5 — store-integrity, intra-series:** any bar with
   `volume = 0 AND open = high = low = close AND |close/prev_close − 1| > 10 %`
   → ALARM quoting the implied ratio; a ratio in the 7.7–8.1 band is diagnostic
   of USD/RMB-counter stitching and can be named in the verdict, any other ratio
   is a halt or a split needing adjudication. Costs no requests (pure store
   query), so it can run on every screen, not just weekly.
2. **Repair `3195.HK`:** drop or convert the 72 affected rows (sina and tencent
   both carry the correct HKD level and agree with each other), then re-derive
   its adjusted series. Until then its long-window features encode a 677 % gain
   that never happened — and `3195.HK` is one of the 10 pinned sentinel names and
   the §4.1 CA_DEGRADED example.
3. Census the other multi-counter HK ETFs for the same seam before expanding the
   universe.

---

## 5. Honest accounting: what the probing cost

- **The eastmoney block is burst- and client-fingerprint based, not a clean IP
  timeout, and I re-armed it.** At 21:35 a single `curl` of *our own* provider URL
  returned **HTTP 200 + 464 KB** (≈25 years of `116.00005` bars) — the ban the
  plan is waiting out had already lifted. In the same minutes, akshare's
  `requests` call and Node's `fetch` to the same URL were refused
  (`RemoteDisconnected` / `UND_ERR_SOCKET`), and after ~12 further probes curl was
  refused too. Two consequences: (a) §A/§B's "re-check with one throttled
  request" must be run **from the Node loader we actually ship**, and interpreted
  as a fingerprint/throttle question, not a date; (b) I burned this session's
  window — no further eastmoney kline probing this week.
- ~250 sina requests: 0 failures, no throttling observed at ~1 s pacing.
- ~60 TickDB calls: one transient `403` from their edge under load; shared trial
  key saturated almost immediately, as expected.
- Model note: this was research/analysis, which `AGENTS.md` puts on the **deep**
  tier; it ran on `qwen3.8-flash`. The measurements are deterministic and
  re-runnable, but the two judgement calls in §7 should be re-read after a
  model switch.

## 6. Not established

- TickDB's ETF *bar* quality and `stock-info` accuracy (every ETF is plan-gated;
  catalogue presence only), its exchange redistribution rights, and its uptime.
- Whether TickDB is as-traded by design or by bug — one name (`NFLX`) is thin
  evidence, though it agrees with sina's basis.
- sina's stability under a full 695-instrument daily pass (measured 131, one
  pass) and its behaviour on halted/relisted names; whether `9195.HK`-class
  counters exist as separate sina codes (probing `9195` returned nothing).
- akshare's US ETF fundamentals (none found) and any US dividend event feed.

---

## 7. Recommendation

1. **Add neither provider.** Yahoo stays the sole primary; TickDB is closed as an
   option (no events, duplicate bars, $10.8k/yr for our window); akshare stays out
   of the runtime, with its **endpoint map** kept in §4.1 as two named leads.
2. **Fix `3195.HK` and add the intra-series integrity check (§4).** This is a live
   bad number in the store, not a provider decision — cheap, dependency-free, and
   it guards a class neither provider nor the current sentinel can see.
3. **Re-open the eastmoney-F10 question for Phase 2 (§2.3)**: HK dividend events
   with declaring currency *and* HKD equivalent, plus HK/US three statements —
   on a host that is not the banned one. This reverses a 2026-09-01 rejection
   that rested on a host-attribution error.
4. **Before workstream B's first live run, make `eastmoney-raw` return-based or
   CA-excluded, and add the half-day exclusion (§3).** Quantified: 4 % of HK /
   22 % of US names carry a benign >1 % level gap; the noise floor is
   date-correlated, not name-correlated.
5. Note in §4.2 that CN adjusted conventions vary *within* a provider (HK
   multiplicative, US additive, ETF absent) — the reason to reject them is
   inconsistency, not additivity.

**Needs your decision:** items 2–4 change the sentinel's checks and reverse a
recorded rejection, so they are design forks → switch to the deep tier
(`qwen3.8 max` + high thinking) before implementing. Item 1 and the §4.1/§4.2
record-keeping are already applied in this commit.
