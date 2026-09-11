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
 *    Passing means "not falsified", never "confirmed".
 *
 *    **Corrected 2026-09-11 (Phase 4b).** This file used to justify that
 *    asymmetry with "portfolio alpha over ~4 years needs IR >= 0.985 for t = 2,
 *    and a realistic screen IR is 0.3-0.7". That was a statement about a
 *    *hypothetical* IR, never measured — the same error class as Gate 1's
 *    mis-calibrated bar. The realized differential now gets its own Newey-West
 *    interval (`Gate2Result.nwT`); the *role* is unchanged (promoting a gate
 *    after seeing its value is goalpost movement), but the claim that this gate
 *    can never confirm is WITHDRAWN. Phase 4c, which has not yet seen its data,
 *    may make a powered differential test the deciding gate.
 *
 * There is no tuning anywhere in this path. The shipped SCREEN_PARAMS *are* the
 * hypothesis, so there is no selection bias to control — and no fitted quantity
 * for a split to protect.
 */
import { Market } from "./screening.js";
import {
  ReplayDay,
  ForwardSeries,
  SymbolSeries,
  ExclusionCensus,
  exclusionCensus,
  replayScreen,
  buildForwardSeries,
} from "./replay.js";
import {
  IcPoint,
  IcStats,
  icSeries,
  icStats,
  icPower,
  neweyWestT,
  spreadSeries,
  spreadSeriesProportional,
  summarizeSpread,
} from "./ic.js";
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
/** Newey-West lag for the Gate-2 daily differential (Phase 4b D2).
 *  Pre-registered at 20 — the lag the IC gate uses, and comparable to the ~15d
 *  average hold. 5 and 60 are reported as descriptive sensitivity only. */
export const DIFFERENTIAL_LAG = 20;
const SESSIONS_PER_YEAR = 252;
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
  /** Phase 4b D4: the SAME contrast with a proportional cutoff
   *  (`max(ceil(0.10 × breadth), 5)`) instead of the fixed top-15, so the number
   *  means the same thing in a 180-name lane and a 25-name lane. Descriptive:
   *  this window is spent for it. */
  spreadPropMean: number;
  spreadPropNwT: number;
  /** Mean realized cutoff — reveals when the 5-name floor, not the decile, binds. */
  spreadPropCutoff: number;
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
  /** Phase 4b D1: the three estimates of the same SE, side by side, plus the
   *  interval at the t-quantile for the effective df (T/h − 1). They disagree by
   *  more than the effect being measured — that IS the finding. */
  naiveSe: number;
  heuristicSe: number;
  degreesOfFreedom: number;
  quantile: number;
  ciLo: number;
  ciHi: number;
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
  /** portfolio total return − benchmark total return. NOTE: a difference of two
   *  *compounded* returns, which is NOT what the NW t below tests. */
  differential: number;
  /** Phase 4b D2: mean of the daily *arithmetic* difference p_t − b_t. */
  differentialDailyMean: number;
  /** Annualised stdev of that daily difference (i.i.d.; descriptive). */
  trackingError: number;
  /** (dailyMean × 252) / trackingError — the CONVENTIONAL IR, i.i.d. TE. */
  ir: number;
  /** Portfolio sessions ÷ 252 — needed because `ir·√years != nwT`: the HAC
   *  factor adjusts the SE of the *mean*, not a per-period quantity. Printed so
   *  the gap is visible instead of looking like an error. */
  years: number;
  /** ir · √years — what the IR alone would imply for t. */
  tFromIr: number;
  /** Pre-registered Newey-West t on the daily differential (lag 20). */
  nwT: number;
  /** Descriptive lag sensitivity — if these disagree with `nwT`, report that
   *  rather than choosing a lag. */
  nwT5: number;
  nwT60: number;
  falsified: boolean;
  reasons: string[];
}

/** Phase 4b D5: `insufficient_evidence` is distinct from `h1_revised`.
 *  A lane whose own SE puts the bar out of reach cannot have falsified H1 — its
 *  Gate-1 FAIL says "this window could not tell", not "no edge". Conflating the
 *  two is what made Phase 4's result read as a negative finding. */
export type LaneVerdict =
  | "h1_holds"
  | "ranking_power_but_not_tradable"
  | "h1_revised"
  | "insufficient_evidence";

export interface LaneResult {
  market: Market;
  gate1: Gate1Result;
  gate2Base: Gate2Result;
  gate2Double: Gate2Result;
  /** Phase 4b D3: which eligibility gate produced this lane's breadth.
   *  Descriptive only (Fork C) — it may not select a gate to relax. */
  exclusions: ExclusionCensus;
  /** Buy-and-hold total return of the index ETF, when present in the data.
   *  phase-4-plan.md pre-registered TWO benchmarks: the equal-weight
   *  same-universe book (which shares the screen's own selection, so the
   *  differential is mostly about portfolio construction) and the index. */
  indexReturn: number | null;
  /** portfolio total return − index total return. */
  indexDifferential: number | null;
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
    const laneDays = daysFor(days, market);

    for (const h of horizons) {
      const points = icSeries(laneDays, forward, h);
      const stats = icStats(points, h);
      const spread = summarizeSpread(spreadSeries(laneDays, forward, h, topN));
      // Phase 4b D4 — the proportional contrast. Descriptive: the window is
      // already spent for it (the fixed-topN version above was published).
      const propCutoffs: number[] = [];
      const propValues = spreadSeriesProportional(laneDays, forward, h, propCutoffs);
      const propSpread = summarizeSpread(propValues);
      const propNw = neweyWestT(propValues, h);
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
          spreadPropMean: propSpread.mean,
          spreadPropNwT: propNw?.t ?? 0,
          spreadPropCutoff: propCutoffs.length ? propCutoffs.reduce((a, b) => a + b, 0) / propCutoffs.length : 0,
        });
      }
      if (h === PRIMARY_HORIZON && stats) {
        primary = stats;
        primaryPoints = points;
      }
    }

    const stats = primary;
    const power = stats ? icPower(stats, PRIMARY_HORIZON) : null;
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
      naiveSe: power?.naiveSe ?? 0,
      heuristicSe: power?.heuristicSe ?? 0,
      degreesOfFreedom: power?.df ?? 0,
      quantile: power?.quantile ?? 0,
      ciLo: power?.ciLo ?? 0,
      ciHi: power?.ciHi ?? 0,
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
    // Phase 4b D5: a FAIL on an unreachable bar is *insufficient evidence*, not
    // a revision of H1. Phase 4 collapsed the two and read as a negative finding.
    const gate1Unreachable = gate1.detectableIc > gate1.minIc;
    const verdict: LaneVerdict = !gate1.passed
      ? gate1Unreachable
        ? "insufficient_evidence"
        : "h1_revised"
      : falsified
        ? "ranking_power_but_not_tradable"
        : "h1_holds";

    const notes: string[] = [];
    // Phase 4b D1: UNCONDITIONAL. This used to be emitted only when Gate 1
    // PASSED — i.e. the single most important context, "this lane could only
    // detect 0.0298", was suppressed in exactly the case that needed it.
    if (stats && power) {
      notes.push(
        `power note: this lane's own NW SE implies it can only detect mean ${PRIMARY_HORIZON}d IC >= ${gate1.detectableIc.toFixed(4)} at t=2` +
          (gate1Unreachable
            ? `, which is ABOVE the ${gate1.minIc} magnitude bar — the bar was unreachable in this lane, so FAIL is insufficient evidence, not evidence of no edge.`
            : `, below the ${gate1.minIc} bar, so this lane could have detected the pre-registered effect.`),
      );
      notes.push(
        `SE triple: naive ${power.naiveSe.toFixed(5)} · heuristic ${power.heuristicSe.toFixed(5)} · realized NW ${gate1.nwSe.toFixed(5)}` +
          ` (df ${power.df.toFixed(1)}) · 95% CI on mean IC [${gate1.ciLo.toFixed(4)}, ${gate1.ciHi.toFixed(4)}] (approx: NW + normal)`,
      );
    }
    if (!falsified) {
      notes.push(
        "Gate 2 is NOT falsified — a pre-registered non-falsification, never a confirmation. " +
          "The Phase-4 claim that this gate can never confirm (IR >= 0.985) is WITHDRAWN: that IR was assumed, never measured. " +
          "See the differential interval in gate2Base.",
      );
    }
    if (Math.abs(base.gate.nwT) >= 2) {
      notes.push(
        `the base-cost daily differential NW t is ${base.gate.nwT.toFixed(2)} (lag ${DIFFERENTIAL_LAG}) — it excludes 0, and this is the ` +
          "project's only adequately-powered evidence. It is NOT a confirmation: Gate 2 is pre-registered as falsification-only (Phase 4b Fork B).",
      );
    }

    const idxSym = input.indexSymbol?.[market];
    const idxRet = idxSym ? buyAndHold(forward.get(idxSym), input.dates) : null;
    if (idxRet != null) indexReturns[market] = idxRet;

    lanes.push({
      market,
      gate1,
      gate2Base: base.gate,
      gate2Double: doubled.gate,
      exclusions: exclusionCensus(days, market),
      indexReturn: idxRet,
      indexDifferential: idxRet == null ? null : base.result.metrics.totalReturn - idxRet,
      yearly,
      verdict,
      notes,
    });
  }

  return { lanes, replayDays: days.length, indexReturns };
}

/** Forward series built once per symbol, not per day. */
function buildForwardMap(s: SymbolSeries): ForwardSeries {
  return buildForwardSeries(s.bars, s.dividends);
}

/** IC/portfolio work is per market, so restrict the day list's rankings to it.
 *  `excludedByReason` is already keyed by market, so it passes through. */
function daysFor(days: ReplayDay[], market: Market): ReplayDay[] {
  return days.map((d) => ({
    date: d.date,
    ranked: d.ranked.filter((p) => p.market === market),
    excludedCount: d.excludedCount,
    excludedByReason: d.excludedByReason,
  }));
}

/** Sample stdev (n − 1); 0 for fewer than two points. */
function sampleSd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
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

  // Phase 4b D2. `differential` above is a difference of COMPOUNDED returns;
  // this is the mean of the daily ARITHMETIC difference — a different statistic,
  // and the only one a Newey-West t can be put on. Both series carry a leading 0
  // (portfolioMetrics drops it), so align on index 1+.
  const diffDaily = result.dailyReturns.slice(1).map((r, i) => r - (benchReturns[i + 1] ?? 0));
  const nw = neweyWestT(diffDaily, DIFFERENTIAL_LAG);
  const trackingError = sampleSd(diffDaily) * Math.sqrt(SESSIONS_PER_YEAR);
  const dailyMean = nw?.mean ?? 0;
  const years = result.metrics.sessions / SESSIONS_PER_YEAR;
  const ir = trackingError === 0 ? 0 : (dailyMean * SESSIONS_PER_YEAR) / trackingError;

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
      differentialDailyMean: dailyMean,
      trackingError,
      ir,
      years,
      tFromIr: ir * Math.sqrt(years),
      nwT: nw?.t ?? 0,
      nwT5: neweyWestT(diffDaily, 5)?.t ?? 0,
      nwT60: neweyWestT(diffDaily, 60)?.t ?? 0,
      falsified: reasons.length > 0,
      reasons,
    },
  };
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
