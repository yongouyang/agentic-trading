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
import { Market, ScreenInput, runScreen } from "../src/screening.js";
import { deriveAdjustedBars } from "../src/adjustment.js";
import { SymbolSeries, buildForwardSeries, forwardReturn, replayScreen } from "../src/replay.js";
import { icSeries, icStats, neweyWestT, spearmanRank, sweepWeightCombos } from "../src/ic.js";
import { BASE_COSTS, benchmarkReturns, scaleCosts, simulatePortfolio } from "../src/portfolio.js";
import { GATE1_MIN_IC, gate1Passes, equityFromReturns, runBacktest } from "../src/backtest.js";

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
    const inputs: ScreenInput[] = Array.from({ length: 20 }, (_, k) => {
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

    expect(capped.ranked.length).toBe(15); // SCREEN_PARAMS.topN
    expect(full.ranked.length).toBeGreaterThan(15);
    expect(full.ranked.slice(0, 15)).toEqual(capped.ranked);
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
      expect(["h1_holds", "ranking_power_but_not_tradable", "h1_revised"]).toContain(lane.verdict);
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
