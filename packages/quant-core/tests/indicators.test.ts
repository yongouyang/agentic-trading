import { describe, expect, it } from "vitest";
import { Bar } from "../src/types.js";
import { advDollar, annualizedVol, maxDrawdown, momentum, sharpe, sma } from "../src/indicators.js";

const bar = (close: number, volume = 1_000): Bar => ({
  date: "2025-01-02",
  open: close,
  high: close,
  low: close,
  close,
  volume,
});

describe("indicators — known answers (hand-computed)", () => {
  it("sma of the last n values", () => {
    // (3 + 4 + 5) / 3 = 4
    expect(sma([1, 2, 3, 4, 5], 3)).toBe(4);
    // last 2 of [10, 20, 30] = (20 + 30) / 2 = 25
    expect(sma([10, 20, 30], 2)).toBe(25);
  });

  it("momentum = c_t / c_{t−n} − 1", () => {
    // 110 / 100 − 1 = 0.1
    expect(momentum([100, 110], 1)).toBeCloseTo(0.1, 12);
    // 110 / 100 − 1 = 0.1 (n skips the middle bar)
    expect(momentum([100, 105, 110], 2)).toBeCloseTo(0.1, 12);
  });

  it("annualizedVol = stdev(daily simple returns) × √252", () => {
    // closes [100, 102, 100] → returns [+0.02, −2/102 = −0.019607843]
    //   mean = 0.000196078; devs = ±0.019803922
    //   sample sd = 0.019803922 × √2 = 0.028007006
    //   ann = 0.028007006 × √252 = 0.444597
    expect(annualizedVol([100, 102, 100], 3)).toBeCloseTo(0.444597, 5);
  });

  it("sharpe = annualized return ÷ annualized vol, rf = 0", () => {
    // same series: mean daily ret 0.000196078 × 252 = 0.0494118
    //   sharpe = 0.0494118 / 0.444597 = 0.111138  (= √252 · mean/sd)
    expect(sharpe([100, 102, 100], 3)).toBeCloseTo(0.111138, 5);
  });

  it("advDollar = median of close × volume over the last n bars", () => {
    // dollar volumes [1, 2, 3, 4] → median (2 + 3) / 2 = 2.5
    const even = [1, 2, 3, 4].map((dv) => bar(dv, 1));
    expect(advDollar(even, 4)).toBe(2.5);
    // dollar volumes [1, 2, 9] → median 2 (not the mean 4)
    const odd = [1, 2, 9].map((dv) => bar(dv, 1));
    expect(advDollar(odd, 3)).toBe(2);
  });

  it("maxDrawdown = min of c_t / max(c_≤t) − 1 (≤ 0)", () => {
    // peak 120, trough 90 → 90/120 − 1 = −0.25 (later 110/120 − 1 = −0.0833)
    expect(maxDrawdown([100, 120, 90, 110], 4)).toBeCloseTo(-0.25, 12);
    // monotone rise → 0
    expect(maxDrawdown([100, 110, 120], 3)).toBe(0);
    // 105/110 − 1 = −0.0454545
    expect(maxDrawdown([100, 110, 105], 3)).toBeCloseTo(-0.0454545, 6);
  });
});

describe("indicators — null on insufficient history / degenerate input", () => {
  it("returns null, never NaN, never throws", () => {
    expect(sma([1, 2], 3)).toBeNull();
    expect(momentum([100], 1)).toBeNull();
    expect(momentum([0, 100], 1)).toBeNull(); // zero base
    expect(annualizedVol([100], 2)).toBeNull();
    expect(sharpe([100, 101], 5)).toBeNull();
    // zero variance (flat series) → sharpe degenerate → null
    expect(sharpe([100, 100, 100], 3)).toBeNull();
    expect(advDollar([bar(10)], 2)).toBeNull();
    // sparse null-volume bars are tolerated: 1 usable of n=2 (≥ ⌈n/2⌉) →
    // median over the usable bars
    expect(advDollar([bar(10), { ...bar(10), volume: null }], 2)).toBe(10_000);
    // exactly half usable: median of the usable pair [10000, 20000] → 15000
    expect(advDollar([bar(10), bar(20), { ...bar(10), volume: null }, { ...bar(10), volume: null }], 4)).toBe(15_000);
    // fewer than ⌈n/2⌉ usable bars → null
    expect(advDollar([bar(10), { ...bar(10), volume: null }, { ...bar(10), volume: null }, { ...bar(10), volume: null }], 4)).toBeNull();
    expect(maxDrawdown([100], 5)).toBeNull();
    expect(maxDrawdown([100, 0, 90], 3)).toBeNull(); // non-positive close
  });
});

describe("sma — property test (seeded LCG, no external deps)", () => {
  // Deterministic LCG (Numerical Recipes constants), output in (0,1).
  const lcg = (seed: number) => {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) % 2 ** 32;
      return s / 2 ** 32;
    };
  };

  it("matches a naive recomputation on a pseudo-random series", () => {
    const rand = lcg(42);
    // positive closes in [50, 150)
    const closes = Array.from({ length: 500 }, () => 50 + rand() * 100);
    for (const n of [20, 50, 200]) {
      const naive = closes.slice(-n).reduce((a, b) => a + b, 0) / n;
      expect(sma(closes, n)).toBeCloseTo(naive, 12);
    }
  });
});
