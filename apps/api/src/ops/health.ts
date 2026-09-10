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
 * Cadence is derived from the launchd plists: daily-hk Mon-Fri 16:50 HKT,
 * daily-us Tue-Sat 06:10 HKT. Both lanes are scheduled in HKT and HKT has had
 * no DST since 1979, so the fixed +08:00 offset below is exact rather than an
 * approximation. There is deliberately NO market-holiday calendar: the spec
 * locked cadence-aware weekday arithmetic, and the warn/alert split absorbs
 * the holidays it cannot see.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaService } from "../prisma.service.js";

export const HKT_OFFSET_MS = 8 * 3600 * 1000;

/** apps/api — same convention as the sentinel/f10 CLIs, so the artifact dir
 *  resolves identically no matter the process cwd. */
const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/** A slot only counts as MISSED once it is this far past. Runs are
 *  catch-up-on-wake by design (the machine sleeps through 06:10), and the
 *  observed 2026-09-10 catch-up was ~2.5h late, so 6h gives headroom without
 *  letting a whole missed day slip through. */
export const MISSED_RUN_GRACE_HOURS = 6;

/** A closed lane pool takes ~3 minutes (the 09-10 run covered 4 of 10 names in
 *  2.5 min), so anything still "running" after 2h is a crashed run. */
export const STALE_RUNNING_HOURS = 2;

/** Weekly jobs run Sundays; 8 days means one missed week fires. */
export const WEEKLY_OVERDUE_DAYS = 8;

/** How far back to scan for missed slots when a lane has no complete run. */
export const NO_RUN_SCAN_DAYS = 30;

export const LANE_CADENCE: Record<"HK" | "US", { weekdays: number[]; hour: number; minute: number }> = {
  HK: { weekdays: [1, 2, 3, 4, 5], hour: 16, minute: 50 }, // Mon-Fri 16:50 HKT
  US: { weekdays: [2, 3, 4, 5, 6], hour: 6, minute: 10 }, // Tue-Sat 06:10 HKT
};

export const WEEKLY_JOBS = ["sentinel", "f10"] as const;
export type WeeklyJob = (typeof WEEKLY_JOBS)[number];

export type HealthLevel = "healthy" | "warn" | "alert";

export interface LaneHealth {
  market: "HK" | "US";
  level: HealthLevel;
  reasons: string[];
  lastCompleteRunId: number | null;
  lastCompleteRunAt: string | null;
  lastScreenRunId: number | null;
  /** Newest bar date the store holds for this market (W3b's value). */
  dataThrough: string | null;
  /** Scheduled slots passed (beyond grace) since the last complete run. */
  expectedRunsMissed: number;
  staleRunning: { id: number; runAt: string } | null;
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
}

export interface HealthOptions {
  now?: Date;
  /** Defaults to apps/api/reports — where the sentinel and f10 jobs write. */
  reportsDir?: string;
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
function missedSlots(market: "HK" | "US", since: Date | null, now: Date): number {
  const cadence = LANE_CADENCE[market];
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
  const lanes: LaneHealth[] = [];

  for (const market of ["HK", "US"] as const) {
    const [run, screenRun, latestBar] = await Promise.all([
      prisma.deepDiveRun.findFirst({ where: { market, status: "complete" }, orderBy: { runAt: "desc" } }),
      prisma.screenRun.findFirst({ where: { market }, orderBy: { runAt: "desc" } }),
      prisma.bar.findFirst({ where: { instrument: { market } }, orderBy: { date: "desc" }, select: { date: true } }),
    ]);

    const staleCutoff = new Date(now.getTime() - STALE_RUNNING_HOURS * 3600 * 1000);
    const stale = await prisma.deepDiveRun.findFirst({
      where: { market, status: "running", runAt: { lt: staleCutoff } },
      orderBy: { runAt: "desc" },
    });

    const reasons: string[] = [];
    const missed = missedSlots(market, run?.runAt ?? null, now);

    if (!run) {
      reasons.push("no complete deep-dive run on record");
    } else if (missed >= 2) {
      reasons.push(`${missed} scheduled runs missed since the last complete run (${run.runAt.toISOString()})`);
    }
    if (stale) {
      reasons.push(`run ${stale.id} has been 'running' since ${stale.runAt.toISOString()} — crashed or killed`);
    }

    // Warn is the catch-up-on-wake case: a lane can be one slot late every day
    // and be perfectly healthy. Only a whole missed slot escalates.
    const level: HealthLevel = reasons.length > 0 ? "alert" : missed === 1 ? "warn" : "healthy";
    if (missed === 1 && !stale && run) reasons.push("1 scheduled run is currently late (catch-up pending)");

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
    });
  }

  const jobs: JobHealth[] = WEEKLY_JOBS.map((job) => {
    const prefix = job === "sentinel" ? "sentinel" : "f10-refresh";
    const last = latestArtifactDate(reportsDir, prefix);
    const reasons: string[] = [];
    if (!last) {
      reasons.push(`no ${prefix}-<date>.json artifact on record — cannot confirm the weekly job ran`);
    } else if (daysBetween(last, now) > WEEKLY_OVERDUE_DAYS) {
      const age = daysBetween(last, now);
      reasons.push(`last artifact ${last} is ${age} days old (weekly job overdue past ${WEEKLY_OVERDUE_DAYS}d)`);
    }
    return { job, level: reasons.length ? "alert" : "healthy", reasons, lastArtifactDate: last };
  });

  const all = [...lanes.map((l) => l.level), ...jobs.map((j) => j.level)];
  const level: HealthLevel = all.includes("alert") ? "alert" : all.includes("warn") ? "warn" : "healthy";
  return { asOf: now.toISOString(), level, lanes, jobs };
}
