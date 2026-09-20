/**
 * Phase 7 P1 — fundamentals metrics + ingest, known-answer tests
 * (docs/phase-7-plan.md §2). No network; the store is faked.
 */
import { describe, expect, it } from "vitest";
import {
  addDays,
  periodTypeFromDuration,
  pointsKnownAt,
  extractEdgarPoints,
  extractEastmoneyHkPoints,
  HK_FILED_LAG_DAYS,
} from "../../src/fundamentals/metrics.js";
import {
  computeCoverage,
  ingestHkSymbol,
  ingestUsSymbol,
  type FundamentalsStore,
} from "../../src/fundamentals/ingest.js";

// ---------------------------------------------------------------------------
// period classification + date arithmetic
// ---------------------------------------------------------------------------

describe("periodTypeFromDuration", () => {
  it("classifies annual / semi / quarter / instant", () => {
    expect(periodTypeFromDuration("2024-01-01", "2024-12-31")).toBe("annual");
    expect(periodTypeFromDuration("2024-01-01", "2024-06-30")).toBe("semi");
    expect(periodTypeFromDuration("2024-04-01", "2024-06-30")).toBe("quarter");
    expect(periodTypeFromDuration(null, "2024-12-31")).toBe("instant");
  });

  it("returns null for durations in no bucket (5-week stub)", () => {
    expect(periodTypeFromDuration("2024-11-25", "2024-12-31")).toBe(null);
  });
});

describe("addDays", () => {
  it("crosses month and year boundaries in UTC", () => {
    expect(addDays("2024-12-31", 90)).toBe("2025-03-31");
    expect(addDays("2024-06-30", HK_FILED_LAG_DAYS)).toBe("2024-09-28");
  });
});

// ---------------------------------------------------------------------------
// EDGAR extraction
// ---------------------------------------------------------------------------

const edgarFixture = {
  facts: {
    "us-gaap": {
      Revenues: {
        units: {
          USD: [
            // original FY2023 10-K
            { start: "2023-01-01", end: "2023-12-31", val: 1000, accn: "a1", form: "10-K", filed: "2024-02-10" },
            // restated FY2023 value arriving inside the FY2024 10-K
            { start: "2023-01-01", end: "2023-12-31", val: 950, accn: "a2", form: "10-K", filed: "2025-02-10" },
            // an 8-K earnings release duplicating Q1 — must be excluded
            { start: "2024-01-01", end: "2024-03-31", val: 260, accn: "a3", form: "8-K", filed: "2024-04-20" },
            { start: "2024-01-01", end: "2024-03-31", val: 260, accn: "a4", form: "10-Q", filed: "2024-04-25" },
          ],
        },
      },
      Assets: {
        units: {
          USD: [
            // instant fact: no start
            { end: "2024-12-31", val: 5000, accn: "a5", form: "10-K", filed: "2025-02-10" },
          ],
        },
      },
    },
  },
};

describe("extractEdgarPoints", () => {
  it("keeps restatements, drops 8-Ks, classifies instants", () => {
    const pts = extractEdgarPoints("ACME", edgarFixture);
    const revenue = pts.filter((p) => p.metric === "revenue");
    expect(revenue).toHaveLength(3); // 2×FY2023 filings + 1×Q1 10-Q
    expect(revenue.every((p) => p.source === "sec-edgar" && p.market === "US")).toBe(true);
    const fy23 = revenue.filter((p) => p.periodEnd === "2023-12-31");
    expect(fy23.map((p) => p.value).sort((a, b) => a - b)).toEqual([950, 1000]);
    expect(fy23.every((p) => p.periodType === "annual" && !p.filedAtSynthetic)).toBe(true);
    const assets = pts.filter((p) => p.metric === "assets");
    expect(assets).toHaveLength(1);
    expect(assets[0].periodType).toBe("instant");
  });

  it("picks the fallback tag with the most points (registrants migrate tags)", () => {
    const q = (end: string, filed: string) => ({ start: "2023-10-01", end, val: 1, accn: "x", form: "10-Q", filed });
    const fixture = {
      facts: {
        "us-gaap": {
          // listed first but shallow — the AMD pattern measured 2026-09-20
          Revenues: { units: { USD: [q("2023-12-31", "2024-02-01"), q("2024-03-31", "2024-05-01")] } },
          SalesRevenueNet: {
            units: {
              USD: [0, 1, 2, 3, 4, 5].map((i) => ({
                start: `20${20 + i}-01-01`,
                end: `20${20 + i}-12-31`,
                val: 1,
                accn: "x",
                form: "10-K",
                filed: `20${21 + i}-02-01`,
              })),
            },
          },
        },
      },
    };
    const pts = extractEdgarPoints("AMD", fixture);
    expect(pts.filter((p) => p.metric === "revenue")).toHaveLength(6);
    expect(pts.every((p) => p.periodType === "annual")).toBe(true);
  });

  it("dedupes identical facts repeated across units (store unique key)", () => {
    const point = { start: "2023-01-01", end: "2023-12-31", val: 1000, accn: "a1", form: "10-K", filed: "2024-02-10" };
    const fixture = {
      facts: { "us-gaap": { Revenues: { units: { USD: [point], "USD-copy": [point] } } } },
    };
    const pts = extractEdgarPoints("DUP", fixture);
    expect(pts.filter((p) => p.metric === "revenue")).toHaveLength(1);
  });

  it("returns [] when us-gaap facts are absent", () => {
    expect(extractEdgarPoints("NONE", {})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// eastmoney HK extraction
// ---------------------------------------------------------------------------

const hkRow = {
  REPORT_DATE: "2024-12-31 00:00:00",
  DATE_TYPE_CODE: "001",
  CURRENCY: "HKD",
  OPERATE_INCOME: 600_000_000,
  GROSS_PROFIT: 250_000_000,
  HOLDER_PROFIT: 150_000_000,
  TOTAL_ASSETS: 900_000_000,
  TOTAL_PARENT_EQUITY: 400_000_000,
  TOTAL_LIABILITIES: 500_000_000,
  BASIC_EPS: 1.5,
  ISSUED_COMMON_SHARES: 100_000_000,
  NETCASH_OPERATE: 180_000_000,
};

describe("extractEastmoneyHkPoints", () => {
  it("maps all nine metrics with the synthetic +90d anchor", () => {
    const pts = extractEastmoneyHkPoints("0700.HK", hkRow);
    expect(pts).toHaveLength(9);
    expect(pts.every((p) => p.filedAt === "2025-03-31" && p.filedAtSynthetic)).toBe(true);
    expect(pts.every((p) => p.source === "eastmoney-f10" && p.market === "HK" && p.periodType === "annual")).toBe(true);
    expect(pts.find((p) => p.metric === "revenue")?.value).toBe(600_000_000);
    expect(pts.find((p) => p.metric === "sharesOutstanding")?.currency).toBe("shares");
  });

  it("classifies semi-annual rows and skips unknown date-type codes", () => {
    const semi = extractEastmoneyHkPoints("0700.HK", { ...hkRow, REPORT_DATE: "2024-06-30 00:00:00", DATE_TYPE_CODE: "002" });
    expect(semi[0]?.periodType).toBe("semi");
    expect(extractEastmoneyHkPoints("0700.HK", { ...hkRow, DATE_TYPE_CODE: "999" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PIT read
// ---------------------------------------------------------------------------

describe("pointsKnownAt", () => {
  const pts = [
    { metric: "revenue", periodEnd: "2023-12-31", periodType: "annual", filedAt: "2024-02-10", value: 1000 },
    { metric: "revenue", periodEnd: "2023-12-31", periodType: "annual", filedAt: "2025-02-10", value: 950 },
    { metric: "revenue", periodEnd: "2024-03-31", periodType: "quarter", filedAt: "2024-04-25", value: 260 },
  ];

  it("sees the original before the restatement, the restatement after", () => {
    const at2024 = pointsKnownAt(pts, "2024-06-01");
    expect(at2024.find((p) => p.periodEnd === "2023-12-31")?.value).toBe(1000);
    const at2025 = pointsKnownAt(pts, "2025-06-01");
    expect(at2025.find((p) => p.periodEnd === "2023-12-31")?.value).toBe(950);
  });

  it("treats asOf as inclusive of same-day filings", () => {
    const atFiled = pointsKnownAt(pts, "2024-02-10");
    expect(atFiled.some((p) => p.periodEnd === "2023-12-31")).toBe(true);
    expect(pointsKnownAt(pts, "2024-02-09")).toHaveLength(0);
  });

  it("hides periods not yet filed at T", () => {
    const at = pointsKnownAt(pts, "2024-04-24");
    expect(at.some((p) => p.periodEnd === "2024-03-31")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ingest (fake fetch + fake store) and coverage
// ---------------------------------------------------------------------------

function fakeStore(): FundamentalsStore & { rows: any[] } {
  const rows: any[] = [];
  return {
    rows,
    fundamentalPoint: {
      async deleteMany(args: { where: { symbol: string; source: string } }) {
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].symbol === args.where.symbol && rows[i].source === args.where.source) rows.splice(i, 1);
        }
      },
      async createMany(args: { data: any[] }) {
        rows.push(...args.data);
      },
    },
  };
}

describe("ingestUsSymbol", () => {
  it("fails as value on missing CIK and writes points on success", async () => {
    const store = fakeStore();
    const cikMap = new Map([["ACME", "0000000001"]]);
    const fetchImpl = (async () => new Response(JSON.stringify(edgarFixture), { status: 200 })) as typeof fetch;
    const bad = await ingestUsSymbol(store, "NOPE", cikMap, { fetchImpl });
    expect(bad).toEqual({ symbol: "NOPE", points: 0, failure: "no-cik" });
    const good = await ingestUsSymbol(store, "ACME", cikMap, { fetchImpl });
    expect(good.failure).toBe(null);
    expect(good.points).toBe(4); // 3 revenue + 1 assets
    expect(store.rows).toHaveLength(4);
    // re-ingest replaces, never accumulates
    await ingestUsSymbol(store, "ACME", cikMap, { fetchImpl });
    expect(store.rows).toHaveLength(4);
  });
});

describe("ingestHkSymbol", () => {
  it("treats result:null as legitimate absence (ETFs)", async () => {
    const store = fakeStore();
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ result: null }), { status: 200 })) as typeof fetch;
    const r = await ingestHkSymbol(store, "2800.HK", { fetchImpl });
    expect(r).toEqual({ symbol: "2800.HK", points: 0, failure: null });
  });

  it("writes one point per metric per row", async () => {
    const store = fakeStore();
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ result: { data: [hkRow] } }), { status: 200 })) as typeof fetch;
    const r = await ingestHkSymbol(store, "0700.HK", { fetchImpl });
    expect(r.points).toBe(9);
    expect(store.rows).toHaveLength(9);
  });
});

describe("computeCoverage", () => {
  it("applies the US ≥8 / HK ≥4 thresholds on distinct revenue periods", () => {
    const mk = (symbol: string, n: number, type: string) =>
      Array.from({ length: n }, (_, i) => ({
        symbol,
        metric: "revenue",
        periodEnd: `20${20 + i}-12-31`,
        periodType: type,
      }));
    const us = computeCoverage([...mk("A", 8, "quarter"), ...mk("B", 7, "quarter")], ["A", "B"], "US");
    expect(us).toMatchObject({ names: 2, meeting: 1, below: ["B"] });
    const hk = computeCoverage([...mk("C", 4, "semi")], ["C"], "HK");
    expect(hk.meeting).toBe(1);
    // restatements of the same periodEnd do not inflate the count
    const dup = computeCoverage(
      [
        { symbol: "D", metric: "revenue", periodEnd: "2023-12-31", periodType: "annual" },
        { symbol: "D", metric: "revenue", periodEnd: "2023-12-31", periodType: "annual" },
      ],
      ["D"],
      "US",
    );
    expect(dup.meeting).toBe(0);
  });
});
