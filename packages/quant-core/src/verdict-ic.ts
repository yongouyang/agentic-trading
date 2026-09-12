/**
 * LLM deep-dive verdict scoring — Phase 5 (docs/phase-5-plan.md).
 *
 * Phases 4/4b spent the deterministic screen's only window and found its bar
 * unreachable. The LLM layer has never been scored at all, and unlike the screen
 * its sample accrues for free: every run persists verdicts, convictions, and the
 * bars they can be scored against.
 *
 * **The point of this module is to refuse to answer.** At ~10 verdicts/day a
 * per-day conviction IC has SE ≈ 1/√(N−1) ≈ 0.33, and 20d labels overlap, so a
 * modest IC of 0.10 is ~5 years of accrual away. Reporting an IC before then
 * would be the same error as Phase 4's unpassable bar, one layer up. So the
 * readiness rule is a *power condition*, not a threshold someone picked, and
 * `verdictReadiness` is what the CLI reports until that condition holds.
 *
 * One arithmetic simplification worth stating, because it removes a fork that
 * looks load-bearing: a per-day **rank** correlation is invariant to adding the
 * same constant to every name's forward return that day. So "excess vs the
 * lane's equal-weight universe" and "absolute return" produce *identical* ICs.
 * The benchmark only matters for the secondary statistic, which is therefore
 * defined without one.
 */
import { IcPoint, MIN_IC_BREADTH, icStats, neweyWestT, spearmanRank } from "./ic.js";

/** One verdict with its realized outcome. `forwardReturn` is null when the
 *  horizon runs past available history — dropped from the IC, never zeroed. */
export interface VerdictObservation {
  /** Entry date: the newest bar date at or before the run's session. */
  date: string;
  market: string;
  symbol: string;
  /** Continuous conviction in [−1, 1]. Abstains must be excluded upstream. */
  conviction: number;
  /** The screen rank this name held on the same day — the CONTROL variable.
   *
   * Measured 2026-09-11 on the 45 stored verdicts: Spearman(screen rank,
   * conviction) = **0.319** over 40 non-abstain verdicts. Not an echo (nowhere
   * near 1), so the layer carries independent information — but the two share
   * ~10 % of variance, so a positive raw conviction IC could partly be the
   * screen's own unvalidated ranking leaking through. This field is what makes
   * that attributable. */
  rank: number;
  forwardReturn: number | null;
}

/** Minimum verdicts in a day's set for its IC to be recorded. Same floor as the
 *  screen's IC series: below this a rank correlation is noise, not evidence. */
export const MIN_VERDICT_BREADTH = MIN_IC_BREADTH;

/** z for 80 % power at one-sided α = 0.05. Used to turn a target effect size
 *  into a required number of days, and vice versa. */
export const POWER_Z = 1.6449 + 0.8416;

/** Per-day Spearman IC of conviction vs forward return.
 *
 *  Absolute and benchmark-relative returns give the same value (rank
 *  invariance), so no universe definition is needed — see the header note. */
export function verdictIcSeries(observations: VerdictObservation[]): IcPoint[] {
  const byDate = new Map<string, { conviction: number; r: number }[]>();
  for (const o of observations) {
    if (o.forwardReturn == null) continue;
    const list = byDate.get(o.date) ?? [];
    list.push({ conviction: o.conviction, r: o.forwardReturn });
    byDate.set(o.date, list);
  }
  const points: IcPoint[] = [];
  for (const [date, rows] of byDate) {
    if (rows.length < MIN_VERDICT_BREADTH) continue;
    const ic = spearmanRank(rows.map((x) => x.conviction), rows.map((x) => x.r));
    // A day where every conviction is identical has no ordering to test; it is
    // skipped rather than counted as a zero-IC observation.
    if (ic == null || Number.isNaN(ic)) continue;
    points.push({ date, ic, n: rows.length });
  }
  return points.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Spearman partial correlation of x and y controlling for z.
 *
 * r_xy·z = (r_xy − r_xz·r_yz) / sqrt((1 − r_xz²)(1 − r_yz²))
 *
 * Null when a denominator vanishes (no variation to partial out).
 */
export function partialSpearman(x: number[], y: number[], z: number[]): number | null {
  const rxy = spearmanRank(x, y);
  const rxz = spearmanRank(x, z);
  const ryz = spearmanRank(y, z);
  if (rxy == null || rxz == null || ryz == null) return null;
  const denom = Math.sqrt((1 - rxz * rxz) * (1 - ryz * ryz));
  if (denom === 0) return null;
  return (rxy - rxz * ryz) / denom;
}

/**
 * Per-day conviction IC **controlling for the screen rank** — the attribution
 * statistic (Phase 5 pre-registration amendment).
 *
 * The raw IC answers "does conviction order outcomes?". This answers the
 * question the round is actually about: "does the LLM add information the screen
 * did not already have?". With rank as a control, a raw IC that is positive
 * while this is ~0 means the layer is echoing the ranking at 0.32 and nothing
 * more. Both are reported; this one is the one that decides H2.
 */
export function verdictIcSeriesControlled(observations: VerdictObservation[]): IcPoint[] {
  const byDate = new Map<string, { c: number; r: number; k: number }[]>();
  for (const o of observations) {
    if (o.forwardReturn == null || !Number.isFinite(o.rank)) continue;
    const list = byDate.get(o.date) ?? [];
    list.push({ c: o.conviction, r: o.forwardReturn, k: o.rank });
    byDate.set(o.date, list);
  }
  const points: IcPoint[] = [];
  for (const [date, rows] of byDate) {
    if (rows.length < MIN_VERDICT_BREADTH) continue;
    const ic = partialSpearman(rows.map((x) => x.c), rows.map((x) => x.r), rows.map((x) => x.k));
    if (ic == null || Number.isNaN(ic)) continue;
    points.push({ date, ic, n: rows.length });
  }
  return points.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Secondary, benchmark-free: within-day mean forward return of the
 * high-conviction half minus the low-conviction half (median split).
 *
 * This is the product-shaped question — does the conviction *ordering* sort
 * outcomes — and it needs no universe definition because both halves come from
 * the same day's set. Ties at the median are dropped rather than assigned, so a
 * day of near-identical convictions cannot manufacture a spread.
 */
export function verdictConvictionSplit(observations: VerdictObservation[], minPerSide = 3): number[] {
  const byDate = new Map<string, { conviction: number; r: number }[]>();
  for (const o of observations) {
    if (o.forwardReturn == null) continue;
    const list = byDate.get(o.date) ?? [];
    list.push({ conviction: o.conviction, r: o.forwardReturn });
    byDate.set(o.date, list);
  }
  const out: number[] = [];
  for (const rows of byDate.values()) {
    if (rows.length < minPerSide * 2) continue;
    // A day with zero conviction dispersion has no ordering to split on; it would
    // otherwise emit a mechanical 0.0 and be counted as an observation.
    const cs = rows.map((x) => x.conviction);
    if (Math.max(...cs) === Math.min(...cs)) continue;
    const sorted = [...rows].sort((a, b) => b.conviction - a.conviction);
    const mid = sorted.length / 2;
    const high = sorted.slice(0, Math.floor(mid));
    const low = sorted.slice(Math.ceil(mid));
    if (high.length < minPerSide || low.length < minPerSide) continue;
    const mean = (xs: { r: number }[]) => xs.reduce((a, x) => a + x.r, 0) / xs.length;
    out.push(mean(high) - mean(low));
  }
  return out;
}

export interface Readiness {
  /** Days with a computable IC. */
  days: number;
  /** Days needed for the power condition at the given target IC. */
  daysNeeded: number;
  decidable: boolean;
  /** NW SE of the mean IC, when it can be measured. */
  seMean: number | null;
  /** Per-day IC sd actually observed, or null below 2 days. */
  sdDay: number | null;
  /** Whether the numbers above came from the series or from theory. */
  seSource: "measured" | "theoretical";
  targetIc: number;
  /** SE the mean must reach: IC_target / POWER_Z. */
  seMax: number;
  reason: string;
}

/**
 * The per-day IC sd the projection *assumes* before the series can measure its
 * own: `1/√(breadth − 1 − controls)`. Exported so a report can print the
 * measured/theoretical ratio — Phase 4b measured that factor at 1.31× (HK) and
 * 2.16× (US), and because `daysNeeded ∝ sd²` a factor of 2 stretches the horizon
 * roughly 4×. The ratio is the number worth watching, so it is made visible
 * rather than implied.
 */
export function theoreticalSdDay(assumedBreadth: number, controls = 0): number | null {
  const df = assumedBreadth - 1 - controls;
  return df > 0 ? 1 / Math.sqrt(df) : null;
}

export interface ReadinessOptions {
  /** Breadth assumed before there is a measured sd (mean verdicts/day). */
  assumedBreadth?: number;
  /** Covariates partialled out of the statistic. The theoretical per-day SE is
   *  1/√(N−1−controls), so a rank-controlled series is slightly noisier — stated
   *  rather than silently reusing the uncontrolled figure. */
  controls?: number;
  /** Days below which the measured sd is too unstable to trust. */
  minDaysForMeasured?: number;
  /** Regime-shift guard: second-half sd / first-half sd above this ⇒ inconclusive. */
  sdStabilityRatio?: number;
}

/**
 * The pre-registered gate: decide only at ≥80 % power for `targetIc`
 * (one-sided α = 0.05), i.e. `SE(mean) ≤ targetIc / POWER_Z`.
 *
 * Until the accrued series is long enough to measure its own sd, the requirement
 * is computed from the theoretical `1/√(N−1)` per-day SE and labelled
 * `theoretical` — so the projection never pretends to be a measurement.
 */
export function verdictReadiness(
  points: IcPoint[],
  horizon: number,
  targetIc: number,
  opts: ReadinessOptions = {},
): Readiness {
  const assumedBreadth = opts.assumedBreadth ?? 10;
  const controls = opts.controls ?? 0;
  const minDays = opts.minDaysForMeasured ?? 20;
  const stabilityRatio = opts.sdStabilityRatio ?? 1.5;

  const days = points.length;
  const seMax = targetIc / POWER_Z;
  const xs = points.map((p) => p.ic);
  const sdDay = days >= 2 ? sampleSd(xs) : null;
  const measuredSe = days >= minDays ? neweyWestT(xs, horizon)?.se ?? null : null;

  const theoreticalSd = theoreticalSdDay(assumedBreadth, controls);
  const sdForProjection = measuredSe != null ? sdDay : theoreticalSd;
  const seSource: Readiness["seSource"] = measuredSe != null ? "measured" : "theoretical";

  // T needed so that SE(mean) ≈ sdDay·√(h/T) falls to seMax.
  const daysNeeded =
    sdForProjection != null ? Math.ceil(horizon * (sdForProjection / seMax) ** 2) : Number.POSITIVE_INFINITY;

  const seMean = measuredSe ?? (days >= 2 && sdDay != null ? sdDay * Math.sqrt(horizon / days) : null);
  // Only a MEASURED SE may authorise a decision. The projected value is for
  // planning: deciding on a projection from a 10-day sample is the same error as
  // Phase 4's assumed power, one layer up — and it is how a noiseless fixture can
  // look "decidable" while carrying no evidence at all.
  const powerOk = measuredSe != null && measuredSe <= seMax;

  // The stability guard needs as many days as the SE measurement does: a ratio
  // computed on 10-vs-10 days is itself noise, and firing on it would report a
  // regime shift where there is only a short sample.
  let unstable = false;
  if (days >= minDays && stabilityRatio > 0) {
    const half = Math.floor(days / 2);
    const first = sampleSd(xs.slice(0, half));
    const second = sampleSd(xs.slice(half));
    unstable = first > 0 && second / first > stabilityRatio;
  }

  const decidable = powerOk && !unstable;
  const reason = unstable
    ? `inconclusive: the second half's per-day IC sd is ${stabilityRatio}× the first half's — a regime shift, not a signal`
    : decidable
      ? `decidable: SE(mean) ${measuredSe!.toFixed(4)} ≤ ${seMax.toFixed(4)} (80 % power at IC ${targetIc}, measured se)`
      : `insufficient evidence: ${days}/${daysNeeded} days — SE(mean) ${seMean == null ? "n/a" : seMean.toFixed(4)} > ${seMax.toFixed(4)} for IC ${targetIc}${measuredSe == null ? " (projected se: not yet measurable)" : ""}`;

  return { days, daysNeeded, decidable, seMean, sdDay, seSource, targetIc, seMax, reason };
}

function sampleSd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

export type VerdictVerdict = "h2_holds" | "h2_falsified" | "insufficient_evidence";

/**
 * The verdict, which is `insufficient_evidence` unless the readiness rule is met
 * *and* the interval separates from zero.
 *
 * `insufficient_evidence` is the expected outcome for months. It is deliberately
 * not phrased as a failure: Phase 4's whole defect was a FAIL that read as a
 * negative finding when the test could not have said anything.
 */
export function verdictFor(points: IcPoint[], horizon: number, targetIc: number, opts: ReadinessOptions = {}): {
  readiness: Readiness;
  stats: ReturnType<typeof icStats>;
  verdict: VerdictVerdict;
} {
  const readiness = verdictReadiness(points, horizon, targetIc, opts);
  const stats = icStats(points, horizon);
  if (!readiness.decidable || !stats) {
    return { readiness, stats, verdict: "insufficient_evidence" };
  }
  if (stats.mean >= readiness.targetIc && stats.nwT >= 2) return { readiness, stats, verdict: "h2_holds" };
  if (stats.mean <= 0 && stats.nwT <= -2) return { readiness, stats, verdict: "h2_falsified" };
  return { readiness, stats, verdict: "insufficient_evidence" };
}
