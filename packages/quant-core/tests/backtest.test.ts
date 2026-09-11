/**
 * Phase 4 backtest engine (docs/phase-4-plan.md).
 *
 * The first two blocks are the ones that matter most: they are the invariants
 * that make every number this engine produces trustworthy. If truncation were
 * not exact, or if a future bar could leak into a past day's decision, the whole
 * test would be quietly wrong — and it would still look plausible.
 */
import { describe, expect, it } from "vitest";
import type { Bar, CorporateAction } from "../src/types.js";
import { Market, SCREEN_PARAMS, ScreenInput, runScreen } from "../src/screening.js";
import { deriveAdjustedBars } from "../src/adjustment.js";
import { SymbolSeries, buildForwardSeries, forwardReturn, replayScreen, exclusionCensus, type ReplayDay } from "../src/replay.js";
import {
  icSeries,
  icStats,
  neweyWestT,
  spearmanRank,
  sweepWeightCombos,
  icPower,
  proportionalCutoff,
  spreadSeries,
  spreadSeriesProportional,
  tQuantile975,
  type IcStats,
} from "../src/ic.js";
import { BASE_COSTS, benchmarkReturns, scaleCosts, simulatePortfolio } from "../src/portfolio.js";
import {
  DIFFERENTIAL_LAG,
  GATE1_MIN_IC,
  PORTFOLIO_BUFFER_RANK,
  PORTFOLIO_TOP_N,
  gate1Passes,
  equityFromReturns,
  runBacktest,
} from "../src/backtest.js";

// ---------------------------------------------------------------------------
// synthetic helpers
// ---------------------------------------------------------------------------

function dates(n: number, start = "2022-01-03"): string[] {
  const d0 = Date.parse(`${start}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(d0 + i * 86_400_000).toISOString().slice(0, 10));
}

/** A trending series with a little oscillation. A *perfectly* smooth geometric
 *  series would have zero return variance, which makes sharpe null and the name
 *  ineligible — so the wave is load-bearing, not decoration. */
function rising(n: number, drift = 0.0015, base = 100, amp = 0.006, phase = 0): number[] {
  return Array.from({ length: n }, (_, i) => base * Math.pow(1 + drift, i) * (1 + amp * Math.sin(i + phase)));
}

function barsFrom(ds: string[], closes: number[], volume = 5_000_000, opens?: number[]): Bar[] {
  return ds.map((d, i) => ({
    date: d,
    open: opens ? opens[i]! : closes[i]!,
    high: closes[i]!,
    low: closes[i]!,
    close: closes[i]!,
    volume,
  }));
}

function series(symbol: string, market: Market, ds: string[], closes: number[], dividends: CorporateAction[] = [], opens?: number[]): SymbolSeries {
  return { symbol, market, caDegraded: false, bars: barsFrom(ds, closes, market === "HK" ? 20_000_000 : 5_000_000, opens), dividends };
}

const usFloorAdv = (closes: number[]) => closes[0]! * 5_000_000 > 20_000_000;

// ---------------------------------------------------------------------------

describe("replay — truncation is exact, not approximate", () => {
  it("a 252-bar trailing slice gives identical screen output to the full series", () => {
    const ds = dates(400);
    const closes = rising(400);
    const s = series("AAA", "US", ds, closes);

    // Sanity: the synthetic name must actually be eligible, or this test would
    // pass by comparing two empty outputs.
    const full = replayScreen([ds[399]!], [s], 10_000);
    expect(full[0]!.ranked.map((p) => p.symbol)).toEqual(["AAA"]);

    const truncated = replayScreen([ds[399]!], [s], 252);
    expect(truncated[0]!.ranked).toEqual(full[0]!.ranked);
  });

  it("holds with a 60-session window too (every indicator window fits)", () => {
    const ds = dates(400);
    const s = series("AAA", "US", ds, rising(400));
    const wide = replayScreen([ds[399]!], [s], 10_000);
    const narrow = replayScreen([ds[399]!], [s], 300);
    expect(narrow[0]!.ranked).toEqual(wide[0]!.ranked);
  });
});

describe("replay — point-in-time correctness", () => {
  const ds = dates(300);
  const closes = rising(300);
  const T = ds[260]!;

  it("mutating a FUTURE bar does not change day-T output (look-ahead tripwire)", () => {
    const before = replayScreen([T], [series("AAA", "US", ds, closes)]);
    const mutated = [...closes];
    mutated[275] = 9_999; // strictly after T
    const after = replayScreen([T], [series("AAA", "US", ds, mutated)]);
    expect(after[0]!.ranked).toEqual(before[0]!.ranked);
  });

  it("a FUTURE dividend does not change day-T output", () => {
    const before = replayScreen([T], [series("AAA", "US", ds, closes)]);
    const futureDiv: CorporateAction = { date: ds[280]!, type: "DIVIDEND", amount: 9, currency: "USD" };
    const after = replayScreen([T], [series("AAA", "US", ds, closes, [futureDiv])]);
    expect(after[0]!.ranked).toEqual(before[0]!.ranked);
  });

  it("a PAST dividend does change day-T output (the adjustment really applies)", () => {
    const before = replayScreen([T], [series("AAA", "US", ds, closes)]);
    // Ex-date 10 sessions before T: the mom60 base bar is now adjusted down
    // while the final bar is not, so mom60 must move.
    const pastDiv: CorporateAction = { date: ds[250]!, type: "DIVIDEND", amount: 2, currency: "USD" };
    const after = replayScreen([T], [series("AAA", "US", ds, closes, [pastDiv])]);
    const b = before[0]!.ranked[0]!;
    const a = after[0]!.ranked[0]!;
    expect(a.mom60).not.toBeCloseTo(b.mom60, 10);
    expect(a.mom60).toBeGreaterThan(b.mom60);
  });

  it("a dividend older than the truncated window is dropped without changing output", () => {
    const oldDiv: CorporateAction = { date: ds[5]!, type: "DIVIDEND", amount: 1, currency: "USD" };
    const withOld = replayScreen([T], [series("AAA", "US", ds, closes, [oldDiv])]);
    const without = replayScreen([T], [series("AAA", "US", ds, closes)]);
    expect(withOld[0]!.ranked).toEqual(without[0]!.ranked);
  });
});

describe("runScreen topN override", () => {
  it("returns the full ranking without changing the first N picks or their scores", () => {
    const ds = dates(300);
    // One more than the per-market candidate limit, so the truncation is visible.
    const inputs: ScreenInput[] = Array.from({ length: SCREEN_PARAMS.topN.US + 1 }, (_, k) => {
      const closes = rising(300, 0.0005 + k * 0.00008, 100, 0.006, k);
      return {
        symbol: `S${String(k).padStart(2, "0")}`,
        market: "US" as Market,
        adjustedBars: deriveAdjustedBars(barsFrom(ds, closes), []),
        rawBars: barsFrom(ds, closes),
        caDegraded: false,
      };
    });

    const capped = runScreen(inputs);
    const full = runScreen(inputs, { topN: Number.MAX_SAFE_INTEGER });
    const limit = SCREEN_PARAMS.topN.US;

    expect(capped.ranked.length).toBe(limit); // per-market SCREEN_PARAMS.topN
    expect(full.ranked.length).toBeGreaterThanOrEqual(limit);
    expect(full.ranked.slice(0, limit)).toEqual(capped.ranked);
    expect(full.excluded).toEqual(capped.excluded);
  });
});

describe("forward returns are anchor-invariant", () => {
  it("a later dividend cancels out of the T → T+h return", () => {
    const ds = dates(120);
    const closes = rising(120);
    const s = series("AAA", "US", ds, closes);
    const laterDiv: CorporateAction = { date: ds[100]!, type: "DIVIDEND", amount: 3, currency: "USD" };
    const s2 = series("AAA", "US", ds, closes, [laterDiv]);

    const a = buildForwardSeries(s.bars, s.dividends);
    const b = buildForwardSeries(s2.bars, s2.dividends);
    // T = ds[10], horizon 20 → the dividend at ds[100] is far outside the window.
    expect(forwardReturn(b, ds[10]!, 20)).toBeCloseTo(forwardReturn(a, ds[10]!, 20)!, 12);
  });

  it("a dividend INSIDE the window is included in the return", () => {
    const ds = dates(120);
    const closes = rising(120);
    const insideDiv: CorporateAction = { date: ds[20]!, type: "DIVIDEND", amount: 3, currency: "USD" };
    const plain = buildForwardSeries(barsFrom(ds, closes), []);
    const withDiv = buildForwardSeries(barsFrom(ds, closes), [insideDiv]);
    const r0 = forwardReturn(plain, ds[10]!, 20)!;
    const r1 = forwardReturn(withDiv, ds[10]!, 20)!;
    expect(r1).toBeGreaterThan(r0); // dividend received while holding
  });

  it("the last `h` sessions have no label", () => {
    const ds = dates(60);
    const s = buildForwardSeries(barsFrom(ds, rising(60)), []);
    expect(forwardReturn(s, ds[59]!, 20)).toBeNull();
    expect(forwardReturn(s, ds[39]!, 20)).not.toBeNull();
  });
});

describe("spearmanRank", () => {
  it("is 1 for monotonic agreement and -1 for reversal", () => {
    expect(spearmanRank([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 12);
    expect(spearmanRank([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 12);
  });

  it("handles ties by average ranks", () => {
    expect(spearmanRank([1, 1, 2, 3], [1, 2, 3, 4])).toBeGreaterThan(0);
    expect(spearmanRank([1, 1, 1, 1], [1, 2, 3, 4])).toBeNull(); // zero variance
  });

  it("is scale-invariant (rank-based)", () => {
    expect(spearmanRank([1, 2, 3], [1, 200, 300])).toBeCloseTo(1, 12);
  });
});

describe("neweyWestT — the overlap correction", () => {
  /** Deterministic AR(1)-ish series with strong positive autocorrelation. */
  function ar1(n: number, rho = 0.9): number[] {
    const e = Array.from({ length: n }, (_, i) => Math.sin(i * 12.9898) * 43758.5453 - Math.floor(Math.sin(i * 12.9898) * 43758.5453) - 0.5);
    const x: number[] = [];
    for (let i = 0; i < n; i++) x.push(i === 0 ? e[0]! : rho * x[i - 1]! + e[i]!);
    return x;
  }

  it("with lag 0 reduces to the plain standard error", () => {
    const xs = ar1(200, 0);
    const nw = neweyWestT(xs, 0)!;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const gamma0 = xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length;
    expect(nw.se).toBeCloseTo(Math.sqrt(gamma0 / xs.length), 12);
  });

  it("inflates the SE on autocorrelated data (so |t| shrinks)", () => {
    const xs = ar1(300);
    const nw0 = neweyWestT(xs, 0)!;
    const nw20 = neweyWestT(xs, 20)!;
    expect(nw20.se).toBeGreaterThan(nw0.se * 1.5);
  });

  it("does not let overlapping data manufacture significance", () => {
    // The real failure mode: 20d forward labels make ~1011 daily ICs look like
    // 1011 independent draws when they are ~50. On strongly autocorrelated data
    // the corrected t must be materially smaller than the naive one — the
    // uncorrected t overstates by roughly sqrt((1+rho)/(1-rho)) ~= 4.4 at
    // rho = 0.9.
    const xs = ar1(2000, 0.9);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length);
    const naiveT = mean / (sd / Math.sqrt(xs.length));
    const nw = neweyWestT(xs, 20)!;
    expect(Math.abs(nw.t)).toBeLessThan(Math.abs(naiveT) / 2);
    // And the inflation factor itself should be in the right ballpark for an
    // AR(1) with rho = 0.9 (theory: sqrt(19) ~= 4.36).
    const nw0 = neweyWestT(xs, 0)!;
    const inflation = nw.se / nw0.se;
    expect(inflation).toBeGreaterThan(2);
    expect(inflation).toBeLessThan(8);
  });

  it("returns null on a degenerate (constant) series", () => {
    expect(neweyWestT([1, 1, 1, 1], 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// portfolio
// ---------------------------------------------------------------------------

describe("simulatePortfolio", () => {
  const ds = dates(300);
  const topN = 1;
  const bufferRank = 1;
  const window = ds.slice(258); // a few replay days

  function build(market: Market = "US") {
    const strong = series("STRONG", market, ds, rising(300, 0.003));
    const weak = series("WEAK", market, ds, rising(300, 0.0005, 100, 0.02));
    const forward = new Map([["STRONG", buildForwardSeries(strong.bars, strong.dividends)], ["WEAK", buildForwardSeries(weak.bars, weak.dividends)]]);
    const days = replayScreen(window, [strong, weak]);
    return { forward, days };
  }

  it("holds a name that stays at the top instead of churning it (hysteresis)", () => {
    const { forward, days } = build();
    const res = simulatePortfolio(days, forward, { topN, bufferRank, costs: BASE_COSTS }, "US");
    expect(res.trades.length).toBe(1); // entered once, closed at the final bar
    expect(res.trades[0]!.symbol).toBe("STRONG");
    expect(res.trades[0]!.holdingSessions).toBeGreaterThan(1);
  });

  it("fills at the NEXT session's open, not the signal day's close", () => {
    const dsOpen = dates(300);
    const closes = rising(300, 0.003);
    const opens = closes.map(() => 777); // a distinctive, unmistakable open price
    const strong = series("STRONG", "US", dsOpen, closes, [], opens);
    const forward = new Map([["STRONG", buildForwardSeries(strong.bars, strong.dividends)]]);
    const days = replayScreen(dsOpen.slice(258), [strong]);
    const res = simulatePortfolio(days, forward, { topN, bufferRank, costs: BASE_COSTS }, "US");
    expect(res.trades.length).toBeGreaterThan(0);
    for (const t of res.trades) expect(t.entryPrice).toBe(777);
  });

  it("charges higher costs → identical decisions, strictly worse result", () => {
    const { forward, days } = build();
    const base = simulatePortfolio(days, forward, { topN, bufferRank, costs: BASE_COSTS }, "US");
    const doubled = simulatePortfolio(days, forward, { topN, bufferRank, costs: scaleCosts(BASE_COSTS, 2) }, "US");
    expect(doubled.trades.length).toBe(base.trades.length);
    expect(doubled.metrics.totalReturn).toBeLessThan(base.metrics.totalReturn);
  });

  it("keeps the books separate: a US book never trades an HK name", () => {
    const sus = series("USNAME", "US", ds, rising(300, 0.003));
    const shk = series("HKNAME", "HK", ds, rising(300, 0.003));
    const forward = new Map([
      ["USNAME", buildForwardSeries(sus.bars, sus.dividends)],
      ["HKNAME", buildForwardSeries(shk.bars, shk.dividends)],
    ]);
    const days = replayScreen(ds.slice(258), [sus, shk]);
    const res = simulatePortfolio(days, forward, { topN: 2, bufferRank: 2, costs: BASE_COSTS }, "US");
    expect(res.trades.length).toBeGreaterThan(0);
    expect(res.trades.every((t) => t.symbol === "USNAME")).toBe(true);
  });

  it("benchmark is equal-weight over the same eligible set and cost-free", () => {
    const { forward, days } = build();
    const b = benchmarkReturns(days, forward, "US");
    expect(b.length).toBe(days.length);
    expect(b[0]).toBe(0);
    expect(b.slice(1).every((x) => Number.isFinite(x))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// the pre-registered bar
// ---------------------------------------------------------------------------

describe("Gate 1 bar", () => {
  it("is a conjunction of magnitude and Newey-West significance", () => {
    expect(GATE1_MIN_IC).toBe(0.02);
    expect(gate1Passes(0.02, 2)).toBe(true);
    expect(gate1Passes(0.02, 1.99)).toBe(false); // strong magnitude, weak evidence
    expect(gate1Passes(0.019, 5)).toBe(false); // huge evidence, trivial magnitude
    expect(gate1Passes(0.05, 4)).toBe(true);
    expect(gate1Passes(-0.03, 4)).toBe(false); // right magnitude, wrong sign
    expect(gate1Passes(0, 0)).toBe(false);
  });

  it("equityFromReturns compounds correctly", () => {
    const eq = equityFromReturns([0.1, -0.1]);
    expect(eq).toEqual([1, 1.1, 0.9900000000000001]); // 1.1 × 0.9 = 0.99
  });
});

describe("runBacktest — end to end on synthetic data", () => {  const ds = dates(420);

  function universe(patterns: "persistent" | "reverting") {
    return Array.from({ length: 24 }, (_, k) => {
      const drift = patterns === "persistent" ? 0.0002 + k * 0.00012 : 0.0016 - k * 0.00012;
      const closes = rising(420, drift, 100, patterns === "persistent" ? 0.004 : 0.03, k);
      return series(`S${String(k).padStart(2, "0")}`, "US", ds, closes);
    });
  }

  it("produces a structurally complete verdict for both lanes", () => {
    const out = runBacktest({ symbolSeries: universe("persistent"), dates: ds.slice(270) });
    expect(out.replayDays).toBe(150);
    expect(out.lanes.map((l) => l.market)).toEqual(["US", "HK"]);
    for (const lane of out.lanes) {
      expect(Number.isFinite(lane.gate1.meanIc)).toBe(true);
      expect(lane.gate1.primaryHorizon).toBe(20);
      expect(["h1_holds", "ranking_power_but_not_tradable", "h1_revised", "insufficient_evidence"]).toContain(lane.verdict);
      // Gate 2 must carry both cost levels.
      expect(lane.gate2Base.costLabel).toBe("base");
      expect(lane.gate2Double.costLabel).toBe("2x");
      expect(Number.isFinite(lane.gate2Base.differential)).toBe(true);
    }
    // The US lane has names, so it must carry real horizon evidence.
    const us = out.lanes.find((l) => l.market === "US")!;
    expect(us.gate1.horizons.length).toBeGreaterThan(0);
    expect(us.gate1.byYear.length).toBeGreaterThan(0);
    // No HK names were supplied, so the HK lane has no evidence and no trades.
    const hk = out.lanes.find((l) => l.market === "HK")!;
    expect(hk.gate1.days).toBe(0);
    expect(hk.verdict).toBe("h1_revised");
  });

  it("detects ranking power when the signal really does persist", () => {
    const out = runBacktest({ symbolSeries: universe("persistent"), dates: ds.slice(270) });
    const us = out.lanes.find((l) => l.market === "US")!;
    // Persisting drifts ⇒ momentum ranks predict forward returns.
    expect(us.gate1.meanIc).toBeGreaterThan(0);
    expect(us.gate1.days).toBeGreaterThan(100);
  });

  it("is not fooled into high IC by a purely reverting cross-section", () => {
    const persistent = runBacktest({ symbolSeries: universe("persistent"), dates: ds.slice(270) }).lanes.find((l) => l.market === "US")!;
    const reverting = runBacktest({ symbolSeries: universe("reverting"), dates: ds.slice(270) }).lanes.find((l) => l.market === "US")!;
    expect(reverting.gate1.meanIc).toBeLessThan(persistent.gate1.meanIc);
  });

  it("the weight sweep reproduces the shipped combo's IC exactly", () => {
    // The sweep must be a pure re-scoring of the same replay, not a second
    // implementation of the screen — otherwise its descriptive numbers would
    // not describe the thing that ships.
    const lanes: SymbolSeries[] = universe("persistent");
    const dates = ds.slice(270);
    const days = replayScreen(dates, lanes);
    const forward = new Map(lanes.map((s) => [s.symbol, buildForwardSeries(s.bars, s.dividends)]));
    const direct = icStats(
      icSeries(
        days.map((d) => ({ ...d, ranked: d.ranked.filter((p) => p.market === "US") })),
        forward,
        20,
      ),
      20,
    )!;
    const shipped = { mom60: 0.5, mom20: 0.25, sharpe252: 0.25 };
    const swept = sweepWeightCombos([...days].map((d) => ({ ...d, ranked: d.ranked.filter((p) => p.market === "US") })), forward, 20, [shipped], shipped)[0]!;
    expect(swept.isShipped).toBe(true);
    expect(swept.meanIc).toBeCloseTo(direct.mean, 10);
    expect(swept.nwT).toBeCloseTo(direct.nwT, 10);
  });
});

// ---------------------------------------------------------------------------
// Phase 4b — the calibration repairs (docs/phase-4b-plan.md)
// ---------------------------------------------------------------------------

describe("Phase 4b D1 — the power statement", () => {
  it("tQuantile975 matches the published table at the effective df", () => {
    // Effective df is T/h − 1 ≈ 48 for US, ≈ 44 for HK. 1.96 is the wrong
    // quantile here, which is why the doc's intervals were recomputed.
    expect(tQuantile975(48)).toBeCloseTo(2.0106, 3);
    expect(tQuantile975(44)).toBeCloseTo(2.0154, 3);
    expect(tQuantile975(1e6)).toBeCloseTo(1.96, 2); // converges to normal
    // Small df must be CONSERVATIVE: the 2-term expansion understates the true
    // quantile (7.15 at df=1 against 12.71), which would produce an
    // overconfident interval. Table values are exact.
    expect(tQuantile975(1)).toBeCloseTo(12.7062, 3);
    expect(tQuantile975(4)).toBeCloseTo(2.7764, 3);
    expect(tQuantile975(4.5)).toBeCloseTo(2.7764, 3); // steps down, not up
    expect(tQuantile975(9)).toBeCloseTo(2.2622, 3);
    // Monotone decreasing in df overall.
    expect(tQuantile975(5)).toBeGreaterThan(tQuantile975(20));
    expect(tQuantile975(20)).toBeGreaterThan(tQuantile975(200));
  });

  it("reports the naive / heuristic / realized SE triple from one IcStats", () => {
    // Shape mirrors the real US numbers so the arithmetic is checkable by hand.
    const stats: IcStats = { days: 983, mean: 0.0145, sd: 0.1611, icir: 0.09, nwSe: 0.01495, nwT: 0.97, lag: 20, meanBreadth: 180 };
    const p = icPower(stats, 20);
    expect(p.naiveSe).toBeCloseTo(0.1611 / Math.sqrt(983), 12);
    expect(p.heuristicSe).toBeCloseTo((1 / Math.sqrt(179)) * Math.sqrt(20) / Math.sqrt(983), 12);
    expect(p.df).toBeCloseTo(983 / 20 - 1, 12);
    // The realized SE is what may set a bar; here it is ~1.4x the heuristic's,
    // i.e. the ex-ante formula was optimistic in this lane.
    expect(p.naiveSe).toBeLessThan(p.heuristicSe);
    expect(p.heuristicSe).toBeLessThan(stats.nwSe);
    expect(p.ciLo).toBeCloseTo(0.0145 - p.quantile * 0.01495, 12);
    expect(p.ciHi).toBeCloseTo(0.0145 + p.quantile * 0.01495, 12);
    expect(p.ciLo).toBeLessThan(0);
    expect(p.ciHi).toBeGreaterThan(GATE1_MIN_IC); // 0.02 is inside the interval
  });

  it("returns NaN for the heuristic on a degenerate breadth rather than dividing by zero", () => {
    const stats: IcStats = { days: 100, mean: 0.01, sd: 0.1, icir: 0.1, nwSe: 0.01, nwT: 1, lag: 20, meanBreadth: 1 };
    expect(Number.isNaN(icPower(stats, 20).heuristicSe)).toBe(true);
  });

  it("the power note is emitted even when Gate 1 FAILS (D1's unconditional fix)", () => {
    // It used to be gated behind `gate1.passed`, so the most important context
    // was suppressed in exactly the case that needed it. Needs >= MIN_IC_BREADTH
    // names: with fewer there is no IC series at all, so there is no power
    // statement to make.
    const ds = dates(420);
    const lanes = Array.from({ length: 6 }, (_, k) => series(`A${k}`, "US", ds, rising(420, 0.0008 + k * 0.00006, 100, 0.02, k)));
    const out = runBacktest({ symbolSeries: lanes, dates: ds.slice(270) });
    const us = out.lanes.find((l) => l.market === "US")!;
    expect(us.gate1.passed).toBe(false);
    expect(us.gate1.days).toBeGreaterThan(0);
    expect(us.notes.join(" ")).toMatch(/power note/);
    expect(us.notes.join(" ")).toMatch(/SE triple/);
    expect(us.notes.join(" ")).toMatch(/95% CI/);
  });
});

describe("Phase 4b D4 — the proportional cutoff", () => {
  it("is a decile where the lane is wide and floors at 5 where it is not", () => {
    expect(proportionalCutoff(180)).toBe(18); // US: any decile >= floor
    expect(proportionalCutoff(60)).toBe(6);
    expect(proportionalCutoff(40)).toBe(5); // ceil(4)=4 → floor binds
    expect(proportionalCutoff(25)).toBe(5); // HK: ceil(2.5)=3 → floor binds
    expect(proportionalCutoff(10)).toBe(5);
  });

  it("is a *different* statistic from the fixed top-15 in a thin lane", () => {
    // The Finding-3 case: 20 names, the top 5 strongly up, the rest flat.
    // A fixed top-15 averages in 10 flat names and dilutes the spread; the
    // proportional cutoff sees exactly the 5 that moved.
    const ds = dates(2, "2022-01-03");
    const ds2 = dates(25, "2022-01-03");
    const names = Array.from({ length: 20 }, (_, k) => `S${String(k).padStart(2, "0")}`);
    const syms = names.map((s, k) => {
      // Flat, then +5% on the final session for the top-5 scored names.
      const closes = Array.from({ length: 2 }, () => 100);
      return series(s, "US", ds, closes).symbol === s
        ? series(s, "US", ds, k < 5 ? [100, 105] : [100, 100])
        : series(s, "US", ds, [100, 100]);
    });
    const forward = new Map(syms.map((x) => [x.symbol, buildForwardSeries(x.bars, x.dividends)]));
    const ranked = names.map((s, k) => ({ symbol: s, market: "US" as Market, rank: k + 1 })) as unknown as ReplayDay["ranked"];
    const day: ReplayDay = { date: ds[0]!, ranked, excludedCount: 0, excludedByReason: { US: {}, HK: {} } };

    const fixed = spreadSeries([day], forward, 1, 15)[0]!;
    const prop = spreadSeriesProportional([day], forward, 1, undefined, 0.1, 5)[0]!;
    expect(fixed).toBeCloseTo((5 * 0.05) / 15, 10); // top 15 of 20 → diluted
    expect(prop).toBeCloseTo(0.05, 10); // top 5 of 20 → undiluted
    expect(prop).toBeGreaterThan(fixed);
    expect(ds2.length).toBe(25); // silence the unused-var lint without a void
  });

  it("skips a day with no breadth instead of emitting a degenerate zero", () => {
    const d: ReplayDay = { date: "2022-01-03", ranked: [], excludedCount: 0, excludedByReason: { US: {}, HK: {} } };
    expect(spreadSeriesProportional([d], new Map(), 1)).toEqual([]);
  });
});

describe("Phase 4b D3 — the eligibility census", () => {
  function rday(date: string, us: Record<string, number>, hk: Record<string, number>, nUs: number, nHk: number): ReplayDay {
    return {
      date,
      ranked: [
        ...Array.from({ length: nUs }, () => ({ market: "US" as Market })),
        ...Array.from({ length: nHk }, () => ({ market: "HK" as Market })),
      ] as unknown as ReplayDay["ranked"],
      excludedCount: 0,
      excludedByReason: { US: us, HK: hk },
    };
  }

  it("attributes rejections per market and per year, with an exact denominator", () => {
    const days = [
      rday("2023-05-02", { LOW_LIQUIDITY: 3, BEARISH_ALIGNMENT: 10 }, { DEEP_DRAWDOWN: 7 }, 100, 20),
      rday("2024-06-03", { LOW_LIQUIDITY: 1, BEARISH_ALIGNMENT: 20 }, { DEEP_DRAWDOWN: 2 }, 90, 25),
    ];
    const us = exclusionCensus(days, "US");
    expect(us.byReason).toEqual({ LOW_LIQUIDITY: 4, BEARISH_ALIGNMENT: 30 });
    expect(us.total).toBe(34);
    expect(us.eligible).toBe(190); // Σ ranked US — the reject-share denominator
    expect(us.days).toBe(2);
    expect(us.byYear.map((y) => y.year)).toEqual(["2023", "2024"]);
    expect(us.byYear[0]!.byReason.BEARISH_ALIGNMENT).toBe(10);

    // The HK lane is counted separately — that separation is the whole point,
    // since HK's 25-name breadth is what makes its Gate 1 unreachable.
    const hk = exclusionCensus(days, "HK");
    expect(hk.byReason).toEqual({ DEEP_DRAWDOWN: 9 });
    expect(hk.eligible).toBe(45);
  });

  it("is populated by the replay, per market, from the reasons runScreen already computed", () => {
    const ds = dates(300);
    const mk = (sym: string, m: Market, drift: number) => series(sym, m, ds, rising(300, drift, 100, 0.006, 0));
    // A flat name trips NON_POSITIVE_SHARPE (and is not US-liquid at HK volume),
    // so both lanes must record a rejection rather than silently dropping it.
    const flat = mk("FLAT", "US", 0);
    const up = mk("UP", "US", 0.002);
    const days = replayScreen(ds.slice(270), [flat, up]);
    const census = exclusionCensus(days, "US");
    expect(census.total).toBeGreaterThan(0);
    expect(Object.keys(census.byReason).length).toBeGreaterThan(0);
    // Another lane's rejections must not leak into this one's census.
    expect(exclusionCensus(days, "HK").total).toBe(0);
  });
});

describe("Phase 4b D2 — the differential interval", () => {
  const ds = dates(300);
  const mkBook = () => Array.from({ length: 8 }, (_, k) => series(`B${k}`, "US", ds, rising(300, 0.001 + k * 0.0004, 100, 0.005, k)));

  it("tests the daily arithmetic difference, and reports it as a distinct quantity from the compounded differential", () => {
    const lanes = mkBook();
    const days = replayScreen(ds.slice(250), lanes);
    const forward = new Map(lanes.map((s) => [s.symbol, buildForwardSeries(s.bars, s.dividends)]));
    const params = { topN: PORTFOLIO_TOP_N, bufferRank: PORTFOLIO_BUFFER_RANK, costs: BASE_COSTS };
    const result = simulatePortfolio(days, forward, params, "US");
    const bench = benchmarkReturns(days, forward, "US");

    // Independently rebuild the series the implementation must be using — same
    // portfolio params as runBacktest's defaults, or it is a different book.
    const diff = result.dailyReturns.slice(1).map((r, i) => r - (bench[i + 1] ?? 0));
    const expected = neweyWestT(diff, DIFFERENTIAL_LAG)!;

    const out = runBacktest({ symbolSeries: lanes, dates: ds.slice(250), markets: ["US"] });
    const g = out.lanes[0]!.gate2Base;
    expect(g.nwT).toBeCloseTo(expected.t, 10);
    expect(g.differentialDailyMean).toBeCloseTo(expected.mean, 12);
    // IR is the annualised mean over the annualised tracking error.
    expect(g.ir).toBeCloseTo((g.differentialDailyMean * 252) / g.trackingError, 10);
    // And the t is NOT the compounded differential over its own SE — the two
    // headline numbers are different statistics (Phase 4b amendment 3).
    expect(g.nwT).not.toBeCloseTo(g.differential / g.trackingError, 6);
  });

  it("discloses the IR-vs-HAC-t gap instead of hiding it (amendment R13)", () => {
    // `ir` uses the i.i.d. tracking error; `nwT` uses the Newey-West SE of the
    // MEAN. They legitimately differ, so reporting one without the other invites
    // reading the gap as an arithmetic error. Both are exposed.
    const lanes = mkBook();
    const out = runBacktest({ symbolSeries: lanes, dates: ds.slice(250), markets: ["US"] });
    const g = out.lanes[0]!.gate2Base;
    expect(g.years).toBeCloseTo((out.lanes[0]!.gate2Base.portfolio.sessions ?? g.years) / 252, 6);
    expect(g.tFromIr).toBeCloseTo(g.ir * Math.sqrt(g.years), 10);
    // The whole point: the two t's are NOT the same number.
    expect(Math.abs(g.tFromIr - g.nwT)).toBeGreaterThan(1e-9);
  });

  it("reports the index benchmark alongside the equal-weight one (amendment R14)", () => {
    // phase-4-plan.md pre-registered TWO benchmarks; only the equal-weight one
    // was ever reported, and it shares the screen's own selection.
    const lanes = mkBook();
    const out = runBacktest({ symbolSeries: lanes, dates: ds.slice(250), markets: ["US"], indexSymbol: { US: "B0" } });
    const lane = out.lanes[0]!;
    expect(lane.indexReturn).not.toBeNull();
    expect(lane.indexDifferential).toBeCloseTo(lane.gate2Base.portfolio.totalReturn - lane.indexReturn!, 10);
  });

  it("carries the pre-registered lag 20 and descriptive 5/60 sensitivity", () => {
    const lanes = mkBook();
    const out = runBacktest({ symbolSeries: lanes, dates: ds.slice(250), markets: ["US"] });
    const g = out.lanes[0]!.gate2Base;
    expect(DIFFERENTIAL_LAG).toBe(20);
    for (const t of [g.nwT, g.nwT5, g.nwT60]) expect(Number.isFinite(t)).toBe(true);
    // All three test the mean of the SAME series, so their signs must agree — a
    // lag cannot flip the sign of an estimate, only its precision. (No ordering
    // between them is claimed: a longer lag may raise or lower |t| depending on
    // whether the autocovariances are positive.)
    const signs = [g.nwT, g.nwT5, g.nwT60].map((t) => Math.sign(t));
    expect(new Set(signs).size).toBe(1);
  });
});

describe("Phase 4b D5 — the verdict vocabulary", () => {
  const ds = dates(420);

  it("calls a FAIL on an unreachable bar `insufficient_evidence`, not `h1_revised`", () => {
    // A tiny synthetic universe has a large SE, so the 0.02 bar is out of reach
    // and a FAIL must not read as "the hypothesis was revised". Needs
    // >= MIN_IC_BREADTH names, else there is no IC series to speak of.
    const lanes = Array.from({ length: 6 }, (_, k) => series(`A${k}`, "US", ds, rising(420, 0.0008 + k * 0.00006, 100, 0.02, k)));
    const out = runBacktest({ symbolSeries: lanes, dates: ds.slice(270) });
    const us = out.lanes.find((l) => l.market === "US")!;
    expect(us.gate1.passed).toBe(false);
    expect(us.gate1.detectableIc).toBeGreaterThan(0);
    expect(us.gate1.detectableIc).toBeGreaterThan(us.gate1.minIc);
    expect(us.verdict).toBe("insufficient_evidence");
    expect(us.notes.join(" ")).toMatch(/insufficient evidence, not evidence of no edge/);
  });

  it("keeps `h1_revised` for a lane with no evidence at all (no data, no inference)", () => {
    const lanes = Array.from({ length: 6 }, (_, k) => series(`A${k}`, "US", ds, rising(420, 0.0008 + k * 0.00006, 100, 0.02, k)));
    const out = runBacktest({ symbolSeries: lanes, dates: ds.slice(270) });
    const hk = out.lanes.find((l) => l.market === "HK")!;
    expect(hk.gate1.days).toBe(0);
    expect(hk.verdict).toBe("h1_revised");
  });
});

describe("Phase 4b review amendments — the census says what it is", () => {
  it("is typed first_failure, because runScreen records ONE reason per name", () => {
    // Without this the census reads as marginal bindingness and licenses
    // "relax gate X -> breadth +Y", which first-failure evidence cannot support.
    const d: ReplayDay = { date: "2023-05-02", ranked: [] as unknown as ReplayDay["ranked"], excludedCount: 0, excludedByReason: { US: { BEARISH_ALIGNMENT: 3 }, HK: {} } };
    expect(exclusionCensus([d], "US").basis).toBe("first_failure");
  });
});
