/**
 * Dummy market-data provider (controllable-dummy pattern): deterministic,
 * zero-network, controllable. Used for local development, unit/integration
 * tests, and e2e — never a real data source.
 *
 * Default: 30 deterministic synthetic weekday sessions ending 2024-12-31
 * (seeded from the symbol — no clocks, no randomness at call time).
 * Per-symbol behavior injection covers the measured failure taxonomy
 * (see DummyBehavior in market-data.types.ts). Injection paths:
 *  - constructor map / setBehavior() for unit + integration tests;
 *  - the x-test-market-behavior request header, honored by the controller
 *    ONLY when MARKET_DATA_TEST_MODE=1 and this dummy is the active provider
 *    (wired in market-data.deps.ts, fail-closed in production).
 */
import type { Bar } from "@agentic-trading/quant-core";
import type { DummyBehavior, FetchWindow, MarketDataProvider, RawMarketDataResponse } from "./market-data.types.js";

/** HKEX holiday with a measured Yahoo phantom bar (verification report §HK). */
export const PHANTOM_BAR_DATE = "2022-01-31";

/** Deterministic 32-bit PRNG (mulberry32) so bars depend only on the symbol. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function symbolSeed(symbol: string): number {
  let h = 2166136261;
  for (const c of symbol) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** 30 weekday sessions ending 2024-12-31, deterministic per symbol. */
export function syntheticBars(symbol: string): Bar[] {
  const rand = seededRandom(symbolSeed(symbol));
  const dates: string[] = [];
  const d = new Date("2024-12-31T00:00:00Z");
  while (dates.length < 30) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) dates.unshift(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  let prev = 50 + rand() * 100;
  return dates.map((date) => {
    const close = Math.max(1, prev * (1 + (rand() - 0.5) * 0.04));
    const high = Math.max(prev, close) * (1 + rand() * 0.01);
    const low = Math.min(prev, close) * (1 - rand() * 0.01);
    const bar: Bar = {
      date,
      open: prev,
      high,
      low,
      close,
      volume: Math.floor(rand() * 1_000_000) + 1,
    };
    prev = close;
    return bar;
  });
}

const OK_BASE = { httpStatus: 200, hasTimestamps: true, providerSaysNotFound: false } as const;

export class DummyMarketDataProvider implements MarketDataProvider {
  private readonly behaviors = new Map<string, DummyBehavior>();

  constructor(injected: Record<string, DummyBehavior> = {}) {
    for (const [symbol, behavior] of Object.entries(injected)) this.behaviors.set(symbol, behavior);
  }

  /** Per-test injection hook (the reference project's `_testResponse` spirit). */
  setBehavior(symbol: string, behavior: DummyBehavior): void {
    this.behaviors.set(symbol, behavior);
  }

  /** The dummy ignores the window — bars are synthetic and deterministic. */
  async fetchDailyBars(symbol: string, _opts?: FetchWindow): Promise<RawMarketDataResponse> {
    const behavior = this.behaviors.get(symbol) ?? "ok";
    switch (behavior) {
      case "rate-limited":
        return { httpStatus: 429, hasTimestamps: false, bars: [], corporateActions: [], providerSaysNotFound: false, failureReason: "http-429" };
      case "timeout":
        return { httpStatus: null, hasTimestamps: false, bars: [], corporateActions: [], providerSaysNotFound: false, failureReason: "timeout" };
      case "empty-bars":
        return { ...OK_BASE, bars: [], corporateActions: [], failureReason: "http-200-empty-bars" };
      case "zombie-meta":
        return { httpStatus: 200, hasTimestamps: false, bars: [], corporateActions: [], providerSaysNotFound: false, failureReason: "http-200-zombie-meta" };
      case "not-found":
        return { httpStatus: 404, hasTimestamps: false, bars: [], corporateActions: [], providerSaysNotFound: true, failureReason: "no-data-found" };
      case "fx-inconsistent-dividends":
        // 9988.HK case, as measured live 2026-09-01: USD-declared dividends
        // on an HK name come back FX-converted into HKD-labeled amounts with
        // >4 decimal places (real: 0.9800875) — the currency field echoes
        // meta.currency, it is NOT "USD". Unusable for local adjustment.
        return {
          ...OK_BASE,
          bars: syntheticBars(symbol),
          corporateActions: [{ date: "2024-06-13", type: "DIVIDEND", amount: 0.9800875, currency: "HKD" }],
        };
      case "holiday-phantom":
        // HKEX closed 2022-01-31 (Lunar New Year) — Yahoo fabricates a
        // zero-volume bar on every HK ticker.
        return {
          ...OK_BASE,
          bars: [{ date: PHANTOM_BAR_DATE, open: 100, high: 101, low: 99, close: 100.5, volume: 0 }, ...syntheticBars(symbol)],
          corporateActions: [],
        };
      case "close-outside-hl": {
        const bars = syntheticBars(symbol);
        const first = bars[0]!;
        bars[0] = { ...first, close: (first.high ?? first.close ?? 1) * 1.05 };
        return { ...OK_BASE, bars, corporateActions: [] };
      }
      case "ok":
        return { ...OK_BASE, bars: syntheticBars(symbol), corporateActions: [] };
    }
  }
}
