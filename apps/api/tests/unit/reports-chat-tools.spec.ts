/**
 * ReportsService phase-3b chat-tool tests (phase-3b-plan §"Tool schema"):
 * runId-targeted daily (wrong-market / unknown-runId 404), transcript index
 * (preview truncation, pipeline ordering) and transcriptEntry, listRuns
 * (ordering / market filter / limit clamp / market validation), and
 * compareSymbols (cross-market join, null fields, arity + unknown-symbol
 * validation). Seeded Prisma rows on a throwaway SQLite db (suite idiom).
 */
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, destroyTestDatabase, type TestDatabase } from "../helpers/test-db.js";
import { PrismaService } from "../../src/prisma.service.js";
import { ReportsService, TRANSCRIPT_PREVIEW_CHARS } from "../../src/reports/reports.service.js";

const VERDICT = { rating: "buy", conviction: 0.7, abstain: false, thesis: "Compounders compound." };

describe("ReportsService chat tools (phase 3b)", () => {
  let db: TestDatabase;
  let prisma: PrismaService;
  let service: ReportsService;
  let usScreenRunId: number;
  let hkScreenRunId: number;
  let usRunOld: number;
  let usRunNew: number;
  let hkRunId: number;
  const hashes = ["c-news", "c-fund", "c-verdict"];
  const LONG_RESPONSE = "x".repeat(TRANSCRIPT_PREVIEW_CHARS + 100);

  beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
    prisma = new PrismaService();
    await prisma.$connect();
    service = new ReportsService(prisma);

    await prisma.instrument.createMany({
      data: [
        { symbol: "AAPL", market: "US", currency: "USD" },
        { symbol: "MSFT", market: "US", currency: "USD" },
        { symbol: "0005.HK", market: "HK", currency: "HKD" },
        { symbol: "UNSREENED", market: "US", currency: "USD" },
      ],
    });

    // US lane: two screen runs + two deep-dive runs (old and new).
    const usScreen = await prisma.screenRun.create({
      data: { market: "US", universeSize: 2, ok: 2, genuinelyAbsent: 0, fetchFailed: 0, degraded: false, warningsJson: "[]" },
    });
    usScreenRunId = usScreen.id;
    await prisma.screenResult.createMany({
      data: [
        { runId: usScreen.id, symbol: "AAPL", rank: 1, score: 0.9, metricsJson: JSON.stringify({ close: 230.5, mom20: 0.04 }) },
        { runId: usScreen.id, symbol: "MSFT", rank: 2, score: 0.8, metricsJson: JSON.stringify({ close: 500.1 }) },
      ],
    });

    const oldRun = await prisma.deepDiveRun.create({
      data: { runAt: new Date("2026-09-06T10:00:00Z"), market: "US", screenRunId: usScreen.id, topN: 1, llmCalls: 3, cacheHits: 0, failed: 0, warningsJson: "[]" },
    });
    usRunOld = oldRun.id;
    await prisma.deepDiveReport.create({
      data: { runId: oldRun.id, symbol: "AAPL", status: "ok", verdictJson: JSON.stringify({ ...VERDICT, thesis: "old run thesis" }), decisionHashesJson: null },
    });

    const newRun = await prisma.deepDiveRun.create({
      data: { runAt: new Date("2026-09-07T10:00:00Z"), market: "US", screenRunId: usScreen.id, topN: 2, llmCalls: 8, cacheHits: 1, failed: 1, warningsJson: "[]" },
    });
    usRunNew = newRun.id;
    await prisma.deepDiveReport.createMany({
      data: [
        { runId: newRun.id, symbol: "AAPL", status: "ok", verdictJson: JSON.stringify(VERDICT), decisionHashesJson: JSON.stringify(hashes) },
        { runId: newRun.id, symbol: "MSFT", status: "failed:llm-timeout", verdictJson: null, decisionHashesJson: null },
      ],
    });

    // AgentDecision rows seeded out of pipeline order; the first entry has a
    // long response to exercise preview truncation.
    const agents = ["verdict", "fundamentals-analyst", "news-analyst"];
    for (let i = 0; i < hashes.length; i++) {
      await prisma.agentDecision.create({
        data: {
          hash: hashes[hashes.length - 1 - i]!,
          agent: agents[i]!,
          model: "k3-256k",
          promptVersion: "v1",
          systemPrompt: `sys-${i}`,
          userPrompt: `usr-${i}`,
          responseText: i === 2 ? LONG_RESPONSE : `resp-${i}`,
          usageJson: JSON.stringify({ promptTokens: 10 + i, completionTokens: 5 + i }),
        },
      });
    }

    // HK lane: one screen run + one deep-dive run; 0005.HK has a screen row
    // but was never deep-dived.
    const hkScreen = await prisma.screenRun.create({
      data: { market: "HK", universeSize: 1, ok: 1, genuinelyAbsent: 0, fetchFailed: 0, degraded: false, warningsJson: "[]" },
    });
    hkScreenRunId = hkScreen.id;
    await prisma.screenResult.create({
      data: { runId: hkScreen.id, symbol: "0005.HK", rank: 1, score: 0.6, metricsJson: JSON.stringify({ close: 99.5 }) },
    });
    const hkRun = await prisma.deepDiveRun.create({
      data: { runAt: new Date("2026-09-07T12:00:00Z"), market: "HK", screenRunId: hkScreen.id, topN: 0, llmCalls: 0, cacheHits: 0, failed: 0, warningsJson: "[]" },
    });
    hkRunId = hkRun.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    destroyTestDatabase(db);
    delete process.env.DATABASE_URL;
  });

  describe("daily with runId", () => {
    it("omitted runId returns the latest run (current behavior)", async () => {
      const out = await service.daily("US");
      expect(out.run.id).toBe(usRunNew);
      expect(out.run.topN).toBe(2);
    });

    it("runId targets a specific historical run", async () => {
      const out = await service.daily("US", usRunOld);
      expect(out.run.id).toBe(usRunOld);
      expect(out.run.screenRunId).toBe(usScreenRunId);
      expect(out.rows[0]!.verdict).toMatchObject({ thesis: "old run thesis" });
    });

    it("404s when the runId belongs to a different market", async () => {
      await expect(service.daily("US", hkRunId)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("404s on an unknown runId", async () => {
      await expect(service.daily("US", 9999)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("deepDiveIndex", () => {
    it("returns the deepDive shape with a transcript index in pipeline order", async () => {
      const out = await service.deepDiveIndex(usRunNew, "AAPL");
      expect(out.run).toMatchObject({ id: usRunNew, market: "US", screenRunId: usScreenRunId, topN: 2 });
      expect(out.symbol).toBe("AAPL");
      expect(out.status).toBe("ok");
      expect(out.verdict).toEqual(VERDICT);
      expect(out.index.map((e) => e.hash)).toEqual(hashes);
      expect(out.index.map((e) => e.agent)).toEqual(["news-analyst", "fundamentals-analyst", "verdict"]);
      expect(out.index[0]).toMatchObject({ model: "k3-256k", promptVersion: "v1", usage: { promptTokens: 12, completionTokens: 7 } });
    });

    it("truncates the preview to ~500 chars with no prompt/response bodies", async () => {
      const out = await service.deepDiveIndex(usRunNew, "AAPL");
      expect(out.index[0]!.preview).toBe(LONG_RESPONSE.slice(0, TRANSCRIPT_PREVIEW_CHARS));
      expect(out.index[0]!.preview.length).toBe(TRANSCRIPT_PREVIEW_CHARS);
      expect(out.index[0]).not.toHaveProperty("systemPrompt");
      expect(out.index[0]).not.toHaveProperty("userPrompt");
      expect(out.index[0]).not.toHaveProperty("responseText");
    });

    it("404s on unknown (runId, symbol) pairs", async () => {
      await expect(service.deepDiveIndex(usRunNew, "0005.HK")).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("transcriptEntry", () => {
    it("returns the full AgentDecision row by hash", async () => {
      const out = await service.transcriptEntry("c-verdict");
      expect(out).toMatchObject({
        hash: "c-verdict",
        agent: "verdict",
        model: "k3-256k",
        promptVersion: "v1",
        systemPrompt: "sys-0",
        userPrompt: "usr-0",
        responseText: "resp-0",
        usage: { promptTokens: 10, completionTokens: 5 },
      });
      expect(typeof out.createdAt).toBe("string");
    });

    it("404s on an unknown hash", async () => {
      await expect(service.transcriptEntry("no-such-hash")).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("listRuns", () => {
    it("returns runs newest-first across markets by default", async () => {
      const out = await service.listRuns();
      expect(out.map((r) => r.id)).toEqual([hkRunId, usRunNew, usRunOld]);
      expect(out[1]).toMatchObject({ market: "US", screenRunId: usScreenRunId, topN: 2, llmCalls: 8, cacheHits: 1, failed: 1 });
      expect(typeof out[0]!.runAt).toBe("string");
    });

    it("filters by market", async () => {
      const out = await service.listRuns("US");
      expect(out.map((r) => r.id)).toEqual([usRunNew, usRunOld]);
    });

    it("honors the limit", async () => {
      const out = await service.listRuns(undefined, 2);
      expect(out.map((r) => r.id)).toEqual([hkRunId, usRunNew]);
    });

    it("400s on a limit outside [1, 50]", async () => {
      await expect(service.listRuns(undefined, 0)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.listRuns(undefined, 51)).rejects.toBeInstanceOf(BadRequestException);
    });

    it("400s on an invalid market", async () => {
      await expect(service.listRuns("CN")).rejects.toBeInstanceOf(BadRequestException);
    });

    it("symbol filter (phase 3c): only runs with a DeepDiveReport for that symbol", async () => {
      // AAPL was dived in both US runs; MSFT only in the new run (failed
      // report still counts — a DeepDiveReport row exists for it).
      expect((await service.listRuns(undefined, 10, "AAPL")).map((r) => r.id)).toEqual([usRunNew, usRunOld]);
      expect((await service.listRuns(undefined, 10, "MSFT")).map((r) => r.id)).toEqual([usRunNew]);
    });

    it("symbol filter combines with market", async () => {
      expect((await service.listRuns("US", 10, "AAPL")).map((r) => r.id)).toEqual([usRunNew, usRunOld]);
      expect((await service.listRuns("HK", 10, "AAPL"))).toEqual([]);
    });

    it("symbol with no reports anywhere → empty list (never a 404/500)", async () => {
      expect(await service.listRuns(undefined, 10, "0005.HK")).toEqual([]); // HK run has zero reports
      expect(await service.listRuns(undefined, 10, "NOSUCH")).toEqual([]);
    });
  });

  describe("compareSymbols", () => {
    it("joins latest screen row + latest verdict across both markets", async () => {
      const out = await service.compareSymbols(["AAPL", "0005.HK"]);
      expect(out.symbols).toHaveLength(2);
      const aapl = out.symbols[0]!;
      expect(aapl.market).toBe("US");
      expect(aapl.screen).toMatchObject({ runId: usScreenRunId, rank: 1, score: 0.9 });
      expect(aapl.screen!.metrics).toMatchObject({ close: 230.5, mom20: 0.04 });
      expect(aapl.verdict).toEqual(VERDICT);
      const hsbc = out.symbols[1]!;
      expect(hsbc.market).toBe("HK");
      expect(hsbc.screen).toMatchObject({ runId: hkScreenRunId, rank: 1, score: 0.6 });
      expect(hsbc.verdict).toBeNull(); // never deep-dived
    });

    it("uses the LATEST deep-dive verdict when a symbol has several", async () => {
      const out = await service.compareSymbols(["AAPL", "MSFT"]);
      expect(out.symbols[0]!.verdict).toMatchObject({ thesis: "Compounders compound." });
      expect(out.symbols[1]!.verdict).toBeNull(); // failed run → null, never 500
      expect(out.symbols[1]!.screen).not.toBeNull();
    });

    it("screen is null for a known symbol with no screen result", async () => {
      const out = await service.compareSymbols(["UNSREENED", "AAPL"]);
      expect(out.symbols[0]!.screen).toBeNull();
      expect(out.symbols[0]!.verdict).toBeNull();
    });

    it("404s on an unknown symbol", async () => {
      await expect(service.compareSymbols(["AAPL", "NOSUCH"])).rejects.toBeInstanceOf(NotFoundException);
    });

    it("400s on fewer than 2 or more than 5 symbols", async () => {
      await expect(service.compareSymbols(["AAPL"])).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.compareSymbols(["A", "B", "C", "D", "E", "F"])).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
