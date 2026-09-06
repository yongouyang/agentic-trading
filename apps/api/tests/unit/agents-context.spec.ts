/**
 * DeepDiveContext assembly (src/agents/context.ts): metricsJson split
 * (caDegraded boolean separated from numeric metrics), bars summary,
 * fundamentals block (stocks only — ETFs skip), news cap plumbing, loud
 * degradation on F10/news failure. Prisma mocked per spec conventions; the
 * real-db persistence shape is covered by the CLI spec.
 */
import { describe, expect, it } from "vitest";
import { buildDeepDiveContext, splitMetrics, summarizeBars, type BuildContextDeps } from "../../src/agents/context.js";
import type { PrismaService } from "../../src/prisma.service.js";

const BARS = Array.from({ length: 80 }, (_, i) => ({
  date: `2026-06-${String((i % 28) + 1).padStart(2, "0")}`.replace(/^/, i < 28 ? "" : i < 56 ? "07-" : "08-"),
  close: 100 + i,
  volume: 1_000_000,
}));
// make dates strictly increasing for the summary math
BARS.forEach((b, i) => (b.date = new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10)));

function fakePrisma(over: { instrument?: any; bars?: any[] } = {}): PrismaService {
  const instrument = over.instrument === undefined ? { id: 1, symbol: "AAPL", name: "Apple Inc.", caDegraded: false } : over.instrument;
  const bars = over.bars === undefined ? BARS : over.bars;
  return {
    instrument: { findUnique: async () => instrument },
    bar: { findMany: async () => [...bars].reverse() }, // prisma returns desc
  } as unknown as PrismaService;
}

const okFundamentals = { fetchFundamentalsSnapshot: async () => ({ text: "FY2025 ..." }) };
const silentNews = { fetchImpl: (async () => ({ status: 200, text: async () => "<rss><channel></channel></rss>" }) as Response) as unknown as typeof fetch, sleep: async () => {}, spacingMs: 0, yahooSearch: null };

const ARGS = { symbol: "AAPL", name: "Apple Inc.", market: "US", kind: "stock" as const, asOf: "2026-09-05", rank: 1, score: 0.9, metrics: { close: 230.5, mom20: 0.02, caDegraded: false } };

describe("splitMetrics", () => {
  it("separates the caDegraded boolean from numeric metrics", () => {
    expect(splitMetrics(JSON.stringify({ close: 1.5, caDegraded: true, junk: "x" }))).toEqual({ metrics: { close: 1.5 }, caDegraded: true });
  });
  it("tolerates null/malformed input", () => {
    expect(splitMetrics(null)).toEqual({ metrics: {}, caDegraded: false });
    expect(splitMetrics("{nope")).toEqual({ metrics: {}, caDegraded: false });
  });
});

describe("summarizeBars", () => {
  it("computes last close, 20/60-session change, adv20", () => {
    const s = summarizeBars(BARS)!;
    expect(s.lastClose).toBe(179);
    expect(s.lastDate).toBe(BARS.at(-1)!.date);
    expect(s.change20d).toBeCloseTo(179 / 159 - 1, 10);
    expect(s.change60d).toBeCloseTo(179 / 119 - 1, 10);
    expect(s.adv20).toBeCloseTo((BARS.slice(-20).reduce((a, b) => a + b.close * b.volume, 0) / 20), 6);
  });
  it("short history degrades change fields to null", () => {
    const s = summarizeBars(BARS.slice(0, 5))!;
    expect(s.change20d).toBeNull();
    expect(s.change60d).toBeNull();
  });
  it("null closes are skipped; all-null → null", () => {
    expect(summarizeBars([{ date: "2026-09-01", close: null, volume: 1 }])).toBeNull();
  });
});

describe("buildDeepDiveContext", () => {
  it("assembles metrics + bars + fundamentals + news for a stock", async () => {
    const deps: BuildContextDeps = { prisma: fakePrisma(), fundamentals: okFundamentals, newsDeps: silentNews };
    const r = await buildDeepDiveContext(deps, ARGS);
    expect("failure" in r).toBe(false);
    if (!("failure" in r)) {
      expect(r.ctx.screenMetrics).toEqual({ close: 230.5, mom20: 0.02 });
      expect(r.ctx.fundamentalsSnapshot).toBe("FY2025 ...");
      expect(r.ctx.recentBars.lastClose).toBe(179);
      expect(r.ctx.caDegraded).toBe(false);
      expect(r.warnings).toEqual([]);
    }
  });

  it("ETF skips the fundamentals fetch entirely", async () => {
    let called = 0;
    const deps: BuildContextDeps = {
      prisma: fakePrisma(),
      fundamentals: { fetchFundamentalsSnapshot: async () => (called++, { text: null }) },
      newsDeps: silentNews,
    };
    const r = await buildDeepDiveContext(deps, { ...ARGS, symbol: "SPY", kind: "etf" });
    expect(called).toBe(0);
    if (!("failure" in r)) expect(r.ctx.fundamentalsSnapshot).toBeUndefined();
  });

  it("F10 failure degrades to a warning, not a failure", async () => {
    const deps: BuildContextDeps = {
      prisma: fakePrisma(),
      fundamentals: { fetchFundamentalsSnapshot: async () => ({ failure: "timeout" }) },
      newsDeps: silentNews,
    };
    const r = await buildDeepDiveContext(deps, ARGS);
    if (!("failure" in r)) {
      expect(r.ctx.fundamentalsSnapshot).toBeUndefined();
      expect(r.warnings.some((w) => w.includes("fundamentals snapshot failed (timeout)"))).toBe(true);
    }
  });

  it("instrument caDegraded=true propagates into the context", async () => {
    const deps: BuildContextDeps = { prisma: fakePrisma({ instrument: { id: 1, symbol: "AAPL", caDegraded: true } }), fundamentals: okFundamentals, newsDeps: silentNews };
    const r = await buildDeepDiveContext(deps, ARGS);
    if (!("failure" in r)) expect(r.ctx.caDegraded).toBe(true);
  });

  it("no Instrument row or no bars is a hard per-name failure", async () => {
    const deps: BuildContextDeps = { prisma: fakePrisma({ instrument: null }), fundamentals: okFundamentals, newsDeps: silentNews };
    expect(await buildDeepDiveContext(deps, ARGS)).toEqual({ failure: "no-instrument" });
    const deps2: BuildContextDeps = { prisma: fakePrisma({ bars: [] }), fundamentals: okFundamentals, newsDeps: silentNews };
    expect(await buildDeepDiveContext(deps2, ARGS)).toEqual({ failure: "no-bars" });
  });
});
