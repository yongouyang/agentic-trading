# Phase 0 Verification Report

**Date:** 2026-08-31 · **Status:** Spike executed, gates evaluated
**Plan:** `docs/phase-0-data-verification.md` · **Probe:** `spike/data-probe.ts`
(throwaway, gitignored; check logic ported from `docs/probes/adjustment-convention.py`)
**Environment:** node 22.23.0, pnpm 12.0.0, `tsx` 4.23.13, `yahoo-finance2` 4.0.2.
Two full runs (`spike/run.log`, `spike/run2.log`); all figures below from run 2
unless noted. Raw JSON: `spike/results-1788191371060.json`.

## Gate verdicts (summary)

| Gate | Verdict | One-line evidence |
|---|---|---|
| **G1** | **PASS\*** | 21/22 liquid-sample fetches OK; sole failure is RYL, a *defunct* sample member (Ryland merged 2015 — Yahoo serves a zombie `MUTUALFUND` meta); live substitute SLGN OK. ≤1 failure per lane holds everywhere. \*Strict overall ratio 95.5% < 98% if the defunct ticker is counted — see §G1. |
| **G2a** | **NOT RUN — environment** | eastmoney IP ban persists (first request: connection dropped). tencent has **no raw series at all** (new finding). A2 baseline (mean 0.00%, max 0.27%) is the only raw-close evidence. |
| **G2b** | **PASS** | Session-date index vs tencent: 99.67–99.75% ≥ 99.5%; every mismatch classified (typhoon/rain closures, tencent's 1200-bar window edge, one provider hole). |
| **G2c** | **NOT RUN as designed — but the underlying question got a direct answer** | eastmoney-derived events unavailable; instead Yahoo's HK CA quality was measured *internally* via G2d residual analysis: **Yahoo's own HK adjclose is FX-buggy** (9988.HK off 5.45%, 0005.HK off 0.43%). |
| **G2d** | **PASS (our math) / measured FAIL vs Yahoo adjclose on 2 HK names** | US + LSE + 4 HK names: max dev ≤0.0001%. 9988.HK 5.45% and 0005.HK 0.43% trace to Yahoo's FX-inconsistent dividend *amounts*, not our math (2800.HK: 10 dividends, 0.0000% exact). |
| **G3** | **PASS** | All 5 UCITS ETFs: `currency: USD`, 0 dividend events, identity adjustment, 1261–1263 bars. GBX trap not present in the UCITS lane. |
| **G4** | **PASS** | 100 tickers sequential @200ms, pinned UA: **100/100 OK, zero 429s**, p50 100ms / p95 161ms / max 208ms, wall 30s → 800-ticker run ≈ **4.1 min**. |
| **G5** | **PASS** | 5/5 taxonomy probes typed as specified (invalid→GENUINELY_ABSENT; 429, timeout, 200+empty-bars, connection-dropped→FETCH_FAILED). |

**No gate result requires changing the routing table or R1–R4** — but two
findings are decision points for the next design session (§"Decision points").

## Per-stratum findings

| Stratum | Tickers | Result |
|---|---|---|
| US mega | AAPL, MSFT, NVDA | All OK, 1254 bars, USD. NVDA 10:1 split handled (see Surprise 2). One real >20% day (NVDA 2023-05-25 +24.4%, post-earnings — genuine). |
| US ETF/index | SPY, QQQ, ^GSPC | All OK, 1254 bars. ^GSPC: 0 volume as expected for an index. |
| US mid-liquidity | PKG, FDS OK (1254 bars); **RYL defunct** | RYL (Ryland Group) merged 2015. Yahoo returns HTTP 200 with `instrumentType: MUTUALFUND`, `currency: null`, **no timestamp array** → typed FETCH_FAILED per taxonomy (correct: a wrong-shape 200, not absence). Live substitute **SLGN**: OK, 1254 bars. |
| HK blue chips | 0700.HK, 9988.HK, 0005.HK | All OK, 1227 bars, HKD. All show a **zero-volume phantom bar on 2022-01-31** (Lunar New Year, HKEX closed — Yahoo fabricates a bar on a holiday). 0700/9988 have a genuine >20% day (2022-03-16, HK policy rally). |
| HK ETF | 2800.HK | OK, 1226 bars, HKD, 10 dividends. G2d exact 0.0000%. |
| HK edge (runtime pick) | **1121.HK, 0623.HK** (lowest 20d turnover of 0142/0345/0623/0440/0636/1121 — HK$0.5M/day each) | Both fetch OK (1227 bars). 0623.HK: **250/1227 zero-volume days** (20%) and 16 bars with close outside [H,L]; 1121.HK: 19 zero-volume days, 6 genuine >20% days. Illiquid-name reality, not a fetch failure — but see Surprise 5. |
| LSE UCITS | CSPX.L, VUAA.L, VWRA.L, ISAC.L, EIMI.L | All OK, 1261–1263 bars, **all currency USD**, 0 dividend events. Each has 1–5 bars (≤0.4%) where close sits outside [H,L] — Yahoo feed bugs (Surprise 5). ISAC/EIMI have a zero-volume bar on 2025-10-24 (Yahoo LSE hole that day). |
| Invalid / delisted | NOSUCHTICKER, TWTR | Both → GENUINELY_ABSENT ("No data found, symbol may be delisted"). Correct. |

## Cross-source validation (HK)

eastmoney: **IP ban persisting** — first request of the session already dropped
(`UND_ERR_SOCKET`), after 2.5s spacing. Per the spike's hard rule, eastmoney
legs were not retried aggressively; tencent is recorded as the HK cross-check
source.

| Check | Source | 0005.HK | 0700.HK | 9988.HK | 2800.HK |
|---|---|---|---|---|---|
| Raw close deviation (G2a) | eastmoney raw | — banned — | — banned — | — banned — | — banned — |
| Date-index overlap (G2b) | tencent | 99.75% | 99.75% | 99.75% | 99.67% |
| tencent bars (1200 cap) | tencent | 1200 | 1200 | 1200 | 1200 |

Date mismatches, all classified:
- **tencent-only** 2023-07-17 (Typhoon Talim), 2023-09-01 (Typhoon Saola),
  2023-09-08 (black rainstorm): HKEX **closed**, tencent carries phantom bars
  → tencent calendar bug, Yahoo correct. (2800.HK also 2025-10-24: provider
  hole/phantom, single day.)
- **yahoo-only** 2021-08-31…2021-09-06: tencent's 1200-bar cap truncates the
  oldest 5 sessions of the 5y window → window edge, not a hole. **A 5y HK
  backfill needs 2 tencent calls** (1227 > 1200).

**New finding:** tencent serves **no raw (unadjusted) HK series** —
`hkfqkline` with `fq=""` and `hkline/get` both return HTTP 200 with empty
`data` (probe: `spike/scratch.ts`). G2a raw-close cross-check therefore
*requires* eastmoney. A2's measured baseline stands: Yahoo vs eastmoney raw
mean 0.00%, max 0.27%.

## G2d detail — our adjustment math vs Yahoo's adjclose

Local derivation: `adj[t] = raw[t] · Π_{ex>t}(1 − D/P_prev)`, where **P_prev is
the previous session's close** and **no split factor is applied** (Yahoo v8 raw
closes are already split-adjusted — see Surprise 2). Max |deviation| vs Yahoo
`adjclose` over ~1250 bars:

| Ticker | max dev | | Ticker | max dev |
|---|---|---|---|---|
| AAPL / MSFT / NVDA / SPY / QQQ / ^GSPC / FDS / SLGN | 0.0000% | | 0700.HK / 2800.HK / 1121.HK / 0623.HK | 0.0000% |
| PKG | 0.0001% | | **0005.HK** | **0.4258%** |
| all 5 LSE UCITS | 0.0000% | | **9988.HK** | **5.4474%** |

The two HK failures are **Yahoo feed bugs, not our math** — proven by
implied-amount analysis (`spike/scratch2.ts`): the dividend amount implied by
Yahoo's own adj/raw ratio jump vs the amount in Yahoo's event feed:

- **9988.HK** (declares dividends in USD): *all 4 events* — Yahoo's adjclose
  applies the **USD amount unconverted** against HKD prices (implied 0.125 vs
  reported 0.9798 ≈ 0.125 × 7.83 HKD/USD). Yahoo's own adjusted series for
  9988.HK is internally inconsistent.
- **0005.HK**: 16/17 events consistent; the newest (2026-08-13, USD 0.10
  interim) is applied unconverted (implied 0.100 vs reported 0.7839 HKD).
- **2800.HK** (HKD-native distributions): 10 events, **0.0000% exact** — the
  derivation math is correct when the feed's amounts are self-consistent.

Consequence: G2d's criterion ("≤0.05% ⇒ our code correct") is met for our code;
the measured HK failures are the G2c question answered directly — **Yahoo's HK
corporate-action data cannot drive local adjustment for USD-declaring HK
names**. This promotes R1's local-adjustment dependency to blocking for the HK
lane (needs HKD-native event amounts; eastmoney, the designated source, is
currently IP-banned).

## Rate-limit probe (§3.4, G4)

- **Yahoo, primary path:** 100 tickers, sequential, 200ms spacing, pinned
  `User-Agent: Mozilla/5.0`: **100/100 OK, zero 429s**. Latency p50 100ms,
  p95 161ms, max 208ms; wall 30.3s. Extrapolated 800-ticker universe:
  **≈4.1 minutes** — trivially fits the daily run windows. Throttle default
  for the ingestion module: 200ms spacing, pinned short UA, no jitter needed.
- **tencent (repair):** 9 calls at ~0.5–0.6s spacing, zero throttling. 1200-bar
  cap ⇒ 2 calls per 5y HK backfill.
- **eastmoney (repair):** unusable this session — per-IP ban now fires on the
  *first* request (previously ~5). Even the §3.4 "find the safe rate" probe
  could not run. The A5 guidance (≥2s + jitter, treat drops as FETCH_FAILED +
  back off) stands, but eastmoney's availability as a repair path is
  demonstrably fragile.

## G5 error-taxonomy probes — 5/5 PASS

| Probe | Result | Typed as |
|---|---|---|
| Invalid symbol (`NOSUCHTICKER`, `NOSUCHTICKER.XYZ`) | Yahoo "No data found" | GENUINELY_ABSENT ✅ |
| Long Chrome UA on Yahoo v8 | HTTP 429 (A1 reproduced) | FETCH_FAILED ✅ |
| Forced timeout (1ms abort) | AbortError | FETCH_FAILED ✅ |
| tencent `hk0005` (4-digit wrong shape) | HTTP 200 + empty bar array (`day: []`, keys `day,qt,prec,vcm,…`) | FETCH_FAILED ✅ |
| eastmoney connection drop | `UND_ERR_SOCKET` on burst/first request | FETCH_FAILED ✅ |

## Surprises vs Appendix A

1. **MMC (Marsh McLennan — a live NYSE large-cap) returns Yahoo 404
   "No data found, symbol may be delisted"** on both query hosts, while Yahoo
   search finds only the futures contract `MMC=F`. Whether transient or
   permanent, it proves a taxonomy hazard: **GENUINELY_ABSENT means "absent
   from Yahoo", never "the security does not exist"** — a live symbol can land
   in that bucket. (MMC was swapped for ACN in the 100-ticker probe; a duplicate
   CVS in the list was also replaced with MDT.)
2. **Yahoo v8 raw closes are already split-adjusted.** Applying the split
   factor in local derivation double-counts (NVDA: +900% error); omitting it
   gives 0.0000%. Dividend *amounts* in the event feed are likewise
   split-adjusted. R1's "store raw + events, adjust locally" must store raw
   **as delivered (split-adjusted)** plus dividend events only — or
   deliberately re-derive split handling. Also: the correct dividend price
   base is the **previous session's close**, not the ex-date close.
3. **Yahoo's own HK adjclose is FX-buggy** (9988.HK all events, HSBC's newest)
   — worse than A2 implied: not only are the event *amounts* FX-converted, the
   *adjusted series itself* mixes USD amounts with HKD prices. R3's
   never-splice rule is vindicated by the same provider being inconsistent
   with itself.
4. **tencent has no raw HK series** (fq="" → empty data, not raw bars). HK
   raw-close cross-checks depend solely on the (fragile) eastmoney path.
5. **Yahoo OHLC sanity violations are real and systematic at the edges:**
   close outside [H,L] on 1–16 bars for all 5 LSE UCITS ETFs and both HK edge
   names; Yahoo also fabricates zero-volume bars on HKEX holidays
   (2022-01-31, all HK tickers). The loader needs an OHLC-repair/clamp rule
   (and holiday-bar filtering), not just gap-filling.
6. **pnpm 12 worked fine** — no `minimumReleaseAge` rejection (tsx 4.23.13,
   yahoo-finance2 4.0.2 installed cleanly). Only note: non-fatal
   `ERR_PNPM_IGNORED_BUILDS` for esbuild's postinstall; tsx runs regardless.
   No fallback to pnpm 11 was needed.

## Decision points for the next design session (not decided here)

- **HK corporate-action events source.** G2d/G2c evidence says Yahoo HK event
  amounts are unusable for USD-declaring names; eastmoney is IP-banned. Whether
  the HK lane moves to "eastmoney for events only" (the remedy G2c names) is a
  routing-table decision — flagged, not made.
- **G1 overall-ratio caveat.** Strictly, 21/22 = 95.5% < 98% — but the single
  failure is a defunct sample member (RYL), a defect of the plan's sample
  list, not of the source; the per-lane criterion (≤1 failure) passes
  everywhere, and the live substitute (SLGN) is clean. Recommend amending the
  sample list (RYL → live mid-cap) rather than demoting Yahoo for US.
- **Loader hardening backlog** (does not change routing): OHLC clamp/repair
  rule, HKEX-holiday phantom-bar filter, zombie-meta (HTTP 200, no timestamps)
  detection, and GENUINELY_ABSENT documented as source-scoped.

## Files

- `spike/data-probe.ts` — the spike (checks are the seed for
  `packages/quant-core`'s data-quality module per plan §5).
- `spike/scratch.ts`, `scratch2.ts`, `scratch3.ts`, `scratch4.ts` — focused
  probes behind Surprises 1–4 (tencent raw shapes, implied dividend amounts,
  RYL/MMC raw responses).
- `spike/run.log`, `run2.log`, `results-*.json` — full evidence.
- This report: `docs/phase-0-verification-report.md`.

Nothing outside `spike/` and this report was created or modified; nothing was
committed. `spike/` is gitignored (`.gitignore:3`).
