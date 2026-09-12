/**
 * `ops:catchup` — decide whether a lane has an unscreened session (2026-09-11).
 *
 * The daily chain fires at 06:10 (US) / 16:50 (HK) HKT, and launchd does not
 * replay calendar slots missed across **power-off** (only sleep — architecture
 * §5.1). Measured supply is therefore only **56 %**: 5 of 9 expected slots per
 * lane since 2026-09-01. That used to cost a stale report. It now costs a **lost
 * observation** from two validation samples, and it roughly doubles the longer
 * one (`phase4c:accrual`: 4.7 y → 8.4 y at that supply rate).
 *
 * So a second, *guarded* slot runs in the evening and does nothing when the day
 * already went well. This CLI is the guard, and it is written as a decision rather
 * than a shell conditional because the question is exactly the one the run ledger
 * answers: **is either leg behind?** — (a) the store holds a session newer than
 * the newest session any run has screened (screen leg), or (b) the newest screen
 * run has no COMPLETE chain-source deep-dive attached (verdict leg). Checking
 * only (a) was the 2026-09-12 production miss: HK was "up to date" on the screen
 * leg while the 09-10/09-11 chain deep-dives had never run (machine off), and the
 * guard skipped — leaving the verdict sample permanently behind until a manual
 * run healed it. An ad-hoc deep-dive (`source: "adhoc"`) must NOT satisfy (b):
 * provenance is the whole point (same policy as `ops/health.ts`).
 *
 * This is not the "self-heal job" R0 declined. That was rejected because the
 * failure it addressed was a stale *report*; this addresses a lost *sample*, and
 * the guard makes it a no-op on a healthy day.
 *
 * Exit codes: 0 = nothing to do · 10 = a lane needs a run (the caller's cue).
 *
 * Usage: pnpm -C apps/api ops:catchup [--json] [--lane hk|us]
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Market } from "@agentic-trading/quant-core";
import { PrismaService } from "../prisma.service.js";

const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/** Exit code meaning "a lane is behind" — distinct from failure. */
export const NEEDS_RUN = 10;

export interface CatchupLane {
  market: Market;
  /** Newest bar date the store holds for this lane. */
  latestBar: string | null;
  /** Newest session any run has screened ('' when no run records it). */
  lastScreened: string | null;
  lastRunAt: string | null;
  needsRun: boolean;
  reason: string;
}

export interface CatchupReport {
  asOf: string;
  lanes: CatchupLane[];
  needsRun: boolean;
}

export function parseCatchupArgs(argv: string[]): { json: boolean; markets: Market[] } {
  const out = { json: false, markets: ["US", "HK"] as Market[] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--" || a === "--quiet") continue;
    if (a === "--json") {
      out.json = true;
      continue;
    }
    if (a === "--lane") {
      const v = argv[++i];
      if (v === "us") out.markets = ["US"];
      else if (v === "hk") out.markets = ["HK"];
      else throw new Error(`--lane must be us|hk, got "${v ?? ""}"`);
      continue;
    }
    throw new Error(`unknown argument "${a}" (expected --json, --lane us|hk)`);
  }
  return out;
}

/**
 * Pure decision. `sessionDate` is the newest session any run has screened;
 * an empty/unknown value means **run it**, because a duplicate costs a few
 * minutes while a lost observation is unrecoverable. `chainDeepDive` is whether
 * that newest screen run carries a complete chain-source deep-dive; the lane is
 * behind when EITHER leg is.
 */
export function decideLane(
  market: Market,
  latestBar: string | null,
  lastScreened: string | null,
  lastRunAt: string | null,
  chainDeepDive: boolean | null,
): CatchupLane {
  if (!latestBar) {
    return { market, latestBar, lastScreened, lastRunAt, needsRun: false, reason: "no stored bars — nothing to screen" };
  }
  if (!lastScreened) {
    return {
      market,
      latestBar,
      lastScreened,
      lastRunAt,
      needsRun: true,
      reason: `no run records which session it screened — running to be safe`,
    };
  }
  if (latestBar > lastScreened) {
    return {
      market,
      latestBar,
      lastScreened,
      lastRunAt,
      needsRun: true,
      reason: `store holds ${latestBar}, last screened ${lastScreened} — SCREEN leg one session behind`,
    };
  }
  if (!chainDeepDive) {
    return {
      market,
      latestBar,
      lastScreened,
      lastRunAt,
      needsRun: true,
      reason: `screen current through ${lastScreened} but no complete chain deep-dive for that session — DEEP-DIVE leg behind`,
    };
  }
  return {
    market,
    latestBar,
    lastScreened,
    lastRunAt,
    needsRun: false,
    reason: `up to date (screened and deep-dived through ${lastScreened}, store holds ${latestBar})`,
  };
}

export function renderCatchup(r: CatchupReport): string {
  const lines = [`== CATCHUP == ${r.asOf} · ${r.needsRun ? "A LANE NEEDS A RUN" : "nothing to do"}`];
  for (const l of r.lanes) {
    lines.push(`${l.market}: ${l.needsRun ? "RUN" : "skip"} — ${l.reason}${l.lastRunAt ? ` (last run ${l.lastRunAt})` : ""}`);
  }
  return lines.join("\n");
}

export async function runCatchup(prisma: PrismaService, markets: Market[]): Promise<CatchupReport> {
  const lanes: CatchupLane[] = [];
  for (const market of markets) {
    const bar = await prisma.bar.findFirst({
      where: { instrument: { market } },
      orderBy: { date: "desc" },
      select: { date: true },
    });
    // The newest run *that records its session*, not merely the newest run: rows
    // written before the column carry '' and cannot answer the question.
    const run = await prisma.screenRun.findFirst({
      where: { market, sessionDate: { not: "" } },
      orderBy: { runAt: "desc" },
    });
    const newest = run ?? (await prisma.screenRun.findFirst({ where: { market }, orderBy: { runAt: "desc" } }));
    // Verdict leg: the newest screen run must carry a COMPLETE chain-source
    // deep-dive. An ad-hoc run does not count — the chain's verdicts are the
    // sample this guard protects.
    const chainDeepDive = run
      ? await prisma.deepDiveRun.findFirst({
          where: { screenRunId: run.id, status: "complete", source: "chain" },
          select: { id: true },
        })
      : null;
    lanes.push(
      decideLane(
        market,
        bar?.date ?? null,
        run?.sessionDate || null,
        newest?.runAt ? newest.runAt.toISOString() : null,
        run ? chainDeepDive != null : null,
      ),
    );
  }
  return { asOf: new Date().toISOString(), lanes, needsRun: lanes.some((l) => l.needsRun) };
}

async function main(): Promise<void> {
  const args = parseCatchupArgs(process.argv.slice(2));
  const prisma = new PrismaService();
  await prisma.$connect();
  let report: CatchupReport;
  try {
    report = await runCatchup(prisma, args.markets);
  } finally {
    await prisma.$disconnect();
  }
  console.log(args.json ? JSON.stringify(report, null, 2) : renderCatchup(report));
  if (report.needsRun) process.exitCode = NEEDS_RUN;
}

const invokedAsScript = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (invokedAsScript) {
  main().catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
  });
}
