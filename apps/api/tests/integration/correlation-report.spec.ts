/**
 * correlation-report against a seeded throwaway SQLite db (same harness as
 * daily-screen.spec.ts): known-answer checks on synthetic trending names —
 * an identical twin must correlate at 1, the report must cover all three
 * blocks the charter asked for, and the artifact must carry the full matrix.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Bar } from "@agentic-trading/quant-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { interLaneCorrelation, runCorrelationReport } from "../../src/cli/correlation-report.js";
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

/** 300 weekday bars ending 2026-09-01, steady uptrend with a deterministic
 *  wobble — passes every gate (adv ≥ both floors at close≈100, vol 1e6). */
function trendBars(seed: number): Bar[] {
  const dates: string[] = [];
  const d = new Date("2026-09-01T00:00:00Z");
  while (dates.length < 300) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) dates.unshift(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  let prev = 100;
  return dates.map((date, i) => {
    const close = prev * (1 + 0.0008 + Math.sin(i * 0.7 + seed) * 0.001);
    const bar: Bar = { date, open: prev, high: Math.max(prev, close) * 1.001, low: Math.min(prev, close) * 0.999, close, volume: 1_000_000 };
    prev = close;
    return bar;
  });
}

async function seed(symbol: string, market: string, bars: Bar[]): Promise<void> {
  const inst = await prisma.instrument.upsert({
    where: { symbol },
    create: { symbol, market, currency: market === "HK" ? "HKD" : "USD", name: symbol },
    update: {},
  });
  await prisma.bar.createMany({
    data: bars.map((b) => ({ instrumentId: inst.id, date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })),
  });
}

describe("runCorrelationReport", () => {
  it("covers inter-factor, inter-name and inter-lane; an identical twin correlates at 1; artifact carries the matrix", async () => {
    const twin = trendBars(1);
    await seed("AAA", "US", twin);
    await seed("BBB", "US", twin); // identical twin → ρ = 1
    await seed("CCC", "US", trendBars(9)); // independent
    await seed("0700.HK", "HK", trendBars(2));
    await seed("9988.HK", "HK", trendBars(5));

    const dir = mkdtempSync(path.join(tmpdir(), "corr-reports-"));
    const lines: string[] = [];
    try {
      const report = await runCorrelationReport({ prisma, reportsDir: dir, today: "2026-09-01", log: (l) => lines.push(l) });

      expect(report.lanes).toHaveLength(2);
      const us = report.lanes.find((l) => l.market === "US")!;
      expect(us.sessionDate).toBe("2026-09-01");
      expect(us.eligibleCount).toBe(3);
      expect(us.interFactor).toHaveLength(3);
      expect(us.interFactor.map((f) => f.pair)).toEqual(["mom20~mom60", "mom20~sharpe252", "mom60~sharpe252"]);

      // The twin pair is the max, at ρ = 1.
      expect(us.breadth.max).toBeCloseTo(1, 10);
      expect(us.breadth.maxPair).toEqual(["AAA", "BBB"]);
      expect(us.breadth.unmeasurable).toBe(0);

      // Both lanes share all 300 weekday dates → inter-lane is measurable.
      expect(report.interLane.commonDates).toBe(60);
      expect(report.interLane.rho).not.toBeNull();

      // Stdout covers the three blocks; the artifact carries the full matrix.
      const out = lines.join("\n");
      expect(out).toContain("inter-factor:");
      expect(out).toContain("inter-name breadth");
      expect(out).toContain("inter-name display");
      expect(out).toContain("inter-lane");
      const artifact = JSON.parse(readFileSync(path.join(dir, "correlation-2026-09-01.json"), "utf8"));
      expect(artifact.lanes[0].matrix.symbols).toEqual(us.matrix.symbols);
      expect(artifact.interLane.commonDates).toBe(60);

      // Read-only: no ScreenRun/ScreenResult written.
      expect(await prisma.screenRun.count()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("interLaneCorrelation is null below the overlap floor", () => {
    const lane = (rets: Record<string, number>) =>
      ({ market: "US", eligibleMeanReturns: rets }) as never;
    const a = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`2026-08-${String(i + 1).padStart(2, "0")}`, 0.001 * i]));
    const r = interLaneCorrelation([lane(a), lane(a)]);
    expect(r.rho).toBeNull();
    expect(r.commonDates).toBe(10);
  });
});
