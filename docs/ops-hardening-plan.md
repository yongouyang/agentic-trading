# Ops Hardening Plan (R0) — execution spec

Planning sessions 2026-09-10 (deep tier). Rewrites the earlier draft as the
**locked execution spec** — every design fork and every numeric value below is
user-decided. Execution is fast-tier work.

## Decisions locked (2026-09-10, user)

| Fork | Decision |
|---|---|
| W2 depth | **Status only.** `DeepDiveRun.status`; read paths filter to complete. No incremental per-name persistence, no partial-run UI. |
| Staleness definition | **Cadence-aware** (weekday arithmetic against each lane's own schedule). Supersedes the earlier "age in hours" answer, which cannot separate a Sat→Tue weekend gap (72 h) from a failure. No market-holiday calendar. |
| Whole-universe gap action | **Mark degraded, still publish.** Shortlist is produced and stored; the gap shows in the integrity header, banner and exit code. |
| `screen:deep-dive` exit line | **Any failure = non-zero.** Partial lane failures count, replacing today's 100%-only rule. |
| Health surfacing | **Dashboard banner.** `osascript` desktop notification explicitly declined. |
| Health artifact | **In scope** — `logs/ops-health-<date>.json`. |
| Weekly jobs in health scope | **In scope** (sentinel + f10-refresh). |
| launchd fix | **Fix arming, keep launchd.** No `pmset` hardware wakes, no self-heal catch-up job. |
| Whole-universe gap bar | **> 50 %** of the lane's universe dropped on one date ⇒ degraded. |
| Health alert level | **Alert at 2 missed** expected runs; exactly 1 missed is warn. |
| Stale `running` age | **2 h** (a healthy lane pool takes ~3 min). |

## Why (measured 2026-09-10)

Five silent-failure paths, none previously recorded:

1. **The 09-10 US deep-dive died mid-run and discarded everything.** 40 live
   calls (08:35:17→08:37:43) completing 4/10 verdicts; no `DeepDiveRun` row for
   `screenRunId=15`, because the run row is created only after the lane's
   `pool()` resolves (`cli/deep-dive.ts:381`).
2. **The chain masks a skipped deep-dive.** Both preflight-fail paths in
   `scripts/daily-chain.sh` `exit "$SCREEN_RC"` — success whenever the screen
   succeeded.
3. **`screen:deep-dive` exits 0 on partial failure** (`cli/deep-dive.ts:470`
   requires `failed === topN`).
4. **A degraded screen run exits 0** — `degraded` is computed and then dropped
   at the process boundary (`daily-screen.ts`).
5. **The US lane ranked on T-1 data and reported clean.** `nullCloseDropped:
   619` was 555 symbols × the single date 2026-09-09; store `max(date)` US =
   2026-09-08 while HK was current. `degraded` is fetched-failure-only
   (`daily-screen.ts:384`) and no integrity field exposed the cutoff.

**Ruled out:** the 08:37 death was *not* sleep. `pmset -g log` shows a true Wake
at 08:31:22 and no sleep until 21:29:01. No `node`/`tsx` crash report exists in
`~/Library/Logs/DiagnosticReports`. Kill reason is a W5 task.

**Scheduling lead:** `UserEventAgent` registered `daily-us`'s
`StartCalendarInterval` entries only at **2026-09-10 08:47:55**, days after the
09-06 install and after that morning's run — consistent with only one scheduled
run ever firing and HK never running.

**Mitigating:** the `AgentDecision` hash log makes a post-crash rerun ~free (the
40 calls replay at $0). R0 is about visibility and recovery, not token cost.

## Scope

Make the pipeline, its exit codes, its stored state and its UI tell the truth
about whether a run happened, whether it finished, and how fresh its data is.

## Non-goals

- No new data sources, no provider replacement, no second source for the US lane.
- No changes to screening logic, scoring, `SCREEN_PARAMS`, or LLM prompts.
- No deploy/auth/hosting work (R4); no Phase-4 backtest (awaiting its own lock).
- No `pmset` wake schedules; no self-heal catch-up job; no desktop notifications.

---

## W1 — Chain truthfulness

**W1a `apps/api/src/cli/deep-dive.ts:470`** — replace the 100%-only rule:

```ts
if (reports.some((r) => r.failed > 0)) process.exitCode = 1;
```

**W1b `apps/api/src/cli/daily-screen.ts`** — set `process.exitCode = 1` when the
lane's run is degraded (this covers the new W3 whole-universe-gap rule). The
report is still written to `apps/api/reports/` and the `ScreenRun` row still
stored — exit code is a quality signal, not an abort.

**W1c `scripts/daily-chain.sh`** — exit taxonomy:

| Code | Meaning |
|---|---|
| 0 | clean |
| 2 | screen leg failed |
| 3 | deep-dive skipped (auth preflight failed) |
| 4 | deep-dive leg failed or partial |
| 5 | post-condition (health) failed |

- Both preflight-fail paths stop returning `$SCREEN_RC` → exit **3**, loudly.
- The chain still runs **both** legs before reporting (a degraded screen does
  not skip the deep-dive — per the locked gap decision); the final exit is the
  **worst** of {screen, deep-dive, health}, not the first non-zero.
- **Post-condition:** after the deep-dive leg, call `ops:health --lane <L>`
  (W4) and exit **5** if it reports unhealthy. This is the only check that
  catches a killed process, which no exit code inside the process can.

Rationale for sharing `ops:health` as the post-condition: one source of truth
instead of a separate `sqlite3` query in shell. W1 therefore lands *with* W4's
CLI, though W1c is independently testable with a stub.

## W2 — Runs survive a crash (visibility)

**Migration** `apps/api/prisma/migrations/20260910120000_deep_dive_run_status/migration.sql`:

```sql
ALTER TABLE "DeepDiveRun" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'complete';
```

Existing rows are correctly `complete`. No table redefinition needed. Prisma
model gains `status String @default("complete")`.

**`apps/api/src/cli/deep-dive.ts`** — insert the run row **before** the lane's
`pool()`, with `status: "running"` and zeroed counters; after the reports are
written, `update` it with the real counters and `status: "complete"`. A crash
therefore leaves a `running` row — a detectable, alertable state — instead of
nothing. Applies to both the normal path and the `--symbol` path.

**Read paths** — every `DeepDiveRun` read in `apps/api/src/reports/reports.service.ts`
filters `status: "complete"`, so a crashed run can never render as a report:

- `daily()` latest pick (`:250`)
- `daily(market, runId)` explicit pick — `findUnique({where:{id}})` becomes
  `findFirst({where:{id, status:"complete"}})`; a running run 404s like any
  other non-report
- `listRuns()` (`:420`) — the picker therefore never lists partial runs
- the deep-dive detail loader (`:349`/`:372`)

Chat tools read through the same service and inherit the filter for free.

## W3 — Data freshness as a first-class field

**W3a — screen time** (`cli/daily-screen.ts`): accumulate null-close drops
**by date** (the loop already has `droppedNullBars` per symbol). New degraded
rule: if one date accounts for drops across more than **50 %** of the
lane's universe, set `degraded = true` with a dated warning
(`whole-universe session gap: 555/555 dropped 2026-09-09`). Today's run would
have flagged; the 09-06/09-09 runs (61–105 scattered drops) would not.

**W3b — read time** (`reports.service.ts`): add `dataThrough: string | null`
to the daily `integrity` object = `max(Bar.date)` for the run's market,
computed on read. No migration. This is the field that also catches "the chain
never ran at all", which a screen-time value cannot.

**W3c — web** (`types.ts`, `integrity-banner.tsx`): render
`data through <date>` alongside the existing screened/ok/excluded line, with a
stale style when the value is behind the lane's cadence expectation. Purely
additive — an absent field renders exactly as today.

## W4 — Health check, artifact, endpoint, banner

**W4a shared module** `apps/api/src/ops/health.ts` — `computeHealth(prisma, now)`,
pure over inputs, per lane (HK, US) plus the two weekly jobs:

- newest **complete** `DeepDiveRun` (id, runAt) and newest `ScreenRun`
- store `dataThrough` (W3b's query, reused)
- `expectedRunsMissed`: **cadence-aware** — expected run-days derived from the
  plists (HK Mon–Fri, US Tue–Sat) at their scheduled local times, counted
  between the last complete run and `now`, with a grace window so a run that is
  merely late (catch-up after wake) is not counted
- `staleRunning`: a `status="running"` row older than **2 h**
- weekly jobs: newest artifact per job (`reports/sentinel-<date>.json`;
  f10 needs a small artifact write added — it currently writes none)

Health levels: **alert** when `expectedRunsMissed >= 2` **or** `staleRunning`
**or** a weekly job is overdue; **warn** when exactly 1 expected run is missed
(1 missed is the normal catch-up-on-wake case, hence warn not alert).
The warn/alert split exists precisely because these runs are catch-up-on-wake
by design (no `pmset` wakes), so "late" must not be confused with "broken".

**W4b CLI** `apps/api/src/cli/ops-health.ts`, script `ops:health`: prints the
per-lane table, writes `logs/ops-health-<date>.json`, exits non-zero on any
alert. Read-only.

**W4c API** — `GET /ops/health` calling the same `computeHealth` live, so the
banner is correct even when no run exists at all (a `reports/daily` 404 would
otherwise be the only signal). Never throws; returns an explicit unhealthy
shape instead.

**W4d web** — `fetchHealth()` in `lib/api.ts` on the never-throw idiom, and a
dashboard banner at the top of `/` (same server-component pattern as
`api-health.tsx`), listing each unhealthy lane, its expected-vs-actual run and
its `dataThrough`.

**W4e launchd** — `com.agentic-trading.ops-health` running after both lanes via
the existing `weekly-maintenance.sh` PATH preamble pattern. The banner computes
live; this job exists so the artifact and the log record exist too.

> **Only remaining open value:** the health job's fire times. Proposed 07:15 and
> 17:30 HKT (after the US and HK chains respectively). Confirm or override
> before creating the plist.

## W5 — launchd arming diagnosis

Find why `daily-us`'s `StartCalendarInterval` entries were unarmed until
2026-09-10 08:47:55 despite the 09-06 install, then fix the arming and verify a
real fire. Checked in order:

1. `launchctl print gui/$UID/com.agentic-trading.daily-us` — armed state now.
2. `scripts/launchd/install.sh` — whether it uses `bootstrap` or the deprecated
   `load`, and whether it re-bootstraps after editing a plist (editing a plist
   does not reload it).
3. Whether `RunAtLoad` is set and whether install triggers the 09-10 08:35 run.
4. Determine the 08:37 kill reason (not sleep, no crash report — check for a
   SIGKILL/OOM source or a launchd-level kill).

Outcome: an armed agent with a verified fire. On-time execution is explicitly
**not** the goal while the machine sleeps at 06:10 — catch-up-on-wake is the
accepted behaviour, which is why W4's health levels are warn/alert rather than a
hard deadline.

## Verification

- **W1:** unit-test `daily-chain.sh` exit codes with a stubbed `pnpm`
  (screen-fail, preflight-fail, deep-dive partial, health-fail) → assert
  2/3/4/5; assert a degraded screen run exits 1; assert the deep-dive CLI exits
  1 on 1-of-10 failures. Then rerun the 09-10 US chain and confirm a real
  `DeepDiveRun` appears for `screenRunId=15` (cache replay, ~$0) — this is the
  W1 acceptance step.
- **W2:** pipeline test with a fake that throws mid-lane → a `status="running"`
  row exists and `daily`/`listRuns` do **not** return it. Migration test against
  a fixture DB with pre-existing rows (all become `complete`).
- **W3:** screen test seeding a whole-universe single-date gap → `degraded ===
  true` with the dated warning; scattered drops stay `false`. Service test for
  `dataThrough` = store max date per market. Web test: banner renders
  `data through`; absent field renders as before.
- **W4:** `computeHealth` unit tests for alert/warn/healthy across cadence
  windows (including a Sat→Tue weekend and a same-day catch-up run);
  `ops:health` exits 0 on a fresh pair, non-zero on a stale lane and on a stale
  `running` row; endpoint test for the no-run shape; web banner renders and
  degrades gracefully when the api is down.
- **W5:** an observed on-time-or-catch-up fire with the entry armed before it.
- **Acceptance fixture:** the 2026-09-10 state (screen ok, deep-dive dead, US
  one session stale) must end up non-zero, visible in the banner, and recorded
  in the artifact.

## Build order

1. W2 migration + pipeline + read-path filters (touches the fewest things
   downstream).
2. W3a screen rule → W3b `dataThrough` → W3c banner.
3. W4a `computeHealth` → W4b CLI → W4c endpoint → W4d banner.
4. W1c chain wiring (uses W4b) + W1a/W1b exit codes.
5. W5 arming diagnosis and fix.
6. Docs (architecture §4.3/§5.1 status notes) + PROGRESS; rerun the US chain.

All of this is fast-tier execution now that the forks are locked.

## Notes for the build session

- All forks and values are locked (table at the top); no further design input
  is required to start. W2 is the only step that touches the database — take it
  first, since W3/W4 read paths build on the filtered run model.
- The migration is additive with a `'complete'` default, so it is safe against
  the existing 6 `DeepDiveRun` rows and needs no backfill.
- W1c depends on W4b's CLI; if you want the chain fixed before the health
  module exists, stub the post-condition and wire it in step 4.
- Do not add `pmset` wakes or a self-heal job — both were considered and
explicitly declined.
