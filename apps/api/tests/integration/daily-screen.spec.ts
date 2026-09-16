/**
 * runDailyScreen end-to-end against the dummy/test providers and a throwaway
 * SQLite db (phase-1-spec §6). No child processes, no network — the live
 * Yahoo smoke test is gated in yahoo-live.spec.ts.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Bar } from "@agentic-trading/quant-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isDummyProviderLabel, runDailyScreen, type UniverseEntry } from "../../src/cli/daily-screen.js";
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

describe("runDailyScreen — provider provenance in the integrity header", () => {
  it("labels the real provider and the report JSON records it", async () => {
    const lines: string[] = [];
    const dir = mkdtempSync(path.join(tmpdir(), "daily-reports-"));
    try {
      const reports = await runDailyScreen(
        {
          prisma,
          provider: new DummyMarketDataProvider(),
          providerLabel: "yahoo",
          universes: { us: [entry("AAPL")] },
          reportsDir: dir,
          today: "2025-01-02",
          log: (l) => lines.push(l),
        },
        { market: "us" },
      );
      expect(reports[0]!.provider).toBe("yahoo");
      expect(lines.join("\n")).toContain("US 2025-01-02 · provider=yahoo:");
      const json = JSON.parse(readFileSync(path.join(dir, "2025-01-02-US.json"), "utf8"));
      expect(json.provider).toBe("yahoo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the dummy provider is shouted in the header and up front (synthetic data must never pass as real)", async () => {
    const lines: string[] = [];
    const reports = await runDailyScreen(
      { prisma, provider: new DummyMarketDataProvider(), universes: { us: [entry("AAPL")] }, reportsDir: null, today: "2025-01-02", log: (l) => lines.push(l) },
      { market: "us" },
    );
    expect(reports[0]!.provider).toBe("DummyMarketDataProvider"); // derived from the injected class
    const out = lines.join("\n");
    expect(out).toContain('⚠ market-data provider is "DummyMarketDataProvider"');
    expect(out).toContain("SYNTHETIC DATA, NOT REAL MARKET DATA");
    expect(out).toContain("point DATABASE_URL at a throwaway db");
  });

  it("isDummyProviderLabel matches the dummy, not a real loader", () => {
    expect(isDummyProviderLabel("DummyMarketDataProvider")).toBe(true);
    expect(isDummyProviderLabel("dummy")).toBe(true);
    expect(isDummyProviderLabel("yahoo")).toBe(false);
    expect(isDummyProviderLabel("YahooMarketDataProvider")).toBe(false);
  });
});

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

  it("a still-forming bar never enters the store (session-close filter) and the drop is logged", async () => {
    const dummy = new DummyMarketDataProvider();
    // Append a still-forming 2026-09-11 bar to the dummy's OK response —
    // exactly what Yahoo serves during market hours.
    const wrap: MarketDataProvider = {
      fetchDailyBars: async (symbol, opts) => {
        const r = await dummy.fetchDailyBars(symbol, opts);
        return { ...r, bars: [...r.bars, { date: "2026-09-11", open: 101, high: 102, low: 100, close: 101.5, volume: 500_000 }] };
      },
    };
    const lines: string[] = [];
    const reports = await runDailyScreen(
      {
        prisma,
        provider: wrap,
        providerLabel: "yahoo",
        universes: { us: [entry("FRM")] },
        reportsDir: null,
        today: "2026-09-11",
        now: new Date("2026-09-11T15:03:00Z"), // 11:03 EDT — session in progress
        log: (l) => lines.push(l),
      },
      { market: "us" },
    );
    const r = reports[0]!;
    expect(r.inProgressBarsFiltered).toBe(1);
    expect(r.warnings.some((w) => w.includes("FRM: dropped in-progress bar(s)") && w.includes("2026-09-11"))).toBe(true);
    expect(lines.join("\n")).toContain("1 in-progress bars filtered");

    const instrument = await prisma.instrument.findUnique({ where: { symbol: "FRM" } });
    const stored = await prisma.bar.findMany({ where: { instrumentId: instrument!.id } });
    expect(stored.some((b) => b.date === "2026-09-11")).toBe(false);
    // The run's sessionDate is the newest COMPLETED bar — the forming session
    // stays unscreened, so the next guard run still sees it as due.
    const run = await prisma.screenRun.findFirst({ where: { market: "US" }, orderBy: { id: "desc" } });
    expect(run!.sessionDate).toBe("2024-12-31");
  });

  it("the same bar is stored once its session has closed", async () => {
    const dummy = new DummyMarketDataProvider();
    const wrap: MarketDataProvider = {
      fetchDailyBars: async (symbol, opts) => {
        const r = await dummy.fetchDailyBars(symbol, opts);
        return { ...r, bars: [...r.bars, { date: "2026-09-11", open: 101, high: 102, low: 100, close: 101.5, volume: 500_000 }] };
      },
    };
    const reports = await runDailyScreen(
      {
        prisma,
        provider: wrap,
        providerLabel: "yahoo",
        universes: { us: [entry("FRM2")] },
        reportsDir: null,
        today: "2026-09-11",
        now: new Date("2026-09-11T20:01:00Z"), // 16:01 EDT — closed
        log: silent,
      },
      { market: "us" },
    );
    expect(reports[0]!.inProgressBarsFiltered).toBe(0);
    const instrument = await prisma.instrument.findUnique({ where: { symbol: "FRM2" } });
    const stored = await prisma.bar.findMany({ where: { instrumentId: instrument!.id } });
    expect(stored.some((b) => b.date === "2026-09-11")).toBe(true);
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

describe("runDailyScreen — YAHOO_KNOWN_GAPS guard on the full-window rewrite", () => {
  // Regression for 2026-09-15: before the guard, every successful Yahoo fetch
  // rewrote the WHOLE bar series and silently undid the curated eastmoney
  // rescues — the 0941.HK 2024-01-15 phantom returned the day after its
  // 09-06 rescue, and the 2025-10-24 / 2026-03-06 rescues vanished with it.
  it("an eastmoney-rescued known-gap bar survives the rewrite; a fresh Yahoo bar on that date is dropped", async () => {
    const instrument = await prisma.instrument.upsert({
      where: { symbol: "2800.HK" },
      create: { symbol: "2800.HK", market: "HK", currency: "HKD", name: "2800.HK" },
      update: {},
    });
    // The curated rescue, as left by `repair:store --rescue 2025-10-24`.
    await prisma.bar.create({
      data: { instrumentId: instrument.id, date: "2025-10-24", open: 99.9, high: 100.1, low: 99.8, close: 99.99, volume: 123_000 },
    });
    const provider: MarketDataProvider = {
      fetchDailyBars: async () => ({
        httpStatus: 200,
        hasTimestamps: true,
        providerSaysNotFound: false,
        corporateActions: [],
        bars: [
          { date: "2025-10-22", open: 25.5, high: 25.6, low: 25.4, close: 25.55, volume: 4e8 },
          { date: "2025-10-23", open: 25.55, high: 25.7, low: 25.5, close: 25.6, volume: 4e8 },
          // Yahoo keeps serving its defective bar on the curated date:
          { date: "2025-10-24", open: 25.6, high: 25.6, low: 25.6, close: 25.6, volume: 0 },
          { date: "2025-10-27", open: 25.7, high: 25.8, low: 25.6, close: 25.75, volume: 4e8 },
        ],
      }),
    };
    const reports = await runDailyScreen(
      { prisma, provider, providerLabel: "yahoo", universes: { hk: [entry("2800.HK")] }, reportsDir: null, today: "2025-10-28", log: silent },
      { market: "hk" },
    );

    const stored = await prisma.bar.findMany({ where: { instrumentId: instrument.id }, orderBy: { date: "asc" } });
    expect(stored.map((b) => b.date)).toEqual(["2025-10-22", "2025-10-23", "2025-10-24", "2025-10-27"]);
    const gap = stored.find((b) => b.date === "2025-10-24")!;
    expect(gap.close).toBe(99.99); // the rescue, not Yahoo's 25.60 phantom
    expect(gap.volume).toBe(123_000);
    expect(
      reports[0]!.warnings.some((w) => w.includes("YAHOO_KNOWN_GAPS guard") && w.includes("preserved 1") && w.includes("dropped 1")),
    ).toBe(true);
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
