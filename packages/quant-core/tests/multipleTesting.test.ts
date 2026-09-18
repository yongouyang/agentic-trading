/**
 * Phase 6A A4 — multiple-testing control and the luck benchmark.
 *
 * The two things tested here are the ones a reader will trust without
 * re-deriving: that the FDR rule really is BH (so "surviving at q = 0.05" means
 * what the plan says), and that the normal approximation is good enough that the
 * p-values are not the weak link.
 */
import { describe, expect, it } from "vitest";
import {
  benjaminiHochberg,
  erfc,
  luckBenchmark,
  luckBenchmarkFromSes,
  normalCdf,
  oneSidedP,
  twoSidedP,
} from "../src/multipleTesting.js";

describe("normal approximation", () => {
  it("matches known Φ values to double precision", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 14);
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021048517795, 12);
    expect(normalCdf(-1.96)).toBeCloseTo(0.024997895148220435, 12);
    expect(normalCdf(2.5758293035489004)).toBeCloseTo(0.995, 12);
    expect(normalCdf(3)).toBeCloseTo(0.9986501019683699, 12);
    expect(normalCdf(-3)).toBeCloseTo(0.0013498980316300946, 12);
  });

  it("is symmetric and monotone", () => {
    for (const z of [0.1, 0.7, 1.3, 2.2, 4.5]) {
      expect(normalCdf(z) + normalCdf(-z)).toBeCloseTo(1, 14);
    }
    expect(normalCdf(0.4)).toBeLessThan(normalCdf(0.5));
  });

  it("erfc carries the two-sided p-value, including the 5% and 1% anchors", () => {
    expect(erfc(0)).toBeCloseTo(1, 14);
    expect(twoSidedP(0)).toBe(1);
    expect(twoSidedP(1.959963984540054)).toBeCloseTo(0.05, 10);
    expect(twoSidedP(2.5758293035489004)).toBeCloseTo(0.01, 10);
    expect(twoSidedP(-2.5758293035489004)).toBeCloseTo(0.01, 10);
    // Non-finite input is "no statistic", not a p-value.
    expect(twoSidedP(Number.NaN)).toBeNull();
    expect(twoSidedP(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("one-sided is half the two-sided value", () => {
    expect(oneSidedP(1.96)!.valueOf()).toBeCloseTo(twoSidedP(1.96)! / 2, 12);
  });
});

describe("Benjamini-Hochberg", () => {
  // The 1995 paper's own worked example (k = 15, q = 0.05): the four smallest
  // p-values pass the step-up, the fifth (0.0201 > 5/15·0.05) does not.
  const classic = [0.0001, 0.0004, 0.0019, 0.0095, 0.0201, 0.0278, 0.0298, 0.0344, 0.0459, 0.324, 0.4262, 0.5719, 0.6528, 0.759, 1];

  it("reproduces the textbook cutoff at q = 0.05", () => {
    const bh = benjaminiHochberg(classic, 0.05);
    expect(bh.k).toBe(15);
    expect(bh.cutoffRank).toBe(4);
    expect(bh.discoveries).toBe(4);
    expect(bh.cutoffP).toBeCloseTo(0.0095, 12);
    expect(bh.rejected.slice(0, 4)).toEqual([true, true, true, true]);
    expect(bh.rejected.slice(4).some(Boolean)).toBe(false);
  });

  it("gives step-up adjusted p-values that are monotone in the sorted order and ≥ p", () => {
    const bh = benjaminiHochberg(classic, 0.05);
    const pairs = classic.map((p, i) => ({ p, adj: bh.adjusted[i]! })).sort((a, b) => a.p - b.p);
    for (let i = 0; i < pairs.length; i++) {
      expect(pairs[i]!.adj).toBeGreaterThanOrEqual(pairs[i]!.p - 1e-12);
      if (i > 0) expect(pairs[i]!.adj).toBeGreaterThanOrEqual(pairs[i - 1]!.adj - 1e-12);
    }
    // The first adjusted value is min_j (k/j)·p_(j), which here is (15/1)·0.0001.
    expect(pairs[0]!.adj).toBeCloseTo(0.0015, 12);
  });

  it("is a monotone decision rule in q: a larger q rejects a superset", () => {
    const tight = benjaminiHochberg(classic, 0.01);
    const loose = benjaminiHochberg(classic, 0.05);
    expect(tight.cutoffRank).toBeLessThanOrEqual(loose.cutoffRank);
    for (let i = 0; i < classic.length; i++) {
      if (tight.rejected[i]) expect(loose.rejected[i]).toBe(true);
    }
    // q = 0.01: i=1 → 0.0006667 (0.0001 ✓), i=2 → 0.001333 (0.0004 ✓),
    // i=3 → 0.002 (0.0019 ✓), i=4 → 0.002667 (0.0095 ✗) ⇒ 3.
    expect(tight.cutoffRank).toBe(3);
  });

  it("p-values are scale-free but the decision is not: the same number at two q's", () => {
    expect(benjaminiHochberg([0.04], 0.05).discoveries).toBe(1);
    expect(benjaminiHochberg([0.04], 0.01).discoveries).toBe(0);
  });

  it("excludes non-finite p-values from k rather than treating them as p = 1", () => {
    const bh = benjaminiHochberg([0.01, null, Number.NaN, Number.POSITIVE_INFINITY], 0.05);
    expect(bh.k).toBe(1);
    expect(bh.rejected).toEqual([true, false, false, false]);
    expect(bh.adjusted[1]).toBeNull();
  });

  it("handles the degenerate inputs without inventing a discovery", () => {
    const empty = benjaminiHochberg([], 0.05);
    expect(empty).toMatchObject({ k: 0, discoveries: 0, cutoffRank: 0, cutoffP: null });
    const allBig = benjaminiHochberg([0.5, 0.6, 0.7, 0.8], 0.05);
    expect(allBig.discoveries).toBe(0);
    expect(allBig.rejected.some(Boolean)).toBe(false);
    // k = 1: the step-up threshold is (1/1)·q, the least aggressive case.
    expect(benjaminiHochberg([0.049], 0.05).discoveries).toBe(1);
    expect(benjaminiHochberg([0.051], 0.05).discoveries).toBe(0);
  });

  it("caps adjusted p-values at 1", () => {
    const bh = benjaminiHochberg([1, 1, 1], 0.05);
    expect(bh.adjusted.every((a) => a === 1)).toBe(true);
    expect(bh.discoveries).toBe(0);
  });
});

describe("luck benchmark — E[max|IC|] under the null", () => {
  it("is SE·√(2 ln K)", () => {
    expect(luckBenchmark(2, 0.01)).toBeCloseTo(0.01 * Math.sqrt(2 * Math.log(2)), 12);
    expect(luckBenchmark(218, 0.01486)!.valueOf()).toBeCloseTo(0.01486 * Math.sqrt(2 * Math.log(218)), 12);
  });

  it("grows with the number of trials and with the lane's SE", () => {
    expect(luckBenchmark(218, 0.01)!).toBeGreaterThan(luckBenchmark(20, 0.01)!);
    expect(luckBenchmark(218, 0.02)!).toBeGreaterThan(luckBenchmark(218, 0.01)!);
  });

  it("declines to state a benchmark it cannot: K < 2 or a non-positive SE", () => {
    expect(luckBenchmark(1, 0.01)).toBeNull();
    expect(luckBenchmark(0, 0.01)).toBeNull();
    expect(luckBenchmark(100, 0)).toBeNull();
    expect(luckBenchmark(100, Number.NaN)).toBeNull();
    expect(luckBenchmarkFromSes([0.01])).toBeNull();
    expect(luckBenchmarkFromSes([0.01, Number.NaN, 0])).toBeNull();
  });

  it("states the sweep's benchmark once per lane, from the mean SE and K", () => {
    const ses = [0.01, 0.02, 0.03];
    expect(luckBenchmarkFromSes(ses)).toBeCloseTo(luckBenchmark(3, 0.02)!, 12);
  });

  it("is the yardstick the plan says it is: on the picker window it exceeds the bar", () => {
    // US realized NW SE 0.01486 over 218 alphas — the number A6 will print.
    const luck = luckBenchmark(218, 0.01486)!;
    expect(luck).toBeGreaterThan(0.01486 * 1.96);
    expect(luck).toBeLessThan(0.06);
  });
});
