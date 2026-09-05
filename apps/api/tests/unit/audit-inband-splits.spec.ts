/**
 * Pure-function tests for the in-band SplitEvent corroboration rubric
 * (src/cli/audit-inband-splits.ts). Key case: the BR 2024-10-04 false
 * positive must classify 'uncorroborated' — the detector was fooled by a
 * single bad open print (114.75 vs prev close 215.07, factor 1.875) while
 * the ex-date close (215.39) shows no repricing. A genuine split reprices
 * open AND close. Also: segment-boundary rows are their own class (a
 * ticker stitch is not corroboration), and missing bars are 'no-bars'.
 * No db, no filesystem.
 */
import { describe, expect, it } from "vitest";
import { classifyInbandRow, CORROBORATED_LOG, DRIFTED_LOG, type AuditBar } from "../../src/cli/audit-inband-splits.js";

const bar = (date: string, open: number, close: number, segmentId = "S#1"): AuditBar => ({ date, open, close, segmentId });

describe("classifyInbandRow", () => {
  it("corroborates a genuine 2:1 split (open and close both halve)", () => {
    const bars = [bar("2024-01-02", 100, 100), bar("2024-01-03", 50.5, 49.5)];
    const v = classifyInbandRow({ symbol: "S", exDate: "2024-01-03", factor: 2 }, bars);
    expect(v.cls).toBe("corroborated");
    expect(v.measuredOpen).toBeCloseTo(100 / 50.5, 6);
    expect(v.measuredClose).toBeCloseTo(100 / 49.5, 6);
  });

  it("reproduces BR 2024-10-04 as uncorroborated (bad open print, close unmoved)", () => {
    // Exact vendor rows: 2024-10-03 close 215.07; 2024-10-04 open 114.75, close 215.39.
    const bars = [bar("2024-10-03", 215, 215.07), bar("2024-10-04", 114.75, 215.39)];
    const v = classifyInbandRow({ symbol: "BR", exDate: "2024-10-04", factor: 1.875 }, bars);
    expect(v.errOpen).toBeLessThan(0.001); // open matches factor almost exactly — the trap
    expect(v.errClose).toBeGreaterThan(DRIFTED_LOG);
    expect(v.cls).toBe("uncorroborated");
  });

  it("drifted-but-plausible when the close repriced but drifted intraday", () => {
    // factor 2; open halves exactly, close lands at 55 (e = ln(100/55/2) ≈ 0.095·? → within 2× band)
    const bars = [bar("2024-01-02", 100, 100), bar("2024-01-03", 50, 68)];
    const v = classifyInbandRow({ symbol: "S", exDate: "2024-01-03", factor: 2 }, bars);
    expect(v.errOpen).toBeLessThan(CORROBORATED_LOG);
    expect(v.errClose).toBeGreaterThan(CORROBORATED_LOG);
    expect(v.errClose).toBeLessThanOrEqual(DRIFTED_LOG);
    expect(v.cls).toBe("drifted-but-plausible");
  });

  it("flags rows sitting on a segment boundary as their own class", () => {
    const bars = [bar("2024-01-02", 100, 100, "S#1"), bar("2024-02-01", 5, 5, "S#2")];
    const v = classifyInbandRow({ symbol: "S", exDate: "2024-02-01", factor: 20 }, bars);
    expect(v.cls).toBe("sits-on-segment-boundary");
    expect(v.measuredOpen).toBeNull();
  });

  it("no-bars when ex-date or prev tradeable bar is missing", () => {
    expect(classifyInbandRow({ symbol: "S", exDate: "2024-01-03", factor: 2 }, [bar("2024-01-02", 100, 100)]).cls).toBe("no-bars");
    expect(classifyInbandRow({ symbol: "S", exDate: "2024-01-02", factor: 2 }, [bar("2024-01-02", 100, 100)]).cls).toBe("no-bars");
    // null-close bars are not tradeable
    const bars: AuditBar[] = [
      { date: "2024-01-02", open: 100, close: 100, segmentId: "S#1" },
      { date: "2024-01-03", open: null, close: null, segmentId: "S#1" },
    ];
    expect(classifyInbandRow({ symbol: "S", exDate: "2024-01-03", factor: 2 }, bars).cls).toBe("no-bars");
  });

  it("uses the last tradeable bar BEFORE exDate as prev (skips halts/nulls)", () => {
    const bars: AuditBar[] = [
      bar("2024-01-02", 100, 100),
      { date: "2024-01-03", open: null, close: null, segmentId: "S#1" },
      bar("2024-01-04", 50, 49),
    ];
    const v = classifyInbandRow({ symbol: "S", exDate: "2024-01-04", factor: 2 }, bars);
    expect(v.prevDate).toBe("2024-01-02");
    expect(v.cls).toBe("corroborated");
  });
});
