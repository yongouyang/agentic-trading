# Research: DataBento XNAS OHLCV-1d archive — import design & split-event sourcing

Date: 2026-09-03 (session ended mid-plan; **this doc is the resume point**).
Status: dataset audited · Yahoo chosen as split source · sweep script ready and
smoke-tested · full Yahoo run + storage-convention decision pending.

---

## 1. The download

`~/Downloads/XNAS-20260902-W559N3FC8U/` — Databento batch job `XNAS-20260902-W559N3FC8U`:

| Fact | Value |
|---|---|
| Dataset / schema | `XNAS.ITCH` / `ohlcv-1d`, symbols=`ALL_SYMBOLS`, `stype_in=raw_symbol` |
| Window | 2021-09-02 → 2026-09-01 (1,254 sessions for full-history names) |
| Files | 20,623 per-instrument CSVs, zstd (~266 MB compressed, ~1.4 GB raw, ~13M rows) |
| Columns | `ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol` |
| Semantics | `rtype=35` (OHLCV_1D), `publisher_id=2` (XNAS.ITCH), `ts_event` = session date at UTC midnight (take first 10 chars); `instrument_id` is Databento-internal and **not stable over time** (AAPL: 24→38) — key on `symbol` |
| Extras | `manifest.json` has **sha256 per file** (use for import integrity check); `condition.json` has per-day feed status; `metadata.json` has the exact query |
| Filenames | symbol URL-encoded inconsistently (`XPOA%2B` = `XPOA+`, but `BAM#` literal) — decode with fallback |
| Coverage quirk | files span each instrument's own lifetime within window (ZK starts 2024-05-10 IPO; Z ends 2025-12-19) |

## 2. Symbol taxonomy — and the ADF trap

Counts from filename census: plain 16,781* · `…U` units 1,227 · `…W` warrants 1,540 ·
`…R` rights 1,029 · `…+` warrants (Nasdaq notation) 311 · `…=` when-issued/SPAC 311 ·
`…#` NYSE-listed issues 124 (verified: `BAM#` = Brookfield's Dec-2022 NYSE listing,
tiny ADF-only volume; `AVK^#` carries NYSE preferred syntax) · `-X` class/preferred 603 ·
test symbols 9 (`ZVZZT`, `ZJZZT`, …).
\* earlier 15,805 used a stricter rule (any-length U/W/R suffix); final classifier keeps
4-char tickers ending R/W/U (e.g. fund `AADR`) and drops only 5-char ones — 16,781.

**The feed is NOT NASDAQ-only.** TotalView-ITCH carries all US securities traded through
Nasdaq including NYSE/Arca/BATS names via ADF (Nasdaq spec §feed scope; Databento venue
docs say the same). Measured: `XOM`/`YUM` present with full 1,254-day coverage but
~1.4–2.3M shares/day vs ~15M consolidated — **partial ADF volume**. `publisher_id` does
not distinguish them (all 2). Consequence: any "NASDAQ universe" filter needs an external
listing-exchange reference (see §6/next-steps). NASDAQ-listed names carry full
consolidated volume (AAPL 15.7M ✓ matches Yahoo).

## 3. Adjustment conflict with R1 (the core design problem)

Measured in-file: ITCH bars are **as-traded, NOT split-adjusted** — NVDA 10:1 shows
1208.00 → open 120.87 on 2024-06-10; TSLA 3:1 shows 892.99 → 303.04 on 2022-08-25.
Our store invariant (architecture §4.2 R1, `quant-core/src/types.ts`): *stored raw must be
split-adjusted at the store boundary; loaders of split-unadjusted providers must normalize
before storage*. So the importer cannot dump these bars into `Instrument/Bar` unchanged —
it needs per-ticker split events (this doc's subject) to normalize, or the data lives in a
separate convention-documented archive. See §6 decisions.

## 4. Split-event sourcing — three options evaluated

### 4.1 Databento Reference API — blocked on account subscription
Endpoint contract (from their OpenAPI + docs example page
`databento.com/docs/examples/corporate-actions/splits-and-reverse-splits/requesting-us-stock-splits`):
`POST https://hist.databento.com/v0/corporate_actions.get_range` form fields
`symbols=ALL_SYMBOLS&start=<date>&end=<date>&events=FSPLT,RSPLT&countries=US`
(⚠ field names are `start`/`end`, **not** `start_date`/`end_date` — the mirror OpenAPI
spec is wrong here; proven by live probe). Returns ex_date, ratio_old/ratio_new,
operating_mic, isin, symbol, issuer_name. Their own NVDA result (1:4 2021-07-20,
1:10 2024-06-10) matches our measured price steps exactly.
**Live result with user key**: auth OK, then `403 license_reference_dataset_no_subscription`
for corporate actions AND adjustment factors AND security master. Fix would be a free
portal subscribe (Data Catalog → Corporate actions → Subscribe) — deferred; Yahoo route
chosen instead (works today, no portal action). Revisit if Yahoo gaps prove material.

### 4.2 Yahoo v8 chart events — CHOSEN (with two known traps)
Same endpoint our provider already calls daily (`apps/api/src/market-data/yahoo-market-data.provider.ts`
already requests `events=div|split` and counts splits — it just discards them today).
Sanity-probed 2026-09-03 (artifacts: `yahoo-splits-sanity.json` in download dir):

- **Depth**: full listing history (AAPL splits back to 1987/bars to 1980; MSFT 9 events;
  NVDA 6). Far exceeds our window. Fields needed exist: ex-date + numerator/denominator.
- **Anchors**: 11/12 exact hits — NVDA/TSLA/AMZN/GOOGL/SMCI forwards; KTTA/TENX/LXEH/
  PRSO/JSPR/ACON reversals from Databento's own docs table.
- **Gap (confirmed)**: `TBLT` 1:65 reversal 2024-01-02 is unmistakable in ITCH bars
  ($0.1575→$10.13 open, vol 222k→10.5k) yet Yahoo returns **no event**. Microcap reversal
  omissions are real → hence the §4.3 cross-check.
- **Not-found class**: ~25% of sampled plain symbols 404 ("may be delisted") — mostly
  genuinely gone from Yahoo (delisted/M&A'd: PKI→Revvity rename, EXAS?, AVDX, KRTX…).
  For those, in-band detection is the only fallback. Warrants/units/rights/`-`/`+` classes:
  nearly all 404 (Yahoo doesn't list them as separate tickers) — acceptable since we only
  adjust common-stock-ish series.
- **TRAP 1 — RETRACTED 2026-09-04 (k3 review):** the original claim "events are
  window-filtered; NVDA asked 2023→2024 returned zero splits despite 2024-06-10
  inside" does NOT reproduce — a live re-probe with period1=2023-06-01,
  period2=2024-12-31 correctly returned the 10:1 event. The 2026-09-03
  observation was most likely a probe-script artifact (epoch units/bounds), not
  Yahoo behavior. The sweep still requests `period1=0` full history and filters
  client-side — strictly conservative and unaffected either way.
- **TRAP 2 — timestamps**: event `date` is epoch seconds at exchange-local 09:30
  (13:30/14:30 UTC) → `toISOString().slice(0,10)` never shifts the calendar day. Verified.
- Courtesy: pinned short UA `Mozilla/5.0`, strictly sequential, 500ms + 0–50% jitter
  (project §4.1 convention; long Chrome UA draws instant 429).

### 4.3 In-band detection (price/volume signatures in ITCH itself) — second opinion only
v1 (single-day volume gate) failed both ways: 154k false positives (crash-with-volume
mimics 3:1) while missing every anchor (NVDA's post-split volume rose 5.7× not 10×; KTTA's
fell 3.4× not 20× — **share volume does not scale cleanly by 1/k**). v2 added a persistence
gate but was found (2026-09-04 k3 review) to have three defects: symbol never recorded in
output, candidate lattice capped at 1:10 reversals (the whole microcap-reversal gap class
unmatchable), and v1-scale noise. **v3 (2026-09-04, validated)**: symmetric lattice to
1:100, tiered price/volume gates (tight near k=1, loose for ≥4× overnight repricings —
a signature essentially unique to corporate actions), plausibility floors. All 11 anchor
events detected with exact ex-dates; ~2 candidate rows per 23 files (~0.08% of sessions)
on a non-anchor sample. Known limits: factor is a bars-derived estimate (10–17% off on
wide-gap microcap ex-dates); ~4:3-class small splits undetectable by design. Its role is
to flag candidates Yahoo missed (esp. the 404/delisted set), never to auto-adjust.

## 5. Scripts & artifacts (what to use tomorrow)

| Path | What | Status |
|---|---|---|
| `scripts/databento/yahoo-splits-sweep.mjs` | Full Yahoo sweep over the 16,781 plain symbols → journal `yahoo-splits-sweep.jsonl` + registry CSV `yahoo-splits-20210902-20260901.csv` (columns: symbol,ex_date,event,ratio_new,ratio_old,factor; window ≥ 2021-09-02). Resumable (journal; non-terminal statuses re-fetched on resume since 2026-09-04), refuses without `--yes`. | 🟢 **RUNNING since 2026-09-04** (nohup/background); mid-flight health check at 3,674 symbols: 2,881 ok / 793 not-found (21.6%), zero transient failures, zero 429s |
| `scripts/databento/split_candidate_detector.py` | §4.3 in-band detector **v3** (needs `pip install zstandard`, e.g. `/tmp/splitcheck`) | ✅ fixed + validated 2026-09-04 vs anchor set (see §4.3); full-archive run pending sweep completion |
| `~/Downloads/XNAS-.../detected-split-candidates.csv` | v1 detector output (154k rows, noisy — superseded) | archived |
| `~/Downloads/XNAS-.../detected-split-candidates-v2.csv` | header-only v2 output (defective script — superseded by v3) | archived |
| `~/Downloads/XNAS-.../yahoo-splits-sanity.json` | 2026-09-03 depth/anchor/stratified-sample evidence (its TRAP-1 windowed claim retracted — see §4.2) | done |
| `~/Downloads/XNAS-.../symbol-listing-exchange.csv` | nasdaqtraded.txt join: listing-exchange/ETF classification for 11,875 currently-listed plain symbols; 4,906 unmatched ≈ delisted since 2021 (aligns with ~22% Yahoo 404 rate). Matched set is only ~30% NASDAQ-listed common stock — the ADF caveat quantified | done 2026-09-04 |
| `scripts/databento/split-crosscheck.mjs` | Registry↔detector join (step 3 below) → `split-crosscheck-report.csv` + `split-registry-additions.csv` (inband/estimated rows schema-compatible with registry). Tested against anchor candidates + partial registry | ✅ ready; run after sweep + full detector run |

**Start command (≈2.9h, resumable, Ctrl-C safe):**
```bash
cd ~/projects/agentic-trading && nohup node scripts/databento/yahoo-splits-sweep.mjs --yes \
  >> ~/Downloads/XNAS-20260902-W559N3FC8U/sweep.log 2>&1 &
tail -f ~/Downloads/XNAS-20260902-W559N3FC8U/sweep.log   # progress every 100 symbols
```

## 6. Decisions

**Taken (recorded here so we don't relitigate):**
1. Split source = **Yahoo v8 events**, full-history requests, filtered ≥ 2021-09-02.
2. Sweep scope = **plain symbols only** (~16.8k); derivative classes excluded from
   adjustment (they're out of stock-picker scope anyway).
3. Cadence = conservative courtesy throttle (500ms+jitter, sequential, one retry ladder).
4. Importer language stays **TypeScript** (§3 pure-TS stack) — the Python snippets floating
   around this topic (yfinance examples) were evaluated only as endpoint probes.
5. **Storage fork — DECIDED 2026-09-05 (user): option (a), separate lossless
   `VendorBar(vendor,symbol,date,…)` archive table** keeping the native as-traded
   convention; split registry stored alongside; adjusted series derived on read.
   The existing `Instrument/Bar` store and R1 are untouched.
6. **Registry finalization — DECIDED 2026-09-05 (user): FAR-tier in-band
   additions only** (653 rows, `source=inband, confidence=estimated`). NEAR-tier
   719 rows stay in `split-crosscheck-report.csv` for optional later vetting.
   Exclude the 9 known test symbols (ZVZZT-class) from the final registry.
7. **Universe scope — DECIDED 2026-09-05 (user): plain symbols only** (16,781,
   incl. delisted); units/warrants/rights/`=`/`#`/`-` classes not imported.
8. **Symbol identity — DECIDED 2026-09-05 (user): empirical segmentation,
   vendor archive only.** Motivation (measured): Databento raw_symbol files
   silently stitch two securities across ticker reuse (META = Roundhill ETF →
   Meta Platforms; BNY = prior ETF → BK rename; FB = Meta → ProShares ETF;
   627/719 NEAR-tier detector candidates were the same artifact). Model:
   nullable `segment_id` on `VendorBar` + `VendorSegment` table (symbol,
   segment_id, first_date, last_date, detection_evidence); raw bar values never
   altered (lossless preserved); populated by a post-import segmentation pass;
   surrogate segment IDs, name/FIGI enrichment deferred until fundamentals need
   legal identity. The Yahoo store stays symbol-keyed (its series are
   continuous through renames). Known-stitched series (META/BNY/FB + full scan
   output) segmented immediately as the mechanism's validation set.
   **Stitch rule**: boundary between consecutive bars where (calendar gap >
   10 sessions) AND (|price jump| outside 1/2.5–2.5×) AND (no `SplitEvent` on
   that date) AND (jump matches no rational split factor within 5% log) —
   same-day reuse without a gap is missed by design (reported, not hidden).

**Resolved without action:**
- Databento **security master** subscribe: declined (measured 2026-09-04:
  `nasdaqtraded.txt` classifies the 11,875 currently-listed plain symbols —
  `symbol-listing-exchange.csv`; the 4,906 unmatched are delisted names, for
  which listing-exchange classification has no import consequence).

## 7. Next steps (ordered)

1. ✅ DONE 2026-09-04: sweep complete, zero failures — 13,416 ok / 3,365
   not-found (20.0%); registry = **2,645 events across 1,731 symbols** (495
   forward / 2,150 reverse; 1,511 reverses ≥1:10).
2. ✅ DONE 2026-09-04: detector fixed to v3 (validated on anchors) and run over
   the full archive: **3,589 candidates** (0.03% of sessions), 0 error files →
   `detected-split-candidates-v3.csv`.
3. ✅ DONE 2026-09-04: cross-check (`split-crosscheck.mjs`) →
   `split-crosscheck-report.csv` + `split-registry-additions.csv`. Tally:
   confirmed 1,283 · factor-mismatch 42 · **yahoo-missed 869** ·
   **yahoo-blind-spot 503** · out-of-scope (non-plain) 892 · registry events
   undetected 1,320 (of which expected-miss 167). Key measured nuances:
   - **Detector recall is ~50%** (1,325/2,645). The 1,153 detector-misses
     decompose: 649 real-signature-but-outside-tolerance (ex-date drift, e.g.
     ABVC 1:10 with +22% ex-gap and volume that rose instead of falling); 305
     ex-date absent from file (halt/renaming windows); 70 factor outside the
     1:100 lattice (e.g. ACON 1:335); 59 no-prev-bar (new listings); 50 halted
     on ex-date; 20 archive-edge (event in final days ⇒ no post window).
   - **Proposed additions = 1,372 rows**, but split by confidence tier:
     **FAR (≥4× repricing): 653** (268 yahoo-missed + 385 blind-spot) —
     spot-checks show these are overwhelmingly real (NESR 3.9×, NINE 46×,
     NIVF 21× all genuine repricings; occasional questionable like MUX 2.5×).
     **NEAR: 719 — treat as needs-manual-verification, do NOT bulk-append.**
   - **NEAR-tier vetting — DONE 2026-09-05, verdict: reject all 719.**
     Re-scored with a stricter rubric + 17-row independent verification sample
     (`near-tier-verdicts.csv`): 627 likely-noise (median measured price ratio
     3,016× — these are **ticker-reuse artifacts**: detector compared the last
     bar of a delisted company with the first bar of the ticker's next
     occupant), 78 unscorable (the known test-symbol leak), 13 uncertain + 1
     likely-real — and the sample check rejected all 14 (zero Yahoo
     corroboration; the 1 "likely-real" is a 4-day-late echo of registry event
     EFAX 2023-01-12). Decision 6.6 confirmed by evidence. Detector follow-up
     worth doing: a price-ratio sanity bound would kill the ticker-reuse class
     at the source (see §7.4 R4 diagnosis — same root cause as META/BNY).
   - **R4 anomaly diagnosis — DONE 2026-09-05** (full outlier decomposition in
     session log): META/BNY = vendor-side ticker-reuse stitches (raw_symbol
     files silently concatenate two securities across a ticker change; a third
     stitch, FB→ProShares ETF, was invisible to R4); MNST = store-side phantom
     half-price bars (data patch); BR 2024-10-04 = false `inband/estimated`
     registry row (data patch: audit in-band rows); ~3k mid-tier outliers =
     vendor extended-hours vs Yahoo regular-session convention mismatch.
     **Design gap surfaced: no symbol-identity concept** (validity windows /
     ticker history) — parked for user decision, deep tier.
   - Yahoo-missed-but-detected FAR rate ≈ 268/13,416 answered symbols ≈ 2% —
     Yahoo's coverage gap is real but small for currently-listed names; the
     detector's main value is the 3,365-symbol delisted blind spot.
4. **READY TO BUILD** (all decisions taken, §6.5–6.7): implement importer CLI
   `apps/api/src/cli/import-databento.ts` — `VendorBar` + `SplitEvent` tables,
   plain-symbols universe, registry = Yahoo CSV + FAR-tier additions,
   better-sqlite3 bulk insert, manifest sha256 verify, per-file idempotent
   journal, Day-17-style typed validation report, R4 return-level
   cross-validation vs Yahoo store on shared symbols.
5. Docs touch-ups: architecture §4.1 routing-table row for Databento (paid archive,
   as-traded convention, ADF caveat); PROGRESS.md after each step.

Model policy note (AGENTS.md): steps 1–3 are execution → fast tier fine; step 4's storage
fork is a design decision → deep tier if it reopens.
