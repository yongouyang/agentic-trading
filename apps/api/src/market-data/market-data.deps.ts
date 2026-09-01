/**
 * Dependency wiring for market data (controllable-dummy pattern, mirroring
 * the reference project's deps.ts). Selection is env-driven:
 *   MARKET_DATA_PROVIDER = "yahoo" | "dummy"
 * Default: the real Yahoo provider; the dummy is selected explicitly
 * (MARKET_DATA_PROVIDER=dummy) or implicitly under MARKET_DATA_TEST_MODE=1,
 * so local dev, tests, and e2e can run with zero network.
 * Fail-closed: dummy wiring AND a set MARKET_DATA_TEST_MODE are refused when
 * NODE_ENV=production unless MARKET_DATA_ALLOW_DUMMY=1 is set explicitly.
 */
import { DummyMarketDataProvider } from "./dummy-market-data.provider.js";
import { YahooMarketDataProvider } from "./yahoo-market-data.provider.js";
import type { MarketDataProvider } from "./market-data.types.js";

export const MARKET_DATA_DEPS = "MARKET_DATA_DEPS";

export interface MarketDataDeps {
  provider: MarketDataProvider;
  /** MARKET_DATA_TEST_MODE=1 — enables x-test-market-behavior header injection. */
  testMode: boolean;
  /** True only with the dummy provider — the ONLY wiring under which the
   *  behavior injection may be honored (never a real provider). */
  dummyMode: boolean;
}

export function getMarketDataDeps(env: Record<string, string | undefined> = process.env): MarketDataDeps {
  const kind = env.MARKET_DATA_PROVIDER ?? (env.MARKET_DATA_TEST_MODE === "1" ? "dummy" : "yahoo");

  if (env.NODE_ENV === "production" && env.MARKET_DATA_ALLOW_DUMMY !== "1") {
    if (kind === "dummy") {
      throw new Error(
        "[market-data] refusing dummy provider with NODE_ENV=production — set MARKET_DATA_ALLOW_DUMMY=1 explicitly only for non-production testing",
      );
    }
    if (env.MARKET_DATA_TEST_MODE === "1") {
      throw new Error(
        "[market-data] refusing MARKET_DATA_TEST_MODE=1 with NODE_ENV=production — test-mode env must not leak into production",
      );
    }
  }

  if (kind === "dummy") {
    return {
      provider: new DummyMarketDataProvider(),
      testMode: env.MARKET_DATA_TEST_MODE === "1",
      dummyMode: true,
    };
  }
  if (kind === "yahoo") {
    return {
      provider: new YahooMarketDataProvider(),
      testMode: env.MARKET_DATA_TEST_MODE === "1",
      dummyMode: false,
    };
  }
  throw new Error(`[market-data] MARKET_DATA_PROVIDER must be "dummy" or "yahoo" (got "${kind}")`);
}
