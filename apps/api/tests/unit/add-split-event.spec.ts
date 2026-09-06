/**
 * Pure-function tests for the SplitEvent append CLI
 * (src/cli/add-split-event.ts). Covers the BHVN 2022-10-04 use case
 * (non-integer measured factor from the Pfizer/new-Biohaven discontinuity)
 * plus the direction/consistency guards. No db, no filesystem.
 */
import { describe, expect, it } from "vitest";
import { buildSplitEventRow } from "../../src/cli/add-split-event.js";

describe("buildSplitEventRow", () => {
  it("builds an inband/estimated forward row with derived factor (BHVN 2022-10-04)", () => {
    const row = buildSplitEventRow({
      symbol: "BHVN",
      exDate: "2022-10-04",
      event: "FORWARD_SPLIT",
      ratioNew: 18.289,
      ratioOld: 1,
      source: "inband",
    });
    expect(row).toEqual({
      symbol: "BHVN",
      exDate: "2022-10-04",
      event: "FORWARD_SPLIT",
      ratioNew: 18.289,
      ratioOld: 1,
      factor: 18.289,
      source: "inband",
      confidence: "estimated",
    });
  });

  it("marks yahoo-sourced rows authoritative", () => {
    const row = buildSplitEventRow({
      symbol: "X",
      exDate: "2024-01-02",
      event: "REVERSE_SPLIT",
      ratioNew: 1,
      ratioOld: 10,
      source: "yahoo",
    });
    expect(row.confidence).toBe("authoritative");
    expect(row.factor).toBe(0.1);
  });

  it("rejects direction/factor mismatch", () => {
    expect(() =>
      buildSplitEventRow({ symbol: "X", exDate: "2024-01-02", event: "FORWARD_SPLIT", ratioNew: 1, ratioOld: 8, source: "inband" }),
    ).toThrow(/factor > 1/);
    expect(() =>
      buildSplitEventRow({ symbol: "X", exDate: "2024-01-02", event: "REVERSE_SPLIT", ratioNew: 2, ratioOld: 1, source: "inband" }),
    ).toThrow(/factor < 1/);
  });

  it("rejects bad date, unknown event/source, non-positive ratios", () => {
    const base = { symbol: "X", exDate: "2024-01-02", event: "FORWARD_SPLIT", ratioNew: 2, ratioOld: 1, source: "inband" };
    expect(() => buildSplitEventRow({ ...base, exDate: "01/02/2024" })).toThrow(/YYYY-MM-DD/);
    expect(() => buildSplitEventRow({ ...base, event: "SPINOFF" })).toThrow(/FORWARD_SPLIT/);
    expect(() => buildSplitEventRow({ ...base, source: "detector" })).toThrow(/yahoo \| inband/);
    expect(() => buildSplitEventRow({ ...base, ratioOld: 0 })).toThrow(/positive/);
    expect(() => buildSplitEventRow({ ...base, symbol: "" })).toThrow(/--symbol/);
  });
});
