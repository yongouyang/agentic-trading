/**
 * Phase 4 orchestration and gate evaluation (docs/phase-4-plan.md).
 *
 * The pre-registered bar, locked 2026-09-10, lives in this file as constants so
 * it cannot drift from the code that applies it:
 *
 *  - Gate 1 (DECIDES): mean 20d rank IC >= GATE1_MIN_IC **and** Newey-West
 *    t >= GATE1_MIN_T. It is the only gate with real power, because it is
 *    cross-sectional — N is 130–550 names per day.
 *  - Gate 2 (FALSIFIES ONLY): the portfolio must not *lose* to the equal-weight
 *    same-universe benchmark at base or 2x costs, nor in a majority of years.
 *    Passing means "not falsified", never "confirmed": portfolio-level alpha
 *    over ~4 years needs IR >= 0.985 to reach t = 2, and a realistic screen IR
 *    is 0.3–0.7.
 *
 * There is no tuning anywhere in this path. The shipped SCREEN_PARAMS *are* the
 * hypothesis, so there is no selection bias to control — and no fitted quantity
 * for a split to protect.
 */
import { Market } from "./screening.js";
import { ReplayDay, ForwardSeries, SymbolSeries, replayScreen, buildForwardSeries } from "./replay.js";
import { IcPoint, IcStats, icSeries, icStats, spreadSeries, summarizeSpread } from "./ic.js";
import {
  BASE_COSTS,
  CostModel,
  PortfolioMetrics,
  PortfolioParams,
  PortfolioResult,
  benchmarkReturns,
  portfolioMetrics,
  scaleCosts,
  simulatePortfolio,
} from "./portfolio.js";

/** Pre-registered Gate 1 thresholds. Do not edit after seeing results. */
export const GATE1_MIN_IC = 0.02;
export const GATE1_MIN_T = 2;

/** The pre-registered Gate 1 bar, as a pure predicate so the boundary is
 *  directly testable and cannot drift from the report text. */
export function gate1Passes(meanIc: number, nwT: number): boolean {
  return meanIc >= GATE1_MIN_IC && nwT >= GATE1_MIN_T;
}
/** Primary horizon. 5d/60d are reported but may not override this. */
export const PRIMARY_HORIZON = 20;
/** Rank-hysteresis parameters (the shipped defaults, untuned). */
export const PORTFOLIO_TOP_N = 15;
export const PORTFOLIO_BUFFER_RANK = 25;

export interface HorizonSummary {
  horizon: number;
  meanIc: number;
  icir: number;
  nwT: number;
  nwSe: number;
  days: number;
  spreadMean: number;
  spreadPositiveShare: number;
}

export interface Gate1Result {
  market: Market;
  primaryHorizon: number;
  meanIc: number;
  icir: number;
  nwT: number;
  nwSe: number;
  days: number;
  meanBreadth: number;
  /** Smallest mean IC this lane could have detected at t = 2, from its own
   *  observed standard error. The honest statement of the lane's power. */
  detectableIc: number;
  minIc: number;
  minT: number;
  passed: boolean;
  horizons: HorizonSummary[];
  byYear: { year: string; meanIc: number; days: number }[];
}

export interface Gate2Result {
  market: Market;
  costLabel: string;
  portfolio: PortfolioMetrics;
  benchmarkReturn: number;
  /** portfolio total return − benchmark total return. */
  differential: number;
  falsified: boolean;
  reasons: string[];
}

export type LaneVerdict = "h1_holds" | "ranking_power_but_not_tradable" | "h1_revised";

export interface LaneResult {
  market: Market;
  gate1: Gate1Result;
  gate2Base: Gate2Result;
  gate2Double: Gate2Result;
  yearly: { year: string; portfolio: number; benchmark: number; differential: number }[];
  verdict: LaneVerdict;
  notes: string[];
}

export interface BacktestInput {
  symbolSeries: SymbolSeries[];
  /** Market session calendar for the replay window, ascending. */
  dates: string[];
  /** Which lanes to evaluate. Defaults to both. Callers with per-market
   *  session calendars run one lane at a time so each lane's IC uses its own
   *  sessions, exactly as `screen:daily --market` does in production. */
  markets?: Market[];
  horizons?: number[];
  costs?: CostModel;
  topN?: number;
  bufferRank?: number;
  /** Buy-and-hold reference (e.g. SPY / 2800.HK) when present in the data. */
  indexSymbol?: Partial<Record<Market, string>>;
}

export interface BacktestOutput {
  lanes: LaneResult[];
  replayDays: number;
  indexReturns: Partial<Record<Market, number>>;
}

/** Compound a daily return series into an equity curve starting at 1. */
export function equityFromReturns(returns: number[]): number[] {
  const out: number[] = [];
  let v = 1;
  for (const r of returns) {
    out.push(v);
    v *= 1 + r;
  }
  out.push(v);
  return out;
}

function groupByYear(points: IcPoint[]): { year: string; meanIc: number; days: number }[] {
  const buckets = new Map<string, number[]>();
  for (const p of points) {
    const y = p.date.slice(0, 4);
    if (!buckets.has(y)) buckets.set(y, []);
    buckets.get(y)!.push(p.ic);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([year, xs]) => ({ year, meanIc: xs.reduce((a, b) => a + b, 0) / xs.length, days: xs.length }));
}

function yearlyReturns(days: ReplayDay[], portfolioReturns: number[], benchReturns: number[]): { year: string; portfolio: number; benchmark: number; differential: number }[] {
  const buckets = new Map<string, { p: number; b: number }>();
  for (let t = 0; t < days.length; t++) {
    const y = days[t]!.date.slice(0, 4);
    const cur = buckets.get(y) ?? { p: 1, b: 1 };
    cur.p *= 1 + (portfolioReturns[t] ?? 0);
    cur.b *= 1 + (benchReturns[t] ?? 0);
    buckets.set(y, cur);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([year, v]) => ({ year, portfolio: v.p - 1, benchmark: v.b - 1, differential: v.p - v.b }));
}

/** Buy-and-hold total return of one symbol over the window, when available. */
function buyAndHold(series: ForwardSeries | undefined, dates: string[]): number | null {
  if (!series || dates.length < 2) return null;
  const from = series.index.get(dates[0]!);
  const to = series.index.get(dates[dates.length - 1]!);
  if (from === undefined || to === undefined) return null;
  const a = series.closes[from]!;
  const b = series.closes[to]!;
  return a === 0 ? null : b / a - 1;
}

export function runBacktest(input: BacktestInput): BacktestOutput {
  const horizons = input.horizons ?? [5, PRIMARY_HORIZON, 60];
  const costs = input.costs ?? BASE_COSTS;
  const topN = input.topN ?? PORTFOLIO_TOP_N;
  const bufferRank = input.bufferRank ?? PORTFOLIO_BUFFER_RANK;

  const days = replayScreen(input.dates, input.symbolSeries);
  const forward = new Map<string, ForwardSeries>();
  for (const s of input.symbolSeries) forward.set(s.symbol, buildForwardMap(s));

  const lanes: LaneResult[] = [];
  const indexReturns: Partial<Record<Market, number>> = {};

  for (const market of input.markets ?? (["US", "HK"] as Market[])) {
    const horizonsSummary: HorizonSummary[] = [];
    let primary: IcStats | null = null;
    let primaryPoints: IcPoint[] = [];

    for (const h of horizons) {
      const points = icSeries(daysFor(days, market), forward, h);
      const stats = icStats(points, h);
      const spread = summarizeSpread(spreadSeries(daysFor(days, market), forward, h, topN));
      if (stats) {
        horizonsSummary.push({
          horizon: h,
          meanIc: stats.mean,
          icir: stats.icir,
          nwT: stats.nwT,
          nwSe: stats.nwSe,
          days: stats.days,
          spreadMean: spread.mean,
          spreadPositiveShare: spread.positiveShare,
        });
      }
      if (h === PRIMARY_HORIZON && stats) {
        primary = stats;
        primaryPoints = points;
      }
    }

    const stats = primary;
    const gate1: Gate1Result = {
      market,
      primaryHorizon: PRIMARY_HORIZON,
      meanIc: stats?.mean ?? 0,
      icir: stats?.icir ?? 0,
      nwT: stats?.nwT ?? 0,
      nwSe: stats?.nwSe ?? 0,
      days: stats?.days ?? 0,
      meanBreadth: stats?.meanBreadth ?? 0,
      detectableIc: stats ? GATE1_MIN_T * stats.nwSe : 0,
      minIc: GATE1_MIN_IC,
      minT: GATE1_MIN_T,
      passed: gate1Passes(stats?.mean ?? 0, stats?.nwT ?? 0),
      horizons: horizonsSummary,
      byYear: groupByYear(primaryPoints),
    };

    const params: PortfolioParams = { topN, bufferRank, costs };
    const base = runPortfolioAndGate(days, forward, params, market, "base", "1x base costs");
    const doubled = runPortfolioAndGate(days, forward, params, market, "2x", "2x base costs", scaleCosts);
    const yearly = yearlyReturns(days, base.result.dailyReturns, base.benchReturns);

    const negativeYears = yearly.filter((y) => y.differential < 0).length;
    const majorityNegative = yearly.length > 0 && negativeYears * 2 > yearly.length;

    const reasons = [...base.gate.reasons];
    if (doubled.gate.falsified) reasons.push(...doubled.gate.reasons);
    if (majorityNegative) reasons.push(`differential negative in ${negativeYears}/${yearly.length} calendar years`);

    const falsified = reasons.length > 0;
    const verdict: LaneVerdict = !gate1.passed ? "h1_revised" : falsified ? "ranking_power_but_not_tradable" : "h1_holds";

    const notes: string[] = [];
    if (gate1.passed && gate1.detectableIc > gate1.minIc) {
      notes.push(
        `power note: this lane's own SE implies it can only detect mean 20d IC >= ${gate1.detectableIc.toFixed(4)} at t=2, ` +
          `which is above the ${gate1.minIc} magnitude bar — the t-stat is the binding constraint here.`,
      );
    }
    if (!falsified) {
      notes.push(
        "Gate 2 is NOT falsified — that is not a confirmation. Portfolio-level alpha over this window would need IR >= 0.985 to reach t = 2.",
      );
    }

    const idxSym = input.indexSymbol?.[market];
    const idxRet = idxSym ? buyAndHold(forward.get(idxSym), input.dates) : null;
    if (idxRet != null) indexReturns[market] = idxRet;

    lanes.push({ market, gate1, gate2Base: base.gate, gate2Double: doubled.gate, yearly, verdict, notes });
  }

  return { lanes, replayDays: days.length, indexReturns };
}

/** Forward series built once per symbol, not per day. */
function buildForwardMap(s: SymbolSeries): ForwardSeries {
  return buildForwardSeries(s.bars, s.dividends);
}

/** IC/portfolio work is per market, so restrict the day list's rankings to it. */
function daysFor(days: ReplayDay[], market: Market): ReplayDay[] {
  return days.map((d) => ({ date: d.date, ranked: d.ranked.filter((p) => p.market === market), excludedCount: d.excludedCount }));
}

function runPortfolioAndGate(
  days: ReplayDay[],
  forward: Map<string, ForwardSeries>,
  params: PortfolioParams,
  market: Market,
  costLabel: string,
  costDescription: string,
  costTransform?: (m: CostModel, k: number) => CostModel,
): { result: PortfolioResult; benchReturns: number[]; gate: Gate2Result } {
  const effective: PortfolioParams = costTransform ? { ...params, costs: costTransform(params.costs, 2) } : params;
  const result = simulatePortfolio(days, forward, effective, market);
  const benchReturns = benchmarkReturns(days, forward, market);
  const bench = portfolioMetrics(equityFromReturns(benchReturns), benchReturns, [], 0);
  const differential = result.metrics.totalReturn - bench.totalReturn;

  const reasons: string[] = [];
  if (differential <= 0) reasons.push(`[${costDescription}] portfolio ${pct(result.metrics.totalReturn)} vs benchmark ${pct(bench.totalReturn)} — differential ${pct(differential)}`);

  return {
    result,
    benchReturns,
    gate: {
      market,
      costLabel,
      portfolio: result.metrics,
      benchmarkReturn: bench.totalReturn,
      differential,
      falsified: reasons.length > 0,
      reasons,
    },
  };
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
