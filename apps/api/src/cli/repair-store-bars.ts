/**
 * Single-symbol store repair CLI (PROGRESS 2026-09-05 R4 follow-up: MNST
 * phantom half-price bars). Re-fetches the full window through the normal
 * ingest path — YahooMarketDataProvider → MarketDataService (RULE L1/L2,
 * classification) — and rewrites the instrument's Bar rows exactly like
 * daily-screen's full-window rewrite (self-healing, phase-1-spec §2).
 *
 *   pnpm -C apps/api repair:store -- --symbol MNST
 *
 * Fail-closed: if the fresh fetch itself still shows the pathology being
 * repaired (an overnight close-to-open jump outside [1/JUMP, JUMP] with no
 * split event observed, or required dates still absent), the script aborts
 * WITHOUT touching the store — patching around a still-broken vendor feed
 * is a caller decision, not a default.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DataOutcome } from "@agentic-trading/quant-core";
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const symbol = args[args.indexOf("--symbol") + 1];
  if (!symbol) throw new Error("usage: tsx src/cli/repair-store-bars.ts --symbol MNST [--require 2026-08-10,...]");
  const reqIdx = args.indexOf("--require");
  const requiredDates = reqIdx >= 0 ? (args[reqIdx + 1] ?? "").split(",").filter(Boolean) : [];

  const prisma = new PrismaService();
  const service = new MarketDataService({ provider: new YahooMarketDataProvider(), testMode: false, dummyMode: false });
  try {
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
