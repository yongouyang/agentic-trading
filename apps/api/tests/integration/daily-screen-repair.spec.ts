/**
 * HK rescue-loader flow (phase-1-hardening-plan §A.3) — runDailyScreen with
 * the dummy Yahoo provider plus an injected fake RepairProvider, against a
 * throwaway SQLite db. No network, no child processes.
 */
import type { Bar } from "@agentic-trading/quant-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDailyScreen, type UniverseEntry } from "../../src/cli/daily-screen.js";
import { DummyMarketDataProvider } from "../../src/market-data/dummy-market-data.provider.js";
import type { RepairProvider } from "../../src/market-data/eastmoney-repair.provider.js";
import type { DummyBehavior } from "../../src/market-data/market-data.types.js";
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

const hk = (symbol: string): UniverseEntry => ({ symbol, name: symbol, currency: "HKD", kind: "stock" });
const us = (symbol: string): UniverseEntry => ({ symbol, name: symbol, currency: "USD", kind: "stock" });
const silent = () => {};

/** Deterministic trending series: 300 weekday bars ending 2026-09-01 — passes
 *  the §4 eligibility set (≥252 bars, adv ≥ HK$100M, low vol, bullish). */
function trendingBars(): Bar[] {
  const dates: string[] = [];
  const d = new Date("2026-09-01T00:00:00Z");
  while (dates.length < 300) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) dates.unshift(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  let prev = 100;
  return dates.map((date, i) => {
    const close = prev * (1 + 0.001 + (i % 2 === 0 ? 0.0005 : -0.0005));
    const bar: Bar = { date, open: prev, high: Math.max(prev, close) * 1.001, low: Math.min(prev, close) * 0.999, close, volume: 1_000_000 };
    prev = close;
    return bar;
  });
}

class FakeRepairProvider implements RepairProvider {
  readonly calls: string[] = [];
  constructor(private readonly table: Record<string, { bars: Bar[] } | { failure: string }>) {}
  async fetchRawBars(symbol: string) {
    this.calls.push(symbol);
    return this.table[symbol] ?? { failure: "not-configured" };
  }
}

describe("runDailyScreen — HK rescue loaders (phase-1-hardening-plan §A)", () => {
  it("Yahoo rate-limited HK name + repair bars ⇒ rescued, screened, dataSource flips, header records it", async () => {
    const provider = new DummyMarketDataProvider({ "0700.HK": "rate-limited" });
    const repair = new FakeRepairProvider({ "0700.HK": { bars: trendingBars() } });
    const reports = await runDailyScreen(
      { prisma, provider, repairProvider: repair, universes: { hk: [hk("0700.HK")] }, reportsDir: null, today: "2026-09-01", log: silent },
      { market: "hk" },
    );
    const r = reports[0]!;
    expect(repair.calls).toEqual(["0700.HK"]);
    expect(r.ok).toBe(1);
    expect(r.fetchFailed).toEqual([]);
    expect(r.rescued).toEqual([{ symbol: "0700.HK", bars: 300, source: "eastmoney" }]);
    expect(r.text).toContain("1 rescued via eastmoney (0700.HK)");
    expect(r.shortlist.map((p) => p.symbol)).toContain("0700.HK");

    const instrument = await prisma.instrument.findUnique({ where: { symbol: "0700.HK" } });
    expect(instrument?.dataSource).toBe("eastmoney");
    expect(await prisma.bar.count({ where: { instrumentId: instrument!.id } })).toBe(300);
    // No stored Yahoo CA history ⇒ CA_DEGRADED + loud warning.
    expect(instrument?.caDegraded).toBe(true);
    expect(r.warnings.some((w) => w.includes("rescue-filled without CA history"))).toBe(true);

    const run = await prisma.screenRun.findFirst({ where: { market: "HK" }, orderBy: { id: "desc" } });
    expect(run).toMatchObject({ universeSize: 1, ok: 1, fetchFailed: 0 });
  });

  it("repair failure ⇒ ticker stays FETCH_FAILED (loud, unchanged)", async () => {
    const provider = new DummyMarketDataProvider({ "0005.HK": "rate-limited" });
    const repair = new FakeRepairProvider({ "0005.HK": { failure: "transport:ECONNRESET" } });
    const reports = await runDailyScreen(
      { prisma, provider, repairProvider: repair, universes: { hk: [hk("0005.HK")] }, reportsDir: null, today: "2026-09-01", log: silent },
      { market: "hk" },
    );
    const r = reports[0]!;
    expect(r.fetchFailed).toEqual([{ symbol: "0005.HK", reason: "http-429" }]);
    expect(r.rescued).toEqual([]);
    expect(r.ok).toBe(0);
    expect(r.warnings.some((w) => w.includes("0005.HK: eastmoney rescue failed (transport:ECONNRESET)"))).toBe(true);
    expect((await prisma.instrument.findUnique({ where: { symbol: "0005.HK" } }))?.dataSource).toBe("yahoo");
  });

  it("call cap: 6 failing HK names ⇒ exactly 5 repair calls, 6th keeps its outcome", async () => {
    const symbols = ["0001.HK", "0002.HK", "0003.HK", "0004.HK", "0006.HK", "0007.HK"];
    const provider = new DummyMarketDataProvider(Object.fromEntries(symbols.map((s): [string, DummyBehavior] => [s, "rate-limited"])));
    const repair = new FakeRepairProvider({});
    const reports = await runDailyScreen(
      { prisma, provider, repairProvider: repair, universes: { hk: symbols.map(hk) }, reportsDir: null, today: "2026-09-01", log: silent },
      { market: "hk" },
    );
    expect(repair.calls).toEqual(symbols.slice(0, 5)); // in-list order, capped at 5
    const r = reports[0]!;
    expect(r.fetchFailed).toHaveLength(6);
    expect(r.rescued).toEqual([]);
  });

  it("US lane is never repaired", async () => {
    const provider = new DummyMarketDataProvider({ AAA: "rate-limited" });
    const repair = new FakeRepairProvider({ AAA: { bars: trendingBars() } });
    const reports = await runDailyScreen(
      { prisma, provider, repairProvider: repair, universes: { us: [us("AAA")] }, reportsDir: null, today: "2026-09-01", log: silent },
      { market: "us" },
    );
    expect(repair.calls).toEqual([]);
    expect(reports[0]!.fetchFailed).toEqual([{ symbol: "AAA", reason: "http-429" }]);
  });

  it("GENUINELY_ABSENT HK name with no stored CAs ⇒ rescued + caDegraded=true warning", async () => {
    const provider = new DummyMarketDataProvider({ "0999.HK": "not-found" });
    const repair = new FakeRepairProvider({ "0999.HK": { bars: trendingBars() } });
    const reports = await runDailyScreen(
      { prisma, provider, repairProvider: repair, universes: { hk: [hk("0999.HK")] }, reportsDir: null, today: "2026-09-01", log: silent },
      { market: "hk" },
    );
    const r = reports[0]!;
    expect(r.genuinelyAbsent).toBe(0);
    expect(r.rescued).toEqual([{ symbol: "0999.HK", bars: 300, source: "eastmoney" }]);
    const instrument = await prisma.instrument.findUnique({ where: { symbol: "0999.HK" } });
    expect(instrument?.dataSource).toBe("eastmoney");
    expect(instrument?.caDegraded).toBe(true);
    expect(r.warnings.some((w) => w.includes("0999.HK: CA_DEGRADED — rescue-filled without CA history"))).toBe(true);
  });

  it("a previously-rescued instrument flips back to yahoo when Yahoo succeeds", async () => {
    await prisma.instrument.create({
      data: { symbol: "0388.HK", market: "HK", currency: "HKD", name: "HKEX", dataSource: "eastmoney" },
    });
    const repair = new FakeRepairProvider({});
    const reports = await runDailyScreen(
      { prisma, provider: new DummyMarketDataProvider(), repairProvider: repair, universes: { hk: [hk("0388.HK")] }, reportsDir: null, today: "2026-09-01", log: silent },
      { market: "hk" },
    );
    expect(repair.calls).toEqual([]); // Yahoo OK ⇒ no repair attempted
    expect(reports[0]!.rescued).toEqual([]);
    expect((await prisma.instrument.findUnique({ where: { symbol: "0388.HK" } }))?.dataSource).toBe("yahoo");
    expect(reports[0]!.warnings.some((w) => w.includes('dataSource flipped back to "yahoo"'))).toBe(true);
  });
});
