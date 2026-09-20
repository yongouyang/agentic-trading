/**
 * `backtest:fundamental` — Phase 7 P4 runner (docs/phase-7-plan.md §4–§5).
 *
 * The declared family: {US, HK} × {G1, G2} = 4 variants, FDR q = 0.05 across
 * the four primary-horizon IC p-values. Per variant:
 *   - IC path (deciding): mean 20d rank IC of the blended score over the
 *     gate-passing U1 cross-section, NW t at lag 20; 5d/60d reported only.
 *   - Portfolio path (falsification-only): gated top-20 quarterly compounder
 *     vs the ungated composite portfolio and the equal-weight universe —
 *     daily return differentials with NW t.
 *   - Sector subgroups (E3's frozen list): exploratory labels, never verdicts.
 *
 * Manual, in-session CLI. Writes reports/backtest/fundamental-<date>.{json,txt}
 * and touches nothing the nightly chain reads.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  benjaminiHochberg,
  eligibleUnder,
  forwardFromPanel,
  gateG1,
  gateG2,
  icSeries,
  icStats,
  neweyWestT,
  portfolioMetrics,
  simulateQuarterlyCompounder,
  twoSidedP,
  type ForwardSeries,
  type ScoredDay,
} from "@agentic-trading/quant-core";
import { PrismaService } from "../prisma.service.js";
import { loadPanel } from "../backtest/panel-read.js";
import { buildScorePanel, type FundamentalRow } from "../backtest/fundamental-scores.js";
import { PANEL_ROOT } from "./panel-export.js";

const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const OUT_DIR = path.join(PKG_ROOT, "reports", "backtest");

// ---------------------------------------------------------------------------
// pre-registered constants (phase-7-plan §4–§5) — decisions, not defaults
// ---------------------------------------------------------------------------

export const PRIMARY_HORIZON = 20;
export const REPORTED_HORIZONS = [5, 60] as const;
export const FDR_Q = 0.05;
export const TOP_N = 20;
export const BUFFER_RANK = 40;
export const COST_RATE: Record<"US" | "HK", number> = { US: 5 / 10_000, HK: 23 / 10_000 };
/** First re-rank waits for ≥ this many scored names (the buffer's breadth). */
export const MIN_SCORED_BREADTH = 40;
/** Power floors (plan amendment P5, 2026-09-20): 2 × the lane's worst measured
 *  primary-horizon NW SE from the build-time run — US 2×0.01124, HK 2×0.02763.
 *  Below these the window cannot detect the effect; `dead` means uninformative. */
export const POWER_FLOOR: Record<"US" | "HK", number> = { US: 0.0225, HK: 0.0553 };

// ---------------------------------------------------------------------------
// gate matrices
// ---------------------------------------------------------------------------

/** Per-day gate state per symbol. G1 re-evaluates only on week-ending sessions
 *  (signal is defined on weekly closes); G2 nightly. Fails closed. */
export function buildGateMatrix(
  gate: "G1" | "G2",
  dates: string[],
  symbols: string[],
  close: (number | null)[][],
): (boolean | null)[][] {
  // per-symbol cleaned close series + per-date cursor
  const series = symbols.map((_, s) => {
    const pts: { date: string; close: number }[] = [];
    for (let d = 0; d < dates.length; d++) {
      const v = close[d]?.[s];
      if (v != null && v > 0) pts.push({ date: dates[d]!, close: v });
    }
    return pts;
  });
  const isoWeek = (date: string) => {
    const d = new Date(`${date}T00:00:00Z`);
    const day = (d.getUTCDay() + 6) % 7; // Mon=0
    const thursday = new Date(d.getTime() + (3 - day) * 86_400_000);
    const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
    const fd = (firstThursday.getUTCDay() + 6) % 7;
    firstThursday.setUTCDate(firstThursday.getUTCDate() + (3 - fd));
    return `${thursday.getUTCFullYear()}-W${Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86_400_000)) + 1}`;
  };

  const out: (boolean | null)[][] = [];
  const cursor = new Array<number>(symbols.length).fill(0);
  const state = new Array<boolean | null>(symbols.length).fill(null);
  // growing per-symbol close history — no per-day re-slicing
  const history = symbols.map(() => [] as number[]);
  for (let d = 0; d < dates.length; d++) {
    const isWeekEnd = d === dates.length - 1 || isoWeek(dates[d]!) !== isoWeek(dates[d + 1]!);
    const row = new Array<boolean | null>(symbols.length);
    for (let s = 0; s < symbols.length; s++) {
      const pts = series[s]!;
      const hist = history[s]!;
      while (cursor[s]! < pts.length && pts[cursor[s]!]!.date <= dates[d]!) {
        hist.push(pts[cursor[s]!]!.close);
        cursor[s]!++;
      }
      const evaluate = gate === "G2" || isWeekEnd;
      if (evaluate && hist.length) {
        state[s] = gate === "G1" ? gateG1(hist).pass : gateG2(hist).pass;
      }
      row[s] = state[s] ?? null;
    }
    out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { markets: ("US" | "HK")[] } {
  let market = "all";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    if (a === "--market") market = (argv[++i] ?? "").toLowerCase();
    else throw new Error(`unknown argument "${a}"`);
  }
  if (!["us", "hk", "all"].includes(market)) throw new Error(`--market must be us|hk|all`);
  return { markets: market === "all" ? ["US", "HK"] : [market.toUpperCase() as "US" | "HK"] };
}

interface VariantResult {
  market: "US" | "HK";
  gate: "G1" | "G2";
  ic: { horizon: number; meanIc: number; nwT: number; nwSe: number; days: number; meanBreadth: number; p: number | null }[];
  portfolio: {
    gated: { totalReturn: number; annualizedReturn: number; maxDrawdown: number; trades: number };
    ungated: { totalReturn: number; annualizedReturn: number; maxDrawdown: number; trades: number };
    diffVsUngated: { meanDailyBps: number; nwT: number } | null;
    diffVsBenchmark: { meanDailyBps: number; nwT: number } | null;
  };
  subgroups: { sector: string; names: number; meanIc20: number | null; days: number }[];
}

async function runMarket(prisma: PrismaService, market: "US" | "HK"): Promise<VariantResult[]> {
  const panel = loadPanel(PANEL_ROOT, market);
  const { dates, symbols } = panel.close;
  console.log(`\n== ${market} == panel ${dates[0]}…${dates[dates.length - 1]} (${dates.length} sessions × ${symbols.length} symbols)`);

  const rows = await prisma.fundamentalPoint.findMany({
    where: { market },
    select: { symbol: true, metric: true, periodEnd: true, periodType: true, filedAt: true, value: true },
  });
  const pointsBySymbol = new Map<string, FundamentalRow[]>();
  for (const r of rows) {
    if (!pointsBySymbol.has(r.symbol)) pointsBySymbol.set(r.symbol, []);
    pointsBySymbol.get(r.symbol)!.push(r);
  }
  const instruments = await prisma.instrument.findMany({ where: { market }, select: { symbol: true, sector: true } });
  const sectorOf = new Map(instruments.map((i) => [i.symbol, i.sector ?? "Other"]));

  const scores = buildScorePanel(market, dates, symbols, panel.close.values, pointsBySymbol);
  const scoredBreadth = scores.score.map((row) => row.filter((v) => v != null).length);
  const startIdx = scoredBreadth.findIndex((b) => b >= MIN_SCORED_BREADTH);
  if (startIdx < 0) throw new Error(`${market}: never reach ${MIN_SCORED_BREADTH} scored names — check fundamentals coverage`);
  console.log(`score panel: first ≥${MIN_SCORED_BREADTH}-breadth session ${dates[startIdx]} (idx ${startIdx})`);

  const forward = forwardFromPanel({ dates, symbols, values: panel.close.values });
  const gateMatrices = {
    G1: buildGateMatrix("G1", dates, symbols, panel.close.values),
    G2: buildGateMatrix("G2", dates, symbols, panel.close.values),
  };

  // equal-weight universe benchmark: mean daily return of mask-eligible names
  const benchReturns: number[] = dates.map((_, d) => {
    if (d === 0) return 0;
    let sum = 0;
    let n = 0;
    for (let s = 0; s < symbols.length; s++) {
      if (!eligibleUnder(panel.mask.values[d]?.[s] ?? null, "U1")) continue;
      const a = panel.close.values[d - 1]?.[s];
      const b = panel.close.values[d]?.[s];
      if (a != null && b != null && a > 0) {
        sum += b / a - 1;
        n++;
      }
    }
    return n ? sum / n : 0;
  });

  const results: VariantResult[] = [];
  for (const gate of ["G1", "G2"] as const) {
    const gatePass = gateMatrices[gate];

    // --- IC path: score over the gate-passing U1 cross-section
    const days: ScoredDay[] = [];
    for (let d = startIdx; d < dates.length; d++) {
      const ranked: { symbol: string; score: number; rank: number }[] = [];
      for (let s = 0; s < symbols.length; s++) {
        if (!eligibleUnder(panel.mask.values[d]?.[s] ?? null, "U1")) continue;
        if (gatePass[d]?.[s] !== true) continue;
        const sc = scores.score[d]![s];
        if (sc == null) continue;
        ranked.push({ symbol: symbols[s]!, score: sc, rank: 0 });
      }
      if (ranked.length < 5) continue;
      ranked.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
      ranked.forEach((r, i) => (r.rank = i + 1));
      days.push({ date: dates[d]!, ranked });
    }
    const ic = [PRIMARY_HORIZON, ...REPORTED_HORIZONS].map((h) => {
      const stats = icStats(icSeries(days, forward, h), h);
      return {
        horizon: h,
        meanIc: stats?.mean ?? NaN,
        nwT: stats?.nwT ?? NaN,
        nwSe: stats?.nwSe ?? NaN,
        days: stats?.days ?? 0,
        meanBreadth: stats?.meanBreadth ?? 0,
        p: stats ? twoSidedP(stats.nwT) : null,
      };
    });

    // --- portfolio path
    const simInput = {
      dates,
      symbols,
      close: panel.close.values,
      score: scores.score,
      ep: scores.ep,
      gatePass,
      topN: TOP_N,
      bufferRank: BUFFER_RANK,
      costRate: COST_RATE[market],
      startIdx,
    };
    const gatedSim = simulateQuarterlyCompounder({ ...simInput, gated: true });
    const ungatedSim = simulateQuarterlyCompounder({ ...simInput, gated: false });
    const mG = portfolioMetrics(gatedSim.equity, gatedSim.dailyReturns, [], 0);
    const mU = portfolioMetrics(ungatedSim.equity, ungatedSim.dailyReturns, [], 0);
    const diffStats = (a: number[], b: number[]) => {
      const diffs = a.map((r, i) => r - (b[i] ?? 0)).slice(Math.max(1, startIdx));
      const nw = neweyWestT(diffs, PRIMARY_HORIZON);
      return nw ? { meanDailyBps: nw.mean * 10_000, nwT: nw.t } : null;
    };

    // --- subgroups: composite 20d IC within each frozen sector (exploratory)
    const subgroups: VariantResult["subgroups"] = [];
    const sectors = [...new Set(symbols.map((s) => sectorOf.get(s) ?? "Other"))].sort();
    for (const sector of sectors) {
      if (sector === "Other") continue;
      const sectorDays: ScoredDay[] = [];
      for (const day of days) {
        const ranked = day.ranked.filter((r) => sectorOf.get(r.symbol) === sector);
        if (ranked.length < 5) continue;
        ranked.forEach((r, i) => (r.rank = i + 1));
        sectorDays.push({ date: day.date, ranked });
      }
      const names = symbols.filter((s) => sectorOf.get(s) === sector).length;
      const stats = icStats(icSeries(sectorDays, forward, PRIMARY_HORIZON), PRIMARY_HORIZON);
      subgroups.push({ sector, names, meanIc20: stats?.mean ?? null, days: stats?.days ?? 0 });
    }

    results.push({
      market,
      gate,
      ic,
      portfolio: {
        gated: { totalReturn: mG.totalReturn, annualizedReturn: mG.annualizedReturn, maxDrawdown: mG.maxDrawdown, trades: gatedSim.trades.length },
        ungated: { totalReturn: mU.totalReturn, annualizedReturn: mU.annualizedReturn, maxDrawdown: mU.maxDrawdown, trades: ungatedSim.trades.length },
        diffVsUngated: diffStats(gatedSim.dailyReturns, ungatedSim.dailyReturns),
        diffVsBenchmark: diffStats(gatedSim.dailyReturns, benchReturns),
      },
      subgroups,
    });
    const primary = ic[0]!;
    console.log(
      `${market}/${gate}: IC20 ${primary.meanIc.toFixed(4)} (NW t ${primary.nwT.toFixed(2)}, ${primary.days}d, breadth ${primary.meanBreadth.toFixed(0)}) · ` +
        `gated TR ${(mG.totalReturn * 100).toFixed(1)}% vs ungated ${(mU.totalReturn * 100).toFixed(1)}%`,
    );
  }
  return results;
}

async function main(): Promise<void> {
  const { markets } = parseArgs(process.argv.slice(2));
  const prisma = new PrismaService();
  await prisma.$connect();
  const all: VariantResult[] = [];
  try {
    for (const market of markets) all.push(...(await runMarket(prisma, market)));
  } finally {
    await prisma.$disconnect();
  }

  // FDR across the declared family — the four primary-horizon p-values
  const bh = benjaminiHochberg(all.map((v) => v.ic[0]!.p), FDR_Q);
  const labelled = all.map((v, i) => {
    const meanIc = v.ic[0]!.meanIc;
    const floor = POWER_FLOOR[v.market];
    const reject = bh.rejected[i] === true;
    const label = !reject || Math.abs(meanIc) < floor ? "dead" : meanIc > 0 ? "alive" : "reversed";
    return { ...v, fdrReject: reject, label };
  });

  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const jsonPath = path.join(OUT_DIR, `fundamental-${stamp}.json`);
  const txtPath = path.join(OUT_DIR, `fundamental-${stamp}.txt`);
  writeFileSync(jsonPath, JSON.stringify({ ranAt: new Date().toISOString(), fdrQ: FDR_Q, family: labelled }, null, 2));

  const lines: string[] = [
    `Phase 7 fundamental-compounder backtest — ${stamp}`,
    `family: {US,HK}×{G1,G2} = 4 variants · FDR q=${FDR_Q} · labels are LABELS (exploratory until confirmed)`,
    ``,
  ];
  for (const v of labelled) {
    lines.push(
      `${v.market}/${v.gate}  IC20=${v.ic[0]!.meanIc.toFixed(4)} t=${v.ic[0]!.nwT.toFixed(2)} fdrReject=${v.fdrReject} label=${v.label}` +
        `  | gated TR ${(v.portfolio.gated.totalReturn * 100).toFixed(1)}% vs ungated ${(v.portfolio.ungated.totalReturn * 100).toFixed(1)}%` +
        `  diff ${v.portfolio.diffVsUngated ? `${v.portfolio.diffVsUngated.meanDailyBps.toFixed(2)}bps/d t=${v.portfolio.diffVsUngated.nwT.toFixed(2)}` : "n/a"}`,
    );
    for (const sg of v.subgroups.filter((s) => s.names >= 15)) {
      lines.push(`    [exploratory] ${sg.sector}: ${sg.names} names, IC20 ${sg.meanIc20?.toFixed(4) ?? "n/a"} over ${sg.days}d`);
    }
  }
  writeFileSync(txtPath, lines.join("\n") + "\n");
  console.log(`\nwrote ${jsonPath}\nwrote ${txtPath}`);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
