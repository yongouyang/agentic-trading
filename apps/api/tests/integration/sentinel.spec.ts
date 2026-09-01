/**
 * Weekly sentinel runner integration test (phase-1-hardening-plan §B.3) —
 * runSentinel() driven directly with fake sources against a throwaway SQLite
 * store. No network, no child processes. The Yahoo leg uses the dummy provider
 * (its synthetic series is deterministic, so "store == fresh" is a real
 * clean-run case, and a revision is a one-value mutation of the seed).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Bar } from "@agentic-trading/quant-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseSentinelArgs, runSentinel, type SentinelDeps } from "../../src/cli/sentinel.js";
import { DummyMarketDataProvider, syntheticBars } from "../../src/market-data/dummy-market-data.provider.js";
import type { RepairProvider } from "../../src/market-data/eastmoney-repair.provider.js";
import type { TencentDateSource } from "../../src/market-data/tencent.provider.js";
import { PrismaService } from "../../src/prisma.service.js";
import { SENTINEL_HK_SAMPLE } from "../../src/sentinel/sentinel-sample.js";
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

const silent = () => {};

async function seed(symbol: string, opts: { bars?: Bar[]; cas?: { date: string; amount: number }[]; dataSource?: string } = {}) {
  const instrument = await prisma.instrument.upsert({
    where: { symbol },
    create: { symbol, market: "HK", currency: "HKD", name: symbol, dataSource: opts.dataSource ?? "yahoo" },
    update: { market: "HK", currency: "HKD", name: symbol, dataSource: opts.dataSource ?? "yahoo" },
  });
  await prisma.bar.deleteMany({ where: { instrumentId: instrument.id } });
  await prisma.bar.createMany({
    data: (opts.bars ?? syntheticBars(symbol)).map((b) => ({
      instrumentId: instrument.id,
      date: b.date,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    })),
  });
  await prisma.corporateAction.deleteMany({ where: { instrumentId: instrument.id } });
  for (const ca of opts.cas ?? []) {
    await prisma.corporateAction.create({
      data: { instrumentId: instrument.id, date: ca.date, type: "DIVIDEND", amount: ca.amount, currency: "HKD" },
    });
  }
}

class FakeTencent implements TencentDateSource {
  readonly calls: string[] = [];
  constructor(private readonly result: (symbol: string) => { dates: string[] } | { failure: string }) {}
  async fetchSessionDates(symbol: string) {
    this.calls.push(symbol);
    return this.result(symbol);
  }
}

class FakeEastmoney implements RepairProvider {
  readonly calls: string[] = [];
  constructor(private readonly result: (symbol: string) => { bars: Bar[] } | { failure: string }) {}
  async fetchRawBars(symbol: string) {
    this.calls.push(symbol);
    return this.result(symbol);
  }
}

/** Dates of the dummy's synthetic series for a symbol (= what Yahoo "returns"). */
const yahooDates = (symbol: string) => syntheticBars(symbol).map((b) => b.date);

function deps(over: Partial<SentinelDeps> = {}): SentinelDeps {
  return {
    prisma,
    provider: new DummyMarketDataProvider(),
    tencent: new FakeTencent((s) => ({ dates: yahooDates(s) })),
    symbols: ["0700.HK"],
    today: "2026-09-04",
    log: silent,
    reportsDir: null,
    ...over,
  };
}

const checkOf = (report: Awaited<ReturnType<typeof runSentinel>>, symbol: string, name: string) =>
  report.rows.find((r) => r.symbol === symbol)!.checks.find((c) => c.check === name)!;

describe("runSentinel — clean run", () => {
  it("store matches every source ⇒ all ok, no alarm, eastmoney leg off by default", async () => {
    await seed("0700.HK");
    const tencent = new FakeTencent((s) => ({ dates: yahooDates(s) }));
    const eastmoney = new FakeEastmoney((s) => ({ bars: syntheticBars(s) }));
    const report = await runSentinel(deps({ tencent, symbols: ["0700.HK"] }), {});

    expect(report.date).toBe("2026-09-04");
    expect(report.alarm).toBe(false);
    expect(report.counts).toEqual({ ok: 1, warn: 0, alarm: 0, skip: 0 });
    expect(report.rows[0]!.verdict).toBe("ok");
    expect(checkOf(report, "0700.HK", "yahoo-rewrite").summary).toMatch(/^ok \d+d identical$/);
    expect(checkOf(report, "0700.HK", "ca-revision").status).toBe("ok");
    expect(tencent.calls).toEqual(["0700.HK"]);
    // The banned leg is opt-in: not called, and the table says why.
    expect(eastmoney.calls).toEqual([]);
    expect(checkOf(report, "0700.HK", "eastmoney-raw").status).toBe("skip");
    expect(report.text).toContain("skip disabled");
    expect(report.legs.eastmoney).toContain("disabled");
  });

  it("enabling the eastmoney leg compares raw closes and passes on identical bars", async () => {
    await seed("0005.HK");
    const eastmoney = new FakeEastmoney((s) => ({ bars: syntheticBars(s) }));
    const report = await runSentinel(deps({ symbols: ["0005.HK"], eastmoney }));
    const c = checkOf(report, "0005.HK", "eastmoney-raw");
    expect(eastmoney.calls).toEqual(["0005.HK"]);
    expect(c.status).toBe("warn"); // 30 common dates < MIN_COMMON_DATES ⇒ thin overlap
    expect(c.metrics).toMatchObject({ commonDates: 30, maxAbsDevPct: 0 });
  });
});

describe("runSentinel — detectors", () => {
  it("Yahoo rewrote one stored close ⇒ ALARM, exit-worthy, with the evidence line", async () => {
    const stored = syntheticBars("0005.HK").map((b, i) => (i === 10 ? { ...b, close: (b.close ?? 0) * 1.02 } : b));
    await seed("0005.HK", { bars: stored });
    const report = await runSentinel(deps({ symbols: ["0005.HK"] }));
    const c = checkOf(report, "0005.HK", "yahoo-rewrite");
    expect(report.alarm).toBe(true);
    expect(report.counts.alarm).toBe(1);
    expect(c.status).toBe("alarm");
    expect(c.metrics.closeMismatch).toBe(1);
    expect(report.text).toContain("exit: 1");
    expect(report.text).toContain("0005.HK [yahoo-rewrite] ALARM");
    expect(report.text).toContain("→ fresh"); // the per-date deviation is printed
  });

  it("eastmoney raw close 2% off the store ⇒ ALARM on that leg", async () => {
    await seed("0001.HK");
    const bars = syntheticBars("0001.HK").map((b, i) => (i === 5 ? { ...b, close: (b.close ?? 0) * 1.02 } : b));
    const report = await runSentinel(deps({ symbols: ["0001.HK"], eastmoney: new FakeEastmoney(() => ({ bars })) }));
    const c = checkOf(report, "0001.HK", "eastmoney-raw");
    expect(c.status).toBe("alarm");
    expect(c.metrics.maxAbsDevPct).toBeCloseTo(2, 1);
    expect(report.rows[0]!.verdict).toBe("alarm");
  });

  it("tencent calendar hole inside the overlap window ⇒ ALARM", async () => {
    await seed("0002.HK");
    // Holes at either EDGE are window edges (tencent's 1200-bar cap, or its
    // series simply ending earlier) and never alarm; a hole in the middle is a
    // real calendar disagreement.
    const tencent = new FakeTencent((s) => ({ dates: yahooDates(s).filter((_, i) => i < 10 || i > 12) }));
    const report = await runSentinel(deps({ symbols: ["0002.HK"], tencent }));
    const c = checkOf(report, "0002.HK", "tencent-dates");
    expect(c.status).toBe("alarm");
    expect(c.metrics.onlyReference).toBe(3);
    expect(report.rows[0]!.verdict).toBe("alarm");
    expect(report.alarm).toBe(true);
  });

  it("our series carries a session on an HKEX closure tencent lacks ⇒ WARN only", async () => {
    await seed("0003.HK");
    // The dummy's synthetic series is plain weekdays, so it (deliberately) has
    // bars on 2024-12-25/26 — real HKEX closures. tencent lacking them is the
    // correct calendar; the mismatch is our provider's phantom, not a revision.
    const tencent = new FakeTencent((s) => ({ dates: yahooDates(s).filter((d) => d !== "2024-12-26") }));
    const report = await runSentinel(deps({ symbols: ["0003.HK"], tencent }));
    const c = checkOf(report, "0003.HK", "tencent-dates");
    expect(c.status).toBe("warn");
    expect(c.metrics.ourPhantomSessions).toBe(1);
    expect(report.counts.warn).toBe(1);
    expect(report.alarm).toBe(false);
  });

  it("dividend event stored but no longer served ⇒ WARN, never ALARM", async () => {
    // Date inside the stored (dummy) bar window, so the bar-level overlap
    // window keeps it in scope for the comparison.
    await seed("0016.HK", { cas: [{ date: "2024-12-05", amount: 1.2 }] });
    const report = await runSentinel(deps({ symbols: ["0016.HK"] }));
    const c = checkOf(report, "0016.HK", "ca-revision");
    expect(c.status).toBe("warn");
    expect(c.metrics.onlyStored).toBe(1);
    expect(report.alarm).toBe(false);
  });

  it("stored dividends identical to the fresh event set ⇒ ok (window-wired case)", async () => {
    await seed("0941.HK", { cas: [{ date: "2024-12-05", amount: 1.15 }] });
    // A provider whose fresh events sit INSIDE the stored bar window, so the
    // bar-level overlap keeps them in scope (the dummy's event date does not).
    const provider = {
      fetchDailyBars: async () => ({
        httpStatus: 200,
        hasTimestamps: true,
        providerSaysNotFound: false,
        bars: syntheticBars("0941.HK"),
        corporateActions: [{ date: "2024-12-05", type: "DIVIDEND" as const, amount: 1.15, currency: "HKD" }],
      }),
    };
    const report = await runSentinel(deps({ symbols: ["0941.HK"], provider }));
    const c = checkOf(report, "0941.HK", "ca-revision");
    expect(c).toMatchObject({ status: "ok", metrics: { windowEvents: 1, freshEvents: 1 } });
    expect(report.alarm).toBe(false);
  });

  it("--symbol reaches the runner (custom sample flagged; only that name runs)", async () => {
    await seed("0700.HK");
    const args = parseSentinelArgs(["--", "--symbol", "0700.HK"]);
    expect(args.symbols).toEqual(["0700.HK"]);
    const report = await runSentinel(deps({ symbols: args.symbols }));
    expect(report.sample).toEqual(["0700.HK"]);
    expect(report.customSample).toBe(true);
    expect(report.text).toContain("CUSTOM --symbol override");
    expect(report.rows.map((r) => r.symbol)).toEqual(["0700.HK"]);
  });

  it("the pinned sample is not flagged as custom", async () => {
    for (const symbol of SENTINEL_HK_SAMPLE) await seed(symbol);
    const report = await runSentinel(deps({ symbols: undefined }));
    expect(report.customSample).toBe(false);
    expect(report.text).not.toContain("CUSTOM");
  });

  it("CA_DEGRADED name: Yahoo restates the FX-converted dividend amounts, so they are noted, not warned", async () => {
    await seed("9988.HK", { cas: [{ date: "2024-12-05", amount: 0.9800875 }] });
    await prisma.instrument.update({ where: { symbol: "9988.HK" }, data: { caDegraded: true } });
    const provider = {
      fetchDailyBars: async () => ({
        httpStatus: 200,
        hasTimestamps: true,
        providerSaysNotFound: false,
        bars: syntheticBars("9988.HK"),
        // Same event, different amount: Yahoo re-converts at a fresh FX rate
        // on every fetch (measured live 2026-09-02, three runs, three values).
        corporateActions: [{ date: "2024-12-05", type: "DIVIDEND" as const, amount: 0.980025, currency: "HKD" }],
      }),
    };
    const report = await runSentinel(deps({ symbols: ["9988.HK"], provider }));
    const c = checkOf(report, "9988.HK", "ca-revision");
    expect(c.status).toBe("ok");
    expect(c.metrics).toMatchObject({ restatedAmounts: 1, amountMismatch: 0 });
    expect(report.counts.warn).toBe(0);
    expect(report.alarm).toBe(false);
  });

  it("fresh Yahoo FETCH_FAILED ⇒ WARN on the rewrite leg, cross-source legs still run against the store", async () => {
    await seed("2318.HK");
    const tencent = new FakeTencent((s) => ({ dates: yahooDates(s) }));
    const report = await runSentinel(
      deps({ symbols: ["2318.HK"], provider: new DummyMarketDataProvider({ "2318.HK": "rate-limited" }), tencent }),
    );
    expect(checkOf(report, "2318.HK", "yahoo-rewrite").summary).toBe("WARN fetch-http-429");
    expect(checkOf(report, "2318.HK", "ca-revision").status).toBe("skip");
    expect(checkOf(report, "2318.HK", "tencent-dates").status).toBe("ok"); // stored series used as reference
    expect(tencent.calls).toEqual(["2318.HK"]);
    expect(report.rows[0]!.verdict).toBe("warn");
    expect(report.alarm).toBe(false);
  });

  it("fresh Yahoo GENUINELY_ABSENT on a pinned sample name ⇒ ALARM", async () => {
    await seed("2800.HK");
    const report = await runSentinel(deps({ symbols: ["2800.HK"], provider: new DummyMarketDataProvider({ "2800.HK": "not-found" }) }));
    expect(checkOf(report, "2800.HK", "yahoo-rewrite").summary).toBe("ALARM absent-now");
    expect(report.alarm).toBe(true);
  });

  it("store owned by eastmoney ⇒ rewrite check skipped, cross-source legs run", async () => {
    await seed("0941.HK", { dataSource: "eastmoney" });
    const report = await runSentinel(deps({ symbols: ["0941.HK"] }));
    const c = checkOf(report, "0941.HK", "yahoo-rewrite");
    expect(c.status).toBe("skip");
    expect(c.summary).toBe("skip store=eastmoney");
    expect(report.text).toContain("store=eastmoney");
    expect(checkOf(report, "0941.HK", "tencent-dates").status).toBe("ok");
  });

  it("symbol with no Instrument row ⇒ WARN and no wasted fetch", async () => {
    const provider = new DummyMarketDataProvider();
    const spy = vi.spyOn(provider, "fetchDailyBars");
    const report = await runSentinel(deps({ symbols: ["9999.HK"], provider }));
    expect(report.rows[0]!.verdict).toBe("warn");
    expect(report.rows[0]!.storedSource).toBeNull();
    expect(checkOf(report, "9999.HK", "yahoo-rewrite").summary).toBe("WARN not-in-store");
    expect(spy).not.toHaveBeenCalled();
  });

  it("empty store for an instrument ⇒ WARN empty-store", async () => {
    await seed("3195.HK", { bars: [] });
    const report = await runSentinel(deps({ symbols: ["3195.HK"] }));
    expect(checkOf(report, "3195.HK", "yahoo-rewrite").summary).toBe("WARN empty-store");
    expect(report.rows[0]!.verdict).toBe("warn");
  });

  it("tencent provider disabled ⇒ leg skipped loudly", async () => {
    await seed("0388.HK");
    const report = await runSentinel(deps({ symbols: ["0388.HK"], tencent: null }));
    const c = checkOf(report, "0388.HK", "tencent-dates");
    expect(c.status).toBe("skip");
    expect(c.details.join(" ")).toContain("tencent leg disabled");
  });

  it("tencent provider failure ⇒ skip with the provider reason (fragility is known)", async () => {
    await seed("1211.HK");
    const tencent = new FakeTencent(() => ({ failure: "http-200-empty-bars (keys=day/qt)" }));
    const report = await runSentinel(deps({ symbols: ["1211.HK"], tencent }));
    const c = checkOf(report, "1211.HK", "tencent-dates");
    expect(c.status).toBe("skip");
    expect(c.summary).toContain("http-200-empty-bars");
  });
});

describe("runSentinel — sample, artifact and table", () => {
  it("defaults to the pinned 10-name HK sample", async () => {
    for (const symbol of SENTINEL_HK_SAMPLE) await seed(symbol);
    const report = await runSentinel(deps({ symbols: undefined }));
    expect(report.sample).toEqual([...SENTINEL_HK_SAMPLE]);
    expect(report.rows.map((r) => r.symbol)).toEqual([...SENTINEL_HK_SAMPLE]);
    expect(report.counts.ok).toBe(10);
  });

  it("writes reports/sentinel-<date>.json (without the rendered text) and prints the table", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sentinel-reports-"));
    try {
      await seed("0005.HK");
      const lines: string[] = [];
      const report = await runSentinel(deps({ symbols: ["0005.HK"], reportsDir: dir, log: (l) => lines.push(l) }));
      const json = JSON.parse(readFileSync(path.join(dir, "sentinel-2026-09-04.json"), "utf8"));
      expect(json.date).toBe("2026-09-04");
      expect(json.sample).toEqual(["0005.HK"]);
      expect(json.text).toBeUndefined();
      expect(json.legs.yahoo).toContain("SYNTHETIC"); // a dummy run must never masquerade as a real check
      expect(json.legs.eastmoney).toContain("disabled");
      expect(json.rows[0].checks.map((c: { check: string }) => c.check)).toEqual([
        "yahoo-rewrite",
        "eastmoney-raw",
        "tencent-dates",
        "ca-revision",
      ]);
      expect(lines.join("\n")).toContain("== SENTINEL ==  2026-09-04 · sample 1 HK names");
      // The legs line names the provider, so a dummy run can read as what it is.
      expect(lines.join("\n")).toContain("legs: yahoo=fresh 5y (DummyMarketDataProvider ⚠ SYNTHETIC");
      expect(lines.join("\n")).toContain("tencent=enabled · eastmoney=disabled");
      expect(lines.join("\n")).toContain(report.rows[0]!.symbol);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
