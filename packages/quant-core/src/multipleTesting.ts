/**
 * Multiple-testing control and the luck benchmark — Phase 6A (A4).
 *
 * Phase 6A sweeps hundreds of alphas on one window. Without correction, a
 * sweep of K independent nulls produces |t| ≥ 2 about one time in twenty *by
 * construction*, so "3 of 218 alphas were significant" is not a finding — it is
 * the expected count. Two separate things are required, and they answer
 * different questions:
 *
 *  - `benjaminiHochberg` controls the **false discovery rate** across the K
 *    tests: at q = 0.05, at most 5 % of the alphas it accepts are expected to be
 *    null. It is a decision rule.
 *  - `luckBenchmark` reports the **largest |IC| a pure null sweep would be
 *    expected to produce**, `E[max|IC|] ≈ SE·√(2 ln K)`. It is a yardstick: a
 *    survivor whose |IC| sits below it is being called significant on the
 *    strength of the search rather than the signal, and the artifact prints both
 *    so the gap is visible.
 *
 * Both are ported here rather than imported from the vendor's `quantlib` so the
 * deciding arithmetic lives in-repo, with the vendored `multipletesting.py` as a
 * reference implementation rather than a runtime dependency (phase-6a fork 3).
 *
 * **Disclosed approximation.** The p-values are normal-approximation
 * (`2·(1 − Φ(|t|))`) applied to a Newey–West t-statistic with ~40-50 effective
 * degrees of freedom. The normal is therefore mildly anti-conservative in the
 * far tail — it reports smaller p-values than a t with df ≈ 45 would. Phase 6A
 * states this in every artifact and does not compensate; the alternative is a
 * t-distribution CDF, which would add a second approximation to hide the first.
 */
/**
 * Standard normal CDF via Cody-style rational `erfc`.
 *
 * Accuracy is ~1e-15 relative in double precision, which is far tighter than
 * anything the FDR decision at q = 0.05 can notice — the point of using a good
 * `erfc` rather than a table approximation is that the *tests* can then assert
 * known values instead of tolerating a loose fit.
 */
export function normalCdf(z: number): number {
  return 0.5 * erfc(-z / Math.SQRT2);
}

export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 2 / (2 + z);
  const ty = 4 * t - 2;
  const cof = [
    -1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2, -9.561514786808631e-3,
    -9.46595344482036e-4, 3.66839497852761e-4, 4.2523324806907e-5, -2.0278578112534e-5,
    -1.624290004647e-6, 1.30365583558e-6, 1.5626441722e-8, -8.5238095915e-8,
    6.529054439e-9, 5.059343495e-9, -9.91364156e-10, -2.27365122e-10,
    9.6467911e-11, 2.394038e-12, -6.886027e-12, 8.94487e-13,
    3.13092e-13, -1.12708e-13, 3.81e-16, 7.106e-15,
  ];
  let d = 0;
  let dd = 0;
  for (let j = cof.length - 1; j > 0; j--) {
    const tmp = d;
    d = ty * d - dd + cof[j]!;
    dd = tmp;
  }
  const ans = t * Math.exp(-z * z + 0.5 * (cof[0]! + ty * d) - dd);
  return x >= 0 ? ans : 2 - ans;
}

/** Two-sided normal p-value for a t-statistic. Non-finite input ⇒ null. */
export function twoSidedP(t: number): number | null {
  if (!Number.isFinite(t)) return null;
  return Math.min(1, Math.max(0, erfc(Math.abs(t) / Math.SQRT2)));
}

/** One-sided p-value for "IC ≤ 0 given the sign we observed" — not used by the
 *  gate (which is two-sided), kept because the luck benchmark is stated in
 *  |IC| and a reader will want it. */
export function oneSidedP(t: number): number | null {
  if (!Number.isFinite(t)) return null;
  return Math.min(1, Math.max(0, 0.5 * erfc(t / Math.SQRT2)));
}

export interface BhResult {
  /** Number of tests offered (finite p-values only). */
  k: number;
  q: number;
  /** BH-adjusted p-values, in the input's order; null where the input was null. */
  adjusted: (number | null)[];
  rejected: boolean[];
  /** Largest index in sorted order that satisfies p_(i) ≤ (i/k)·q, or 0. */
  cutoffRank: number;
  /** The p-value at the cutoff, or null when nothing was rejected. */
  cutoffP: number | null;
  /** Number rejected. */
  discoveries: number;
}

/**
 * Benjamini–Hochberg step-up at level `q`.
 *
 * Rejects the `i` smallest p-values for the largest `i` with
 * `p_(i) ≤ (i/k)·q`. Adjusted p-values are the standard step-up
 * `p̃_(i) = min_{j ≥ i} (k/j)·p_(j)`, monotonised and capped at 1, so they can be
 * compared directly against `q`.
 *
 * Null (non-finite) p-values are excluded from `k` and never rejected: an alpha
 * whose statistic could not be computed is not evidence in either direction, and
 * silently treating it as p = 1 would inflate `k` and weaken the correction.
 */
export function benjaminiHochberg(pValues: (number | null)[], q: number): BhResult {
  const finite: { p: number; i: number }[] = [];
  pValues.forEach((p, i) => {
    if (p != null && Number.isFinite(p)) finite.push({ p, i });
  });
  const k = finite.length;
  const rejected = new Array<boolean>(pValues.length).fill(false);
  const adjusted = new Array<number | null>(pValues.length).fill(null);
  if (k === 0) return { k, q, adjusted, rejected, cutoffRank: 0, cutoffP: null, discoveries: 0 };

  const sorted = [...finite].sort((a, b) => a.p - b.p || a.i - b.i);
  let cutoffRank = 0;
  for (let i = 0; i < k; i++) {
    if (sorted[i]!.p <= ((i + 1) / k) * q) cutoffRank = i + 1;
  }
  // Monotone envelope from the largest p downwards.
  let running = 1;
  for (let i = k - 1; i >= 0; i--) {
    running = Math.min(running, (k / (i + 1)) * sorted[i]!.p);
    adjusted[sorted[i]!.i] = Math.min(1, running);
  }
  for (let i = 0; i < cutoffRank; i++) rejected[sorted[i]!.i] = true;
  return {
    k,
    q,
    adjusted,
    rejected,
    cutoffRank,
    cutoffP: cutoffRank > 0 ? sorted[cutoffRank - 1]!.p : null,
    discoveries: cutoffRank,
  };
}

/**
 * `E[max|IC|] ≈ SE·√(2 ln K)` — the largest |IC| a sweep of K independent nulls
 * is expected to produce at *this* lane's standard error.
 *
 * Two honest caveats travel with the number:
 *  - It is an asymptotic order-statistic approximation, not an exact expectation.
 *  - The sweep's alphas are **correlated**, so the effective number of
 *    independent trials is smaller than K. Using K therefore *overstates* the
 *    benchmark, i.e. it is conservative — harder to pass, which is the direction
 *    the phase's pre-registration prefers.
 *
 * Returns null for K < 2 (the maximum of one draw is not a multiple-testing
 * statement) or a non-positive SE.
 */
export function luckBenchmark(k: number, se: number): number | null {
  if (!Number.isFinite(k) || !Number.isFinite(se) || k < 2 || se <= 0) return null;
  return se * Math.sqrt(2 * Math.log(k));
}

/** `E[max|IC|]` computed from a set of IC standard errors: the sweep's own SE is
 *  the pooled one, so the benchmark is stated once per lane, not per alpha. */
export function luckBenchmarkFromSes(ses: number[]): number | null {
  const finite = ses.filter((s) => Number.isFinite(s) && s > 0);
  if (finite.length < 2) return null;
  const mean = finite.reduce((a, b) => a + b, 0) / finite.length;
  return luckBenchmark(finite.length, mean);
}
