/**
 * Pure-function tests for the vendor-archive stitch rule
 * (research-databento-import.md §6.8 + the volume-signature strengthening —
 * see the header note in src/cli/segment-vendor-bars.ts): META-like reuse
 * flagged; a plain trading gap without a price discontinuity NOT flagged;
 * a jump with a SplitEvent on the date NOT flagged; a jump matching a
 * rational (3:1) with split-consistent volume NOT flagged; the same jump
 * with occupant-swap volume IS flagged; a same-day big jump NOT flagged
 * (documented limitation — reuse without a gap is missed by design);
 * multi-stitch series partitioned into 3 segments. No db, no filesystem.
 */
import { describe, expect, it } from "vitest";
import {
  assignSegments,
  explainingSplitFactor,
  findBoundaries,
  matchesRationalFactor,
  nearestRationalFactor,
  type SegBar,
} from "../../src/cli/segment-vendor-bars.js";

const bar = (date: string, price: number, volume = 1000): SegBar => ({ date, open: price, close: price, volume });

/** Daily bars from `start` for `n` sessions at `price`/`volume`. */
function series(start: string, n: number, price: number, volume = 1000): SegBar[] {
  const out: SegBar[] = [];
  const t = Date.parse(start);
  for (let i = 0; i < n; i++) {
    out.push(bar(new Date(t + i * 86400000).toISOString().slice(0, 10), price, volume));
  }
  return out;
}

describe("nearestRationalFactor / matchesRationalFactor (price-only lattice, 5% log)", () => {
  it("matches common split factors both directions", () => {
    expect(nearestRationalFactor(2)?.factor).toBe(2);
    expect(matchesRationalFactor(1 / 3)).toBe(true);
    expect(matchesRationalFactor(10)).toBe(true);
    expect(matchesRationalFactor(1 / 65)).toBe(true);
  });

  it("the lattice is dense: META/BNY/FB jumps all match some rational (why (d) needs volume)", () => {
    expect(matchesRationalFactor(15.9479)).toBe(true); // META ≈ 16:1
    expect(matchesRationalFactor(13.5971)).toBe(true); // BNY ≈ 27:2
    expect(matchesRationalFactor(0.2047)).toBe(true); // FB ≈ 1:5
  });

  it("rejects ratios beyond 5% log of any lattice point", () => {
    expect(matchesRationalFactor(45)).toBe(false); // between 40 and 50, >5% log from both
    expect(matchesRationalFactor(300)).toBe(false); // beyond the 1:100 lattice
  });
});

describe("explainingSplitFactor — price lattice + detector volume gates", () => {
  it("3:1 jump with split-consistent volume (×3, persistent) is explained", () => {
    const bars = [...series("2024-01-02", 10, 90, 1000), ...series("2024-03-01", 5, 30, 3000)];
    expect(explainingSplitFactor(bars, 10)?.factor).toBe(3);
    expect(findBoundaries(bars, new Set())).toHaveLength(0);
  });

  it("the same 3:1 jump with occupant-swap volume (flat) is NOT explained", () => {
    const bars = [...series("2024-01-02", 10, 90, 1000), ...series("2024-03-01", 5, 30, 1000)];
    expect(explainingSplitFactor(bars, 10)).toBeNull();
    expect(findBoundaries(bars, new Set())).toHaveLength(1);
  });

  it("FAR factor with direction-inconsistent persistent volume is rejected (META-like)", () => {
    // 15.9× jump ≈ 1:16 reverse split candidate, but volume explodes ~40×
    // (new occupant is a much bigger security) — direction gate rejects.
    const bars = [...series("2022-01-10", 10, 12.3, 200_000), ...series("2022-06-09", 5, 196, 8_000_000)];
    expect(explainingSplitFactor(bars, 10)).toBeNull();
  });

  it("insufficient volume history ⇒ price-lattice match alone decides (conservative)", () => {
    // boundary at the very start of the series: no pre-window, no volume
    const bars: SegBar[] = [bar("2024-01-02", 90), bar("2024-03-01", 30)];
    const noVol = bars.map(({ date, open, close }) => ({ date, open, close }));
    expect(explainingSplitFactor(noVol, 1)?.factor).toBe(3);
    expect(findBoundaries(noVol, new Set())).toHaveLength(0);
  });
});

describe("findBoundaries — the four-condition stitch rule", () => {
  it("flags a META-like reuse: long gap + huge jump + occupant-swap volume", () => {
    const bars = [...series("2022-01-17", 10, 12.3, 200_000), ...series("2022-06-09", 5, 196, 8_000_000)];
    const b = findBoundaries(bars, new Set());
    expect(b).toHaveLength(1);
    expect(b[0]!.prevDate).toBe("2022-01-26");
    expect(b[0]!.date).toBe("2022-06-09");
    expect(b[0]!.jump).toBeCloseTo(196 / 12.3, 5);
    expect(b[0]!.rejectedFactor?.factor).toBe(1 / 16); // split-factor orientation
  });

  it("does NOT flag a long trading gap without a price discontinuity", () => {
    // halted ~2 months, resumes at roughly the same level
    const bars = [...series("2023-01-02", 10, 50), ...series("2023-03-10", 5, 51)];
    expect(findBoundaries(bars, new Set())).toHaveLength(0);
  });

  it("does NOT flag a jump when a SplitEvent sits on the resume date", () => {
    const bars = [...series("2024-06-03", 10, 1200), ...series("2024-07-01", 5, 120)];
    expect(findBoundaries(bars, new Set(["2024-07-01"]))).toHaveLength(0);
  });

  it("does NOT flag a jump matching a rational factor (3:1) with split-consistent volume", () => {
    const bars = [...series("2024-01-02", 10, 90, 1000), ...series("2024-03-01", 5, 30.2, 3100)];
    expect(findBoundaries(bars, new Set())).toHaveLength(0);
  });

  it("does NOT flag a same-day big jump (documented limitation: gap required)", () => {
    const bars = [...series("2024-01-02", 5, 10), bar("2024-01-07", 200)];
    expect(findBoundaries(bars, new Set())).toHaveLength(0);
  });

  it("does NOT flag a gap + jump inside the [1/2.5, 2.5] band", () => {
    const bars = [...series("2024-01-02", 5, 10), ...series("2024-02-20", 3, 22)];
    expect(findBoundaries(bars, new Set())).toHaveLength(0);
  });
});

describe("assignSegments", () => {
  it("unstitched series = a single segment with empty evidence", () => {
    const bars = series("2024-01-02", 10, 100);
    const segs = assignSegments("AAPL", bars, []);
    expect(segs).toEqual([
      { segmentId: "AAPL#1", firstDate: "2024-01-02", lastDate: "2024-01-11", evidence: "" },
    ]);
  });

  it("stitched series = 2 segments, the second carries the stitch evidence", () => {
    const bars = [...series("2022-01-17", 10, 12.3, 200_000), ...series("2022-06-09", 5, 196, 8_000_000)];
    const boundaries = findBoundaries(bars, new Set());
    const segs = assignSegments("META", bars, boundaries);
    expect(segs.map((s) => s.segmentId)).toEqual(["META#1", "META#2"]);
    expect(segs[0]).toMatchObject({ firstDate: "2022-01-17", lastDate: "2022-01-26", evidence: "" });
    expect(segs[1]).toMatchObject({ firstDate: "2022-06-09", lastDate: "2022-06-13" });
    expect(segs[1]!.evidence).toContain("stitch 2022-01-26→2022-06-09");
    expect(segs[1]!.evidence).toContain("jump 15.9");
  });

  it("multi-stitch series gets 3 chronological segments", () => {
    const bars = [
      ...series("2022-01-03", 10, 10, 1000),
      ...series("2022-06-01", 10, 200, 5000), // stitch 1: gap + 20×, volume ×5 (inconsistent)
      ...series("2023-01-02", 10, 5, 900), // stitch 2: gap + 1/40×, volume ~flat (inconsistent)
    ];
    const boundaries = findBoundaries(bars, new Set());
    expect(boundaries).toHaveLength(2);
    const segs = assignSegments("X", bars, boundaries);
    expect(segs.map((s) => s.segmentId)).toEqual(["X#1", "X#2", "X#3"]);
    expect(segs[0]!.lastDate).toBe("2022-01-12");
    expect(segs[1]).toMatchObject({ firstDate: "2022-06-01", lastDate: "2022-06-10" });
    expect(segs[2]).toMatchObject({ firstDate: "2023-01-02", lastDate: "2023-01-11" });
    expect(segs[1]!.evidence).not.toBe("");
    expect(segs[2]!.evidence).not.toBe("");
  });
});
