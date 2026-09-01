# Phase 1 Hardening Plan — Rescue Loaders, Weekly Sentinel, HSCEI Universe

**Date:** 2026-09-01 · **Status:** A + B implemented 2026-09-02 — B live-validated
on Yahoo + tencent (clean baseline in hand), A's eastmoney leg still
ban-blocked; C pending
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

**Update 2026-09-02 — live validation parked:** the 2026-08-31 spike ban was
still in effect ~36h later (all `push2his`/`push2` hosts TCP-drop every
request regardless of headers/cookies; `www`/`quote` unaffected). Rescue
loader A was committed with unit+integration tests green but **no live
eastmoney validation**. Re-check with a single throttled request ~48h after
last probe (≈2026-09-04). If bans routinely outlast a day, the "rescue in the
next daily run" premise is weak and the rescue-source decision must be
re-opened.

### A.1 Endpoint facts (from spike/data-probe.ts, keep these exact)

- eastmoney:
  `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=116.<6-digit>&fqt=0&…`
  — raw bars; **hard-drops TCP (temp IP ban) after ~5 requests at 0.35s
  spacing ⇒ ≥2s + jitter, and cap total calls per run**.
- tencent (sentinel only):
  `https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get?param=hk<5-digit>,day,,,1200,qfq`
  — ≤1200 bars/call; wrong-but-plausible code shape → 200 + empty array
  (RULE L4 already covers); code is **5-digit** (`hk00005`) where Yahoo is
  4-digit (`0005.HK`). Some names have no `qfqday` array at all (measured
  3195.HK): the payload then carries `day` — same session calendar, so the
  sentinel's date check accepts either (it never reads closes from here).
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

## B. Weekly sentinel (`pnpm -C apps/api screen:sentinel`) — IMPLEMENTED 2026-09-02

The §4.3 insurance against silent provider revision — not optional per the
architecture. Manual CLI (no scheduler in v1); run it roughly weekly.
Read-only by design: it never writes bars, events or runs — only the JSON
artifact and the exit code.

- **Fixed sample (10, pinned):** `0005.HK 0700.HK 0941.HK 9988.HK 0388.HK
  0001.HK 0016.HK 2318.HK 2800.HK 3195.HK` — liquid mix incl. CA-heavy
  payers, an ETF, and the HK-domiciled US tracker. Code:
  `src/sentinel/sentinel-sample.ts`, pinned by a unit test against this list
  (an edit must be deliberate). `--symbol X` overrides for diagnosis and marks
  the report `CUSTOM`.
- **Checks per name (code:** `src/sentinel/sentinel-checks.ts`,** pure functions,
  no I/O**):**
  1. **Yahoo fresh vs stored** (same-provider rewrite detector): fetch the
     full window fresh, diff against the stored series on the overlapping
     date set — any raw-close mismatch is history revision. Tolerance: exact
     date-set equality on overlap; closes compared with a tiny float epsilon
     (1e-9 relative). Any mismatch ⇒ **ALARM**. ✔ live-validated: 1225/1225
     days identical on 9 names and 576/576 on 3195.HK; an injected one-value
     corruption was caught with its date, both values and the % deviation,
     exit 1.
  2. **eastmoney raw closes (cross-source, convention-free per R4):** mean
     and max |dev| on common dates; session-date overlap %. Alarm if
     max |dev| > 1% or any date-set mismatch; warn if mean |dev| > 0.27%
     (the measured 0005.HK baseline). **Built but off by default — `--eastmoney`
     opts in.** Rationale (deviation from the plan, decision 2026-09-02): the
     2026-08-31 IP ban was still in force on 2026-09-02, and a weekly tool must
     not keep re-probing a banned host and extending it. The leg reuses
     `EastmoneyRepairProvider` (no second eastmoney client, same ≥2s + jitter
     pacing); it is unit/integration tested with fakes and stays unvalidated
     live until §A's ban re-check (~2026-09-04).
  3. **tencent qfq date overlap** (dates are convention-free; closes are NOT
     compared): alarm on date-set mismatch. Enforced structurally — the new
     `TencentKlineProvider` returns **dates only**, so a close comparison is
     not expressible. Live shapes confirmed 2026-09-02: `qfqday` for stocks and
     2800.HK, `day` only for 3195.HK (both handled).
- CA event comparison (stored vs fresh, on the overlap window) ⇒ **WARN**, not
  alarm, as pinned. **Extension from live evidence:** amount restatements on a
  `CA_DEGRADED` name are recorded but ignored — measured on 0005.HK/9988.HK,
  Yahoo re-converts each USD-declared dividend at a fresh FX rate **on every
  fetch** (2026-08-13 came back 0.78407 → 0.78404003 → 0.78402 in three runs),
  so a permanent weekly WARN would be self-inflicted noise. Event *date sets*
  are still compared on those names; HKD-native payers were clean.
- **Refinements made from live evidence (deviations, all in service of
  "explainable, not absent", each with a test):**
  - *Window-edge rule:* every diff runs on the **overlap** of the two date sets
    (the stored window is older than the fresh trailing-5y one; tencent caps at
    1200 bars ≈ 4.6y). Dates outside the overlap are never a mismatch — which
    also means an edge hole is indistinguishable from a truncation, so only
    in-window holes alarm.
  - *Known-closure attribution:* the live run reproduced the verification
    report §G2b mismatches exactly (99.67% overlap; tencent carries 2022-01-31
    plus the three 2023 cyclone closures). A phantom on a date HKEX was
    demonstrably shut is the **carrier's** calendar bug, not a Yahoo revision:
    tencent-side ⇒ recorded as a note (row stays ok — warning weekly about a
    third-party bug we cannot fix trains us to ignore the sentinel); our-side ⇒
    **WARN** (store contamination: an L1 phantom that survived the load).
    Published closures come from `HKEX_HOLIDAYS`; the measured ad-hoc cyclone
    closures from the new `HKEX_ADHOC_CLOSURES`, both exposed as
    `HKEX_KNOWN_NON_SESSIONS`. Evidence-driven on purpose: a NEW cyclone
    closure alarms once, a human classifies it, only then is it appended with a
    citation.
  - *Loader parity:* the fresh Yahoo set goes through the **same L1/L2 repairs**
    as the store (via `MarketDataService`) before diffing — otherwise the
    dropped holiday-phantom bar and the clamped closes would ALARM every run.
  - *Verdicts the plan did not specify:* store owned by another source ⇒ check 1
    skips (single-source invariant; cross-source thresholds apply); symbol
    absent from the store ⇒ WARN (a silently unmonitored name is exactly this
    workstream's failure mode); fresh `FETCH_FAILED` ⇒ WARN, cross-source legs
    then diff against the stored series; fresh `GENUINELY_ABSENT` ⇒ ALARM (a
    pinned liquid name does not vanish); thin overlap <50 comparable dates ⇒
    WARN, zero ⇒ ALARM.
- **Provenance guard (found while preparing the live run):** the store's whole
  HK lane had been overwritten with the dummy provider's 30 synthetic bars by an
  earlier run (2026-09-01, run 6 — all 122 names ended `INSUFFICIENT_HISTORY`,
  and the header still read "122/122 screened"). The daily header and the
  sentinel legs line now both carry the provider label
  (`provider=yahoo` / `⚠ PROVIDER=dummy — SYNTHETIC DATA`), so a synthetic store
  can never masquerade as a baseline again. Restored with a real 122-name HK run
  (122/122 OK, 0 fetch-failed, 252 clamped bars, rescue pass correctly idle — no
  eastmoney request made).
- Spacing: tencent 500ms + jitter, eastmoney ≥2s + jitter, Yahoo 200ms + jitter
  — each provider paces itself. Measured live run: ~25s for 10 names on 20
  requests (~2 min with the eastmoney leg on, as planned).
- Output: stdout table (per-check cells + one evidence line per non-ok check)
  + JSON artifact in `apps/api/reports/sentinel-<date>.json` — the artifact
  carries every metric, so it is the comparable baseline for future diffs.
  **Exit code 1 on any ALARM** (verified live both ways), 0 otherwise; a usage
  error or FATAL also exits 1.
- Tests: 37 unit for the four diff functions (mismatch injection ⇒ alarm; clean
  ⇒ ok; tencent path never compares closes) + 20 tencent-provider unit tests
  (live response shapes incl. the 200+empty RULE L4 shape, `qfqday`/`day`
  fallback, transport drop, pacing) + 20 integration through `runSentinel` with
  fake sources and a throwaway SQLite store + 8 CLI/sample pinning tests.
- **Live baseline:** `apps/api/reports/sentinel-2026-09-01.json` — 10/10 ok,
  ALARM 0, WARN 0 (tencent 99.67% / 1196d with 4 classified phantoms; eastmoney
  leg disabled). Re-run weekly and diff the metrics against this file.

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

1. `hkSymbolMaps` + eastmoney repair provider + CLI integration (A) — ✔ code +
   tests 2026-09-02; live rescue validation still blocked on the §A ban
2. Sentinel CLI (B) — ✔ 2026-09-02, live-validated on the two unblocked legs;
   its eastmoney leg is built, opt-in, and joins A's pending live validation
3. HSCEI expansion (C — independent, can go first) — pending

**Acceptance:** all existing suites stay green ✔ (`pnpm -w test` and
`pnpm -w test:coverage`; the coverage gate was found red at A's commit and is
green again); new unit/integration tests above pass ✔ (166 in apps/api, 41 in
quant-core); one live `screen:sentinel` run produces a clean report (baseline
for future diffs) ✔ — `reports/sentinel-2026-09-01.json`, 10/10 ok, exit 0, and
exit 1 verified with an injected corruption; one live HK `screen:daily` run
confirms the rescue path is exercised-or-idle correctly and the header format is
right ✔ (idle correctly — 122/122 via Yahoo, zero eastmoney requests; header
format verified, plus the new provider label). Docs: update
`architecture-v1.md` §4.3 (sentinel sample pinned) and this plan's status ✔;
log the session in `PROGRESS.md` ✔.
