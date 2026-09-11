/**
 * `phase4c:accrual` — the prospective-data clock (Phase 4b D6).
 *
 * Phase 4 and 4b both spent the same 1003-session window, so nothing more can be
 * learned there: every further statistic on it is in-sample. The only genuinely
 * fresh free data is **future sessions**, and the daily pipeline is already
 * emitting them — `ScreenRun`/`ScreenResult` accumulate one row per lane per
 * session, with the ranked list as it was published that day.
 *
 * This CLI answers the only question that matters for planning Phase 4c: *how
 * much of that data exists, and how long until it can decide anything.* It
 * computes the second part from D1's measured standard error rather than from a
 * plausible effect size — the rule Phase 4 broke.
 *
 * Read-only. No artifact, by design: it is a live readout, and the numbers it
 * projects from are already stored in the backtest artifact it cites.
 *
 * Usage: pnpm -C apps/api phase4c:accrual [--json]
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scheduledSlotsBetween } from "../ops/health.js";
import { PrismaService } from "../prisma.service.js";

const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const BACKTEST_DIR = path.join(PKG_ROOT, "reports", "backtest");

/** Sessions after this date are prospective. The Phase-4 window ends 2026-09-11
 *  (US) / 2026-09-11 (HK), so anything strictly after it was never looked at. */
export const PROSPECTIVE_FROM = "2026-09-12";

/** The pre-registered Gate 1 bar and its significance requirement: the target SE
 *  is bar / t, because a bar reachable only at t < 2 is not reachable at all. */
export const GATE1_BAR = 0.02;
export const GATE1_T = 2;

/** Trading sessions per month, for turning a session count into a date. */
const SESSIONS_PER_MONTH = 21;

export interface AccrualLane {
  market: "US" | "HK";
  /** Stored production runs after the cutoff — one lane-day observation each. */
  prospectiveSessions: number;
  /** Slots the cadence says should have fired since the cutoff. */
  expectedSessions: number;
  /** expected − collected. Every one is a permanently lost observation, not just
   *  a stale report: the validation sample needs a fixed number of sessions. */
  missedSessions: number;
  /** Of those, how many already have a full 20-session forward label. */
  labelled20: number;
  latestBar: string | null;
  /** From the newest backtest artifact: the realized SE this window produced. */
  observedDays: number | null;
  observedNwSe: number | null;
  /** Sessions needed for the 0.02 bar to be reachable at t = 2, from that SE. */
  requiredDays: number | null;
  /** requiredDays − observedDays, in sessions and in months. */
  additionalSessions: number | null;
  additionalMonths: number | null;
  /** The statistic D6 picks instead: the Gate-2 differential. Its t grows as √T
   *  at fixed IR, so the accrual needed is a different (and smaller) number. */
  differentialT: number | null;
  differentialYears: number | null;
  differentialAdditionalYears: number | null;
}

export interface AccrualReport {
  asOf: string;
  prospectiveFrom: string;
  lanes: AccrualLane[];
  /** Which backtest artifact the SE projections came from. */
  sourceArtifact: string | null;
  note: string;
}

/** Newest `backtest/YYYY-MM-DD.json`, or null. */
export function newestBacktestArtifact(dir: string = BACKTEST_DIR): { file: string; json: any } | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const dates = names
    .map((n) => n.match(/^(\d{4}-\d{2}-\d{2})\.json$/)?.[1])
    .filter((d): d is string => Boolean(d))
    .sort();
  const latest = dates[dates.length - 1];
  if (!latest) return null;
  const file = path.join(dir, `${latest}.json`);
  try {
    return { file, json: JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    return null;
  }
}

/** HKT calendar date of a stored run. */
export function hktDate(d: Date): string {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Sessions needed for the bar to be reachable, scaled from the observed SE.
 * SE shrinks with 1/√T, so T_req = T_obs · (se_obs / se_target)².
 */
export function requiredSessions(observedDays: number, observedSe: number, bar = GATE1_BAR, t = GATE1_T): number {
  const target = bar / t;
  if (!(observedSe > 0) || !(observedDays > 0)) return NaN;
  return observedDays * (observedSe / target) ** 2;
}

export function projectLane(
  market: "US" | "HK",
  ip: { sessions: number; expectedSessions?: number; labelled20: number; latestBar: string | null },
  artifact: any | null,
): AccrualLane {
  const lane = artifact?.lanes?.find((l: any) => l.market === market);
  const observedDays: number | null = lane?.gate1?.days ?? null;
  const observedNwSe: number | null = lane?.gate1?.nwSe ?? null;
  const req =
    observedDays != null && observedNwSe != null && observedDays > 0 && observedNwSe > 0
      ? requiredSessions(observedDays, observedNwSe)
      : null;
  const additional = req != null && observedDays != null ? req - observedDays : null;
  const differentialT: number | null = lane?.gate2Base?.nwT ?? null;
  const differentialYears: number | null = lane?.gate2Base?.years ?? null;
  const differentialAdditionalYears =
    differentialT != null && differentialYears != null && Math.abs(differentialT) > 0
      ? differentialYears * (GATE1_T / Math.abs(differentialT)) ** 2 - differentialYears
      : null;
  return {
    market,
    prospectiveSessions: ip.sessions,
    expectedSessions: ip.expectedSessions ?? ip.sessions,
    missedSessions: Math.max(0, (ip.expectedSessions ?? ip.sessions) - ip.sessions),
    labelled20: ip.labelled20,
    latestBar: ip.latestBar,
    observedDays,
    observedNwSe,
    requiredDays: req,
    additionalSessions: additional,
    additionalMonths: additional == null ? null : additional / SESSIONS_PER_MONTH,
    differentialT,
    differentialYears,
    differentialAdditionalYears,
  };
}

export function renderAccrual(r: AccrualReport): string {
  const lines: string[] = [];
  lines.push(`== PHASE 4c ACCRUAL == ${r.asOf} · prospective from ${r.prospectiveFrom}`);
  for (const l of r.lanes) {
    lines.push(
      `${l.market}: ${l.prospectiveSessions}/${l.expectedSessions} prospective lane-days collected` +
        `${l.missedSessions > 0 ? ` — **${l.missedSessions} slots missed** (each is a permanently lost observation)` : ""}` +
        ` · ${l.labelled20} already carry a 20d label · store data through ${l.latestBar ?? "—"}`,
    );
    if (l.observedNwSe == null) {
      lines.push(`    no backtest artifact to project from — run \`backtest:screen\` first`);
      continue;
    }
    lines.push(
      `    observed: ${l.observedDays} days · NW SE ${l.observedNwSe.toFixed(5)} → the ${GATE1_BAR} bar needs SE <= ${(GATE1_BAR / GATE1_T).toFixed(3)}`,
    );
    lines.push(
      `    required: ~${Math.ceil(l.requiredDays!).toLocaleString()} lane-days to reach t=${GATE1_T} on an IC of ${GATE1_BAR}` +
        ` → ~${Math.ceil(l.additionalSessions!).toLocaleString()} more sessions (~${(l.additionalMonths! / 12).toFixed(1)} years at ${SESSIONS_PER_MONTH}/month)`,
    );
    if (l.differentialT != null && l.differentialAdditionalYears != null) {
      lines.push(
        `    the D6 statistic instead (differential, t=${l.differentialT.toFixed(2)} over ${l.differentialYears!.toFixed(2)}y):` +
          ` t grows as sqrt(T) at fixed IR, so |t|=${GATE1_T} needs ~${l.differentialAdditionalYears.toFixed(1)} more years`,
      );
    }
  }
  lines.push("");
  lines.push(r.note);
  return lines.join("\n");
}

/** Distinct session dates per market, ascending. */
async function laneSessions(prisma: PrismaService, market: string): Promise<string[]> {
  const rows = (await prisma.bar.findMany({
    where: { instrument: { market } },
    distinct: ["date"],
    orderBy: { date: "asc" },
    select: { date: true },
  })) as { date: string }[];
  return rows.map((r) => r.date);
}

export async function runAccrual(prisma: PrismaService): Promise<AccrualReport> {
  const artifact = newestBacktestArtifact();
  const lanes: AccrualLane[] = [];

  for (const market of ["US", "HK"] as const) {
    const sessions = await laneSessions(prisma, market);
    const runs = await prisma.screenRun.findMany({ where: { market }, orderBy: { runAt: "asc" } });
    const prospective = runs.map((r) => hktDate(r.runAt)).filter((d) => d >= PROSPECTIVE_FROM);
    // Supply vs expectation: the same cadence the health check uses, so a missed
    // slot is counted once and means the same thing in both places.
    const today = hktDate(new Date());
    const expectedSessions = scheduledSlotsBetween(market, PROSPECTIVE_FROM, today);
    // A prospective session carries a 20d label once 20 lane sessions exist after it.
    const labelled20 = prospective.filter((d) => sessions.filter((s) => s > d).length >= 20).length;
    lanes.push(
      projectLane(
        market,
        { sessions: prospective.length, expectedSessions, labelled20, latestBar: sessions[sessions.length - 1] ?? null },
        artifact?.json ?? null,
      ),
    );
  }

  return {
    asOf: new Date().toISOString(),
    prospectiveFrom: PROSPECTIVE_FROM,
    lanes,
    sourceArtifact: artifact ? path.relative(PKG_ROOT, artifact.file) : null,
    note:
      "Projections scale the OBSERVED Newey-West SE by 1/sqrt(T) — measured, not assumed (Phase 4b D1's rule). " +
      "They are a planning floor, not a promise: the SE is regime-dependent, which is why D6 pairs the design-half " +
      "bar with an SE-stability guard. Note the two rows are different questions: the rank-IC row asks when the " +
      "0.02 bar becomes *reachable*, while the differential row asks when the statistic D6 actually picks becomes " +
      "*significant* at its observed IR. The collected/expected counts are the other half of the same problem: " +
      "this sample is supplied by the daily chain, so a missed slot is a lost observation rather than a stale report.",
  };
}

export function parseAccrualArgs(argv: string[]): { json: boolean } {
  let json = false;
  for (const arg of argv) {
    if (arg === "--" || arg === "--quiet") continue;
    if (arg === "--json") {
      json = true;
      continue;
    }
    throw new Error(`unknown argument "${arg}" (expected --json)`);
  }
  return { json };
}

async function main(): Promise<void> {
  const args = parseAccrualArgs(process.argv.slice(2));
  const prisma = new PrismaService();
  await prisma.$connect();
  let report: AccrualReport;
  try {
    report = await runAccrual(prisma);
  } finally {
    await prisma.$disconnect();
  }
  console.log(args.json ? JSON.stringify(report, null, 2) : renderAccrual(report));
}

const invokedAsScript = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (invokedAsScript) {
  main().catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
  });
}
