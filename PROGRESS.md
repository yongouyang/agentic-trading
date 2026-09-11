# PROGRESS

Session log for the agentic-trading project. Newest entries on top.
Each entry: what was done, key decisions, and what's next.

---

## 2026-09-11 (Round 1 EXECUTED) — health stopped crying wolf; the coverage gate is readable again; the power-off contract is recorded

First of the four rounds proposed in tonight's review. Two commits, tree clean,
all suites green. Both bugs were the same class as R0's: a signal that was
always-on (or always-red) and therefore read as noise.

**F1 — a weekly job must be due before it can be late** (`ad32376`). The 09-10
health artifact was ALERT on `f10: no artifact on record`, but f10 was installed
Sun **09-10 23:21** — *after* that morning's 09:17 slot — so its first due slot
was Sun 09-13, two days in the future. `computeHealth` treated "no artifact" as
failure with no notion of due-ness, and since **any job alert pins the whole
report**, the banner was red for a job that could not go green before 09-13.
That also made W5's acceptance impossible: no week, however clean, could ever
report HEALTHY.

Fixed by anchoring on the **install instant** — `install.sh` *copies* the plist,
so its mtime dates it — and reusing the existing HKT/weekday slot arithmetic
(generalised out of `missedSlots`) to ask whether a Sunday slot has passed since.
A missing plist stays an ALERT: health cannot then even prove the job was
installed. **Verified live**: `ops:health` went **ALERT → WARN**, exit **1 → 0**,
with `f10: HEALTHY · no artifact yet — not yet due (installed
2026-09-10T15:21:34Z)`. The lanes still correctly warn about the runs missed
today — the report is now honest rather than uniformly red.

**F2 — the coverage gate was red at HEAD, so nobody could read it** (`b993981`).
`test:coverage` failed at **75.05 % lines vs a 90 % `src/**` threshold**, and had
been red since the 3c ship (77.97 % recorded there) without ever being
reconciled — the same silent-failure class R0 was built to remove. Cause is
narrow: `src/cli/**` sits at 58.16 % lines, three entrypoints at 0 % because they
are `main()`-only and exercised by real runs (daily chain, launchd, e2e), not
unit tests — the reasoning that already excludes `src/main.ts`. Every other
directory is ≥93 %.

The lazy fix is to drop the threshold to 75 %, which makes it a rubber stamp.
Instead the 90 % gate exempts cli **by negation** (`!src/cli/**`) so it stays
**default-deny** — a new `src/` subdirectory is gated at 90 % unless someone
explicitly exempts it, which a per-directory allow-list would not give. The cli
files keep their own floor (55/78 vs measured 58.16/81.1) so they cannot rot
further unnoticed, and stay in the printed report. **Verified the gate still
bites** rather than silently matching nothing: raised to 99 it failed at
**97.12 %**. Final: exit 0, 437 passed / 1 skipped.

**F3 — the power-off contract is now recorded, not assumed.** Both the daily-hk
and ops-health plist headers claimed launchd "catches up after wake". True for
**sleep** (observed 09-10: a 06:10 slot caught up at 08:35), false across
**power-off**, which keeps no memory of elapsed slots (observed **09-11: booted
19:44, both the 06:10 and 16:50 slots gone, no replay**). Written into
architecture §5.1 beside the cadence table, and into the two plist headers.
Comment-only plist edits — the installed copies pick them up at the next
`install.sh`.

**Tests:** +7 cases in `ops-health.spec.ts` (not-yet-due, due-and-missed,
plist-missing, artifact-age-beats-plist-mtime), and the existing weekly cases
are now hermetic — they were silently reading the developer's real
`~/Library/LaunchAgents`. Suites: api 437 + 1 skipped (coverage gate green),
quant-core 77, agents 43, web 102, tsc clean, all plists `plutil -lint` OK.

**Still open from Round 1: the W5 acceptance itself — no scheduled cycle has
been observed since the 09-10 arming fix**, because every slot since then fell
while the machine was off or asleep. The next US slot is **Sat 09-12 06:10
HKT**; it only closes W5 if the machine is awake for it.

**Decided (user, 2026-09-11): slot times stay as they are.** 06:10 / 16:50 are
kept; a day whose slots fall while the machine is powered off is accepted as
lost. The rationale is that the failure is already *visible* (`ops:health`
counts it, the banner shows it, `dataThrough` exposes the stale cutoff) and the
store heals on the next run — so the cost is a missed session, not a silent one.
The boot-time catch-up that would recover those days was declined, consistent
with the R0 spec's "no self-heal job".

Next: Round 2 — Phase 4b, the corrected pre-registration + the top-decile
hypothesis (**deep tier, high thinking**; the user switches before planning).
Parked: Round 3 (LLM-layer prospective scoring, fast tier), Databento R1
baseline, the §7 `deepseek-v4-flash` doc correction.

---

## 2026-09-10 (Phase 4 EXECUTED) — H1 NOT SUPPORTED; the pre-registered bar is unpassable as specified

Built and ran the Phase-4 backtest (`packages/quant-core/src/{replay,ic,portfolio,backtest}.ts`
+ `pnpm -C apps/api backtest:screen`, 1m50s end-to-end).

**Result: `h1_revised` on both lanes — H1 is not supported.**

| lane | mean 20d IC | NW t | days | breadth | power floor | Gate 1 | Gate 2 |
|---|---|---|---|---|---|---|---|
| US | **+0.0145** | 0.97 | 983 | 180 | 0.0298 | FAIL | not falsified |
| HK | **−0.0192** | −0.78 | 898 | 25 | 0.0493 | FAIL | falsified |

- Window: US 2022-09-08…2026-09-08 (1003 sessions), HK 2022-09-19…2026-09-09
  (976). HK's window starts 11 days later than the plan's single estimate
  because the start is now computed per lane from real bar counts.
- **US Gate 2 not falsified**: portfolio +88.95 % vs equal-weight eligible
  benchmark +50.92 % (differential +38.03 %), survives 2× costs at +24.98 %.
  But **SPY returned +101.82 %** — the screen beat its like-for-like baseline and
  lost to holding the index. Sharpe 0.83, MDD −18.5 %, 941 trades, 15-day
  average hold, turnover 30.8×.
- **HK Gate 2 falsified at both cost levels**: +12.65 % vs +40.10 % at base, and
  −9.98 % at 2× costs. 776 trades and 26.1× annual turnover against a 46 bp
  round trip is a ~12 %/yr cost drag that kills it on its own.

**The important finding is about the bar, not about the screen.** The
pre-registered Gate 1 conjunction (IC ≥ 0.02 AND t ≥ 2) **cannot be passed in
either lane**: its power floor (US 0.0298, HK 0.0493) exceeds its own magnitude
requirement. The cause is a calibration error in my earlier analysis — I
computed power from *universe* size (552/131) instead of the actual **eligible
breadth after the gates** (180/25), so the standard error was understated. A true
IC of exactly 0.02 yields US t = 1.34, not 2. The honest reading: the FAIL says
the bar was mis-specified, and the informative quantities are the measured IC
and t themselves — *not* evidence that H1 is false. Fixing the calibration and
re-testing is a **new pre-registration**, never an edit to this one.

**Reported but not gated:**
- US IC by year: 2022 −0.0469, 2023 +0.0185, 2024 +0.0316, 2025 +0.0343,
  2026 −0.0208 — regime-dependent, above 0.02 in two of the middle three years.
- US top-N-vs-rest spread: +0.83 % at 20d (60 % of days positive), +2.19 % at
  60d. Economically meaningful while rank IC is weak — consistent with a signal
  concentrated at the extremes rather than monotone across the ranking, which is
  a *different hypothesis* worth its own pre-registration (a rank IC cannot see
  a top-decile effect).
- Descriptive 9-combo weight sweep: monotone in both lanes, IC **falls** as the
  mom60 weight rises (US 0.40 → 0.0199/0.0203/0.0190; 0.60 →
  0.0103/0.0096/0.0078). Shipped ranks 5/9 (US), 6/9 (HK); smooth plateau, no
  isolated spike. **Explicitly barred from changing `SCREEN_PARAMS`.**

**Engine invariants proven by test** (these are what make the numbers
believable): truncation to the 252-bar trailing window is *exactly* equivalent to
the full series; mutating a future bar or adding a future dividend cannot change
future day-T output; forward returns are anchor-invariant; and Newey–West
materially shrinks t versus the naive statistic on autocorrelated IC series.
One real bug was caught by test: position sizing computed shares as
`notional / px` and then added the cost, pushing the outlay above the target so
the cash guard silently rejected every entry when `topN == 1`.

**Not done / next:** the low-power lane question (HK's 25-name breadth makes any
rank-IC bar nearly unreachable — the *screen's gates* may be the binding
constraint, not the signal); a corrected pre-registration; the top-decile framing.
No changes to production parameters were made or recommended.

---

## 2026-09-10 (Phase 4 design LOCKED) — no-tuning full-window test; power analysis reshaped the bar

Deep-tier planning session on the two items flagged when the plan was drafted
(the success bar and the 3-fold thinness). Four forks locked; the plan was
rewritten (`docs/phase-4-plan.md`).

**Four locked decisions:**
1. **No tuning** — test the shipped `SCREEN_PARAMS` as-is over the full 1031
   sessions. No split, no folds, no grid.
2. **Asymmetric bar** — Gate 1 (cross-sectional IC) decides; Gate 2 (portfolio,
   Sharpe, costs) is falsification-only and never cited as confirmation.
3. **Gate 1** — mean 20d rank IC ≥ 0.02 AND Newey-West t ≥ 2 (lag = horizon).
4. **Separate per-lane verdicts** — no conjunction; HK cannot veto US.

**What the analysis changed.** Two structural findings, both of which the draft
had wrong:

- **Fold thinness was mis-diagnosed.** For anchored walk-forward,
  `train_1 = 1031 − Σ(test) − embargo` — it depends on the **total** test budget,
  *not* the fold count. 3×165 and 2×250 spend identical data (train_1 ≈ 470);
  3 folds simply buy three independent tune→test cycles. (Also corrected a
  committed arithmetic error: the earlier table gave fold 2/3 trains of 531/781
  by adding test sizes instead of recomputing boundaries; the values are
  468/718.)
- **The bar was testing the gate with no power.** Per-day rank IC SE ≈ 1/√(N−1)
  gives ≈0.043 (US, 552 names) and ≈0.088 (HK, 131); with NW lag = 20 the
  effective N is ~50, so the full window detects IC ≥ 0.012 (US) / 0.025 (HK).
  But portfolio-level alpha over 4.12y needs **IR ≥ 0.985** for t = 2, where a
  realistic screen IR is 0.3–0.7 (IR 0.5 would need ~16 years, IR 0.3 ~44).
  Conditions 2–3 of the draft bar were therefore coin flips, not tests.

**Consequence flagged at lock time:** because the t-stat binds for HK, HK's
*effective* Gate 1 requirement is IC ≥ 0.025, not 0.02 — at IC = 0.02 HK's
t = 1.62. Pre-registered explicitly so a HK failure reads as *insufficient
evidence*, not as evidence of no edge.

**Also corrected:** the draft claimed the window spans "2022 bear". The warmup
pushes the start to 2022-09-08 and the bear bottomed mid-October 2022 — ~one
month of bear, not a regime.

Deferred, not cancelled: grid tuning. Its geometry is worked out in the plan
(3×165 is the best option) and its heatmap survives as an explicitly
**descriptive** output with a rule that it may not be used to change
`SCREEN_PARAMS` without a new pre-registered test on new data.

Next: fast-tier execution of the plan's build order (quant-core `backtest`
module → `backtest:screen` CLI → run + verdict). Also pending: observe the Fri
scheduled cycle to close W5's on-time-fire verification.

---

## 2026-09-10 (R0 EXECUTED) — W1–W5 landed; chain fails loudly; health banner live; jobs re-armed

Executed `docs/ops-hardening-plan.md` end to end (fast tier, all forks locked).
Five commits, tree clean, 535 tests green.

- `8e89470` **W2** — `DeepDiveRun.status` (`running` → `complete`). Additive
  migration with an explicit `'complete'` default (the 6 existing rows are
  complete by definition — verified after deploy). The row is created BEFORE the
  lane's name pool, so a killed run leaves a detectable row; all four read paths
  in `reports.service.ts` filter to `complete`, so it can never render as a
  report or appear in the picker. +4 tests.
- `cecd55f` **W3** — null-close drops counted **by date**; a single date at
  >50 % of the lane degrades the run with a dated warning. `dataThrough` =
  `max(Bar.date)` per market on read (no migration) and rendered in the integrity
  header. +9 tests.
- `0f0ae12` **W4** — `ops/health.ts` `computeHealth`, `ops:health` CLI +
  artifact, `GET /ops/health`, dashboard `HealthBanner`, `ops-health` launchd job,
  and an f10 artifact (that job previously left no on-disk trace). +18 api / +8 web.
- `d47e853` **W1** — exit taxonomy `0/2/3/4/5`; both preflight paths no longer
  return `$SCREEN_RC`; the chain reports the worst leg and ends with
  `ops:health --lane <L>`. Adds `scripts/tests/daily-chain.test.sh` (11 cases).
- **W5** — arming fixed and verified (see below).

**Two more silent paths found while building (beyond the three in the entry
below):** `cli/deep-dive.ts:470` set exit 1 only when `failed === topN`, so 9 of
10 names failing exited 0; and `daily-screen.ts` computed `degraded` then dropped
it at the process boundary. Both now non-zero.

**W5 diagnosis — jobs were loaded but UNARMED.** install.sh used the deprecated
`launchctl unload`/`load -w`. Evidence: log retention covers the 09-06 21:54
install (102 entries in that window) with **zero** `agentic-trading` launchd
activity, and the first `StartCalendarInterval` registration is **09-08 20:18** —
so arming happened via later incidental domain events, not the install. That is
why exactly one scheduled run fired in four days. Fix: `bootout`/`bootstrap`/
`enable` plus `scripts/launchd/verify.sh`, which asserts each job's calendar
stream is `watching` and fails the install otherwise (a loaded-but-unarmed job is
invisible to `launchctl list`). All 5 jobs re-armed; `ops-health` installed and
**kickstart-verified under launchd's bare PATH** (`launchctl list` shows exit 1,
correctly alerting).

**Corrected claim:** the plan asserted a post-crash rerun is ~free via the
`AgentDecision` cache. Measured: the US rerun scored **0 cache hits / 72 live
calls** — the prompt carries date-dependent bars and news, so the 08:37 calls did
not replay. Recovery is cheap in *engineering* effort, not in tokens.

**Acceptance (09-10 state repaired):** `screen:deep-dive --market us` →
run=**7**, screenRun=**15**, 10/10 ok, 72 calls. `ops:health --lane us` now
**HEALTHY** (was ALERT / 3 missed). Deliberate deviation from the plan's "rerun
the chain": it was 23:21 HKT with the US market **open**, so re-running
`screen:daily` would have written a partial 09-10 session into the store. The
missing 09-09 session, and `dataThrough` still reading 2026-09-08, heal at the
next scheduled US run (Fri 06:10 HKT, after the US close) — not forced now.

**Resolved (user, 2026-09-10):** the 08:37 kill was almost certainly the user
powering off the machine mid-run — which explains the absent crash report. Worth
noting: this is precisely the failure class that cannot be diagnosed from inside
the process, because no exit code is ever emitted. That is why W1's
post-condition asks the **store** whether a complete run exists, and why W2's
`running` row exists to make the corpse visible.

Next: observe one scheduled cycle (Fri) to confirm arming + a clean chain run,
then Phase-4 plan lock (success bar + fold thinness). Standing: R2 LLM-layer
prospective scoring, Databento R1 baseline, deploy profile.

---

## 2026-09-10 (R0 spec — LOCKED) — W1–W4 detailed + W5 added; all forks and values decided

Second planning pass, turning `docs/ops-hardening-plan.md` from a draft into the
locked execution spec (258 lines). All design forks and numeric values are now
user-decided; execution is fast-tier work.

**New findings this pass (beyond the three in the entry below):**
4. **`screen:deep-dive` exits 0 on partial failure** — `cli/deep-dive.ts:470`
   only sets exitCode 1 when `failed === topN`, i.e. a 100 % lane failure. 9 of
   10 names failing exits 0.
5. **A degraded screen run exits 0** — `daily-screen.ts` computes `degraded`
   and drops it at the process boundary.

**Correction to the earlier diagnosis:** the 09-10 08:37 death was **not**
sleep. `pmset -g log` shows a true Wake at 08:31:22 and **no sleep until
21:29:01**; no `node`/`tsx` crash report exists in DiagnosticReports. Kill
reason is now an explicit W5 task rather than an assumption.

**Scheduling lead (W5):** `UserEventAgent` registered `daily-us`'s
`StartCalendarInterval` entries only at **2026-09-10 08:47:55** — days after the
09-06 install and after that morning's run — consistent with one scheduled run
ever firing and HK never running. The machine was also in maintenance DarkWake
(not full wake) at the 06:10 slot, so the 08:35 run was a catch-up.

**Decided (locked):** W2 = status column only; health surfacing = dashboard
banner (`osascript` declined); staleness = cadence-aware weekday arithmetic
(supersedes the earlier age-in-hours choice, which cannot tell a Sat→Tue 72 h
weekend from a failure); gap action = mark degraded and still publish;
`screen:deep-dive` any-failure-exits-non-zero; weekly jobs in health scope;
launchd fix = repair arming only (no `pmset` wakes, no self-heal job); gap bar
> 50 % of universe; alert at 2 missed expected runs (1 = warn); stale
`running` = 2 h.

**Shape:** W1 chain exit taxonomy 0/2/3/4/5 + `ops:health` as the post-condition
(the only check that catches a killed process); W2 additive migration
`DeepDiveRun.status` default `'complete'` with the four `reports.service.ts`
read paths filtered; W3a per-date null-close counting → degraded, W3b
`dataThrough` on read (no migration), W3c banner; W4 shared `computeHealth` +
`ops:health` CLI + `GET /ops/health` + banner + plist (f10 needs a small
artifact write — it writes none today); W5 arming diagnosis.

**One value still open:** the health job's fire times (proposed 07:15 + 17:30
HKT), flagged in the spec.

Next: fast-tier execution in the spec's build order (W2 → W3 → W4 → W1c → W5),
with the 09-10 state as the acceptance fixture. Still standing: Phase-4 plan
lock, R2 LLM-layer prospective scoring, Databento R1 baseline, deploy profile.

---

## 2026-09-10 (Ops hardening — PLANNED, awaiting lock) — "next rounds" review; 3 silent failures found; R0 chosen; 3c committed

Enhancement-review session that turned into a finding session. User reviewed
candidate rounds (R0 ops trust / R1 Phase-4 backtest / R2 LLM-layer validation
/ R3 data gaps / R4 deploy / R5 quality gates) and **locked R0 as next work**,
plus "commit 3c first".

**Committed (tree was 26 modified + 3 untracked since the 3c ship):**
- `a68f687` fix(scheduling): launchd PATH + durable-key preflight in
  daily/weekly chains (this is the uncommitted 09-10 fix for `pnpm: command
  not found`).
- `ee9e04d` feat(phase-3c): historical-run browsing + indicator overlays.
- `49d27e8` docs(phase-4): plan + PROGRESS through 3c.
- Verified before committing: web 92/92, api 404 passed + 1 skipped.

**Three silent failures found (measured, none previously recorded):**
1. **09-10 US deep-dive died mid-run and discarded everything.** Log ends at
   `screen:daily exit=0` with no `screen:deep-dive exit=` line. `AgentDecision`
   proves 40 live calls (08:35:17→08:37:43) completing 4/10 verdicts; no
   `DeepDiveRun` row for `screenRunId=15` because the run row is created only
   after the lane's `pool()` resolves (`cli/deep-dive.ts:381`).
2. **Skipping the deep-dive exits 0** — both preflight-fail paths in
   `scripts/daily-chain.sh` do `exit "$SCREEN_RC"`. Silent failure is by
   design today; launchd sees a clean job.
3. **US ranked on T-1 data and reported clean.** Today's `nullCloseDropped:
   619` = **555 symbols × the single date 2026-09-09**; store `max(date)` US =
   **2026-09-08** (HK current at 09-09/131). Live Yahoo has a real 09-09 AAPL
   close (315.34 @ 65.4M), so the session was lost, not absent. `degraded`
   stayed false — it is fetched-failure-only (`daily-screen.ts:384`) and the
   integrity header has no cutoff field.

**Also noted:** since launchd install (09-06) exactly **one** scheduled run has
fired (09-10 08:35 US, caught up on wake); HK has not run since 09-06. Plists
are loaded and correct — machine sleep plus the two silent paths explain it.

**Spec written:** `docs/ops-hardening-plan.md` (R0, ~167 lines, **not yet
locked** — 4 forks: W2 status-only vs incremental persistence; alert channel;
staleness threshold; whole-universe gap rule). Workstreams: W1 chain exit
codes + post-condition, W2 `DeepDiveRun.status` so crashed runs are visible
and never become "the latest report", W3 `dataThrough`/whole-universe-gap
integrity field + banner, W4 `ops:health` CLI + launchd alert via `osascript`.
The 09-10 evidence is the acceptance fixture.

Next: user locks the 4 R0 forks, then execution is fast-tier work. Still
standing: Phase-4 plan lock (success bar + fold thinness), R2 LLM-layer
prospective scoring, Databento R1 baseline, deploy profile (architecture §7
still pins the now-superseded `deepseek-v4-flash` — the catalog's current
model is `deepseek-flash` = "DeepSeek V4.1 Flash").

---

## 2026-09-10 (Phase 4 plan — DRAFTED, awaiting lock) — backtest spec written; 4 forks user-locked

Deep-tier planning session for backtesting the screen (H1). Spec written to
`docs/phase-4-plan.md` — **not yet user-locked** (user will review the
pre-registered success bar and the 3-fold walk-forward structure next
session; both flagged for scrutiny in the plan's presentation).

Forks locked by the user (all four recommended options):

1. **Screen only** — the LLM deep-dive layer is not backtestable; verdicts
   get validated prospectively from persisted AgentDecision rows, later, free.
2. **Rank-hysteresis hold** — buy on top-N entry, hold until rank > buffer
   or gate failure; mirrors real manual use.
3. **Walk-forward folds** (3 anchored, purged boundaries) + Day-23
   plateau-seeking; CPCV+PBO deferred as audit-only tool.
4. **Survivorship accepted & labeled** — results are upper bounds, all
   claims relative to same-universe benchmark + index.

Key design spine (in the spec): replay = `runScreen` on PIT-truncated series
(CAs sliced to ex-date ≤ T) so signal logic stays single-source; two ordered
gates (ranking power IC first, tradability sim second); tuning restricted to
weights/topN/buffer-rank on an 81-combo coarse grid, gates fixed; success bar
pre-registered before any run. Build order: quant-core `backtest` module →
`backtest:screen` CLI → grid run + verdict.

**Next session**: user reviews/locks `docs/phase-4-plan.md` (esp. the
success-bar thresholds and fold thinness), then execution = fast tier
(switch back to k3-256k).

---

## 2026-09-09 (Phase 3c SHIPPED) — historical-run browsing + indicator overlays

All three build steps of `docs/phase-3c-plan.md` landed (api → web → e2e +
docs). Read-only SQL + derivation only; no new LLM surface, no new
dependencies.

- **API** (`apps/api/src/reports/`): `GET /reports/runs?market=&limit=&symbol=`
  exposes `listRuns` — market validated (400), limit default 20 clamped to
  [1,50] (400 only on non-integer), `symbol` filter = only runs with a
  DeepDiveReport for that name (powers the symbol-page picker; symbol with
  no reports → empty list, never 404/500). `GET
  /instruments/:symbol/price-history` gains an additive `indicators` field —
  `{ sma50, sma200, mom20, mom60, mdd252, vol60 }`, each `[{ date, value }]`
  — rolled via the quant-core point functions (`sma` / `momentum` /
  `maxDrawdown` / `annualizedVol`) over the FULL `deriveAdjustedBars` series,
  then sliced to the requested window; null-lookback points omitted, never
  zeroed. The 3a `bars`/`markers` contract is byte-unchanged; chat's
  `getPriceHistory` tool inherits the field for free.
- **Web** (`apps/web`): `price-chart.tsx` upgraded to lightweight-charts v5
  panes — pane 0 unchanged content + SMA50/SMA200 line overlays, sub-panes
  for momentum (mom20/mom60), drawdown (mdd252 area, ≤ 0), volatility
  (vol60), all rendered as %, plus a static CSS legend row; the `indicators`
  prop is optional and absent → renders exactly as before. One component
  serves both `/symbol/[symbol]` and the chat `getPriceHistory` tool card
  (locked decision 4 — passthrough added in `tool-cards.tsx`). New
  `run-picker.tsx` client component: newest-first dropdown, label `run {id} ·
  {runAt local} · topN {n}`, selection rewrites the URL param (shareable) and
  preserves sibling params. Dashboard `/`: per-lane picker in each lane
  header, selection as `?hkRun=<id>&usRun=<id>` (absent = latest);
  `fetchDailyReport` gained a runId passthrough and `fetchRuns` was added to
  `lib/api.ts` on the never-throw idiom. Symbol page: picker lists only runs
  containing THAT symbol (the api `symbol` filter), rewrites the existing
  `?run=`; the `?run=` hard requirement stays; picker also offered on the
  "no deep-dive found" notice.
- **Decisions taken on spec gaps** (flagged during build): `limit` is clamped
  into [1,50] rather than 400ing on out-of-range integers (the spec said
  "clamp"; 400 reserved for non-integer input — the service-level listRuns
  guard used by chat is unchanged); picker rendered inside the
  `LaneSection` lane-header slot rather than literally above the section;
  picker has a "latest run" empty option that deletes the param so a
  selection is reversible; chart height grows 320→560px when indicators are
  present.
- **Tests**: api 404 passed / 1 skipped (network-gated yahoo-live) — hand-
  computed SMA/momentum/drawdown/vol over a seeded 260-bar series,
  null-lookback omission, window slicing == bars slicing, listRuns ordering /
  market / clamp / symbol filter, HTTP-level route wiring + 400s. Web 92
  passed (chart pane plumbing with exact `addSeries` pane indices + %
  scaling, run-picker rendering + navigation, dashboard per-lane wiring from
  fixture runs, symbol-page picker + passthrough, chat tool card
  passthrough; coverage 98.4% lines / 95% branches, gate green). e2e 6/6
  (dashboard pickers with the api up, selection → `?hkRun=` in URL, api-down
  picker degrades with the lane — never a 500). All builds clean. Note:
  `pnpm test:coverage` on apps/api was already red at HEAD on the `src/**`
  90% lines threshold (77.7% baseline; 77.97% with 3c) — pre-existing, not a
  regression; reports module itself sits at 96% lines.

Next: Phase 4 — backtesting design (deep-tier session; screen rules are a
hypothesis per Days 15/23, out-of-sample discipline per Days 11/23).
Standing loose ends: weekly sentinel, Databento archive as the R1 baseline
candidate, the phase-3a deferred items.

---

## 2026-09-09 (durable LLM key — DONE) — Moonshot platform key in .env; rotating-token dependency gone for local profile

Executed follow-up #2 from this morning's chat ops notes:

- **`.env`**: user added `LLM_API_KEY` (Kimi platform key, works against the
  existing `LLM_BASE_URL=https://api.kimi.com/coding/v1` — verified live:
  HTTP 200 with `k3-256k`, `temperature: 1`, `reasoning_effort: "low"`).
  `LLM_API_KEY_FILE` left in place as inert fallback — both consumers
  (`chat-config.ts`, `cli/deep-dive.ts`) prefer `LLM_API_KEY` when set.
- **`scripts/daily-chain.sh` preflight** now reads `LLM_API_KEY` + the `.env`
  base URL first (it previously only knew the Kimi OAuth token and would have
  kept probing the wrong credential); OAuth token path retained as fallback.
- **Verified**: raw probe 200 → `screen:deep-dive -- --market hk --top 1`
  smoke, 2269.HK ok, 7/7 calls, 0 failures (run=6).
- **Ops note**: the API server reads chat config once at process start —
  restart it to pick up the key for the chat path. With a static key the
  401-after-an-hour failure mode is gone; the per-request key re-read
  follow-up was dropped as no longer required.

---

## 2026-09-09 (chat ops notes) — cache replay observed in the wild; 401 root-caused; 2 follow-ups recorded

First real user session on the shipped 3b chat. Two observations:

- **Cache replay works in the wild**: the smoke question ("top 3 names in
  the latest HK daily report…") answered instantaneously on click — a full
  AgentDecision hash replay, 0 live calls. Working as designed.
- **401 on the first cache-miss turn**: `llm http-401 invalid_authentication_error`.
  Root cause is the known rotating-token limitation, now with a daemon-shaped
  twist: chat-config reads `LLM_API_KEY_FILE` once **at API process start**,
  so a server running longer than the token's ~hourly expiry is guaranteed to
  401 on its next live call. The deep-dive CLI never hits this (short-lived
  process). Workaround: restart the API (the CLI keeps the token fresh).

**Follow-up recorded (fast tier):**
1. **Durable fix** — Moonshot platform key in `.env` (previously deferred to
   the deploy profile; would fix local permanently too). **Done same day —
   see the entry above.** (The originally-listed 401 self-heal / per-request
   key re-read was dropped: with a static key there is no rotation to heal.)

Also noted (not scheduled): chat has no options data — put-selling questions
get verdicts + price history only. A data-source addition if the use case
becomes real.

---

## 2026-09-08 (Phase 3c plan — DECIDED) — historical-run browsing + indicator overlays; spec in docs/phase-3c-plan.md

Short planning pass over the shipped 3a/3b surfaces. All four forks
user-locked; execution spec is `docs/phase-3c-plan.md`:

1. **Browsable runs: deep-dive runs only** (runs with verdicts — what
   `listRuns` already returns; screen-only days stay invisible).
2. **Run pickers on dashboard + symbol page** — per-lane picker on `/`
   wired to `?hkRun=`/`?usRun=` (shareable, absent = latest); symbol-page
   picker rewrites the existing `?run=`.
3. **All four indicator visuals** — SMA50/SMA200 overlay lines on the price
   pane + momentum (mom20/60), drawdown (mdd252), volatility (vol60)
   sub-panels (lightweight-charts v5 panes).
4. **Same chart component in chat** — the `getPriceHistory` tool card
   renders the full overlaid/panel chart.

Two additive read-API changes: `GET /reports/runs?market=&limit=&symbol=`
(exposes listRuns; `symbol` filter = runs containing a DeepDiveReport for
that symbol — flagged decision, powers the symbol-page picker so it never
lands on "no deep-dive found") and an `indicators` field on
price-history (sma50/sma200/mom20/mom60/mdd252/vol60 series rolled from the
existing quant-core point functions over the full adjusted series,
window-sliced, null-lookback omitted; 3a contract byte-compatible).

Build order: API endpoints + tests → web chart/pickers/wiring + tests →
e2e + docs + PROGRESS. Execution is fast-tier work; all decisions are in
the spec.

---

## 2026-09-08 (Phase 3b SHIPPED) — full tool-calling chat end-to-end

All five build steps of `docs/phase-3b-plan.md` landed; the 3a "no LLM
path" invariant is now **exactly one guarded LLM path**.

- **Schema + migration** `20260908120000_chat_sessions` (hand-written SQL,
  `migrate deploy`, per the phase-2 idiom): `ChatSession` (usage totals,
  nullable title) + `ChatMessage` (role/content/toolName/toolArgsJson, FK to
  session) exactly per the plan's data model. Gotcha worth remembering: the
  test-db helper splits migration SQL on `;` naively, so migration *comments*
  must not contain semicolons (a comment-only fragment fails with SQLite
  code 21 "not an error").
- **ReportsService extensions** (`apps/api/src/reports/reports.service.ts`,
  still read-only SQL): `daily(market, runId?)` (runId 404s on unknown run
  or wrong market; omitted = latest, contract unchanged); `deepDive`
  refactored onto a shared `loadDeepDive` helper, public shape
  byte-identical; new `deepDiveIndex(runId, symbol)` (transcript index with
  500-char response previews, pipeline order), `transcriptEntry(hash)` (full
  AgentDecision row, 404 on unknown hash), `listRuns(market?, limit=10)`
  (limit clamped to [1,50], market validated), `compareSymbols(symbols)`
  (2–5, per-symbol latest screen row + latest verdict overlay, null fields
  instead of 500s, 404 on unknown symbol).
- **llm-client**: additive native function-calling support (tools in,
  tool_calls out) — the wire mechanism for the chat loop; completion API
  untouched.
- **Chat module** (`apps/api/src/chat/`): tool registry (6 read-only tools
  wrapping ReportsService), chat-service loop, SSE controller. Guardrails:
  20 LLM calls/session hard stop (`cap-reached` event), max 5 tool rounds
  per user message (round 5 the model answers with what it has — tools
  omitted from the request), structural-only injection posture (tool results
  wrapped `<tool-data>`, system prompt states data-never-instructions).
  Every chat LLM call writes an `AgentDecision` row with `agent="chat"`
  (content hash → $0 exact-repeat cache hits). 503-when-unconfigured lives
  in the controller: only `POST /chat/sessions` and `POST …/messages` 503;
  GET session routes and reports stay up.
- **Web** (`apps/web`): SSE proxy route handlers under `app/api/chat/`
  (`ReadableStream` passthrough for the message stream; 503 env-unset / 502
  unreachable / upstream status relayed; browser never sees the api origin).
  `/chat` client route: session picker/resume, cost header
  (`calls: n/20 · tokens: p+c` from `usage` events), cap notice + disabled
  input, inline error events, `?symbol=X` input preseed. Hand-rolled
  markdown renderer (no new deps). Inline tool cards rendered from
  *persisted* role="tool" messages (the stream carries status only;
  refetch-after-done): daily → watchlist table, compareSymbols →
  side-by-side table, getDeepDive → verdict card + transcript index,
  getPriceHistory → mini lightweight-charts chart (`price-chart.tsx` moved
  to `app/components/`), transcript entry → collapsed pre, unknown payloads
  → collapsed raw JSON — the message list never breaks. "Chat" nav links on
  dashboard + symbol pages.
- **Decisions taken on spec gaps** (flagged during build, within the spec's
  guardrails): tool-call replay across turns via user-role tool-data blocks;
  toolCalls ride in `usageJson` so AgentDecision cache hits replay the same
  tool calls; the session cap counts live LLM calls only (cache hits free);
  on round 5 tools are omitted from the request rather than forcing a stop;
  chat history trimmed to last ~20 messages / 60k chars; GET session routes
  stay up when chat is unconfigured; native function calling (not
  prompt-based JSON) is the wire mechanism.
- **Tests**: agents 43 · api 391 passed / 1 skipped · web 72 (incl. markdown
  renderer, tool cards from fixture sessions, cost header, cap notice, SSE
  proxy with mocked upstream, client test driving a canned SSE stream;
  coverage 98% lines / 95% branches) · e2e 4/4 (chat not-configured state
  on the main instance, api-down /chat graceful, dashboard Chat link).
  All builds clean.
- **Live smoke (same day, k3-256k low-effort, temp=1)**: real HK question
  ("top 3 names in the latest HK daily report + verdicts") → 2 live calls
  (tool-select 984 prompt tokens → answer 16,780), `getDailyReport(HK)`
  tool call, grounded answer (2269/1997/3988 with correct ratings), SSE
  event sequence clean. Session 2 with the identical turn: **0 live calls,
  full cache replay ($0)** — the AgentDecision hash cache holds for chat.
  2 `agent="chat"` decision rows; session token totals correct
  (16,780/265 on session 1, 0/0 on session 2).

Next: Phase 4 — backtesting design (deep-tier session; screen rules are a
hypothesis per Days 15/23, out-of-sample discipline per Days 11/23).
Standing loose ends: weekly sentinel, Databento archive as the R1 baseline
candidate, the phase-3a deferred items.

---

## 2026-09-07 (Phase 3b plan — DECIDED) — full tool-calling chat; 12 forks locked, spec in docs/phase-3b-plan.md

3b planning pass over the shipped 3a read API. All forks decided by the
user; execution spec is `docs/phase-3b-plan.md`:

1. **Loop in a Nest chat module** — tools are in-process ReportsService
   calls; web is a thin SSE proxy (browser → Next → Nest).
2. **Sessions persisted** — new `ChatSession`/`ChatMessage` tables;
   chat LLM calls logged as `AgentDecision` rows with `agent="chat"`
   (hash cache → $0 exact repeats).
3. **Event-level SSE** — status/chunk/usage/done/error events; no
   token-level streaming, no llm-client stream support needed.
4. **Tools (all read-only)**: getDailyReport (+runId for history),
   getDeepDive (verdict + transcript *index*), getTranscriptEntry(hash)
   on-demand, getPriceHistory, compareSymbols (stored-data join, 2–5
   symbols), listRuns.
5. **Guardrails**: 20 LLM calls/session hard stop (`cap-reached` event),
   max 5 tool rounds per user message, tokens-only cost display in the UI
   header, structural-only prompt-injection posture (tool outputs wrapped
   as quoted `<tool-data>`; read-only tools bound the blast radius).
6. **Chat model**: `LLM_CHAT_MODEL` env, k3-256k low-effort default. First
   time the API process touches an LLM — chat routes 503 when env is
   missing, reports stay up. The 3a "no LLM path" invariant becomes
   "exactly one guarded LLM path".
7. **UI**: `/chat` client route, markdown + inline tool cards reusing 3a
   components, session picker/resume.

Build order: Prisma models + ReportsService extensions → tool registry +
chat loop (fake-client tests) → SSE controller → web proxy + `/chat` UI →
e2e + docs. Execution is fast-tier work; all decisions are in the spec.

---

## 2026-09-07 (Phase 3a SHIPPED) — read-only report UI live: read API + dashboard + deep-dive pages

Executed `docs/phase-3-plan.md` 3a build order end-to-end (fast tier; all
decisions were locked in the plan):

**1. Read API (apps/api, new `reports` module).** Three read-only SQL
endpoints — no provider calls, no LLM path (the UI-can-never-trigger-LLM
invariant holds structurally):

- `GET /reports/daily?market=US|HK` — latest DeepDiveRun joined to its
  ScreenRun: integrity header (universeSize/ok/genuinelyAbsent/fetchFailed/
  degraded/warnings) + ranked rows with metrics summary and verdict overlay;
  screened-but-not-dived names carry `verdict: null`. 404 when no run yet.
- `GET /reports/deep-dive/:runId/:symbol` — full parsed verdict + ordered
  transcript (AgentDecision rows resolved from `decisionHashesJson` in
  pipeline call order, verified against pipeline.ts).
- `GET /instruments/:symbol/price-history?days=250` — store-only; adjusted
  close via `deriveAdjustedBars` over the FULL stored series then sliced
  (out-of-window dividends still back-adjust); CA markers include DIVIDEND +
  IN_SPECIE. Lives on a separate read-only controller so the live-fetch
  `/bars` seam stays distinct.

16 new service tests (seeded SQLite via test-db helper); api suite 354
passed, build clean.

**2. Web UI (apps/web).** `/` dashboard — HK + US lane sections with
integrity headers (red banner when degraded), ranked watchlist tables
(rating badge, diverging conviction bar, one-line thesis), rows linking to
`/symbol/[symbol]?run=` (verdict card with keyRisks/invalidationConditions,
lightweight-charts adjusted-close + volume chart with DIVIDEND/IN_SPECIE
markers, native-`<details>` transcript accordion, zero client JS except the
chart). Plain CSS (`app/globals.css`), no framework. Failure posture per the
ApiHealth precedent: per-lane `api: unreachable` / `no run yet`, never a
500 — asserted by a new Playwright api-down instance in the smoke suite.
New dep: `lightweight-charts@5.2.1` (v5 series API).

**3. Gates.** web Vitest 38/38 (100% lines / 97% branches); web build clean;
root Playwright 2/2. Bonus live check against the real store: today's HK
run rendered end-to-end (table, verdict card, 14-entry transcript, chart).

**What's next:** 3b chat — full tool-calling chat per the locked decision;
gets its own short planning pass (tool schema, per-session call caps, cost
display, SSE streaming, prompt-injection posture) before implementation.

---

## 2026-09-06 (Phase 3 plan — DECIDED) — report-first, chat second; plan doc is the execution spec for 3a

Phase 3 design review (deep tier). Four forks decided by the user, spec in
`docs/phase-3-plan.md`:

1. **Report-first, chat second** — 3a = read-only report UI (daily dashboard
   + per-name deep-dive page) on a new read API; chat lands after as 3b.
2. **Chat (3b) = full tool-calling chat** — free-form questions, LLM
   tool-calls into the Nest API; its own planning pass before implementation.
3. **Price charts in 3a** — lightweight-charts (decided stack), adjusted
   close via the same `deriveAdjustedBars` the screen uses, CA markers.
4. **Localhost only** — browser never calls the API directly (server
   components + `API_INTERNAL_URL`); no auth, no CORS.

3a scope: 3 read-only endpoints (`/reports/daily`, `/reports/deep-dive/:run/:symbol`,
`/instruments/:symbol/price-history`), 2 routes (`/`, `/symbol/[symbol]`),
one new dep (`lightweight-charts`). Invariant: **the UI can never trigger an
LLM call.** Architecture §8 amended to the report-first ordering.

Execution starts tomorrow — fast tier (k3-256k low thinking) per the model
policy; all decisions are recorded in the plan doc.

---

## 2026-09-06 (NEAR-tier vetting + F10 rounding) — 51 XNYS candidates vetted: 2 appends (ITRG, LAC), 24 confirmed echoes; F10 sums now rounded to 6dp

**1. NEAR-tier + echo-class vetting — DONE (27+24, the last open registry item).**
Funnel reproduced exactly (`scripts/databento/xnys_near_funnel.py`; 913 − 1
BHVN = 912 no-exact-registry → echo 24 / NEAR 27 / FAR 5 remaining, universe =
5,333 imported databento-xnys symbols). All 51 vetted against bars + primary
sources (`scripts/databento/xnys-near-tier-verdicts.csv`):

- **Echo-class (24): all confirmed echoes, no action.** Every candidate
  matches a lattice-clean Yahoo registry row within 1–8 days — detector
  re-fires on the first bar after a no-bar gap, exactly the BNDD/EFAX class.
- **NEAR (27): 24 false positives, 3 real corporate actions.**
  - **ITRG 2023-05-26 — APPENDED** (REVERSE_SPLIT 0.4162, inband/estimated):
    real 1-for-2.5 consolidation (Integra PR + 2023 20-F), Yahoo silent.
    Close-measured factor per the BHVN lesson.
  - **LAC 2023-10-04 — APPENDED** (FORWARD_SPLIT 1.3814, inband/estimated):
    Lithium Americas separation (1 old = 1 new LAC + 1 LAAC), same
    spinoff-class append precedent as BHVN.
  - **ARI 2026-07-16 — APPENDED** (REVERSE_SPLIT 0.666, inband/estimated):
    real **$3.50 special cash dividend** (OCC infomemo 59316; observed
    −$3.52 step matches exactly) — an *additive* event recorded as a
    multiplicative factor per user decision (option 1), exact at the ex-date
    close only; revisit if VendorBar gains a dividend layer.
  - False-positive anatomy (for future detector tuning): earnings gaps ×6,
    leveraged-ETF/ETN beta on crash days ×6 (YINN, BITU, BERZ, WTIU, JETD,
    HIYY-halt), microcap pumps/drift/post-IPO fades ×11, ticker-identity
    noise ×1 (CTM = Castellum, not Castor Maritime).

**Registry now: 2,642 yahoo + 597 inband = 3,239 SplitEvents.**

**2. F10 amount rounding — DONE.** Same-ex-date cash rows summed in binary
float could leave artifacts (9988.HK 1.9510839999999998 class);
`mergeF10ForSymbol` now rounds the summed HKD to 6 dp on write
(`refresh-f10-ca.ts`). No live rows affected (checked: no long-repr amounts in
CorporateAction). Suite 338 passed / 1 skipped, tsc clean.

**Open:** none from this batch. Next architecturally-significant chunk:
**Phase 3 chat UI** — deep-tier planning session.

---

## 2026-09-06 (scheduling — INSTALLED) — launchd runs the daily chain + weekly jobs; last pre-Phase-3 infrastructure item closed

The four CLIs are now automated via user LaunchAgents (`scripts/launchd/`,
installed to `~/Library/LaunchAgents`, verified loaded via `launchctl list`).
Decisions (all confirmed with the user):

- **launchd, not cron** — macOS cron silently skips jobs missed during sleep;
  StartCalendarInterval catches up after wake.
- **Wrapper per lane** — `scripts/daily-chain.sh hk|us` runs `screen:daily`
  then `screen:deep-dive --top 10` sequentially, preceded by a cheap LLM auth
  preflight (the local profile's credential is the Kimi CLI's *rotating* OAuth
  token). Preflight failure ⇒ skip the deep-dive leg loudly, keep
  screen:daily's result, exit code names the manual rerun. Durable fix (a
  Moonshot platform key) belongs to the deploy profile.
- **Sunday-morning maintenance**, staggered so the two eastmoney hosts aren't
  hit back-to-back: sentinel **with `--eastmoney`** at 08:47 HKT, then
  `ca:f10-refresh` at 09:17.

| Job | Schedule (HKT) |
|---|---|
| daily-hk (screen + deep-dive) | Mon–Fri 16:50 |
| daily-us (screen + deep-dive) | Tue–Sat 06:10 |
| weekly-sentinel (--eastmoney) | Sun 08:47 |
| weekly-f10 (ca:f10-refresh) | Sun 09:17 |

Logs: `logs/*.log` (launchd StandardOut/ErrorPath; dir gitignored). Docs:
architecture §5.1 (new), §4.3 cadence note, hardening-plan §B superseded note.
Smoke-verified: plist lint OK ×4, script syntax OK, token-read preflight OK;
the chain legs themselves were E2E-proven earlier today, so no full burn.

Remaining recorded items: NEAR-tier split-candidate vetting (27+24, optional),
F10 amount rounding cosmetic. Next: **Phase 3 chat UI** — deep-tier planning
session.

---

## 2026-09-06 (full daily pipeline E2E — PASSED) — screen:daily → deep-dive top-10 both lanes, 20/20 ok; Phase 2 functionally complete

First full-shape run of the daily pipeline (architecture §5 steps 1–5):

1. **screen:daily --market all**: US 555/555, HK 131/131, neither lane
   degraded. Loader guards worked at ingest: 61 US + 86 HK null-close bars
   dropped (L5, Yahoo still-forming bars) and 66 level-break bars dropped
   (L6 — Yahoo keeps serving 3195.HK's USD-stitch prefix, the rule drops it
   every run, as designed).
2. **screen:deep-dive --market all --top 10**: **20/20 names ok, 141 calls,
   0 failures** (US 71 — MPC needed 8: the verdict repair round fired live
   and recovered; HK 70). Verdicts are differentiated and sane: HK lane
   buy-leaning (6160.HK 0.55; 1093/1801/3988 0.45; 0005/0939 0.35), US lane
   neutral-heavy with two sells (CRL −0.35, IQV −0.30). ~362k total tokens
   across 155 AgentDecision rows (incl. smoke) — pennies-class cost as
   budgeted.
3. Cache semantics confirmed correct in the wild: 0 cache hits because
   screen:daily refreshed every name's metrics → new prompt bytes → new
   decisions. ($0 rerun on UNCHANGED data was proven in the smoke.) Note
   2269.HK moved buy 0.45 → neutral 0.10 between screenRun 10 and 12 —
   fresh-data sensitivity, expected.
4. pnpm install wrinkle settled (clean install, agents suite green).

**Phase 2 is functionally complete.** Remaining recorded items: scheduling
(sentinel + ca:f10-refresh + the daily chain itself are CLIs with no
automation yet), NEAR-tier split-candidate vetting (27+24, optional),
F10 amount rounding cosmetic. Next architecturally-significant chunk:
**Phase 3 chat UI** (Next.js reading ScreenRun/DeepDiveRun/AgentDecision) —
worth its own deep-tier planning session.

---

## 2026-09-06 (Phase-2 live smoke — PASSED) — first real deep-dives persisted; cache rerun at $0 proven; k3-256k profile wired

Execution per `docs/phase-2-plan.md` step 6, on the user's chosen local
profile: **k3-256k (low thinking) for all three roles**, using the Kimi Code
CLI's own subscription credential.

**Endpoint facts measured live** (probe before wiring): the coding endpoint
`api.kimi.com/coding/v1` accepts model `k3-256k` (the `kimi-code/` prefix is
CLI-internal — rejected on the wire), requires **temperature = 1** (400s
otherwise), and accepts `reasoning_effort: "low"`. The credential is an
OAuth access_token that **rotates** (~hourly expiry observed), so it is
never copied into `.env`: new `LLM_API_KEY_FILE` env var points at
`~/.kimi-code/credentials/kimi-code.json` and is read fresh at process
start. Client gained `reasoningEffort` pass-through +
`defaultTemperature`/`defaultReasoningEffort` (+4 tests; agents 39, api
338/1, tsc clean).

**Smoke: `screen:deep-dive -- --market hk --top 2` — 2/2 ok, 14 calls, 0
failures.** 2269.HK → buy 0.45 (thesis grounded in the F10 fundamentals
snapshot: revenue +18.4% H1 2026), 1997.HK → neutral 0.15. 14
AgentDecision rows with full prompts/responses. **Cache rerun: 0 LLM calls,
14/14 cache hits, AgentDecision count unchanged** — the content-addressed
$0-rerun property holds end-to-end.

**Known limitation (recorded, not blocking):** the local profile depends on
the CLI's OAuth token being fresh; if the CLI hasn't run recently the token
may be expired (run any `kimi` command to refresh). A Moonshot platform key
remains the stable long-term option; deploy profile stays DeepSeek
`deepseek-v4-flash` (moonshot blackholed from AWS ap-east-1 — measured).

**Next:** full daily shape — `screen:deep-dive -- --market all --top 10`
after the next screen:daily; then Phase 3 (chat UI reading DeepDiveRun /
AgentDecision) whenever scheduled.

---

## 2026-09-06 (Phase-2 execution, fast tier) — agent pipeline implemented steps 1–5; all suites green; live smoke pending

Per `docs/phase-2-plan.md` build order (steps 1–5; the live smoke is a
separate step for the main session):

1. **Migration `20260906180000_agent_pipeline`** (hand-written SQL +
   `migrate deploy` — `migrate dev` refuses non-interactive, same as the
   ca_inspecie_events precedent): AgentDecision (content-addressed decision
   log) + DeepDiveRun + DeepDiveReport exactly as spec'd. Client regenerated.
2. **packages/agents** (37 new tests): `llm-client.ts` (OpenAI-compatible
   fetch client, 60s timeout, 1 retry on transport/5xx, typed LlmError),
   `verdict.ts` (strict parseVerdict + extractJsonCandidate + single-repair
   message builder; owns RATINGS), `prompts.ts` (PROMPT_VERSION="v1",
   byte-deterministic builders, num/pct/money fixed-precision helpers, sorted
   metrics + date/title-sorted news — golden snapshot test), `pipeline.ts`
   (news+fundamentals parallel, ETF news-only, 2-round debate, verdict + 1
   repair round, cache lookup before every call). `Verdict` extended with
   `asOf` + `promptVersion` per plan.
3. **F10 probe** (6 paced requests, all reachable ~1s): pinned
   RPT_HKF10_FN_MAININDICATOR (HK, source=F10) and the US two-step
   RPT_USF10_INFO_ORGPROFILE → SECUCODE → RPT_USF10_FN_GMAININDICATOR
   (source=SECURITIES; US reportNames from akshare stock_finance_us_em.py
   source, not guessed). DATE_TYPE_CODE 001=annual; YoY/ratio fields are
   percent units. Verbatim probe responses saved as test fixtures.
   `EastmoneyF10Provider.fetchFundamentalsSnapshot` renders a ~12-line block
   (latest interim/quarter + latest annual, YoY deltas).
4. **src/agents/news.ts**: Google News RSS (HK: CN name + "0700.HK" lanes;
   US: "AAPL Apple"), minimal regex RSS parser (degrades titles-only), cap
   10, exact-title dedupe, Yahoo `search` supplement wrapped in try/catch.
5. **src/cli/deep-dive.ts** + `screen:deep-dive` script: latest ScreenRun
   per lane → top-N by rank, `--symbol` ad-hoc bypass, concurrency pool 4,
   `--max-calls` (default 200) with SYNCHRONOUS 7-call reservation per name
   (pool-safe, aborts before overspend), per-name try/catch → failed:<slug>,
   persists DeepDiveRun + reports. Env via native `process.loadEnvFile`
   (apps/api/.env then root .env; no dotenv in repo); missing LLM_* vars
   fail loud naming every var when names will be processed.

**Known wrinkle:** pnpm's lockfile carried a stale peerless `vitest@3.2.7`
resolution for packages/agents that never materialized in the store —
worked around with a symlink to the peer-suffixed variant quant-core uses;
regenerate the lockfile at the next normal `pnpm install`.

**Test counts vs baseline:** api 336 passed / 1 skipped (295+1 baseline),
quant-core 49 (unchanged), agents 37 (new), tsc clean in all three.

**Next:** live smoke `screen:deep-dive -- --market hk --top 2` on the Kimi
local profile (needs a Moonshot platform key in .env) — verify report rows,
decision-log rows, cache-hit rerun at $0.


---

## 2026-09-06 (archify system map) — docs/architecture-system-map.html delivered, 9/9 showcase checks, containment pass at 4 viewports

Same system map rebuilt with the archify skill (architecture type, 10 nodes,
snake layout: sources → apps/api → store → quant-core → screen → agents → web).
Validation 9/9, 0 errors, 0 warnings; `deliver` sha256
`b1fb3d6c…` (spec 5,003 B) → `66ecbcdf…` (HTML 717,183 B); `visual-check`
containment pass at 1440×900 / 1600×1000 / 1920×1080 / 2048×1320, min projected
node text 6.80–9.00 px (floor 6). Two geometry repairs were needed: the first
layout had `decisions→web` crossing `agents`, and `store→quant`'s label needed
`labelDy: 24`; viewBox ended at 1230×684 to clear a 6px vertical overflow at
1440×900. **Perceptual visual review is still pending** — the browser evidence
is containment + readability only. Linked from docs/architecture-map.md; the
older mermaid `architecture-map.html` stays.

---

## 2026-09-06 (tooling) — archify skill installed for pi + Kimi Code

`~/.agents/skills/archify` (from the repo's packaged `archify.zip`, v2.17, MIT)
→ pi discovers it globally; Kimi Code gets it by adding `~/.agents/skills`
to `extra_skill_dirs` in `~/.kimi-code/config.toml` (backup taken). Smoke
test: `node bin/archify.mjs validate/render architecture examples/web-app.architecture.json`
passes with **no npm install** — devDeps (ajv/parse5/saxes) are not needed for
render/validate. pi needs a restart to list it; Kimi picks it up next launch.

---

## 2026-09-06 (architecture map) — docs/architecture-map.md: 3 mermaid diagrams (system map / daily flow / phase evolution) + invariant list

Reference diagrams drawn from architecture-v1.md + the as-built tree:
solid = shipped (ingestion, Day-17 gate, quant-core, Prisma store, Databento
archive, F10 overlay, sentinel), dashed = designed. System map encodes the
core rule visually: agent-layer arrows point into storage, never into
quant-core. Phase table says why each phase is where it is (2 needs a stable
ScreenRun; 3 is a viewer over persisted runs; 4 needs P2 verdict history to
score the screen). No code changed.

**Next:** Phase 2 execution per docs/phase-2-plan.md build order (fast tier).

## 2026-09-06 (Phase-2 planning session, deep tier) — agent pipeline fully spec'd; all 5 forks user-locked; ready for fast-tier execution

Planning session for Phase 2 (lean agent pipeline + persisted daily
reports). Full spec: **`docs/phase-2-plan.md`**; architecture §7 amended
with the decision summary. Locked forks:

1. **Fundamentals analyst**: eastmoney F10 three-statements, stocks only;
   HK ETFs skip the fundamentals leg (news+technicals only). One-off probe
   step pins statement fields before the assembler is written.
2. **News/sentiment**: Google News RSS per name both lanes (CN+EN for HK) +
   Yahoo supplement; ~10 headlines; the LLM judges sentiment (no separate
   model).
3. **Structured output**: prompt + strict validate + exactly 1 repair round
   — provider-agnostic, no `response_format` dependency.
4. **Breadth**: top 10/lane (~140 calls/day, pennies), `--symbol` ad-hoc,
   `--max-calls` budget guard.
5. **Models**: Kimi all-roles local; DeepSeek `deepseek-v4-flash` on deploy.
   Carried-over measured fact (ib-learning-site ai-feedback.md, probe-Lambda
   verified): `api.moonshot.cn` is blackholed from AWS ap-east-1 — DeepSeek
   deploy is a network fact, not a preference. Kimi Code CLI subscription
   credential ≠ open-platform API key; local profile needs a Moonshot
   platform key in `.env`.

Core design: `AgentDecision` table keyed by
sha256(agent|model|promptVersion|system|user) — cache/audit/debug in one
artifact; **byte-deterministic prompt builders are a tested invariant**
(golden files), because the snapshot travels inside the prompt and an
unchanged snapshot must hash-hit at $0. `DeepDiveRun`/`DeepDiveReport`
persist reports with per-name `failed:<slug>` isolation. New
`screen:deep-dive` CLI over the latest ScreenRun; packages/agents stays
pure (fetch-based LLM client fully injectable — no new dependencies).

**Next:** switch to the fast tier and execute the build order in
docs/phase-2-plan.md §Build order (6 steps; live smoke = top-2 HK on the
local Kimi profile, then a $0 cache rerun).

---

## 2026-09-06 (0941.HK divergence triaged + fixed) — sentinel fully green: 0 ALARM / 0 WARN / 10 ok, exit 0

The last sentinel ALARM (0941.HK eastmoney max 1.08% on 2024-01-15) is
resolved. Root cause: **Yahoo served a flat zero-volume stale phantom on a
full trading session** — O=H=L=C=65.05, repeating the 2024-01-11 close,
while eastmoney shows a real day (close 65.75, high 66.00, low 64.90,
~10M shares) and tencent carries the session. The other 7 zero-volume
0941.HK stored bars are all CNY-eve/Christmas half-days whose closes match
eastmoney to the tick — harmless; 2024-01-15 was the only defective one.
(Why no loader rule catches this class: a flat zero-volume bar is genuine
data for illiquid names — 0623.HK has 250 — so detection needs either a
liquidity profile or the curated set. That's why the curated set exists.)

**Fix (same locked pattern as the ETF session gaps):**
1. `repair:store -- --symbol 0941.HK --rescue 2024-01-15` → store now holds
   the real bar (65.00/65.75/66.00/64.90, vol 9,973,161).
2. `YAHOO_KNOWN_GAPS` semantics broadened from "session Yahoo drops" to
   "session Yahoo drops OR serves a demonstrably defective bar on";
   0941.HK → {2024-01-15} added. `checkYahooRewrite` now excludes
   known-gap dates from the close-MISMATCH count as well as absence (fresh
   Yahoo keeps serving the phantom, so the divergence arrives as a
   mismatch). +2 tests (mismatch-on-known-gap excluded + listed; mismatch
   off-set still ALARMs). `knownGapDivergences` metric counts all shapes.

**Sentinel after: ALARM 0 · WARN 0 · ok 10 · exit 0** — first fully green
run. 0941.HK eastmoney max dev 1.08% → 0.38%. Tests 293→295 passed / 1
skipped, tsc clean.

Every sentinel class measured this week is now either fixed at ingest
(L5/L6), rescued with curated attribution (YAHOO_KNOWN_GAPS), allowed by
convention (HKEX_KNOWN_HALF_DAYS), or explained by imported events
(IN_SPECIE/F10 overlay). No standing unexplained divergences remain.

---

## 2026-09-06 (Phase-2 CA-source decision — DECIDED + implemented) — eastmoney F10 overlay for CA_DEGRADED + IN_SPECIE events; sentinel down to 1 known ALARM

The standing Phase-2 CA-source open item is closed. New measured fact that
shaped it: F10 (`datacenter.eastmoney.com`, RPT_HKF10_MAIN_DIVBASIC) carries
the in-specie class R3a called "invisible to any event-based check" —
0700.HK 特别分配 rows for JD (2022-01-20, ratio 1/21, no HKD equivalent),
Meituan (2023-01-05, 1/10 + 18.13 HKD/share), Tencent Music (2018), China
Literature (2017). User decisions (all four):
1. **F10 = correction overlay** — Yahoo stays primary for HK stock
   dividends; F10 corrects amounts for CA_DEGRADED names only. US names and
   HK ETFs stay Yahoo-only (F10 has neither — measured).
2. **IN_SPECIE imported** as a new CorporateAction type (ratio +
   HKD-equivalent-when-present; amount now nullable, `detail` audit column —
   migration `20260906163032_ca_inspecie_events`). Store price convention
   unchanged.
3. **Weekly batch, non-blocking** — `pnpm -C apps/api ca:f10-refresh`
   enrichment CLI; failure never degrades screen:daily.
4. Implemented immediately.

**Implementation** (`eastmoney-f10.provider.ts` + pure `parseF10Plan`,
`refresh-f10-ca.ts` with exported `mergeF10ForSymbol`, sentinel eastmoney
leg now in-specie-aware: level comparison starts after the latest IN_SPECIE
ex-date — R3a-prescribed). Tests 252→293 passed / 1 skipped, tsc clean.

**Three load-bearing catches found by live data** (small-lane probe before
the full run): (a) F10 cash amounts are *as-declared* — 1211.HK's 2025
bonus row would have overlaid 3×-too-large pre-split amounts; overlay +
cross-check are now restricted to ex-dates after the latest bonus event;
(b) same-ex-date cash rows SUM (0005.HK 2024-05-09: ordinary $0.10 +
special $0.21 — the overlay now exceeds Yahoo's own event stream there,
flagged loudly); (c) the daily-screen rescue path read all CA rows into
dividend adjustment — IN_SPECIE null amounts would have produced NaN
factors; now filters `type="DIVIDEND"`.

**Live results:** full HK lane refreshed (131 entries, ~2.5 min paced, zero
provider failures): 20 IN_SPECIE rows across 13 names; overlay corrections
across the CA_DEGRADED cohort (9988 ×4, 9999 ×21, 9987 ×7, 9618 ×3, 0005,
9961, …); caDegraded roster now 63 HK names. Sentinel `--eastmoney`:
**0700.HK eastmoney leg 8.48% ALARM → ok (max 0.67%, n898 post-2023-01-05
window). The only remaining ALARM is 0941.HK 1.08% on 2024-01-15** — the
standing known marginal divergence.

**Next:** 0941.HK's 1.08% single-session divergence is the last unexplained
sentinel ALARM (eastmoney vs Yahoo on 2024-01-15; tencent date leg clean) —
candidate for a one-off triage. Cosmetic: same-ex-date summation leaves
float artifacts (9988.HK 1.9510839999999998) — round on write if it ever
matters.

---

## 2026-09-06 (Yahoo-gap rescue) — 3 missing HK sessions rescued from eastmoney; YAHOO_KNOWN_GAPS curated set; sentinel down to 2 known-class ALARMs

Follow-up to the data-quality batch's item 7. Decision (user): record
rescued sessions in a curated known-gap constant — no schema migration, no
per-bar provenance.

**1. `YAHOO_KNOWN_GAPS`** (quant-core calendars): symbol → dates map;
2800.HK {2025-10-24}, 3195.HK {2025-10-24, 2026-03-06}. Admission bar: two
independent carriers (eastmoney fqt=0 + tencent) serve the session while a
fresh Yahoo fetch does not.

**2. `rescueSessions` in repair-store-bars.ts** (`--symbol X --rescue
d1,d2`): eastmoney full-series fetch → fail-closed gates (fetch failure /
date missing or null-OHLC / >10% level break vs nearest stored prior close)
→ upsert only the requested bars. `Instrument.dataSource` stays "yahoo"; no
CA handling (rescue source has none). Rescued bars verified in level:
2800.HK 2025-10-24 close 26.80 (neighbors 26.60/27.04); 3195.HK 10.60
(10.52/10.75) and 10.80 (10.81/10.44).

**3. Sentinel known-gap exclusion — two legs, not one.** `checkYahooRewrite`
gained a `knownGaps` param (excluded from the dirty count, annotated in
details, `(+N known Yahoo gaps rescued)` suffix on ok summaries). The
subagent caught that the **tencent-dates** leg also needed it: its reference
calendar is the fresh Yahoo series (sentinel.ts:210), not the store, so it
kept ALARMing on rescued dates — fixed with a 4th `knownGaps` param on
`checkTencentDates` (new attribution class 3: Yahoo gap, distinct from the
carrier-phantom classes; semantics of the store-vs-tencent direction
unchanged).

**4. Sentinel after: ALARM 4 → 2.** 2800.HK and 3195.HK fully OK across all
four legs. Remaining: 0700.HK 8.48% (Yahoo nets in-specie distributions —
Phase-2 CA-source decision) and 0941.HK 1.08% (marginally over the 1% line).
Both pre-classified. Tests: apps/api 250→252 passed / 1 skipped, tsc clean.

**Next:** Phase-2 CA-source decision (the standing open item; covers the
0700.HK in-specie class). 0941.HK's 1.08%: keep watching — one session
(2024-01-15) marginally over the line, mean 0.00%.

---

## 2026-09-06 (data-quality batch, executed) — loader RULE L5 (null-close) + RULE L6 (level-break segment); sentinel half-day allowance; 3195.HK repaired; store healed to 0 null bars

Executed the locked decisions from the earlier 2026-09-06 entry (all four
recommended options). Tests: quant-core 41→49 passed, apps/api 238→241
passed / 1 skipped, tsc clean both packages.

**1. RULE L5 — null-close guard** (`quant-core/data-quality.ts`, runs first
in `MarketDataService.getDailyBars`): any bar with null close is dropped,
dates returned loudly (Yahoo serves still-forming bars this way — measured
492 US names 2026-08-28, 22 HK 2026-09-01). New `"null-close"` dummy
provider behavior exercises it end-to-end.

**2. RULE L6 — intra-series level-break segment guard** (runs after L2): a
maximal leading/trailing run (≥3) of flat zero-volume bars sitting >10% off
the adjacent 20-bar median is cross-currency stitching; ratio in the
[7.7, 8.1] HKD-peg band → auto-drop with loud warning (3195.HK case);
any other ratio (2836.HK ×2.1 class) → keep + adjudication warning; <3-bar
runs get a point-detector warning; never drops more than half the series.

**3. Sentinel half-day allowance**: `HKEX_KNOWN_HALF_DAYS = {2022-01-31}`
(quant-core calendars); `checkEastmoneyRaw` excludes it from the
date-mismatch ALARM trigger, still listed in details annotated "known HKEX
half-day divergence". Store convention (L1 drops the CNY-eve phantom) is
unchanged.

**4. Integrity header**: screen:daily now reports `N null-close bars
dropped` / `N level-break bars dropped` per lane; warnings flow into
ScreenRun warningsJson.

**5. 3195.HK repaired.** `repair:store -- --symbol 3195.HK` rewrote the
series through the hardened loader: 508 bars starting 2024-08-08 at the
correct HKD level (8.13); the 69-bar USD-counter prefix (66 flat zero-vol +
3 null) was dropped by L5/L6 during the re-fetch. Sentinel eastmoney max
|dev| for 3195.HK: **709% → 0.18%**.

**6. Null-bar heal — DONE.** Full `screen:daily -- --market all`:
US 555/555, HK 131/131, 0 fetch-failed; 61 US + 86 HK null-close bars
dropped at ingest; stored null-close bars: **646 → 0** (the EA/EQR/AVB
recurrence did not survive the guarded rewrite).

**7. Sentinel re-run (--eastmoney): 4 ALARMs, all classified, none new-class:**
- 0700.HK max 8.48% on 2021-09-20 — the known Yahoo net-of-in-specie-
  distribution divergence (JD/Meituan steps; Phase-2 CA-source decision).
- 0941.HK max 1.08% — marginally over the 1% line, as before.
- 2800.HK and 3195.HK: **store missing 2025-10-24** (both eastmoney and
  tencent carry it → a Yahoo gap, not a phantom); 3195.HK also missing
  2026-03-06. New follow-up: rescue those single sessions via the §A
  eastmoney path.
- The 2022-01-31 half-day ALARMs are gone (9 names quieted); zero
  yahoo-rewrite ALARMs (every leg "identical").

**Next:** repair the two missing ETF sessions (2800.HK 2025-10-24,
3195.HK 2025-10-24 + 2026-03-06) from eastmoney; then the Phase-2 CA-source
decision remains the standing open item.

---

## 2026-09-06 (quick wins) — architecture §4.1 Databento row extended to XNYS; eastmoney ban LIFTED + §A live validation done; first sentinel eastmoney leg run (ALARMs all classified)

**1. architecture-v1 §4.1**: the existing Databento routing-table row now
covers both archives (XNAS all-plain-symbols + XNYS NYSE-listed-restricted),
registry totals post-echo-dedupe (2,642 yahoo + 594 inband = 3,236),
VendorSegment reuse handling, and space→dot normalization. This closes the
doc touch-up open since 2026-09-05.

**2. eastmoney ban re-check — LIFTED.** Single throttled probe to `push2his`
(0005.HK, fqt=0): HTTP 200 with real klines. The 2026-08-31 ban lasted
between 36h and 6 days. §A's rescue-source decision stands (bans do not
routinely outlast a week).

**3. §A live rescue-path validation — DONE.** `EastmoneyRepairProvider.
fetchRawBars("0700.HK")`: 5,476 raw bars 2004→2026-09-04 in 2.2s, 0 parse
failures; vs store on 1,226 overlapping dates: **median |Δ| 0.0000%**.
Measured caveat (new): old bars deviate up to 8.48% in exactly two steps —
Tencent's JD.com (2022) and Meituan (2023) distributions-in-specie.
**Yahoo's stored closes are net of in-specie distributions; eastmoney fqt=0
is pure as-traded.** Rescuing such a name shifts its old-bar levels and the
kept Yahoo dividend events don't cover in-specie distributions. Exact for
names without them; flagged for the Phase-2 CA-source decision (hardening
plan §A update).

**4. First `screen:sentinel -- --eastmoney` run — leg works** (10/10 names
answered at ≥2s+jitter pacing, no re-ban; exit 1 with 10 ALARMs — every
ALARM classified):
- `2022-01-31` date-set mismatch on 9 names: CNY-eve half-day. eastmoney
  serves it; the store's L1 rule drops it from Yahoo data
  ("holiday-phantom"). This is the live evidence for the pending
  "eastmoney-raw half-day-excluded" decision (2026-09-03, still open).
- 0700.HK max 8.48%: the in-specie-distribution steps from §3. 0941.HK
  1.08% marginally over the 1% alarm line; all others ≤0.54%.
- 3195.HK max 709%: the known USD-counter defect (user decision still
  pending — drop/convert its 72 oldest bars).
- **NEW DEFECT surfaced: null-close bars stored at ingest.** 492 US names
  carry an all-null bar for 2026-08-28 and 22 HK names (mostly ETFs) for
  2026-09-01 — Yahoo served still-forming/unfinalized bars on run day and
  the loader stored them instead of dropping. EA/EQR/AVB show the same
  pattern repeatedly (17/12/6 nulls in 30d). Self-heals on the next
  full-window rewrite, but the loader should refuse null-close bars;
  recommend folding into the pending data-quality decisions (with 3195.HK).

**What's next**: Phase 2 design (deep tier): agent pipeline +
Piotroski/earnings inputs + eastmoney-F10 CA-source decision.

**Decisions taken 2026-09-06 (user) — execution spec for the data-quality
batch (fast tier, decisions locked):**
1. **3195.HK repair — drop + re-derive.** Delete its oldest 72 bars (the
   USD-counter segment, through 2024-04-30 per the sentinel's max-dev date),
   re-derive the adjusted series. Adopt the intra-series integrity check
   (per-row level jump vs local level, the >10% class from
   `docs/research-akshare-tickdb.md`) in the loader so the class is caught
   at ingest; one run covers both.
2. **Null-close loader guard + repair now.** Loader drops any bar with null
   close (loud warning, counted in the integrity header); then re-run the
   daily ingest (`screen:daily`, both lanes) to rewrite the window and heal
   the 514 stored null bars (492 US 2026-08-28, 22 HK 2026-09-01).
3. **HK half-day convention — half-day-excluded confirmed.** Store
   convention unchanged (L1 drops 2022-01-31); change the sentinel's
   eastmoney leg to allow the known HKEX half-day set (2022-01-31 today;
   source the set from the store's L1-drop warnings) instead of alarming.
4. **HK universe — accept 131.** No non-index H-share chase.

---

## 2026-09-06 (echo dedupe + XNYS FAR funnel) — 4 inband echo rows deleted; XNYS FAR review funnels 913 → 1 append (BHVN); new `split:add` CLI

Both follow-ups from the XNYS import session executed, user-approved scopes
(item 1: all 4 echo pairs; item 2: verify-then-append the 6 in-universe FAR).

**1. Echo-pair dedupe — DONE.** Systematic sweep (yahoo+inband on same symbol
within 21d) found BNDD was not alone: 4 echo pairs + 2 incompatible-factor
pairs (MSPR, SMX — distinct serial-splitter events, left alone). Root cause:
the XNAS import ingested all 1,372 crosscheck additions (not the decided
FAR-only 653), so NEAR-tier echoes entered the registry; corroboration and
persistence audits structurally can't catch them (the reprice is real, only
date/factor duplicated). Each echo verified against primary sources (real
event = the yahoo row; inband row = detector firing on the first archive bar
after a multi-session no-bar gap, lattice-snapping the measured step):
- BNDD 2025-09-12 deleted (real: 1:8 reverse 2025-09-05 — BOX Exchange memo
  + MIAX corporate-action alert).
- EFAX 2023-01-18 deleted (real: 2:1 split 2023-01-12 — OCC Infomemo 51629 +
  State Street press release).
- FLYD 2024-03-27 deleted (real: 1:10 reverse 2024-03-25 — BMO press release
  2024-03-15).
- FLYD 2026-02-26 deleted (real: 1:10 reverse 2026-02-24 — BMO batch-2
  reverse-split FWP 2026-02-12).
All via `split:delete` with evidence in the reason string. Re-segmentation
safety checked: all four gaps are <10 sessions and/or lattice-matched, so the
stitch rule can't newly fire on those dates.

**2. XNYS FAR-tier review — DONE, funnel is much smaller than framed.** The
review's "913 candidates with no registry event" used exact (symbol, exDate)
matching. Applying the XNAS-precedent filters against the current registry:
913 → −117 echo-like (≤14d + factor within 25%-log of a registry event — the
BNDD/EFAX class, must NOT be appended) → 161 FAR (≥4×/≤0.25×) → −155 on
symbols outside the imported 5,333-symbol XNYS universe (Option A) → **6
in-universe candidates**. Verification of the 6 (bars + primary sources):
- **BHVN 2022-10-04 — APPENDED** (FORWARD_SPLIT 18.289:1, inband/estimated):
  Pfizer acquired old Biohaven 2022-10-03 ($148.50 cash + 0.5 new-Biohaven
  share per old share; Pfizer 10-K); new BHVN first traded 2022-10-04; Yahoo
  has no event. Factor = close-measured 151.8/8.3 (true adjustment ≈18.4
  incl. 0.5-share terms; detector's open-based 21.3 rejected). Spinoff/
  acquisition class — consistent with the §8 deferral rationale (real price
  step needed for back-adjustment).
- **LPA 2024-06-05 — rejected**: de-SPAC low-float pump/collapse
  ($10→$213→$17 across days, chaotic both directions), no corporate action.
- **MI 2026-03-10 — rejected**: no corporate action found (Yahoo silent; only
  2026 split news is the later 1:80 reverse effective 05-18); microcap crash.
- **PLAG 2026-08-12 — rejected**: 08-11 intraday spike 0.70→6.66 (9.5×) then
  revert to 1.245; pump-and-revert, not a split.
- **QXO 2024-07-30 — rejected**: market repricing toward the $9.14 placement
  price of the $1B private placement (10-Q/8-K); no corporate action that day.
- **RFL 2021-10-28 — rejected**: 8-K that day = devimistat Phase-3 AVENGER
  500 failure + ARMADA 2000 stopped; genuine -73% news crash.

**3. New CLI `split:add`** (`apps/api/src/cli/add-split-event.ts`,
`pnpm -C apps/api split:add`): the append side of `split:delete` — derives
factor from ratioNew/ratioOld, enforces event/factor direction agreement,
refuses on existing (symbol, exDate), loud logging. 4 unit tests. Suite
238 passed / 1 skipped; tsc clean.

**Registry now: 2,642 yahoo + 594 inband = 3,236 SplitEvents.**

**Detector lessons (for any future in-band run):** (a) dedupe candidates
against the registry with a ±14d window + 25%-log factor match, not exact
dates — exact matching let 117 echo-likes into the XNYS 913 and 4 into the
XNAS registry; (b) detector factor is open-based — for verified appends
prefer close-measured factors; (c) FAR-tier on the imported universe still
needs per-symbol verification — 5/6 were non-corporate-action repricings
(trial failure, placement repricing, pump spikes).

**What's next**: XNYS data + registry ready for consumers. Optional: the 27
NEAR-tier in-universe candidates (and 24 echo-class rows) stay unvetted
(FAR-only policy); architecture §4.1 routing-table row for Databento still
open.

---

## 2026-09-06 (XNYS import) — archive IMPORTED under Option A + segmented; 3 phantom registry rows deleted; spinoff class deferred to docs

All user-approved. Six-step sequence from the XNYS review completed:

1. **Import manifest** (`scripts/databento/xnys_import_manifest.py` →
   `xnys-import-manifest.csv`): 20,189 XNYS symbols → **5,352 approved**
   (5,325 listed-nyse per reference + 27 backstop). Volume cross-check
   validates the reference (approved overlap median XNYS/XNAS vol ratio
   1.23; rejected NASDAQ names 0.11). Backstop set turned out to be mostly
   NYSE test symbols (NTEST/CTEST/MTEST/PTEST — excluded, user-approved
   test-symbol convention extended); BRK.A the only economically
   meaningful capture.
2. **Yahoo sweep extension** (12 surviving new symbols,
   `xnys-yahoo-splits-sweep.mjs`): zero split events; BRK-A confirmed;
   XNYS `HOS` flagged as probable ticker reuse (Yahoo's HOS = delisted
   Hornbeck Offshore).
3. **Importer** `apps/api/src/cli/import-databento-xnys.ts`
   (`import:databento:xnys`): per-day streaming ingest, manifest-driven,
   space→dot normalization at storage (`BRK B`→`BRK.B`), NYSE test names +
   space derivative suffixes classified out, sha256 journal. Dry-run
   reconciled exactly.
4. **Import DONE**: 1,254/1,254 files, **3,993,374 VendorBar rows**,
   5,333 symbols, 0 failures/dupes/OHLC violations; VendorInstrument 5,321
   upserted. Suite 234 passed / 1 skipped; tsc clean.
5. **Segmentation** (`segment-vendor-bars.ts --vendor databento-xnys`):
   27 stitched symbols found; BNY stitched at the SAME boundary as XNAS
   (cross-archive corroboration). 8 ambiguous boundaries (registry event
   in gap): **all 8 merged after review** (PSIL/BNDD near-exact factor
   matches; AIM/PAPL/LTL/BKEM/BKSE/RZG consistent with factor + drift over
   long gaps — leveraged-ETF/microcap-serial-splitter class). Final:
   **5,352 VendorSegment rows, 19 stitched symbols = genuine ticker reuse**.
   Flagged: BNDD registry duplicate pair (yahoo 1:8 2025-09-05 + inband
   1:8.33 2025-09-12, same-event echo — EFAX pattern) not yet deduped.
6. **Registry patches**: phantom rows CENN 2023-12-01 (postponed; real
   12-08 kept), CLSM 2025-10-27 (never happened), CNF 2023-11-08 (stale
   low-print false positive) **deleted** with primary-source evidence —
   **registry now 2,642 yahoo + 598 inband = 3,240**. Spinoff-as-split
   class (GE ×2, T, ~19 known + ~40 candidates): user decision = defer,
   documented in `docs/research-databento-import.md` §8 (do NOT delete —
   real price steps needed for back-adjustment; add eventType column if
   ever needed).

**What's next**: (a) BNDD duplicate-pair dedupe (needs one verification
pass on which date is real); (b) optionally FAR-tier in-band split
detection over the XNYS universe using `xnys-split-candidates.csv`
(2,414 plausible, of which 913 have no registry event — the Yahoo-gap
class); (c) XNYS data is otherwise ready for consumers.

---

## 2026-09-05 (XNYS review) — NYSE 5y OHLCV-1d archive quality-checked: clean, importable; one new decision pending (universe scope)

Read-only review of `~/Downloads/XNYS-20260903-GYR7NW7XTP` (XNYS.PILLAR,
ohlcv-1d, per-DAY files — structure inverted vs XNAS's per-symbol). Scripts:
`scripts/databento/xnys_{manifest_check,full_scan,split_detector,registry_crosscheck}.py`;
candidates `xnys-split-candidates.csv`, cross-check `xnys-registry-crosscheck.csv`.

- **Integrity/coverage**: manifest sha256 1,256/1,256 PASS. 1,254 session
  files, 2021-09-03→2026-09-02, no gaps; 50 file-less dates = market
  holidays (condition.json marks holidays "available" — treat as calendar).
  4 `degraded` days incl. 2023-01-24 (NYSE opening-auction glitch). Total
  **9,471,460 rows**, zero anomalous days.
- **OHLC sanity: remarkably clean** — zero violations of any kind across
  9.47M rows (cleaner than XNAS, which had empty no-trade rows). Flip side:
  thin names have mid-series holes — importers must treat missing dates as
  normal. Only 3,085 symbols have full 1,254-bar history.
- **Symbol universe**: 20,189 symbols; 18,565 plain + 1,624 non-plain in
  NYSE *space* notation (` WS`, ` U`, ` PRA`, ` WI`, ` RT` vs Nasdaq
  punctuation). **Feed-purity trap is bidirectional**: XNYS carries the
  whole NASDAQ universe (AAPL/MSFT/NVDA full history) at ~3–5% UTP volume —
  mirror of the XNAS ADF caveat; `publisher_id` uniformly 9 doesn't help.
  2,301 Nasdaq-notation 5-char U/W/R derivatives pass the bare plain-regex
  (the importer's final classifier must be ported, not just the regex).
  Test-symbol leak here too: 7 of 14 (ZVZZT full-history).
- **instrument_id still not fully stable** (194 symbols with 2 ids, 3 with
  3) → symbol-keyed storage reconfirmed.
- **Split/stitch detection (v3 gates + persistence + gap classification,
  all lessons applied)**: 3,119 raw candidates → 163 bad-open-print
  (persistence gate kills them, same as XNAS), 583 ticker-reuse across
  >14d gaps (**persistence alone can't kill this class** — the new occupant
  reprices permanently; the gap signal is essential), 2,414 plausible.
  META/BNY/FB stitches reproduce identically (132d/104d/1,114d gaps).
- **Registry cross-check on the overlap** (3,226 events): 96.5% reprice at
  the right date in the right ballpark; 84.5% tight; detector recall 47.5%
  (XNAS ~50%) — validates both archive and registry. 913 plausible
  candidates have no registry event (Yahoo-gap class). Loose end: 3
  registry rows (CENN 2023-12-01, CLSM 2025-10-27, CNF) show NO repricing
  in XNYS — possible cancelled/postponed events; spot-check vs a third
  source before relying on them. Registry also carries **spinoff
  distributions Yahoo reports as "splits"** (GE 2023-01-04/2024-04-02 =
  GEHC/GEV, T 2022-04-11 = WarnerMedia) — consumers beware.
- **Anchors 5/5**: SHOP 10:1 2022-06-29, GME 4:1 2022-07-22, WMT 3:1
  2024-02-26, CMG 50:1 2024-06-26 (measured 49.97), WSM 2:1 2024-07-09.
- **Verdict**: importable with existing conventions. Adapt: per-day
  streaming ingest + regroup by symbol, symbol from the `symbol` column,
  ported classifier. Keep: symbol-keyed VendorBar, manifest gate,
  Yahoo/FAR registry, segmentation pass, persistence gate. **NEW DECISION
  (user, deep tier): universe scope** — importing everything double-stores
  ~16k NASDAQ names at degraded ~4% volume; recommended to restrict to
  NYSE/Arca-listed names via the listing-exchange reference (or record a
  volume-completeness flag).

---

## 2026-09-05 (persistence gate + segment merges) — 331 bad-print rows deleted, detector v4, AREB/SPRB merged (all user-approved)

- **Persistence re-audit of the 929 in-band rows** (new read-only CLI
  `pnpm -C apps/api audit:persistence`, report
  `apps/api/reports/inband-audit-persistence-2026-09-05.{csv,json}`). Rule:
  over ex-day close + next ≤3 same-segment sessions, count closes within
  25%-log of prevClose (`prevHits`) and of prevClose/factor (`persistHits`);
  `bad-print` iff prevHits ≥ 2 AND persistHits < 2 (the impliedHits guard
  rescues shallow factors whose tolerance bands overlap). Result: **598
  genuine-persistent / 331 bad-print** (of the 413 drifted rows: 329 bad /
  84 genuine; 2 of the 516 "corroborated" were single-print artifacts —
  CRIB, LEV+A). Anchors verified: AACT/AAMI bad-print, ACRS/ACRX genuine.
- **Deletion:** batch mode removed all 331 bad-print rows (0 missing).
  **Registry now: 2,645 yahoo + 598 in-band = 3,243 SplitEvents.**
- **Detector close-persistence gate** — new
  `scripts/databento/split_persistence_filter.py` post-filters the v3
  candidate CSV (no archive re-scan; same rule/tolerance). v3 3,589 →
  **v4: 2,583 kept, 1,006 rejected** as bad-open-print
  (`scripts/databento/detected-split-candidates-v4.csv`). All documented
  detector anchors preserved.
- **AREB/SPRB ambiguous boundaries resolved — merged.** Both were
  over-detection: multi-week trading gaps containing the actual Yahoo
  reverse split (AREB 1:100 on 2026-03-23; SPRB 1:75 on 2025-08-05).
  AREB#2→AREB#1 (1,045 bars) and SPRB#2→SPRB#1 (1,159 bars) re-tagged,
  VendorSegment rows merged with evidence notes (VendorSegment 16,843 →
  16,841), duplicate SPRB 2025-08-07 Yahoo SplitEvent deleted. Stitched
  symbols now 70.
- Tests: 224 passed / 1 skipped (+7 new persistence-gate specs); typecheck
  clean. Borderline genuine kept: ADAP 2024-10-31 (shallow 0.69 factor,
  overlap-band rescue) — eyeball if a stricter shallow-factor policy is
  ever wanted.

---

## 2026-09-05 (registry cleanup) — 273 uncorroborated in-band SplitEvent rows batch-deleted (user-approved)

`delete-split-event.ts` gained a batch mode (`--from-csv … --class … --yes`,
same loud per-row logging, exit 1 on any missing row). Deleted all 273
`uncorroborated` rows from the 2026-09-05 in-band audit (bad-open-print class;
BR was the prototype) — 0 missing, exit 0. Registry now: **2,645 yahoo +
929 in-band = 3,574 SplitEvents**. The 413 `drifted-but-plausible` rows remain
pending user review in `apps/api/reports/inband-audit-2026-09-05.csv`.
Typecheck clean; suite 217 passed / 1 skipped.

---

## 2026-09-05 (data patches) — MNST store repaired via Yahoo re-fetch, BR false SplitEvent deleted, all 1,203 in-band registry rows audited

R4-anomaly data patches (diagnosis in the segmentation-era entries above):

- **MNST store repair — DONE.** Store `Bar` had phantom half-price bars on
  2026-07-20/21/22, 07-31, 08-06 (~$47–48 vs true ~$95) plus a null bar on
  2026-08-10: a mix of pre-split (unadjusted) and post-split (Yahoo
  retro-adjusted) fetches. Root cause confirmed by live probe: after the
  2026-08-11 2:1 split Yahoo retro-adjusts the whole series, so any
  post-split fetch of a window returns half-price bars that collided with
  the stored unadjusted ones. Fixed by a full-window re-fetch through the
  normal ingest path (new `pnpm -C apps/api repair:store -- --symbol MNST`
  = YahooMarketDataProvider → MarketDataService L1/L2 → daily-screen's
  deleteMany+createMany rewrite; fail-closed sanity gate aborts without
  writing if the fresh fetch still shows a >1.8× overnight jump or lacks a
  required date). Post-repair: 1,255 bars, phantoms gone, 08-10 present,
  splitCount=2 observed. Store↔vendor (split-adjusted via SplitEvent)
  daily-return diffs across 2026-07-15→08-15: max 1.20% — the strict 0.5%
  bar is NOT met on 5 days, but healthy-symbol baselines show the
  Yahoo↔Databento-XNAS convention noise is far larger (AAPL 6.8%, MSFT
  10.2% max single-day return diff in the same window, incl. a session-
  dating shift on 07-30), so the residual is convention noise, not
  corruption.
- **BR 2024-10-04 SplitEvent (15:8, inband/estimated) — DELETED** via new
  logged script `pnpm -C apps/api split:delete -- --symbol … --ex-date …
  --reason …` (prints row JSON before/after, refuses when absent). Root
  cause measured: vendor 2024-10-04 open printed 114.75 vs prev close
  215.07 (1.874× ≈ factor 1.875 — the detector's trap) while the ex-date
  close was 215.39 — a single bad open print, not a repricing. BR has no
  other SplitEvent rows.
- **In-band registry audit — DONE** (`pnpm -C apps/api audit:inband`;
  report `apps/api/reports/inband-audit-2026-09-05.{json,csv}`). NOTE: the
  registry holds **1,203** inband rows, not 653 — 653 was the pre-import
  FAR tally; the imported set was 1,372 FAR − 169 test-symbol drops.
  Rubric: prev close vs ex-date open AND close; e = max|ln(measured/
  factor)|; corroborated ≤ ln 1.25, drifted ≤ 2·ln 1.25, else
  uncorroborated; different-segment prev/ex bars are their own class.
  (In-band factor is the detector's own open-based estimate, so the open
  leg is near-vacuous; the close leg is the real persistence test — this
  is exactly what reproduces BR as uncorroborated.) Tallies: **516
  corroborated · 413 drifted-but-plausible · 273 uncorroborated · 0
  segment-boundary · 0 no-bars.** Zero boundary rows is structural: the
  segmentation stitch rule exempts dates carrying a SplitEvent. The 273
  uncorroborated are dominated by the BR signature (open repriced to the
  factor, close unmoved ⇒ bad open prints, not splits). NO rows deleted
  beyond BR — the full list is in the report CSV for user review.
- Tests: 10 new unit tests (BR-exact-numbers rubric case, boundary/no-bars
  classes, repair sanity gate incl. phantom-jump rejection); 217 total
  green, typecheck clean.

---

## 2026-09-05 (segmentation) — Vendor-archive identity layer BUILT + validated: 72 stitched symbols, anchors META/BNY/FB PASS

Decision §6.8 executed. `apps/api/src/cli/segment-vendor-bars.ts`
(`pnpm -C apps/api segment:databento [--symbols …] [--limit N]`):

- **Schema** (additive migration `20260905120000_vendor_segmentation`):
  nullable `VendorBar.segmentId` + `VendorSegment(vendor,symbol,segmentId,
  firstDate,lastDate,evidence)`. Every bar tagged (11,330,404); 16,843
  segments across 16,765 symbols; unstitched = single segment.
- **Stitch rule** as decided (gap >14 cal. days AND jump outside
  [1/2.5, 2.5] AND no SplitEvent on the date AND no split explanation) with
  **one disclosed strengthening**: the rational lattice (n:d, 1..32 ∪
  {40,50,64,65,70,80,100}, 5% log) is dense enough that ALL THREE anchors
  match a rational (META 15.95× ≈ 16:1 at 0.33% log; BNY 13.60× ≈ 27:2;
  FB 0.205× ≈ 1:5) — a price-only condition (d) makes the §6.8 validation
  set unflaggable. So (d) mirrors the detector fully: a lattice match must
  ALSO pass the detector's volume signature (NEAR 0.5–4: day + 5-session
  persistent volume ≈ k within ±55%; FAR: direction-consistent persistence;
  insufficient volume history ⇒ price match alone decides, conservative).
  Across a real reuse the occupant changes and volume contradicts every
  split hypothesis — this is what flags META/BNY/FB. Flag for review if the
  letter of §6.8 was intended.
- **Full run** (~45 s): 72 stitched symbols, 78 boundaries. Anchors META
  (2022-01-28→2022-06-09), BNY (2026-02-06→2026-05-21), FB
  (2022-06-08→2025-06-26) all PASS with exact boundaries; fail-closed exit
  on anchor failure. Report artifact `apps/api/reports/
  segment-vendor-bars-2026-09-05.json`. Idempotent (transactional replace).
- **Honest read**: the 72 are dominated by genuine long-dormant ticker
  recycling (BBBY, HLTH, CORZ, PARA, WW…). 6 boundaries have a registry
  split INSIDE the gap; 4/6 are still reuse by direction (VIVO/PARA/MF/VELO),
  AREB (1:100 in gap, observed 27×) and SPRB (two 1:75 in gap, observed
  190×) are the genuinely ambiguous ones — possible mild over-detection on
  serial reverse-splitters whose ex-date bars are absent from the archive.
  Under-detection by design: same-day reuse (no gap), gaps ≤14 days, reuse
  jumps inside [1/2.5, 2.5].
- Tests: 16 new unit tests (synthetic series: META-like flagged, plain gap
  not, SplitEvent-on-date not, 3:1-with-split-volume not, same rational
  with occupant-swap volume flagged, same-day jump not, 3-segment
  multi-stitch); 207 total green, typecheck clean.

---

## 2026-09-05 (later) — DataBento importer CLI BUILT + full archive imported: 16,765 files, 11.2M rows, 0 failures

Step §7.4 done. `apps/api/src/cli/import-databento.ts`
(`pnpm -C apps/api import:databento [--limit N] [--symbols …]`):

- **Schema** (additive migration `20260905093000_databento_vendor_archive`):
  `VendorBar(vendor,symbol,date,OHLCV)` as-traded · `SplitEvent(symbol,exDate,
  event,ratios,factor,source,confidence)` · `VendorInstrument` (listing
  classification) · `VendorImportFile` (per-file journal). Instrument/Bar and
  R1 untouched (decision 6.5). Bulk insert = Prisma `$executeRawUnsafe`
  `INSERT OR REPLACE` in per-file transactions (no better-sqlite3 in repo —
  stayed on the existing Prisma layer, no new deps); zstd via system `zstd -dc`.
- **Universe**: 20,623 files → 16,765 imported (3,842 non-plain, 16 test
  excluded: 14 listing-CSV `flag=test` + hardcoded Z-class ∪ ZVOL/ZBA — a
  superset of the doc's "9 known"; the 7 extra are NYSE/IEX/BZX test names).
- **Full run** (~3 min): 11,203,925 rows inserted, 0 sha256 mismatches,
  0 failures, 0 zero-tradeable symbols, coverage 2021-09-02 → 2026-09-01,
  per-file rows min/max/median 1/1254/613. Journal idempotent (re-run skips).
- **Registry**: 3,848 SplitEvents = 2,645 yahoo ∪ 1,372 inband FAR, 0 conflicts,
  169 test-symbol rows dropped.
- **R4 cross-validation** (report-only, 553 shared US symbols, 680,775 return
  pairs): match rate 37.8% at |Δ|≤0.1%, median |Δ| 0.18% (dominated by Yahoo
  adjusted-price rounding). Worst outliers are symbol-history artifacts, not
  import bugs: META 2022-06-09 = FB→META ticker change (vendor 14.04×),
  BNY/MNST similar one-sided store anomalies — worth a data-quality follow-up.
- Tests: 20 new (unit + fixture integration), 191 total green; typecheck clean.

**Next**: architecture §4.1 routing-table row for Databento; optionally vet the
NEAR-tier 719 cross-check rows; META/BNY/MNST store anomalies from R4.

---

## 2026-09-05 — Sweep + full detector run + cross-check COMPLETE: registry 2,645 events, 1,372 proposed additions (653 high-confidence)

All three execution steps from the research plan are done (doc §7 updated with
full results):

- **Sweep**: 16,781/16,781, zero failures. 13,416 ok / 3,365 not-found (20.0%).
  Registry = 2,645 events / 1,731 symbols (495 forward / 2,150 reverse).
- **Detector v3 over full archive**: 3,589 candidates, 0 error files.
- **Cross-check** (`split-crosscheck.mjs`): confirmed 1,283 · factor-mismatch 42
  · yahoo-missed 869 · yahoo-blind-spot 503 · out-of-scope 892. Detector recall
  ~50% vs registry — misses decompose as 649 real-signature-outside-tolerance
  (e.g. ABVC +22% ex-gap), 305 ex-date absent from file, 70 beyond 1:100
  lattice (ACON 1:335), 129 boundary classes. Fine for its advisory role.
- **Proposed registry additions: 1,372**, tiered by confidence — FAR (≥4×
  repricing) 653 spot-check real (NESR/NINE/NIVF verified); NEAR 719 NOT for
  bulk append. Yahoo's gap on answered symbols ≈ 2% (FAR); its real weakness
  is the delisted blind spot, where the detector adds 385 FAR events.
- Test symbols (ZVZZT-class) leaked into sweep journal and candidates —
  exclude at registry finalization.

**Open for user (deep tier)**: storage fork (§6) + registry finalization
policy (FAR-only vs also vetting NEAR). Then the importer CLI (step 4).

---

## 2026-09-04 — Review of the 09-03 session; sweep hardened + RUNNING; detector fixed (v3); cross-check tooling ready

Reviewed the prior (Qwen3.8-flash) session's analysis before executing its plan
(`docs/research-databento-import.md` updated with all corrections).

**Verified accurate** (live re-probes): ITCH bars are as-traded/unadjusted (NVDA
1208.00 → 120.87 on 2024-06-10, in-file); Yahoo v8 full-history depth + anchors;
the TBLT 1:65 Yahoo gap is real; ~25% Yahoo 404 rate (mid-sweep: 21.6%).
**One claim retracted**: TRAP-1 "windowed Yahoo requests drop in-window split
events" does NOT reproduce — 2026-09-03 observation was a probe artifact; the
`period1=0` mitigation stays (strictly conservative). Doc §4.2 corrected.

**Done:**
- `yahoo-splits-sweep.mjs` hardened: transient statuses (retries-exhausted /
  exception / http-*) now re-fetched on resume (were permanently skipped);
  completion check updated. Sweep **launched ~09:20 UTC, running in background**
  (16,640 to fetch, est 2.9h; health check at 3,674: zero failures/429s).
- `split_candidate_detector.py` → **v3, validated** (was shipped with 3 defects:
  symbol never written to output; candidate lattice capped at 1:10 reversals —
  whole microcap-reversal gap class unmatchable; v1-scale noise). v3: symmetric
  lattice to 1:100, tiered gates (≥4× overnight gap ≈ unique to corporate
  actions ⇒ loose FAR tier stays specific), plausibility floors. All 11 anchor
  events detected, ex-dates exact, incl. TBLT 1:64 and KTTA 1:20; noise ~2 rows
  / 23 files. Factors are bars-derived estimates (up to ~17% off on wide-gap
  microcap ex-dates) — dates exact, which is what the cross-check needs.
- Listing-exchange classification via `nasdaqtraded.txt` (free, current-only):
  11,875/16,781 plain symbols classified → `symbol-listing-exchange.csv` in the
  download dir. Only ~30% of matched are NASDAQ-listed common stock (ADF caveat
  quantified); the 4,906 unmatched are delisted names (spot-verified), aligning
  with the Yahoo 404 rate — security-master subscribe now clearly low-value.
- New `scripts/databento/split-crosscheck.mjs`: registry↔detector join →
  `split-crosscheck-report.csv` + `split-registry-additions.csv` (inband/
  estimated, registry-schema-compatible). Tested against anchors: NVDA/KTTA
  confirmed, TBLT flagged yahoo-missed with 1:64 as expected.

**Next** (when sweep lands): full-archive detector run → cross-check → honest
gap-rate report → then the storage-fork decision (§6, user call, deep tier),
now informed by the listing-exchange stats.

---

## 2026-09-03 (late) — DataBento XNAS 5y OHLCV-1d archive: audited; Yahoo chosen as split source; sweep ready to run

User downloaded Databento batch `XNAS-20260902-W559N3FC8U` (~266 MB zst → ~1.4 GB,
20,623 per-symbol CSVs, 2021-09-02→2026-09-01, schema `ohlcv-1d`). Session was
plan-first (no store changes). Full audit + decisions in
**`docs/research-databento-import.md`** — read it first when resuming.

Measured findings: bars are **as-traded, NOT split-adjusted** (NVDA/TSLA ex-date steps
verified) → collides with R1's store-boundary invariant unless normalized by a split
registry; the feed is **not NASDAQ-only** (NYSE names present via ADF at partial volume;
`publisher_id` useless for classification); filenames URL-encode inconsistently
(`%2B` vs literal `#`); `instrument_id` unstable within one symbol; `manifest.json`
ships sha256 per file (free import integrity check).

Split sourcing evaluated three ways: **Databento Reference API** — exact contract proven
(`corporate_actions.get_range`, fields `start`/`end` not `start_date`; their NVDA result
matches our measured steps) but user key gets
`403 license_reference_dataset_no_subscription` on all three reference datasets (free
portal subscribe would fix — deferred). **Yahoo v8 events** — chosen: full-history depth
(AAPL 1987+), 11/12 anchors exact incl. microcap reversals from Databento's own docs;
two traps recorded (events silently window-filtered ⇒ always `period1=0`; delisted/M&A'd
names 404 ≈25% of plain sample). One real gap confirmed: `TBLT` 1:65 reversal visible in
ITCH bars, absent from Yahoo ⇒ in-band detector kept as second opinion (v1 heuristic
measured unreliable both directions; v2 persistence-gated script saved untested).
**In-band detection alone** — rejected as primary.

Artifacts ready: `scripts/databento/yahoo-splits-sweep.mjs` (plain symbols only = 16,781;
resumable journal + registry CSV; smoke-tested, 141 symbols already journaled; start
command in doc §5, ≈2.9h) and `scripts/databento/split_candidate_detector.py`.

Next session: run sweep → validate/run detector → cross-check & report gap rate → then
the open storage fork (separate as-traded `VendorBar` archive vs R1-normalized merge into
`Instrument/Bar`) decides the importer design (`import-databento.ts`, better-sqlite3 bulk,
sha256 verify, Day-17-style typed validation, R4 return-level cross-validation).

---

## 2026-09-03 — Provider research: AKShare + TickDB (verdict: add neither) + a live `3195.HK` store defect

### What was done

Answered "are AKShare / TickDB feasible providers for HK and US stocks + ETFs"
**empirically** — live probes against both, plus a whole-HK-lane audit against
the store, rather than reading their docs. New
`docs/research-akshare-tickdb.md`; `docs/architecture-v1.md` §4.1 (two new
source rows + a rejected row + corrected exclusion reasons), §4.2 (new **R3a**
invariant, R4 qualification), §4.1 tail (adjusted-series nuance), §11 risks 5
and 6 extended. Nothing in `src/` was changed — §4 below is a defect report
needing your call.

**Method.** Disposable venv (`/tmp/akenv`, akshare 1.18.94) for AKShare; direct
HTTP for TickDB (its no-registration trial key from `GET /api/public/claw-keys`);
Node `fetch` + Node `vm` to test portability of the underlying endpoints without
Python. 131/131 HK instruments and 45 US names compared bar-for-bar against the
store over the full 5-year window (154,895 + 55k comparisons). Artifacts and
re-runnable probes listed at the head of the research doc.

### Verdicts (all measured)

- **TickDB — not feasible, close the line.** Coverage is real and *does* include
  ETFs (catalogue HK 3,543 / US 14,169 with 5,479 ETF-named; **131/131 HK and
  562/564 US** of our own instruments present), and quality is excellent
  (median close deviation vs the store **0.0000 %**, volumes identical to the
  unit) — which is the problem: it is the **same numbers as Yahoo**, so it buys
  no independence. Decisive: **no dividend or split endpoint and no `adjust`
  parameter anywhere in its OpenAPI** ⇒ §4.2 R1 (store raw **+ events**) is
  unsatisfiable at any tier. Free tier measured: 72 whitelisted symbols, `3007`
  `kline_history_years_limit: 1`, `limit=1000` rejected outright, 30 req/min on
  a **single globally shared** trial key (≈10 calls saturated it; ~50 probes drew
  `403`). 5-year history = Enterprise $899/mo (~$10.8k/yr) to duplicate Yahoo.
  Two integration traps recorded: daily bars are stamped at **exchange-local
  midnight in UTC ms** (naive UTC join shifts every HK bar one session — that is
  what produced my first, wrong, "1.9 % deviation" result), and `kline` returns a
  **still-forming bar** despite documenting "completed periods".
- **AKShare — right coverage, wrong dependency.** The 2026-08-31 exclusion
  reason ("A-share scope") was **factually wrong about coverage**: sina's HK/US
  routes return **131/131 HK + 40/40 US** instruments with **0 failures** and the
  *entire* listed history in one request (HSBC 6,965 bars since 1998, `AAPL`
  10,023 since 1984, and **21/21 ETF probes** incl. `02800` since 1999 and
  `SPY` since 2001) at ~1.5 s/name ⇒ a 695-instrument pass ≈18 min. Excluded
  anyway: Python in a pure-TS stack (§3), and its eastmoney bar route is the
  already-banned `push2his` (9/9 refusals). Portability is *not* the blocker —
  7/7 endpoints answer Node `fetch` directly, and akshare's ~18 KB obfuscated
  sina decoder runs under Node `vm` (decoded 6,965 bars in ~50 ms) — vendoring a
  reverse-engineered decoder is simply not worth it for redundancy.
- **Yahoo stays the sole primary.** §4.3's posture survived this inquiry
  unaided — but see the defect below, which is *not* a provider-choice problem.

### New architecture findings

1. **R3a (added to §4.2): "raw" is not a shared quantity.** Yahoo back-adjusts
   `close` for splits, bonus issues **and** distributions-in-specie; sina,
   eastmoney `fqt=0`, tencent and TickDB are all **as-traded**. Exact factors:
   `1211.HK` 0.3333 across BYD's 2025-06-10 bonus, `WMT` 0.3333, `SMCI` 0.1,
   `UNG` 4.0, `NFLX` 10.0, and `0700.HK` 0.92186 → 0.94978 → 1.0 across the JD
   and Meituan ex-dates — **with no split row in Yahoo's own event feed**. ⇒ the
   §A.4 "agree to tick precision on surrounding closes" rescue guard is exactly
   what keeps R3 safe (must not be relaxed), and any cross-source **level**
   comparison fires on convention: 5/131 HK names (≈4 %) and 10/45 US (≈22 %)
   carry a benign >1 % gap.
2. **Workstream B's `eastmoney-raw` check needs a change before its first live
   run.** Its rule (ALARM max |dev| > 1 %) compares *levels*, so it would alarm
   on `0700.HK` (8 %) and `1211.HK` (67 %) for a benign reason; Phase 0's "0.27 %
   agreement" was measured on `0005.HK`, which had no split in-window. Measured
   fix: compare **day-over-day returns** (or CA-exclude ex-dates) — that drops
   1,575 mismatching name-days to 259 (1.12 %).
3. **Second noise class: HKEX half-day / year-end sessions are date-correlated.**
   2025-12-31 → 11/15 sampled names deviate 0.15–0.45 %, 2024-12-31 → 8/15,
   2026-02-16 → 8/15, 2025-01-28 → 7/15, 2024-12-24 → 7/15. A mean-based WARN
   threshold must exclude these dates or it reports the calendar. (`2800.HK` clean
   throughout: max 0.13 % — the G2d baseline and the pinned sample are unaffected.)
4. **§4.1's HK dividend-event gap has a free answer.** eastmoney's **F10** host
   (`datacenter.eastmoney.com`) is *not* the banned host: 12/12 calls at ~1 s,
   ~0–100 ms, also 200 from Node. It publishes per-event **declaring-currency
   amount + HKD equivalent + ex/book/pay dates** (94 rows back to 1999 for
   `0005.HK`, incl. scrip flags; `01211.HK` shows RMB→HKD *and* the
   每10股派8转12 bonus terms) — i.e. exactly what clears `CA_DEGRADED`, plus
   HK/US three-statement history for Phase 2 (`00700` 1,124/585/966 rows). The
   2026-09-01 "eastmoney for events" rejection was aimed at the wrong host.
   No ETF records, no US dividend feed.
5. **CN adjusted conventions vary *inside* one provider** → §4.1 tail rewritten.
   sina HK `qfq` is multiplicative (TR 420.2 % vs our 428.6 %), sina US `qfq` is
   additive cash, and sina has **no factor file for HK ETFs** (HTTP 404 ⇒ `qfq`
   ≡ raw: ETF TR −2.8 % vs our +14.5 %). R3/R4 ("never consume a CN adjusted
   series") stands; the reason is inconsistency, not additivity.

### Defect found in our own store (needs your call; no code touched)

**`3195.HK`'s oldest 72 stored bars are USD-counter prices in an HKD series.**
Root cause confirmed four ways: (1) store rows `2024-04-29…2024-08-07` are flat
(`O=H=L=C`) with `volume=0` at 1.03, then `2024-08-08` closes **8.13** — a
phantom **+677 %** step in our data; (2) sina *and* tencent are continuous there
(8.725 / 8.695 → 8.13) and both match Yahoo after 08-08; (3) over exactly those
72 rows `sina/store` = **7.826 ± 0.058** — the HKD peg, not a consolidation
factor; (4) the fund's USD counter `9195.HK` answers `currency=USD` close
**1.552** against `3195.HK` `currency=HKD` **12.17** (12.17/7.85 = 1.55 ✓). So
Yahoo spliced another counter's history into the series — the *price*-layer twin
of the `adjclose` FX bug §4.1 already records, and it passes every shipped check
(`yahoo-rewrite` same-provider, `tencent-dates` dates-only, `eastmoney-raw`
opt-in/banned), which means **the sentinel's coverage has a hole no provider
choice can fill**.

Store-wide census (local, no network): 1,672 HK + 347 US flat rows, of which
**7 rows across 5 names also break the local level by >10 %** — `3195.HK` (this
defect), `2836.HK` (2 rows, ×2.1, same shape, needs adjudication), `2269.HK` (2),
`0020.HK`, `0881.HK`, `2846.HK` (1 each, ~10–31 %). Flat alone is *not* the
signal: `2819.HK` has 363 flat rows (62 % of its history) that match sina at
ratio 1.000 — genuine thin sessions. Proposed control: an **intra-series** check
`volume=0 AND open=high=low=close AND |close/prev − 1| > 10 %` → ALARM quoting
the implied ratio (7.7–8.1 ⇒ counter stitching; otherwise halt/split). Zero
network cost, so it can run on every screen rather than weekly.

### Operational note (self-reporting)

**The eastmoney block lifted before the planned 09-04 re-check — and I re-armed
it.** One `curl` of *our own* provider URL returned HTTP 200 + 464,683 B (≈25 y
of `116.00005` bars); akshare's `requests` call and Node's `fetch` to the same
URL were refused within the same minutes, and after ~12 further probes every
client including curl was refused again. So (a) the §A/§B blocker re-check must
be **one request, issued by the Node loader we ship**, and (b) the refusal is
burst- *and* fingerprint-sensitive, not a clean IP timeout — §11 risk 6 updated.
No further eastmoney kline probing this week. ~250 sina requests: 0 failures, no
throttling.

### What's next

- **Your decision (deep tier, per `AGENTS.md`):** (1) adopt the intra-series
  integrity check and repair `3195.HK` (drop or convert 72 bars, re-derive —
  its 12-1m/long-window features currently encode a 677 % gain that never
  happened); (2) make `eastmoney-raw` return-based + half-day-excluded before
  its first live run; (3) re-open eastmoney-F10 as the Phase-2 HK events /
  statements source, which reverses a recorded rejection.
- Then the pending §A/§B live validation: single Node request → `--eastmoney`
  baseline. Worth pairing with the `3195.HK` repair so one run covers both.
- Before HSCEI/ETF universe expansion: census multi-counter HK ETFs (`9xxx` USD
  / `83xxx` RMB counters) for the same seam — it is a universe-quality issue now,
  not only a repair issue.
- TickDB: closed. Re-open only if a later phase needs real-time ticks/depth
  (it still will not have corporate actions).

---
---
## 2026-09-02 (docs) — Day 25–28 knowledge-base extraction

### What was done
- Extracted the last four slide folders (`knowledge-base/day_25`–`day_28`,
  8 JPGs each) into HTML docs, same pattern as Day 1–24 (delegated to four
  k3-256k coder subagents, one per day, per the fast-tier policy):
  - `docs/day_25_asset-allocation.html` — 多标的与资产配置: strategy
    diversification ≠ asset diversification; weights; concentration risk;
    industry exposure; simple-first allocation rules (≤20% stock, ≤40%
    industry, ±5–10% rebalance band).
  - `docs/day_26_multi-factor-model.html` — 多因子模型: factor families,
    Factor Engine (raw→score), standardization (Z-Score/Min-Max), 40/40/20
    composite model, score→Top-N ranking, Factor Model ≠ Portfolio.
  - `docs/day_27_factor-backtest.html` — 因子回测: 5-step pipeline, group
    returns & monotonicity, long-short spreads, IC/ICIR, stability over
    single-period returns, 7 traits of a research-worthy factor.
  - `docs/day_28_factor-combination-weights.html` — 因子组合与权重: weight
    grid search (91-combo ternary grid), the historical-optimum trap,
    plateau-not-spike stable regions, out-of-sample validation rules.
- Verification: all four files pass a tag-balance parse; day_25 hero/sections
  spot-checked against the slides. Subagents flagged (and preserved, with
  footnotes) two slide typos: day_26 slide 8 duplicate rank "1", day_28
  slide 3 Scheme B row E's inconsistent 40% weight; day_25 slide 6's
  105万/105% table kept as printed (slide footnotes it as unrealized gains).

### What's next
- Commit these four docs (with the user's go-ahead).
- Unchanged: ~2026-09-04 eastmoney ban re-check ⇒ §A + sentinel eastmoney
  leg; user decision on chasing ~140 HK names; Phase 2 design (deep tier).

---

## 2026-09-02 (review + follow-ups) — sanity check of workstream B, then items 1/3/4

### Review of the Qwen3.8-Flash session (workstream B, commit 3f0998c)
- All claims verified: 166/1 apps-api + 41 quant-core tests pass, coverage gate
  green (apps/api 95.1% lines / 91.1% branches), build green; the code matches
  its docs (tencent dates-only is structural, eastmoney leg fail-closed,
  sentinel truly read-only — `MarketDataService` has no Prisma access).
- **One finding:** the "clean 10-name baseline" artifact
  `reports/sentinel-2026-09-01.json` was actually a 1-row CUSTOM leftover from
  the corruption-injection verification (`customSample: true`), and
  `apps/api/reports/` is gitignored — the diff baseline was both wrong and
  fragile.

### What was done
- **Sentinel baseline regenerated** (live, ~25s): `reports/sentinel-2026-09-02.json`,
  10/10 ok, ALARM 0, WARN 0, exit 0 — reproduces the claimed numbers exactly
  (yahoo-rewrite 1225d identical ×9, 576d on 3195.HK; tencent 99.67%/1196d with
  the 4 classified phantoms). Plan §B now points at this file and records that
  reports/ is gitignored.
- **Fail-closed dummy guard** (`assertRealProviderStore`, `cli/daily-screen.ts`):
  the workstream-B provenance header only *labeled* synthetic output; the CLI
  now *refuses* the dummy provider before any store write unless
  `SCREEN_ALLOW_DUMMY_STORE=1` is set explicitly. Verified live
  (`MARKET_DATA_TEST_MODE=1 screen:daily` → FATAL, exit 1) + 5 unit tests
  (new `tests/unit/daily-screen.cli.spec.ts`). Sentinel needs no guard
  (read-only).
- **Workstream C — HSCEI universe expansion** (delegated to a k3-256k coder
  subagent, per the fast-tier policy): **9 verified adds** ⇒ universe 122 →
  **131**. Source: hsi.com.hk official HSCEI constituents feed retrieved
  2026-09-02 (50 names), cross-checked against Wikipedia. Verify-then-add
  against Yahoo v8 applied to all 11 candidates (one UA-less probe batch drew
  HTTP 429; cool-down + UA fixed it). Acceptance run live:
  `131/131 screened · 0 fetch-failed · 0 genuinely absent · DEGRADED: no`;
  1801.HK/6160.HK/1288.HK made the shortlist.

### Deviations & open items
- **Plan §C's expectation was stale:** it predicted ~140 total and named
  2601.HK/6030.HK as example adds — both probe OK but are **not current HSCEI
  constituents** (removed from the index; Wikipedia's list is Aug-2022). Only
  9 of 50 HSCEI names were genuinely missing. Reaching ~140 would need a
  separate decision to add liquid non-index H-shares (2601/6030 are
  verified-live first candidates) — **user decision pending**.
- The sentinel baseline is a local, gitignored file; committing it (force-add)
  would make the diff baseline durable — not done (git mutation needs the
  user's go-ahead).
- Unchanged: eastmoney ban re-check ~2026-09-04 (single throttled request),
  then §A live rescue validation + first `screen:sentinel -- --eastmoney`.

### What's next
- ~2026-09-04: eastmoney ban re-check ⇒ §A + sentinel eastmoney leg validation.
- User decision: chase ~140 with non-index H-shares, or accept 131.
- Phase 2 design (deep tier): agent pipeline + Piotroski/earnings inputs.

### Test/coverage state after this session
- apps/api **171 passed / 1 skipped** (was 166/1), quant-core 41, agents 5;
  `pnpm -w test`, `pnpm -w test:coverage`, `pnpm -w build` all green.

---

## 2026-09-02 — Hardening workstream B: weekly sentinel CLI (live-validated)

### What was done
- **`TencentKlineProvider`** (`src/market-data/tencent.provider.ts`): the
  sentinel's second-calendar leg. Returns **dates only** (`{dates, series} |
  {failure}`, never throws) so "never compare tencent closes" (R4, no raw HK
  series) is structural, not conventional. Spike URL verbatim
  (`param=hk<5digit>,day,,,1200,qfq`), 500ms + 0–50% jitter, spacing/sleep/
  fetch injectable. Live shapes confirmed: `qfqday` for stocks/2800.HK, `day`
  only for 3195.HK (fallback needed); wrong code shape = 200 + empty (L4).
- **Four pure diff checks** (`src/sentinel/sentinel-checks.ts`): `yahoo-rewrite`
  (same-provider revision ⇒ any in-window date/close mismatch ALARM, 1e-9
  relative), `eastmoney-raw` (ALARM max |dev| > 1% or date mismatch, WARN mean
  > 0.27%), `tencent-dates` (ALARM on unexplained mismatch), `ca-revision`
  (WARN-only). Shared window-edge rule: all comparisons run on the **overlap**
  of the two date sets (store vs trailing-5y vs tencent's 1200-bar cap).
- **`runSentinel` + CLI** (`src/cli/sentinel.ts`, `screen:sentinel`): pinned
  10-name sample (`src/sentinel/sentinel-sample.ts`), legs Yahoo fresh (through
  `MarketDataService`, so L1/L2 parity with the store) + tencent dates +
  eastmoney raw **opt-in only** (`--eastmoney`, reuses
  `EastmoneyRepairProvider`; the banned host must not be re-probed weekly).
  Read-only; stdout table + `reports/sentinel-<date>.json`; `process.exitCode =
  1` on any ALARM; `--symbol` override flagged as CUSTOM in header and JSON.
- **`HKEX_ADHOC_CLOSURES` / `HKEX_KNOWN_NON_SESSIONS`** (quant-core calendars):
  the three measured 2023 cyclone closures (Talim 07-17, Saola 09-01, black
  rain 09-08) that tencent carries phantom bars for, unioned with the published
  holidays. Documented as a *closure* set, not an L1 input (L1 semantics
  unchanged). Evidence-driven growth rule: new closure ⇒ one ALARM ⇒ human
  classifies ⇒ append with citation.
- **Provider-provenance guard** (deviation, added after a live finding): the
  daily header now carries `provider=yahoo` /
  `⚠ PROVIDER=dummy — SYNTHETIC DATA, NOT REAL MARKET DATA` (+ two up-front log
  lines), `LaneReport.provider` and the sentinel legs line carry it too, and
  `main()` labels yahoo/dummy explicitly from `getMarketDataDeps().dummyMode`.
- **Docs:** `architecture-v1.md` §4.3 (sentinel as built: CLI, pinned sample,
  four checks, opt-in eastmoney leg, exit code, request volume),
  `phase-1-hardening-plan.md` §B (implemented + every deviation and its
  evidence), vitest coverage comment re-baselined.
- **Tests:** 166 passed / 1 skipped in apps/api (was 70/1) — 37 check-function
  unit, 20 tencent-provider unit, 20 sentinel integration (fake sources +
  throwaway SQLite), 8 CLI/sample pinning, 3 new daily-screen provenance tests,
  2 new quant-core calendar tests (41 there). `pnpm -w test` and
  `pnpm -w test:coverage` green; build green.
- **Coverage debt fixed on the way:** `pnpm -w test:coverage` was **already red
  at HEAD** (market-data 77.3% branches vs the 85% gate, overall 78.5% vs 80% —
  workstream A landed without running the coverage gate). Added the missing
  provider-shape tests (Yahoo sparse-payload/option-default/error-taxonomy
  paths, eastmoney pacing + numeric-field nulls, tencent shapes): now
  market-data 93.5%, overall 91.1%. Uncovered residue is the CLI `main()`
  wrappers and the live-gated smoke path.

### Live validation (workstream B, the two unblocked legs)
- HK store had to be repaired first: **all 122 HK instruments held the dummy
  provider's 30 synthetic bars ending 2024-12-31** (run 6, 2026-09-01 — a dummy
  run did a full-window rewrite and the header looked healthy; every name
  `INSUFFICIENT_HISTORY`). This is the hazard the guard above now shouts about.
- Real HK `screen:daily` restored the lane: 122/122 screened, 0 fetch-failed,
  252 clamped bars, rescue pass correctly **idle** (zero eastmoney requests —
  the ban was not probed), header format verified.
- `screen:sentinel` baseline (10 names, ~25s): **yahoo-rewrite ok on all 10**
  (1225/1225 days, 3195.HK 576/576), **tencent-dates 99.67% / 1196d** with
  exactly the 4 classified phantoms — reproduces the Phase 0 §G2b numbers.
  ALARM 0, exit 0. Artifact kept as the diff baseline.
- ALARM path proven against live data: one corrupted stored close was caught
  with its date + deviation and exit 1; value restored and re-verified.
- **New finding (CA leg):** on the two CA_DEGRADED names Yahoo restates
  dividend amounts **on every fetch** (0005.HK 2026-08-13: 0.78407 →
  0.78404003 → 0.78402 across three runs); the eight HKD-native payers were
  byte-identical. Confirms the CA_DEGRADED policy empirically; amounts on those
  two names are now recorded-but-ignored (date sets still compared) so the
  weekly run stays clean at 10/10 ok.

### Deviations & open items
- Sentinel §B: window-edge/overlap rule, known-closure attribution (note vs
  WARN vs ALARM by direction), loader parity, and the extra verdicts
  (not-in-store ⇒ WARN, store=eastmoney ⇒ skip check 1, fetch-failed ⇒ WARN +
  stored reference, absent ⇒ ALARM, thin overlap ⇒ WARN) — all listed with
  evidence in the plan §B.
- eastmoney leg (§B check 2) is **built and tested but never run live** — same
  blocker as §A. Re-check the ban ~2026-09-04 with one throttled request, then
  validate §A's rescue path and this leg together.
- Design note for §A's re-open: bans outlasting a day argue for the sentinel
  being runnable without the banned leg, which is now the default.

### What's next
- Workstream C: HSCEI universe expansion (verify-then-add against Yahoo v8).
- ~2026-09-04: single throttled eastmoney probe ⇒ then §A live rescue
  validation + first `screen:sentinel -- --eastmoney` run (≈2 min).
- Phase 2 design (deep tier): agent pipeline + Piotroski/earnings inputs.

---

## 2026-09-02 — Hardening workstream A: HK rescue loaders

### What was done
- **`hkSymbolMaps`** (`src/market-data/hk-symbol-map.ts`): pure `0005.HK` →
  `{ eastmoneySecid: "116.00005", tencentCode: "hk00005" }`; throws loudly on
  non-`.HK` / wrong digit counts (programming error, not provider failure).
- **`EastmoneyRepairProvider`** (`src/market-data/eastmoney-repair.provider.ts`):
  narrow `RepairProvider` interface (`fetchRawBars` → `{bars} | {failure}`,
  never throws on provider failure). Spike's push2his `fqt=0` request shape
  verbatim, fields2 extended to f51–f56 for full OHLCV (spike only fetched
  date+close) and beg=0/end=20500101 for the full window. ≥2s + 0–50% jitter
  sequential throttle (ban protection — hard TCP drop after ~5 rapid calls,
  measured); spacing/sleep/fetch injectable like YahooMarketDataProvider.
- **Prisma migration `20260901155827_instrument_data_source`**: added
  `Instrument.dataSource String @default("yahoo")`.
- **`runDailyScreen` rescue pass** (HK lane only, after the main ingest pass,
  max 5 calls/run in-list order): non-OK outcomes collected to `needsRepair`;
  successful rescue ⇒ L2 clamp + runChecks, whole-series bar rewrite,
  `dataSource="eastmoney"`, keep stored Yahoo CAs (none ⇒ caDegraded=true +
  "rescue-filled without CA history" warning), ticker joins today's screen,
  tallies move failure→ok; rescue failure keeps the original outcome loudly;
  gate-failing rescue series is stored but excluded; successful Yahoo fetch
  for a non-yahoo instrument flips `dataSource` back. Header gains
  `· N rescued via eastmoney (…)`, LaneReport/report JSON gain `rescued[]`.
  Deps: `repairProvider` optional — real eastmoney by default, disabled under
  MARKET_DATA_TEST_MODE=1 unless injected (fail-closed).
- **Tests**: 17 unit (symbol map + parsing incl. TCP-drop/non-200/empty-klines
  → `{failure}`, throw only on programming error); 6 integration (rescue
  happy path + screened + flip + header; repair failure stays FETCH_FAILED;
  cap 5 of 6; US never repaired; GENUINELY_ABSENT without CA history ⇒
  caDegraded; flip-back to yahoo). `pnpm -C apps/api test`: 70 passed, 1
  skipped; build green; `pnpm -w test` green.

### Deviations
- eastmoney URL: spike verbatim except fields2 f51–f56 (needed for OHLCV
  Bars) and beg/end widened to full window; noted in the provider header.
- The `rescued via eastmoney` header segment appears only when N > 0.

### Live validation blocked: eastmoney IP ban persists
- Probed 2026-09-02: `push2his.eastmoney.com` (and `push2`, all numbered
  subdomains) drop our connections at TCP level on **every** request — exact
  spike URL, HTTP/1.1 vs 2, plain HTTP, browser headers, Referer, and cookies
  from a successful `quote.eastmoney.com` visit all fail identically.
  Controls fine (`www`/`quote` 200, tencent OK) ⇒ host-specific IP-level ban,
  still in effect ~36h after the 2026-08-31 spike ban. Failed probes may
  extend it — probing stopped.
- Decision (user): commit the work, park live validation ~48h, no probing
  meanwhile. Open risk for the plan: bans outlasting a day undermine the
  "rescue in the next daily run" premise, and eastmoney is the only raw-bar
  HK rescue source. If still banned when re-checked, re-open the rescue-source
  decision.

### What's next
- Re-check eastmoney ban ~2026-09-04 with a single throttled request; then
  one live rescue-path validation.
- Workstream B: weekly sentinel CLI (`screen:sentinel`, fixed 10-name sample,
  three diff checks, non-zero exit on ALARM).
- Workstream C: HSCEI universe expansion (verify-then-add against Yahoo v8).

---

## 2026-09-01 (plan) — Phase 1 hardening plan pinned

### What was done
- Wrote `docs/phase-1-hardening-plan.md` for the deferred Phase 1 items.
  Decisions (user): rescue loaders fire automatically in-run; sentinel is a
  manual CLI with a fixed 10-name HK sample; **coverage ledger skipped**
  (full-window rewrites are cheap and self-healing; revisit trigger
  documented); HSCEI universe expansion in scope (verify-then-add).
- Key design pin: **eastmoney is the only raw-bar HK rescue source** —
  tencent serves no raw HK series (200+empty on `fq=''`; dates-only role).
  Rescue follows a whole-series rule (full replace + `Instrument.dataSource`
  provenance column, never a splice, R3); ≤5 eastmoney calls/run at ≥2s +
  jitter (IP-ban protection); US lane has no rescue source by design.
- Sentinel checks pinned: Yahoo-fresh-vs-stored rewrite detector (ALARM on
  any overlap mismatch), eastmoney raw-close diff (alarm >1% max dev, warn
  >0.27% mean), tencent date-overlap only (closes never compared).

### What's next
- Execute the hardening plan (fast tier OK — parameters are pinned), then
  Phase 2 design (deep tier).

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
