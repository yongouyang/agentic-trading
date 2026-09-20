/**
 * Phase 7 P3 (docs/phase-7-plan.md §3–§4) — known-answer tests for the
 * quality composite, earnings yield, z-scores, and the two trend gates.
 */
import { describe, expect, it } from "vitest";
import {
  combineScore,
  compositeComponents,
  earningsYield,
  gateG1,
  gateG2,
  latestStock,
  qualityCompositeZ,
  trailingTwelveMonths,
  winsorizedZScores,
  type PitPoint,
} from "../src/fundamentals-composite.js";

const pt = (metric: string, periodEnd: string, periodType: PitPoint["periodType"], value: number): PitPoint => ({
  metric,
  periodEnd,
  periodType,
  filedAt: periodEnd, // tests control visibility via periodEnd; filedAt unused here
  value,
});

// ---------------------------------------------------------------------------
// trailingTwelveMonths
// ---------------------------------------------------------------------------

describe("trailingTwelveMonths", () => {
  it("sums the last 4 quarters when they span a year", () => {
    const pts = [
      pt("revenue", "2023-12-31", "quarter", 100),
      pt("revenue", "2024-03-31", "quarter", 110),
      pt("revenue", "2024-06-30", "quarter", 120),
      pt("revenue", "2024-09-30", "quarter", 130),
    ];
    expect(trailingTwelveMonths(pts, "revenue", "2024-12-31")).toBe(460);
  });

  it("falls back to 2 semis, then 1 annual", () => {
    const semis = [pt("revenue", "2024-06-30", "semi", 200), pt("revenue", "2024-12-31", "semi", 240)];
    expect(trailingTwelveMonths(semis, "revenue", "2025-03-31")).toBe(440);
    const annual = [pt("revenue", "2024-12-31", "annual", 400)];
    expect(trailingTwelveMonths(annual, "revenue", "2025-06-30")).toBe(400);
  });

  it("rejects quarter runs with gaps (do not span a year)", () => {
    const pts = [
      pt("revenue", "2022-12-31", "quarter", 100),
      pt("revenue", "2024-03-31", "quarter", 110),
      pt("revenue", "2024-06-30", "quarter", 120),
      pt("revenue", "2024-09-30", "quarter", 130),
    ];
    expect(trailingTwelveMonths(pts, "revenue", "2024-12-31")).toBe(null);
  });

  it("ignores periods ending after asOf and ignores instant points", () => {
    const pts = [
      pt("revenue", "2024-12-31", "annual", 400),
      pt("revenue", "2025-12-31", "annual", 999),
      pt("revenue", "2024-12-31", "instant", 555),
    ];
    expect(trailingTwelveMonths(pts, "revenue", "2025-06-30")).toBe(400);
  });
});

describe("latestStock", () => {
  it("returns the latest value at or before asOf, regardless of period type", () => {
    const pts = [pt("assets", "2023-12-31", "instant", 900), pt("assets", "2024-12-31", "instant", 1000)];
    expect(latestStock(pts, "assets", "2024-06-30")).toBe(900);
    expect(latestStock(pts, "assets", "2025-01-01")).toBe(1000);
  });

  it("accepts HK-style stocks typed by their report period (annual/semi)", () => {
    const pts = [pt("sharesOutstanding", "2024-12-31", "annual", 9_000_000)];
    expect(latestStock(pts, "sharesOutstanding", "2025-06-30")).toBe(9_000_000);
  });
});

// ---------------------------------------------------------------------------
// composite components
// ---------------------------------------------------------------------------

describe("compositeComponents", () => {
  it("computes all five components from a full synthetic history", () => {
    const pts: PitPoint[] = [];
    // 4 years of quarterly revenue + grossProfit (for TTM, margins, CAGR)
    for (let y = 2021; y <= 2024; y++) {
      for (const [m, d] of [["03-31", "q"], ["06-30", "q"], ["09-30", "q"], ["12-31", "q"]] as const) {
        pts.push(pt("revenue", `${y}-${m}`, "quarter", 100 * (y - 2020)));
        pts.push(pt("grossProfit", `${y}-${m}`, "quarter", 50 * (y - 2020)));
      }
      pts.push(pt("netIncome", `${y}-12-31`, "annual", 30 * (y - 2020)));
      pts.push(pt("assets", `${y}-12-31`, "instant", 1000));
      pts.push(pt("equity", `${y}-12-31`, "instant", 500));
      pts.push(pt("liabilities", `${y}-12-31`, "instant", 500));
    }
    const c = compositeComponents(pts, "2025-03-31");
    // TTM revenue 2024 = 4 × 400; assets 1000 → GP TTM 4×200=800 / 1000
    expect(c.grossProfitability).toBeCloseTo(800 / 1000, 9);
    expect(c.roe).toBeCloseTo(120 / 500, 9); // annual 2024 NI = 30×4
    expect(c.safety).toBeCloseTo(-0.5, 9);
    // revenue TTM now (1600) vs TTM 3y ago (asOf 2022-03-31: quarters
    // 2021Q2–2022Q1 = 100+100+100+200 = 500)
    expect(c.growth).toBeCloseTo(Math.pow(1600 / 500, 1 / 3) - 1, 9);
    // margins are all exactly 0.5 → std 0 → stability 0
    expect(c.marginStability).toBeCloseTo(0, 12);
  });

  it("returns nulls when history is too thin", () => {
    const c = compositeComponents([pt("revenue", "2024-12-31", "annual", 100)], "2025-03-31");
    expect(c.grossProfitability).toBe(null);
    expect(c.roe).toBe(null);
    expect(c.marginStability).toBe(null);
    expect(c.safety).toBe(null);
    expect(c.growth).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// earnings yield + weights
// ---------------------------------------------------------------------------

describe("earningsYield", () => {
  it("is TTM net income over market cap", () => {
    const pts = [pt("netIncome", "2024-12-31", "annual", 50), pt("sharesOutstanding", "2024-12-31", "instant", 100)];
    expect(earningsYield(pts, "2025-03-31", 20)).toBeCloseTo(50 / 2000, 12);
    expect(earningsYield(pts, "2025-03-31", -5)).toBe(null);
  });
});

describe("combineScore", () => {
  it("applies the declared market weights (US 70/30, HK 60/40)", () => {
    expect(combineScore("US", 1, 0)).toBeCloseTo(0.7, 12);
    expect(combineScore("HK", 1, 0)).toBeCloseTo(0.6, 12);
    expect(combineScore("HK", 0, 1)).toBeCloseTo(0.4, 12);
  });
});

// ---------------------------------------------------------------------------
// z-scores + composite aggregation
// ---------------------------------------------------------------------------

describe("winsorizedZScores", () => {
  it("standardizes with symmetric z for a symmetric input", () => {
    const z = winsorizedZScores([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(z.every((v): v is number => v != null)).toBe(true);
    const mean = (z as number[]).reduce((s, v) => s + v, 0) / 20;
    expect(mean).toBeCloseTo(0, 9);
  });

  it("clips extreme outliers at the p5/p95 band", () => {
    const values = [...Array(19).fill(1), 1000];
    const z = winsorizedZScores(values) as number[];
    // the outlier is clipped to the p95 raw value (=1) → all z equal → 0
    expect(Math.max(...z)).toBeCloseTo(0, 9);
  });

  it("passes nulls through and zeros a constant cross-section", () => {
    expect(winsorizedZScores([2, null, 2, 2, 2])).toEqual([0, null, 0, 0, 0]);
  });
});

describe("qualityCompositeZ", () => {
  const base = {
    grossProfitability: 0.4,
    roe: 0.2,
    marginStability: -0.02,
    safety: -0.4,
    growth: 0.1,
  };
  it("equal-weights the available component z-scores", () => {
    const z = qualityCompositeZ([base, { ...base, roe: 0.3 }, { ...base, growth: -0.1 }]);
    expect(z.every((v) => v != null)).toBe(true);
    // name 2 beats name 1 only on ROE → z2 > z1
    expect(z[1]!).toBeGreaterThan(z[0]!);
  });

  it("returns null below the ≥3-components minimum", () => {
    const sparse = { grossProfitability: 0.4, roe: 0.2, marginStability: null, safety: null, growth: null };
    // a third full name keeps every component column at ≥2 present values, so
    // the sparse name's null — not column collapse — is what is tested
    const z = qualityCompositeZ([base, sparse, { ...base, roe: 0.25 }]);
    expect(z[1]).toBe(null);
    expect(z[0]).not.toBe(null);
    expect(z[2]).not.toBe(null);
  });
});

// ---------------------------------------------------------------------------
// gates
// ---------------------------------------------------------------------------

describe("gateG1 (close vs 200-day MA, evaluated weekly)", () => {
  it("passes when the last close is at/above the 200d MA, fails below", () => {
    const flat = Array(200).fill(100);
    expect(gateG1(flat).pass).toBe(true);
    const broken = [...Array(199).fill(100), 90];
    expect(gateG1(broken).pass).toBe(false);
  });

  it("fails closed with fewer than 200 sessions", () => {
    expect(gateG1(Array(199).fill(100))).toEqual({ gate: "G1", pass: false, detail: null });
  });
});

describe("gateG2 (12-month return > 0)", () => {
  it("passes on a positive 252-session return, fails otherwise", () => {
    const up = [...Array(252).fill(100), 110];
    expect(gateG2(up).pass).toBe(true);
    expect(gateG2(up).detail).toBeCloseTo(0.1, 9);
    const down = [...Array(252).fill(100), 90];
    expect(gateG2(down).pass).toBe(false);
  });

  it("fails closed with insufficient history", () => {
    expect(gateG2(Array(252).fill(100)).pass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// look-ahead invariant: extending history beyond T never changes the value at T
// ---------------------------------------------------------------------------

it("PIT invariant: points after asOf do not change any component", () => {
  const pts: PitPoint[] = [];
  for (let y = 2021; y <= 2025; y++) {
    pts.push(pt("revenue", `${y}-12-31`, "annual", 100 * (y - 2020)));
    pts.push(pt("assets", `${y}-12-31`, "instant", 1000));
    pts.push(pt("equity", `${y}-12-31`, "instant", 500));
    pts.push(pt("liabilities", `${y}-12-31`, "instant", 500));
    pts.push(pt("netIncome", `${y}-12-31`, "annual", 30 * (y - 2020)));
    pts.push(pt("grossProfit", `${y}-12-31`, "annual", 50 * (y - 2020)));
  }
  const asOf = "2023-06-30";
  const before = compositeComponents(pts, asOf);
  const after = compositeComponents(pts.filter((p) => p.periodEnd <= asOf), asOf);
  expect(before).toEqual(after);
});
