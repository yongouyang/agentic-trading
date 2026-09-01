/**
 * Daily screen CLI (phase-1-spec §5) — deterministic core end-to-end, no LLM.
 *
 *   pnpm -C apps/api screen:daily -- --market us|hk|all
 *
 * Plain script, NOT Nest: constructs PrismaService + the env-selected provider
 * (getMarketDataDeps — dummy under MARKET_DATA_TEST_MODE=1) + MarketDataService
 * directly. No scheduling in Phase 1.
 *
 * Stages per lane: universe load (Instrument upsert) → ingest via
 * MarketDataService (classify + L1 holiday-phantom drop + L2 OHLC clamp) →
 * bar/dividend upserts + CA_DEGRADED auto-detection → runChecks quality gate
 * → DataOutcome tallies → derive adjusted (R1/R2) → runScreen → persist
 * ScreenRun + ScreenResult → print report + write reports/<date>-<market>.json.
 *
 * Degraded rule: FETCH_FAILED count > 2% of the lane's universe size.
 *
 * HK rescue pass (phase-1-hardening-plan §A): HK tickers whose Yahoo outcome
 * ≠ OK (FETCH_FAILED and GENUINELY_ABSENT) are collected during the main loop
 * and repaired after the main pass via the RepairProvider (eastmoney — the
 * only raw-bar HK rescue source), max 5 calls per run. A rescued ticker's
 * ENTIRE stored series is replaced (whole-series rule, single-source
 * invariant) and Instrument.dataSource flips to "eastmoney"; any later
 * successful Yahoo fetch flips it back to "yahoo". Repaired tickers join
 * today's screen; the US lane is never repaired.
 *
 * Tests drive runDailyScreen() directly (dummy provider + throwaway SQLite);
 * the CLI wrapper below is only argument parsing and wiring.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  clampOhlc,
  DataOutcome,
  deriveAdjustedBars,
  runChecks,
  runScreen,
  type CorporateAction,
  type Market,
  type ScreenInput,
  type ScreenPick,
} from "@agentic-trading/quant-core";
import { getMarketDataDeps } from "../market-data/market-data.deps.js";
import { EastmoneyRepairProvider, type RepairProvider } from "../market-data/eastmoney-repair.provider.js";
import { MarketDataService } from "../market-data/market-data.service.js";
import type { MarketDataProvider } from "../market-data/market-data.types.js";
import { PrismaService } from "../prisma.service.js";

export interface UniverseEntry {
  symbol: string;
  name: string;
  currency: string;
  kind: "stock" | "etf";
}

export type Lane = "us" | "hk";

export interface DailyScreenDeps {
  prisma: PrismaService;
  provider: MarketDataProvider;
  /** Test override — skips reading the committed universe JSONs. */
  universes?: Partial<Record<Lane, UniverseEntry[]>>;
  /** Universe JSON directory (default: apps/api/data). */
  dataDir?: string;
  /** Report output directory (default: apps/api/reports). Null disables. */
  reportsDir?: string | null;
  /** Run date YYYY-MM-DD (default: today) — deterministic in tests. */
  today?: string;
  /** Report sink (default: console.log). */
  log?: (line: string) => void;
  /** HK rescue loader (phase-1-hardening-plan §A). Undefined ⇒ default:
   *  real EastmoneyRepairProvider, or disabled (null) under
   *  MARKET_DATA_TEST_MODE=1. Explicit null disables; inject a fake in tests. */
  repairProvider?: RepairProvider | null;
}

export interface DailyScreenOpts {
  market: Lane | "all";
}

export interface FetchFailure {
  symbol: string;
  reason: string;
}

export interface LaneReport {
  market: Market;
  date: string;
  universeSize: number;
  ok: number;
  genuinelyAbsent: number;
  fetchFailed: FetchFailure[];
  clampedBars: number;
  degraded: boolean;
  warnings: string[];
  shortlist: ScreenPick[];
  excludedCounts: Record<string, number>;
  /** HK rescue audit (phase-1-hardening-plan §A): tickers whose stored series
   *  was wholesale replaced from the rescue source this run. */
  rescued: { symbol: string; bars: number; source: string }[];
  text: string;
}

const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/** Ban protection (phase-1-hardening-plan §A.1): eastmoney hard-drops TCP
 *  after ~5 rapid requests ⇒ cap total repair calls per run. */
const MAX_REPAIR_CALLS_PER_RUN = 5;

function loadUniverse(dataDir: string, lane: Lane): UniverseEntry[] {
  const raw = JSON.parse(readFileSync(path.join(dataDir, `universe.${lane}.json`), "utf8"));
  return raw.symbols as UniverseEntry[];
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;

function renderText(r: LaneReport): string {
  const failedList = r.fetchFailed.map((f) => `${f.symbol}: ${f.reason}`).join(", ") || "—";
  const rescuedSegment = r.rescued.length
    ? ` · ${r.rescued.length} rescued via eastmoney (${r.rescued.map((x) => x.symbol).join(", ")})`
    : "";
  const lines = [
    `== DATA INTEGRITY ==  ${r.market} ${r.date}: ${r.ok}/${r.universeSize} screened · ` +
      `${r.fetchFailed.length} fetch-failed (${failedList}) · ${r.genuinelyAbsent} genuinely absent · ` +
      `${r.clampedBars} clamped bars${rescuedSegment} · DEGRADED: ${r.degraded ? "yes" : "no"}`,
    "== SHORTLIST ==",
    ...r.shortlist.map(
      (p) =>
        `${String(p.rank).padStart(2)}  ${p.symbol.padEnd(8)} score ${p.score.toFixed(2)}  ` +
        `mom60 ${pct(p.mom60)}  sharpe ${p.sharpe252.toFixed(2)}  vol ${(p.vol60 * 100).toFixed(0)}%` +
        (p.caDegraded ? "  ⚠CA" : ""),
    ),
  ];
  return lines.join("\n");
}

async function runLane(
  lane: Lane,
  deps: DailyScreenDeps,
  service: MarketDataService,
  today: string,
  repairProvider: RepairProvider | null,
): Promise<LaneReport> {
  const market = lane.toUpperCase() as Market;
  const { prisma } = deps;
  const entries = deps.universes?.[lane] ?? loadUniverse(deps.dataDir ?? path.join(PKG_ROOT, "data"), lane);

  const warnings: string[] = [];
  const fetchFailed: FetchFailure[] = [];
  let ok = 0;
  let genuinelyAbsent = 0;
  let clampedBars = 0;
  const inputs: ScreenInput[] = [];
  /** HK tickers needing the post-pass rescue (phase-1-hardening-plan §A.2). */
  const needsRepair: { symbol: string; instrumentId: number; outcome: DataOutcome }[] = [];

  for (const entry of entries) {
    const instrument = await prisma.instrument.upsert({
      where: { symbol: entry.symbol },
      create: { symbol: entry.symbol, market, currency: entry.currency, name: entry.name },
      update: { market, currency: entry.currency, name: entry.name },
    });

    const result = await service.getDailyBars(entry.symbol);

    if (result.outcome === DataOutcome.GENUINELY_ABSENT) {
      genuinelyAbsent++;
      if (lane === "hk") needsRepair.push({ symbol: entry.symbol, instrumentId: instrument.id, outcome: result.outcome });
      continue;
    }
    if (result.outcome === DataOutcome.FETCH_FAILED) {
      fetchFailed.push({ symbol: entry.symbol, reason: result.failureReason ?? "unknown" });
      if (lane === "hk") needsRepair.push({ symbol: entry.symbol, instrumentId: instrument.id, outcome: result.outcome });
      continue;
    }
    ok++;

    if (result.droppedPhantomBars.length) {
      warnings.push(`${entry.symbol}: L1 dropped holiday-phantom bars: ${result.droppedPhantomBars.join(",")}`);
    }
    if (result.repairedBars.length) {
      clampedBars += result.repairedBars.length;
      warnings.push(`${entry.symbol}: L2 clamped close into [H,L] on ${result.repairedBars.join(",")}`);
    }
    if (result.splitCount) {
      warnings.push(`${entry.symbol}: ${result.splitCount} split event(s) observed (audit only — never stored/applied, R1)`);
    }

    // Full-window rewrite (self-healing, phase-1-spec §2): replace bars,
    // upsert dividend events by (instrumentId, date, type). A successful
    // Yahoo fetch reclaims series ownership (single-source invariant, §A.2).
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
    if (instrument.dataSource !== "yahoo") {
      await prisma.instrument.update({ where: { id: instrument.id }, data: { dataSource: "yahoo" } });
      warnings.push(`${entry.symbol}: Yahoo fetch OK — dataSource flipped back to "yahoo" (was "${instrument.dataSource}")`);
    }
    for (const ca of result.corporateActions) {
      await prisma.corporateAction.upsert({
        where: { instrumentId_date_type: { instrumentId: instrument.id, date: ca.date, type: ca.type } },
        create: { instrumentId: instrument.id, date: ca.date, type: ca.type, amount: ca.amount, currency: ca.currency },
        update: { amount: ca.amount, currency: ca.currency },
      });
    }

    // CA_DEGRADED auto-detection (phase-1-spec §2, amended 2026-09-01):
    // HK name whose dividends look FX-converted (>4dp amounts or non-HKD
    // currency) — computed in MarketDataService.
    if (result.caDegraded && !instrument.caDegraded) {
      await prisma.instrument.update({ where: { id: instrument.id }, data: { caDegraded: true } });
      warnings.push(`${entry.symbol}: CA_DEGRADED — dividends look FX-converted (Yahoo USD-declaring HK payer bug)`);
    }

    // Day-17 quality gate — failures and warnings are both loud.
    const check = runChecks(market, result.bars, today);
    for (const f of check.failures) warnings.push(`${entry.symbol}: CHECK FAILURE: ${f}`);
    for (const w of check.warnings) warnings.push(`${entry.symbol}: ${w}`);

    const adjustedBars = deriveAdjustedBars(result.bars, result.corporateActions);
    inputs.push({ symbol: entry.symbol, market, adjustedBars, rawBars: result.bars, caDegraded: result.caDegraded });
  }

  // HK rescue pass (phase-1-hardening-plan §A.2) — after the main pass,
  // never inline; at most MAX_REPAIR_CALLS_PER_RUN eastmoney calls per run
  // (ban protection), in-list order; beyond-cap tickers keep their outcome.
  const rescued: LaneReport["rescued"] = [];
  if (repairProvider && needsRepair.length) {
    let calls = 0;
    for (const item of needsRepair) {
      if (calls >= MAX_REPAIR_CALLS_PER_RUN) break;
      calls++;
      const res = await repairProvider.fetchRawBars(item.symbol);
      if ("failure" in res) {
        warnings.push(`${item.symbol}: eastmoney rescue failed (${res.failure}) — keeps ${item.outcome}, retry next run`);
        continue;
      }

      // Quality gate on rescued bars, identical to the Yahoo path.
      const { bars, repaired } = clampOhlc(res.bars);
      if (repaired.length) {
        clampedBars += repaired.length;
        warnings.push(`${item.symbol}: L2 clamped close into [H,L] on rescued bars ${repaired.join(",")}`);
      }
      const check = runChecks(market, bars, today);
      for (const w of check.warnings) warnings.push(`${item.symbol}: ${w}`);

      // Whole-series rule (R3 made concrete): replace the ENTIRE stored
      // series from the rescue source; a ticker's series is single-source.
      await prisma.bar.deleteMany({ where: { instrumentId: item.instrumentId } });
      await prisma.bar.createMany({
        data: bars.map((b) => ({
          instrumentId: item.instrumentId,
          date: b.date,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          volume: b.volume,
        })),
      });
      await prisma.instrument.update({ where: { id: item.instrumentId }, data: { dataSource: "eastmoney" } });

      if (check.failures.length) {
        // Gate-failing rescue series is stored for inspection but excluded.
        warnings.push(`${item.symbol}: rescue gate failure — stored but excluded from screen: ${check.failures.join("; ")}`);
        continue;
      }

      // CA handling on rescue (§A.2): eastmoney supplies no usable CA events
      // — keep previously stored Yahoo dividends and continue deriving with
      // them; if none exist, CA_DEGRADED + loud warning.
      const storedCas = await prisma.corporateAction.findMany({ where: { instrumentId: item.instrumentId } });
      const dividends: CorporateAction[] = storedCas.map((ca) => ({
        date: ca.date,
        type: "DIVIDEND" as const,
        amount: ca.amount,
        currency: ca.currency,
      }));
      const instrument = (await prisma.instrument.findUniqueOrThrow({ where: { id: item.instrumentId } }))!;
      let caDegraded = instrument.caDegraded;
      if (dividends.length === 0 && !caDegraded) {
        caDegraded = true;
        await prisma.instrument.update({ where: { id: item.instrumentId }, data: { caDegraded: true } });
        warnings.push(`${item.symbol}: CA_DEGRADED — rescue-filled without CA history`);
      }

      // Rescued tickers join today's screen (that is the point); tallies
      // move from the failure bucket to screened.
      if (item.outcome === DataOutcome.FETCH_FAILED) {
        const i = fetchFailed.findIndex((f) => f.symbol === item.symbol);
        if (i >= 0) fetchFailed.splice(i, 1);
      } else {
        genuinelyAbsent--;
      }
      ok++;
      rescued.push({ symbol: item.symbol, bars: bars.length, source: "eastmoney" });
      inputs.push({
        symbol: item.symbol,
        market,
        adjustedBars: deriveAdjustedBars(bars, dividends),
        rawBars: bars,
        caDegraded,
      });
    }
  }

  // Deterministic screen (phase-1-spec §4) over this lane's eligible set.
  const screen = runScreen(inputs);
  const excludedCounts: Record<string, number> = {};
  for (const e of screen.excluded) excludedCounts[e.reason] = (excludedCounts[e.reason] ?? 0) + 1;

  const degraded = fetchFailed.length > 0.02 * entries.length;

  // Persist (phase-1-spec §5): one ScreenRun per lane + ScreenResult rows.
  const run = await prisma.screenRun.create({
    data: {
      market,
      universeSize: entries.length,
      ok,
      genuinelyAbsent,
      fetchFailed: fetchFailed.length,
      degraded,
      warningsJson: JSON.stringify(warnings),
    },
  });
  await prisma.screenResult.createMany({
    data: screen.ranked.map((p) => ({
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

  const report: LaneReport = {
    market,
    date: today,
    universeSize: entries.length,
    ok,
    genuinelyAbsent,
    fetchFailed,
    clampedBars,
    degraded,
    warnings,
    shortlist: screen.ranked,
    excludedCounts,
    rescued,
    text: "",
  };
  report.text = renderText(report);
  return report;
}

/** Full daily pipeline — the function tests call directly (no child
 *  processes). Returns one report per lane. */
export async function runDailyScreen(deps: DailyScreenDeps, opts: DailyScreenOpts): Promise<LaneReport[]> {
  const today = deps.today ?? new Date().toISOString().slice(0, 10);
  const log = deps.log ?? console.log;
  const service = new MarketDataService({ provider: deps.provider, testMode: false, dummyMode: false });
  // Fail-closed default: a real rescue loader only outside test mode; under
  // MARKET_DATA_TEST_MODE=1 rescue is disabled unless explicitly injected.
  const repairProvider =
    deps.repairProvider !== undefined
      ? deps.repairProvider
      : process.env.MARKET_DATA_TEST_MODE === "1"
        ? null
        : new EastmoneyRepairProvider();
  const lanes: Lane[] = opts.market === "all" ? ["us", "hk"] : [opts.market];

  const reports: LaneReport[] = [];
  for (const lane of lanes) {
    const report = await runLane(lane, deps, service, today, repairProvider);
    log(report.text);
    if (deps.reportsDir !== null) {
      const dir = deps.reportsDir ?? path.join(PKG_ROOT, "reports");
      mkdirSync(dir, { recursive: true });
      const { text: _text, ...json } = report;
      writeFileSync(path.join(dir, `${today}-${report.market}.json`), JSON.stringify(json, null, 2));
    }
    reports.push(report);
  }
  return reports;
}

// ---------------------------------------------------------------------------
// CLI wrapper (argument parsing + env wiring only).
// ---------------------------------------------------------------------------

function parseMarket(argv: string[]): Lane | "all" {
  const i = argv.indexOf("--market");
  const value = i >= 0 ? argv[i + 1] : "all";
  if (value !== "us" && value !== "hk" && value !== "all") {
    throw new Error(`--market must be us|hk|all (got "${value}")`);
  }
  return value;
}

async function main(): Promise<void> {
  const market = parseMarket(process.argv.slice(2));
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const { provider } = getMarketDataDeps(process.env);
    await runDailyScreen({ prisma, provider }, { market });
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
