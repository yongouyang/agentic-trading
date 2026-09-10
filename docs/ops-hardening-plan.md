# Ops Hardening Plan (R0) — make the daily chain able to fail loudly

Planning session 2026-09-10 (deep tier). Follows the Phase-3c ship and the
Phase-4 plan draft. **Not yet user-locked** — four forks at the bottom.

## Why now (measured 2026-09-10, not theoretical)

The Phase 1–3 build is sound; the *running* of it is not. Three defects found
in one review, all silent:

1. **The 2026-09-10 US deep-dive died mid-run and discarded everything.**
   `logs/daily-us.log` ends at `screen:daily exit=0` — no `screen:deep-dive
   exit=` line, so the script was killed inside the deep-dive leg.
   `AgentDecision` proves it got **40 live calls in (08:35:17 → 08:37:43),
   completing 4 of 10 verdicts**. No `DeepDiveRun` row exists for
   `screenRunId=15` (newest is id 6 → `screenRunId=14`), because
   `runDeepDiveBatch` creates the run row *after* the whole lane's `pool()`
   resolves (`apps/api/src/cli/deep-dive.ts:381`). Result: 40 calls and 4
   finished verdicts are invisible, and the UI silently shows an older run.
2. **Skipping the deep-dive exits 0.** Both preflight-failure paths in
   `scripts/daily-chain.sh` do `exit "$SCREEN_RC"` — success whenever the
   screen succeeded. launchd records a clean job. Silent failure is currently
   *by design*.
3. **The US lane ranked on T-1 data and reported clean.** Today's screen
   dropped `nullCloseDropped: 619` = **555 symbols × the single date
   2026-09-09** (`"AAPL: L5 dropped null-close bars: 2026-09-09"`). Store
   confirms `max(date)` US = **2026-09-08**; HK is current (09-09, 131 bars).
   Live Yahoo has a real 2026-09-09 close for AAPL (315.34, 65.4M volume), so
   the session was genuinely lost, not absent. `degraded` stayed **false**:
   it is fetched-failure-only (`daily-screen.ts:384`,
   `fetchFailed.length > 0.02 * entries.length`). The integrity header
   (`apps/web/app/components/integrity-banner.tsx`) has no field that would
   have shown a stale cutoff.

Also relevant: since launchd was installed 2026-09-06, **exactly one
scheduled run has ever fired** (09-10 08:35 US, caught up on wake). HK has not
run since 09-06. The plists are loaded and correct; the machine's sleep
behaviour plus the two silent-failure paths above are the whole story.

**Mitigating fact:** the `AgentDecision` hash log makes a rerun after a crash
nearly free (the 40 calls replay from cache at $0). So this plan is about
*visibility and recovery*, not about burning tokens twice.

## Scope

Make the pipeline, its exit codes, its stored state, and its UI tell the
truth about whether a run happened, whether it finished, and how fresh its
data is. Read-only where possible; no changes to screening logic, scoring,
`SCREEN_PARAMS`, or the deep-dive prompts.

## Non-goals

- No new data sources, no provider replacement, no second source for the US lane.
- No re-architecture of the LLM pipeline; no retry/resume engine.
- No deploy, auth, or hosting work (that is R4).
- No changes to the screen's *scoring*; only the integrity/status surfaces.
- Not the Phase-4 backtest (separate, awaiting lock).

## W1 — Chain truthfulness (small, shell only)

`scripts/daily-chain.sh`:

- Introduce distinct exit codes: `0` clean, `2` screen failed, `3` deep-dive
  preflight skipped (auth), `4` deep-dive leg failed. The preflight-fail paths
  must **stop returning `$SCREEN_RC`** — a skipped deep-dive is a non-zero
  outcome and must be loud.
- Add a post-condition check after the deep-dive leg: query the just-created
  `screenRunId` and assert a `DeepDiveRun` row exists. If not, exit `4` with a
  one-line diagnostic. Cheap, catches W2's failure mode at the source.
- Keep the "skip loudly rather than fail 20 × 7 calls" philosophy — the change
  is that "loud" now includes the exit code, not just a log line.

## W2 — Runs survive a crash (schema + pipeline, one migration)

The fork with real design weight (see forks).

**D1 (status-only, lazy):** add `status String @default("complete")` to
`DeepDiveRun`. Insert the row with `status="running"` *before* the lane's
`pool()`, flip to `"complete"` after the reports are written. Read paths
(`listRuns`, daily's latest-run selection) filter to `status='complete'`, so a
crashed run never becomes "the latest report" — today's correct UI behaviour
is preserved. A `running` row older than N minutes is a detectable, alertable
"crashed run" state, and W1's post-condition reads it directly.

**D2 (incremental, fuller):** D1 plus persisting each name's
`DeepDiveReport` row as it completes, so a crash keeps its finished verdicts
and the UI can show a partial run. More code, and it introduces a "partial
report" state the UI must explain.

Recommendation: **D1**. It makes the failure visible and alertable (the actual
gap) at a fraction of the surface. D2's incremental persistence buys recovered
verdicts that a cache-hit rerun reproduces for ~$0 anyway — do it only if
partial reports turn out to be wanted.

## W3 — Data freshness as a first-class field (small, no migration)

- **Screen time** (`daily-screen.ts`): derive the lane's effective cutoff
  (`max(bar.date)` actually used) and track null-close drops **by date**. New
  degraded rule: if one date accounts for null-close drops across >50 % of the
  lane's universe, set `degraded = true` with a warning naming the date
  (`"whole-universe session gap: 555/555 dropped 2026-09-09"`). Today's run
  would have been flagged; the 09-06/09-09 runs (61–105 scattered drops) would
  not.
- **Read time** (`apps/api/src/reports/reports.service.ts`): add
  `dataThrough: string | null` to the daily `integrity` object — `max(bar.date)`
  per lane for the run's market, computed on read, no migration. This is the
  signal that also catches "the chain never ran at all", which a screen-time
  field cannot.
- **UI** (`integrity-banner.tsx` + `apps/web/app/types.ts`): render
  `data through <date>` next to the existing screened/ok/excluded line, with a
  staleness style when `dataThrough` is older than the previous trading
  session. Keep it additive: a missing/absent field renders exactly as today.

## W4 — Alerting (small, native, no dependency)

- New read-only CLI `ops:health` (`apps/api/src/cli/ops-health.ts`): for each
  lane, report whether the newest `ScreenRun` has a `status='complete'`
  `DeepDiveRun`, the run's age, and the lane's `dataThrough` age. Non-zero exit
  when a lane's newest complete run is older than ~1 trading session, or a
  `running` row is stale.
- New launchd job `com.agentic-trading.ops-health` (daily, after both chains —
  e.g. 07:00 and 17:30, or a single 07:15 run covering both lanes). On failure,
  fire a macOS notification via `osascript -e 'display notification …'` — a
  native platform feature, no dependency — and log to `logs/` per the existing
  convention. This is the piece that catches a killed job, which W1 cannot.
- Reuse the existing `scripts/weekly-maintenance.sh` PATH preamble pattern.

## Verification

- **W1:** unit-test the chain script's exit codes with a stubbed `pnpm`
  (screen-fail, preflight-fail, deep-dive-fail, missing-run-row); assert
  non-zero on every degraded outcome. Manual: rerun the 09-10 US chain and
  confirm a real `DeepDiveRun` appears for `screenRunId=15` (cache replay, ~$0).
- **W2:** pipeline test with a fake that throws mid-lane → assert a
  `status='running'` row exists and `listRuns`/daily do **not** return it.
- **W3:** screen test seeding a whole-universe single-date null-close gap →
  `degraded === true` with the dated warning; and the scattered-drop case stays
  `false`. `reports.service` test for `dataThrough` = store max date per lane.
  Web test: banner renders `data through`; absent field renders as before.
- **W4:** `ops:health` exits 0 on a fresh complete pair, non-zero on a stale
  lane and on a stale `running` row; plist lint + `install.sh` dry run.
- The 2026-09-10 evidence above is the acceptance fixture: after R0, that
  exact state (screen ok, deep-dive dead, US one session stale) must be
  non-zero, non-degraded-invisible, and alerted.

## Build order

1. W1 (shell, independent) → W2 migration + read-path filters → W3 screen rule
   + api field + banner → W4 CLI + plist + install.
2. Docs: architecture §4.3/§5.1 status notes, PROGRESS entry.
3. Re-run the US chain for `screenRunId=15` to close today's gap and prove the
   end-to-end path.

All four workstreams are fast-tier execution **once the forks below are
locked**.

## Forks to lock

1. **W2 depth** — D1 status-only (recommended) vs D2 status + incremental
   per-name persistence.
2. **Alert channel** — `osascript` desktop notification (recommended: native,
   zero-dependency) vs writing a sentinel-style JSON artifact only vs both.
3. **Staleness threshold** — "older than the previous trading session"
   (recommended; uses the store's own session calendar) vs a fixed ~30 h wall
   clock.
4. **Whole-universe gap rule** — >50 % of the lane's universe on one date
   (recommended) vs a lower bound that also catches partial wipes.
