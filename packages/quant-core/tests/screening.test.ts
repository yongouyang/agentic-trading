import { describe, expect, it } from "vitest";
import { Bar } from "../src/types.js";
import { SCREEN_PARAMS, ScreenInput, runScreen } from "../src/screening.js";

/** Build bars from a close series; dates are sequential placeholders. */
const barsOf = (closes: number[], volume = 1_000_000): Bar[] =>
  closes.map((c, i) => ({
    date: `2024-${String(1 + Math.floor(i / 28)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`,
    open: c,
    high: c,
    low: c,
    close: c,
    volume,
  }));

const input = (symbol: string, closes: number[], o: Partial<ScreenInput> = {}): ScreenInput => ({
  symbol,
  market: "US",
  adjustedBars: barsOf(closes),
  rawBars: o.rawBars ?? barsOf(closes, 1_000_000),
  caDegraded: false,
  ...o,
});

/** Steady riser 100 → 100 + slope·(len−1): passes every eligibility rule and
 *  every signal condition (tiny vol, no drawdown, positive mom/sharpe). */
const riser = (len: number, slope: number): number[] => Array.from({ length: len }, (_, i) => 100 + slope * i);

describe("screening — eligibility rules (§4, each fails independently)", () => {
  const pass = input("PASS", riser(260, 0.15));

  it("passes a clean name, carrying indicator values and the caDegraded flag", () => {
    const { ranked, excluded } = runScreen([{ ...pass, caDegraded: true }]);
    expect(excluded).toEqual([]);
    expect(ranked).toHaveLength(1);
    const p = ranked[0]!;
    expect(p.rank).toBe(1);
    expect(p.symbol).toBe("PASS");
    expect(p.score).toBe(0); // single-name set → z = 0
    expect(p.caDegraded).toBe(true);
    expect(p.mom60).toBeGreaterThan(0);
    expect(p.sharpe252).toBeGreaterThan(0);
  });

  it("INSUFFICIENT_HISTORY: fewer than 252 adjusted bars", () => {
    const { excluded } = runScreen([input("SHORT", riser(251, 0.15))]);
    expect(excluded).toEqual([{ symbol: "SHORT", reason: "INSUFFICIENT_HISTORY" }]);
  });

  it("LOW_LIQUIDITY: adv20 below the market floor", () => {
    const closes = riser(260, 0.15);
    // adv20 = 130 × 100 = 13 000 << $20M
    const illiquid = input("ILLIQ", closes, { rawBars: barsOf(closes, 100) });
    const { excluded } = runScreen([illiquid]);
    expect(excluded).toEqual([{ symbol: "ILLIQ", reason: "LOW_LIQUIDITY" }]);
    // HK floor is HK$100M: 13 000 also fails there
    const hk = runScreen([{ ...illiquid, market: "HK" as const }]);
    expect(hk.excluded).toEqual([{ symbol: "ILLIQ", reason: "LOW_LIQUIDITY" }]);
  });

  it("HIGH_VOLATILITY: vol60 above 0.60", () => {
    // Alternating ±5% days: |ret| ≈ 4.9% daily → ann vol ≈ 78% > 60%
    const closes = Array.from({ length: 260 }, (_, i) => (i % 2 ? 105 : 100));
    const { excluded } = runScreen([input("VOL", closes)]);
    expect(excluded).toEqual([{ symbol: "VOL", reason: "HIGH_VOLATILITY" }]);
  });

  it("DEEP_DRAWDOWN: mdd252 below −0.50", () => {
    // 130 → 45 over 30 bars, then a long recovery to 100. In the 252-bar
    // window the peak is 100 (the end) and the trough 45 → mdd = −55%.
    const drop = Array.from({ length: 30 }, (_, i) => 130 * Math.pow(45 / 130, i / 29));
    const rec = Array.from({ length: 230 }, (_, i) => 45 + (55 * (i + 1)) / 230);
    const { excluded } = runScreen([input("DD", [...drop, ...rec])]);
    expect(excluded).toEqual([{ symbol: "DD", reason: "DEEP_DRAWDOWN" }]);
  });
});

describe("screening — signal conditions (§4, each fails independently)", () => {
  it("BEARISH_ALIGNMENT: close < SMA50 (steady decline)", () => {
    const closes = Array.from({ length: 260 }, (_, i) => 150 - (50 * i) / 259);
    const { excluded } = runScreen([input("BEAR", closes)]);
    expect(excluded).toEqual([{ symbol: "BEAR", reason: "BEARISH_ALIGNMENT" }]);
  });

  it("NEGATIVE_MOMENTUM: bullish alignment holds but mom60 ≤ 0", () => {
    // 252 closes: flat 100 (0–150), rise 100→141 (151–191, the mom60 base),
    // drop 141→117 (192–211), recover 117→127 (212–251).
    //   mom60 = 127/141 − 1 ≈ −9.9% ≤ 0
    //   sma50 ≈ 122.2 < close 127; sma200 ≈ 111.6 < sma50  (alignment holds)
    //   sharpe252 > 0 (net ln(127/100) > 0); vol60 ≈ 9%; mdd252 ≈ −17%
    const closes = [
      ...Array.from({ length: 151 }, () => 100),
      ...Array.from({ length: 41 }, (_, i) => 100 + (i + 1) * 1),
      ...Array.from({ length: 20 }, (_, i) => 141 - 1.2 * (i + 1)),
      ...Array.from({ length: 40 }, (_, i) => 117 + 0.25 * (i + 1)),
    ];
    expect(closes).toHaveLength(252);
    const { excluded } = runScreen([input("MOM", closes)]);
    expect(excluded).toEqual([{ symbol: "MOM", reason: "NEGATIVE_MOMENTUM" }]);
  });

  it("NON_POSITIVE_SHARPE: alignment and mom60 hold but sharpe252 ≤ 0", () => {
    // 252 closes: decline 100→80 (0–100), flat 80 (101–191), rise 80→88
    // (192–251).
    //   mom60 = 88/80 − 1 = +10% > 0; close 88 > sma50 ≈ 84.7 > sma200 ≈ 82.4
    //   net 252-bar return ln(88/100) < 0 → mean daily ret < 0 → sharpe < 0
    const closes = [
      ...Array.from({ length: 101 }, (_, i) => 100 - 0.2 * i),
      ...Array.from({ length: 91 }, () => 80),
      ...Array.from({ length: 60 }, (_, i) => 80 + (8 * (i + 1)) / 60),
    ];
    expect(closes).toHaveLength(252);
    const { excluded } = runScreen([input("SRP", closes)]);
    expect(excluded).toEqual([{ symbol: "SRP", reason: "NON_POSITIVE_SHARPE" }]);
  });
});

describe("screening — score, rank, truncation (§4)", () => {
  // Naive recomputations (independent of src/indicators.ts) for expected values.
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const pstdev = (xs: number[]) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
  const z = (xs: number[]) => {
    const m = mean(xs);
    const sd = pstdev(xs);
    return sd === 0 ? xs.map(() => 0) : xs.map((x) => (x - m) / sd);
  };
  const naiveSharpe = (closes: number[]): number => {
    const w = closes.slice(-252);
    const rets = w.slice(1).map((c, i) => c / w[i]! - 1);
    const m = mean(rets);
    const sd = Math.sqrt(rets.reduce((a, r) => a + (r - m) ** 2, 0) / (rets.length - 1));
    return (m * 252) / (sd * Math.sqrt(252));
  };

  it("z-score blend on a 3-name universe (hand-computed)", () => {
    // Linear risers, len 260: A slope 0.10, B slope 0.20, C slope 0.40.
    // Hand-computed moments (c_t = 100 + s·t, last index 259):
    //   mom60 = c_259/c_199 − 1:  A 125.9/119.9 − 1 = 0.0500417
    //                             B 151.8/139.8 − 1 = 0.0858369
    //                             C 203.6/179.6 − 1 = 0.1336303
    //   mom20 = c_259/c_239 − 1:  A 125.9/123.9 − 1 = 0.0161419
    //                             B 151.8/147.8 − 1 = 0.0270636
    //                             C 203.6/195.6 − 1 = 0.0408998
    //   sharpe252: recomputed naively below (identical return cadence,
    //   scale-dependent).
    const A = riser(260, 0.1);
    const B = riser(260, 0.2);
    const C = riser(260, 0.4);
    const { ranked, excluded } = runScreen([input("A", A), input("B", B), input("C", C)]);
    expect(excluded).toEqual([]);
    expect(ranked.map((p) => p.symbol)).toEqual(["C", "B", "A"]);

    const mom60 = [125.9 / 119.9 - 1, 151.8 / 139.8 - 1, 203.6 / 179.6 - 1];
    const mom20 = [125.9 / 123.9 - 1, 151.8 / 147.8 - 1, 203.6 / 195.6 - 1];
    const sh = [A, B, C].map(naiveSharpe);
    const w = SCREEN_PARAMS.weights;
    const expected = [0, 1, 2].map(
      (i) => w.mom60 * z(mom60)[i]! + w.mom20 * z(mom20)[i]! + w.sharpe252 * z(sh)[i]!,
    );
    // ranked is sorted C, B, A → reverse the A, B, C expectations
    expect(ranked[0]!.score).toBeCloseTo(expected[2]!, 10);
    expect(ranked[1]!.score).toBeCloseTo(expected[1]!, 10);
    expect(ranked[2]!.score).toBeCloseTo(expected[0]!, 10);
    // cross-check the module's own mom values against the hand arithmetic
    expect(ranked[2]!.mom60).toBeCloseTo(0.0500417, 6);
    expect(ranked[0]!.mom20).toBeCloseTo(0.0408998, 6);
  });

  it("ranks per market independently", () => {
    const us = input("US1", riser(260, 0.3));
    const hk: ScreenInput = { ...input("HK1", riser(260, 0.1)), market: "HK" };
    const { ranked } = runScreen([us, hk]);
    expect(ranked).toHaveLength(2);
    expect(ranked.every((p) => p.rank === 1)).toBe(true);
  });

  it("truncates to top 15 per market, keeping the highest scores", () => {
    // 20 US names with strictly increasing slopes → strictly increasing
    // mom/scores; the 5 flattest must be dropped.
    const inputs = Array.from({ length: 20 }, (_, i) => input(`N${i}`, riser(260, 0.1 + i * 0.005)));
    const { ranked, excluded } = runScreen(inputs);
    expect(excluded).toEqual([]);
    expect(ranked).toHaveLength(SCREEN_PARAMS.topN);
    expect(ranked.map((p) => p.rank)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(ranked.map((p) => p.symbol)).not.toContain("N0");
    expect(ranked[0]!.symbol).toBe("N19");
    for (let i = 1; i < ranked.length; i++) expect(ranked[i]!.score).toBeLessThan(ranked[i - 1]!.score);
  });

  it("breaks score ties by higher adv20", () => {
    const closes = riser(260, 0.15);
    const low = input("LOWADV", closes); // vol 1e6 → adv20 ≈ 1.3e8
    const high = input("HIGHADV", closes, { rawBars: barsOf(closes, 2_000_000) });
    const { ranked } = runScreen([low, high]);
    expect(ranked.map((p) => p.symbol)).toEqual(["HIGHADV", "LOWADV"]);
    expect(ranked[0]!.score).toBeCloseTo(ranked[1]!.score, 12);
    expect(ranked[0]!.adv20).toBeGreaterThan(ranked[1]!.adv20);
  });
});
