import { describe, expect, it } from "vitest";
import {
  MIN_CORR_OVERLAP,
  pairwiseCorrelation,
  returnsByDate,
  summarizeCorrelation,
} from "../src/correlation.js";

/** Deterministic wiggly series, length n, seeded by `seed` — no Math.random. */
function series(n: number, seed: number): number[] {
  return Array.from({ length: n }, (_, i) => Math.sin(i * 0.7 + seed) * 0.01 + (i % 3) * 0.001);
}

describe("returnsByDate", () => {
  it("keys simple returns by the later date and skips non-positive/null closes", () => {
    const rets = returnsByDate([
      { date: "2026-09-10", close: 100 },
      { date: "2026-09-11", close: 101 },
      { date: "2026-09-14", close: null },
      { date: "2026-09-15", close: 103 },
    ]);
    expect(rets.get("2026-09-11")).toBeCloseTo(0.01, 10);
    expect(rets.has("2026-09-14")).toBe(false);
    expect(rets.has("2026-09-15")).toBe(false); // previous close null → no observation
    expect(rets.size).toBe(1);
  });
});

describe("pairwiseCorrelation + summarizeCorrelation", () => {
  const dates = Array.from({ length: 60 }, (_, i) => `2026-07-${String(i + 1).padStart(2, "0")}`);

  it("intersects on common dates; diagonal is 1; missing dates are not fabricated", () => {
    const a = series(60, 1);
    const byDate = (vals: number[], keep: (i: number) => boolean = () => true) =>
      new Map(dates.map((d, i) => [d, vals[i]!] as const).filter((_, idx) => keep(idx)));
    const corr = pairwiseCorrelation(
      new Map([
        ["AAA", byDate(a)],
        ["BBB", byDate(a, (i) => i >= 10)], // identical series, 10 fewer dates
        ["CCC", byDate(series(60, 9))], // independent
      ]),
    );
    expect(corr.symbols).toEqual(["AAA", "BBB", "CCC"]);
    expect(corr.matrix[0]![0]).toBe(1);
    expect(corr.matrix[0]![1]).toBeCloseTo(1, 10);
    expect(corr.overlaps[0]![1]).toBe(50);
    expect(corr.overlaps[1]![0]).toBe(50);
    expect(Math.abs(corr.matrix[0]![2]!)).toBeLessThan(0.3);

    const s = summarizeCorrelation(corr);
    expect(s.pairs).toBe(3);
    expect(s.unmeasurable).toBe(0);
    expect(s.mean).not.toBeNull();
    expect(s.max).toBeCloseTo(1, 10);
    expect(s.maxPair).toEqual(["AAA", "BBB"]);
  });

  it("pairs below MIN_CORR_OVERLAP report null and count as unmeasurable", () => {
    const a = series(60, 1);
    const byDate = (vals: number[], keep: (i: number) => boolean) =>
      new Map(dates.map((d, i) => [d, vals[i]!] as const).filter((_, idx) => keep(idx)));
    const corr = pairwiseCorrelation(
      new Map([
        ["AAA", byDate(a, (i) => i < MIN_CORR_OVERLAP - 1)],
        ["BBB", byDate(a, (i) => i < MIN_CORR_OVERLAP - 1)], // 19 common dates
        ["CCC", byDate(a, (i) => i >= MIN_CORR_OVERLAP)], // zero common with AAA
      ]),
    );
    expect(corr.matrix[0]![1]).toBeNull();
    expect(corr.matrix[0]![2]).toBeNull();
    const s = summarizeCorrelation(corr);
    expect(s.pairs).toBe(0);
    expect(s.unmeasurable).toBe(3);
    expect(s.mean).toBeNull();
    expect(s.maxPair).toBeNull();
  });

  it("a negated series correlates at -1", () => {
    const a = series(60, 1);
    const byDate = (vals: number[]) => new Map(dates.map((d, i) => [d, vals[i]!] as const));
    const corr = pairwiseCorrelation(
      new Map([
        ["AAA", byDate(a)],
        ["BBB", byDate(a.map((v) => -v))],
      ]),
    );
    expect(corr.matrix[0]![1]).toBeCloseTo(-1, 10);
  });
});
