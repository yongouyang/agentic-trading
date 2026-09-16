/**
 * `ops:catchup` — the guard on the evening catch-up chain (2026-09-11).
 *
 * Since 2026-09-14 the guarded evening run (`daily-catchup`, 20:30 + 23:03
 * HKT) is THE daily pipeline for both lanes, not a safety net: the machine is
 * realistically only on in the evening, so the 06:10 (US) and 16:50 (HK)
 * launchd jobs were removed that day. At 20:30 HKT the HK lane's same-day
 * session is complete; the US lane processes the PREVIOUS US session (closed
 * 04:00/05:00 HKT that morning) — lag 1 by construction.
 *
 * The guard is written as a decision rather than a shell conditional because
 * the question is exactly the one the run ledger answers: **is either leg
 * behind?** Three checks, in order:
 *
 * (0) EXPECTED-session probe (added 2026-09-14, after that day's incident):
 *     the store-based check (a) is blind when NOTHING fetched. On 2026-09-14
 *     the machine was powered off until 20:05 HKT, no chain ever ran, the
 *     store still ended at 2026-09-11 — equal to the last screened session —
 *     so the guard read "up to date" while that day's completed HK session
 *     went unscreened; the day would have been lost with every surface
 *     reporting healthy. So the guard now asks the PROVIDER, not the store:
 *     fetch daily bars for the first 3 names of the lane's committed
 *     universe and take the newest bar date whose session has officially
 *     closed (quant-core `sessionClosed`). If that date is newer than the
 *     newest session any run has screened, a completed session exists that
 *     no run has seen — run; the chain's fetch brings the store forward and
 *     screens it. The probe is the source of truth for "a newer session
 *     completed" precisely because it needs NO holiday calendar: on a
 *     holiday the provider simply returns the previous trading day, so the
 *     probe can never invent a session. It is READ-ONLY
 *     (`MarketDataService.getDailyBars` never persists; the chain's runLane
 *     does the upserts), and a probe failure degrades to null = exactly the
 *     pre-probe behaviour — a guard that cannot see must not invent work.
 * (a) SCREEN leg: the store holds a session newer than the newest session
 *     any run has screened. "Newest" means the MAX `sessionDate` across the
 *     lane's runs, never the newest `runAt`: a `screen:rescreen` row carries
 *     a fresh runAt and an old sessionDate, and must not make the lane read
 *     as behind on the sessions it just healed.
 * (b) VERDICT leg: the newest screen run has no COMPLETE chain-source
 *     deep-dive attached. Checking only (a) was the 2026-09-12 production
 *     miss: HK was "up to date" on the screen leg while the 09-10/09-11
 *     chain deep-dives had never run (machine off), and the guard skipped —
 *     leaving the verdict sample permanently behind until a manual run
 *     healed it. An ad-hoc deep-dive (`source: "adhoc"`) must NOT satisfy
 *     (b): provenance is the whole point (same policy as `ops/health.ts`).
 *
 * This is not the "self-heal job" R0 declined. That was rejected because the
 * failure it addressed was a stale *report*; this addresses a lost *sample*,
 * and the guard makes it a no-op on a healthy day.
 *
 * Exit codes: 0 = nothing to do · 10 = a lane needs a run (the caller's cue).
 *
 * Usage: pnpm -C apps/api ops:catchup [--json] [--lane hk|us]
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DataOutcome, sessionClosed, type Market } from "@agentic-trading/quant-core";
import { getMarketDataDeps } from "../market-data/market-data.deps.js";
import { deepDiveCovers } from "../ops/health.js";
import { MarketDataService } from "../market-data/market-data.service.js";
import { PrismaService } from "../prisma.service.js";
import { loadUniverse, type Lane } from "./daily-screen.js";

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
  /** Newest COMPLETED session per the provider probe (null when the probe
   *  was not run or failed entirely — the guard then decides from the store
   *  alone, exactly as before 2026-09-14). */
  expectedSession: string | null;
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

/** How many names of the lane's universe the probe fetches. Three is enough:
 *  the probe answers "has a NEWER session completed", and any liquid name
 *  answers it — on a holiday every name returns the previous trading day, so
 *  breadth adds nothing and costs Yahoo requests. */
export const PROBE_SYMBOLS = 3;

/** Answers, per market, the newest session date the provider reports as
 *  COMPLETE — null when the answer is unavailable. */
export type ExpectedSessionProbe = (market: Market) => Promise<string | null>;

/**
 * Builds the production probe (see the header's check (0)). For each of the
 * lane's first PROBE_SYMBOLS universe names: fetch daily bars, keep the dates
 * whose session has officially closed by `now` (the same sessionClosed the
 * store invariant uses, so "expected" can never name a still-forming bar),
 * and return the max. A per-symbol failure is skipped (another name can still
 * answer); only total failure — or an unreadable universe file — yields null,
 * which preserves the pre-2026-09-14 store-only behaviour exactly. Read-only:
 * getDailyBars classifies but never persists.
 */
export function makeExpectedSessionProbe(
  service: Pick<MarketDataService, "getDailyBars">,
  now: Date,
  dataDir: string = path.join(PKG_ROOT, "data"),
): ExpectedSessionProbe {
  return async (market) => {
    let symbols: string[];
    try {
      symbols = loadUniverse(dataDir, market.toLowerCase() as Lane)
        .slice(0, PROBE_SYMBOLS)
        .map((e) => e.symbol);
    } catch {
      return null;
    }
    let best: string | null = null;
    for (const symbol of symbols) {
      try {
        const result = await service.getDailyBars(symbol);
        if (result.outcome !== DataOutcome.OK) continue;
        for (const b of result.bars) {
          if (sessionClosed(market, b.date, now) && (best === null || b.date > best)) best = b.date;
        }
      } catch {
        continue; // one failed name must not blind the whole lane
      }
    }
    return best;
  };
}

/**
 * Pure decision. `sessionDate` is the newest session any run has screened;
 * an empty/unknown value means **run it**, because a duplicate costs a few
 * minutes while a lost observation is unrecoverable. `chainDeepDive` is whether
 * that newest screen run carries a complete chain-source deep-dive; the lane is
 * behind when EITHER leg is. `expectedSession` is the provider probe's answer
 * (check (0), 2026-09-14): when non-null and newer than `lastScreened`, a
 * completed session exists that no run has seen — this fires even when the
 * store is stale or empty, which the store legs below cannot see.
 */
export function decideLane(
  market: Market,
  latestBar: string | null,
  lastScreened: string | null,
  lastRunAt: string | null,
  chainDeepDive: boolean | null,
  expectedSession: string | null,
): CatchupLane {
  if (expectedSession && expectedSession > (lastScreened ?? "")) {
    return {
      market,
      latestBar,
      lastScreened,
      lastRunAt,
      expectedSession,
      needsRun: true,
      reason: `session ${expectedSession} complete but only screened through ${lastScreened ?? "nothing"} — catch-up chain will fetch and screen it (probe, not store)`,
    };
  }
  if (!latestBar) {
    return { market, latestBar, lastScreened, lastRunAt, expectedSession, needsRun: false, reason: "no stored bars — nothing to screen" };
  }
  if (!lastScreened) {
    return {
      market,
      latestBar,
      lastScreened,
      lastRunAt,
      expectedSession,
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
      expectedSession,
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
      expectedSession,
      needsRun: true,
      reason: `screen current through ${lastScreened} but no complete chain deep-dive that produced verdicts for that session (never ran, or every name failed) — DEEP-DIVE leg behind`,
    };
  }
  return {
    market,
    latestBar,
    lastScreened,
    lastRunAt,
    expectedSession,
    needsRun: false,
    reason: `up to date (screened and deep-dived through ${lastScreened}, store holds ${latestBar})`,
  };
}

export function renderCatchup(r: CatchupReport): string {
  const lines = [`== CATCHUP == ${r.asOf} · ${r.needsRun ? "A LANE NEEDS A RUN" : "nothing to do"}`];
  for (const l of r.lanes) {
    const probe = l.expectedSession ? ` · probe expects ${l.expectedSession}` : "";
    const lastRun = l.lastRunAt ? ` (last run ${l.lastRunAt})` : "";
    lines.push(`${l.market}: ${l.needsRun ? "RUN" : "skip"} — ${l.reason}${probe}${lastRun}`);
  }
  return lines.join("\n");
}

export async function runCatchup(
  prisma: PrismaService,
  markets: Market[],
  probe?: ExpectedSessionProbe,
): Promise<CatchupReport> {
  const lanes: CatchupLane[] = [];
  for (const market of markets) {
    // The probe goes first and is independent of the store reads: it asks the
    // provider which sessions are complete, so a never-fetched day (machine
    // off at every fetch slot) can no longer read as "up to date".
    const expectedSession = probe ? await probe(market) : null;
    const bar = await prisma.bar.findFirst({
      where: { instrument: { market } },
      orderBy: { date: "desc" },
      select: { date: true },
    });
    // The newest run *that records its session*, not merely the newest run: rows
    // written before the column carry '' and cannot answer the question. Order by
    // SESSION DATE, not runAt (2026-09-13): a rescreen row (screen:rescreen) has
    // a fresh runAt and an OLD sessionDate, and ordering by runAt would make the
    // lane read as behind on exactly the sessions the rescreen just healed.
    const run = await prisma.screenRun.findFirst({
      where: { market, sessionDate: { not: "" } },
      orderBy: [{ sessionDate: "desc" }, { runAt: "desc" }],
    });
    const newest = run ?? (await prisma.screenRun.findFirst({ where: { market }, orderBy: { runAt: "desc" } }));
    // Verdict leg: the newest screen run must carry a COMPLETE chain-source
    // deep-dive. An ad-hoc run does not count — the chain's verdicts are the
    // sample this guard protects.
    const chainDeepDive = run
      ? await prisma.deepDiveRun.findFirst({
          where: { screenRunId: run.id, status: "complete", source: "chain" },
          select: { id: true, topN: true, failed: true },
        })
      : null;
    // "Complete" is not the same as "produced verdicts": a run in which every
    // name failed reads as complete (2026-09-16, see deepDiveCovers). Such a run
    // leaves the lane behind, so the next slot retries the leg.
    const covered = chainDeepDive != null && deepDiveCovers(chainDeepDive.topN, chainDeepDive.failed);
    lanes.push(
      decideLane(
        market,
        bar?.date ?? null,
        run?.sessionDate || null,
        newest?.runAt ? newest.runAt.toISOString() : null,
        run ? covered : null,
        expectedSession,
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
    // Same provider wiring as screen:daily's main, minus the dummy store
    // guard: the probe only READS (getDailyBars never persists), and one
    // service is shared across lanes. `now` is captured once so the probe
    // and the run use a single definition of "session closed".
    const { provider } = getMarketDataDeps(process.env);
    const service = new MarketDataService({ provider, testMode: false, dummyMode: false });
    const probe = makeExpectedSessionProbe(service, new Date());
    report = await runCatchup(prisma, args.markets, probe);
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
