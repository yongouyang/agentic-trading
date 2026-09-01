/**
 * runDailyScreen end-to-end against the dummy/test providers and a throwaway
 * SQLite db (phase-1-spec §6). No child processes, no network — the live
 * Yahoo smoke test is gated in yahoo-live.spec.ts.
 */
import type { Bar } from "@agentic-trading/quant-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDailyScreen, type UniverseEntry } from "../../src/cli/daily-screen.js";
import { DummyMarketDataProvider } from "../../src/market-data/dummy-market-data.provider.js";
import { PHANTOM_BAR_DATE } from "../../src/market-data/dummy-market-data.provider.js";
import type { DummyBehavior, MarketDataProvider, RawMarketDataResponse } from "../../src/market-data/market-data.types.js";
import { PrismaService } from "../../src/prisma.service.js";
import { createTestDatabase, destroyTestDatabase, type TestDatabase } from "../helpers/test-db.js";

let db: TestDatabase;
let prisma: PrismaService;
const savedUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  db = await createTestDatabase();
  process.env.DATABASE_URL = db.url;
  prisma = new PrismaService();
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  if (savedUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedUrl;
  destroyTestDatabase(db);
});

const entry = (symbol: string): UniverseEntry => ({ symbol, name: symbol, currency: symbol.endsWith(".HK") ? "HKD" : "USD", kind: "stock" });

const silent = () => {};

describe("runDailyScreen — dummy provider, throwaway SQLite", () => {
  it("all 8 dummy behaviors flow through with correct outcome tallies; >2% fetch-failed ⇒ degraded", async () => {
    const behaviors: [string, DummyBehavior][] = [
      ["OKA", "ok"],
      ["RL", "rate-limited"],
      ["TO", "timeout"],
      ["EB", "empty-bars"],
      ["ZM", "zombie-meta"],
      ["NF", "not-found"],
      ["FXD", "fx-inconsistent-dividends"],
      ["HP", "holiday-phantom"],
      ["COHL", "close-outside-hl"],
    ];
    const provider = new DummyMarketDataProvider(Object.fromEntries(behaviors));
    const reports = await runDailyScreen(
      { prisma, provider, universes: { us: behaviors.map(([s]) => entry(s)) }, reportsDir: null, today: "2025-01-02", log: silent },
      { market: "us" },
    );
    const r = reports[0]!;
    expect(r.market).toBe("US");
    expect(r.universeSize).toBe(9);
    // OK: ok + fx-inconsistent-dividends + holiday-phantom + close-outside-hl
    expect(r.ok).toBe(4);
    // FETCH_FAILED: rate-limited, timeout, empty-bars (L4), zombie-meta (L3)
    expect(r.fetchFailed.map((f) => f.symbol).sort()).toEqual(["EB", "RL", "TO", "ZM"]);
    expect(r.fetchFailed.find((f) => f.symbol === "RL")?.reason).toBe("http-429");
    // GENUINELY_ABSENT: not-found only — never a wrong-shape 200.
    expect(r.genuinelyAbsent).toBe(1);
    expect(r.clampedBars).toBe(1); // close-outside-hl repaired by L2
    expect(r.degraded).toBe(true); // 4/9 > 2%

    const run = await prisma.screenRun.findFirst({ where: { market: "US" }, orderBy: { id: "desc" } });
    expect(run).toMatchObject({ universeSize: 9, ok: 4, genuinelyAbsent: 1, fetchFailed: 4, degraded: true });
    const warnings = JSON.parse(run!.warningsJson) as string[];
    expect(warnings.some((w) => w.startsWith("COHL: L2 clamped"))).toBe(true);
  });

  it("HK lane: CA_DEGRADED auto-detection fires; L1 drops the HKEX-holiday phantom bar", async () => {
    const provider = new DummyMarketDataProvider({
      "9988.HK": "fx-inconsistent-dividends",
      "0700.HK": "holiday-phantom",
      "0005.HK": "ok",
    });
    const reports = await runDailyScreen(
      { prisma, provider, universes: { hk: ["9988.HK", "0700.HK", "0005.HK"].map(entry) }, reportsDir: null, today: "2025-01-02", log: silent },
      { market: "hk" },
    );
    const r = reports[0]!;
    expect(r.market).toBe("HK");
    expect(r.ok).toBe(3);
    expect(r.degraded).toBe(false);
    expect(r.warnings.some((w) => w.includes("9988.HK: CA_DEGRADED"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("0700.HK") && w.includes(PHANTOM_BAR_DATE))).toBe(true);

    const instrument = await prisma.instrument.findUnique({ where: { symbol: "9988.HK" } });
    expect(instrument?.caDegraded).toBe(true);
    expect(instrument?.market).toBe("HK");

    // Dividend event stored; phantom bar dropped; other HK names untouched.
    const cas = await prisma.corporateAction.findMany({ where: { instrumentId: instrument!.id } });
    expect(cas).toHaveLength(1);
    expect(cas[0]).toMatchObject({ type: "DIVIDEND", currency: "HKD", amount: 0.9800875 });
    const tencent = await prisma.instrument.findUnique({ where: { symbol: "0700.HK" } });
    const bars = await prisma.bar.findMany({ where: { instrumentId: tencent!.id } });
    expect(bars.some((b) => b.date === PHANTOM_BAR_DATE)).toBe(false);
    expect((await prisma.instrument.findUnique({ where: { symbol: "0005.HK" } }))?.caDegraded).toBe(false);
  });

  it("small universe of synthetic trending names yields a persisted ranked shortlist", async () => {
    const symbols = ["TRD1", "TRD2", "TRD3", "TRD4", "TRD5", "TRD6"];
    const provider = new TrendingProvider({ TRD6: "rate-limited" });
    const reports = await runDailyScreen(
      { prisma, provider, universes: { us: symbols.map(entry) }, reportsDir: null, today: "2026-09-01", log: silent },
      { market: "us" },
    );
    const r = reports[0]!;
    expect(r.ok).toBe(5);
    expect(r.fetchFailed).toEqual([{ symbol: "TRD6", reason: "http-429" }]);
    expect(r.degraded).toBe(true); // 1/6 > 2%
    expect(r.shortlist).toHaveLength(5);
    // Drift increases with the index ⇒ TRD5 (highest drift) ranks first.
    expect(r.shortlist[0]!.symbol).toBe("TRD5");
    expect(r.shortlist.map((p) => p.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(r.text).toContain("== DATA INTEGRITY ==");
    expect(r.text).toContain("== SHORTLIST ==");

    const run = await prisma.screenRun.findFirst({ where: { market: "US", universeSize: 6 }, orderBy: { id: "desc" } });
    const rows = await prisma.screenResult.findMany({ where: { runId: run!.id }, orderBy: { rank: "asc" } });
    expect(rows).toHaveLength(5);
    const metrics = JSON.parse(rows[0]!.metricsJson);
    expect(metrics.mom60).toBeGreaterThan(0);
    expect(metrics.sharpe252).toBeGreaterThan(0);
    expect(metrics).toHaveProperty("adv20");
  });
});

/** Deterministic trending provider: 300 weekday bars ending 2026-09-01 with a
 *  per-symbol positive drift plus a tiny alternating wobble (zero-variance
 *  series get sharpe=null by design — indicators never return NaN). */
class TrendingProvider implements MarketDataProvider {
  constructor(private readonly behaviors: Record<string, DummyBehavior> = {}) {}
  async fetchDailyBars(symbol: string): Promise<RawMarketDataResponse> {
    if (this.behaviors[symbol]) {
      return { httpStatus: 429, hasTimestamps: false, bars: [], corporateActions: [], providerSaysNotFound: false, failureReason: "http-429" };
    }
    const drift = 0.0008 + (symbol.charCodeAt(3) - 49) * 0.0004; // TRD1…TRD6
    const dates: string[] = [];
    const d = new Date("2026-09-01T00:00:00Z");
    while (dates.length < 300) {
      const dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) dates.unshift(d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() - 1);
    }
    let prev = 100;
    const bars: Bar[] = dates.map((date, i) => {
      const close = prev * (1 + drift + (i % 2 === 0 ? 0.0005 : -0.0005));
      const bar: Bar = { date, open: prev, high: Math.max(prev, close) * 1.001, low: Math.min(prev, close) * 0.999, close, volume: 1_000_000 };
      prev = close;
      return bar;
    });
    return { httpStatus: 200, hasTimestamps: true, bars, corporateActions: [], providerSaysNotFound: false };
  }
}
