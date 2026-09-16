/**
 * Diversification report CLI (charter §5.3 MEDIUM, built 2026-09-15):
 * "diversification is asserted but never measured; a correlation matrix over
 * the persisted daily returns would settle it." READ-ONLY — recomputes the
 * latest session's screen from the store (replayScreen, the proven PIT path)
 * and measures three correlation blocks:
 *
 *   inter-factor — cross-sectional ρ among mom20 / mom60 / sharpe252 over the
 *     lane's full eligible set (is the composite score effectively one factor?)
 *   inter-name   — pairwise ρ of daily adjusted returns over the trailing
 *     window for the ranked breadth (topN) and for the displayTopN subset the
 *     user actually sees
 *   inter-lane   — ρ between the two lanes' equal-weight eligible-set mean
 *     returns over the same window
 *
 *   pnpm -C apps/api report:correlation [-- --window 60]
 *
 * Stdout carries the summaries; the full matrices land in
 * reports/correlation-<date>.json. Nothing is written to any store table —
 * measurement, not a screen change (Stage-1 charter: factor weights, gates,
 * universe and portfolio rule are untouched).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  deriveAdjustedBars,
  MIN_CORR_OVERLAP,
  pairwiseCorrelation,
  pearson,
  replayScreen,
  returnsByDate,
  SCREEN_PARAMS,
  summarizeCorrelation,
  type Bar,
  type CorporateAction,
  type CorrelationSummary,
  type Market,
  type PairwiseCorrelation,
  type ScreenPick,
  type SymbolSeries,
} from "@agentic-trading/quant-core";
import { PrismaService } from "../prisma.service.js";

const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

export const CORR_WINDOW = 60;

export interface LaneCorrelation {
  market: Market;
  /** Newest store bar date for the lane — the session the screen is recomputed on. */
  sessionDate: string;
  universeSize: number;
  eligibleCount: number;
  /** Cross-sectional ρ among the score components over the full eligible set. */
  interFactor: { pair: string; rho: number | null }[];
  /** Pairwise return correlation over the ranked measurement breadth (topN). */
  breadth: CorrelationSummary & { names: number };
  /** Same, restricted to the displayTopN rows the dashboard presents. */
  display: CorrelationSummary & { names: number };
  /** Full breadth matrix — artifact only, too wide for stdout. */
  matrix: PairwiseCorrelation;
  /** date → equal-weight mean return of the eligible set (window dates only). */
  eligibleMeanReturns: Record<string, number>;
}

export interface CorrelationReport {
  date: string;
  window: number;
  lanes: LaneCorrelation[];
  interLane: { rho: number | null; commonDates: number };
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

function groupByInstrument<T extends { instrumentId: number }>(rows: T[]): Map<number, T[]> {
  const m = new Map<number, T[]>();
  for (const r of rows) {
    const arr = m.get(r.instrumentId);
    if (arr) arr.push(r);
    else m.set(r.instrumentId, [r]);
  }
  return m;
}

/** Windowed adjusted-return series per symbol: full-history derive (R2), then
 *  returns restricted to the trailing `windowDates` (keys are the later date,
 *  so the first window date contributes only as the previous close). */
function windowedReturns(series: SymbolSeries[], windowDates: string[]): Map<string, Map<string, number>> {
  const first = windowDates[0]!;
  const out = new Map<string, Map<string, number>>();
  for (const s of series) {
    const adjusted = deriveAdjustedBars(s.bars, s.dividends);
    const rets = returnsByDate(adjusted.map((b) => ({ date: b.date, close: b.adjustedClose })));
    const windowed = new Map<string, number>();
    for (const [date, r] of rets) if (date > first) windowed.set(date, r);
    out.set(s.symbol, windowed);
  }
  return out;
}

export async function laneCorrelation(prisma: PrismaService, market: Market, window: number = CORR_WINDOW): Promise<LaneCorrelation> {
  const instruments = await prisma.instrument.findMany({ where: { market }, orderBy: { symbol: "asc" } });
  const ids = instruments.map((i) => i.id);
  const bars = (await prisma.bar.findMany({
    where: { instrumentId: { in: ids } },
    orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
    select: { instrumentId: true, date: true, open: true, high: true, low: true, close: true, volume: true },
  })) as RawRow[];
  const divs = (await prisma.corporateAction.findMany({
    where: { instrumentId: { in: ids }, type: "DIVIDEND" },
    orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
    select: { instrumentId: true, date: true, type: true, amount: true, currency: true },
  })) as (CorporateAction & { instrumentId: number })[];
  if (bars.length === 0) throw new Error(`${market}: no bars in the store — nothing to correlate`);

  const barsById = groupByInstrument(bars);
  const divsById = groupByInstrument(divs);
  const series: SymbolSeries[] = instruments
    .filter((inst) => (barsById.get(inst.id) ?? []).length > 0)
    .map((inst) => ({
      symbol: inst.symbol,
      market,
      caDegraded: Boolean(inst.caDegraded),
      bars: barsById.get(inst.id)!.map((r) => ({ date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume })) as Bar[],
      dividends: (divsById.get(inst.id) ?? []).map((d) => ({ date: d.date, type: "DIVIDEND" as const, amount: d.amount, currency: d.currency })),
    }));

  const laneDates = [...new Set(bars.map((b) => b.date))].sort();
  const sessionDate = laneDates[laneDates.length - 1]!;
  const windowDates = laneDates.slice(-(window + 1));

  // Recompute the session's screen with topN lifted — replayScreen is the
  // proven path; ranked = the full eligible set, ranked.
  const day = replayScreen([sessionDate], series)[0]!;
  const eligible: ScreenPick[] = day.ranked;

  const interFactor = (["mom20", "mom60", "sharpe252"] as const).flatMap((a, i, arr) =>
    arr.slice(i + 1).map((b) => ({
      pair: `${a}~${b}`,
      rho: pearson(
        eligible.map((p) => p[a]),
        eligible.map((p) => p[b]),
      ),
    })),
  );

  const bySymbol = new Map(series.map((s) => [s.symbol, s]));
  const eligibleSeries = eligible.map((p) => bySymbol.get(p.symbol)!);
  const allReturns = windowedReturns(eligibleSeries, windowDates);

  const breadthNames = eligible.slice(0, SCREEN_PARAMS.topN[market]).map((p) => p.symbol);
  const displayNames = eligible.slice(0, SCREEN_PARAMS.displayTopN[market]).map((p) => p.symbol);
  const pick = (names: string[]) => new Map(names.map((n) => [n, allReturns.get(n)!]));
  const matrix = pairwiseCorrelation(pick(breadthNames));
  const breadth = { ...summarizeCorrelation(matrix), names: breadthNames.length };
  const display = { ...summarizeCorrelation(pairwiseCorrelation(pick(displayNames))), names: displayNames.length };

  const eligibleMeanReturns: Record<string, number> = {};
  for (const date of windowDates.slice(1)) {
    let sum = 0;
    let n = 0;
    for (const rets of allReturns.values()) {
      const r = rets.get(date);
      if (r !== undefined) {
        sum += r;
        n++;
      }
    }
    if (n > 0) eligibleMeanReturns[date] = sum / n;
  }

  return {
    market,
    sessionDate,
    universeSize: instruments.length,
    eligibleCount: eligible.length,
    interFactor,
    breadth,
    display,
    matrix,
    eligibleMeanReturns,
  };
}

/** ρ between the two lanes' eligible equal-weight mean returns, aligned on
 *  common dates only (HK/US calendars differ); null below MIN_CORR_OVERLAP. */
export function interLaneCorrelation(lanes: LaneCorrelation[]): { rho: number | null; commonDates: number } {
  if (lanes.length < 2) return { rho: null, commonDates: 0 };
  const [a, b] = [lanes[0]!.eligibleMeanReturns, lanes[1]!.eligibleMeanReturns];
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [date, r] of Object.entries(a)) {
    const other = b[date];
    if (other !== undefined) {
      xs.push(r);
      ys.push(other);
    }
  }
  return { rho: xs.length < MIN_CORR_OVERLAP ? null : pearson(xs, ys), commonDates: xs.length };
}

export interface ReportDeps {
  prisma: PrismaService;
  /** Directory for correlation-<date>.json; null skips the artifact. */
  reportsDir: string | null;
  today?: string;
  window?: number;
  log?: (line: string) => void;
}

const fmt = (v: number | null) => (v == null ? "—" : v.toFixed(3));
const fmt2 = (v: number | null) => (v == null ? "—" : v.toFixed(2));

export function formatReport(report: CorrelationReport, artifactPath: string | null): string[] {
  const lines: string[] = [];
  lines.push(`== CORRELATION == ${report.date} · window ${report.window} sessions · read-only measurement (charter §5.3)`);
  for (const lane of report.lanes) {
    lines.push(`${lane.market} · session ${lane.sessionDate} · eligible ${lane.eligibleCount}/${lane.universeSize}`);
    lines.push(`  inter-factor: ${lane.interFactor.map((f) => `ρ(${f.pair.replace("~", ",")})=${fmt2(f.rho)}`).join(" · ")}`);
    const b = lane.breadth;
    lines.push(
      `  inter-name breadth ${b.names}: mean ρ ${fmt(b.mean)} · median ${fmt(b.median)} · max ${fmt(b.max)}${b.maxPair ? ` (${b.maxPair.join("~")})` : ""} · ${b.pairs} pairs, ${b.unmeasurable} unmeasurable`,
    );
    const d = lane.display;
    lines.push(
      `  inter-name display ${d.names}: mean ρ ${fmt(d.mean)} · median ${fmt(d.median)} · max ${fmt(d.max)}${d.maxPair ? ` (${d.maxPair.join("~")})` : ""} · ${d.pairs} pairs, ${d.unmeasurable} unmeasurable`,
    );
  }
  lines.push(`inter-lane (eligible equal-weight): ρ=${fmt(report.interLane.rho)} over ${report.interLane.commonDates} common sessions`);
  if (artifactPath) lines.push(`artifact: ${artifactPath}`);
  return lines;
}

export async function runCorrelationReport(deps: ReportDeps): Promise<CorrelationReport> {
  const { prisma } = deps;
  const log = deps.log ?? ((l: string) => console.log(l));
  const window = deps.window ?? CORR_WINDOW;
  const today = deps.today ?? new Date().toISOString().slice(0, 10);

  const lanes: LaneCorrelation[] = [];
  for (const market of ["US", "HK"] as const) {
    lanes.push(await laneCorrelation(prisma, market, window));
  }
  const report: CorrelationReport = { date: today, window, lanes, interLane: interLaneCorrelation(lanes) };

  let artifactPath: string | null = null;
  if (deps.reportsDir) {
    mkdirSync(deps.reportsDir, { recursive: true });
    artifactPath = path.join(deps.reportsDir, `correlation-${today}.json`);
    writeFileSync(artifactPath, JSON.stringify(report, null, 2));
  }
  for (const line of formatReport(report, artifactPath)) log(line);
  return report;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const windowIdx = args.indexOf("--window");
  const window = windowIdx >= 0 ? Number(args[windowIdx + 1]) : CORR_WINDOW;
  if (!Number.isInteger(window) || window < MIN_CORR_OVERLAP) {
    throw new Error(`--window must be an integer >= ${MIN_CORR_OVERLAP}`);
  }
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    await runCorrelationReport({ prisma, reportsDir: path.join(PKG_ROOT, "reports"), window });
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
