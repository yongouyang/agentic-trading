/**
 * ReportsService tests (phase-3-plan §3a): daily join shape (verdict overlay,
 * screened-but-not-deep-dived nulls), transcript ordering from
 * decisionHashesJson, 404s, price-history adjustment matching
 * deriveAdjustedBars exactly, CA marker extraction (incl. IN_SPECIE),
 * param validation. Seeded Prisma rows on a throwaway SQLite db (suite idiom).
 */
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveAdjustedBars } from "@agentic-trading/quant-core";
import { createTestDatabase, destroyTestDatabase, type TestDatabase } from "../helpers/test-db.js";
import { PrismaService } from "../../src/prisma.service.js";
import {
  parseDaysParam,
  parseRunsLimitParam,
  parseRunIdParam,
  ReportsService,
  SCREEN_RULES_CAVEAT,
  summarizeMetrics,
  visibleRows,
} from "../../src/reports/reports.service.js";

const VERDICT_AAPL = {
  instrumentId: "AAPL",
  rating: "buy",
  conviction: 0.6,
  abstain: false,
  thesis: "Resilient services mix.",
  keyRisks: ["China demand"],
  invalidationConditions: ["Services growth < 5%"],
  asOf: "2026-09-05",
  promptVersion: "v1",
};

describe("ReportsService", () => {
  let db: TestDatabase;
  let prisma: PrismaService;
  let service: ReportsService;
  let screenRunId: number;
  let deepDiveRunId: number;
  let seededIndCloses: number[];
  let seededIndDates: string[];
  const hashes = ["h-news", "h-fund", "h-bull1", "h-bear1", "h-verdict"];

  beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
    prisma = new PrismaService();
    await prisma.$connect();
    service = new ReportsService(prisma);

    // Screen lane: 3 ranked names; the deep-dive only covers top 2.
    const screenRun = await prisma.screenRun.create({
      data: {
        market: "US",
        universeSize: 3,
        ok: 3,
        genuinelyAbsent: 0,
        fetchFailed: 1,
        degraded: true,
        warningsJson: JSON.stringify(["XYZ: fetch failed (http-429)"]),
      },
    });
    screenRunId = screenRun.id;
    await prisma.screenResult.createMany({
      data: [
        { runId: screenRun.id, symbol: "AAPL", rank: 1, score: 0.9, metricsJson: JSON.stringify({ close: 230.5, sma50: 220.1, mom20: 0.04, caDegraded: false }) },
        { runId: screenRun.id, symbol: "MSFT", rank: 2, score: 0.8, metricsJson: JSON.stringify({ close: 500.1 }) },
        { runId: screenRun.id, symbol: "SPY", rank: 3, score: 0.7, metricsJson: JSON.stringify({ close: 650.2 }) },
      ],
    });

    const ddRun = await prisma.deepDiveRun.create({
      data: {
        market: "US",
        screenRunId: screenRun.id,
        topN: 2,
        llmCalls: 12,
        cacheHits: 2,
        failed: 1,
        warningsJson: JSON.stringify(["MSFT: fundamentals fetch degraded"]),
      },
    });
    deepDiveRunId = ddRun.id;
    await prisma.deepDiveReport.createMany({
      data: [
        {
          runId: ddRun.id,
          symbol: "AAPL",
          status: "ok",
          verdictJson: JSON.stringify(VERDICT_AAPL),
          decisionHashesJson: JSON.stringify(hashes),
        },
        { runId: ddRun.id, symbol: "MSFT", status: "failed:llm-timeout", verdictJson: null, decisionHashesJson: null },
      ],
    });

    // AgentDecision rows created out of pipeline order — ordering must come
    // from decisionHashesJson, not row id.
    const agents = ["verdict", "bear", "bull", "fundamentals-analyst", "news-analyst"];
    for (let i = 0; i < hashes.length; i++) {
      await prisma.agentDecision.create({
        data: {
          hash: hashes[hashes.length - 1 - i]!,
          agent: agents[i]!,
          model: "k3-256k",
          promptVersion: "v1",
          systemPrompt: `sys-${i}`,
          userPrompt: `usr-${i}`,
          responseText: `resp-${i}`,
          usageJson: JSON.stringify({ promptTokens: 10 + i, completionTokens: 5 + i }),
        },
      });
    }

    // Instrument with bars + corporate actions for price-history.
    const inst = await prisma.instrument.create({
      data: { symbol: "0005.HK", market: "HK", currency: "HKD", name: "HSBC" },
    });
    await prisma.bar.createMany({
      data: [
        { instrumentId: inst.id, date: "2026-09-01", open: 100, high: 102, low: 99, close: 100, volume: 1000 },
        { instrumentId: inst.id, date: "2026-09-02", open: 101, high: 103, low: 100, close: 101, volume: 1100 },
        { instrumentId: inst.id, date: "2026-09-03", open: 99, high: 100, low: 97, close: 98, volume: 900 },
        { instrumentId: inst.id, date: "2026-09-04", open: 98.5, high: 99.5, low: 97.5, close: 99, volume: 950 },
      ],
    });
    await prisma.corporateAction.createMany({
      data: [
        { instrumentId: inst.id, date: "2026-09-03", type: "DIVIDEND", amount: 2, currency: "HKD" },
        { instrumentId: inst.id, date: "2026-09-04", type: "IN_SPECIE", amount: null, currency: "HKD", detail: "1:10 spin-off" },
      ],
    });
    await prisma.instrument.create({ data: { symbol: "NOBARS", market: "US", currency: "USD" } });

    // Indicator fixture (phase-3c): 260 bars, no corporate actions (adjusted
    // close == close). Rises 100→229 over the first 130 bars, then falls to
    // 101 — a single clean peak so drawdown/vol are hand-checkable.
    const indCloses: number[] = [];
    for (let i = 0; i < 260; i++) indCloses.push(i < 130 ? 100 + i : 360 - i);
    const indDates: string[] = [];
    for (let i = 0; i < 260; i++) {
      const d = new Date(Date.UTC(2025, 8, 1) + i * 86_400_000);
      indDates.push(d.toISOString().slice(0, 10));
    }
    const ind = await prisma.instrument.create({ data: { symbol: "INDX", market: "US", currency: "USD" } });
    await prisma.bar.createMany({
      data: indDates.map((date, i) => ({ instrumentId: ind.id, date, open: indCloses[i]!, high: indCloses[i]!, low: indCloses[i]!, close: indCloses[i]!, volume: 1000 })),
    });
    seededIndCloses = indCloses;
    seededIndDates = indDates;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    destroyTestDatabase(db);
    delete process.env.DATABASE_URL;
  });

  describe("daily", () => {
    it("joins the latest deep-dive run to its screen run with integrity header and ranked rows", async () => {
      const out = await service.daily("US");
      expect(out.market).toBe("US");
      expect(out.run.id).toBe(deepDiveRunId);
      expect(out.run.screenRunId).toBe(screenRunId);
      expect(out.run.topN).toBe(2);
      expect(out.run.warnings).toEqual(["MSFT: fundamentals fetch degraded"]);
      expect(out.integrity).toEqual({
        universeSize: 3,
        ok: 3,
        genuinelyAbsent: 0,
        fetchFailed: 1,
        degraded: true,
        warnings: ["XYZ: fetch failed (http-429)"],
        // W3b: newest US bar in the store — the INDX fixture's last date.
        dataThrough: seededIndDates[seededIndDates.length - 1],
        // The list's own session, distinct from the store cutoff in dataThrough.
        // The fixture's ScreenRun predates the column, so it is null.
        screenedSession: null,
        // Phase 4b item 6: rule provenance, alongside the data provenance.
        caveat: SCREEN_RULES_CAVEAT,
      });
      // The caveat must not quantify the floors: they are window-specific and
      // would silently rot here after the next backtest.
      expect(out.integrity.caveat).toMatch(/unvalidated hypothesis/);
      expect(out.integrity.caveat).not.toMatch(/0\.0\d\d/);
      expect(out.rows.map((r) => [r.rank, r.symbol])).toEqual([
        [1, "AAPL"],
        [2, "MSFT"],
        [3, "SPY"],
      ]);
    });

    it("overlays verdict (rating, conviction, abstain, thesis) for deep-dived names; failed names get null verdict + status", async () => {
      const out = await service.daily("US");
      const aapl = out.rows[0]!;
      expect(aapl.verdict).toEqual({ rating: "buy", conviction: 0.6, abstain: false, thesis: "Resilient services mix." });
      expect(aapl.metrics).toMatchObject({ close: 230.5, sma50: 220.1, mom20: 0.04, caDegraded: false });
      expect(aapl.deepDiveStatus).toBe("ok");
      const msft = out.rows[1]!;
      expect(msft.verdict).toBeNull();
      expect(msft.deepDiveStatus).toBe("failed:llm-timeout");
    });

    it("screened-but-not-deep-dived names (rank > topN) appear with null verdict and null status", async () => {
      const out = await service.daily("US");
      const spy = out.rows[2]!;
      expect(spy.symbol).toBe("SPY");
      expect(spy.verdict).toBeNull();
      expect(spy.deepDiveStatus).toBeNull();
      expect(spy.metrics).toMatchObject({ close: 650.2 });
    });

    it("404s when the market has no deep-dive run", async () => {
      await expect(service.daily("HK")).rejects.toBeInstanceOf(NotFoundException);
    });

    it("400s on an invalid market", async () => {
      await expect(service.daily("CN")).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.daily("")).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("deepDive transcript", () => {
    it("resolves transcript in decisionHashesJson (pipeline) order, not insertion order", async () => {
      const out = await service.deepDive(deepDiveRunId, "AAPL");
      expect(out.run).toMatchObject({ id: deepDiveRunId, market: "US", screenRunId, topN: 2 });
      expect(out.status).toBe("ok");
      expect(out.transcript.map((t) => t.hash)).toEqual(hashes);
      expect(out.transcript[0]).toMatchObject({ agent: "news-analyst", model: "k3-256k", promptVersion: "v1", usage: { promptTokens: 14, completionTokens: 9 } });
      expect(out.transcript[0]!.systemPrompt).toBe("sys-4"); // seeded reversed
    });

    it("returns the full parsed verdict JSON", async () => {
      const out = await service.deepDive(deepDiveRunId, "AAPL");
      expect(out.verdict).toEqual(VERDICT_AAPL);
    });

    it("failed name: verdict null, transcript empty, status preserved", async () => {
      const out = await service.deepDive(deepDiveRunId, "MSFT");
      expect(out.status).toBe("failed:llm-timeout");
      expect(out.verdict).toBeNull();
      expect(out.transcript).toEqual([]);
    });

    it("404s on unknown (runId, symbol) pairs", async () => {
      await expect(service.deepDive(deepDiveRunId, "SPY")).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.deepDive(9999, "AAPL")).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("priceHistory", () => {
    it("returns adjusted closes matching deriveAdjustedBars exactly", async () => {
      const out = await service.priceHistory("0005.HK", 250);
      const bars = [
        { date: "2026-09-01", open: 100, high: 102, low: 99, close: 100, volume: 1000 },
        { date: "2026-09-02", open: 101, high: 103, low: 100, close: 101, volume: 1100 },
        { date: "2026-09-03", open: 99, high: 100, low: 97, close: 98, volume: 900 },
        { date: "2026-09-04", open: 98.5, high: 99.5, low: 97.5, close: 99, volume: 950 },
      ];
      const expected = deriveAdjustedBars(bars, [
        { date: "2026-09-03", type: "DIVIDEND", amount: 2, currency: "HKD" },
        { date: "2026-09-04", type: "DIVIDEND" as never, amount: null as never, currency: "HKD" }, // IN_SPECIE filtered by the type check
      ]);
      expect(out.bars.map((b) => b.date)).toEqual(expected.map((b) => b.date));
      for (let i = 0; i < expected.length; i++) {
        expect(out.bars[i]!.close).toBe(expected[i]!.adjustedClose);
        expect(out.bars[i]!.volume).toBe(expected[i]!.volume);
      }
      // Sanity: dividend on 09-03 back-adjusts 09-01/02 (factor 1 − 2/101).
      expect(out.bars[0]!.close).toBeCloseTo(100 * (1 - 2 / 101), 10);
      expect(out.bars[2]!.close).toBe(98); // ex-date and later: factor 1
    });

    it("markers include ALL corporate actions (DIVIDEND and IN_SPECIE)", async () => {
      const out = await service.priceHistory("0005.HK", 250);
      expect(out.markers).toEqual([
        { date: "2026-09-03", type: "DIVIDEND", amount: 2, currency: "HKD" },
        { date: "2026-09-04", type: "IN_SPECIE", amount: null, currency: "HKD" },
      ]);
    });

    it("slices to the most recent `days` bars (adjustment computed over the full series first)", async () => {
      const out = await service.priceHistory("0005.HK", 2);
      expect(out.days).toBe(2);
      expect(out.bars.map((b) => b.date)).toEqual(["2026-09-03", "2026-09-04"]);
      expect(out.bars[0]!.close).toBe(98);
    });

    it("404s on unknown symbols and instruments with no bars", async () => {
      await expect(service.priceHistory("NOSUCH", 250)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.priceHistory("NOBARS", 250)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("priceHistory indicators (phase 3c)", () => {
    // Independent hand-computations of the quant-core definitions over the
    // seeded series (adjusted == raw: no corporate actions on INDX).
    const handSma = (upto: number, n: number) => {
      let sum = 0;
      for (let i = upto - n + 1; i <= upto; i++) sum += seededIndCloses[i]!;
      return sum / n;
    };
    const handMom = (upto: number, n: number) => seededIndCloses[upto]! / seededIndCloses[upto - n]! - 1;
    const handMdd = (upto: number, n: number) => {
      let peak = seededIndCloses[upto - n + 1]!;
      let mdd = 0;
      for (let i = upto - n + 1; i <= upto; i++) {
        const c = seededIndCloses[i]!;
        if (c > peak) peak = c;
        if (c / peak - 1 < mdd) mdd = c / peak - 1;
      }
      return mdd;
    };
    const handVol = (upto: number, n: number) => {
      const rets: number[] = [];
      for (let i = upto - n + 2; i <= upto; i++) rets.push(seededIndCloses[i]! / seededIndCloses[i - 1]! - 1);
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const v = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
      return Math.sqrt(v) * Math.sqrt(252);
    };

    it("rolls sma50/sma200/mom20/mom60/mdd252/vol60 over the full adjusted series", async () => {
      const out = await service.priceHistory("INDX", 260);
      const last = 259;
      expect(out.indicators.sma50.at(-1)).toEqual({ date: seededIndDates[last]!, value: handSma(last, 50) });
      expect(out.indicators.sma200.at(-1)!.value).toBeCloseTo(handSma(last, 200), 10);
      expect(out.indicators.mom20.at(-1)!.value).toBeCloseTo(handMom(last, 20), 10);
      expect(out.indicators.mom60.at(-1)!.value).toBeCloseTo(handMom(last, 60), 10);
      expect(out.indicators.mdd252.at(-1)!.value).toBeCloseTo(handMdd(last, 252), 10);
      expect(out.indicators.vol60.at(-1)!.value).toBeCloseTo(handVol(last, 60), 10);
      // Interior point (index 100, rising leg): sma50 = mean of closes 51..100.
      expect(out.indicators.sma50[100 - 49]).toEqual({ date: seededIndDates[100]!, value: handSma(100, 50) });
      expect(out.indicators.mom20[100 - 20]!.value).toBeCloseTo(handMom(100, 20), 10);
    });

    it("omits null-lookback points (never zeroed)", async () => {
      const out = await service.priceHistory("INDX", 260);
      expect(out.bars).toHaveLength(260);
      expect(out.indicators.sma50).toHaveLength(260 - 50 + 1);
      expect(out.indicators.sma50[0]!.date).toBe(seededIndDates[49]!);
      expect(out.indicators.sma200).toHaveLength(260 - 200 + 1);
      expect(out.indicators.mom20).toHaveLength(260 - 20);
      expect(out.indicators.mom60).toHaveLength(260 - 60);
      expect(out.indicators.mdd252).toHaveLength(260 - 252 + 1);
      expect(out.indicators.vol60).toHaveLength(260 - 60 + 1);
    });

    it("slices indicators to the same window as the bars", async () => {
      const out = await service.priceHistory("INDX", 100);
      expect(out.bars.map((b) => b.date)).toEqual(seededIndDates.slice(-100));
      // All six windows are ≤ 160 bars of lookback, so every windowed date is covered.
      expect(out.indicators.sma50.map((p) => p.date)).toEqual(seededIndDates.slice(-100));
      expect(out.indicators.vol60.map((p) => p.date)).toEqual(seededIndDates.slice(-100));
      expect(out.indicators.sma50.at(-1)!.value).toBeCloseTo(handSma(259, 50), 10);
      // mdd252 still rolls over the full series — 9 points, all inside the window.
      expect(out.indicators.mdd252).toHaveLength(9);
      expect(out.indicators.mdd252[0]!.date).toBe(seededIndDates[251]!);
    });

    it("short-history symbols get empty indicator series (all lookbacks null)", async () => {
      const out = await service.priceHistory("0005.HK", 250);
      expect(out.indicators).toEqual({ sma50: [], sma200: [], mom20: [], mom60: [], mdd252: [], vol60: [] });
      // bars/markers contract unchanged.
      expect(out.bars).toHaveLength(4);
      expect(out.markers).toHaveLength(2);
    });
  });

  describe("param parsing", () => {
    it("parseDaysParam: default 250, accepts bounds, rejects bad values", () => {
      expect(parseDaysParam(undefined)).toBe(250);
      expect(parseDaysParam("1")).toBe(1);
      expect(parseDaysParam("2000")).toBe(2000);
      for (const bad of ["0", "-5", "2001", "1.5", "abc"]) {
        expect(() => parseDaysParam(bad)).toThrow(BadRequestException);
      }
    });

    it("parseRunIdParam: BadRequest on non-numeric / non-positive", () => {
      expect(parseRunIdParam("42")).toBe(42);
      for (const bad of ["abc", "1.5", "0", "-3", ""]) {
        expect(() => parseRunIdParam(bad)).toThrow(BadRequestException);
      }
    });

    it("parseRunsLimitParam: default 20, clamps into [1, 50], rejects non-integers", () => {
      expect(parseRunsLimitParam(undefined)).toBe(20);
      expect(parseRunsLimitParam("1")).toBe(1);
      expect(parseRunsLimitParam("50")).toBe(50);
      expect(parseRunsLimitParam("0")).toBe(1); // clamped
      expect(parseRunsLimitParam("999")).toBe(50); // clamped
      for (const bad of ["abc", "1.5", ""]) {
        expect(() => parseRunsLimitParam(bad)).toThrow(BadRequestException);
      }
    });

    it("summarizeMetrics passes through numeric fields and caDegraded, tolerates junk", () => {
      expect(summarizeMetrics(JSON.stringify({ close: 1, mom20: 0.1, caDegraded: true, extra: "x" }))).toEqual({ close: 1, mom20: 0.1, caDegraded: true });
      expect(summarizeMetrics("not-json")).toEqual({});
      expect(summarizeMetrics(JSON.stringify({ close: "oops" }))).toEqual({});
    });
  });

  // W2 (docs/ops-hardening-plan.md): a crashed run leaves a "running" row, which
  // must never surface as a report. The row is given an explicit later runAt so
  // it WOULD win the latest-run pick if the status filter were missing.
  describe("W2 — only complete runs are reports", () => {
    let runningRunId: number;

    beforeAll(async () => {
      const running = await prisma.deepDiveRun.create({
        data: {
          runAt: new Date(Date.now() + 60_000),
          market: "US",
          screenRunId,
          topN: 2,
          llmCalls: 0,
          cacheHits: 0,
          failed: 0,
          warningsJson: "[]",
          status: "running",
        },
      });
      runningRunId = running.id;
    });

    it("daily() ignores a newer running run and returns the latest complete one", async () => {
      const out = await service.daily("US");
      expect(out.run.id).toBe(deepDiveRunId);
    });

    it("daily(runId) 404s for a running run", async () => {
      await expect(service.daily("US", runningRunId)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("listRuns() lists the complete run and never the running one", async () => {
      const ids = (await service.listRuns("US", 50)).map((r) => r.id);
      expect(ids).toContain(deepDiveRunId);
      expect(ids).not.toContain(runningRunId);
    });
  });

  describe("W3b — dataThrough is the market's effective data cutoff", () => {
    it("returns the newest bar date for the run's market", async () => {
      const out = await service.daily("US");
      expect(out.integrity.dataThrough).toBe(seededIndDates[seededIndDates.length - 1]);
    });
  });
});

describe("visibleRows — display breadth is narrower than measurement breadth", () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ rank: i + 1 }));

  it("slices HK to 5 and US to 10, per Phase 5 Fork A", () => {
    // The defect being fixed: HK showed 15 of ~25 eligible names — 60% of its
    // universe, which is not a ranking. Measurement breadth (40) is untouched.
    expect(visibleRows(rows, "HK")).toHaveLength(5);
    expect(visibleRows(rows, "US")).toHaveLength(10);
    expect(visibleRows(rows, "HK").map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it("is a no-op when fewer candidates exist than the limit", () => {
    expect(visibleRows([{ rank: 1 }], "US")).toHaveLength(1);
  });

  it("falls back to the full list for an unknown market rather than showing nothing", () => {
    // A missing config entry is a gap; silently rendering an empty watchlist
    // would be the worse failure.
    expect(visibleRows(rows, "JP")).toHaveLength(40);
  });
});

describe("provenance — an ad-hoc run must not become the lane's view", () => {
  it("daily() prefers the newest CHAIN run over a newer ad-hoc one", async () => {
    // The measured 2026-09-12 case: HK's dashboard showed a 3-name smoke test
    // (run 8) because it was the newest complete run for the lane.
    const seen: any[] = [];
    const prisma = {
      deepDiveRun: {
        findFirst: async ({ where }: any) => {
          seen.push(where);
          if (where.source === "chain") return { id: 5, market: "HK", screenRunId: 14, runAt: new Date("2026-09-09T15:10:45Z"), status: "complete", topN: 10, llmCalls: 68, cacheHits: 0, failed: 0, warningsJson: "[]", source: "chain" };
          return { id: 8, market: "HK", screenRunId: 17, runAt: new Date("2026-09-11T15:14:17Z"), status: "complete", topN: 3, llmCalls: 21, cacheHits: 0, failed: 0, warningsJson: "[]", source: "adhoc" };
        },
      },
      screenRun: { findUnique: async () => ({ id: 14, market: "HK", sessionDate: "2026-09-09", universeSize: 131, ok: 131, genuinelyAbsent: 0, fetchFailed: 0, degraded: false, warningsJson: "[]" }) },
      screenResult: { findMany: async () => [] },
      deepDiveReport: { findMany: async () => [] },
      bar: { findFirst: async () => ({ date: "2026-09-11" }) },
    } as any;
    const svc = new ReportsService(prisma);
    const out = await svc.daily("HK");
    expect(out.run.id).toBe(5); // the chain run, not the newer ad-hoc one
    expect(seen[0]).toMatchObject({ source: "chain" });
  });

  it("falls back to any provenance when a lane has no chain run yet", async () => {
    // A fresh install (or only experiments so far) must still render verdicts
    // rather than "no run yet".
    const prisma = {
      deepDiveRun: {
        findFirst: async ({ where }: any) =>
          where.source === "chain"
            ? null
            : { id: 8, market: "HK", screenRunId: 17, runAt: new Date("2026-09-11T15:14:17Z"), status: "complete", topN: 3, llmCalls: 21, cacheHits: 0, failed: 0, warningsJson: "[]", source: "adhoc" },
      },
      screenRun: { findUnique: async () => ({ id: 17, market: "HK", sessionDate: "2026-09-11", universeSize: 131, ok: 131, genuinelyAbsent: 0, fetchFailed: 0, degraded: false, warningsJson: "[]" }) },
      screenResult: { findMany: async () => [] },
      deepDiveReport: { findMany: async () => [] },
      bar: { findFirst: async () => ({ date: "2026-09-11" }) },
    } as any;
    const out = await new ReportsService(prisma).daily("HK");
    expect(out.run.id).toBe(8); // better than nothing, and the picker labels it
  });

  it("an explicit runId still reaches an ad-hoc run", async () => {
    // The picker must be able to show one; only the *default* is restricted.
    const prisma = {
      deepDiveRun: { findFirst: async ({ where }: any) => ({ id: where.id, market: "HK", screenRunId: 17, runAt: new Date("2026-09-11T15:14:17Z"), status: "complete", topN: 3, llmCalls: 21, cacheHits: 0, failed: 0, warningsJson: "[]", source: "adhoc" }) },
      screenRun: { findUnique: async () => ({ id: 17, market: "HK", sessionDate: "2026-09-11", universeSize: 131, ok: 131, genuinelyAbsent: 0, fetchFailed: 0, degraded: false, warningsJson: "[]" }) },
      screenResult: { findMany: async () => [] },
      deepDiveReport: { findMany: async () => [] },
      bar: { findFirst: async () => ({ date: "2026-09-11" }) },
    } as any;
    const out = await new ReportsService(prisma).daily("HK", 8);
    expect(out.run.id).toBe(8);
  });
});

describe("integrity — the list's own session, not just the store cutoff", () => {
  it("carries screenedSession so a stale list is distinguishable from fresh data", async () => {
    // After the provenance fix HK legitimately shows an OLDER chain run, so
    // "data through 2026-09-11" alone would invite the reader to assume the
    // ranking is that fresh. The two facts are different and both are now shown.
    const prisma = {
      deepDiveRun: { findFirst: async () => ({ id: 5, market: "HK", screenRunId: 14, runAt: new Date("2026-09-09T15:10:45Z"), status: "complete", topN: 10, llmCalls: 68, cacheHits: 0, failed: 0, warningsJson: "[]", source: "chain" }) },
      screenRun: { findUnique: async () => ({ id: 14, market: "HK", sessionDate: "2026-09-09", universeSize: 131, ok: 131, genuinelyAbsent: 0, fetchFailed: 0, degraded: false, warningsJson: "[]" }) },
      screenResult: { findMany: async () => [] },
      deepDiveReport: { findMany: async () => [] },
      bar: { findFirst: async () => ({ date: "2026-09-11" }) },
    } as any;
    const out = await new ReportsService(prisma).daily("HK");
    expect(out.integrity.screenedSession).toBe("2026-09-09");
    expect(out.integrity.dataThrough).toBe("2026-09-11");
    expect(out.integrity.screenedSession).not.toBe(out.integrity.dataThrough);
  });
});
