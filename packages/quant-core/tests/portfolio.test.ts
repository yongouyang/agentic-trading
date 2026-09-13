/**
 * Targeted branch tests for the portfolio simulator — the money-math edge
 * cases that backtest.test.ts (end-to-end on synthetic screens) does not
 * reach: unusable opens, missing bars on fill days, the no-leverage cash
 * guard, sparse rankings, final-bar close-out failures, and the degenerate
 * inputs of portfolioMetrics / benchmarkReturns.
 */
import { describe, expect, it } from "vitest";
import type { Market, ScreenPick } from "../src/screening.js";
import type { ForwardSeries, ReplayDay } from "../src/replay.js";
import {
  BASE_COSTS,
  CostModel,
  Trade,
  benchmarkReturns,
  portfolioMetrics,
  scaleCosts,
  simulatePortfolio,
} from "../src/portfolio.js";

const ZERO_COSTS: CostModel = { perSideBps: { US: 0, HK: 0 } };

const pick = (symbol: string, rank: number, market: Market = "US"): ScreenPick => ({
  rank,
  symbol,
  market,
  score: 0,
  close: 100,
  sma50: 100,
  sma200: 100,
  mom20: 0,
  mom60: 0,
  vol60: 0,
  sharpe252: 0,
  adv20: 1e9,
  mdd252: 0,
  caDegraded: false,
});

const day = (date: string, ranked: ScreenPick[] = []): ReplayDay => ({
  date,
  ranked,
  excludedCount: 0,
  excludedByReason: { US: {}, HK: {} },
  excludedMarginal: { US: {}, HK: {} },
  excludedSole: { US: {}, HK: {} },
});

/** Build a ForwardSeries directly. `opens` defaults to the closes (fill at
 *  open == fill at close unless a test says otherwise). */
function series(
  dates: string[],
  closes: (number | null)[],
  opens?: (number | null)[],
): ForwardSeries {
  const index = new Map<string, number>();
  dates.forEach((d, i) => index.set(d, i));
  return { dates, index, closes: closes as number[], opens: opens ?? closes };
}

const params = (topN: number, bufferRank: number, costs: CostModel = ZERO_COSTS) => ({
  topN,
  bufferRank,
  costs,
});

describe("simulatePortfolio — fill price selection", () => {
  it("fills at the T+1 open when the provider has one", () => {
    const days = [day("2025-01-02", [pick("AAA", 1)]), day("2025-01-03")];
    const fwd = new Map([["AAA", series(["2025-01-02", "2025-01-03"], [100, 110], [100, 105])]]);
    const r = simulatePortfolio(days, fwd, params(1, 3), "US");
    expect(r.trades).toHaveLength(1); // closed out at the final bar
    expect(r.trades[0]!.entryPrice).toBe(105); // the open, not the close
    expect(r.trades[0]!.exitPrice).toBe(110); // final-bar close
  });

  it("falls back to the close when the open is null or non-positive", () => {
    const days = [day("2025-01-02", [pick("AAA", 1), pick("BBB", 2)]), day("2025-01-03")];
    const fwd = new Map([
      ["AAA", series(["2025-01-02", "2025-01-03"], [100, 110], [100, null])],
      ["BBB", series(["2025-01-02", "2025-01-03"], [50, 55], [50, -1])],
    ]);
    const r = simulatePortfolio(days, fwd, params(2, 4), "US");
    const aaa = r.trades.find((t) => t.symbol === "AAA")!;
    const bbb = r.trades.find((t) => t.symbol === "BBB")!;
    expect(aaa.entryPrice).toBe(110);
    expect(bbb.entryPrice).toBe(55);
  });

  it("skips the buy entirely when neither open nor close is usable", () => {
    const days = [day("2025-01-02", [pick("AAA", 1)]), day("2025-01-03"), day("2025-01-06")];
    const fwd = new Map([["AAA", series(["2025-01-02", "2025-01-03", "2025-01-06"], [100, 0, 100], [100, null, 100])]]);
    const r = simulatePortfolio(days, fwd, params(1, 3), "US");
    expect(r.trades).toHaveLength(0);
    expect(r.equity).toEqual([1, 1, 1]); // never invested
  });
});

describe("simulatePortfolio — missing bars around fills", () => {
  it("keeps the position when the sell day has no bar for the symbol", () => {
    // Day 2: AAA falls out of the ranking → sell order for day 3. But AAA has
    // no bar on day 3, so the sell cannot fill; the final-bar close-out then
    // exits at the last available close.
    const days = [
      day("2025-01-02", [pick("AAA", 1)]),
      day("2025-01-03", [pick("AAA", 1)]),
      day("2025-01-06", []),
    ];
    const fwd = new Map([["AAA", series(["2025-01-02", "2025-01-03"], [100, 120], [100, 100])]]);
    const r = simulatePortfolio(days, fwd, params(1, 3), "US");
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]!.exitDate).toBe("2025-01-06"); // final bar, not day 3 open
    expect(r.trades[0]!.exitPrice).toBe(120); // last known close
    // Gap day is marked at the last known price, not dropped to zero.
    expect(r.equity[2]).toBeCloseTo(1.2, 10);
  });

  it("enforces the no-leverage cash guard when a sell fails to fill", () => {
    // topN=2. Day 1: AAA fills with half the equity. Day 2 ranking: AAA out,
    // BBB and CCC in. On day 3 AAA has no bar, so its sell fails and only the
    // ~0.5 cash is available: BBB fills, CCC is skipped rather than overdrawing.
    const days = [
      day("2025-01-02", [pick("AAA", 1)]),
      day("2025-01-03", [pick("BBB", 1), pick("CCC", 2)]),
      day("2025-01-06", [pick("BBB", 1), pick("CCC", 2)]),
    ];
    const fwd = new Map([
      ["AAA", series(["2025-01-02", "2025-01-03"], [100, 100])],
      ["BBB", series(["2025-01-02", "2025-01-03", "2025-01-06"], [10, 10, 10])],
      ["CCC", series(["2025-01-02", "2025-01-03", "2025-01-06"], [20, 20, 20])],
    ]);
    const r = simulatePortfolio(days, fwd, params(2, 4), "US");
    const symbols = r.trades.map((t) => t.symbol).sort();
    expect(symbols).toEqual(["AAA", "BBB"]); // CCC never bought
    expect(r.trades.find((t) => t.symbol === "BBB")!.entryPrice).toBe(10);
  });
});

describe("simulatePortfolio — rank hysteresis and ordering", () => {
  it("holds a name ranked between topN and bufferRank, sells past the buffer", () => {
    const days = [
      day("2025-01-02", [pick("AAA", 1)]),
      day("2025-01-03", [pick("AAA", 2)]), // inside the buffer: hold
      day("2025-01-06", [pick("AAA", 4)]), // past bufferRank=3: sell at next open
      day("2025-01-07"),
    ];
    const fwd = new Map([
      ["AAA", series(["2025-01-02", "2025-01-03", "2025-01-06", "2025-01-07"], [100, 110, 120, 130])],
    ]);
    const r = simulatePortfolio(days, fwd, params(1, 3), "US");
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]!.entryDate).toBe("2025-01-03");
    expect(r.trades[0]!.exitDate).toBe("2025-01-07");
    expect(r.trades[0]!.holdingSessions).toBe(2); // 01-07 idx 3 − 01-03 idx 1
  });

  it("does not re-buy a name already held", () => {
    const days = [
      day("2025-01-02", [pick("AAA", 1)]),
      day("2025-01-03", [pick("AAA", 1), pick("BBB", 2)]),
      day("2025-01-06", [pick("AAA", 1), pick("BBB", 2)]),
    ];
    const fwd = new Map([
      ["AAA", series(["2025-01-02", "2025-01-03", "2025-01-06"], [100, 100, 100])],
      ["BBB", series(["2025-01-02", "2025-01-03", "2025-01-06"], [50, 50, 50])],
    ]);
    const r = simulatePortfolio(days, fwd, params(2, 4), "US");
    const aaa = r.trades.find((t) => t.symbol === "AAA")!;
    expect(aaa.entryDate).toBe("2025-01-03"); // the FIRST fill; never re-entered
  });

  it("ignores sparse ranks above topN", () => {
    const days = [day("2025-01-02", [pick("AAA", 5), pick("BBB", 7)]), day("2025-01-03")];
    const fwd = new Map([
      ["AAA", series(["2025-01-02", "2025-01-03"], [100, 100])],
      ["BBB", series(["2025-01-02", "2025-01-03"], [100, 100])],
    ]);
    const r = simulatePortfolio(days, fwd, params(1, 3), "US");
    expect(r.trades).toHaveLength(0);
    expect(r.equity).toEqual([1, 1]);
  });

  it("only trades picks from its own market", () => {
    const days = [day("2025-01-02", [pick("0700.HK", 1, "HK")]), day("2025-01-03")];
    const fwd = new Map([["0700.HK", series(["2025-01-02", "2025-01-03"], [100, 100])]]);
    const r = simulatePortfolio(days, fwd, params(1, 3), "US");
    expect(r.trades).toHaveLength(0);
  });
});

describe("simulatePortfolio — final-bar close-out failures", () => {
  it("records no trade when the series vanishes before the final bar", () => {
    const days = [day("2025-01-02", [pick("AAA", 1)]), day("2025-01-03")];
    const fwd = new Map([["AAA", series(["2025-01-02", "2025-01-03"], [100, 110])]]);
    // Simulate a provider hole appearing after the buy was signaled: the book
    // must not crash, and the position is dropped without a trade record.
    const r = simulatePortfolio(days, fwd, params(1, 3), "US");
    expect(r.trades).toHaveLength(1);
    fwd.delete("AAA");
    const r2 = simulatePortfolio(days, fwd, params(1, 3), "US");
    expect(r2.trades).toHaveLength(0);
    expect(r2.equity).toEqual([1, 1]);
  });

  it("records no trade when the final close is null", () => {
    const days = [day("2025-01-02", [pick("AAA", 1)]), day("2025-01-03")];
    const fwd = new Map([["AAA", series(["2025-01-02", "2025-01-03"], [100, null])]]);
    const r = simulatePortfolio(days, fwd, params(1, 3), "US");
    expect(r.trades).toHaveLength(0);
  });
});

describe("portfolioMetrics — degenerate inputs", () => {
  it("handles an empty equity curve", () => {
    const m = portfolioMetrics([], [], [], 0);
    expect(m.sessions).toBe(0);
    expect(m.totalReturn).toBe(0);
    expect(m.annualizedReturn).toBe(0);
    expect(m.sharpe).toBe(0);
    expect(m.winRate).toBe(0);
    expect(m.plRatio).toBe(0);
    expect(m.turnover).toBe(0);
    expect(m.tradeCount).toBe(0);
  });

  it("reports zero return when the first equity value is zero", () => {
    const m = portfolioMetrics([0, 0], [0, 0], [], 0);
    expect(m.totalReturn).toBe(0);
    expect(m.annualizedReturn).toBe(0);
    expect(m.maxDrawdown).toBe(0); // peak === 0 guard, no divide-by-zero
  });

  it("reports zero annualized return when the final equity is non-positive", () => {
    const m = portfolioMetrics([1, -0.5], [0, -1.5], [], 0);
    expect(m.totalReturn).toBe(-1.5);
    expect(m.annualizedReturn).toBe(0);
  });

  it("reports zero sharpe for a single session or zero-variance returns", () => {
    expect(portfolioMetrics([1], [0], [], 0).sharpe).toBe(0);
    expect(portfolioMetrics([1, 1, 1], [0, 0, 0], [], 0).sharpe).toBe(0);
  });

  const trade = (pnl: number): Trade => ({
    symbol: "AAA",
    market: "US",
    entryDate: "2025-01-02",
    exitDate: "2025-01-03",
    entryPrice: 100,
    exitPrice: 100 + pnl,
    pnl,
    returnPct: pnl / 100,
    holdingSessions: 1,
  });

  it("reports plRatio Infinity when there are wins but no losses", () => {
    const m = portfolioMetrics([1, 1.1], [0, 0.1], [trade(10)], 1);
    expect(m.plRatio).toBe(Infinity);
    expect(m.winRate).toBe(1);
  });

  it("reports a finite plRatio across wins and losses", () => {
    const m = portfolioMetrics([1, 1.1, 1.0], [0, 0.1, -0.0909], [trade(10), trade(-5)], 1);
    expect(m.plRatio).toBeCloseTo(2, 10); // avgWin 10 / avgLoss 5
    expect(m.winRate).toBe(0.5);
    expect(m.avgHoldingSessions).toBe(1);
  });

  it("tracks drawdown depth and duration", () => {
    const m = portfolioMetrics([1, 0.9, 0.8, 0.85, 1.1], [0, -0.1, -0.1111, 0.0625, 0.2941], [], 0);
    expect(m.maxDrawdown).toBeCloseTo(-0.2, 4);
    expect(m.maxDrawdownSessions).toBe(3); // sessions 1..3 below the day-0 peak
    expect(m.totalReturn).toBeCloseTo(0.1, 10);
  });

  it("annualises turnover against mean equity", () => {
    // 252 sessions of flat equity 1, one unit traded per side of notional.
    const equity = new Array(252).fill(1);
    const rets = new Array(252).fill(0);
    const m = portfolioMetrics(equity, rets, [], 2);
    expect(m.turnover).toBeCloseTo(2, 10);
  });
});

describe("benchmarkReturns — per-pick guards", () => {
  const days = (extra: ScreenPick[] = []): ReplayDay[] => [
    day("2025-01-02", [pick("AAA", 1), pick("BBB", 2), ...extra]),
    day("2025-01-03", [pick("AAA", 1), pick("BBB", 2), ...extra]),
  ];

  it("averages only picks with usable bars in the book's market", () => {
    const fwd = new Map([
      ["AAA", series(["2025-01-02", "2025-01-03"], [100, 110])],
      ["BBB", series(["2025-01-02", "2025-01-03"], [100, 90])],
    ]);
    const r = benchmarkReturns(days(), fwd, "US");
    expect(r[0]).toBe(0);
    expect(r[1]).toBeCloseTo((0.1 + -0.1) / 2, 10);
  });

  it("skips other-market picks, missing series, missing bars, and zero closes", () => {
    const ds = days([
      pick("0700.HK", 3, "HK"), // other market
      pick("GHOST", 4), // no series at all
      pick("LATE", 5), // no bar on the first day
      pick("ZERO", 6), // zero close on the first day
    ]);
    const fwd = new Map([
      ["AAA", series(["2025-01-02", "2025-01-03"], [100, 110])],
      ["BBB", series(["2025-01-02", "2025-01-03"], [100, 90])],
      ["0700.HK", series(["2025-01-02", "2025-01-03"], [300, 330])],
      ["LATE", series(["2025-01-03"], [10])],
      ["ZERO", series(["2025-01-02", "2025-01-03"], [0, 100])],
    ]);
    const r = benchmarkReturns(ds, fwd, "US");
    expect(r[1]).toBeCloseTo(0, 10); // only AAA and BBB count
  });

  it("pushes 0 for a day with no usable returns at all", () => {
    const ds = [day("2025-01-02", [pick("GHOST", 1)]), day("2025-01-03", [pick("GHOST", 1)])];
    const r = benchmarkReturns(ds, new Map(), "US");
    expect(r).toEqual([0, 0]);
  });
});

describe("cost models", () => {
  it("scaleCosts multiplies every per-side cost", () => {
    const scaled = scaleCosts(BASE_COSTS, 3);
    expect(scaled.perSideBps.US).toBe(15);
    expect(scaled.perSideBps.HK).toBe(69);
    expect(BASE_COSTS.perSideBps.US).toBe(5); // untouched
  });

  it("applies per-side costs to both entry and exit", () => {
    const costs: CostModel = { perSideBps: { US: 100, HK: 0 } }; // 1% per side
    const days = [day("2025-01-02", [pick("AAA", 1)]), day("2025-01-03")];
    const fwd = new Map([["AAA", series(["2025-01-02", "2025-01-03"], [100, 100])]]);
    const r = simulatePortfolio(days, fwd, params(1, 3, costs), "US");
    const t = r.trades[0]!;
    // Shares sized so total outlay is the full unit equity: 1 / (100 × 1.01).
    const shares = 1 / (100 * 1.01);
    expect(t.pnl).toBeCloseTo(shares * 100 * 0.99 - shares * 100, 10);
    expect(t.pnl).toBeLessThan(0); // flat price, costs eat ~2%
  });
});
