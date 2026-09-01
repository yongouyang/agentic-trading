import { describe, expect, it } from "vitest";
import { getMarketDataDeps } from "../../src/market-data/market-data.deps.js";
import { DummyMarketDataProvider } from "../../src/market-data/dummy-market-data.provider.js";
import { YahooMarketDataProvider } from "../../src/market-data/yahoo-market-data.provider.js";

describe("getMarketDataDeps — env selection, fail-closed", () => {
  it("defaults to the real Yahoo provider", () => {
    const deps = getMarketDataDeps({});
    expect(deps.provider).toBeInstanceOf(YahooMarketDataProvider);
    expect(deps.dummyMode).toBe(false);
    expect(deps.testMode).toBe(false);
  });

  it("MARKET_DATA_TEST_MODE=1 selects the dummy and enables test injection", () => {
    const deps = getMarketDataDeps({ MARKET_DATA_TEST_MODE: "1" });
    expect(deps.provider).toBeInstanceOf(DummyMarketDataProvider);
    expect(deps.dummyMode).toBe(true);
    expect(deps.testMode).toBe(true);
  });

  it("MARKET_DATA_PROVIDER=dummy selects the dummy explicitly (zero-network local dev)", () => {
    const deps = getMarketDataDeps({ MARKET_DATA_PROVIDER: "dummy" });
    expect(deps.provider).toBeInstanceOf(DummyMarketDataProvider);
    expect(deps.dummyMode).toBe(true);
  });

  it("refuses the dummy with NODE_ENV=production (fail-closed)", () => {
    expect(() => getMarketDataDeps({ NODE_ENV: "production", MARKET_DATA_PROVIDER: "dummy" })).toThrow(
      /refusing dummy provider/,
    );
    // MARKET_DATA_TEST_MODE=1 implies the dummy, which is refused first.
    expect(() => getMarketDataDeps({ NODE_ENV: "production", MARKET_DATA_TEST_MODE: "1" })).toThrow(
      /refusing dummy provider/,
    );
    expect(() =>
      getMarketDataDeps({ NODE_ENV: "production", MARKET_DATA_PROVIDER: "yahoo", MARKET_DATA_TEST_MODE: "1" }),
    ).toThrow(/refusing MARKET_DATA_TEST_MODE=1/);
  });

  it("production defaults to the real Yahoo provider", () => {
    const deps = getMarketDataDeps({ NODE_ENV: "production" });
    expect(deps.provider).toBeInstanceOf(YahooMarketDataProvider);
    expect(deps.dummyMode).toBe(false);
  });

  it("MARKET_DATA_ALLOW_DUMMY=1 is the explicit production opt-in", () => {
    const deps = getMarketDataDeps({ NODE_ENV: "production", MARKET_DATA_ALLOW_DUMMY: "1", MARKET_DATA_PROVIDER: "dummy" });
    expect(deps.dummyMode).toBe(true);
  });

  it("unknown provider names are rejected loudly", () => {
    expect(() => getMarketDataDeps({ MARKET_DATA_PROVIDER: "bloomberg" })).toThrow(/must be "dummy" or "yahoo"/);
  });
});
