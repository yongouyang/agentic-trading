/**
 * API integration tests: boot the real AppModule with the dummy market-data
 * provider + a throwaway SQLite db (migration SQL applied — dev.db is
 * gitignored). Exercises the health endpoint and the provider seam end to
 * end: every injected dummy behavior must produce the documented DataOutcome
 * typing. Fully deterministic — no network.
 */
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DataOutcome } from "@agentic-trading/quant-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { MARKET_DATA_DEPS, type MarketDataDeps } from "../../src/market-data/market-data.deps.js";
import { DummyMarketDataProvider, PHANTOM_BAR_DATE } from "../../src/market-data/dummy-market-data.provider.js";
import type { DummyBehavior } from "../../src/market-data/market-data.types.js";
import { PrismaService } from "../../src/prisma.service.js";
import { createTestDatabase, destroyTestDatabase, type TestDatabase } from "../helpers/test-db.js";

describe("API integration (dummy provider + throwaway SQLite)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let db: TestDatabase;
  let prisma: PrismaService;
  let deps: MarketDataDeps;

  beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
    prisma = new PrismaService();
    deps = { provider: new DummyMarketDataProvider(), testMode: true, dummyMode: true };

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(MARKET_DATA_DEPS)
      .useValue(deps)
      .compile();

    app = moduleRef.createNestApplication();
    await app.listen(0);
    baseUrl = (await app.getUrl()).replace("[::1]", "localhost");
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATABASE_URL;
    destroyTestDatabase(db);
  });

  function getBars(symbol: string, behavior?: DummyBehavior | "bogus") {
    return fetch(`${baseUrl}/instruments/${symbol}/bars`, {
      headers: behavior ? { "x-test-market-behavior": behavior } : {},
    });
  }

  it("GET /health reports ok against the throwaway db", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok", instruments: 0 });
  });

  it("GET /instruments/:symbol/bars defaults to deterministic synthetic bars typed OK", async () => {
    const res = await getBars("0005.HK");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBe(DataOutcome.OK);
    expect(body.bars.length).toBeGreaterThan(0);
  });

  it.each([
    ["rate-limited", "http-429"],
    ["timeout", "timeout"],
    ["empty-bars", "http-200-empty-bars"],
    ["zombie-meta", "http-200-zombie-meta"],
  ] as const)("%s → FETCH_FAILED via x-test-market-behavior header", async (behavior, reason) => {
    const res = await getBars("0700.HK", behavior);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBe(DataOutcome.FETCH_FAILED);
    expect(body.failureReason).toBe(reason);
    expect(body.bars).toEqual([]);
  });

  it("not-found → GENUINELY_ABSENT", async () => {
    const res = await getBars("NOSUCHTICKER", "not-found");
    const body = await res.json();
    expect(body.outcome).toBe(DataOutcome.GENUINELY_ABSENT);
  });

  it("fx-inconsistent-dividends → OK + caDegraded flag (9988.HK case)", async () => {
    const res = await getBars("9988.HK", "fx-inconsistent-dividends");
    const body = await res.json();
    expect(body.outcome).toBe(DataOutcome.OK);
    expect(body.caDegraded).toBe(true);
    expect(body.corporateActions[0]).toMatchObject({ type: "DIVIDEND", currency: "HKD", amount: 0.9800875 });
  });

  it("holiday-phantom → OK with the phantom bar dropped (RULE L1)", async () => {
    const res = await getBars("0700.HK", "holiday-phantom");
    const body = await res.json();
    expect(body.outcome).toBe(DataOutcome.OK);
    expect(body.droppedPhantomBars).toEqual([PHANTOM_BAR_DATE]);
    expect(body.bars.some((b: { date: string }) => b.date === PHANTOM_BAR_DATE)).toBe(false);
  });

  it("close-outside-hl → OK with the close clamped and reported (RULE L2)", async () => {
    const res = await getBars("CSPX.L", "close-outside-hl");
    const body = await res.json();
    expect(body.outcome).toBe(DataOutcome.OK);
    expect(body.repairedBars).toHaveLength(1);
  });

  it("rejects an unknown test behavior loudly", async () => {
    const res = await getBars("0005.HK", "bogus");
    expect(res.status).toBe(400);
  });

  it("ignores the injection header when test mode is off", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(MARKET_DATA_DEPS)
      .useValue({ provider: new DummyMarketDataProvider(), testMode: false, dummyMode: true })
      .compile();
    const strictApp = moduleRef.createNestApplication();
    await strictApp.listen(0);
    try {
      const url = (await strictApp.getUrl()).replace("[::1]", "localhost");
      const res = await fetch(`${url}/instruments/0700.HK/bars`, { headers: { "x-test-market-behavior": "timeout" } });
      const body = await res.json();
      expect(body.outcome).toBe(DataOutcome.OK); // header ignored — dummy default, not the injected timeout
    } finally {
      await strictApp.close();
    }
  });

  /** Phase-3c: route wiring for the read-only additions — one seeded lane. */
  describe("reports runs + price-history indicators", () => {
    let runId: number;

    beforeAll(async () => {
      const screenRun = await prisma.screenRun.create({
        data: { market: "US", universeSize: 1, ok: 1, genuinelyAbsent: 0, fetchFailed: 0, degraded: false, warningsJson: "[]" },
      });
      const run = await prisma.deepDiveRun.create({
        data: { runAt: new Date("2026-09-08T10:00:00Z"), market: "US", screenRunId: screenRun.id, topN: 1, llmCalls: 5, cacheHits: 1, failed: 0, warningsJson: "[]" },
      });
      runId = run.id;
      await prisma.deepDiveReport.create({
        data: { runId: run.id, symbol: "AAPL", status: "ok", verdictJson: null, decisionHashesJson: null },
      });
      const inst = await prisma.instrument.create({ data: { symbol: "INDX", market: "US", currency: "USD" } });
      await prisma.bar.createMany({
        data: Array.from({ length: 60 }, (_, i) => ({
          instrumentId: inst.id,
          date: new Date(Date.UTC(2026, 5, 1) + i * 86_400_000).toISOString().slice(0, 10),
          open: 100 + i,
          high: 100 + i,
          low: 100 + i,
          close: 100 + i,
          volume: 1000,
        })),
      });
    });

    it("GET /reports/runs returns the seeded run newest-first", async () => {
      const res = await fetch(`${baseUrl}/reports/runs`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body[0]).toMatchObject({ id: runId, market: "US", topN: 1, llmCalls: 5, cacheHits: 1, failed: 0 });
      expect(typeof body[0].runAt).toBe("string");
    });

    it("GET /reports/runs?market= filters and validates", async () => {
      const us = await fetch(`${baseUrl}/reports/runs?market=US`);
      expect((await us.json()).map((r: { id: number }) => r.id)).toContain(runId);
      const hk = await fetch(`${baseUrl}/reports/runs?market=HK`);
      expect(await hk.json()).toEqual([]);
      const bad = await fetch(`${baseUrl}/reports/runs?market=CN`);
      expect(bad.status).toBe(400);
    });

    it("GET /reports/runs?limit= clamps into [1, 50] and 400s on non-integers", async () => {
      const clamped = await fetch(`${baseUrl}/reports/runs?limit=999`);
      expect(clamped.status).toBe(200);
      const bad = await fetch(`${baseUrl}/reports/runs?limit=abc`);
      expect(bad.status).toBe(400);
    });

    it("GET /reports/runs?symbol= only runs with a DeepDiveReport for that symbol", async () => {
      const aapl = await fetch(`${baseUrl}/reports/runs?symbol=AAPL`);
      expect((await aapl.json()).map((r: { id: number }) => r.id)).toEqual([runId]);
      const none = await fetch(`${baseUrl}/reports/runs?symbol=NOPE`);
      expect(await none.json()).toEqual([]);
    });

    it("GET /instruments/:symbol/price-history carries the additive indicators field", async () => {
      const res = await fetch(`${baseUrl}/instruments/INDX/price-history?days=30`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.bars).toHaveLength(30);
      expect(Object.keys(body.indicators)).toEqual(["sma50", "sma200", "mom20", "mom60", "mdd252", "vol60"]);
      // 60 stored bars, days=30 → window = series indices 30..59. sma50 is
      // defined from index 49 → 11 points starting at window index 19; mom20
      // (defined from index 20) covers every windowed date. Exact values are
      // unit-tested against hand computations in reports.service.spec.ts.
      expect(body.indicators.sma50[0].date).toBe(body.bars[19].date); // index 49 overall
      expect(body.indicators.mom20.map((p: { date: string }) => p.date)).toEqual(body.bars.map((b: { date: string }) => b.date));
      expect(body.indicators.sma200).toEqual([]);
    });
  });
});
