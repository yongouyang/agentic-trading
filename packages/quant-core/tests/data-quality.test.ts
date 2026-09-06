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
  dropNullCloseBars,
  dropLevelBreakSegment,
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

const flatBar = (date: string, level: number): Bar => ({ date, open: level, high: level, low: level, close: level, volume: 0 });

/** 3195.HK shape: a prefix of flat zero-volume bars at 1.0x stitched onto a
 *  ~7.8x HKD series (the USD-counter segment, measured ratio ~7.77). */
function stitchedSeries(prefixBars: number, prefixLevel: number, mainBars: number, mainLevel: number): Bar[] {
  const out: Bar[] = [];
  let d = 1;
  for (let i = 0; i < prefixBars; i++, d++) out.push(flatBar(`2024-04-${String(d).padStart(2, "0")}`, prefixLevel));
  let m = 8, day = 8;
  for (let i = 0; i < mainBars; i++) {
    out.push(bar(`2024-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`, mainLevel * (1 + (i % 5) * 0.005)));
    if (++day > 28) {
      day = 1;
      m++;
    }
  }
  return out;
}

describe("RULE L5 — dropNullCloseBars (still-forming bars with null OHLC)", () => {
  it("drops null-close bars, keeps others, returns the dropped dates", () => {
    const nullBar: Bar = { date: "2026-08-28", open: null, high: null, low: null, close: null, volume: null };
    const { bars: out, dropped } = dropNullCloseBars([bar("2026-08-27", 100), nullBar, bar("2026-08-31", 101)]);
    expect(out.map((b) => b.date)).toEqual(["2026-08-27", "2026-08-31"]);
    expect(dropped).toEqual(["2026-08-28"]);
  });

  it("handles empty and all-null input", () => {
    expect(dropNullCloseBars([])).toEqual({ bars: [], dropped: [] });
    const nullBar = (d: string): Bar => ({ date: d, open: null, high: null, low: null, close: null, volume: null });
    const r = dropNullCloseBars([nullBar("2026-09-01"), nullBar("2026-09-02")]);
    expect(r.bars).toEqual([]);
    expect(r.dropped).toEqual(["2026-09-01", "2026-09-02"]);
  });
});

describe("RULE L6 — dropLevelBreakSegment (cross-currency stitching guard)", () => {
  it("drops the 3195.HK peg-fingerprint prefix and warns with the ratio", () => {
    const bars = stitchedSeries(10, 1.05, 30, 8.19);
    const r = dropLevelBreakSegment(bars);
    expect(r.dropped).toHaveLength(10);
    expect(r.dropped[0]).toBe("2024-04-01");
    expect(r.bars).toHaveLength(30);
    expect(r.bars.some((b) => b.date.startsWith("2024-04"))).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/×7\.8/);
    expect(r.warnings.join(" ")).toContain("peg");
  });

  it("keeps a non-peg level break (2836.HK ×2.1 class) and flags it", () => {
    const bars = stitchedSeries(10, 50, 30, 105);
    const r = dropLevelBreakSegment(bars);
    expect(r.dropped).toEqual([]);
    expect(r.bars).toHaveLength(40);
    expect(r.warnings.join(" ")).toMatch(/×2\.1/);
    expect(r.warnings.join(" ")).toContain("adjudicate");
  });

  it("drops a peg-fingerprint SUFFIX segment the same way", () => {
    const main = stitchedSeries(0, 1, 30, 8.1);
    const suffix: Bar[] = [];
    let d = 1;
    for (let i = 0; i < 8; i++, d++) suffix.push(flatBar(`2025-01-${String(d).padStart(2, "0")}`, 1.04));
    const r = dropLevelBreakSegment([...main, ...suffix]);
    expect(r.dropped).toEqual(suffix.map((b) => b.date));
    expect(r.bars).toHaveLength(30);
  });

  it("leaves a no-break series untouched", () => {
    const bars = stitchedSeries(0, 1, 40, 100);
    const r = dropLevelBreakSegment(bars);
    expect(r.bars).toHaveLength(40);
    expect(r.dropped).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("short run (<3): a single flat zero-volume bar breaking >10% vs its previous bar warns but never drops", () => {
    const bars = [...stitchedSeries(0, 1, 30, 100), flatBar("2025-01-02", 130)];
    const r = dropLevelBreakSegment(bars);
    expect(r.dropped).toEqual([]);
    expect(r.bars).toHaveLength(31);
    expect(r.warnings.join(" ")).toContain("point break");
    expect(r.warnings.join(" ")).toContain("2025-01-02");
  });

  it("never drops a majority segment — keeps everything and warns instead", () => {
    const bars = [...stitchedSeries(40, 1.05, 0, 0), ...stitchedSeries(0, 1, 30, 8.19)];
    const r = dropLevelBreakSegment(bars);
    expect(r.dropped).toEqual([]);
    expect(r.bars).toHaveLength(70);
    expect(r.warnings.join(" ")).toContain("majority");
  });
});
