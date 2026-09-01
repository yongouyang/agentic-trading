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
    expect(body.corporateActions[0]).toMatchObject({ type: "DIVIDEND", currency: "USD" });
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
});
