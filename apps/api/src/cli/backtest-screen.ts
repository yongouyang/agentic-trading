/**
 * `backtest:screen` — Phase 4 runner (docs/phase-4-plan.md).
 *
 * Store (read-only) → point-in-time replay of the SHIPPED screen → Gate 1
 * (decides) + Gate 2 (falsifies) → JSON + human report under
 * `apps/api/reports/backtest/`.
 *
 * There is no tuning here by design: SCREEN_PARAMS are the hypothesis. The only
 * knobs this CLI exposes change *how the evidence is summarised* (horizons,
 * cost levels), never the strategy — so the pre-registered bar cannot be moved
 * after seeing results.
 *
 * Each lane replays on its own session calendar, matching production's
 * `screen:daily --market <lane>`.
 *
 * Usage:
 *   pnpm -C apps/api backtest:screen [--market us|hk|all] [--json] [--quiet]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Bar, CorporateAction } from "@agentic-trading/quant-core";
import {
  Market,
  SymbolSeries,
  runBacktest,
  sweepWeightCombos,
  type LaneResult,
  type WeightSweepRow,
} from "@agentic-trading/quant-core";
import { SCREEN_PARAMS } from "@agentic-trading/quant-core";
import { buildForwardSeries, replayScreen } from "@agentic-trading/quant-core";
import { PrismaService } from "../prisma.service.js";

const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/** Warmup: the first session at which any symbol in the lane has enough bars to
 *  be screenable. Derived from the store rather than hardcoded, so it stays
 *  correct as history grows. */
export const MIN_BARS_FOR_REPLAY = 252;

export interface BacktestArgs {
  markets: Market[];
  quiet: boolean;
}

export function parseBacktestArgs(argv: string[]): BacktestArgs {
  let markets: Market[] = ["US", "HK"];
  let quiet = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue; // pnpm passes a bare --
    if (arg === "--quiet") {
      quiet = true;
      continue;
    }
    if (arg === "--json") continue; // JSON is always written to the artifact
    if (arg === "--market") {
      const v = argv[++i];
      if (v === "all") markets = ["US", "HK"];
      else if (v === "us") markets = ["US"];
      else if (v === "hk") markets = ["HK"];
      else throw new Error(`--market must be us|hk|all, got "${v ?? ""}"`);
      continue;
    }
    throw new Error(`unknown argument "${arg}" (expected --market us|hk|all, --quiet)`);
  }
  return { markets, quiet };
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

/** Group rows by instrument, preserving ascending date order. */
function groupBy<T extends { instrumentId: number }>(rows: T[]): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const r of rows) {
    let list = out.get(r.instrumentId);
    if (!list) {
      list = [];
      out.set(r.instrumentId, list);
    }
    list.push(r);
  }
  return out;
}

export interface LoadedLane {
  market: Market;
  series: SymbolSeries[];
  dates: string[];
  windowStart: string | null;
  skippedNoBars: number;
}

/** The retired grid's weight dimension: mom60 / mom20 grids with
 *  sharpe252 = 1 − mom60 − mom20 (simplex preserved), exactly as the plan
 *  specified before tuning was dropped. */
export const SWEEP_WEIGHT_COMBOS = [0.4, 0.5, 0.6].flatMap((mom60) =>
  [0.15, 0.25, 0.35].map((mom20) => ({ mom60, mom20, sharpe252: 1 - mom60 - mom20 })),
);

export async function loadLane(prisma: PrismaService, market: Market, log: (m: string) => void = () => {}): Promise<LoadedLane> {
  const instruments = await prisma.instrument.findMany({ where: { market }, orderBy: { symbol: "asc" } });
  const ids = instruments.map((i) => i.id);
  log(`  ${market}: ${instruments.length} instruments — loading bars + dividends…`);

  const bars = (await prisma.bar.findMany({
    where: { instrumentId: { in: ids } },
    orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
    select: { instrumentId: true, date: true, open: true, high: true, low: true, close: true, volume: true },
  })) as RawRow[];

  // R1: splits are never applied locally, so only dividends are relevant.
  const divs = (await prisma.corporateAction.findMany({
    where: { instrumentId: { in: ids }, type: "DIVIDEND" },
    orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
    select: { instrumentId: true, date: true, type: true, amount: true, currency: true },
  })) as (CorporateAction & { instrumentId: number })[];

  const barsById = groupBy(bars);
  const divsById = groupBy(divs);

  const series: SymbolSeries[] = [];
  let skippedNoBars = 0;
  const allDates = new Set<string>();
  let windowStart: string | null = null;

  for (const inst of instruments) {
    const rows = barsById.get(inst.id);
    if (!rows || rows.length === 0) {
      skippedNoBars++;
      continue;
    }
    for (const r of rows) allDates.add(r.date);

    // Lane window start = earliest date any symbol reaches the warmup length.
    if (rows.length >= MIN_BARS_FOR_REPLAY) {
      const d = rows[MIN_BARS_FOR_REPLAY - 1]!.date;
      if (windowStart === null || d < windowStart) windowStart = d;
    }

    series.push({
      symbol: inst.symbol,
      market,
      caDegraded: Boolean((inst as { caDegraded?: boolean }).caDegraded),
      bars: rows.map((r) => ({ date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume })) as Bar[],
      dividends: (divsById.get(inst.id) ?? []).map((d) => ({ date: d.date, type: "DIVIDEND" as const, amount: d.amount, currency: d.currency })),
    });
  }

  const dates = [...allDates].sort().filter((d) => windowStart === null || d >= windowStart);
  return { market, series, dates, windowStart, skippedNoBars };
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
const num = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "—");

function renderLane(lane: LaneResult, indexReturn?: number): string[] {
  const L = lane.gate1;
  const out: string[] = [];
  out.push(`--- ${lane.market} ---`);
  out.push(
    `GATE 1 (decides)   mean 20d IC ${num(L.meanIc, 4)} · ICIR ${num(L.icir)} · NW t ${num(L.nwT, 2)} (lag ${L.primaryHorizon}) · ${L.days} days · breadth ${num(L.meanBreadth, 0)}`,
  );
  out.push(`                   bar: IC >= ${L.minIc} AND t >= ${L.minT} → ${L.passed ? "PASS" : "FAIL"}`);
  out.push(`                   power floor: this lane can only detect IC >= ${num(L.detectableIc, 4)} at t=2`);
  // D1: the three SEs side by side. They disagree by more than the effect being
  // measured, which is the finding — Phase 4 set its bar from the middle one.
  out.push(
    `                   SE triple: naive ${num(L.naiveSe, 5)} · heuristic ${num(L.heuristicSe, 5)} · realized NW ${num(L.nwSe, 5)} (df ${num(L.degreesOfFreedom, 1)})`,
  );
  out.push(
    `                   mean IC 95% CI [${num(L.ciLo, 4)}, ${num(L.ciHi, 4)}] at q=${num(L.quantile, 3)} — approximate (NW + normal)`,
  );
  for (const h of L.horizons) {
    out.push(
      `  ${String(h.horizon).padStart(2)}d: IC ${num(h.meanIc, 4)} · ICIR ${num(h.icir)} · t ${num(h.nwT, 2)} · spread ${pct(h.spreadMean)} (${num(h.spreadPositiveShare * 100, 0)}% days positive)`,
    );
    // D4 (descriptive): the same contrast with a proportional cutoff.
    out.push(
      `       prop spread ${pct(h.spreadPropMean)} · NW t ${num(h.spreadPropNwT, 2)} · mean cutoff ${num(h.spreadPropCutoff, 0)} of ${num(L.meanBreadth, 0)} names`,
    );
  }
  if (L.byYear.length) {
    out.push(`  by year: ${L.byYear.map((y) => `${y.year} ${num(y.meanIc, 4)} (${y.days}d)`).join(" · ")}`);
  }
  for (const [label, g] of [
    ["base", lane.gate2Base],
    ["2x  ", lane.gate2Double],
  ] as const) {
    const m = g.portfolio;
    out.push(
      `GATE 2 (${label}) portfolio ${pct(m.totalReturn)} vs benchmark ${pct(g.benchmarkReturn)} → differential ${pct(g.differential)}` +
        ` · Sharpe ${num(m.sharpe, 2)} · MDD ${pct(m.maxDrawdown)} · trades ${m.tradeCount} · hold ${num(m.avgHoldingSessions, 0)}d · turnover ${num(m.turnover, 1)}x`,
    );
  }
  // D2: the differential's own interval. NOTE the two statistics are different
  // quantities — `differential` is a difference of compounded returns, `NW t`
  // tests the mean of the daily arithmetic difference.
  const gb = lane.gate2Base;
  out.push(
    `  differential interval (D2) daily arithmetic mean ${pct(gb.differentialDailyMean)} · TE ${pct(gb.trackingError)}/yr · IR ${num(gb.ir, 2)} · NW t ${num(gb.nwT, 2)} (lag 20)`,
  );
  out.push(
    `     lag sensitivity: t(5) ${num(gb.nwT5, 2)} · t(20) ${num(gb.nwT, 2)} · t(60) ${num(gb.nwT60, 2)} — descriptive; if these disagree, report that rather than pick a lag`,
  );
  if (lane.yearly.length) {
    out.push(`  yearly differential: ${lane.yearly.map((y) => `${y.year} ${pct(y.differential)}`).join(" · ")}`);
  }
  if (indexReturn != null) out.push(`  buy & hold reference: ${pct(indexReturn)}`);
  // D3: the eligibility census. Descriptive only (Fork C).
  const X = lane.exclusions;
  const reasons = Object.entries(X.byReason).sort((a, b) => b[1] - a[1]);
  const denom = X.total + X.eligible;
  out.push(
    `  exclusion census (D3, descriptive): ${num(X.total, 0)} rejected vs ${num(X.eligible, 0)} eligible observations` +
      ` → ${num((X.total / Math.max(1, denom)) * 100, 1)}% of screenable observations rejected`,
  );
  for (const [reason, n] of reasons) {
    out.push(`    ${reason.padEnd(22)} ${num(n, 0).padStart(7)}  (${num((n / Math.max(1, X.total)) * 100, 1)}% of rejections, ${num(n / Math.max(1, X.days), 0)}/day)`);
  }
  out.push(
    `    by year: ${X.byYear.map((y) => `${y.year} ${Object.entries(y.byReason).sort((a, b) => b[1] - a[1])[0]?.join(" ") ?? "—"}`).join(" · ")}  (dominant reason)`,
  );
  out.push(`VERDICT ${lane.market}: ${lane.verdict}`);
  for (const n of lane.notes) out.push(`  note: ${n}`);
  for (const g of [lane.gate2Base, lane.gate2Double]) for (const r of g.reasons) out.push(`  falsified: ${r}`);
  return out;
}

export function renderBacktest(
  lanes: LaneResult[],
  window: { start: string; end: string; sessions: number },
  indexReturns: Partial<Record<Market, number>>,
  weightSweep: Partial<Record<Market, WeightSweepRow[]>> = {},
): string {
  const lines: string[] = [];
  lines.push("== PHASE 4b — SCREEN BACKTEST (H1), CALIBRATION REPAIRED ==");
  lines.push(
    `window ${window.start} … ${window.end} (${window.sessions} sessions) · screen parameters UNTUNED (SCREEN_PARAMS as shipped)`,
  );
  lines.push("");
  for (const lane of lanes) lines.push(...renderLane(lane, indexReturns[lane.market]));
  lines.push("");
  for (const market of ["US", "HK"] as Market[]) {
    const rows = weightSweep[market];
    if (!rows || rows.length === 0) continue;
    lines.push(`DESCRIPTIVE weight sweep (${market}, mean 20d IC) — NOT a gate, do not tune from this:`);
    for (const r of rows) {
      lines.push(
        `  mom60 ${r.weights.mom60.toFixed(2)} / mom20 ${r.weights.mom20.toFixed(2)} / sharpe ${r.weights.sharpe252.toFixed(2)}` +
          ` → IC ${num(r.meanIc, 4)} · t ${num(r.nwT, 2)}${r.isShipped ? "   <-- SHIPPED" : ""}`,
      );
    }
    const best = [...rows].sort((a, b) => b.meanIc - a.meanIc)[0]!;
    const shipped = rows.find((r) => r.isShipped);
    const rank = [...rows].sort((a, b) => b.meanIc - a.meanIc).findIndex((r) => r.isShipped) + 1;
    lines.push(`  shipped combo ranks ${rank}/${rows.length} by mean IC; best is ${num(best.meanIc, 4)} (spread ${num(best.meanIc - (shipped?.meanIc ?? 0), 4)} over shipped)`);
  }
  lines.push("");
  lines.push("Pre-registered limitations:");
  lines.push("  · Gate 2 is falsification-only: passing means 'not falsified', never 'confirmed'.");
  lines.push("    The Phase-4 justification for that ('IR >= 0.985' assumed, not measured) is WITHDRAWN — see the differential interval above.");
  lines.push("  · Gate 1's FAIL is `insufficient_evidence` wherever the lane's own SE puts the 0.02 bar out of reach — that is not evidence of no edge.");
  lines.push("  · Survivorship — the store holds today's universe; results are upper bounds, claims are relative.");
  lines.push("  · SCREEN_PARAMS were designed with knowledge of this period, so this is not a clean prospective test.");
  lines.push("  · D3's census and D4's proportional spread are DESCRIPTIVE; this window is spent for both.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

export interface BacktestReport {
  generatedAt: string;
  window: { start: string; end: string; sessions: number };
  lanes: LaneResult[];
  indexReturns: Partial<Record<Market, number>>;
  skippedNoBars: number;
  /** DESCRIPTIVE only — see sweepWeightCombos. Must not be used to change
   *  SCREEN_PARAMS without a new pre-registered test. */
  weightSweep: Partial<Record<Market, WeightSweepRow[]>>;
}

export async function runBacktestCli(prisma: PrismaService, args: BacktestArgs, log: (m: string) => void = () => {}): Promise<BacktestReport> {
  const lanes: LaneResult[] = [];
  const indexReturns: Partial<Record<Market, number>> = {};
  const weightSweep: Partial<Record<Market, WeightSweepRow[]>> = {};
  let start: string | null = null;
  let end: string | null = null;
  let sessions = 0;
  let skippedNoBars = 0;

  for (const market of args.markets) {
    const lane = await loadLane(prisma, market, log);
    skippedNoBars += lane.skippedNoBars;
    log(
      `  ${market}: ${lane.series.length} symbols with bars, replay window ${lane.windowStart ?? "n/a"} … ${lane.dates[lane.dates.length - 1] ?? "n/a"} (${lane.dates.length} sessions)`,
    );
    if (lane.dates.length < 2) {
      log(`  ${market}: too few sessions to replay — skipped`);
      continue;
    }

    // One lane at a time, on that lane's own session calendar.
    const out = runBacktest({
      symbolSeries: lane.series,
      dates: lane.dates,
      markets: [market],
      indexSymbol: { US: "SPY", HK: "2800.HK" },
    });
    const evaluated = out.lanes.find((l) => l.market === market);
    if (evaluated) lanes.push(evaluated);
    Object.assign(indexReturns, out.indexReturns);

    // Descriptive appendix: recompute the score under the retired weight grid
    // from the SAME replay output, so only the weights differ.
    log(`  ${market}: descriptive weight sweep (9 combos)…`);
    const forward = new Map(lane.series.map((s) => [s.symbol, buildForwardSeries(s.bars, s.dividends)]));
    const replayDays = replayScreen(lane.dates, lane.series);
    weightSweep[market] = sweepWeightCombos(replayDays, forward, 20, SWEEP_WEIGHT_COMBOS, {
      mom60: SCREEN_PARAMS.weights.mom60,
      mom20: SCREEN_PARAMS.weights.mom20,
      sharpe252: SCREEN_PARAMS.weights.sharpe252,
    });

    if (lane.windowStart && (start === null || lane.windowStart < start)) start = lane.windowStart;
    const lastDate = lane.dates[lane.dates.length - 1]!;
    if (end === null || lastDate > end) end = lastDate;
    sessions = Math.max(sessions, lane.dates.length);
  }

  return {
    generatedAt: new Date().toISOString(),
    window: { start: start ?? "", end: end ?? "", sessions },
    lanes,
    indexReturns,
    skippedNoBars,
    weightSweep,
  };
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseBacktestArgs(process.argv.slice(2));
  const log = args.quiet ? () => {} : (m: string) => console.error(m);

  const prisma = new PrismaService();
  await prisma.$connect();
  let report: BacktestReport;
  try {
    log("loading store (read-only)…");
    report = await runBacktestCli(prisma, args, log);
  } finally {
    await prisma.$disconnect();
  }

  const text = renderBacktest(report.lanes, report.window, report.indexReturns, report.weightSweep);
  console.log(text);

  const dir = path.join(PKG_ROOT, "reports", "backtest");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  writeFileSync(path.join(dir, `${stamp}.json`), JSON.stringify(report, null, 2));
  writeFileSync(path.join(dir, `${stamp}.txt`), `${text}\n`);
  log(`artifacts → apps/api/reports/backtest/${stamp}.{json,txt}`);
}

const invokedAsScript = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (invokedAsScript) {
  main().catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
  });
}
