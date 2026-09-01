import { describe, expect, it } from "vitest";
import { Bar, DataOutcome } from "../src/types.js";
import {
  checkDuplicates,
  findDateGaps,
  findZeroVolumeBars,
  isStaleLastBar,
  checkOhlcSanity,
  findOutlierMoves,
  runChecks,
  dropHolidayPhantomBars,
  clampOhlc,
  classifyResponse,
} from "../src/data-quality.js";

const bar = (date: string, close: number, o: Partial<Bar> = {}): Bar => ({
  date,
  open: o.open ?? close,
  high: o.high ?? close * 1.02,
  low: o.low ?? close * 0.98,
  close,
  volume: o.volume === undefined ? 1_000 : o.volume,
});

describe("Day-17 checks (ported from spike/data-probe.ts)", () => {
  it("counts duplicate timestamps", () => {
    expect(checkDuplicates(["2025-01-02", "2025-01-02", "2025-01-03"])).toBe(1);
    expect(checkDuplicates(["2025-01-02", "2025-01-03"])).toBe(0);
  });

  it("finds date gaps beyond the holiday allowance", () => {
    const dates = ["2025-01-02", "2025-01-03", "2025-01-20"]; // 10 weekdays missing
    const { missing, allowance } = findDateGaps(dates, "US");
    expect(missing).toContain("2025-01-06");
    expect(missing.length).toBeGreaterThan(allowance);
  });

  it("finds zero/null-volume bars", () => {
    const zv = findZeroVolumeBars([bar("2025-01-02", 10, { volume: 0 }), bar("2025-01-03", 10)]);
    expect(zv.map((b) => b.date)).toEqual(["2025-01-02"]);
  });

  it("flags a stale last bar (deterministic `today`)", () => {
    expect(isStaleLastBar("2025-01-02", "2025-01-10")).toBe(true);
    expect(isStaleLastBar("2025-01-10", "2025-01-10")).toBe(false);
  });

  it("detects OHLC sanity violations (non-positive close, close outside [H,L])", () => {
    const bars = [
      bar("2025-01-02", -1, { open: -1, high: -0.9, low: -1.1 }),
      bar("2025-01-03", 10, { high: 9, low: 8 }), // close 10 > high 9
      bar("2025-01-06", 10),
    ];
    const { nonPositive, outsideHL } = checkOhlcSanity(bars);
    expect(nonPositive).toEqual(["2025-01-02"]);
    expect(outsideHL).toEqual(["2025-01-03"]);
  });

  it("flags |ret|>20% single-day moves as warnings, never repairs them", () => {
    const spikes = findOutlierMoves([bar("2025-01-02", 100), bar("2025-01-03", 125), bar("2025-01-06", 110)]);
    expect(spikes).toHaveLength(1);
    expect(spikes[0]!.date).toBe("2025-01-03");
  });

  it("runChecks aggregates failures and warnings loudly", () => {
    const bars = [bar("2025-01-02", 100), bar("2025-01-02", 100), bar("2025-01-03", 130, { volume: 0 })];
    const r = runChecks("US", bars, "2025-01-10");
    expect(r.failures.some((f) => f.includes("duplicate"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("zero/null-volume"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("outliers"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("stale last bar"))).toBe(true);
  });
});

describe("loader rules (measured facts, verification report 2026-08-31)", () => {
  // RULE L1: Yahoo fabricates zero-volume phantom bars on HKEX holidays
  // (2022-01-31, every HK ticker). Illiquid-name zero-volume bars on real
  // sessions (0623.HK: 250/1227) are genuine and must be KEPT.
  it("drops holiday phantom bars but keeps genuine illiquid zero-volume bars", () => {
    const bars = [
      bar("2022-01-28", 470),
      bar("2022-01-31", 470, { volume: 0 }), // HKEX closed (Lunar New Year)
      bar("2022-02-01", 471, { volume: 0 }), // real session, illiquid name
    ];
    const kept = dropHolidayPhantomBars(bars, new Set(["2022-01-31"]));
    expect(kept.map((b) => b.date)).toEqual(["2022-01-28", "2022-02-01"]);
  });

  // RULE L2: close-outside-[H,L] clamp/repair (1–16 bars on LSE UCITS, HK edge).
  it("clamps an out-of-range close and reports the repaired dates", () => {
    const { bars: out, repaired } = clampOhlc([bar("2025-01-02", 10, { high: 9.5, low: 9 })]);
    expect(out[0]!.close).toBe(9.5);
    expect(repaired).toEqual(["2025-01-02"]);
    // clean bars untouched
    const clean = clampOhlc([bar("2025-01-02", 10)]);
    expect(clean.repaired).toEqual([]);
    expect(clean.bars[0]!.close).toBe(10);
  });

  // RULE L3/L4 + taxonomy: G5 probes measured 5/5.
  it("classifies the G5 taxonomy probes", () => {
    // invalid symbol → GENUINELY_ABSENT (source-scoped: never "does not exist")
    expect(classifyResponse({ httpStatus: 200, hasTimestamps: false, barCount: 0, providerSaysNotFound: true })).toBe(
      DataOutcome.GENUINELY_ABSENT,
    );
    expect(classifyResponse({ httpStatus: 404, hasTimestamps: false, barCount: 0, providerSaysNotFound: false })).toBe(
      DataOutcome.GENUINELY_ABSENT,
    );
    // 429 / transport failure → FETCH_FAILED
    expect(classifyResponse({ httpStatus: 429, hasTimestamps: false, barCount: 0, providerSaysNotFound: false })).toBe(
      DataOutcome.FETCH_FAILED,
    );
    expect(classifyResponse({ httpStatus: null, hasTimestamps: false, barCount: 0, providerSaysNotFound: false })).toBe(
      DataOutcome.FETCH_FAILED,
    );
    // RULE L3: zombie meta — HTTP 200 + no timestamps (RYL) → FETCH_FAILED
    expect(classifyResponse({ httpStatus: 200, hasTimestamps: false, barCount: 0, providerSaysNotFound: false })).toBe(
      DataOutcome.FETCH_FAILED,
    );
    // RULE L4: HTTP 200 + empty bar array (tencent hk0005) → FETCH_FAILED
    expect(classifyResponse({ httpStatus: 200, hasTimestamps: true, barCount: 0, providerSaysNotFound: false })).toBe(
      DataOutcome.FETCH_FAILED,
    );
    // good payload → OK
    expect(classifyResponse({ httpStatus: 200, hasTimestamps: true, barCount: 1227, providerSaysNotFound: false })).toBe(
      DataOutcome.OK,
    );
  });
});
