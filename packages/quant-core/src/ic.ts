/**
 * Ranking-power statistics — Phase 4 Gate 1 (docs/phase-4-plan.md).
 *
 * The IC gate is the only gate in Phase 4 with real statistical power, because
 * it is cross-sectional: N is 130–550 names *per day*, not per year. Everything
 * here therefore has to be right, and one thing in particular has to be right:
 *
 * **Newey-West is mandatory, not a refinement.** Forward labels overlap — the
 * 20d return at T and at T+1 share 19 of their 20 sessions, so the daily IC
 * series is strongly autocorrelated by construction. A plain t-statistic treats
 * ~1011 overlapping observations as independent when the effective count is
 * closer to 1011/20 ≈ 50, and overstates significance by roughly √20 ≈ 4.5×.
 * `neweyWestT` is the only t-statistic the gate may use.
 */
import { ReplayDay, ForwardSeries, forwardReturn } from "./replay.js";

export interface IcPoint {
  date: string;
  ic: number;
  n: number;
}

export interface IcStats {
  /** Number of days with a computable IC. */
  days: number;
  mean: number;
  sd: number;
  /** mean / sd of the daily IC series (not annualised). */
  icir: number;
  /** Newey-West standard error of the mean. */
  nwSe: number;
  /** mean / nwSe — the gate statistic. */
  nwT: number;
  /** Bartlett lag used. */
  lag: number;
  /** Mean cross-sectional breadth (eligible names per day). */
  meanBreadth: number;
}

/** Average ranks with ties shared (the basis of Spearman). */
function averageRanks(xs: number[]): number[] {
  const idx = xs.map((_, i) => i).sort((a, b) => xs[a]! - xs[b]!);
  const ranks = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && xs[idx[j + 1]!]! === xs[idx[i]!]!) j++;
    const shared = (i + j) / 2 + 1; // 1-based average rank
    for (let k = i; k <= j; k++) ranks[idx[k]!] = shared;
    i = j + 1;
  }
  return ranks;
}

/** Pearson correlation; null on degenerate input (zero variance). */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i]!;
    my += ys[i]!;
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Spearman rank correlation = Pearson on average ranks. */
export function spearmanRank(xs: number[], ys: number[]): number | null {
  if (xs.length < 3) return null;
  return pearson(averageRanks(xs), averageRanks(ys));
}

/** Minimum pairs for an IC to be recorded — below this the rank correlation is
 *  too noisy to contribute a daily observation. */
export const MIN_IC_BREADTH = 5;

/** Daily Spearman IC of score vs forward return over the eligible set. */
export function icSeries(days: ReplayDay[], forward: Map<string, ForwardSeries>, horizon: number): IcPoint[] {
  const out: IcPoint[] = [];
  for (const day of days) {
    const scores: number[] = [];
    const rets: number[] = [];
    for (const pick of day.ranked) {
      const series = forward.get(pick.symbol);
      if (!series) continue;
      const r = forwardReturn(series, day.date, horizon);
      if (r == null) continue;
      scores.push(pick.score);
      rets.push(r);
    }
    if (scores.length < MIN_IC_BREADTH) continue;
    const ic = spearmanRank(scores, rets);
    if (ic == null || Number.isNaN(ic)) continue;
    out.push({ date: day.date, ic, n: scores.length });
  }
  return out;
}

/** Mean forward return of the top-N ranked names minus the mean of the rest. */
export function spreadSeries(
  days: ReplayDay[],
  forward: Map<string, ForwardSeries>,
  horizon: number,
  topN: number,
): number[] {
  const out: number[] = [];
  for (const day of days) {
    const top: number[] = [];
    const rest: number[] = [];
    for (const pick of day.ranked) {
      const series = forward.get(pick.symbol);
      if (!series) continue;
      const r = forwardReturn(series, day.date, horizon);
      if (r == null) continue;
      (pick.rank <= topN ? top : rest).push(r);
    }
    if (top.length === 0 || rest.length === 0) continue;
    out.push(top.reduce((a, b) => a + b, 0) / top.length - rest.reduce((a, b) => a + b, 0) / rest.length);
  }
  return out;
}

/**
 * Newey-West (Bartlett) standard error of the mean of a serially correlated
 * series, and the resulting t-statistic.
 *
 * Var(mean) ≈ (1/T)·[γ₀ + 2·Σ_{l=1..L} (1 − l/(L+1))·γ_l]
 *
 * `lag` must be at least the label horizon: that is the order of the induced
 * moving-average structure.
 */
export function neweyWestT(xs: number[], lag: number): { mean: number; se: number; t: number; lag: number } | null {
  const T = xs.length;
  if (T < 3) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / T;
  const dev = xs.map((x) => x - mean);
  const L = Math.max(0, Math.min(lag, T - 1));

  let gamma0 = 0;
  for (const d of dev) gamma0 += d * d;
  gamma0 /= T;

  let acc = gamma0;
  for (let l = 1; l <= L; l++) {
    let gl = 0;
    for (let i = l; i < T; i++) gl += dev[i]! * dev[i - l]!;
    gl /= T;
    acc += 2 * (1 - l / (L + 1)) * gl;
  }
  if (acc <= 0) return null; // degenerate (e.g. constant series)

  const se = Math.sqrt(acc / T);
  if (se === 0) return null;
  return { mean, se, t: mean / se, lag: L };
}

/** Full statistics for one IC series. `lag` defaults to the label horizon. */
export function icStats(points: IcPoint[], lag: number): IcStats | null {
  const xs = points.map((p) => p.ic);
  const nw = neweyWestT(xs, lag);
  if (!nw) return null;
  const T = xs.length;
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - nw.mean) ** 2, 0) / Math.max(1, T - 1));
  const meanBreadth = points.reduce((a, p) => a + p.n, 0) / T;
  return {
    days: T,
    mean: nw.mean,
    sd,
    icir: sd === 0 ? 0 : nw.mean / sd,
    nwSe: nw.se,
    nwT: nw.t,
    lag: nw.lag,
    meanBreadth,
  };
}

/** Mean and share-positive for a spread series. */
export function summarizeSpread(values: number[]): { mean: number; positiveShare: number; n: number } {
  if (values.length === 0) return { mean: 0, positiveShare: 0, n: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const positiveShare = values.filter((v) => v > 0).length / values.length;
  return { mean, positiveShare, n: values.length };
}

/** Proportional top-vs-rest cutoff: a decile of the day's breadth, floored.
 *
 * The floor is load-bearing, not cosmetic: HK's post-gate breadth is 25 names,
 * so a pure decile is 2–3 names and the "top decile" contrast degenerates into
 * noise. Phase 4 used a *fixed* `topN = 15` for both lanes, which is 8 % of US
 * breadth but **60 %** of HK's — the same number wearing two different meanings.
 * Stating the rule explicitly is what makes it pre-registered (Phase 4b D4). */
export const PROP_SPREAD_SHARE = 0.1;
export const PROP_SPREAD_FLOOR = 5;

export function proportionalCutoff(breadth: number, share = PROP_SPREAD_SHARE, floor = PROP_SPREAD_FLOOR): number {
  return Math.max(Math.ceil(share * breadth), floor);
}

/**
 * Proportional-cutoff version of `spreadSeries`. Same construction, but the top
 * set is a share of each day's breadth rather than a fixed count, so the number
 * means the same thing in a 180-name lane and a 25-name lane.
 *
 * `cutoffs` collects each day's realized cutoff, because in a thin lane the
 * floor (not the share) is what binds and the report has to say which.
 */
export function spreadSeriesProportional(
  days: ReplayDay[],
  forward: Map<string, ForwardSeries>,
  horizon: number,
  cutoffs?: number[],
  share = PROP_SPREAD_SHARE,
  floor = PROP_SPREAD_FLOOR,
): number[] {
  const out: number[] = [];
  for (const day of days) {
    const scored: { rank: number; r: number }[] = [];
    for (const pick of day.ranked) {
      const series = forward.get(pick.symbol);
      if (!series) continue;
      const r = forwardReturn(series, day.date, horizon);
      if (r == null) continue;
      scored.push({ rank: pick.rank, r });
    }
    if (scored.length === 0) continue;
    const cutoff = proportionalCutoff(scored.length, share, floor);
    const top: number[] = [];
    const rest: number[] = [];
    for (const s of scored) (s.rank <= cutoff ? top : rest).push(s.r);
    if (top.length === 0 || rest.length === 0) continue;
    cutoffs?.push(cutoff);
    out.push(top.reduce((a, b) => a + b, 0) / top.length - rest.reduce((a, b) => a + b, 0) / rest.length);
  }
  return out;
}

/**
 * Upper 0.975 quantile of Student's *t*.
 *
 * Exact table for df < 10 (the Cornish–Fisher expansion is asymptotic and
 * *understates* the quantile there — df = 1 gives 7.15 against a true 12.71, a
 * CI that is far too narrow, i.e. overconfident). Non-integer df below 10 step
 * down to the next whole df, which is the conservative direction. Above df = 10
 * the two-term expansion is accurate to ~3e-3, and at the df this pipeline
 * actually sees (T/h − 1 ≈ 44–48) to <1e-4.
 *
 * 1.96 is simply the wrong quantile here, which is why Phase 4b recomputed the
 * intervals: with overlapping labels the effective df is ~48, not ∞.
 */
const T_975_SMALL: Record<number, number> = {
  1: 12.7062,
  2: 4.3027,
  3: 3.1824,
  4: 2.7764,
  5: 2.5706,
  6: 2.4469,
  7: 2.3646,
  8: 2.306,
  9: 2.2622,
};

export function tQuantile975(df: number): number {
  if (!Number.isFinite(df) || df < 10) {
    const whole = Math.max(1, Math.floor(Number.isFinite(df) ? df : 1));
    return T_975_SMALL[Math.min(9, whole)] ?? 2.2622;
  }
  const z = 1.959964;
  const d = df;
  return z + (z ** 3 + z) / (4 * d) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * d * d);
}

/**
 * The *three* estimates of the IC's standard error, side by side (Phase 4b D1).
 *
 * They disagree by more than the effect they are trying to measure, which is the
 * whole finding:
 *  - `naiveSe`   treats all T days as independent (ignores label overlap).
 *  - `heuristicSe` is the ex-ante planning formula `(1/√(N−1))·√h/√T`. Phase 4
 *    set its 0.02 bar from this, on the *universe* size instead of the
 *    post-gate breadth — and its two error sources (per-day SE understated when
 *    names are correlated, overlap penalty overstated) have opposite signs, so
 *    its net error is not predictable in advance.
 *  - `stats.nwSe` is the realized Newey–West SE. The only one that may set a bar.
 *
 * `dpf` (degrees of freedom) drives the interval quantile: T/h − 1.
 */
export function icPower(
  stats: IcStats,
  horizon: number,
): { naiveSe: number; heuristicSe: number; df: number; quantile: number; ciLo: number; ciHi: number } {
  const T = stats.days;
  const naiveSe = T > 0 ? stats.sd / Math.sqrt(T) : NaN;
  const heuristicSe =
    T > 0 && stats.meanBreadth > 1
      ? (1 / Math.sqrt(stats.meanBreadth - 1)) * (Math.sqrt(horizon) / Math.sqrt(T))
      : NaN;
  const df = horizon > 0 ? T / horizon - 1 : T - 1;
  const quantile = tQuantile975(df);
  return {
    naiveSe,
    heuristicSe,
    df,
    quantile,
    ciLo: stats.mean - quantile * stats.nwSe,
    ciHi: stats.mean + quantile * stats.nwSe,
  };
}

export interface WeightCombo {
  mom60: number;
  mom20: number;
  sharpe252: number;
}

export interface WeightSweepRow {
  weights: WeightCombo;
  meanIc: number;
  icir: number;
  nwT: number;
  days: number;
  isShipped: boolean;
}

/** Population stdev; 0 on empty input. */
function pstdev(xs: number[]): number {
  if (xs.length === 0) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length);
}

/**
 * DESCRIPTIVE weight sweep — the retired grid's weight dimension.
 *
 * This is **not** a gate and **not** a selection step. The plan bars using it to
 * change `SCREEN_PARAMS`: any change motivated by this table is a new
 * hypothesis, and it needs a new pre-registered test on data that does not
 * include this window's results.
 *
 * Only the weights are swept, because only the weights affect the score — and
 * therefore the IC. `topN` and `bufferRank` change the portfolio, not the
 * ranking, so the grid collapses from 81 combos to 9 for ranking-power purposes.
 *
 * Scores are recomputed from the replay's per-pick components, so the eligible
 * set and every indicator stay exactly as the shipped screen produced them.
 */
export function sweepWeightCombos(
  days: ReplayDay[],
  forward: Map<string, ForwardSeries>,
  horizon: number,
  combos: WeightCombo[],
  shipped: WeightCombo,
): WeightSweepRow[] {
  const zscores = (xs: number[]): number[] => {
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = pstdev(xs);
    return sd === 0 ? xs.map(() => 0) : xs.map((x) => (x - mean) / sd);
  };

  return combos.map((w) => {
    const points: IcPoint[] = [];
    for (const day of days) {
      const m60: number[] = [];
      const m20: number[] = [];
      const sh: number[] = [];
      const rets: number[] = [];
      for (const pick of day.ranked) {
        const series = forward.get(pick.symbol);
        if (!series) continue;
        const r = forwardReturn(series, day.date, horizon);
        if (r == null) continue;
        m60.push(pick.mom60);
        m20.push(pick.mom20);
        sh.push(pick.sharpe252);
        rets.push(r);
      }
      if (m60.length < MIN_IC_BREADTH) continue;
      const z60 = zscores(m60);
      const z20 = zscores(m20);
      const zsh = zscores(sh);
      const scores = m60.map((_, i) => w.mom60 * z60[i]! + w.mom20 * z20[i]! + w.sharpe252 * zsh[i]!);
      const ic = spearmanRank(scores, rets);
      if (ic == null || Number.isNaN(ic)) continue;
      points.push({ date: day.date, ic, n: m60.length });
    }
    const stats = icStats(points, horizon);
    return {
      weights: w,
      meanIc: stats?.mean ?? 0,
      icir: stats?.icir ?? 0,
      nwT: stats?.nwT ?? 0,
      days: stats?.days ?? 0,
      isShipped: w.mom60 === shipped.mom60 && w.mom20 === shipped.mom20 && w.sharpe252 === shipped.sharpe252,
    };
  });
}
