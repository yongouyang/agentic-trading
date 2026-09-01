# Phase 1 Hardening Plan — Rescue Loaders, Weekly Sentinel, HSCEI Universe

**Date:** 2026-09-01 · **Status:** Agreed implementation plan, ready for fast-tier execution
**Parent docs:** `architecture-v1.md` §4.1/§4.3, `phase-1-spec.md`,
`phase-0-verification-report.md`, `research-openalgo-reference.md` §3.
Phase 1's gate has passed; this plan covers its deferred hardening items.

**Decisions (user, 2026-09-01):**
1. Scope: rescue loaders + weekly sentinel + HSCEI universe expansion.
   **Coverage ledger: explicitly skipped** — full-window rewrites are ~3 min
   and self-healing (§11 risk 5); reconsider only if Yahoo throttling makes
   runs unreliable.
2. Rescue loaders fire **automatically in-run** on non-OK outcomes.
3. Sentinel is a **manual CLI with a fixed 10-name sample**.

---

## A. Rescue loaders (HK lane only)

**Hard fact that shapes the design (spike, measured 2026-08-31):** tencent
serves **no raw HK series** — `hkfqkline fq=''` and `hkline/get` both return
HTTP 200 + empty data. **eastmoney `push2his` with `fqt=0` is the only raw-bar
rescue source.** Tencent's role is date-overlap cross-checks only (qfq dates
are convention-free). The US lane has **no rescue source at all** —
`FETCH_FAILED` there stays excluded and loud, retry next run (§4.1).

### A.1 Endpoint facts (from spike/data-probe.ts, keep these exact)

- eastmoney:
  `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=116.<6-digit>&fqt=0&…`
  — raw bars; **hard-drops TCP (temp IP ban) after ~5 requests at 0.35s
  spacing ⇒ ≥2s + jitter, and cap total calls per run**.
- tencent (sentinel only):
  `https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get?param=hk<5-digit>,day,,,1200,qfq`
  — ≤1200 bars/call; wrong-but-plausible code shape → 200 + empty array
  (RULE L4 already covers); code is **5-digit** (`hk00005`) where Yahoo is
  4-digit (`0005.HK`).
- Symbol mapping: `0005.HK` → eastmoney `00005` (secid `116.00005`) →
  tencent `hk00005`. One pure function `hkSymbolMaps(symbol)` in quant-core
  or the api market-data module, unit-tested (`0700.HK` → `00700`/`hk00700`).

### A.2 Provider and flow

- New `apps/api/src/market-data/eastmoney-repair.provider.ts` implementing a
  narrow interface (not the Yahoo seam — no CA events exist here):

  ```typescript
  interface RepairProvider {
    fetchRawBars(symbol: string): Promise<{ bars: Bar[] } | { failure: string }>;
  }
  ```

- Trigger point: `runDailyScreen`'s ingest loop — when
  `classifyResponse` ≠ OK **and** lane is HK, attempt repair after the main
  pass (never inline per-ticker — eastmoney needs slow spacing; batch the
  failures). At most **5 eastmoney calls per run** (ban protection), 2s +
  0–50% jitter; failures beyond the cap stay `FETCH_FAILED`.
- **Whole-series rule (R3 made concrete):** rescue never splices. A rescued
  ticker gets its **entire stored series replaced** by the eastmoney raw
  series (delete + rewrite, same as the Yahoo path) and
  `Instrument.dataSource` (new column, default `"yahoo"`) set to
  `"eastmoney"`. On any later run where Yahoo succeeds for that ticker, the
  full-window rewrite flips it back to `"yahoo"` automatically. A ticker's
  stored series is therefore always single-source.
- **CA handling on rescue:** eastmoney supplies no usable CA events. Keep any
  previously stored Yahoo dividend events and continue deriving with them.
  If none exist, set `caDegraded = true` and warn ("rescue-filled without CA
  history") — long-window signals on that name are annotated, per the
  CA_DEGRADED policy.
- Repaired tickers **do** enter today's screen (that is the point), flagged
  in the report. Integrity header gains a segment:
  `· 2 rescued via eastmoney (0700.HK, 9988.HK)`.
- Quality gate runs on rescued bars identically (L2 clamp, `runChecks`);
  a rescue series failing the gate is stored anyway but the ticker is
  excluded with the loud reason (data is kept for inspection).

### A.3 Tests

- Unit: `hkSymbolMaps` mapping; eastmoney response parsing incl. TCP-drop →
  `{failure}` (never throw); L4 empty-200 classification on tencent (shared
  `classifyResponse` path).
- Integration (dummy providers): Yahoo `rate-limited` on an HK name +
  fake repair provider returning bars → ticker screened, `dataSource` flips,
  header reports the rescue; repair-provider failure → ticker stays
  `FETCH_FAILED`; call cap enforced (6 failures ⇒ 5 attempts); US name +
  failure ⇒ no rescue attempted.

## B. Weekly sentinel (`pnpm -C apps/api screen:sentinel`)

The §4.3 insurance against silent provider revision — not optional per the
architecture. Manual CLI (no scheduler in v1); run it roughly weekly.

- **Fixed sample (10, pinned):** `0005.HK 0700.HK 0941.HK 9988.HK 0388.HK
  0001.HK 0016.HK 2318.HK 2800.HK 3195.HK` — liquid mix incl. CA-heavy
  payers, an ETF, and the HK-domiciled US tracker.
- **Three checks per name:**
  1. **Yahoo fresh vs stored** (same-provider rewrite detector): fetch the
     full window fresh, diff against the stored series on the overlapping
     date set — any raw-close mismatch is history revision. Tolerance: exact
     date-set equality on overlap; closes compared with a tiny float epsilon
     (1e-9 relative). Any mismatch ⇒ **ALARM**.
  2. **eastmoney raw closes (cross-source, convention-free per R4):** mean
     and max |dev| on common dates; session-date overlap %. Alarm if
     max |dev| > 1% or any date-set mismatch; warn if mean |dev| > 0.27%
     (the measured 0005.HK baseline).
  3. **tencent qfq date overlap** (dates are convention-free; closes are
     NOT compared): alarm on date-set mismatch.
- CA event counts are compared Yahoo-stored vs the fresh fetch (revision
  detector) — count delta ⇒ warn, not alarm (cross-source CA sets
  legitimately differ; eastmoney CA comparison is out of scope here).
- Spacing: tencent ~500ms, eastmoney ≥2s + jitter; 10 names ≈ 1–2 min total.
- Output: stdout table with per-name verdicts + JSON artifact in
  `apps/api/reports/sentinel-<date>.json`; **exit code non-zero on any
  ALARM** so it can later be wired to cron without changes.
- Tests: fixture-driven unit tests for the three diff functions (mismatch
  injection ⇒ alarm; clean ⇒ ok; tencent-dates-only path never compares
  closes); integration test with fake providers through the CLI's exported
  runner function (same pattern as `runDailyScreen`).

## C. HSCEI universe expansion

- Add HSCEI constituents missing from `universe.hk.json` (HSI+HS Tech already
  covered; HSCEI adds e.g. 1288.HK ABC, 2601.HK CPIC, 6030.HK CITIC Sec —
  target ~140 total).
- **Verify-then-add is mandatory** (the universe-build rule from Phase 1):
  probe each candidate against Yahoo v8 before committing it; drop anything
  that 404s. Reuse the probe pattern from the Phase 1 universe build.
- `_meta.maintenance` entry records the addition and date.
- Acceptance: a subsequent `screen:daily -- --market hk` shows the new
  universe size with no FETCH_FAILED beyond noise and no unexplained
  GENUINELY_ABSENT.

## D. Coverage ledger — decision record (skipped)

Full 5y rewrite per run costs ~3 min at pinned spacing and is self-healing
against silent revision; a ledger saves fetch time but weakens the rewrite
guarantee and adds a failure mode (ledger/store drift). **Revisit trigger:**
Yahoo throttling makes full runs unreliable, or universe grows past ~2,000
names. If adopted then: maintain it incrementally (openalgo recomputes
MIN/MAX/COUNT per upsert — don't copy that part).

---

## Build order & acceptance

1. `hkSymbolMaps` + eastmoney repair provider + CLI integration (A)
2. Sentinel CLI (B)
3. HSCEI expansion (C — independent, can go first)

**Acceptance:** all existing suites stay green; new unit/integration tests
above pass; one live `screen:sentinel` run produces a clean report (baseline
for future diffs); one live HK `screen:daily` run confirms the rescue path is
exercised-or-idle correctly and the header format is right. Docs: update
`architecture-v1.md` §4.3 (sentinel sample pinned) and this plan's status;
log the session in `PROGRESS.md`.
