/**
 * Pure-function tests for the Phase-4c vendor loader
 * (src/cli/vendor-loader.ts) and the vendor backtest window gating
 * (src/cli/backtest-vendor.ts). No db, no filesystem — artifacts and rows
 * are synthesized inline.
 *
 * Covers the pre-registered loader rules (docs/phase-4c-plan.md "Universe
 * (fixed)"): quarantine exclusion, dual-feed single-feed choice, split
 * application incl. the two detector-candidate rows (CDTX, QXO), the
 * dividend layer on a synthetic ex-date, PIT correctness of the replay, and
 * the test-half firewall.
 */
import { describe, expect, it } from "vitest";
import type { Bar } from "@agentic-trading/quant-core";
import { deriveAdjustedBars, replayScreen, type SymbolSeries } from "@agentic-trading/quant-core";
import {
  VENDOR_EXTRA_SPLITS,
  applySplitAdjustments,
  assembleVendorSeries,
  chooseFeed,
  mergeSplits,
  scaleDividendsToSplitBasis,
  type VendorArtifacts,
  type VendorBarRow,
} from "../../src/cli/vendor-loader.js";
import {
  parseVendorBacktestArgs,
  resolveWindow,
  testHalfStart,
} from "../../src/cli/backtest-vendor.js";

const bar = (date: string, close: number, volume = 1_000_000): Bar => ({
  date,
  open: close,
  high: close,
  low: close,
  close,
  volume,
});

const row = (vendor: string, symbol: string, date: string, close: number, volume = 1e6): VendorBarRow => ({
  vendor,
  symbol,
  date,
  open: close,
  high: close,
  low: close,
  close,
  volume,
});

const artifacts = (over: Partial<VendorArtifacts> = {}): VendorArtifacts => ({
  survivors: [],
  quarantined: new Set(),
  dividends: new Map(),
  dividendResidual: new Set(),
  ...over,
});

describe("chooseFeed (dual-feed rule)", () => {
  it("picks the feed with more bars", () => {
    expect(
      chooseFeed([
        { vendor: "databento-xnas", barCount: 800 },
        { vendor: "databento-xnys", barCount: 1200 },
      ]),
    ).toBe("databento-xnys");
  });
  it("breaks ties deterministically to databento-xnas", () => {
    expect(
      chooseFeed([
        { vendor: "databento-xnys", barCount: 1000 },
        { vendor: "databento-xnas", barCount: 1000 },
      ]),
    ).toBe("databento-xnas");
  });
});

describe("applySplitAdjustments", () => {
  it("backward-adjusts prices by 1/factor and volume by factor before the ex-date", () => {
    const bars = [bar("2024-01-02", 100, 1000), bar("2024-01-03", 100, 1000), bar("2024-01-04", 50, 2000)];
    const out = applySplitAdjustments(bars, [{ symbol: "X", exDate: "2024-01-04", factor: 2 }]);
    expect(out[0]!.close).toBeCloseTo(50, 10);
    expect(out[1]!.close).toBeCloseTo(50, 10);
    expect(out[2]!.close).toBeCloseTo(50, 10); // ex-date bar itself is on the new basis
    expect(out[0]!.volume).toBeCloseTo(2000, 10); // dollar volume invariant
    expect(out[2]!.volume).toBeCloseTo(2000, 10);
    // input untouched
    expect(bars[0]!.close).toBe(100);
  });

  it("compounds multiple splits and handles reverse splits (factor < 1)", () => {
    const bars = [bar("2024-01-02", 10), bar("2024-02-01", 10), bar("2024-03-01", 10)];
    const out = applySplitAdjustments(bars, [
      { symbol: "X", exDate: "2024-02-01", factor: 0.1 }, // 1:10 reverse
      { symbol: "X", exDate: "2024-03-01", factor: 2 }, // 2:1 forward
    ]);
    expect(out[0]!.close).toBeCloseTo(10 / (0.1 * 2), 10); // both splits after it
    expect(out[1]!.close).toBeCloseTo(10 / 2, 10);
    expect(out[2]!.close).toBeCloseTo(10, 10);
  });
});

describe("scaleDividendsToSplitBasis", () => {
  it("divides amounts by the cumulative factor of LATER splits only", () => {
    const divs = [{ date: "2024-01-15", type: "DIVIDEND" as const, amount: 1, currency: "USD" }];
    const splits = [
      { symbol: "X", exDate: "2024-01-10", factor: 2 }, // before the dividend: no effect
      { symbol: "X", exDate: "2024-02-01", factor: 4 }, // after: amount / 4
    ];
    const out = scaleDividendsToSplitBasis(divs, splits);
    expect(out[0]!.amount).toBeCloseTo(0.25, 10);
  });
});

describe("mergeSplits", () => {
  it("registry wins on a symbol+exDate collision with the detector rows", () => {
    const merged = mergeSplits(
      [{ symbol: "CDTX", exDate: "2024-04-24", factor: 0.05 }],
      [{ symbol: "CDTX", exDate: "2024-04-24", factor: 1 / 19 }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.factor).toBe(0.05);
  });
});

describe("VENDOR_EXTRA_SPLITS (the two P2/P3 detector-candidate rows)", () => {
  it("CDTX 2024-04-24 1:19 reverse and QXO 2024-07-30 16:3 forward, as pre-registered", () => {
    const cdtx = VENDOR_EXTRA_SPLITS.find((s) => s.symbol === "CDTX")!;
    const qxo = VENDOR_EXTRA_SPLITS.find((s) => s.symbol === "QXO")!;
    expect(cdtx.exDate).toBe("2024-04-24");
    expect(cdtx.factor).toBeCloseTo(1 / 19, 10);
    expect(qxo.exDate).toBe("2024-07-30");
    expect(qxo.factor).toBeCloseTo(16 / 3, 10);
  });
});

describe("assembleVendorSeries", () => {
  const art = artifacts({
    survivors: [
      { symbol: "AAA", vendorKeys: ["databento-xnas"] },
      { symbol: "DUAL", vendorKeys: ["databento-xnas", "databento-xnys"] },
      { symbol: "GAPCO", vendorKeys: ["databento-xnas"] },
      { symbol: "CDTX", vendorKeys: ["databento-xnas"] },
    ],
    quarantined: new Set(["databento-xnas|GAPCO"]),
    dividends: new Map([["AAA", [{ date: "2024-01-10", type: "DIVIDEND" as const, amount: 2, currency: "USD" }]]]),
    dividendResidual: new Set(["NOPE"]),
  });
  const rows: VendorBarRow[] = [
    row("databento-xnas", "AAA", "2024-01-02", 100),
    row("databento-xnas", "AAA", "2024-01-03", 100),
    row("databento-xnas", "AAA", "2024-01-10", 98),
    row("databento-xnys", "AAA", "2024-01-02", 777), // NOT a survivor series (vendorKeys: xnas only) — must not load
    row("databento-xnys", "DUAL", "2024-01-02", 10),
    row("databento-xnys", "DUAL", "2024-01-03", 10),
    row("databento-xnys", "DUAL", "2024-01-04", 10),
    row("databento-xnas", "DUAL", "2024-01-02", 999), // shorter feed: must not load
    row("databento-xnas", "GAPCO", "2024-01-02", 5), // quarantined: must not load
    row("databento-xnas", "CDTX", "2024-04-23", 10.5),
    row("databento-xnas", "CDTX", "2024-04-24", 200),
  ];
  const lane = assembleVendorSeries(rows, art, mergeSplits([], VENDOR_EXTRA_SPLITS), 2);

  it("loads only survivor SERIES (a non-survivor feed of a survivor symbol is ignored)", () => {
    const aaa = lane.series.filter((s) => s.symbol === "AAA");
    expect(aaa).toHaveLength(1);
    expect(aaa[0]!.bars.map((b) => b.close)).toEqual([100, 100, 98]); // xnas bars, never the 777 xnys bar
  });

  it("excludes the quarantined series (vendor+symbol)", () => {
    expect(lane.series.map((s) => s.symbol)).not.toContain("GAPCO");
    expect(lane.manifest.quarantinedExcluded).toBe(1);
  });

  it("loads a dual-feed symbol from exactly one feed (more bars)", () => {
    const dual = lane.series.filter((s) => s.symbol === "DUAL");
    expect(dual).toHaveLength(1);
    expect(dual[0]!.bars.map((b) => b.close)).toEqual([10, 10, 10]); // xnys feed, not the 999 bar
    expect(lane.manifest.dualFeedSymbols).toBe(1);
  });

  it("applies the CDTX detector split row to the loaded bars", () => {
    const cdtx = lane.series.find((s) => s.symbol === "CDTX")!;
    // 1:19 reverse on 2024-04-24: pre-ex bars scale UP by 19 (backward, anchored
    // at the latest bar) so the series is continuous at the post-split level.
    expect(cdtx.bars[0]!.close).toBeCloseTo(10.5 * 19, 6);
    expect(cdtx.bars[1]!.close).toBeCloseTo(200, 10); // ex-date bar unscaled
    expect(lane.manifest.splitEventsApplied).toBe(1);
    expect(lane.manifest.extraSplitsApplied.join(";")).toContain("CDTX 2024-04-24");
  });

  it("carries the Yahoo dividend into the symbol's dividend list (adjustment happens in quant-core)", () => {
    const aaa = lane.series.find((s) => s.symbol === "AAA")!;
    expect(aaa.dividends).toHaveLength(1);
    expect(aaa.caDegraded).toBe(false);
  });

  it("windowStart follows the minBars warmup rule", () => {
    expect(lane.windowStart).toBe("2024-01-03"); // first date any series has 2 bars (minBars=2)
    expect(lane.dates[0]).toBe("2024-01-03");
  });
});

describe("dividend adjustment on a synthetic ex-date (picker convention mirrored)", () => {
  it("scales prior bars by (1 - D/P_prev), P_prev = previous session close", () => {
    // adjustment.ts:50-68 — multiplicative back-adjustment, prev-close base.
    const bars = [bar("2024-01-02", 100), bar("2024-01-03", 100), bar("2024-01-04", 98)];
    const out = deriveAdjustedBars(bars, [
      { date: "2024-01-04", type: "DIVIDEND", amount: 2, currency: "USD" },
    ]);
    expect(out[0]!.close).toBeCloseTo(98, 10); // 100 * (1 - 2/100)
    expect(out[1]!.close).toBeCloseTo(98, 10);
    expect(out[2]!.close).toBeCloseTo(98, 10); // ex-date bar unscaled
  });

  it("amounts scaled onto the split basis reproduce the raw-basis factor exactly", () => {
    // 2:1 split AFTER the dividend: prices halve, the amount must halve too,
    // so (1 - D/P) on the adjusted basis equals the raw-basis ratio.
    const rawBars = [bar("2024-01-02", 100), bar("2024-01-03", 100), bar("2024-01-04", 98)];
    const splits = [{ symbol: "X", exDate: "2024-02-01", factor: 2 }];
    const adjBars = applySplitAdjustments(rawBars, splits);
    const scaledDivs = scaleDividendsToSplitBasis(
      [{ date: "2024-01-04", type: "DIVIDEND", amount: 2, currency: "USD" }],
      splits,
    );
    const out = deriveAdjustedBars(adjBars, scaledDivs);
    // adjusted prev close 50, scaled amount 1 → factor (1 - 1/50) = 0.98, same as raw.
    expect(out[0]!.close).toBeCloseTo(50 * 0.98, 10);
    expect(out[1]!.close).toBeCloseTo(50 * 0.98, 10);
    expect(out[2]!.close).toBeCloseTo(49, 10);
  });
});

describe("PIT correctness (replay truncation property)", () => {
  // 300 sessions of synthetic history so the 252-bar truncation engages; two
  // corporate actions AFTER day T must not change the day-T screen output.
  const days: string[] = [];
  for (let i = 0; i < 300; i++) {
    const d = new Date(Date.UTC(2024, 0, 2) + i * 86400000);
    days.push(d.toISOString().slice(0, 10));
  }
  const T = days[280]!;
  const mkSeries = (withFutureCA: boolean): SymbolSeries => ({
    symbol: "SYN",
    market: "US",
    caDegraded: false,
    bars: days.map((d, i) => bar(d, 100 + i * 0.1, 2_000_000)),
    dividends: withFutureCA
      ? [{ date: days[295]!, type: "DIVIDEND", amount: 5, currency: "USD" }]
      : [],
  });
  const flatten = (out: ReturnType<typeof replayScreen>) =>
    out.map((d) => ({
      date: d.date,
      ranked: d.ranked.map((p) => [p.symbol, p.score]),
      excluded: d.excludedCount,
    }));

  it("a dividend with exDate > T does not affect the day-T replay output", () => {
    const cal = days.slice(252, 281); // replay through T only
    expect(flatten(replayScreen(cal, [mkSeries(true)]))).toEqual(flatten(replayScreen(cal, [mkSeries(false)])));
  });

  it("a split with exDate > T does not affect the day-T replay output (uniform scaling invariance)", () => {
    const cal = days.slice(252, 281);
    const base = mkSeries(false);
    const withSplit: SymbolSeries = {
      ...base,
      bars: applySplitAdjustments(base.bars, [{ symbol: "SYN", exDate: days[295]!, factor: 7 }]),
    };
    expect(flatten(replayScreen(cal, [withSplit]))).toEqual(flatten(replayScreen(cal, [base])));
  });
});

describe("test-half firewall (backtest-vendor window gating)", () => {
  const calendar = ["2022-09-01", "2023-01-01", "2023-05-01", "2023-09-01", "2024-01-01", "2024-05-01"];

  it("splits the calendar chronologically at the midpoint session", () => {
    expect(testHalfStart(calendar)).toBe("2023-09-01");
    expect(testHalfStart(["2024-01-01"])).toBeNull();
  });

  it("defaults to the design half (earlier chronological half)", () => {
    const w = resolveWindow(calendar, { from: null, to: null, spendTestHalf: false });
    expect(w).toEqual({ from: "2022-09-01", to: "2023-05-01", testStart: "2023-09-01" });
  });

  it("refuses any window reaching the test half without --spend-test-half", () => {
    expect(() => resolveWindow(calendar, { from: null, to: "2023-09-01", spendTestHalf: false })).toThrow(/FIREWALL/);
    expect(() => resolveWindow(calendar, { from: "2024-01-01", to: null, spendTestHalf: false })).toThrow(/FIREWALL/);
  });

  it("allows the test half only with the explicit flag", () => {
    const w = resolveWindow(calendar, { from: "2023-09-01", to: "2024-05-01", spendTestHalf: true });
    expect(w.to).toBe("2024-05-01");
  });

  it("parses CLI args", () => {
    expect(parseVendorBacktestArgs(["--from", "2022-09-01", "--to", "2023-05-01", "--quiet"])).toEqual({
      from: "2022-09-01",
      to: "2023-05-01",
      spendTestHalf: false,
      quiet: true,
    });
    expect(() => parseVendorBacktestArgs(["--from", "2022/09/01"])).toThrow(/YYYY-MM-DD/);
    expect(() => parseVendorBacktestArgs(["--hack"])).toThrow(/unknown argument/);
  });
});
