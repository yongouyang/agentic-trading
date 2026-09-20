/**
 * Ops health (W4a, docs/ops-hardening-plan.md).
 *
 * Answers three questions the pipeline could not previously answer about
 * itself: did a run happen, did it finish, and is its data fresh enough to
 * trust. Built after 2026-09-10, when the US deep-dive died mid-run after 40
 * calls / 4 verdicts, the chain still exited 0, and the shortlist ranked on T-1
 * data while reporting degraded=false.
 *
 * Read-only. Shared by the `ops:health` CLI (artifact + exit code), the
 * `GET /ops/health` endpoint (the dashboard banner) and the chain's
 * post-condition check (W1c), so all three agree by construction.
 *
 * Cadence (re-declared 2026-09-14): the 06:10 (US) and 16:50 (HK) jobs were
 * REMOVED on 2026-09-14 — the machine is realistically only on in the
 * evening, so the GUARDED evening catch-up (`daily-catchup` plist, 20:30 and
 * 23:03 HKT) is now the ONLY daily run for both lanes, and this health model's
 * expected cadence. Since the same day the catch-up guard PROBES the provider
 * for the newest completed session instead of trusting the store alone, so a
 * power-off day (store never fetched) triggers the chain that brings the
 * store forward — which keeps the store-bound behind-ness logic here accurate
 * for the states that are actionable. A fully-dark evening (machine off
 * through both slots) remains invisible to the missed count — accepted: its
 * verdicts are unrecoverable by design (promptness gate) and its screen
 * sessions surface as informational rescreenable holes after the next fetch.
 * A lane therefore counts a missed evening
 * only when it was still BEHIND after an evening's slots (last slot + grace)
 * on a day the store held a completed unscreened session — "behind" being the
 * ops:catchup definition: the store holds a session newer than the newest
 * screened one, OR the newest screen lacks a complete chain-source deep-dive.
 *
 * Session → expected evening (weekday arithmetic in HKT, deliberately NO
 * market-holiday calendar — the warn/alert split absorbs what it cannot see):
 * an HK session is expected screened the SAME evening (bars are storable from
 * 16:10 HKT — lag 0); a US session the FOLLOWING HKT evening (its close is
 * 04:00/05:00 HKT the next day, so Monday's session is screened Tuesday 20:30
 * HKT — lag 1 by construction). Thresholds unchanged: 1 missed evening = warn,
 * 2+ = alert. HKT has had no DST since 1979, so the fixed +08:00 offset below
 * is exact rather than an approximation.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionClosed } from "@agentic-trading/quant-core";
import { PROSPECTIVE_FROM } from "../cli/accrual.js";
import { loadCostRows, parseCapUsd, parsePricing, summarize } from "./cost.js";
import type { PrismaService } from "../prisma.service.js";

export const HKT_OFFSET_MS = 8 * 3600 * 1000;

/** apps/api — same convention as the sentinel/f10 CLIs, so the artifact dir
 *  resolves identically no matter the process cwd. */
const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/** An evening only counts as MISSED once the last catch-up slot is this far
 *  past. Runs are catch-up-on-wake by design, and the observed 2026-09-10
 *  catch-up was ~2.5h late, so 6h gives headroom without letting a whole
 *  missed day slip through. */
export const MISSED_RUN_GRACE_HOURS = 6;

/** A closed lane pool takes ~3 minutes (the 09-10 run covered 4 of 10 names in
 *  2.5 min), so anything still "running" after 2h is a crashed run. */
export const STALE_RUNNING_HOURS = 2;

/** Weekly jobs run Sundays; 8 days means one missed week fires. */
export const WEEKLY_OVERDUE_DAYS = 8;

/** How far back to scan for missed slots when a lane has no complete run. */
export const NO_RUN_SCAN_DAYS = 30;

/** The guarded evening catch-up (`daily-catchup` plist) runs 20:30 and 23:03
 *  HKT daily; a lane is missed only once the LAST slot of an evening plus the
 *  grace window has elapsed with the lane still behind. */
export const EVENING_LAST_SLOT = { hour: 23, minute: 3 } as const;

/** Cadence-aware weekday arithmetic (locked 2026-09-13): which HKT evenings a
 *  lane can be expected screened by. HK sessions are due the SAME evening
 *  (Mon–Fri, lag 0); US sessions the FOLLOWING HKT evening, so US evenings are
 *  Tue–Sat (lag 1 by construction). The 06:10/16:50 jobs were removed on
 *  2026-09-14 and were never in this table anyway — the guarded evening run is
 *  the only daily run, so it is the only thing that can be "missed". */
export const LANE_CADENCE: Record<"HK" | "US", { weekdays: number[] }> = {
  HK: { weekdays: [1, 2, 3, 4, 5] },
  US: { weekdays: [2, 3, 4, 5, 6] },
};

export const WEEKLY_JOBS = ["sentinel", "f10", "validation"] as const;
export type WeeklyJob = (typeof WEEKLY_JOBS)[number];

/** Where launchd installs the jobs; the plist's mtime dates the install. */
const DEFAULT_LAUNCH_AGENTS_DIR = path.join(homedir(), "Library", "LaunchAgents");

/** Repo-root logs/ — where the weekly validation digest is written
 *  (logs/validation-digest-<date>.json). */
const DEFAULT_LOGS_DIR = path.join(PKG_ROOT, "..", "..", "logs");

/** Weekly jobs run Sunday morning (HKT). Sentinel and f10 are staggered so the
 *  two eastmoney hosts are not hit back-to-back; the validation digest runs
 *  last, after both. Mirrors scripts/launchd/*.plist — and the plist name
 *  matters, because its mtime is the only record of when the job was
 *  installed. */
export const WEEKLY_CADENCE: Record<WeeklyJob, { label: string; weekday: number; hour: number; minute: number }> = {
  sentinel: { label: "com.agentic-trading.weekly-sentinel", weekday: 0, hour: 20, minute: 47 },
  f10: { label: "com.agentic-trading.weekly-f10", weekday: 0, hour: 21, minute: 17 },
  validation: { label: "com.agentic-trading.weekly-validation", weekday: 0, hour: 21, minute: 47 },
};

/** The per-job artifact prefix, and which directory the artifact lives in. */
export const WEEKLY_ARTIFACT: Record<WeeklyJob, { prefix: string; dir: "reports" | "logs" }> = {
  sentinel: { prefix: "sentinel", dir: "reports" },
  f10: { prefix: "f10-refresh", dir: "reports" },
  validation: { prefix: "validation-digest", dir: "logs" },
};

/** Phase-5 amendment A3's pre-agreed re-pricing signal: the measured per-day
 *  IC sd running at least this multiple of the assumed one. */
export const PROJECTION_WATCH_RATIO = 1.5;

export type HealthLevel = "healthy" | "warn" | "alert";

/** Does a chain deep-dive actually COVER the verdict leg for its session?
 *
 * `status: "complete"` is written unconditionally by `runDeepDiveBatch`
 * (`cli/deep-dive.ts`), so a run in which EVERY name failed still reads as a
 * successful leg to both guards. Measured 2026-09-16: the Kimi weekly quota wall
 * failed 4 of 63 names mid-evening — partial, so the leg genuinely ran. But when
 * the quota is already gone at the start of a run, or the key expires between
 * the preflight and the first call, all 40 fail and the run still reports
 * complete: the sample silently stops accruing while health stays green. That is
 * the case this predicate closes, and it is why "produced zero verdicts" must
 * count as NOT covered so the 23:03 slot and the next evening retry it.
 *
 * `topN === 0` (a lane with no picks that evening) IS coverage — there was
 * nothing to deep-dive, and calling it behind would re-run the lane forever.
 *
 * A PARTIAL failure deliberately still counts as coverage: the leg ran, the
 * session was seen, and re-running to chase a permanently-failing name would
 * loop every night. Its cost is surfaced instead of actioned — `HealthLane`
 * carries `deepDiveFailed`/`deepDiveTopN` so the loss is visible without
 * inventing work. */
export function deepDiveCovers(topN: number, failed: number): boolean {
  return topN === 0 || failed < topN;
}

/** 2026-09-19: the nightly deep-dive leg was retired by user decision — H2 is
 *  recorded as `abandoned` in docs/hypothesis-register.json (no class emitted:
 *  the anti-Goodhart clause allows a clock to stop only on a class at
 *  pre-registered power, and H2 stood at 0/159 days). Sessions screened on or
 *  after this date are NOT expected to carry a chain deep-dive, so the verdict
 *  leg of both guards (this file and ops:catchup) is silent for them; sessions
 *  before it keep their historical status (all of them were deep-dived).
 *  The screen leg is unaffected and still gates. Reversal: flip this date
 *  forward is NOT a reversal — restore the leg in scripts/daily-chain.sh and
 *  delete the two uses of this constant. */
export const DEEP_DIVE_RETIRED_AT = "2026-09-19";

/** Whether the verdict leg applies to a screened session: only sessions
 *  screened before the deep-dive retirement can owe a chain deep-dive. */
export function verdictLegApplies(sessionDate: string | null): boolean {
  return sessionDate != null && sessionDate < DEEP_DIVE_RETIRED_AT;
}

export interface LaneHealth {
  market: "HK" | "US";
  level: HealthLevel;
  reasons: string[];
  lastCompleteRunId: number | null;
  lastCompleteRunAt: string | null;
  lastScreenRunId: number | null;
  /** Newest bar date the store holds for this market (W3b's value). */
  dataThrough: string | null;
  /** Guarded evening catch-ups missed: evenings whose last slot (+ grace)
   *  passed with the lane still behind on a completed unscreened session. */
  expectedRunsMissed: number;  staleRunning: { id: number; runAt: string } | null;
  /** INFORMATIONAL ONLY (2026-09-13): completed store sessions >=
   *  PROSPECTIVE_FROM with no ScreenRun, excluding the currently-pending
   *  session tonight's catch-up will screen. Recoverable via
   *  `screen:rescreen --market <lane> --holes` — holes never change the level
   *  (the level system is for action-needed-now). */
  rescreenableHoles: number;
  /** Names the newest chain deep-dive could not verdict, out of its breadth
   *  (2026-09-16). Informational: a partial failure is real lost sample, but it
   *  must not re-run the lane. `null` when no chain run exists. */
  deepDiveFailed: number | null;
  deepDiveTopN: number | null;
}

export interface JobHealth {
  job: WeeklyJob;
  level: HealthLevel;
  reasons: string[];
  lastArtifactDate: string | null;
}

export interface HealthReport {
  asOf: string;
  level: HealthLevel;
  lanes: LaneHealth[];
  jobs: JobHealth[];
  /** Charter K3's spend reading (2026-09-16). INFORMATIONAL ONLY — like
   *  `rescreenableHoles`, it never contributes a reason or moves the level:
   *  exceeding a spend cap is a discipline signal, not a data-integrity
   *  failure, and mixing them would devalue the level system. `null` only if the
   *  store read failed. */
  cost: HealthCost | null;
}

export interface HealthCost {
  /** False when `LLM_PRICE_*` are unset — then every USD field is null and
   *  consumers must show tokens without inventing dollars. */
  priced: boolean;
  basis: string | null;
  /** Calendar month-to-date, HKT (the zone every other window in this file uses). */
  month: string;
  monthUsd: number | null;
  capUsd: number | null;
  overCap: boolean;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  /** Measured over rows carrying the cache split; `null` while none do. */
  cacheHitRate: number | null;
  /** True when some rows predate cache-split capture: the USD figure is an
   *  upper bound, and it is labelled that way rather than silently presented. */
  upperBound: boolean;
  /** Per-model calls (and spend) in the window. A month that straddles a model
   *  switch is a month whose dollar total mixes two price lists — and in this
   *  project's first such month, one of them (k3-256k) was subscription-billed
   *  and therefore had NO marginal cost at all. The mix is published so the
   *  headline number can be read correctly instead of being silently blended. */
  modelMix: { model: string; calls: number; usd: number | null }[];
}

export interface HealthOptions {
  now?: Date;
  /** Defaults to apps/api/reports — where the sentinel and f10 jobs write. */
  reportsDir?: string;
  /** Defaults to repo-root logs/ — where the validation digest is written. */
  logsDir?: string;
  /** Defaults to ~/Library/LaunchAgents — where the plist mtimes live. */
  launchAgentsDir?: string;
}

// --------------------------------------------------------------------------
// HKT calendar helpers (fixed offset, see the header note).
// --------------------------------------------------------------------------

function hktParts(d: Date): { y: number; m: number; d: number; weekday: number } {
  const s = new Date(d.getTime() + HKT_OFFSET_MS);
  return { y: s.getUTCFullYear(), m: s.getUTCMonth() + 1, d: s.getUTCDate(), weekday: s.getUTCDay() };
}

/** The instant of a given HKT calendar date + wall time. */
function hktSlot(y: number, m: number, d: number, hour: number, minute: number): Date {
  return new Date(Date.UTC(y, m - 1, d, hour - 8, minute));
}

/**
 * Scheduled slots strictly after `since` (or within the scan window when
 * `since` is null) that have already passed by more than the grace window.
 */
function countDueSlots(
  cadence: { weekdays: number[]; hour: number; minute: number },
  since: Date | null,
  now: Date,
): number {
  const cutoff = new Date(now.getTime() - MISSED_RUN_GRACE_HOURS * 3600 * 1000);
  const scanFrom = since ?? new Date(now.getTime() - NO_RUN_SCAN_DAYS * 86_400_000);
  const from = hktParts(scanFrom);
  const to = hktParts(cutoff);
  let count = 0;
  // Walk HKT calendar days. A calendar date's weekday is well-defined
  // independent of timezone, so UTC-midnight stepping is correct here.
  let t = Date.UTC(from.y, from.m - 1, from.d);
  const end = Date.UTC(to.y, to.m - 1, to.d);
  for (; t <= end; t += 86_400_000) {
    const day = new Date(t);
    if (!cadence.weekdays.includes(day.getUTCDay())) continue;
    const slot = hktSlot(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), cadence.hour, cadence.minute);
    if (since && slot.getTime() <= since.getTime()) continue;
    if (slot.getTime() <= cutoff.getTime()) count++;
  }
  return count;
}

function addDays(date: string, n: number): string {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** The HKT evening on which a session is expected screened: HK the same
 *  evening (lag 0), US the following one (lag 1 by construction). */
function expectedEvening(market: "HK" | "US", sessionDate: string): string {
  return market === "HK" ? sessionDate : addDays(sessionDate, 1);
}

/** Mon–Fri session candidates in (from, to]. Deliberately no market-holiday
 *  calendar — the warn/alert split absorbs the holidays it cannot see. */
function sessionCandidatesBetween(fromExclusive: string, toInclusive: string): string[] {
  const out: string[] = [];
  for (let d = addDays(fromExclusive, 1); d <= toInclusive; d = addDays(d, 1)) {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (wd >= 1 && wd <= 5) out.push(d);
  }
  return out;
}

/**
 * Missed evenings for a lane that is still behind. `pendingEvenings` holds the
 * expected screening evening of every completed session the lane has not
 * caught up on (unscreened store sessions, plus the newest screened session
 * when its chain deep-dive is missing). The count is the first due evening
 * plus every later cadence evening whose last slot passed the grace window —
 * the lane was behind on each of them, so the guarded catch-up should have
 * run and did not fix it.
 */
function missedEvenings(market: "HK" | "US", pendingEvenings: string[], now: Date): number {
  if (pendingEvenings.length === 0) return 0;
  const cutoff = new Date(now.getTime() - MISSED_RUN_GRACE_HOURS * 3600 * 1000);
  const firstDue = pendingEvenings.reduce((a, b) => (b < a ? b : a));
  const [fy, fm, fd] = firstDue.split("-").map(Number);
  const to = hktParts(cutoff);
  let count = 0;
  const end = Date.UTC(to.y, to.m - 1, to.d);
  for (let t = Date.UTC(fy!, fm! - 1, fd!); t <= end; t += 86_400_000) {
    const day = new Date(t);
    if (!LANE_CADENCE[market].weekdays.includes(day.getUTCDay())) continue;
    const slot = hktSlot(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), EVENING_LAST_SLOT.hour, EVENING_LAST_SLOT.minute);
    if (slot.getTime() <= cutoff.getTime()) count++;
  }
  return count;
}

/** Newest `sentinel-<date>.json` / `f10-refresh-<date>.json` date in a dir. */
function latestArtifactDate(dir: string, prefix: string): string | null {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return null; // no reports dir yet — treated as "never ran"
  }
  const dates = names
    .map((n) => n.match(new RegExp(`^${prefix}-(\\d{4}-\\d{2}-\\d{2})\\.json$`))?.[1])
    .filter((d): d is string => Boolean(d))
    .sort();
  return dates.length ? dates[dates.length - 1]! : null;
}

/**
 * When the weekly job was installed — install.sh *copies* the plist, so its
 * mtime is the install instant. Without this anchor, "no artifact" is
 * indistinguishable from "has not had a due slot yet": on 2026-09-11 the
 * f10 job (installed 09-10 23:21, first slot Sun 09-13 09:17) reported ALERT,
 * and because any job alert pins the whole report, the banner went red for a
 * job that had never been due.
 */
function installedAt(dir: string, label: string): Date | null {
  try {
    return statSync(path.join(dir, `${label}.plist`)).mtime;
  } catch {
    return null;
  }
}

/**
 * The projection watch (Phase-5 amendment A3), read off the newest validation
 * digest. Returns the WARN reason when the pooled per-day IC sd is measurable
 * and runs at >= PROJECTION_WATCH_RATIO times the assumed value; null while
 * the sd is unmeasurable (null fields — the expected state for months) or the
 * digest cannot be parsed. Lane-independent by design: it reads the POOLED
 * row, the primary read, and it is a warn, never an alert — the decision A3
 * asks for is a re-pricing, not an incident.
 */
function projectionWatchReason(logsDir: string, artifactDate: string): string | null {
  let digest: any;
  try {
    digest = JSON.parse(readFileSync(path.join(logsDir, `validation-digest-${artifactDate}.json`), "utf8"));
  } catch {
    return null;
  }
  const sdDay = digest?.pooled?.sdDay;
  const sdTheory = digest?.pooled?.sdTheory;
  if (typeof sdDay !== "number" || typeof sdTheory !== "number" || !(sdTheory > 0)) return null;
  const ratio = sdDay / sdTheory;
  if (ratio < PROJECTION_WATCH_RATIO) return null;
  return (
    `projection watch: measured per-day IC sd is ${ratio.toFixed(1)}x the assumed value — ` +
    `Phase-5 A3's re-pricing decision is due while still unlabelled`
  );
}

function daysBetween(fromDate: string, now: Date): number {
  const [y, m, d] = fromDate.split("-").map(Number);
  const from = Date.UTC(y!, m! - 1, d!);
  const p = hktParts(now);
  return Math.floor((Date.UTC(p.y, p.m - 1, p.d) - from) / 86_400_000);
}

// --------------------------------------------------------------------------
// The check.
// --------------------------------------------------------------------------

export async function computeHealth(prisma: PrismaService, opts: HealthOptions = {}): Promise<HealthReport> {
  const now = opts.now ?? new Date();
  const reportsDir = opts.reportsDir ?? path.join(PKG_ROOT, "reports");
  const logsDir = opts.logsDir ?? DEFAULT_LOGS_DIR;
  const launchAgentsDir = opts.launchAgentsDir ?? DEFAULT_LAUNCH_AGENTS_DIR;
  const lanes: LaneHealth[] = [];

  for (const market of ["HK", "US"] as const) {
    // Provenance (same policy as ReportsService.daily): "last complete run"
    // means the newest complete **chain** run — an ad-hoc smoke run must not
    // reset the missed-slot clock. Fall back to any provenance only when the
    // lane has no chain run at all.
    const [chainRun, anyRun, screenRun, latestBar, laneBarDates, laneScreened] = await Promise.all([
      prisma.deepDiveRun.findFirst({ where: { market, status: "complete", source: "chain" }, orderBy: { runAt: "desc" } }),
      prisma.deepDiveRun.findFirst({ where: { market, status: "complete" }, orderBy: { runAt: "desc" } }),
      // The newest run *that records its session* — rows predating the column
      // carry '' and cannot answer the cadence question. Order by SESSION DATE,
      // not runAt (same rule as ops:catchup): a screen:rescreen row has a fresh
      // runAt and an OLD sessionDate, and must not read as the newest session —
      // neither for the screen leg nor for the verdict leg below, where the
      // newest SESSION's screen run is the one that must carry a complete
      // chain deep-dive.
      prisma.screenRun.findFirst({ where: { market, sessionDate: { not: "" } }, orderBy: [{ sessionDate: "desc" }, { runAt: "desc" }] }),
      prisma.bar.findFirst({ where: { instrument: { market } }, orderBy: { date: "desc" }, select: { date: true } }),
      // Hole visibility (informational): distinct store sessions + screened
      // sessionDates, so rescreenable holes can be counted without a second pass.
      prisma.bar.findMany({ where: { instrument: { market } }, distinct: ["date"], orderBy: { date: "asc" }, select: { date: true } }),
      prisma.screenRun.findMany({ where: { market, sessionDate: { not: "" } }, select: { sessionDate: true } }),
    ]);
    const run = chainRun ?? anyRun;
    // Verdict leg: the newest screen must carry a COMPLETE chain-source
    // deep-dive that actually produced verdicts — an ad-hoc run does not count
    // (same policy as ops:catchup), and neither does a chain run whose every
    // name failed (deepDiveCovers, 2026-09-16). RETIRED 2026-09-19: the leg is
    // silent for sessions screened on/after DEEP_DIVE_RETIRED_AT
    // (verdictLegApplies) — the nightly deep-dive no longer runs by decision.
    const chainDeepDive = screenRun
      ? await prisma.deepDiveRun.findFirst({
          where: { screenRunId: screenRun.id, status: "complete", source: "chain" },
          select: { id: true, topN: true, failed: true },
        })
      : null;
    const chainCovers = chainDeepDive != null && deepDiveCovers(chainDeepDive.topN, chainDeepDive.failed);

    const staleCutoff = new Date(now.getTime() - STALE_RUNNING_HOURS * 3600 * 1000);
    const stale = await prisma.deepDiveRun.findFirst({
      where: { market, status: "running", runAt: { lt: staleCutoff } },
      orderBy: { runAt: "desc" },
    });

    const lastScreened = screenRun?.sessionDate || null;
    const storeThrough = latestBar?.date ?? null;
    const verdictLeg = verdictLegApplies(lastScreened);

    // Pending evenings: the expected screening evening of every completed
    // session the lane has not caught up on — each unscreened store session
    // (screen leg), plus the newest screened session when its chain verdict is
    // missing (verdict leg). An empty list means the lane is NOT behind, and a
    // lane that is not behind cannot have missed anything.
    const pending = new Set<string>();
    if (storeThrough && lastScreened && storeThrough > lastScreened) {
      for (const d of sessionCandidatesBetween(lastScreened, storeThrough)) pending.add(expectedEvening(market, d));
    } else if (storeThrough && !lastScreened) {
      // No run records its session (legacy rows) — count the newest only, the
      // conservative bound; the "no complete run" alert covers the never-ran.
      pending.add(expectedEvening(market, storeThrough));
    }
    if (verdictLeg && !chainCovers) pending.add(expectedEvening(market, lastScreened!));
    const missed = missedEvenings(market, [...pending], now);

    // Rescreenable holes (INFORMATIONAL ONLY — never a reason, never a level):
    // completed store sessions in the prospective window nobody screened. The
    // newest unscreened session is excluded — it is tonight's catch-up's job,
    // not a hole. The recovery is `screen:rescreen --market <lane> --holes`.
    const screenedDates = new Set(laneScreened.map((r) => r.sessionDate));
    const unscreened = (laneBarDates as { date: string }[])
      .map((r) => r.date)
      .filter((d) => d >= PROSPECTIVE_FROM && sessionClosed(market, d, now) && !screenedDates.has(d));
    const pendingTonight = storeThrough !== null && unscreened.length > 0 && unscreened[unscreened.length - 1] === storeThrough;
    const rescreenableHoles = unscreened.length - (pendingTonight ? 1 : 0);

    const reasons: string[] = [];

    if (!run && (lastScreened == null || verdictLeg)) {
      // lastScreened null means the lane has never recorded a screened session:
      // the absence of ANY complete run is what is actionable there, not the
      // retired deep-dive leg specifically.
      reasons.push(verdictLeg ? "no complete deep-dive run on record" : "no complete run on record");
    } else if (missed >= 2) {
      reasons.push(
        `${missed} guarded evening catch-ups missed — lane still behind ` +
          `(store through ${storeThrough ?? "—"}, screened through ${lastScreened ?? "—"}; last complete run ${run?.runAt.toISOString() ?? "—"})`,
      );
    }
    if (stale) {
      reasons.push(`run ${stale.id} has been 'running' since ${stale.runAt.toISOString()} — crashed or killed`);
    }
    // A leg that ran and produced NOTHING is not "one evening late" — it is a
    // failed leg, so it is an alert-level reason of its own rather than riding
    // the missed-evening count. Partial failures stay informational (below) to
    // avoid a re-run loop on a permanently-failing name. Silent for sessions
    // screened on/after DEEP_DIVE_RETIRED_AT — no retry slot exists anymore.
    if (verdictLeg && chainDeepDive && !chainCovers) {
      reasons.push(
        `newest chain deep-dive (run ${chainDeepDive.id}) completed with 0 of ${chainDeepDive.topN} verdicts — ` +
          `the verdict leg produced nothing; the next slot will retry it`,
      );
    }

    // Warn is the catch-up-on-wake case: a lane can be one evening late and be
    // perfectly healthy (tonight's 20:30/23:03 slots should recover it). Only
    // a second missed evening escalates.
    const level: HealthLevel = reasons.length > 0 ? "alert" : missed === 1 ? "warn" : "healthy";
    if (missed === 1 && !stale && run) reasons.push("1 evening catch-up is late (lane still behind after last evening's slots)");

    lanes.push({
      market,
      level,
      reasons,
      lastCompleteRunId: run?.id ?? null,
      lastCompleteRunAt: run?.runAt.toISOString() ?? null,
      lastScreenRunId: screenRun?.id ?? null,
      dataThrough: latestBar?.date ?? null,
      expectedRunsMissed: missed,
      staleRunning: stale ? { id: stale.id, runAt: stale.runAt.toISOString() } : null,
      rescreenableHoles,
      deepDiveFailed: chainDeepDive?.failed ?? null,
      deepDiveTopN: chainDeepDive?.topN ?? null,
    });
  }

  const jobs: JobHealth[] = WEEKLY_JOBS.map((job) => {
    const artifact = WEEKLY_ARTIFACT[job];
    const prefix = artifact.prefix;
    const artifactDir = artifact.dir === "logs" ? logsDir : reportsDir;
    const cadence = WEEKLY_CADENCE[job];
    const last = latestArtifactDate(artifactDir, prefix);
    const reasons: string[] = [];
    let level: HealthLevel = "healthy";

    if (last) {
      const age = daysBetween(last, now);
      if (age > WEEKLY_OVERDUE_DAYS) {
        level = "alert";
        reasons.push(`last artifact ${last} is ${age} days old (weekly job overdue past ${WEEKLY_OVERDUE_DAYS}d)`);
      }
      // Content-aware, validation only: the digest's pooled sd ratio is A3's
      // re-pricing signal. A warn, never an alert, and silent while the sd is
      // unmeasurable (nulls) — which is the expected state for months.
      if (job === "validation") {
        const watch = projectionWatchReason(logsDir, last);
        if (watch) {
          if (level === "healthy") level = "warn";
          reasons.push(watch);
        }
      }
    } else {
      const anchor = installedAt(launchAgentsDir, cadence.label);
      const due = anchor
        ? countDueSlots({ weekdays: [cadence.weekday], hour: cadence.hour, minute: cadence.minute }, anchor, now)
        : null;
      if (due === null) {
        level = "alert";
        reasons.push(`no ${prefix}-<date>.json artifact on record and no ${cadence.label}.plist to date the install — cannot confirm the weekly job ran`);
      } else if (due === 0) {
        // Installed after the most recent Sunday slot. Not a signal either way.
        reasons.push(
          `no artifact yet — not yet due (installed ${anchor!.toISOString()}, first Sunday slot ` +
            `${String(cadence.hour).padStart(2, "0")}:${String(cadence.minute).padStart(2, "0")} HKT)`,
        );
      } else {
        level = "alert";
        reasons.push(
          `no ${prefix}-<date>.json artifact on record — cannot confirm the weekly job ran ` +
            `(${due} scheduled slot(s) passed since the ${anchor!.toISOString()} install)`,
        );
      }
    }
    return { job, level, reasons, lastArtifactDate: last };
  });

  const all = [...lanes.map((l) => l.level), ...jobs.map((j) => j.level)];
  const level: HealthLevel = all.includes("alert") ? "alert" : all.includes("warn") ? "warn" : "healthy";
  return { asOf: now.toISOString(), level, lanes, jobs, cost: await computeCost(prisma, now) };
}

/** First instant of the HKT calendar month containing `now`. */
export function hktMonthStart(now: Date): { start: Date; month: string } {
  const { y, m } = hktParts(now);
  return { start: hktSlot(y, m, 1, 0, 0), month: `${y}-${String(m).padStart(2, "0")}` };
}

/** K3's reading. Informational by construction — it returns data, never a reason,
 *  so it cannot move a lane's level. */
async function computeCost(prisma: PrismaService, now: Date): Promise<HealthCost | null> {
  const pricing = parsePricing(process.env);
  const capUsd = parseCapUsd(process.env);
  const { start, month } = hktMonthStart(now);
  try {
    const rows = await loadCostRows(prisma, start, now);
    const s = summarize(rows, pricing, capUsd);
    return {
      priced: s.priced,
      basis: s.basis,
      month,
      monthUsd: s.priced ? s.totals.usd : null,
      capUsd: s.priced ? s.capUsd : null,
      overCap: s.overCap,
      calls: s.totals.calls,
      promptTokens: s.totals.promptTokens,
      completionTokens: s.totals.completionTokens,
      cacheHitTokens: s.totals.cacheHitTokens,
      cacheMissTokens: s.totals.cacheMissTokens,
      cacheHitRate: s.cacheHitRate,
      upperBound: s.totals.upperBound,
      modelMix: Object.entries(s.byModel)
        .map(([model, t]) => ({ model, calls: t.calls, usd: s.priced ? t.usd : null }))
        .sort((a, b) => b.calls - a.calls),
    };
  } catch {
    // A cost read must never be able to fail the health check that guards the
    // data pipeline: absent is better than a false ALERT.
    return null;
  }
}
