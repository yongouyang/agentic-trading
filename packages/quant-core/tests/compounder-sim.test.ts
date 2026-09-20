/**
 * Phase 7 P4 — known-answer tests for the quarterly compounder simulation
 * (docs/phase-7-plan.md §4).
 */
import { describe, expect, it } from "vitest";
import {
  epCeiling,
  quarterlyRerankDates,
  simulateQuarterlyCompounder,
  type QuarterlySimInput,
} from "../src/compounder-sim.js";

describe("quarterlyRerankDates", () => {
  it("picks the first session of each quarter from startIdx", () => {
    const dates = ["2024-01-02", "2024-01-03", "2024-03-28", "2024-04-01", "2024-04-02", "2024-07-01"];
    const r = quarterlyRerankDates(dates, 0);
    expect([...r].sort((a, b) => a - b)).toEqual([0, 3, 5]);
  });

  it("respects startIdx (no re-rank before it)", () => {
    const dates = ["2024-01-02", "2024-04-01", "2024-07-01"];
    expect([...quarterlyRerankDates(dates, 2)]).toEqual([2]);
  });
});

describe("epCeiling", () => {
  it("excludes the bottom E/P quintile (the most expensive)", () => {
    // 10 names: E/P 0.01…0.10 → bottom two (0.01, 0.02) excluded
    const row = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.1];
    const keep = epCeiling(row);
    expect(keep[0]).toBe(null);
    expect(keep[1]).toBe(null);
    expect(keep[2]).toBe(0.03);
    expect(keep[9]).toBe(0.1);
  });

  it("keeps nulls null and refuses tiny cross-sections", () => {
    expect(epCeiling([0.05, null, 0.06])).toEqual([null, null, null]);
  });
});

// ---------------------------------------------------------------------------
// end-to-end simulation on a toy grid
// ---------------------------------------------------------------------------

/** 6 sessions across two quarters, 5 symbols, topN=2. */
function toyInput(over: Partial<QuarterlySimInput> = {}): QuarterlySimInput {
  const dates = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-04-01", "2024-04-02", "2024-04-03"];
  const symbols = ["AAA", "BBB", "CCC", "DDD", "EEE"];
  return {
    dates,
    symbols,
    close: dates.map(() => [100, 100, 100, 100, 100]),
    // AAA strongest, EEE weakest; EEE fails the E/P ceiling (bottom quintile)
    score: dates.map(() => [5, 4, 3, 2, 1]),
    ep: dates.map(() => [0.1, 0.09, 0.08, 0.07, 0.06]),
    gatePass: dates.map(() => [true, true, true, true, true] as (boolean | null)[]),
    topN: 2,
    bufferRank: 3,
    costRate: 0,
    startIdx: 0,
    gated: true,
    ...over,
  };
}

describe("simulateQuarterlyCompounder", () => {
  it("buys the top-N at the re-rank, filled at the NEXT session's close", () => {
    const r = simulateQuarterlyCompounder(toyInput());
    const buys = r.trades.filter((t) => t.entryDate);
    // final liquidation closes both at the last session
    const entries = [...new Set(buys.map((t) => `${t.symbol}@${t.entryDate}`))];
    expect(entries.sort()).toEqual(["AAA@2024-01-03", "BBB@2024-01-03"]);
    expect(r.trades.every((t) => t.exitReason === "final")).toBe(true);
  });

  it("exits on a nightly gate break at the next session's close", () => {
    const input = toyInput();
    // AAA's gate breaks on 2024-01-03 (its entry day) → exit at 2024-01-04's close
    input.gatePass = input.dates.map((_, d) => [d < 1, true, true, true, true] as (boolean | null)[]);
    const r = simulateQuarterlyCompounder(input);
    const gateExit = r.trades.find((t) => t.exitReason === "gate");
    expect(gateExit?.symbol).toBe("AAA");
    expect(gateExit?.exitDate).toBe("2024-01-04");
    // no re-entry until a re-rank — and AAA's gate never recovers
    expect(r.trades.filter((t) => t.symbol === "AAA")).toHaveLength(1);
  });

  it("drops a holding at the re-rank when it falls out of the buffer", () => {
    const input = toyInput();
    // In Q2 the ranking flips: CCC first, BBB second, AAA third — topN=2,
    // bufferRank=3 → AAA (rank 3) survives the buffer, nobody exits
    input.score = input.dates.map((_, d) => (d < 3 ? [5, 4, 3, 2, 1] : [3, 4, 5, 2, 1]));
    let r = simulateQuarterlyCompounder(input);
    expect(r.trades.filter((t) => t.exitReason === "rerank")).toHaveLength(0);
    // now tighten: bufferRank=2 → AAA (rank 3) exits at the re-rank
    input.bufferRank = 2;
    r = simulateQuarterlyCompounder(input);
    const rerankExit = r.trades.find((t) => t.exitReason === "rerank");
    expect(rerankExit?.symbol).toBe("AAA");
    expect(rerankExit?.exitDate).toBe("2024-04-02"); // re-rank 04-01 → fill 04-02
    // CCC enters the same day
    expect(r.trades.some((t) => t.symbol === "CCC" && t.entryDate === "2024-04-02")).toBe(true);
  });

  it("ungated variant ignores the gate entirely", () => {
    const input = toyInput({ gated: false });
    input.gatePass = input.dates.map(() => [false, false, false, false, false] as (boolean | null)[]);
    const r = simulateQuarterlyCompounder(input);
    expect(r.trades.filter((t) => t.exitReason === "final")).toHaveLength(2);
  });

  it("carries the last mark across a gap day (no equity collapse)", () => {
    const input = toyInput();
    // 2024-01-04: every close missing — equity must not collapse to cash
    input.close = input.dates.map((_, d) =>
      d === 2 ? ([null, null, null, null, null] as (number | null)[]) : ([100, 100, 100, 100, 100] as (number | null)[]),
    );
    const r = simulateQuarterlyCompounder(input);
    expect(r.equity[2]!).toBeCloseTo(1, 9);
    expect(Math.min(...r.equity)).toBeGreaterThan(0.9);
  });

  it("marks equity with P&L when prices move", () => {
    const input = toyInput();
    input.close = input.dates.map((_, d) => [100 + d * 10, 100, 100, 100, 100] as (number | null)[]);
    const r = simulateQuarterlyCompounder(input);
    // AAA bought at 2024-01-03 close (110), sold at the final close (150);
    // BBB flat. Final equity = cash = 0.5·(150/110) + 0.5
    expect(r.equity[r.equity.length - 1]!).toBeCloseTo(0.5 * (150 / 110) + 0.5, 9);
    const lastTrade = r.trades.find((t) => t.symbol === "AAA")!;
    expect(lastTrade.returnPct).toBeCloseTo(150 / 110 - 1, 9);
  });
});
