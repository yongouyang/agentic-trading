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
import { parseDaysParam, parseRunIdParam, ReportsService, summarizeMetrics } from "../../src/reports/reports.service.js";

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
      });
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

    it("summarizeMetrics passes through numeric fields and caDegraded, tolerates junk", () => {
      expect(summarizeMetrics(JSON.stringify({ close: 1, mom20: 0.1, caDegraded: true, extra: "x" }))).toEqual({ close: 1, mom20: 0.1, caDegraded: true });
      expect(summarizeMetrics("not-json")).toEqual({});
      expect(summarizeMetrics(JSON.stringify({ close: "oops" }))).toEqual({});
    });
  });
});
