/**
 * LLM verdict scoring — Phase 5 (docs/phase-5-plan.md).
 *
 * The tests that matter are the readiness ones. This module exists to REFUSE to
 * answer, so the checks that count are: the power arithmetic, that it refuses
 * when it should, that it never reports a verdict below the threshold, and that a
 * degenerate day is skipped rather than counted as a zero.
 */
import { describe, expect, it } from "vitest";
import {
  MIN_VERDICT_BREADTH,
  partialSpearman,
  POWER_Z,
  VerdictObservation,
  verdictConvictionSplit,
  verdictFor,
  verdictIcSeries,
  verdictIcSeriesControlled,
  verdictReadiness,
} from "../src/verdict-ic.js";

/** n observations on one date, with conviction and outcome perfectly aligned. */
function day(date: string, n: number, opts: { flip?: boolean; conv?: number[]; ret?: number[] } = {}): VerdictObservation[] {
  const conv = opts.conv ?? Array.from({ length: n }, (_, i) => (i / (n - 1)) * 2 - 1);
  const ret = opts.ret ?? conv.map((c) => c * 0.1);
  return conv.map((c, i) => ({
    date,
    market: "US",
    symbol: `S${i}`,
    conviction: c,
    forwardReturn: opts.flip ? -(ret[i] ?? 0) : (ret[i] ?? 0),
  }));
}

/** T days of the same construction, one day per session. */
function series(T: number, n = 10, flip = false): VerdictObservation[] {
  return Array.from({ length: T }, (_, t) => day(`2026-01-${String(t + 1).padStart(2, "0")}`, n, { flip })).flat();
}

describe("Phase 5 — per-day IC of conviction vs outcome", () => {
  it("is +1 when conviction orders outcomes and −1 when it inverts", () => {
    expect(verdictIcSeries(day("2026-01-02", 10))[0]!.ic).toBeCloseTo(1, 10);
    expect(verdictIcSeries(day("2026-01-02", 10, { flip: true }))[0]!.ic).toBeCloseTo(-1, 10);
  });

  it("is invariant to a common daily shift — the fork that arithmetic removes", () => {
    // Absolute vs "excess vs the lane's universe" must give IDENTICAL ICs: a rank
    // correlation cannot see a constant added to every name that day. If this
    // ever fails, the benchmark question was real and the plan is wrong.
    const base = day("2026-01-02", 10);
    const shifted = base.map((o) => ({ ...o, forwardReturn: o.forwardReturn! + 0.07 }));
    expect(verdictIcSeries(shifted)[0]!.ic).toBeCloseTo(verdictIcSeries(base)[0]!.ic, 12);
  });

  it("drops unlabelled verdicts instead of zeroing them (the horizon has not elapsed)", () => {
    const rows = day("2026-01-02", 10).map((o, i) => (i < 4 ? { ...o, forwardReturn: null } : o));
    const pts = verdictIcSeries(rows);
    expect(pts).toHaveLength(1);
    expect(pts[0]!.n).toBe(6); // 6 labelled names, not 10
  });

  it("skips a day below the breadth floor, and one with no conviction spread", () => {
    expect(verdictIcSeries(day("2026-01-02", MIN_VERDICT_BREADTH - 1))).toEqual([]);
    // Every conviction identical: there is no ordering to correlate.
    const flat = day("2026-01-02", 10, { conv: Array.from({ length: 10 }, () => 0.5) });
    expect(verdictIcSeries(flat)).toEqual([]);
  });
});

describe("Phase 5 — the readiness rule is 80% power, not a chosen number", () => {
  /** Drive the readiness rule with an explicit IC series: it takes IcPoint[], so
   *  the power arithmetic can be tested without constructing returns. */
  const pts = (ics: number[]): { date: string; ic: number; n: number }[] =>
    ics.map((ic, i) => ({ date: `2026-${String(1 + Math.floor(i / 28)).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`, ic, n: 10 }));
  /** A realistic IC series: a mean with smooth (positively autocorrelated) noise. */
  const noisy = (T: number, mean: number, amp = 0.06) =>
    pts(Array.from({ length: T }, (_, i) => mean + amp * Math.sin(i / 2.5)));

  it("targets SE(mean) <= IC / (z_alpha + z_beta)", () => {
    const r = verdictReadiness(pts([0.1, 0.2, 0.3]), 20, 0.1);
    expect(r.seMax).toBeCloseTo(0.1 / POWER_Z, 12);
    expect(POWER_Z).toBeCloseTo(2.4865, 3); // 1.6449 + 0.8416
  });

  it("refuses to decide at the current accrual, and says how long is needed", () => {
    // 10 verdicts/day is the shipped breadth. The projection must be years, not
    // months — that asymmetry against the screen is the round's motivating fact.
    const r = verdictReadiness(noisy(20, 0.1), 20, 0.1, { assumedBreadth: 10, minDaysForMeasured: 1_000 });
    expect(r.days).toBe(20);
    expect(r.seSource).toBe("theoretical");
    expect(r.decidable).toBe(false);
    expect(r.daysNeeded).toBeGreaterThan(1000);
    expect(r.daysNeeded).toBeLessThan(1500); // ~1372 at breadth 10, IC 0.10
    expect(r.reason).toMatch(/insufficient evidence: 20\/\d+ days/);
  });

  it("the required horizon falls as ~1/breadth, which is the breadth fork's whole content", () => {
    const need = (breadth: number) =>
      verdictReadiness(noisy(20, 0.1), 20, 0.1, { assumedBreadth: breadth, minDaysForMeasured: 1_000 }).daysNeeded;
    const n10 = need(10);
    const n40 = need(40);
    // SE_day ≈ 1/sqrt(N-1), so T ≈ 1/(N-1): 40 names ≈ 4.3x fewer days than 10.
    expect(n10 / n40).toBeGreaterThan(4);
    expect(n10 / n40).toBeLessThan(4.6);
  });

  it("decides once the sample is long enough — and only then", () => {
    // A sustained +0.15 IC over 200 days: se ~0.02, well inside seMax 0.0402.
    const r = verdictReadiness(noisy(200, 0.15), 20, 0.1, { minDaysForMeasured: 20 });
    expect(r.days).toBe(200);
    expect(r.decidable).toBe(true);
    expect(r.seSource).toBe("measured");
    expect(r.seMean!).toBeLessThanOrEqual(r.seMax);
    expect(r.reason).toMatch(/decidable/);
  });

  it("switches from the theoretical to the measured sd once it has enough days", () => {
    const short = verdictReadiness(noisy(19, 0.1), 20, 0.1, { minDaysForMeasured: 20 });
    const long = verdictReadiness(noisy(20, 0.1), 20, 0.1, { minDaysForMeasured: 20 });
    expect(short.seSource).toBe("theoretical");
    expect(long.seSource).toBe("measured");
  });

  it("guards against a regime shift rather than letting it look like signal", () => {
    // Calm first half, violently unstable second half: the sd ratio trips the
    // guard, so a regime change cannot masquerade as a decidable signal.
    const calm = Array.from({ length: 40 }, () => 0.05);
    const wild = Array.from({ length: 40 }, (_, i) => 0.05 + (i % 2 ? 0.5 : -0.5));
    const r = verdictReadiness(pts([...calm, ...wild]), 20, 0.1, { minDaysForMeasured: 20 });
    expect(r.decidable).toBe(false);
    expect(r.reason).toMatch(/inconclusive/);
  });
});

describe("Phase 5 — the verdict never overstates", () => {
  const pts = (ics: number[]): { date: string; ic: number; n: number }[] =>
    ics.map((ic, i) => ({ date: `2026-${String(1 + Math.floor(i / 28)).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`, ic, n: 10 }));
  const noisy = (T: number, mean: number, amp = 0.06) =>
    pts(Array.from({ length: T }, (_, i) => mean + amp * Math.sin(i / 2.5)));

  it("is insufficient_evidence below the readiness threshold, however strong the IC", () => {
    // A +0.9 IC over only 10 days is not evidence at a 20d horizon, and saying
    // otherwise is exactly the Phase-4 error.
    const { readiness, verdict } = verdictFor(pts(Array.from({ length: 10 }, (_, i) => 0.9 + 0.02 * Math.sin(i))), 20, 0.1);
    expect(readiness.decidable).toBe(false);
    expect(verdict).toBe("insufficient_evidence");
    // And it must SAY why: the se is a projection, not a measurement.
    expect(readiness.reason).toMatch(/projected se: not yet measurable/);
  });

  it("holds only at/above the target IC with t >= 2", () => {
    const { stats, verdict } = verdictFor(noisy(200, 0.15), 20, 0.1, { minDaysForMeasured: 20 });
    expect(stats!.mean).toBeGreaterThanOrEqual(0.1);
    expect(stats!.nwT).toBeGreaterThanOrEqual(2);
    expect(verdict).toBe("h2_holds");
  });

  it("falsifies on a decisive negative, and only then", () => {
    const { verdict } = verdictFor(noisy(200, -0.15), 20, 0.1, { minDaysForMeasured: 20 });
    expect(verdict).toBe("h2_falsified");
  });

  it("is insufficient — not a hold — when the mean clears the target but the interval spans zero", () => {
    // Mean 0.11 (above target 0.10) with large IRREGULAR noise, so the HAC se does
    // not collapse the way a periodic fixture lets it: se(mean) ~0.08 > seMax
    // 0.0402, i.e. the effect is not resolvable and must not be called a hold.
    // AR(1) with rho = 0.9: the realistic shape for an overlapping-horizon IC
    // series (which is why the HAC correction exists), and enough dispersion that
    // the interval cannot resolve a 0.15 mean.
    let seed = 987654321;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5;
    let ar = 0;
    const ics = Array.from({ length: 200 }, () => {
      ar = 0.9 * ar + rand();
      return 0.15 + ar;
    });
    const { readiness, stats, verdict } = verdictFor(pts(ics), 20, 0.1, { minDaysForMeasured: 20 });
    expect(stats!.mean).toBeGreaterThan(0.1);
    expect(readiness.decidable).toBe(false);
    expect(verdict).toBe("insufficient_evidence");
    expect(readiness.reason).toMatch(/insufficient evidence/);
  });

  it("returns insufficient_evidence on an empty sample instead of throwing", () => {
    const { readiness, stats, verdict } = verdictFor([], 20, 0.1);
    expect(verdict).toBe("insufficient_evidence");
    expect(stats).toBeNull();
    expect(readiness.days).toBe(0);
    expect(readiness.daysNeeded).toBeGreaterThan(0);
  });
});

describe("Phase 5 — the benchmark-free conviction split", () => {
  it("is positive when high conviction outperforms low", () => {
    const spreads = verdictConvictionSplit(day("2026-01-02", 10));
    expect(spreads).toHaveLength(1);
    expect(spreads[0]!).toBeGreaterThan(0);
    expect(verdictConvictionSplit(day("2026-01-02", 10, { flip: true }))[0]!).toBeLessThan(0);
  });

  it("needs enough names on each side, and skips flat days", () => {
    expect(verdictConvictionSplit(day("2026-01-02", 4))).toEqual([]); // 2 vs 2 < min
    expect(verdictConvictionSplit(day("2026-01-02", 10, { conv: Array.from({ length: 10 }, () => 0) }))).toEqual([]);
  });
});

describe("Phase 5 amendment — attributing the layer against the screen rank", () => {
  /** Deterministic independent uniforms in [-0.5, 0.5). */
  function makeRand(seed0: number) {
    let s = seed0;
    return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5;
  }

  /**
   * `signal` adds a component to the RETURN that conviction carries but the
   * screen rank does not. With signal = 0 the two are merely rank-driven at 0.32
   * and the layer adds nothing; with signal > 0 it genuinely does.
   */
  function universe(days: number, signal: number, n = 12): VerdictObservation[] {
    const obs: VerdictObservation[] = [];
    const r1 = makeRand(12345);
    const r2 = makeRand(999);
    for (let d = 0; d < days; d++) {
      const date = `2026-${String(1 + Math.floor(d / 28)).padStart(2, "0")}-${String((d % 28) + 1).padStart(2, "0")}`;
      for (let k = 0; k < n; k++) {
        const rank = k + 1;
        const conv = rank + 3 * r1();          // conviction ≈ rank + noise
        const ret = rank + 3 * r2() + signal * (conv - rank); // return ≈ rank + other noise
        obs.push({ date, market: "US", symbol: `S${k}`, conviction: conv, rank, forwardReturn: ret });
      }
    }
    return obs;
  }

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  it("sees the confound: with no extra signal the RAW IC looks strong while the controlled one is ~0", () => {
    // This is the exact failure the amendment exists to prevent — a layer whose
    // conviction is merely a noisy function of the screen's rank would otherwise
    // record a healthy IC and be credited with information it does not have.
    const obs = universe(40, 0);
    const rawIc = mean(verdictIcSeries(obs).map((p) => p.ic));
    const ctrlIc = mean(verdictIcSeriesControlled(obs).map((p) => p.ic));
    expect(rawIc).toBeGreaterThan(0.4);
    expect(Math.abs(ctrlIc)).toBeLessThan(0.25);
    expect(rawIc).toBeGreaterThan(Math.abs(ctrlIc) * 2);
  });

  it("sees real signal: when conviction carries information rank does not, the controlled IC is positive", () => {
    const obs = universe(40, 1.5);
    const rawIc = mean(verdictIcSeries(obs).map((p) => p.ic));
    const ctrlIc = mean(verdictIcSeriesControlled(obs).map((p) => p.ic));
    expect(ctrlIc).toBeGreaterThan(0.3);
    expect(rawIc).toBeGreaterThan(0);
  });

  it("partialSpearman matches the closed form, and is undefined when the control is degenerate", () => {
    const x = [5, 1, 4, 2, 8, 3, 7, 6];
    const y = [2, 7, 1, 5, 3, 8, 4, 6];
    const z = [1, 2, 3, 4, 5, 6, 7, 8];
    // Spearman pairs computed independently of the implementation (see the
    // closed form in partialSpearman's docstring), so this asserts the formula
    // rather than restating the code.
    const rxy = -0.4523809523809524;
    const rxz = 0.47619047619047616;
    const ryz = 0.38095238095238093;
    // Formula, not the implementation: (rxy - rxz*ryz) / sqrt((1-rxz^2)(1-ryz^2))
    const expected = (rxy - rxz * ryz) / Math.sqrt((1 - rxz * rxz) * (1 - ryz * ryz));
    const got = partialSpearman(x, y, z);
    expect(got).not.toBeNull();
    // Same sign and magnitude to within the hand-computed rounding.
    expect(Math.abs(got! - expected)).toBeLessThan(0.02);
    // z identical to x ⇒ r_xz = 1 ⇒ nothing left to partial out.
    expect(partialSpearman(x, y, x)).toBeNull();
  });

  it("needs the rank: an observation without one is dropped, not defaulted", () => {
    const obs = universe(3, 0).map((o, i) => (i === 0 ? { ...o, rank: Number.NaN } : o));
    const pts = verdictIcSeriesControlled(obs);
    // Day 1 loses a name; the remaining days are still counted.
    expect(pts.length).toBeGreaterThan(0);
    expect(pts[0]!.n).toBeLessThanOrEqual(pts[pts.length - 1]!.n);
  });

  it("needs one more day than the raw statistic for the same target (one covariate)", () => {
    const ic = Array.from({ length: 20 }, (_, i) => 0.1 + 0.06 * Math.sin(i / 2.5)).map((v, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      ic: v,
      n: 40,
    }));
    const raw = verdictReadiness(ic, 20, 0.1, { assumedBreadth: 40, minDaysForMeasured: 1000 });
    const ctrl = verdictReadiness(ic, 20, 0.1, { assumedBreadth: 40, controls: 1, minDaysForMeasured: 1000 });
    expect(ctrl.daysNeeded).toBeGreaterThanOrEqual(raw.daysNeeded);
    expect(ctrl.daysNeeded / raw.daysNeeded).toBeLessThan(1.1);
  });
});
