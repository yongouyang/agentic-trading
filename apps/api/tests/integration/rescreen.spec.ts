/**
 * `screen:rescreen` against a throwaway SQLite db: PIT correctness (a dividend
 * with ex-date > T and a bar after T must not leak into the recompute), the
 * persisted row shape (source "rescreen", census, production topN truncation),
 * and the duplicate refusal against real rows.
 *
 * The slice invariants themselves are quant-core's (replay equivalence tests);
 * here the assertions are that the CLI wires to them and that the persisted
 * rows match production's shape.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCREEN_PARAMS, replayScreen, type Bar, type SymbolSeries } from "@agentic-trading/quant-core";
import { enumerateHoles, rescreenSession } from "../../src/cli/rescreen.js";
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

/** 2026-09-16 20:00 HKT: every session through 09-16 has closed in both lanes. */
const NOW = new Date("2026-09-16T20:00:00+08:00");
const T = "2026-09-15";
const FUTURE = "2026-09-16";

function weekdayDates(end: string, count: number): string[] {
  const dates: string[] = [];
  const d = new Date(`${end}T00:00:00Z`);
  while (dates.length < count) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) dates.unshift(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return dates;
}

/** Trending series (drift + tiny alternating wobble — zero-variance series get
 *  sharpe=null by design) that clears every §4 gate for the market's adv floor. */
function trendingBars(symbolIndex: number, dates: string[], volume: number): Bar[] {
  const drift = 0.0008 + symbolIndex * 0.0004;
  let prev = 100;
  return dates.map((date, i) => {
    const close = prev * (1 + drift + (i % 2 === 0 ? 0.0005 : -0.0005));
    const bar: Bar = { date, open: prev, high: Math.max(prev, close) * 1.001, low: Math.min(prev, close) * 0.999, close, volume };
    prev = close;
    return bar;
  });
}

async function seedSymbol(market: "HK" | "US", symbol: string, bars: Bar[], dividends: { date: string; amount: number }[] = []) {
  const inst = await prisma.instrument.create({
    data: { symbol, market, currency: market === "HK" ? "HKD" : "USD" },
  });
  await prisma.bar.createMany({ data: bars.map((b) => ({ instrumentId: inst.id, ...b })) });
  for (const d of dividends) {
    await prisma.corporateAction.create({
      data: { instrumentId: inst.id, date: d.date, type: "DIVIDEND", amount: d.amount, currency: "HKD" },
    });
  }
  return inst;
}

function seriesOf(barsBySymbol: Map<string, Bar[]>, divsBySymbol: Map<string, { date: string; amount: number }[]>, market: "HK" | "US"): SymbolSeries[] {
  return [...barsBySymbol.entries()].map(([symbol, bars]) => ({
    symbol,
    market,
    caDegraded: false,
    bars,
    dividends: (divsBySymbol.get(symbol) ?? []).map((d) => ({ date: d.date, type: "DIVIDEND" as const, amount: d.amount, currency: "HKD" })),
  }));
}

describe("rescreenSession — PIT correctness against a store that holds the future", () => {
  const dates = weekdayDates(FUTURE, 280); // ends on FUTURE (09-16); T is one session earlier
  const hkBars = new Map<string, Bar[]>();
  const hkDivs = new Map<string, { date: string; amount: number }[]>();

  it("a dividend with ex-date > T and a bar after T do not affect the result", async () => {
    const symbols = ["AAA.HK", "BBB.HK", "CCC.HK"];
    symbols.forEach((s, i) => hkBars.set(s, trendingBars(i, dates, 2_000_000)));
    hkBars.set("SHORT.HK", trendingBars(9, dates.slice(-100), 2_000_000)); // too little history — exercises the census
    // The poison, sitting in the store before the rescreen: a bar AND a
    // dividend (AAA.HK) dated after T.
    hkDivs.set("AAA.HK", [{ date: FUTURE, amount: 5 }]);
    for (const s of [...symbols, "SHORT.HK"]) await seedSymbol("HK", s, hkBars.get(s)!, hkDivs.get(s));

    const r = await rescreenSession(prisma, "HK", T, NOW);
    expect(r.date).toBe(T);
    expect(r.persisted).toBe(3);
    expect(r.excludedTotal).toBe(1); // SHORT.HK: INSUFFICIENT_HISTORY

    // The PIT expectation: replay over history as of T — no 09-16 bar, no 09-16
    // dividend. The CLI must reproduce it exactly.
    const pitSeries = seriesOf(
      new Map([...symbols, "SHORT.HK"].map((s) => [s, hkBars.get(s)!.filter((b) => b.date <= T)])),
      new Map(), // the only dividend has ex-date > T
      "HK",
    );
    const expected = replayScreen([T], pitSeries)[0]!;

    const run = await prisma.screenRun.findUniqueOrThrow({ where: { id: r.runId } });
    const rows = await prisma.screenResult.findMany({ where: { runId: run.id }, orderBy: { rank: "asc" } });
    expect(rows.map((x) => [x.symbol, x.rank])).toEqual(expected.ranked.map((p) => [p.symbol, p.rank]));
    for (const [i, row] of rows.entries()) {
      expect(row.score).toBeCloseTo(expected.ranked[i]!.score, 12);
      expect(JSON.parse(row.metricsJson).close).toBeCloseTo(expected.ranked[i]!.close, 12);
    }
    expect(JSON.parse(run.excludedJson)).toEqual(expected.excludedByReason.HK);

    // Sensitivity: the assertion above is meaningful only if the future data
    // WOULD have changed the answer. Replaying at the future session (09-16 bar
    // included, its dividend now in force) moves every ranked metric — so a
    // leak could not have passed silently.
    const futureDay = replayScreen([FUTURE], seriesOf(hkBars, hkDivs, "HK"))[0]!;
    const aaaFuture = futureDay.ranked.find((p) => p.symbol === "AAA.HK")!;
    const aaaPersisted = rows.find((x) => x.symbol === "AAA.HK")!;
    expect(aaaFuture.close).not.toBeCloseTo(JSON.parse(aaaPersisted.metricsJson).close, 6);

    // And a leaked future bar would move the screened session itself.
    expect(run.sessionDate).toBe(T);
  });

  it("persists the production row shape: source, counters, census, metrics keys", async () => {
    const run = await prisma.screenRun.findFirstOrThrow({ where: { market: "HK", sessionDate: T } });
    expect(run).toMatchObject({
      source: "rescreen",
      sessionDate: T,
      universeSize: 4,
      ok: 4, // unknowable for a historical session — set to universeSize
      genuinelyAbsent: 0,
      fetchFailed: 0,
      degraded: false,
    });
    const warnings = JSON.parse(run.warningsJson) as string[];
    expect(warnings.some((w) => /integrity counters unknowable for a historical session/.test(w))).toBe(true);
    expect(JSON.parse(run.excludedJson)).toEqual({ INSUFFICIENT_HISTORY: 1 });

    const rows = await prisma.screenResult.findMany({ where: { runId: run.id } });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.keys(JSON.parse(row.metricsJson)).sort()).toEqual(
        ["adv20", "caDegraded", "close", "mdd252", "mom20", "mom60", "sharpe252", "sma200", "sma50", "vol60"].sort(),
      );
    }
  });

  it("refuses a duplicate (a ScreenRun already covers T for the lane)", async () => {
    await expect(rescreenSession(prisma, "HK", T, NOW)).rejects.toThrow(/already covers this session/);
    expect(await prisma.screenRun.count({ where: { market: "HK", sessionDate: T } })).toBe(1);
  });

  it("enumerateHoles on real rows: the other post-cutoff sessions are holes", async () => {
    // Store sessions >= PROSPECTIVE_FROM for HK: 09-14, 09-15 (rescreened),
    // 09-16 — all closed at NOW.
    expect(await enumerateHoles(prisma, "HK", NOW)).toEqual(["2026-09-14", "2026-09-16"]);
  });
});

describe("rescreenSession — production topN is re-applied (replayScreen lifts it)", () => {
  it("45 eligible US names persist exactly topN rows, ranks 1..N", async () => {
    const dates = weekdayDates(FUTURE, 280);
    const symbols = Array.from({ length: 45 }, (_, i) => `US${String(i).padStart(2, "0")}`);
    for (const [i, s] of symbols.entries()) await seedSymbol("US", s, trendingBars(i % 9, dates, 1_000_000));

    const r = await rescreenSession(prisma, "US", T, NOW);
    expect(r.persisted).toBe(SCREEN_PARAMS.topN.US); // 40, not the full 45

    const rows = await prisma.screenResult.findMany({ where: { runId: r.runId }, orderBy: { rank: "asc" } });
    expect(rows.map((x) => x.rank)).toEqual(Array.from({ length: SCREEN_PARAMS.topN.US }, (_, i) => i + 1));

    // The persisted rows are the head of the FULL eligible ranking, unchanged.
    const fullSeries = seriesOf(new Map(symbols.map((s, i) => [s, trendingBars(i % 9, dates, 1_000_000).filter((b) => b.date <= T)])), new Map(), "US");
    const expected = replayScreen([T], fullSeries)[0]!.ranked.slice(0, SCREEN_PARAMS.topN.US);
    expect(rows.map((x) => x.symbol)).toEqual(expected.map((p) => p.symbol));
    for (const [i, row] of rows.entries()) expect(row.score).toBeCloseTo(expected[i]!.score, 12);
  });
});
