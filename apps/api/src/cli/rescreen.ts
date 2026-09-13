/**
 * `screen:rescreen` — point-in-time re-screen of sessions missed during a
 * multi-day outage (2026-09-13; architecture §5.1 recovery semantics).
 *
 * Why this exists: the guarded evening catch-up (`ops:catchup`) heals only the
 * NEWEST missed session — it fires when the store's max date is ahead of the
 * newest screened session, then `daily-chain` screens one session. After a
 * multi-day gap (travel, machine off) the middle sessions stay holes forever.
 * Bars self-heal (every run refetches 5y and upserts); verdicts for lag > 1
 * are unrecoverable BY DESIGN (the promptness gate excludes them — never run a
 * deep-dive for an old session). But a screen observation is a deterministic
 * function of data dated ≤ T, so it IS recoverable: this CLI recomputes it
 * from the store exactly as production would have seen it at T.
 *
 * Per target date T:
 *   1. Refuse (loudly, exit 1) when T < PROSPECTIVE_FROM (spent window — no
 *      prospective value), T is not yet a completed session (sessionClose),
 *      the store holds no lane bars dated T, or a ScreenRun already covers T
 *      for the lane (dedup by sessionDate — the same key phase4c:accrual uses).
 *   2. Load the lane's instruments, bars dated ≤ T, dividends with ex-date ≤ T,
 *      and slice through quant-core's `replayScreen` (trailing 252-bar window
 *      + the dividend window-start optimisation — the exact production cut,
 *      proven by the replay equivalence tests, not re-derived here).
 *      `replayScreen` lifts topN, so `SCREEN_PARAMS.topN[market]` is re-applied
 *      when persisting picks, keeping rows identical in shape to production's.
 *   3. Persist a ScreenRun (sessionDate = T, source = "rescreen") + the top-N
 *      ScreenResult rows. Integrity counters (ok / fetchFailed / genuinelyAbsent
 *      / degraded) are unknowable for a historical session — the fetch outcomes
 *      of that evening are gone — so ok = universeSize and the rest are
 *      0/false, with a note in warningsJson saying exactly that.
 *
 * Usage:
 *   pnpm -C apps/api screen:rescreen -- --market us|hk --date YYYY-MM-DD
 *   pnpm -C apps/api screen:rescreen -- --market us|hk --holes
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  SCREEN_PARAMS,
  replayScreen,
  sessionClosed,
  type Bar,
  type CorporateAction,
  type Market,
  type SymbolSeries,
} from "@agentic-trading/quant-core";
import { PrismaService } from "../prisma.service.js";
import { PROSPECTIVE_FROM } from "./accrual.js";

export interface RescreenArgs {
  market: "us" | "hk";
  date: string | null;
  holes: boolean;
}

export function parseRescreenArgs(argv: string[]): RescreenArgs {
  let market: "us" | "hk" | null = null;
  let date: string | null = null;
  let holes = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue; // pnpm passes a bare --
    if (arg === "--market") {
      const v = argv[++i];
      if (v !== "us" && v !== "hk") throw new Error(`--market must be us|hk, got "${v ?? ""}"`);
      market = v;
      continue;
    }
    if (arg === "--date") {
      const v = argv[++i];
      if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`--date must be YYYY-MM-DD, got "${v ?? ""}"`);
      date = v;
      continue;
    }
    if (arg === "--holes") {
      holes = true;
      continue;
    }
    throw new Error(`unknown argument "${arg}" (expected --market us|hk plus --date YYYY-MM-DD or --holes)`);
  }
  if (!market) throw new Error("--market us|hk is required");
  if (holes && date) throw new Error("--date and --holes are mutually exclusive");
  if (!holes && !date) throw new Error("one of --date YYYY-MM-DD or --holes is required");
  return { market, date, holes };
}

/** Distinct store bar dates for the lane, ascending (same read accrual does). */
async function laneSessionDates(prisma: PrismaService, market: Market): Promise<string[]> {
  const rows = (await prisma.bar.findMany({
    where: { instrument: { market } },
    distinct: ["date"],
    orderBy: { date: "asc" },
    select: { date: true },
  })) as { date: string }[];
  return rows.map((r) => r.date);
}

/**
 * Rescreenable holes: completed store sessions in the prospective window with
 * NO ScreenRun covering that sessionDate for the lane. This intentionally
 * includes the newest unscreened session — tonight's catch-up would screen it
 * too, and accrual dedups by sessionDate, so healing it early is safe.
 */
export async function enumerateHoles(prisma: PrismaService, market: Market, now: Date = new Date()): Promise<string[]> {
  const [dates, runs] = await Promise.all([
    laneSessionDates(prisma, market),
    prisma.screenRun.findMany({ where: { market, sessionDate: { not: "" } }, select: { sessionDate: true } }),
  ]);
  const screened = new Set(runs.map((r) => r.sessionDate));
  return dates.filter((d) => d >= PROSPECTIVE_FROM && sessionClosed(market, d, now) && !screened.has(d));
}

export interface RescreenedSession {
  date: string;
  runId: number;
  /** ScreenResult rows written (topN-truncated, production shape). */
  persisted: number;
  /** First-failure census total (excludedJson). */
  excludedTotal: number;
}

interface RawRow {
  instrumentId: number;
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

function groupBy<T extends { instrumentId: number }>(rows: T[]): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const r of rows) {
    const list = out.get(r.instrumentId);
    if (list) list.push(r);
    else out.set(r.instrumentId, [r]);
  }
  return out;
}

/**
 * Recompute the screen for one historical session T and persist it.
 * Throws with a clear reason on every refusal case — a refused rescreen writes
 * nothing.
 */
export async function rescreenSession(
  prisma: PrismaService,
  market: Market,
  date: string,
  now: Date = new Date(),
): Promise<RescreenedSession> {
  if (date < PROSPECTIVE_FROM) {
    throw new Error(
      `refusing to rescreen ${market} ${date}: before PROSPECTIVE_FROM (${PROSPECTIVE_FROM}) — the window is spent, a rescreened row has no prospective value`,
    );
  }
  if (!sessionClosed(market, date, now)) {
    throw new Error(`refusing to rescreen ${market} ${date}: session not yet completed — the daily chain will screen it once it closes`);
  }

  const instruments = await prisma.instrument.findMany({ where: { market }, orderBy: { symbol: "asc" } });
  const ids = instruments.map((i) => i.id);

  const onDate = await prisma.bar.findFirst({ where: { instrumentId: { in: ids }, date }, select: { instrumentId: true } });
  if (!onDate) {
    throw new Error(`refusing to rescreen ${market} ${date}: no bars in the store for that session`);
  }
  const dup = await prisma.screenRun.findFirst({ where: { market, sessionDate: date }, select: { id: true, source: true } });
  if (dup) {
    throw new Error(
      `refusing to rescreen ${market} ${date}: ScreenRun ${dup.id} (source=${dup.source}) already covers this session — dedup is by sessionDate, the same rule phase4c:accrual counts with`,
    );
  }

  // PIT cut: only bars dated <= T and dividends with ex-date <= T exist as far
  // as this run is concerned. The trailing-window slice itself is delegated to
  // replayScreen (bars truncation + dividend window-start optimisation) so the
  // CLI can never drift from the proven replay invariants.
  const bars = (await prisma.bar.findMany({
    where: { instrumentId: { in: ids }, date: { lte: date } },
    orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
    select: { instrumentId: true, date: true, open: true, high: true, low: true, close: true, volume: true },
  })) as RawRow[];
  // R1: splits are never applied locally, so only dividends are relevant.
  const divs = (await prisma.corporateAction.findMany({
    where: { instrumentId: { in: ids }, type: "DIVIDEND", date: { lte: date } },
    orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
    select: { instrumentId: true, date: true, type: true, amount: true, currency: true },
  })) as (CorporateAction & { instrumentId: number })[];

  const barsById = groupBy(bars);
  const divsById = groupBy(divs);
  const series: SymbolSeries[] = [];
  for (const inst of instruments) {
    const rows = barsById.get(inst.id);
    if (!rows || rows.length === 0) continue; // no history at T — invisible then too
    series.push({
      symbol: inst.symbol,
      market,
      caDegraded: Boolean(inst.caDegraded),
      bars: rows.map((r) => ({ date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume })) as Bar[],
      dividends: (divsById.get(inst.id) ?? []).map((d) => ({
        date: d.date,
        type: "DIVIDEND" as const,
        amount: d.amount,
        currency: d.currency,
      })),
    });
  }

  const day = replayScreen([date], series)[0]!;
  const census = day.excludedByReason[market] ?? {};
  const excludedTotal = Object.values(census).reduce((a, b) => a + b, 0);
  // replayScreen lifts topN (the IC gate needs the full eligible set); the
  // production breadth is re-applied here so persisted rows match the shape
  // screen:daily writes.
  const picks = day.ranked.filter((p) => p.market === market).slice(0, SCREEN_PARAMS.topN[market]);

  // Integrity counters are unknowable for a historical session (the fetch
  // outcomes of that evening are gone) — record the honest values and say so.
  const warnings = [
    `rescreened at ${now.toISOString()}: integrity counters unknowable for a historical session; screen PIT-recomputed from stored bars`,
  ];
  const run = await prisma.screenRun.create({
    data: {
      market,
      universeSize: instruments.length,
      ok: instruments.length,
      genuinelyAbsent: 0,
      fetchFailed: 0,
      degraded: false,
      warningsJson: JSON.stringify(warnings),
      excludedJson: JSON.stringify(census),
      sessionDate: date,
      source: "rescreen",
    },
  });
  await prisma.screenResult.createMany({
    data: picks.map((p) => ({
      runId: run.id,
      symbol: p.symbol,
      rank: p.rank,
      score: p.score,
      metricsJson: JSON.stringify({
        close: p.close,
        sma50: p.sma50,
        sma200: p.sma200,
        mom20: p.mom20,
        mom60: p.mom60,
        vol60: p.vol60,
        sharpe252: p.sharpe252,
        adv20: p.adv20,
        mdd252: p.mdd252,
        caDegraded: p.caDegraded,
      }),
    })),
  });
  return { date, runId: run.id, persisted: picks.length, excludedTotal };
}

// ---------------------------------------------------------------------------
// CLI wrapper (argument parsing + wiring only).
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseRescreenArgs(process.argv.slice(2));
  const market = args.market.toUpperCase() as Market;
  const prisma = new PrismaService();
  await prisma.$connect();
  const now = new Date();
  try {
    const dates = args.holes ? await enumerateHoles(prisma, market, now) : [args.date!];
    if (args.holes && dates.length === 0) {
      console.log(`${market}: no holes — every completed store session >= ${PROSPECTIVE_FROM} has a ScreenRun`);
      return;
    }
    let failures = 0;
    for (const date of dates) {
      try {
        const r = await rescreenSession(prisma, market, date, now);
        console.log(
          `${market} ${r.date}: ScreenRun ${r.runId} (source=rescreen) · ${r.persisted} ranked persisted · ${r.excludedTotal} excluded (first-failure census)`,
        );
      } catch (err) {
        failures++;
        console.error(`${market} ${date}: ${(err as Error)?.message ?? err}`);
      }
    }
    if (failures) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

const invokedAsScript = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (invokedAsScript) {
  main().catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
  });
}
