/**
 * Pure-function tests for the repair-store-bars sanity gate
 * (src/cli/repair-store-bars.ts): a fresh fetch that still contains the
 * pathology being repaired (phantom half-price bars ⇒ ~2× overnight jump)
 * must fail the gate so the CLI aborts WITHOUT touching the store; a
 * smooth series with all required dates present passes. No db, no network.
 *
 * rescueSessions (§A session rescue) is covered with an injected fake
 * RepairProvider and a mock prisma (plain objects cast to the real types —
 * no ORM, no db): the fail-closed gates (fetch failure / missing date /
 * level break) must produce problems and ZERO writes; the happy path upserts
 * only the requested dates.
 */
import type { Bar } from "@agentic-trading/quant-core";
import { describe, expect, it } from "vitest";
import type { RepairProvider } from "../../src/market-data/eastmoney-repair.provider.js";
import type { PrismaService } from "../../src/prisma.service.js";
import { checkFetchedSeries, rescueSessions } from "../../src/cli/repair-store-bars.js";

const bar = (date: string, price: number) => ({ date, open: price, high: price, low: price, close: price, volume: 1000 });

describe("checkFetchedSeries", () => {
  it("passes a smooth series with required dates present", () => {
    const bars = [bar("2026-08-06", 47), bar("2026-08-07", 46), bar("2026-08-10", 45.5)];
    expect(checkFetchedSeries(bars, { requiredDates: ["2026-08-10"] }).ok).toBe(true);
  });

  it("fails on a phantom-bar-scale overnight jump (MNST 07-17→07-20 pattern)", () => {
    // 97.5 close → 48.6 open = 0.499× — the phantom half-price signature.
    const bars = [bar("2026-07-17", 97.5), bar("2026-07-20", 48.6)];
    const check = checkFetchedSeries(bars);
    expect(check.ok).toBe(false);
    expect(check.problems[0]).toMatch(/overnight jump/);
  });

  it("fails when a required date is missing or null-close", () => {
    const bars = [bar("2026-08-07", 46), { date: "2026-08-10", open: null, high: null, low: null, close: null, volume: null }];
    const check = checkFetchedSeries(bars, { requiredDates: ["2026-08-10"] });
    expect(check.ok).toBe(false);
    expect(check.problems[0]).toMatch(/2026-08-10/);
  });

  it("ignores null bars when evaluating jumps", () => {
    const bars = [bar("2026-08-07", 46), { date: "2026-08-08", open: null, high: null, low: null, close: null, volume: null }, bar("2026-08-10", 45.5)];
    expect(checkFetchedSeries(bars).ok).toBe(true);
  });
});

/** Mock prisma: one Instrument row, one stored prior close, upsert spy. */
function mockPrisma(priorClose: number | null) {
  const upserts: { date: string; close: number | null }[] = [];
  const prisma = {
    instrument: { findUnique: async () => ({ id: 7, symbol: "3195.HK" }) },
    bar: {
      findFirst: async () => (priorClose == null ? null : { date: "2025-10-23", close: priorClose }),
      upsert: async (args: { create: { date: string; close: number | null } }) => {
        upserts.push(args.create);
        return args.create;
      },
    },
  } as unknown as PrismaService;
  return { prisma, upserts };
}

const fakeProvider = (res: { bars: Bar[] } | { failure: string }): RepairProvider => ({ fetchRawBars: async () => res });

describe("rescueSessions — §A session rescue, fail-closed all-or-nothing", () => {
  const emBar = (date: string, close: number): Bar => ({ date, open: close, high: close, low: close, close, volume: 1e6 });

  it("happy path: upserts only the requested dates, no problems", async () => {
    const { prisma, upserts } = mockPrisma(10.2);
    const provider = fakeProvider({ bars: [emBar("2025-10-23", 10.2), emBar("2025-10-24", 10.25), emBar("2026-03-06", 10.4)] });
    const report = await rescueSessions({ prisma, repairProvider: provider }, "3195.HK", ["2025-10-24", "2026-03-06"]);
    expect(report.problems).toEqual([]);
    expect(report.rescued).toEqual(["2025-10-24", "2026-03-06"]);
    expect(upserts.map((u) => u.date)).toEqual(["2025-10-24", "2026-03-06"]);
  });

  it("eastmoney fetch failure ⇒ problems, zero writes", async () => {
    const { prisma, upserts } = mockPrisma(10.2);
    const report = await rescueSessions({ prisma, repairProvider: fakeProvider({ failure: "timeout" }) }, "3195.HK", ["2025-10-24"]);
    expect(report.problems[0]).toMatch(/eastmoney fetch failed: timeout/);
    expect(report.rescued).toEqual([]);
    expect(upserts).toEqual([]);
  });

  it("requested date missing (or null-OHLC) in the eastmoney series ⇒ problems, zero writes", async () => {
    const { prisma, upserts } = mockPrisma(10.2);
    const provider = fakeProvider({ bars: [emBar("2025-10-23", 10.2), { ...emBar("2025-10-24", 10.25), close: null }] });
    const report = await rescueSessions({ prisma, repairProvider: provider }, "3195.HK", ["2025-10-24", "2026-03-06"]);
    expect(report.problems).toHaveLength(2);
    expect(report.problems.join(" ")).toMatch(/2025-10-24 missing or null-OHLC/);
    expect(report.problems.join(" ")).toMatch(/2026-03-06 missing or null-OHLC/);
    expect(upserts).toEqual([]);
  });

  it("level break >10% vs the stored prior close (USD-stitching class) ⇒ problems, zero writes", async () => {
    const { prisma, upserts } = mockPrisma(10.2);
    const provider = fakeProvider({ bars: [emBar("2025-10-24", 1.31)] }); // ~87% below the store — stitched
    const report = await rescueSessions({ prisma, repairProvider: provider }, "3195.HK", ["2025-10-24"]);
    expect(report.problems[0]).toMatch(/level break vs store: 2025-10-24/);
    expect(upserts).toEqual([]);
  });

  it("within the 10% gate passes (cross-source noise, not a level break)", async () => {
    const { prisma, upserts } = mockPrisma(10.2);
    const provider = fakeProvider({ bars: [emBar("2025-10-24", 10.2 * 1.05)] });
    const report = await rescueSessions({ prisma, repairProvider: provider }, "3195.HK", ["2025-10-24"]);
    expect(report.problems).toEqual([]);
    expect(upserts).toHaveLength(1);
  });

  it("no stored bar before the rescue date ⇒ cannot gate ⇒ problems, zero writes", async () => {
    const { prisma, upserts } = mockPrisma(null);
    const provider = fakeProvider({ bars: [emBar("2025-10-24", 10.25)] });
    const report = await rescueSessions({ prisma, repairProvider: provider }, "3195.HK", ["2025-10-24"]);
    expect(report.problems[0]).toMatch(/no usable stored close before 2025-10-24/);
    expect(upserts).toEqual([]);
  });
});
