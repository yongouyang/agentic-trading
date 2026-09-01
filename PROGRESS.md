# PROGRESS

Session log for the agentic-trading project. Newest entries on top.
Each entry: what was done, key decisions, and what's next.

---

## 2026-09-01 (research) — openalgo reference analysis

### What was done
- Source-level analysis of `~/projects/openalgo` (Flask + React 19, 36 broker
  plugins, 500 endpoints, 6 data stores) as a design reference →
  `docs/research-openalgo-reference.md`. Scope decided with the user up
  front: v1–v3-applicable first; deep-dives on data stores/Historify,
  sandbox/paper trading, MCP surface, frontend.
- **Top borrows:** `data_catalog` coverage ledger for incremental ingestion
  (Phase 1 hardening); service-layer `paper|live` fork + daily equity
  snapshot table + next-bar-open fills + per-market cost model (Phase 4 paper
  trading — openalgo lacks the last two); MCP-layer LLM tool-design
  discipline (structured errors, truncation metadata, server-side compute +
  legend) for Phase 3 chat tools; jsdom test setup + CSS-token chart theming
  + feature-folder layout for Phase 3 web.
- **Skipped as not-our-constraints:** DuckDB (1M rows don't need it), 5-way
  DB split, eventlet/NullPool machinery, OAuth-for-hosted-MCP-clients, the
  charting terminal, Socket.IO (SSE replaces), all broker normalization.
- **Confirmed we're ahead on:** corporate actions (they have none) and
  transaction costs in paper fills (they have none).

### What's next
- Unchanged: Phase 2 design (deep tier) — agent pipeline + Piotroski/earnings
  deterministic inputs; Phase 1 follow-ups (rescue loaders, weekly sentinel,
  coverage-ledger ingestion).

---

## 2026-09-01 (skills) — trading_skills audit; skill dirs shared across harnesses

### What was done
- Reviewed [staskh/trading_skills](https://github.com/staskh/trading_skills)
  (350★, options-seller/IBKR toolkit, 24 skills over a Python package);
  cloned to `~/vendor/trading_skills` and wrote the audit →
  `docs/research-trading-skills-audit.md`.
- **Borrow (knowledge, not code):** scanner-bullish rubric → Phase 4
  hypothesis H2; Piotroski F-score + earnings calendar → Phase 2 analyst
  inputs; beta/VaR → risk module gap; report template + md→pdf → Phase 3.
- **Not borrowed:** Python runtime (pure-TS fork), unschematized yfinance
  data path (no L1–L4/R1–R4 discipline), 13 IBKR/options skills (out of
  scope; IBKR data is paid), whale-hunting (paid API). HK news-depth gap
  confirmed unchanged (insider data is SEC Form 4, US-only).
- **Harness config:** registered all three vendored skill libraries
  (Vibe-Trading, ccxt, trading_skills) in kimi-code `extra_skill_dirs`
  (doctor-validated, backed up) and pi `settings.json` — both harnesses now
  share the same skill index.

### What's next
- Phase 2 design (deep tier): lean agent pipeline; fold in the Piotroski /
  earnings-calendar deterministic inputs.

---

## 2026-09-01 — Phase 1 apps/api implemented (loader + daily CLI)

### What was done
- **Prisma migration `20260901132915_phase1_screen_runs`**: added `ScreenRun`
  + `ScreenResult` (per phase-1-spec §5); fixed the stale `"US" | "HK" | "LSE"`
  schema comment (LSE lane dropped).
- **`YahooMarketDataProvider`** (`src/market-data/yahoo-market-data.provider.ts`):
  ported from spike/data-probe.ts — pinned UA `Mozilla/5.0`, full 5y window by
  default, 200ms+0–50% jitter sequential throttle, one 5s in-run retry on
  429/timeout/5xx, yahoo-finance2 schema-validation → raw v8 fetch fallback,
  splits counted (`splitCount`) never stored. Never throws on provider
  failure; spacing/backoff/sleep/chart/fetch injectable for tests.
- **Seam change**: `fetchDailyBars(symbol, opts?: { period1?, period2? })`;
  dummy provider ignores opts. `MarketDataService` passes opts through and now
  applies RULE L1 with the matching calendar (HKEX for `.HK`, NYSE otherwise).
- **deps.ts**: real Yahoo provider is now the default; dummy under
  `MARKET_DATA_PROVIDER=dummy` or `MARKET_DATA_TEST_MODE=1`; fail-closed
  production rules unchanged. deps.spec updated to match.
- **Daily CLI** (`src/cli/daily-screen.ts`, `pnpm -C apps/api screen:daily --
  --market us|hk|all`, tsx): plain script wiring PrismaService + env-selected
  provider + MarketDataService; universe upsert → ingest/classify/L1/L2 →
  bar+dividend persistence (full-window delete+createMany rewrite) →
  CA_DEGRADED auto-detection → runChecks → tallies → deriveAdjustedBars →
  runScreen → ScreenRun/ScreenResult persist → integrity-led stdout report +
  `apps/api/reports/<date>-<MARKET>.json` (gitignored). Pipeline factored into
  exported `runDailyScreen(deps, opts)` for in-process tests.
- **Tests**: 11 new yahoo-provider unit tests (mocked chart/fetch, zero
  spacing/backoff), 3 runDailyScreen integration tests (8 dummy behaviors →
  tallies ok=4/fetchFailed=4/absent=1/degraded; HK CA_DEGRADED + phantom drop;
  6 trending names → persisted ranked shortlist), live-Yahoo smoke gated
  behind `YAHOO_LIVE_TEST=1` (never default). `pnpm -C apps/api test`: 47
  passed, 1 skipped; `pnpm -C apps/api build` green; `pnpm -w test` green.
- Added deps: `yahoo-finance2 ^4.0.2` (matches spike), `tsx ^4.20.3` (dev).

### Deviations / notes
- `RawMarketDataResponse` gained optional `splitCount` (spec requires split
  counts in the run report; they must cross the provider seam).
- deps.ts default flipped dummy→yahoo per the Phase 1 tasking; the old
  deps.spec default test was updated accordingly.
- Playwright e2e not run (needs built apps/ports); the only e2e-relevant
  change is the provider default — e2e sets `MARKET_DATA_TEST_MODE=1`, which
  still selects the dummy, so no e2e impact expected.
- **Post-implementation fix (same session):** the live smoke failed —
  `yahooFinance.chart called with invalid options`. The provider passed
  `includeAdjustedClose: true` (rejected by the yahoo-finance2 v4 options
  schema) and omitted `return: "array"`. Fixed to the spike's exact verified
  option set (`period1, period2, interval, events: "div|split",
  return: "array"`); adjclose is unneeded since we derive locally (R1).
  Live probe after fix: 0005.HK → 1227 bars/5y (matches the Phase-0 spike
  measurement exactly), AAPL → 1255 bars, both `OK`; gated live test passes;
  full suite + build re-verified green. Lesson: unit tests mock the chart
  function, so only the gated live test catches option-schema drift.

### What's next
- Run the gate: real `screen:daily -- --market all` against live Yahoo and
  review the integrity report (warnings must be explainable).
- Follow-up (explicitly out of Phase 1): eastmoney/tencent rescue loaders,
  weekly sentinel, Phase 2 LLM layer.

---

## 2026-09-01 (gate) — Phase 1 gate run: live seed + screen, three bugs found and fixed

### Gate run results (live Yahoo, both lanes, 5y)
- US: **555/555 screened, 0 fetch-failed, 0 absent, 0 clamped** — full top-15
  shortlist (CRL, MPC, VLO, PSX, ABNB …), not degraded.
- HK: **121/121 screened, 0 fetch-failed**, 253 L2-clamped bars (concentrated
  in 8 thin ETFs — 3074.HK alone ~150; the known Yahoo H/L feed bug on edge
  names, loud in warnings), not degraded.
- Warnings reviewed, all explainable: L1 dropped the measured 2022-01-31
  HKEX phantom bar lane-wide; >20% outlier flags match real events
  (NVDA +24.4% 2023-05-25 per Phase-0 report); split audit counts logged,
  never stored (R1).

### Bugs found by the live run (all fixed, all covered by new/updated tests)
1. **yahoo-finance2 option schema**: provider passed `includeAdjustedClose`
   (rejected by v4) — fixed to the spike's exact verified option set. Only
   the gated live test catches this; unit tests mock the chart fn.
2. **advDollar too strict**: one null-volume bar in the 20-bar window → null
   → 489/554 US names failed LOW_LIQUIDITY (run happened during US market
   hours; Yahoo serves a partial in-progress bar). Now tolerates sparse
   nulls (null only if <⌈n/2⌉ usable). Post-fix US exclusions: LOW_LIQUIDITY 1.
   (Operational caveat recorded: production cadence is post-close; the
   full-window rewrite self-heals any partial bar on the next run.)
3. **CA_DEGRADED detection was unfireable**: spec said "dividend currency ≠
   HKD", but Yahoo's event `currency` echoes meta.currency (always HKD). Live
   probing showed the real fingerprint — FX-converted amounts with >4 decimal
   places (0005.HK 0.783188 6dp, 9988.HK 0.9800875 7dp, 2888.HK 8dp; clean
   HKD payers ≤4dp: 2800.HK 2dp, 1299.HK AIA not flagged ✓). Detection now
   currency-mismatch OR >4dp; dummy `fx-inconsistent-dividends` behavior
   updated to the realistic shape; spec §2/§3 amended. Post-fix: 33 HK names
   flagged (HSBC, Alibaba, CNY-declaring Chinese banks, several ETFs) and
   annotated `⚠CA` in the shortlist.

### Universe hygiene (from the run's GENUINELY_ABSENT tally — taxonomy worked)
- Removed 9 US tickers Yahoo 404s (M&A/renames, verified live): MMC, FI, BK,
  SEE, HOLX, K, ANSS, CMA, CTRA; added BNY (renamed BK). Added 2888.HK
  (Standard Chartered, HSI member missed in curation) → HK universe 122.

### What's next
- Phase 1 gate: **passed** per spec §0 (seeded store, explainable warnings,
  deterministic shortlists, 86 tests green across quant-core + api).
- Follow-ups (out of Phase 1): eastmoney/tencent rescue loaders + weekly
  sentinel; consider HSCEI additions if HK universe breadth is wanted (121→~140).
- Phase 2: lean LLM agent pipeline + persisted daily reports.

---

## 2026-09-01 — Phase 1 spec drafted and pinned

### What was done
- Audited Phase 1 implementation-readiness (loader ready; indicator params,
  screen rules, universe source, CLI shape were unspecified).
- Wrote `docs/phase-1-spec.md` pinning every parameter implementation must
  not improvise. Key pinned decisions:
  - **Universe**: static curated JSON (`apps/api/data/universe.{us,hk}.json`),
    no scraping in v1; ~550 US + ~140 HK entries.
  - **Loader**: always fetch the full 5y window and upsert (self-healing vs
    silent provider revision; ~3 min/run at 200ms+jitter, concurrency 1);
    one 5s-backoff retry then `FETCH_FAILED`; yahoo-finance2 validation
    rejection → raw v8 fetch fallback; splits never stored; CA_DEGRADED
    auto-detected at ingest (HK name with non-HKD dividend currency).
  - **Indicators**: batch pure functions (Day-18 incremental deferred to
    Phase 4); SMA20/50/200, mom20/60, vol60, sharpe252 (rf=0), adv20 (raw),
    mdd252; `null` on insufficient history.
  - **Screen [H1 hypothesis]**: eligibility (≥252 bars, adv20 ≥ $20M/HK$100M,
    vol60 ≤ 60%, mdd252 ≥ −50%) → signals (close>SMA50>SMA200, mom60>0,
    sharpe252>0) → rank by 0.50·z(mom60)+0.25·z(mom20)+0.25·z(sharpe252),
    top 15/market. Numbers explicitly marked as Phase-4 backtest targets.
  - **CLI**: `pnpm -C apps/api screen:daily -- --market us|hk|all`, plain tsx
    script (no Nest), degraded if FETCH_FAILED > 2%, persists `ScreenRun` +
    `ScreenResult` (one new migration), stdout integrity header + JSON
    artifact in gitignored `apps/api/reports/`.
  - Seed depth formally pinned at **5 years**.
- Non-goals recorded: no LLM, no scheduler, no repair-source loaders
  (eastmoney/tencent sentinel is a post-gate follow-up), no UI changes.

### What's next (proposed)
1. Switch to fast tier (k3-256k) and execute `docs/phase-1-spec.md` top to
   bottom: universe JSONs → Prisma migration → Yahoo provider → indicators →
   screener → CLI → tests.

---

## 2026-09-01 — Scope narrowed to HK + US; broker data research recorded

### What was done
- Researched whether IBKR / Futu provide free HK/US market data →
  `docs/research-broker-market-data.md`. **Neither is free for our use:**
  IBKR historical bars require paid per-exchange subscriptions (only delayed
  streaming ticks are free); Futu has free quote rights (HK LV1, US LV3 promo)
  but a 100–1000 tickers/7d historical-kline quota by asset tier, no LSE
  coverage, and a Python/OpenD-only protocol. No routing-table change; the
  §4.1 "Later" row now carries the findings.
- **Scope change (user decision): dropped the LSE/UCITS lane** → v1 is HK + US
  stocks/ETFs only. Tax-efficient US exposure moves to **HK-domiciled US-index
  trackers** (3195.HK etc.): no US estate tax, 30% WHT embedded at fund level
  (~0.2%/yr drag vs Irish UCITS — accepted for simplicity). Verified caveat:
  3455.HK (QQQ cross-listing) is **US-domiciled** (ISIN US…) — it confers no
  tax benefit at all. Recorded in `architecture-v1.md` §2/§6, the phase-0 doc
  (G3/LSE stratum marked moot), and a tax-doc addendum ("venue ≠ domicile").

### What's next (proposed)
1. Phase 1: Yahoo loader (through the `MarketDataProvider` seam, pinned UA,
   200ms spacing, L1–L4 applied), indicators, screening engine, daily CLI
   shortlist. Universe is now two lanes: S&P 500 + Nasdaq 100 + major US ETFs;
   HSI + HS Tech constituents + liquid HK ETFs (incl. HK-domiciled US trackers).

---

## 2026-09-01 (testing) — Test infrastructure: vitest everywhere + dummy market-data seam + Playwright e2e

- **Pattern:** mirrors ~/projects/ib-learning-site — every external dependency
  gets a controllable dummy (deterministic defaults + per-test injection),
  env-selected, fail-closed in production.
- **`apps/api` market-data seam** (`src/market-data/`): `MarketDataProvider`
  interface returns the RAW response shape; `MarketDataService` applies
  quant-core's `classifyResponse` (L3/L4 taxonomy) + loader rules (L1
  HKEX-holiday phantom drop, L2 close-outside-[H,L] clamp) + the CA_DEGRADED
  flag for USD-declared HK dividends (9988.HK). `DummyMarketDataProvider`:
  deterministic synthetic bars (symbol-seeded PRNG, fixed calendar) + 8
  injectable behaviors covering the verification-report failure taxonomy
  (429, timeout, 200+empty-bars, zombie-meta, not-found,
  fx-inconsistent-dividends, holiday-phantom, close-outside-hl). Injection:
  constructor map / `setBehavior()` in tests, or the
  `x-test-market-behavior` header — honored ONLY with
  `MARKET_DATA_TEST_MODE=1` AND the dummy provider (deps.ts refuses dummy +
  test mode under `NODE_ENV=production` unless `MARKET_DATA_ALLOW_DUMMY=1`).
  Minimal endpoint `GET /instruments/:symbol/bars` exercises the seam. The
  LLM-client seam is deferred to Phase 2 (no LLM code exists yet).
- **vitest everywhere (no Jest):** api (node env, unplugin-swc for decorator
  metadata + a `.js`→`.ts` resolver plugin for the NodeNext specifiers),
  web (jsdom + RTL + jest-dom, `@` alias), quant-core unchanged.
  Throwaway-SQLite helper applies the real migration SQL (dev.db is
  gitignored — tests never touch it); `DATABASE_URL` env overrides the
  PrismaService datasource (constructor-param injection broke Nest DI via
  emitted design:paramtypes).
- **Playwright e2e at root:** `scripts/find-port.cjs` resolves disjoint free
  ports (api 3001/3100+, web 3000/3200+ — probe-then-bind race made disjoint
  pools necessary); two webServers (built api with dummy env wiring, `next
  start` web with `API_INTERNAL_URL`); Desktop Chrome only. Smoke spec:
  placeholder renders + web reaches `/health` ("api: ok (instruments: N)").
  Page needed `export const dynamic = "force-dynamic"` (static prerender
  baked the no-env branch).
- **Coverage:** v8, per-area thresholds set just below measured —
  quant-core 96.8L/81.7B → 95/80; api 100L/93.8B → 90/80 (market-data 90/85);
  web 100/100 → 95/95. Root scripts: `test` (54 tests: 16 quant-core + 33 api
  + 5 web), `test:coverage`, `test:e2e` (builds first). All green incl.
  `pnpm -r build`; `playwright install chromium` done.
- **Next (Phase 1, unchanged):** real Yahoo loader behind the same seam
  (`MARKET_DATA_PROVIDER=yahoo` currently throws a declared not-implemented).

---

## 2026-09-01 (scaffold) — Phase 0 monorepo scaffolded; build + tests green

- pnpm workspace (`packageManager: pnpm@12.0.0` pinned; allowBuilds for
  prisma/esbuild postinstalls), strict shared `tsconfig.base.json` (NodeNext).
- `packages/quant-core`: `Bar` / `DataOutcome` (GENUINELY_ABSENT documented as
  source-scoped) / dividend-only `CorporateAction` / dual `Signal` (5-tier +
  conviction + abstain). Data-quality module ported from `spike/data-probe.ts`
  (gaps, duplicates, zero-volume, stale last bar, OHLC sanity, >20% outliers)
  plus loader rules L1–L4 encoded from the verification report: HKEX-holiday
  phantom-bar filter, close-outside-[H,L] clamp, zombie-meta → FETCH_FAILED,
  200+empty-bars → FETCH_FAILED. Adjustment module implements R1 exactly
  (multiplicative, dividend events only, NO split factor, prev-session-close
  base, anchored at latest bar). vitest: **16/16 green** incl. NVDA-style
  no-split-factor and 2800.HK-style prev-close-base regressions.
- `packages/agents`: skeleton — `Verdict` type + re-export of quant-core's
  `Signal`; no LLM code (Phase 2).
- `apps/api`: Nest 11 (ESM) health module + Prisma 6.19.3 / SQLite
  (`Instrument`, `Bar`, `CorporateAction` — raw OHLCV + CA events per R1);
  `migrate dev --name init` applied; boots and serves `/health`.
- `apps/web`: Next 15.5 placeholder page; production build green.
- Resolved: TS 5.9.3, vitest 3.2.7, Nest 11.2.3, Next 15.5.24 / React 19.2.8,
  Prisma 6.19.3. Deviation: no root `lint` script (no ESLint configured —
  not trivial; defer). No git mutations.
- **Next (Phase 1):** Yahoo loader (pinned UA, 200ms spacing, L1–L4 rules) +
  quant-core indicators + screening engine + daily CLI shortlist.

---

## 2026-09-01 — HK corporate-action events: decided (defer with degraded flag)

- User resolved the spike's decision point 1: **v1 ships with Yahoo CA events;
  USD-declaring HK names carry a `CA_DEGRADED` flag** with long-window signals
  annotated. Eastmoney-for-events rejected as a blocking dependency (per-IP ban
  fires on first request). Proper HK CA source revisited in Phase 2.
  Recorded in `architecture-v1.md` §4.
- **Phase 0 gate is now fully passed** → next: scaffold the pnpm monorepo
  (pin `packageManager`, pnpm 12 accepted), then Phase 1 quant-core seeding
  the data-quality module from `spike/data-probe.ts`.

---

## 2026-08-31 (spike) — Phase 0 spike executed: gates pass, two decision points

### What was done
- Ran the spike (`spike/data-probe.ts`, tsx + yahoo-finance2, gitignored) per
  `docs/phase-0-data-verification.md`; full evidence in
  **`docs/phase-0-verification-report.md`**. Verdicts: G1 PASS\* (sole failure
  was defunct sample member RYL — sample-list defect, amended to SLGN),
  G2b/G3/G4/G5 PASS, G2d PASS for our math (≤0.0001% on 18 of 20 names).
  G2a NOT RUN (eastmoney IP ban persists; **tencent found to have no raw HK
  series at all** — raw cross-checks depend on eastmoney alone).
  G4: 800-ticker daily run ≈ **4.1 min**, zero 429s at 200ms spacing.
- **Key measured finding:** Yahoo's own HK `adjclose` is FX-buggy — it applies
  USD dividend amounts unconverted against HKD prices (9988.HK all 4 events,
  5.45% error; HSBC's newest event). HKD-native payers exact (2800.HK
  0.0000%). ⇒ Yahoo HK event amounts **cannot** drive local adjustment for
  USD-declaring HK names; R3 vindicated by Yahoo being inconsistent *with
  itself*.
- **R1 corrected in `architecture-v1.md`:** Yahoo v8 raw closes are **already
  split-adjusted** — no split factor in local derivation (double-counts; NVDA
  +900% error); dividend base is the previous session's close. ("Stored raw is
  split-adjusted" is now an invariant at the store boundary.)
- Other surprises logged: MMC (live NYSE large-cap) 404s on Yahoo →
  GENUINELY_ABSENT is documented as **source-scoped**; Yahoo fabricates
  zero-volume bars on HKEX holidays and has close-outside-[H,L] bars at the
  edges → loader hardening backlog (clamp/repair, holiday-bar filter,
  zombie-meta detection). pnpm 12 worked fine (no minimumReleaseAge hit).

### Decision points carried to the next design session (NOT decided by the spike)
1. **HK corporate-action events source** — Yahoo amounts unusable for
   USD-declaring names; eastmoney (G2c's named remedy) is IP-banned; tencent
   has no events/raw. Options on the table: eastmoney events-only at sentinel
   rates with degraded-flag fallback; or v1 flags affected HK names and defers.
2. Loader hardening backlog (does not change routing).

### What's next (proposed)
1. Resolve the HK-events decision point, then scaffold the monorepo
   (Phase 0 build; pin `packageManager`).
2. Phase 1: quant-core indicators + screening engine + daily CLI shortlist,
   seeding the data-quality module from `spike/data-probe.ts`.

---

## 2026-08-31 (review) — Pre-spike probing reviewed; 3 open items decided

### What was done
- Independent review of the earlier "Pre-spike data probing" session (docs +
  `docs/probes/adjustment-convention.py`). **Re-ran the probe live**
  (`--no-eastmoney`): every headline number in Appendix A reproduced exactly
  (HSBC mean −12.31% / max 40.16% / 86% bars >1%; +369.9% vs +590.8%; p95
  momentum error 10.84pp; CSPX.L USD, 0 events). Verdict: G2 withdrawal and
  invariants R1–R4 are sound and measured, not asserted.
- Fixed four nits found by the review, all in `architecture-v1.md`:
  HSBC dividends are **USD**-declared, not GBP (§4); R1's formula now includes
  the **split factor** (§4.2 — dividends-only adjustment silently breaks on
  split names like NVDA 10:1); window footnote on the §4.2 evidence table
  (raw column from 2021-08-31, return columns from the 2021-10-18 common
  start); sentinel explicitly scoped to the **HK lane only** (§4.3 — US/LSE
  rely on G2d + Yahoo-internal consistency).
- Decided the session's three open items (user-approved):
  (a) spike deps in a **throwaway gitignored `spike/` dir**;
  (b) sample slots filled: US mid-caps **PKG, RYL, FDS**; fake **NOSUCHTICKER**;
  delisted **TWTR**; HK edge = 2 lowest-turnover names picked by the spike at
  runtime from a candidate list (choice logged);
  (c) gate **G1** = ≥98% overall **and ≤1 failure per market lane**.

### What's next (proposed)
1. Hand the spike to the **fast tier**: `spike/data-probe.ts` (tsx +
   yahoo-finance2), porting the check logic from the committed Python probe;
   run the ~30-ticker sample against G1–G5; write
   `docs/phase-0-verification-report.md`.
2. Only if gates pass: scaffold the pnpm monorepo (pin `packageManager`; the
   spike install doubles as the pnpm-12 acceptance test).

---

## 2026-08-31 (later) — Pre-spike data probing: gate G2 rewritten, routing table revised

### What was done
- Confirmed the agreed order of work: **spike first, scaffold second**
  (phase-0 doc §3 + this file's own "what's next"). Checked the environment:
  node 22.23 / pnpm 12.0.0 / tsx 4.23.13 present, and Yahoo + stooq + tencent
  endpoints all answered HTTP 200 from this machine → spike is runnable today.
- Found that **gate G2 as written was not a valid test**, so ran the decisive
  part of the spike early with throwaway Python probes: pulled `0005.HK`,
  `0700.HK`, `MSFT`, `CSPX.L` (5y daily) from Yahoo (raw + `adjclose` +
  dividend events), tencent `hkfqkline`, and eastmoney `push2his` at three
  `fqt` settings, and compared them bar by bar.
- **Measured the adjustment problem on HSBC (0005.HK, 5y):** Yahoo is
  multiplicative (2021 bar 41.45 → adj 30.74), tencent/eastmoney 前复权 is
  additive (→ 23.31 / 18.91). Same stock, same dates: mean deviation
  **−12.3%**, max **40.2%**, **86% of bars beyond 1%**, and implied 5y total
  return **+369.9% vs +590.8%**. Even `0700.HK` (3.9% cumulative dividends)
  hits **9.2%** max deviation with 40% of bars beyond 1%, with the error
  **peaking at the 2022 price trough** — where reversal/dip signals fire.
  Rolling 20d-momentum error p95 **10.8pp** on HSBC: enough to re-order a
  shortlist. Mechanism proved exactly (Yahoo Σ dividends 22.89 = eastmoney
  `raw − qfq` 22.89), and the additive series was reconstructed from Yahoo's
  own event list to within 0.6pp → **local adjustment is feasible**.
- **Convention-free comparison works:** raw closes Yahoo vs eastmoney agree at
  mean **0.00%**, max **0.27%**, 1226/1227 dates aligned. That is what a
  cross-source gate can actually test.
- Probed the fallback paths and found three real hazards: **stooq serves a
  JavaScript proof-of-work challenge page instead of CSV** (HTTP 200 + HTML,
  `POST /__verify`) → dropped from the routing table, leaving the US lane with
  no free second source; **tencent needs 5-digit `hk00005`** (Yahoo needs
  4-digit `0005.HK`) and returns **HTTP 200 with an empty bar array** for the
  4-digit form — a bad request that looks like "no data exists"; **eastmoney
  hard-drops the connection** (IP ban) after ~5 requests at 0.35s spacing.
  Also: Yahoo 429s instantly on a long Chrome `User-Agent` but returns 200 in
  130ms with `Mozilla/5.0` → UA must be pinned in the loader.
- Confirmed Yahoo's HK **corporate actions** are the actual weak spot, not its
  bars: HSBC dividends arrive as `0.783188` / `0.78378403` — 8 decimals,
  unequal across quarters, on an HKD-quoted stock ⇒ Yahoo FX-converts a
  GBP-declared dividend. Re-scoped the risk from "HK data quality" to "HK CA
  data quality".
- De-risked gate G3 partially: `CSPX.L` reports `currency: USD` with **0**
  dividend events (USD-accumulating share class), so the GBX/pence 100× trap
  mostly threatens GBP *ordinaries*, which are not in the UCITS lane.
- Rewrote the affected docs: `phase-0-data-verification.md` (§1 routing table,
  §2 risk statuses, §3.3 validation method, gate **G2 → G2a–G2d**, §3.4 probes,
  new **Appendix A** with all measured numbers), `architecture-v1.md` (§2 new
  Market-data decision row, §4.1 probed routing table, new **§4.2 invariants
  R1–R4** with the evidence table, new **§4.3** single-provider posture +
  weekly sentinel, §5 pipeline steps 1–2, §11 risks 5–6).

### Key decisions
- **R1 store raw + corporate-action events; derive the adjusted series locally**
  with one documented multiplicative back-adjustment. No provider's convention
  enters signal math. *(The alternative — trust Yahoo's `adjclose` and defer
  local adjustment to Phase 4 — was explicitly rejected: it leaves the screen
  dependent on an uninspectable provider factor table that silently
  FX-converts, and makes every fallback unusable.)*
- **R2 dual series with different jobs:** adjusted for signals, **raw** for
  every displayed price and order entry.
- **R3 no-splice rule:** one instrument's series comes from one provider only;
  a fallback may supply raw bars, after which the whole series is re-derived
  (a mid-window splice would inject a phantom ~12% jump into momentum).
- **R4 cross-source validation compares only convention-free quantities** —
  raw closes, session-date index, CA event sets. Never adjusted prices.
- **Single provider confirmed as the design:** Yahoo is the only free no-key
  source spanning US + HK + LSE-UCITS in one API with the correct convention,
  and probing showed every alternative is more fragile, not less. Second
  sources are demoted to **per-ticker repair** plus a **weekly 10-ticker
  sentinel** (~10 req/week) that exists to catch a provider silently rewriting
  history. Bulk cross-source validation is out of v1.
- **Gate G2 replaced** by G2a (raw close ≥99% within 0.1%, none beyond 0.5%),
  G2b (date index ≥99.5%, every mismatch named), G2c (CA events; **no hard
  fail** — it is the measurement of Yahoo HK event quality), G2d (our own
  adjustment vs Yahoo `adjclose` ≤0.05%, i.e. tests our code, not the feed).
- **G5 extended**: HTTP 200 + empty bar array, and dropped connection, both map
  to `FETCH_FAILED` — never `GENUINELY_ABSENT`.
- If G1 forces a per-market demotion to eastmoney/tencent, two providers must
  coexist and R1's local adjustment becomes blocking from day one rather than
  phased.

### What's next (proposed)
1. Hand the spike to the **fast tier** (`qwen3.8 flash`) — design questions are
   now closed and recorded; `scripts/data-probe.ts` + `docs/phase-0-verification-report.md`
   are execution. The check logic already exists and is committed at
   `docs/probes/adjustment-convention.py` (re-verified: reproduces every
   Appendix A number) — port it rather than rewrite it.
2. Three small items still need the user's nod before coding (they are spec
   holes, not design forks): (a) spike deps live in a throwaway gitignored
   `spike/` dir so a root `package.json` isn't the back door into monorepo
   scaffolding; (b) the 4 unfilled sample slots in §3.1 (2–3 S&P mid-caps, 1–2
   illiquid/halted HK names, one fake + one delisted symbol); (c) G1's "≥98%"
   granularity — 1 failure in a 30-ticker sample is 96.7%, so state per-market
   minimums or an absolute failure count.
3. **Unagreed side finding (pnpm):** v12 *is* the Rust rewrite (verified: the
   npm package is a wrapper that links a 32MB Mach-O from `@pnpm/exe.*`, its
   strings contain `pnpm/crates/*.rs`, and its own `--help` banner says
   "Experimental"). But it is 5 days old and not the npm `latest` tag (11.24.0),
   `--ignore-scripts` leaves a broken placeholder binary, and v11+'s default
   `minimumReleaseAge: 1 day` will reject a <24h-old dep version with a
   misleading "no matching version". Performance is not a reason to care here
   (~20ms warm either way). Proposal: keep 12.x locally, pin `packageManager`
   in the root `package.json` at scaffold time, note the
   `minimumReleaseAge` gotcha in `AGENTS.md`, and let the 2-dep spike install be
   the acceptance test (rollback = one line, pin `11.24.0`).

---

## 2026-08-31 — Phase 0 data verification plan documented

### What was done
- Read the vendored `data-routing` and `yfinance` skills end-to-end; extracted
  operational intelligence that reshapes Phase 0 (Vibe-Trading ranks yfinance
  last for HK; Yahoo IP-ban behavior; 4-digit HK padding; auto_adjust
  semantics; stooq/tencent as free no-key fallbacks).
- Wrote `docs/phase-0-data-verification.md`: spike-first verification plan —
  ~30-ticker stratified sample (US/HK/LSE + edge cases), automated Day-17
  checks per ticker, cross-source validation (yahoo vs stooq/tencent, 1%
  tolerance), rate-limit probe, and 5 acceptance gates (G1–G5) with explicit
  fallback actions per gate.

### Key decisions
- **Free no-key sources only** for v1 routing: Yahoo primary, stooq (US) +
  tencent (HK) fallbacks. Alpha Vantage dropped as bulk fallback (free tier
  ≈ 25 req/day — per-ticker rescue at best). A-share sources (akshare/
  tushare) out of scope entirely.
- **Spike before scaffold**: a throwaway `tsx` script verifies the stack
  empirically before any monorepo code; its check functions later seed
  `packages/quant-core`'s data-quality module.
- LSE **GBX/GBP trap** added as gate G3 (100× scale risk on `.L` tickers).

### What's next (proposed)
1. Execute the spike: build `scripts/data-probe.ts`, run the sample, write
   `docs/phase-0-verification-report.md` with gate verdicts.
2. Only after gates pass: scaffold the pnpm monorepo (Phase 0 build).

---

## 2026-08-31 — Skills-reuse review → architecture amendments + vendored corpora

### What was done
- Reviewed `docs/research-github-skills-reuse.md` (934-line audit of 9 top
  trading repos) against our v1 scope, focusing on market data collection and
  technical analysis implementation.
- Amended `docs/architecture-v1.md`:
  - §4: replaced "silently excluded from screening" with the loud three-way
    `DataOutcome` taxonomy (OK / GENUINELY_ABSENT / FETCH_FAILED), degraded-run
    marking, and a data-integrity header in the daily report (resolves the
    conflict flagged in the audit's §15.2).
  - §4: added declarative data-routing table requirement + tencent/longbridge
    as identified HK fallbacks if Yahoo fails the Phase 0 gate.
  - §5: pipeline steps updated for typed outcomes and integrity header.
  - §7: dual signal representation (5-tier rating + continuous conviction
    ∈ [-1,1] + abstain ≠ neutral) and PromptCache-keyed decision log
    (cache + audit + debug, $0 reruns).
- Vendored reference skill corpora (both MIT, shallow sparse clones, outside
  the repo): `~/vendor/Vibe-Trading/agent/src/skills` (90 skills) and
  `~/vendor/ccxt/.claude/skills` (24 skills + `skills-lock.json`).
- Registered both skill dirs in `~/.pi/agent/settings.json` (`skills` array)
  so pi sessions can consult them as reference prose.

### Key decisions
- Loud, typed data failures over silent exclusion — a silent rate-limit batch
  must never read as "no opportunities today."
- Dual signal representation adopted: 5-tier rating for UI, continuous
  conviction for Phase 4 backtesting, abstain excluded from blend numerator
  AND denominator.
- MIT corpora are reference-only knowledge sources: read the prose,
  reimplement in TS. freqtrade/OpenBB/Fincept remain ideas-only (licenses).

### What's next (proposed)
1. Phase 0: scaffold monorepo; data ingestion + quality report (gate: Yahoo
   HK/US/LSE data quality).
2. Write our own first skills in `.agents/skills/` (data-routing,
   data-quality-gate, universe-lanes, hk-tax-treatment — per audit §12
   Phase 1) once the repo skeleton exists.
3. Consider playbooks-as-markdown for the daily pipeline and the 4-section
   report contract (core_conclusion / data_perspective / intelligence /
   battle_plan) when building Phase 2.

---

## 2026-08-30 — Platform architecture decided (stock picker v1)

### What was done
- Reviewed TradingAgents (v0.3.x) live: a per-ticker decision engine (analyst
  team → bull/bear debate → trader → risk → PM verdict), no universe
  screening/execution — the "which stocks deserve attention" gap is ours.
- Ran a 3-round decision session; all major forks confirmed (see doc).
- Wrote `docs/architecture-v1.md`: full design, repo layout, daily pipeline,
  three market lanes, build order (Phases 0–4).

### Key decisions
- **Objective**: agentic platform, v1 = stock picker; user trades manually.
  Agents propose, quant core disposes.
- **Markets**: HK + US stocks/ETFs, plus a separate simple weekly lane for
  Irish UCITS ETFs (15% dividend WHT per `docs/tax-comparison-hk-us-stocks-etfs.md`).
  Brokers later: Futu/moomoo + IBKR.
- **Stack**: pure TypeScript — pnpm monorepo, Nest.js API + Next.js chat UI
  (consistent with `docs/research-nestjs-vs-go-platform-choice.md`),
  `packages/quant-core` (the 24-day course in TS) + `packages/agents` (lean
  TradingAgents pattern reimplemented, not reused). SQLite via Prisma.
- **Pipeline**: daily after close (16:45 HKT HK / 06:00 HKT US) → data-quality
  gate → technical-first screen (~800 liquid tickers → top 10–15/market) →
  lean LLM deep-dive (2 analysts → bull/bear debate → structured verdict,
  ~6–8 calls/stock) → persisted report.
- **LLMs**: Kimi (Moonshot) workhorse + budget open models, OpenAI-compatible
  env-config. Data: `yahoo-finance2` + Alpha Vantage behind Day-17
  Reader/Loader interface.
- Out of v1: execution, backtest, portfolio. Phase 4 backtests the screen
  itself (Day 15/23 discipline).

### What's next (proposed)
1. Phase 0: scaffold monorepo; data ingestion + quality report. Gate: verify
   Yahoo data quality for HK/US/LSE tickers before building screening on it.
2. Phase 1: quant-core indicators + screening engine + daily CLI shortlist.

---

## 2026-08-30 — Research: GitHub skills audit (9 top trading repos)

### What was done
- Created `docs/research-github-skills-reuse.md` — inspected the **actual
  source trees** (GitHub API + raw file reads, not README summaries) of
  TradingAgents 102k★, OpenBB 72k★, daily_stock_analysis 64k★,
  ai-hedge-fund 63k★, freqtrade 54k★, Qlib 48k★, ccxt 44k★,
  Vibe-Trading 32k★, FinceptTerminal 31k★.
- **Only 4 of 9 ship real SKILL.md files**: Vibe-Trading (**90 skills**),
  ccxt (**24 skills**), daily_stock_analysis (1), FinceptTerminal (runtime
  *learned* skills). The two highest-starred agentic repos (TradingAgents,
  ai-hedge-fund) ship zero skills — but the strongest architecture patterns.
- **Major discovery:** ai-hedge-fund was silently rewritten into a clean 93-file
  quant core. Extracted: `AlphaModel` ABC unifying quant + LLM personas into
  one conviction-valued `Signal`; the three-way failure contract (data errors
  RAISE, LLM errors ABSTAIN, empty means genuinely-absent); `abstain ≠ neutral`
  in blending (excluded from numerator AND denominator); triple-purpose
  `PromptCache`; "conviction requests, risk disposes" with the
  clamp-to-cash-never-redistribute rule; `FundSpec` YAML mandate hierarchy;
  CPCV + PBO overfitting validation.
- **Major discovery:** Vibe-Trading ships 90 MIT skills incl. HK-specific
  `hk-connect-flow`, `etf-analysis`, `dividend-analysis`, plus 462-alphas Alpha
  Zoo, 30 YAML swarm-team presets, the `data-routing` router skill
  (test-enforced against the source registry), markdown research playbooks with
  cron frontmatter, a strategy decay state machine, fail-closed ordered mandate
  checks, and a hash-chained governance ledger.
- Documented ccxt's skills *distribution* engineering: provenance split
  (`.claude/skills/` own 9 / `.agents/skills/` vendored 15 / 15 symlinks
  bridging), `skills-lock.json` content hashes, POSIX-sh installer targeting
  4 harness dirs, and 7 parallel agent-discovery surfaces.
- Catalogued 23 ranked reusable patterns with source, effort and rationale;
  mapped each to a specific one of our modules; listed 8 explicit anti-patterns
  NOT to copy; flagged license risk (freqtrade GPL-3.0, OpenBB + FinceptTerminal
  NOASSERTION — ideas only, no vendoring).
- Cross-checked against pi's own skills doc: pi implements the Agent Skills
  standard and loads `~/.agents/skills/` and project `.agents/skills/` natively,
  so ccxt's vendored set and Vibe-Trading's 90 skills are usable today with
  zero conversion.
- **Reconciled the whole audit against `docs/architecture-v1.md`** (written
  after the landscape research, before this audit) in a new §15:
  - **Withdrew** the "run vibe-trading-mcp as a backend" recommendation —
    v1 locks *pure TypeScript, no Python service*. Phase 0 is now read-only
    reference mining (keeps the guarantee intact), with the out-of-band option
    documented consciously since Python would live in the agent harness, not the
    pipeline.
  - **Flagged a real conflict:** v1 §4 says a ticker failing data-quality checks
    is *"silently excluded from screening"*, which contradicts this audit's
    single most-repeated finding (ai-hedge-fund: silently-empty-on-failure
    "poisons backtests, because missing data is indistinguishable from 'no
    signal'"). Proposed keeping the exclusion but making it loud and typed via a
    three-way `DataOutcome` (OK / GENUINELY_ABSENT / FETCH_FAILED), a
    data-integrity header in the daily report, and a **degraded** run status.
    With ~800 tickers and Yahoo-only fallback, a silent 429 batch could gut the
    HK lane while the report reads normal.
  - **Re-tiered scope:** v1 is a stock picker, so mandate enforcement, risk
    clamps, decay state machine, governance ledger and CPCV/PBO move to
    Phase 4+ in a dedicated deferral table.
  - **Corrected stale assumptions** in the NestJS doc: universe is ~800 tickers
    (not 50–200) and there are two daily runs (16:45 + 06:00 HKT). Conclusion
    unchanged — still sub-second compute and ~99.9% idle.
  - **Confirmed v1's design on 7 independent points** (agents-propose/core-
    disposes, structured outputs, decision log, separate debate-free Irish
    UCITS lane, provider abstraction, pattern-not-code reuse) and found one
    free upgrade: keying the decision log by prompt hash also yields $0 reruns.
  - **Surfaced one representation decision:** v1's 5-tier rating vs
    ai-hedge-fund's continuous conviction ∈ [-1,+1]. Recommend storing both —
    rating for the UI, conviction so Phase 4 backtesting isn't degraded by
    bucketing.

### Key decisions
- **Adopt the agent-skills format for our own knowledge packaging** — start with
  7 skills (not 90): `data-routing`, `mandate`, `hk-tax-treatment`,
  `backtest-diagnose`, `signal-authoring`, `data-quality-gate`, `universe-lanes`.
  The last two are ours alone — no surveyed repo has them.
- **Adopt ai-hedge-fund's contracts wholesale** — the failure taxonomy and
  abstain semantics are cheap now and un-retrofittable later.
- **Mine skill content, don't depend on Python runtimes** — Vibe-Trading/ccxt
  are MIT reference material under v1's pure-TypeScript constraint.
- **Strategies become YAML specs, not code** — so an agent can propose one and
  our validator can accept or reject it (Phase 4; v1 output is a ranking).
- **Documented the license boundary explicitly** so no GPL code enters the tree.

### What's next (proposed)
1. **Resolve the §15.2 silent-exclusion conflict** — confirm the three-way
   `DataOutcome` amendment to architecture-v1 §4.
2. Decide the Phase 0 gate: pure-TS only, or allow out-of-band Vibe-Trading MCP
   for ad-hoc HK research if `yahoo-finance2` proves too thin for HK small-caps.
3. Scaffold `.agents/skills/` with the 7 skills above; add the router-vs-registry
   consistency test.
4. Encode `Signal{conviction, reasoning, abstained}` + `DataOutcome` as the
   first `packages/quant-core` shared types (alongside v1's 5-tier rating).
5. Write `playbooks/hk-close.md` and `playbooks/us-close.md` in the playbook
   frontmatter format before writing any scheduler code.

---

## 2026-08-30 — Research: NestJS vs Go platform choice (supersedes Go decision)

### What was done
- Created `docs/research-nestjs-vs-go-platform-choice.md` — a context-aware
  re-evaluation of the language choice given the actual deployment reality:
  single Mac Mini, daily batch processing, solo developer, no existing code.
- Quantified the real daily workload: ~30–90s total run time, 99.9% idle,
  bottleneck is always network I/O (API calls, LLM calls), never compute.
- Mapped NestJS module system 1:1 to our 7-module architecture — DI +
  decorators handle wiring that would be manual in Go.
- Compared ecosystems: TypeScript wins decisively on LLM/AI SDKs (Vercel AI
  SDK, LangChain.js, official MCP SDK), which are core to an *agentic*
  platform. Go wins on raw compute but the advantage is irrelevant at daily
  frequency.
- Estimated ~40% less code and ~30% faster time-to-first-backtest in NestJS.

### Key decisions
- **NestJS (TypeScript) recommended over Go** for this project.
- Go's advantages (single binary, 2–3x speed, concurrency) solve problems
  we don't have. NestJS's advantages (DI, AI SDKs, full-stack, velocity)
  solve problems we do have.
- Money safety via `decimal.js` + Zod + branded types (not as strong as Go's
  `shopspring/decimal` + compile-time types, but sufficient).
- SQLite via Prisma as the database (zero-config, single-file, Mac Mini).
- PM2 as process manager.
- Go revisited only if: intraday tick-level frequency, multi-machine scaling,
  or 10K+ parameter sweeps become requirements.

### What's next (proposed)
- Set up NestJS monorepo with `pnpm` workspace + Turborepo.
- Scaffold the 7-module architecture in NestJS.
- Implement `decimal.js` money safety pattern from Day 1.
- Begin with Market Data module (Day 17 equivalent).

---

## 2026-08-30 — Research: Quant library language choice (Go vs Rust)

### What was done
- Created `docs/research-quant-library-language-choice.md` — comprehensive
  analysis of programming language choices for building quant trading systems.
- Surveyed the open-source quant ecosystem across Python, C++, Go, Rust, C#,
  and Java with live GitHub star counts.
- Documented known technology stacks of top hedge funds (Renaissance, Two
  Sigma, Citadel, DE Shaw, Jane Street, Jump Trading, HRT, etc.) — the
  universal pattern is polyglot: Python research → C++/Java execution.
- Deep Go vs Rust comparison covering: performance benchmarks, ecosystem
  maturity, architecture fit for our 7-module pipeline, hiring, and tooling.
- Scored our 7-module architecture against both languages — Go wins on
  breadth (43/55 vs 40/55), Rust wins on compute-intensive modules.
- Recommended a hybrid approach: Go primary (Phase 1), Rust escape hatch
  for backtest hot paths (Phase 2, future).

### Key decisions
- **Go confirmed as primary language** — our strategy frequency (daily/
  hourly bars), agent integration needs, and existing codebase all favor Go.
- Rust only needed later if parameter optimization becomes the bottleneck.
- `shopspring/decimal` recommended for all financial math (never float64).
- `cinar/indicator` recommended for technical analysis indicators.
- Study `barter-rs` (Rust) and `freqtrade` (Python) for architecture patterns.

### What's next (proposed)
- Begin implementing the Go modules using `shopspring/decimal` for money math.
- Evaluate `cinar/indicator` for integration into the Day-18 indicator module.
- Use the tax analysis doc to drive asset selection in the strategy layer.

---

## 2026-08-30 — Tax comparison analysis: HK vs US stocks & ETFs

### What was done
- Created `docs/tax-comparison-hk-us-stocks-etfs.md` — a comprehensive tax
  analysis for a Hong Kong resident trading HK-listed and US-listed stocks
  and ETFs.
- Covers: capital gains (0% both), dividend withholding (0% HK vs 30% US vs
  15% Irish-domiciled), interest income (portfolio interest exemption), US
  estate tax exposure (up to 40% on US-situs assets > US$60K), and Irish-
  domiciled ETFs as the recommended alternative.
- Includes worked examples, estate tax rate schedule, popular Irish-domiciled
  ETF ticker list (CSPX.L, VWRA.L, VUSA.L, ISAC.L, EIMI.L), accumulating vs
  distributing comparison, and 6 action items for decision-making.

### Key decisions
- Documented in `docs/` (not `knowledge-base/`) as this is reference material
  for investment decisions, not course-slide extraction.
- Irish-domiciled ETFs recommended as the default vehicle for US/global equity
  exposure — saves 15% dividend withholding and eliminates US estate tax.
- Accumulating ETFs preferred over distributing for additional tax efficiency.

### What's next (proposed)
- Use this analysis to drive asset allocation decisions when building the
  portfolio module.
- Consider integrating tax-aware position sizing into the trading engine
  (e.g., prefer Irish-domiciled ETFs in signal generation).

---

## 2026-08-30 — Day 21, 22, 23, 24 knowledge extraction → topic docs

### What was done
- Read the JPG slides of `knowledge-base/day_21/` (IMG_6639–6646, 8 slides),
  `day_22/` (IMG_6647–6654, 8 slides), `day_23/` (IMG_6655–6662, 8 slides)
  and `day_24/` (IMG_6663–6670, 8 slides) of "30天学习量化投资" using the
  macOS Vision OCR tool.
- Created four self-contained HTML docs in `docs/`, matching the existing style:
  - `docs/day_21_backtest-engine.html` — Backtest Engine (回测引擎): the
    system orchestrator / director analogy; complete 6-module pipeline (Market →
    Strategy → Order → Broker → Portfolio → Performance); module I/O table;
    tracing one Bar through 6 steps; Engine responsibilities vs non-responsibilities;
    Go Engine struct and Run() pseudocode with the main loop.
  - `docs/day_22_performance-analyzer.html` — Performance Analyzer (绩效分析):
    position in pipeline; three core metrics — Return (how much earned), Max
    Drawdown (worst pain), Sharpe Ratio (risk worth it?); Sharpe reference scale;
    two-strategy comparison (aggressive vs steady); Go struct design with
    PerformanceReport; 7-step computation pipeline.
  - `docs/day_23_parameter-optimization-overfitting.html` — Parameter Optimization
    & Overfitting Prevention (参数优化与防过拟合): parameters as strategy knobs;
    multi-metric batch testing; overfitting signs; single-point trap (isolated
    peaks vs stable plateaus); 2D parameter heatmap with color-coded cells;
    out-of-sample validation with time split; scientific 4-step optimization flow.
  - `docs/day_24_strategy-portfolio.html` — Strategy Portfolio (策略组合):
    Strategy vs Portfolio roles; why combinations are needed (market regime
    cycling); capital allocation with weight bars; correlation explained;
    low-correlation profit/loss offset mechanism; more strategies ≠ better
    diversification (need different return sources); 6-step portfolio construction
    process.
- Verified all four docs render with headless Chrome screenshots; no rendering
  issues found; temporary screenshots deleted.

### Key decisions
- Day 22 reuses the Sharpe scale component from Day 12 for visual consistency.
- Day 23 introduces `.heatmap` CSS with color-coded table cells (hot/warm/cool/peak)
  for the 2D parameter sweep visualization.
- Day 24 uses `.alloc-bar` for capital allocation visualization and the
  `.compare-3` grid for three-strategy examples.
- All docs maintain the bilingual English/Chinese convention.

### What's next (proposed)
1. Continue extraction for remaining days (25–30) as folders appear.
2. Build an index/hub page linking all 24 day docs.
3. Begin implementing the Go modules based on Days 16–21 architecture.

---

## 2026-08-30 — Day 18, 19, 20 knowledge extraction → topic docs

### What was done
- Read the JPG slides of `knowledge-base/day_18/` (IMG_6615–6622, 8 slides),
  `day_19/` (IMG_6623–6630, 8 slides) and `day_20/` (IMG_6631–6638, 8 slides)
  of "30天学习量化投资" using the macOS Vision OCR tool.
- Created three self-contained HTML docs in `docs/`, matching the existing style:
  - `docs/day_18_sliding-window-incremental-sma.html` — 滑动窗口与增量SMA:
    Naive SMA O(N) problem; sliding window O(1) formula (new_sum = old_sum −
    oldest + newest); circular buffer with fixed memory and in-place overwrite
    (with visual ring buffer diagrams); Go SMA struct and Update() implementation;
    why append(window[1:], v) is bad for long-running systems; Reset() for reuse;
    don't prematurely unify Indicator interface; golden cross as edge trigger
    (state machine with IN_UP/IN_DOWN states and Go code).
  - `docs/day_19_strategy-signals-trading-logic.html` — 策略信号与交易逻辑:
    Strategy's sole job is producing signals; Signal struct definition; dual MA
    golden/death cross with state machine; Signal ≠ Order ≠ Trade; same signal
    can produce different outcomes; BUY execution checklist (5 checks); SELL
    execution checklist (5 checks); responsibility boundaries table (Strategy →
    Risk → Order → Broker → Portfolio); complete 8-step trading chain with
    pseudocode.
  - `docs/day_20_trade-simulation-transaction-costs.html` — 成交模拟与交易成本:
    Strategy thinks / Broker executes; ideal vs real fill; slippage definition
    and cumulative impact table; commission types (brokerage, exchange, stamp
    duty) with worked buy/sell examples; complete BUY calculation walkthrough
    (signal → slippage → fill → qty → amount → commission → deduction → account
    update); why costs destroy strategies (gross vs net comparison); high vs low
    turnover cost comparison; slippage control methods.
- Verified all three docs render with headless Chrome screenshots; no rendering
  issues found; temporary screenshots deleted.
- Day 21 folder exists but is empty — skipped.

### Key decisions
- Day 18 introduces `.ring` CSS component for circular buffer visualization
  (colored cells with index labels showing in-place overwrite).
- Day 19 uses `.checklist` component with colored icons for BUY/SELL execution
  checks. State machine flow diagram for IN_UP/IN_DOWN transitions.
- Day 20 uses `.cost-bar` component for visualizing gross return vs cost erosion.
  Three-column comparison for before/after/cost account states.
- All docs maintain the bilingual English/Chinese convention.

### What's next (proposed)
1. Continue extraction for remaining days as folders appear.
2. Build an index/hub page linking all 20 day docs.
3. Begin implementing the Go modules: CSV reader (Day 17) → SMA indicator
   (Day 18) → Strategy signals (Day 19) → Broker simulation (Day 20).

---

## 2026-08-30 — Day 14, 15, 16, 17 knowledge extraction → topic docs

### What was done
- Read the JPG slides of `knowledge-base/day_14/` (IMG_6583–6590, 8 slides),
  `day_15/` (IMG_6591–6598, 8 slides), `day_16/` (IMG_6599–6606, 8 slides)
  and `day_17/` (IMG_6607–6614, 8 slides) of "30天学习量化投资" using the
  macOS Vision OCR tool.
- Created four self-contained HTML docs in `docs/`, matching the existing style:
  - `docs/day_14_risk-control-backtest-framework.html` — 风险控制与第一版回测框架:
    Three-layer risk control system (single-trade / position / account-level);
    risk budget → per-share risk → risk-allowed quantity formula; position limit
    and the min() rule for final buy quantity; account-level brake system (2% daily
    loss stop, 10% drawdown halve, 15% kill switch); stop-loss reality (gap-down
    risk); first backtest framework integrating risk into the pipeline.
  - `docs/day_15_hypothesis-to-strategy.html` — 从假设到策略: The scientific
    method for strategy development (hypothesis → rules → backtest → OOS →
    explain → launch); market hypotheses (trend continuity, mean reversion, etc.);
    translating hypotheses into quantifiable rules (semiconductor ETF trend
    strategy example); multi-dimensional validation; interpretability as the key
    to surviving drawdowns; 5-question pre-launch checklist.
  - `docs/day_16_go-project-structure.html` — Go量化项目结构: Project directory
    layout with `cmd/` + `internal/` + `data/`; modular monolith vs microservices
    rationale; 7 core modules with responsibilities; backtest time-loop
    orchestration; Go `internal/` directory import boundaries; dependency inversion
    with Strategy interface (Go code examples); unit testing pyramid and Go test
    patterns.
  - `docs/day_17_csv-market-data-reader.html` — CSV行情读取: CSV format → Bar
    struct conversion; io.Reader design for data-source decoupling; two-layer
    interface (Reader parses, Loader fetches); Reader responsibility boundaries
    (should/should-not do); comprehensive data quality checklist (7 error
    categories); trading-day vs natural-day time ordering rules.
- Verified all four docs render with headless Chrome screenshots; no rendering
  issues found; temporary screenshots deleted.

### Key decisions
- Day 14 introduces a `.layers` CSS component for the 3-layer risk control stack
  and `.compare-3` for the 3 account-level brake rules.
- Day 15 uses a `.checklist` component for the 5-question pre-launch self-check.
- Day 16 uses a `.tree` component for directory structure display and a `.pyramid`
  for the test pyramid visual. Dark-background code blocks for Go code.
- Day 17 uses a `.sources` grid for data-source types and continues the Go code
  block style from Day 16.
- All docs maintain the bilingual English/Chinese convention.

### What's next (proposed)
1. Continue extraction for remaining days as folders appear.
2. Build an index/hub page linking all 17 day docs.
3. Begin implementing the Go project structure from Day 16.
4. Implement the CSV market data reader from Day 17 as the first module.
5. Feed Day 14 risk control formulas into the risk module design.

---

## 2026-08-30 — Day 11, 12, 13 knowledge extraction → topic docs

### What was done
- Read the JPG slides of `knowledge-base/day_11/` (IMG_6550–6553, 4 slides),
  `day_12/` (IMG_6554–6557, 4 slides) and `day_13/` (IMG_6558–6565, 8 slides)
  of "30天学习量化投资" using the macOS Vision OCR tool.
- Created three self-contained HTML docs in `docs/`, matching the existing style:
  - `docs/day_11_parameter-optimization-overfitting.html` — 参数优化与过拟合:
    Overfitting definition and programmer analogy (memorizing vs learning);
    parameter plateaus vs isolated peaks (with inline SVG bar charts);
    why the highest-return parameter (MA7=35%) is dangerous while the plateau
    (MA5/6/8/9=17-20%) is reliable; out-of-sample testing (train on 2015-2022,
    validate on 2023-2025); decision checklist.
  - `docs/day_12_volatility-sharpe-ratio.html` — 波动率与夏普比率: Volatility as
    "bumpiness" (with SVG equity curves for low vs high vol); Sharpe Ratio formula
    and 5-band visual scale (<0 poor to >3 excellent, with overfitting warning);
    Sharpe vs Max Drawdown comparison (complementary, not substitutable);
    Strategy A (18%/9% vol/Sharpe 2.0) vs B (25%/20% vol/Sharpe 1.25) worked
    comparison.
  - `docs/day_13_position-sizing.html` — 仓位管理: Position definition and
    terminology (满仓/半仓/轻仓/空仓 with visual bars); how position amplifies
    both gains and losses (symmetric tables); fixed position sizing (auto-scaling
    with equity, 4 advantages, conservative/balanced/aggressive ranges); dynamic
    position sizing (volatility-based allocation with SVG curve); leverage as
    multiplier (Sharpe unchanged, no Alpha creation); real Alpha comes from
    strategy improvement; 3-scenario practice exercise.
- Verified all three docs render with headless Chrome screenshots (top + full-page);
  no rendering issues found; temporary screenshots deleted.

### Key decisions
- Day 11 uses inline SVG bar charts to contrast parameter plateaus (flat green bars)
  vs isolated peaks (single red spike) — visual communication of the core concept.
- Day 12 introduces a 5-band Sharpe scale component for quick visual reference.
- Day 13 introduces `.pos-bar` (position bar) and `.compare-3` (3-column grid)
  components to visualize capital allocation.
- All docs continue the bilingual English/Chinese convention.

### What's next (proposed)
1. Continue extraction for remaining days as folders appear.
2. Build an index/hub page linking all 13 day docs.
3. Feed Day 11 overfitting concepts into backtest module validation pipeline.
4. Feed Day 12 Sharpe/volatility metrics into backtest report outputs.
5. Feed Day 13 position sizing into portfolio/risk module design (fixed vs dynamic
   allocation, leverage constraints).

---

## 2026-08-30 — Day 8, 9, 10 knowledge extraction → topic docs

### What was done
- Read the JPG slides of `knowledge-base/day_8/` (IMG_6527–6533 + IMG_6542 cover,
  8 slides), `day_9/` (IMG_6534–6541, 8 slides) and `day_10/` (IMG_6543–6549,
  7 slides) of "30天学习量化投资" using the macOS Vision OCR tool from
  `knowledge-base/day_6/.tools/ocr`.
- Created three self-contained HTML docs in `docs/`, matching the day_6/7 style:
  - `docs/day_8_order-trade-fees-slippage.html` — 订单、成交、手续费与滑点:
    Order vs Trade (intent vs result); the complete Signal→Order→Trade→Portfolio
    chain; slippage definition, sources, and return impact; commission fee formula
    and accumulation effect; partial fills and market depth; a full-cost worked
    calculation (buy 2000 @ 10.05 with 万三 fee); the five hidden costs that make
    real returns fall short of ideal backtests.
  - `docs/day_9_equity-curve-drawdown.html` — 收益曲线、累计收益与最大回撤:
    Equity Curve as the strategy's biography (with SVG chart); cumulative return
    formula and three outcomes (profit/break-even/loss); current drawdown from
    peak; Maximum Drawdown (MDD) computation with worked example (with SVG chart);
    returns and drawdowns coexisting (the classic "back to start but endured -23%"
    example); full practice exercise with Day 0–5 data.
  - `docs/day_10_win-rate-profit-ratio-expectancy.html` — 胜率、盈亏比与期望
    收益: Win rate (frequency ≠ quality); Profit/Loss ratio (win size vs loss
    size); Expected Return formula (the ultimate verdict); the 90%-win-rate-can-
    still-lose trap; trend strategies (low win rate, high P/L, one big win covers
    many small losses); full practice with 10-trade dataset.
- Verified all three docs render with headless Chrome screenshots (top + full-page);
  no rendering issues found; temporary screenshots deleted.

### Key decisions
- Naming follows the existing `day_N_<slug>.html` pattern established by days 1–7.
- Day 9 includes inline SVG charts for the equity curve and MDD diagrams (instead
  of ASCII art) for clearer visual communication.
- Day 10 introduces `.trade-strip` and `.gauge` CSS components for visualizing
  win/loss sequences and expectancy bars — extensions of the existing design
  language.
- All Chinese terms preserved in parentheses alongside English, consistent with
  previous docs.

### What's next (proposed)
1. Continue extraction for days 11–12 when ready.
2. Consider building an index/hub page linking all 10 (soon 12) day docs.
3. Feed Day 8 execution concepts into the `broker/` module design (slippage
   models, partial fill handling).
4. Feed Day 9–10 evaluation metrics into the `backtest/` module (equity curve,
   MDD, win rate, P/L ratio, expected return as report outputs).

---

## 2026-08-30 — Day 4, 5, 7 knowledge extraction → topic docs

### What was done
- Read the JPG slides of `knowledge-base/day_4/` (IMG_6503–6510), `day_5/`
  (IMG_6511–6518) and `day_7/` (IMG_6519–6526), same pipeline as before
  (Vision OCR via `knowledge-base/day_6/.tools/ocr` + direct visual reads,
  three parallel subagents).
- Created three self-contained HTML docs in `docs/`:
  - `docs/day_4_backtest-state-machine.html` — 回测是一个状态机: backtest replays
  history bar-by-bar in strict time order; look-ahead bias (前视偏差) as the
    deadliest sin (5 scenarios, 4 harms); the 6-step daily loop; the Flat↔Long
  two-state FSM with a 15-day dual-MA walkthrough; three core variables
    (cash / position / price).
  - `docs/day_5_time-series-and-arrays.html` — 时间序列与数组: a program sees a
  time series, not a chart; MA as a fixed-size sliding window over the last N
  closes; why averaging all history is wrong; NaN on insufficient data;
    the O(1) incremental sliding-window MA (Go struct with Update).
  - `docs/day_7_bar-signal-position-portfolio.html` — Bar、Signal、Position 与
    Portfolio: the four core data structures (Go struct contracts); Signal as a
  suggestion memo that never mutates the account; floating P&L and average
    cost rules; Equity = Cash + Σ(Qty × Price); position sizing; a full
    Bar→Signal→Risk→Broker→Portfolio worked exercise.
- Fixed two rendering issues found during verification (emoji tofu in day_5,
  `<b>` inside `.io-box` inheriting `display: block` in day_7). Re-screenshotted
  all three docs after fixes — render cleanly; temp screenshots deleted.
- Renamed the docs to `day_N_<slug>.html` (underscore after the day number) to
  match the user's rename of the day_6 doc; updated the day_1–3 filenames and
  their references in the previous PROGRESS entry accordingly.

### Key decisions
- Day 4 slide 8/8's practice table has an internal inconsistency (labels Day 14
  as the sell trigger while its own MA5/MA20 numbers show MA5 > MA20); the doc
  follows slide 6/8's internally consistent 15-day version (buy Day 10, hold
  Day 11–14, sell Day 15).

### What's next (proposed)
1. All available days (1–7) are now extracted — the knowledge base feeds the
   repo skeleton: `data/` (Day 2 + Day 7 Bar), `indicator/` (Day 3 + Day 5 MA),
   `strategy/`/`portfolio/`/`backtest/` (Day 4 + Day 6 + Day 7 contracts).
2. When day_8+ folders appear, run the same extraction pipeline.

---

## 2026-08-30 — Day 1–3 knowledge extraction → topic docs

### What was done
- Read the JPG slides of `knowledge-base/day_1/` (IMG_6480–6486, slides 2–8),
  `day_2/` (IMG_6487–6494) and `day_3/` (IMG_6495–6502) of the course
  "30天学习量化投资", using the same pipeline as day 6: Vision OCR via
  `knowledge-base/day_6/.tools/ocr` plus direct visual reads (three parallel
  subagents, one per day).
- Created three self-contained HTML docs in `docs/`, matching the day_6 style:
  - `docs/day_1_quant-investing-fundamentals.html` — 量化投资入门: core metrics
    (return, max drawdown, win rate, profit factor, Sharpe), an MA golden-cross
    trend strategy walkthrough, reading backtests, and risk control as the
    survival key. (Note: day_1 folder holds slides 2–8; the cover slide is absent.)
  - `docs/day_2_candlestick-ohlcv-data.html` — K线与OHLCV数据: OHLCV structure,
    阳线/阴线 semantics (color encodes Close vs Open only, not the intraday
    path), body & shadows, return rate vs price difference.
  - `docs/day_3_trend-moving-averages.html` — 趋势与移动平均线: "don't predict,
    follow", MA(N) computation and the sliding window, short vs long MAs, the
    dual-MA strategy, and the whipsaw weakness (鞭打效应).
- Verified all three docs render with headless Chrome screenshots; no issues
  found; temporary screenshots deleted.

### Key decisions
- One HTML doc per day in `docs/`, named `day_N-<topic-slug>.html`, reusing the
  day_6 CSS design language verbatim (plus small same-style extensions where a
  day needed new components, e.g. candlestick diagram, formula blocks).
- English as working language with original Chinese terms preserved in
  parentheses — same convention as the day_6 doc.

### What's next (proposed)
1. Continue extraction for the remaining days as their folders appear
   (days 4–5 are still missing).
2. Feed Days 1–3 concepts into the repo skeleton: `data/` (OHLCV from Day 2),
   `indicator/` (MA from Day 3), and the metrics/risk vocabulary (Day 1).

---


### What was done
- Ran a web + GitHub survey (GitHub API star counts fetched live) of platforms
  similar to our goal; compiled into
  `docs/research-agentic-trading-landscape.md`.
- Landscape splits into four layers: (A) multi-agent LLM decision frameworks
  — TradingAgents (~102k★), ai-hedge-fund (~63k★), TradingAgents-CN (~31k★);
  (B) agent-native trading harnesses — HKUDS Vibe-Trading (~32k★, shadow
  account), HKUDS AI-Trader (~22k★), LangAlpha ("Claude Code for markets");
  (C) classic engines — OpenBB, freqtrade, Lean, Hummingbot, Qlib (+RD-Agent),
  FinRL; (D) agent-to-market infra — Alpaca MCP, financial-datasets MCP,
  Kraken CLI.
- Academic layer is thin: TradingAgents paper (arXiv 2412.20138), FinMem
  (layered memory), early 2026 benchmarks (AlphaForgeBench, FinPersona-Bench);
  recurring warning across sources is backtest overfitting + no accepted
  live-trading benchmark.

### Key decisions
- **Gap identified**: no OSS project combines LLM agents + a trusted quant core
  (our seven modules) + hard non-LLM risk gates + paper→live broker path for
  personal investing — that is our defensible build target.
- Patterns to adopt: agents-proposes/engine-disposes risk gate, shadow (paper)
  account before live, MCP as the broker/data seam, persistent research
  workspace.
- All major decision-layer projects are "educational only" — code reuse needs
  license checks (TradingAgents-CN is hybrid-licensed; clones/scams exist).

### What's next (proposed)
1. Decide first market/broker target (Alpaca paper trading is the obvious
   default) and agent decision frequency.
2. Decide: reuse an engine (Lean/freqtrade) as backtest backend vs. grow our
   own seven-module core from `docs/day_6_quant-system-architecture.html`.
3. Skim-read candidates: TradingAgents paper, FinMem, RD-Agent; track
   `LLMQuant/awesome-trading-agents` for new entrants.

---

## 2026-08-30 — Day 6 knowledge extraction → architecture doc

### What was done
- Read all 8 pages of `knowledge-base/day_6/` (page_1.JPG – page_8.JPG), a Chinese
  course series "30天学习量化投资 · Day 6: 量化系统架构" covering the core
  components of a quant trading system.
- Created `docs/quant-system-architecture.html` — a self-contained (no external
  dependencies) HTML architecture document distilling the slides into the
  initial building blocks  of this project:
  1. Why modularize (monolith vs. modular)
  2. System overview: 7 core modules + backtest collaboration loop diagram
  3. Module specifications: responsibilities, I/O contracts, worked examples
     (OHLCV bars, MA5 calc, MA golden-cross strategy, AAPL fill math with
     fees/slippage, risk-rule table)
  4. Core design principles: four roles (Strategy / Risk / Broker / Portfolio),
     low coupling via stable interfaces, DIP, anti-patterns with code examples
  5. Proposed repository skeleton + inter-module data contracts table
  6. Practice roadmap (Bollinger Band breakout-sell scenario)
- Verified rendering with headless Chrome screenshots; fixed a CSS bug
  (`.tree` block missing `white-space: pre`) found during verification;
  removed the temporary screenshots afterward.

### Key decisions
- **HTML over Markdown** for the architecture doc: the content is diagram-heavy
  (module map, flow diagrams, comparison panels), and a single self-contained
  HTML file renders them better than md.
- **Seven top-level modules** adopted as the project skeleton:
  `data/`, `indicator/`, `strategy/`, `risk/`, `broker/`, `portfolio/`, `backtest/`.
- **Interface-first design (DIP)**: modules collaborate through stable
  interfaces, not direct calls. The `Strategy` interface sketch is kept in the
  slides' Go-style syntax, but the implementation language is **not decided yet**
  — the repo currently has no code, only docs and knowledge base.
- **Key domain rule recorded**: the fill report (成交回报) is the only source of
  truth for account state; Strategy never mutates Portfolio directly.
- Doc written in English (user's working language) with original Chinese terms
  annotated where they carry specific meaning.

### What's next (suggested, from Day 6 practice roadmap)
1. `indicator/` — implement Bollinger Bands BB(20,2).
2. `strategy/` — emit sell signal when close breaks above the upper band.
3. `portfolio/` / `broker/` — insufficient-balance / insufficient-position checks.
4. `backtest/` — run one simple strategy end-to-end and produce a report
   (annual return, max drawdown, Sharpe, win rate, profit factor, # trades).
5. Decide the implementation language before writing the first module.
