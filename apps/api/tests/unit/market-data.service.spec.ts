import { DataOutcome } from "@agentic-trading/quant-core";
import { describe, expect, it } from "vitest";
import { DummyMarketDataProvider, PHANTOM_BAR_DATE } from "../../src/market-data/dummy-market-data.provider.js";
import type { MarketDataDeps } from "../../src/market-data/market-data.deps.js";
import { MarketDataService } from "../../src/market-data/market-data.service.js";
import type { DummyBehavior } from "../../src/market-data/market-data.types.js";

function serviceWith(behaviors: Record<string, DummyBehavior>): MarketDataService {
  const deps: MarketDataDeps = { provider: new DummyMarketDataProvider(behaviors), testMode: false, dummyMode: true };
  return new MarketDataService(deps);
}

describe("MarketDataService — measured failure taxonomy (verification report G5 / L1–L4)", () => {
  it("ok: deterministic synthetic bars typed OK", async () => {
    const service = serviceWith({});
    const a = await service.getDailyBars("0005.HK");
    const b = await service.getDailyBars("0005.HK");
    expect(a.outcome).toBe(DataOutcome.OK);
    expect(a.bars.length).toBeGreaterThan(0);
    expect(a).toEqual(b); // deterministic — no clocks, no randomness
  });

  it.each([
    ["rate-limited", "http-429"],
    ["timeout", "timeout"],
    ["empty-bars", "http-200-empty-bars"],
    ["zombie-meta", "http-200-zombie-meta"],
  ] as const)("%s → FETCH_FAILED (%s)", async (behavior, reason) => {
    const service = serviceWith({ "0005.HK": behavior });
    const result = await service.getDailyBars("0005.HK");
    expect(result.outcome).toBe(DataOutcome.FETCH_FAILED);
    expect(result.failureReason).toBe(reason);
    expect(result.bars).toEqual([]);
  });

  it("not-found → GENUINELY_ABSENT (source-scoped, never FETCH_FAILED)", async () => {
    const service = serviceWith({ NOSUCHTICKER: "not-found" });
    const result = await service.getDailyBars("NOSUCHTICKER");
    expect(result.outcome).toBe(DataOutcome.GENUINELY_ABSENT);
    expect(result.bars).toEqual([]);
  });

  it("fx-inconsistent-dividends: USD-declared dividend on an HK name → caDegraded (9988.HK case)", async () => {
    const service = serviceWith({ "9988.HK": "fx-inconsistent-dividends" });
    const result = await service.getDailyBars("9988.HK");
    expect(result.outcome).toBe(DataOutcome.OK);
    expect(result.caDegraded).toBe(true);
    expect(result.corporateActions[0]).toMatchObject({ type: "DIVIDEND", currency: "USD" });
  });

  it("fx-inconsistent-dividends: non-HK names are not flagged", async () => {
    const service = serviceWith({ AAPL: "fx-inconsistent-dividends" });
    const result = await service.getDailyBars("AAPL");
    expect(result.caDegraded).toBe(false);
  });

  it("holiday-phantom: HKEX-holiday zero-volume bar dropped (RULE L1), genuine bars kept", async () => {
    const service = serviceWith({ "0700.HK": "holiday-phantom" });
    const result = await service.getDailyBars("0700.HK");
    expect(result.outcome).toBe(DataOutcome.OK);
    expect(result.droppedPhantomBars).toEqual([PHANTOM_BAR_DATE]);
    expect(result.bars.some((b) => b.date === PHANTOM_BAR_DATE)).toBe(false);
    expect(result.bars.length).toBeGreaterThan(0);
  });

  it("close-outside-hl: close clamped into [H,L] and reported loudly (RULE L2)", async () => {
    const service = serviceWith({ "CSPX.L": "close-outside-hl" });
    const result = await service.getDailyBars("CSPX.L");
    expect(result.outcome).toBe(DataOutcome.OK);
    expect(result.repairedBars).toHaveLength(1);
    const repaired = result.bars.find((b) => b.date === result.repairedBars[0])!;
    expect(repaired.close!).toBeLessThanOrEqual(repaired.high!);
    expect(repaired.close!).toBeGreaterThanOrEqual(repaired.low!);
  });
});
