/**
 * Daily-screen CLI wiring tests: the fail-closed store guard (added after the
 * 2026-09-01 run-6 incident, where a dummy run rewrote the HK lane's real 5y
 * series with 30 synthetic bars per name and the header still looked healthy)
 * and the provenance label helper.
 */
import { describe, expect, it } from "vitest";
import { assertRealProviderStore, isDummyProviderLabel } from "../../src/cli/daily-screen.js";

describe("assertRealProviderStore — fail-closed dummy guard", () => {
  it("passes for the real provider", () => {
    expect(() => assertRealProviderStore(false, {})).not.toThrow();
  });

  it("refuses the dummy provider by default (synthetic full-window rewrite)", () => {
    expect(() => assertRealProviderStore(true, {})).toThrow(/refusing to run screen:daily with the dummy provider/);
  });

  it("refuses the dummy even under MARKET_DATA_TEST_MODE without the explicit flag", () => {
    expect(() => assertRealProviderStore(true, { MARKET_DATA_TEST_MODE: "1" })).toThrow(/SCREEN_ALLOW_DUMMY_STORE=1/);
  });

  it("allows the dummy only with SCREEN_ALLOW_DUMMY_STORE=1 set explicitly", () => {
    expect(() => assertRealProviderStore(true, { SCREEN_ALLOW_DUMMY_STORE: "1" })).not.toThrow();
    expect(() => assertRealProviderStore(true, { SCREEN_ALLOW_DUMMY_STORE: "0" })).toThrow();
  });
});

describe("isDummyProviderLabel", () => {
  it("matches the dummy class name and explicit labels, case-insensitively", () => {
    expect(isDummyProviderLabel("DummyMarketDataProvider")).toBe(true);
    expect(isDummyProviderLabel("dummy")).toBe(true);
    expect(isDummyProviderLabel("yahoo")).toBe(false);
    expect(isDummyProviderLabel("YahooMarketDataProvider")).toBe(false);
  });
});
