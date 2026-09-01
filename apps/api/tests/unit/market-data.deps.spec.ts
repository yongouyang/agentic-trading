import { describe, expect, it } from "vitest";
import { getMarketDataDeps } from "../../src/market-data/market-data.deps.js";
import { DummyMarketDataProvider } from "../../src/market-data/dummy-market-data.provider.js";

describe("getMarketDataDeps — env selection, fail-closed", () => {
  it("defaults to the dummy provider (zero-network local dev)", () => {
    const deps = getMarketDataDeps({});
    expect(deps.provider).toBeInstanceOf(DummyMarketDataProvider);
    expect(deps.dummyMode).toBe(true);
    expect(deps.testMode).toBe(false);
  });

  it("MARKET_DATA_TEST_MODE=1 enables test injection (dummy only)", () => {
    expect(getMarketDataDeps({ MARKET_DATA_TEST_MODE: "1" }).testMode).toBe(true);
  });

  it("refuses the dummy with NODE_ENV=production (fail-closed)", () => {
    expect(() => getMarketDataDeps({ NODE_ENV: "production" })).toThrow(/refusing dummy provider/);
  });

  it("refuses a leaked MARKET_DATA_TEST_MODE with NODE_ENV=production", () => {
    expect(() =>
      getMarketDataDeps({ NODE_ENV: "production", MARKET_DATA_PROVIDER: "yahoo", MARKET_DATA_TEST_MODE: "1" }),
    ).toThrow(/refusing MARKET_DATA_TEST_MODE=1/);
  });

  it("MARKET_DATA_ALLOW_DUMMY=1 is the explicit production opt-in", () => {
    const deps = getMarketDataDeps({ NODE_ENV: "production", MARKET_DATA_ALLOW_DUMMY: "1" });
    expect(deps.dummyMode).toBe(true);
  });

  it("yahoo is declared but deferred to Phase 1", () => {
    expect(() => getMarketDataDeps({ MARKET_DATA_PROVIDER: "yahoo" })).toThrow(/not implemented yet/);
  });

  it("unknown provider names are rejected loudly", () => {
    expect(() => getMarketDataDeps({ MARKET_DATA_PROVIDER: "bloomberg" })).toThrow(/must be "dummy" or "yahoo"/);
  });
});
