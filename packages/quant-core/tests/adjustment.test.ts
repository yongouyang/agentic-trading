import { describe, expect, it } from "vitest";
import { Bar, CorporateAction } from "../src/types.js";
import { deriveAdjustedCloses, deriveAdjustedBars } from "../src/adjustment.js";

const bar = (date: string, close: number, ohlc?: Partial<Bar>): Bar => ({
  date,
  open: ohlc?.open ?? close,
  high: ohlc?.high ?? close * 1.01,
  low: ohlc?.low ?? close * 0.99,
  close,
  volume: ohlc?.volume ?? 1_000_000,
});

const div = (date: string, amount: number): CorporateAction => ({
  date,
  type: "DIVIDEND",
  amount,
  currency: "USD",
});

describe("deriveAdjustedCloses — R1 convention (measured 2026-08-31)", () => {
  // NVDA-style: provider raw is ALREADY split-adjusted (10:1 on 2024-06-10).
  // The event feed carries the split, but R1 applies DIVIDEND EVENTS ONLY.
  // Applying the split factor double-counts (measured: NVDA +900% error).
  it("applies NO split factor to split-adjusted raw (NVDA-style regression)", () => {
    // Pre-split session closes delivered split-adjusted: 10, 11; post: 12, 12.5.
    const bars = [bar("2024-06-06", 10), bar("2024-06-07", 11), bar("2024-06-10", 12), bar("2024-06-11", 12.5)];
    const dividends = [div("2024-06-11", 0.1)]; // ex-date 06-11, prev close = 12
    const adj = deriveAdjustedCloses(bars, dividends);
    const expectedFactor = 1 - 0.1 / 12;
    expect(adj.get("2024-06-06")).toBeCloseTo(10 * expectedFactor, 10);
    expect(adj.get("2024-06-07")).toBeCloseTo(11 * expectedFactor, 10);
    expect(adj.get("2024-06-10")).toBeCloseTo(12 * expectedFactor, 10);
    // If a 10:1 split factor were (wrongly) applied, pre-split bars would be
    // ~10x smaller — assert they are NOT.
    expect(adj.get("2024-06-06")!).toBeGreaterThan(1);
  });

  it("is anchored at the latest bar (latest adj == latest raw)", () => {
    const bars = [bar("2025-01-02", 100), bar("2025-01-03", 102), bar("2025-01-06", 105)];
    const adj = deriveAdjustedCloses(bars, [div("2025-01-06", 2)]);
    expect(adj.get("2025-01-06")).toBe(105);
  });

  // 2800.HK-style regression: the dividend price base is the PREVIOUS
  // SESSION'S close. Measured: prev-close base → 0.0000% vs Yahoo adjclose;
  // ex-date-close base → 0.61% error.
  it("uses the previous session's close as the dividend base (2800.HK-style)", () => {
    const bars = [bar("2025-03-03", 50), bar("2025-03-04", 49), bar("2025-03-05", 51)];
    const adj = deriveAdjustedCloses(bars, [div("2025-03-05", 1)]);
    // prev close of the ex-date (03-05) is 49, NOT the ex-date close 51.
    expect(adj.get("2025-03-03")).toBeCloseTo(50 * (1 - 1 / 49), 10);
    const wrongBase = 50 * (1 - 1 / 51);
    expect(Math.abs(adj.get("2025-03-03")! - wrongBase)).toBeGreaterThan(1e-6);
  });

  it("only events AFTER the bar's date contribute (i > t)", () => {
    const bars = [bar("2025-01-02", 100), bar("2025-01-03", 100), bar("2025-01-06", 100)];
    const adj = deriveAdjustedCloses(bars, [div("2025-01-03", 5)]);
    expect(adj.get("2025-01-02")).toBeCloseTo(100 * (1 - 5 / 100), 10);
    expect(adj.get("2025-01-03")).toBe(100); // ex-date bar itself: unadjusted
  });

  it("skips events whose ex-date has no previous close in the series", () => {
    const bars = [bar("2025-01-02", 100), bar("2025-01-03", 100)];
    const adj = deriveAdjustedCloses(bars, [div("2020-01-01", 5)]);
    expect(adj.get("2025-01-02")).toBe(100);
  });

  it("skips a dividend whose ex-date falls between bars (no prev close for it)", () => {
    // Ex-date 2025-01-04 is a Saturday: there is no bar on it, so there is no
    // previous-session close keyed to that date and the event cannot be priced.
    const bars = [bar("2025-01-02", 100), bar("2025-01-03", 100), bar("2025-01-06", 100)];
    const adj = deriveAdjustedCloses(bars, [div("2025-01-04", 5)]);
    expect(adj.get("2025-01-02")).toBe(100);
    expect(adj.get("2025-01-03")).toBe(100);
  });

  it("compounds multiple dividend events multiplicatively", () => {
    const bars = [bar("2025-01-02", 100), bar("2025-01-03", 50), bar("2025-01-06", 25)];
    const adj = deriveAdjustedCloses(bars, [div("2025-01-03", 5), div("2025-01-06", 2.5)]);
    // prev closes: 100 for the 01-03 ex-date, 50 for the 01-06 ex-date.
    expect(adj.get("2025-01-02")).toBeCloseTo(100 * (1 - 5 / 100) * (1 - 2.5 / 50), 10);
    expect(adj.get("2025-01-03")).toBeCloseTo(50 * (1 - 2.5 / 50), 10);
    expect(adj.get("2025-01-06")).toBe(25);
  });

  it("ignores non-DIVIDEND corporate actions", () => {
    const split = { date: "2025-01-06", type: "SPLIT", amount: 10, currency: "USD" } as unknown as CorporateAction;
    const bars = [bar("2025-01-02", 100), bar("2025-01-03", 100), bar("2025-01-06", 100)];
    const adj = deriveAdjustedCloses(bars, [split]);
    expect(adj.get("2025-01-02")).toBe(100);
  });

  it("skips bars with a null close", () => {
    const bars = [bar("2025-01-02", 100), { ...bar("2025-01-03", 0), close: null }, bar("2025-01-06", 102)];
    const adj = deriveAdjustedCloses(bars, []);
    expect(adj.has("2025-01-03")).toBe(false);
    expect(adj.get("2025-01-06")).toBe(102);
  });

  it("returns an empty map for empty input", () => {
    expect(deriveAdjustedCloses([], []).size).toBe(0);
    expect(deriveAdjustedBars([], [])).toEqual([]);
  });
});

describe("deriveAdjustedBars", () => {
  it("scales OHLC by the close factor", () => {
    const bars = [bar("2025-01-02", 100, { open: 99, high: 101, low: 98 }), bar("2025-01-03", 100)];
    const out = deriveAdjustedBars(bars, [div("2025-01-03", 2)]);
    const f = 1 - 2 / 100;
    expect(out[0]!.close).toBeCloseTo(100 * f, 10);
    expect(out[0]!.open).toBeCloseTo(99 * f, 10);
    expect(out[0]!.high).toBeCloseTo(101 * f, 10);
    expect(out[0]!.low).toBeCloseTo(98 * f, 10);
    expect(out[0]!.adjustedClose).toBeCloseTo(out[0]!.close!, 12);
  });

  it("preserves null OHLC legs instead of fabricating prices", () => {
    const bars: Bar[] = [
      { date: "2025-01-02", open: null, high: null, low: null, close: 100, volume: null },
      bar("2025-01-03", 100),
    ];
    const out = deriveAdjustedBars(bars, [div("2025-01-03", 2)]);
    expect(out).toHaveLength(2);
    expect(out[0]!.open).toBeNull();
    expect(out[0]!.high).toBeNull();
    expect(out[0]!.low).toBeNull();
    expect(out[0]!.close).toBeCloseTo(100 * (1 - 2 / 100), 10);
  });

  it("drops bars with a null close entirely", () => {
    const bars: Bar[] = [
      bar("2025-01-02", 100),
      { date: "2025-01-03", open: null, high: null, low: null, close: null, volume: null },
    ];
    expect(deriveAdjustedBars(bars, [])).toHaveLength(1);
  });
});
