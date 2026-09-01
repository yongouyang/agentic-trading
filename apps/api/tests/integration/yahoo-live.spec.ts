/**
 * Live-Yahoo smoke test (phase-1-spec §6) — gated behind YAHOO_LIVE_TEST=1,
 * NEVER runs by default / in CI. Fetches 5y of 0005.HK and AAPL through the
 * real provider (real 200ms spacing) and checks the raw response shape only.
 */
import { classifyResponse, DataOutcome } from "@agentic-trading/quant-core";
import { describe, expect, it } from "vitest";
import { YahooMarketDataProvider } from "../../src/market-data/yahoo-market-data.provider.js";

describe.skipIf(process.env.YAHOO_LIVE_TEST !== "1")("Yahoo live smoke (YAHOO_LIVE_TEST=1 only)", () => {
  it("fetches 5y of 0005.HK and AAPL", async () => {
    const provider = new YahooMarketDataProvider();
    for (const symbol of ["0005.HK", "AAPL"]) {
      const r = await provider.fetchDailyBars(symbol);
      const outcome = classifyResponse({
        httpStatus: r.httpStatus,
        hasTimestamps: r.hasTimestamps,
        barCount: r.bars.length,
        providerSaysNotFound: r.providerSaysNotFound,
      });
      expect(outcome, `${symbol}: ${r.failureReason ?? ""}`).toBe(DataOutcome.OK);
      expect(r.bars.length).toBeGreaterThan(1000); // ~5y of sessions
      expect(r.bars[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  }, 120_000);
});
