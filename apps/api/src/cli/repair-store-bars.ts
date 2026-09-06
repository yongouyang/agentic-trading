/**
 * Single-symbol store repair CLI (PROGRESS 2026-09-05 R4 follow-up: MNST
 * phantom half-price bars). Re-fetches the full window through the normal
 * ingest path — YahooMarketDataProvider → MarketDataService (RULE L1/L2,
 * classification) — and rewrites the instrument's Bar rows exactly like
 * daily-screen's full-window rewrite (self-healing, phase-1-spec §2).
 *
 *   pnpm -C apps/api repair:store -- --symbol MNST
 *   pnpm -C apps/api repair:store -- --symbol 2800.HK --rescue 2025-10-24[,2026-03-06]
 *
 * `--rescue` switches to the session-rescue path (phase-1-hardening-plan §A):
 * individual sessions that Yahoo's feed drops (`YAHOO_KNOWN_GAPS`) are
 * upserted from eastmoney fqt=0 raw bars via EastmoneyRepairProvider, leaving
 * every other bar, the CA rows and Instrument.dataSource untouched (the
 * series stays Yahoo-owned). Mutually exclusive with the full-rewrite path.
 *
 * Fail-closed in both paths: the full rewrite aborts if the fresh fetch still
 * shows the pathology being repaired (an overnight close-to-open jump outside
 * [1/JUMP, JUMP] with no split event observed, or required dates still
 * absent); the rescue aborts all-or-nothing per symbol if the eastmoney fetch
 * fails, a requested date is missing/null in the eastmoney series, or a
 * candidate close breaks level against the store (>10% vs the nearest stored
 * prior close — the 3195.HK USD-stitching class is caught here instead of
 * being imported). Patching around a still-broken vendor feed is a caller
 * decision, not a default.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DataOutcome, type Bar } from "@agentic-trading/quant-core";
import { EastmoneyRepairProvider, type RepairProvider } from "../market-data/eastmoney-repair.provider.js";
import { MarketDataService } from "../market-data/market-data.service.js";
import { YahooMarketDataProvider } from "../market-data/yahoo-market-data.provider.js";
import { PrismaService } from "../prisma.service.js";

const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

export const JUMP_TOLERANCE = 1.8; // flag |close_{t-1} → open_t| outside [1/1.8, 1.8]

export interface RepairCheck {
  ok: boolean;
  problems: string[];
}

/** Pure sanity check on a freshly fetched series: every consecutive
 *  close→open jump must be within tolerance (a real split would have been
 *  observed by Yahoo and excluded by the caller's expectation), and all
 *  requiredDates must be present with a non-null close. */
export function checkFetchedSeries(
  bars: { date: string; open: number | null; close: number | null }[],
  opts: { requiredDates?: string[]; jumpTolerance?: number } = {},
): RepairCheck {
  const tol = opts.jumpTolerance ?? JUMP_TOLERANCE;
  const problems: string[] = [];
  const tradeable = bars.filter((b) => b.close != null && b.open != null);
  for (let i = 1; i < tradeable.length; i++) {
    const prev = tradeable[i - 1]!;
    const cur = tradeable[i]!;
    const jump = (cur.open as number) / (prev.close as number);
    if (jump > tol || jump < 1 / tol) {
      problems.push(`overnight jump ${prev.date} close ${prev.close} → ${cur.date} open ${cur.open} (${jump.toFixed(3)}×)`);
    }
  }
  for (const d of opts.requiredDates ?? []) {
    const bar = bars.find((b) => b.date === d);
    if (!bar || bar.close == null) problems.push(`required date ${d} missing or null-close in fresh fetch`);
  }
  return { ok: problems.length === 0, problems };
}

export interface RepairDeps {
  prisma: PrismaService;
  service: MarketDataService;
  now?: () => Date;
}

export interface RepairReport {
  symbol: string;
  outcome: DataOutcome;
  replacedBars: number;
  droppedPhantomBars: string[];
  repairedBars: string[];
  splitCount: number;
  problems: string[];
}

export async function repairSymbol(deps: RepairDeps, symbol: string, requiredDates: string[] = []): Promise<RepairReport> {
  const { prisma, service } = deps;
  const instrument = await prisma.instrument.findUnique({ where: { symbol } });
  if (!instrument) throw new Error(`no Instrument row for ${symbol}`);

  const result = await deps.service.getDailyBars(symbol);
  if (result.outcome !== DataOutcome.OK) {
    throw new Error(`fetch for ${symbol} not OK: ${result.outcome} (${result.failureReason ?? "no reason"})`);
  }

  const check = checkFetchedSeries(result.bars, { requiredDates });
  if (!check.ok) {
    // Fail-closed: vendor is still serving the pathology — do NOT rewrite.
    return {
      symbol,
      outcome: result.outcome,
      replacedBars: 0,
      droppedPhantomBars: result.droppedPhantomBars,
      repairedBars: result.repairedBars,
      splitCount: result.splitCount,
      problems: check.problems,
    };
  }

  // Full-window rewrite, identical to daily-screen.ts (single-source
  // invariant: a successful Yahoo fetch reclaims series ownership).
  await prisma.bar.deleteMany({ where: { instrumentId: instrument.id } });
  await prisma.bar.createMany({
    data: result.bars.map((b) => ({
      instrumentId: instrument.id,
      date: b.date,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    })),
  });
  for (const ca of result.corporateActions) {
    await prisma.corporateAction.upsert({
      where: { instrumentId_date_type: { instrumentId: instrument.id, date: ca.date, type: ca.type } },
      create: { instrumentId: instrument.id, date: ca.date, type: ca.type, amount: ca.amount, currency: ca.currency },
      update: { amount: ca.amount, currency: ca.currency },
    });
  }

  return {
    symbol,
    outcome: result.outcome,
    replacedBars: result.bars.length,
    droppedPhantomBars: result.droppedPhantomBars,
    repairedBars: result.repairedBars,
    splitCount: result.splitCount,
    problems: [],
  };
}

/** Level-consistency gate for rescued bars: a candidate eastmoney close may
 *  deviate at most this much from the store's nearest prior close. Catches a
 *  currency-stitching-class feed break (the 3195.HK lesson) before import. */
export const RESCUE_LEVEL_TOLERANCE = 0.1;

export interface RescueDeps {
  prisma: PrismaService;
  repairProvider: RepairProvider;
}

export interface RescueReport {
  symbol: string;
  rescued: string[];
  problems: string[];
}

/** Session rescue (phase-1-hardening-plan §A): upsert individual sessions
 *  from eastmoney fqt=0 raw bars into a Yahoo-owned series. Fail-closed,
 *  all-or-nothing per symbol: ANY problem (fetch failure, a requested date
 *  missing/null in the eastmoney series, a level break vs the store) ⇒ zero
 *  writes. On success ONLY the requested dates are upserted — no other bars,
 *  no CA rows (the rescue source has none), no Instrument.dataSource change. */
export async function rescueSessions(deps: RescueDeps, symbol: string, dates: string[]): Promise<RescueReport> {
  const { prisma, repairProvider } = deps;
  const report: RescueReport = { symbol, rescued: [], problems: [] };
  const instrument = await prisma.instrument.findUnique({ where: { symbol } });
  if (!instrument) throw new Error(`no Instrument row for ${symbol}`);

  const res = await repairProvider.fetchRawBars(symbol);
  if ("failure" in res) {
    report.problems.push(`eastmoney fetch failed: ${res.failure}`);
    return report;
  }

  const byDate = new Map(res.bars.map((b) => [b.date, b]));
  const candidates: Bar[] = [];
  for (const d of dates) {
    const b = byDate.get(d);
    if (!b || b.open == null || b.high == null || b.low == null || b.close == null) {
      report.problems.push(`requested date ${d} missing or null-OHLC in eastmoney series`);
    } else {
      candidates.push(b);
    }
  }

  // Level-consistency gate: each candidate close vs the stored series'
  // nearest prior close. Loud cross-source discipline — a >10% break means
  // the eastmoney series is denominated/stitched differently from the store.
  for (const b of candidates) {
    const prior = await prisma.bar.findFirst({
      where: { instrumentId: instrument.id, date: { lt: b.date } },
      orderBy: { date: "desc" },
    });
    if (!prior || prior.close == null || prior.close <= 0) {
      report.problems.push(`level break vs store: no usable stored close before ${b.date} to gate against`);
      continue;
    }
    const ratio = (b.close as number) / prior.close;
    if (Math.abs(ratio - 1) > RESCUE_LEVEL_TOLERANCE) {
      report.problems.push(
        `level break vs store: ${b.date} eastmoney close ${b.close} vs stored ${prior.date} close ${prior.close} (${((ratio - 1) * 100).toFixed(2)}%)`,
      );
    }
  }
  if (report.problems.length) return report; // all-or-nothing: zero writes

  for (const b of candidates) {
    await prisma.bar.upsert({
      where: { instrumentId_date: { instrumentId: instrument.id, date: b.date } },
      create: { instrumentId: instrument.id, date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume },
      update: { open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume },
    });
    report.rescued.push(b.date);
  }
  return report;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const symbol = args[args.indexOf("--symbol") + 1];
  if (!symbol) throw new Error("usage: tsx src/cli/repair-store-bars.ts --symbol MNST [--require 2026-08-10,...] | --symbol 2800.HK --rescue 2025-10-24,...");

  const prisma = new PrismaService();
  try {
    const rescueIdx = args.indexOf("--rescue");
    if (rescueIdx >= 0) {
      // Session-rescue path (§A): eastmoney raw bars, mutually exclusive with
      // the default Yahoo full-rewrite below.
      const rescueDates = (args[rescueIdx + 1] ?? "").split(",").filter(Boolean);
      if (!rescueDates.length) throw new Error("--rescue needs at least one date (e.g. --rescue 2025-10-24,2026-03-06)");
      const report = await rescueSessions({ prisma, repairProvider: new EastmoneyRepairProvider() }, symbol, rescueDates);
      console.log(JSON.stringify(report, null, 2));
      if (report.problems.length) {
        console.error(`RESCUE ABORTED — problems found; store untouched.`);
        process.exitCode = 1;
      }
      return;
    }
    const reqIdx = args.indexOf("--require");
    const requiredDates = reqIdx >= 0 ? (args[reqIdx + 1] ?? "").split(",").filter(Boolean) : [];
    const service = new MarketDataService({ provider: new YahooMarketDataProvider(), testMode: false, dummyMode: false });
    const report = await repairSymbol({ prisma, service }, symbol, requiredDates);
    console.log(JSON.stringify(report, null, 2));
    if (report.problems.length) {
      console.error(`REPAIR ABORTED — fresh fetch still fails sanity checks; store untouched.`);
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
