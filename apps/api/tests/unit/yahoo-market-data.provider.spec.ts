import { classifyResponse, DataOutcome } from "@agentic-trading/quant-core";
import { describe, expect, it, vi } from "vitest";
import type { RawMarketDataResponse } from "../../src/market-data/market-data.types.js";
import { YahooMarketDataProvider, type YahooMarketDataProviderOptions } from "../../src/market-data/yahoo-market-data.provider.js";

const noSleep = async () => {};

/** Zero spacing/backoff — tests never wait. */
function providerWith(opts: YahooMarketDataProviderOptions) {
  return new YahooMarketDataProvider({ spacingMs: 0, retryBackoffMs: 0, sleep: noSleep, ...opts });
}

function jsonResponse(status: number, body: unknown): Response {
  return { status, json: async () => body } as unknown as Response;
}

function classify(r: RawMarketDataResponse): DataOutcome {
  return classifyResponse({
    httpStatus: r.httpStatus,
    hasTimestamps: r.hasTimestamps,
    barCount: r.bars.length,
    providerSaysNotFound: r.providerSaysNotFound,
  });
}

const QUOTE = { date: new Date("2024-12-31T00:00:00Z"), open: 10, high: 11, low: 9, close: 10.5, volume: 1_000_000 };

describe("YahooMarketDataProvider — response mapping (mocked chart/fetch, zero spacing/backoff)", () => {
  it("maps a chart result: bars, dividends with meta currency, splits counted not stored", async () => {
    const chart = vi.fn().mockResolvedValue({
      meta: { currency: "HKD" },
      quotes: [QUOTE, { ...QUOTE, date: new Date("2025-01-02T00:00:00Z"), close: 11 }],
      events: {
        dividends: [{ date: new Date("2024-06-13T00:00:00Z"), amount: 0.66 }],
        splits: [{ date: new Date("2022-06-01T00:00:00Z"), numerator: 10, denominator: 1 }],
      },
    });
    const p = providerWith({ chart });
    const r = await p.fetchDailyBars("0700.HK");
    expect(r.httpStatus).toBe(200);
    expect(r.hasTimestamps).toBe(true);
    expect(r.bars).toHaveLength(2);
    expect(r.bars[0]).toMatchObject({ date: "2024-12-31", close: 10.5 });
    expect(r.corporateActions).toEqual([{ date: "2024-06-13", type: "DIVIDEND", amount: 0.66, currency: "HKD" }]);
    expect(r.splitCount).toBe(1);
    expect(r.providerSaysNotFound).toBe(false);
    expect(classify(r)).toBe(DataOutcome.OK);
    // Full 5y window by default, interval 1d, div|split events.
    const query = chart.mock.calls[0]![1] as any;
    expect(query.interval).toBe("1d");
    expect(query.events).toBe("div|split");
    expect(query.period2.getTime() - query.period1.getTime()).toBeGreaterThan(4.9 * 365.25 * 86400_000);
  });

  it("429 → one in-run retry, then FETCH_FAILED (never throws)", async () => {
    const chart = vi.fn().mockRejectedValue(new Error("HTTP 429 Too Many Requests"));
    const p = providerWith({ chart });
    const r = await p.fetchDailyBars("AAPL");
    expect(chart).toHaveBeenCalledTimes(2);
    expect(r.httpStatus).toBe(429);
    expect(r.bars).toEqual([]);
    expect(r.providerSaysNotFound).toBe(false);
    expect(r.failureReason).toBe("http-429");
    expect(classify(r)).toBe(DataOutcome.FETCH_FAILED);
  });

  it("429 then success: the single retry recovers", async () => {
    const chart = vi.fn().mockRejectedValueOnce(new Error("HTTP 429")).mockResolvedValueOnce({ meta: { currency: "USD" }, quotes: [QUOTE] });
    const p = providerWith({ chart });
    const r = await p.fetchDailyBars("AAPL");
    expect(chart).toHaveBeenCalledTimes(2);
    expect(classify(r)).toBe(DataOutcome.OK);
  });

  it("'No data found' → GENUINELY_ABSENT, no retry", async () => {
    const chart = vi.fn().mockRejectedValue(new Error("No data found, symbol may be delisted (404)"));
    const p = providerWith({ chart });
    const r = await p.fetchDailyBars("NOSUCHTICKER");
    expect(chart).toHaveBeenCalledTimes(1);
    expect(r.providerSaysNotFound).toBe(true);
    expect(classify(r)).toBe(DataOutcome.GENUINELY_ABSENT);
  });

  it("timeout → retryable, then FETCH_FAILED with httpStatus null", async () => {
    const chart = vi.fn().mockRejectedValue(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
    const p = providerWith({ chart });
    const r = await p.fetchDailyBars("AAPL");
    expect(chart).toHaveBeenCalledTimes(2);
    expect(r.httpStatus).toBeNull();
    expect(r.failureReason).toBe("timeout");
    expect(classify(r)).toBe(DataOutcome.FETCH_FAILED);
  });

  it("schema-validation rejection → raw v8 fallback; zombie meta → L3 FETCH_FAILED", async () => {
    const chart = vi.fn().mockRejectedValue(new Error("Failed Yahoo Schema validation"));
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { chart: { result: [{ meta: { instrumentType: "MUTUALFUND", currency: "USD" } }], error: null } }),
    );
    const p = providerWith({ chart, fetchImpl });
    const r = await p.fetchDailyBars("RYL");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const url = String(fetchImpl.mock.calls[0]![0]);
    expect(url).toContain("query1.finance.yahoo.com/v8/finance/chart/RYL");
    expect(url).toContain("interval=1d");
    expect(url).toContain("events=div%2Csplit");
    expect(url).toContain("includeAdjustedClose=true");
    expect(r.httpStatus).toBe(200);
    expect(r.hasTimestamps).toBe(false);
    expect(r.bars).toEqual([]);
    expect(classify(r)).toBe(DataOutcome.FETCH_FAILED);
  });

  it("raw fallback with empty timestamp array → L4 FETCH_FAILED", async () => {
    const chart = vi.fn().mockRejectedValue(new Error("Schema validation failed"));
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { chart: { result: [{ meta: { currency: "USD" }, timestamp: [] }], error: null } }),
    );
    const p = providerWith({ chart, fetchImpl });
    const r = await p.fetchDailyBars("AAPL");
    expect(r.hasTimestamps).toBe(false);
    expect(classify(r)).toBe(DataOutcome.FETCH_FAILED);
  });

  it("chart-level empty quotes array → L4 FETCH_FAILED (no fallback)", async () => {
    const chart = vi.fn().mockResolvedValue({ meta: { currency: "USD" }, quotes: [] });
    const fetchImpl = vi.fn();
    const p = providerWith({ chart, fetchImpl });
    const r = await p.fetchDailyBars("AAPL");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.hasTimestamps).toBe(false);
    expect(r.bars).toEqual([]);
    expect(classify(r)).toBe(DataOutcome.FETCH_FAILED);
  });

  it("raw fallback OK: dividends from events object with meta currency, splits counted", async () => {
    const chart = vi.fn().mockRejectedValue(new Error("Schema validation failed"));
    const t1 = Math.floor(new Date("2024-12-30T00:00:00Z").getTime() / 1000);
    const t2 = Math.floor(new Date("2024-12-31T00:00:00Z").getTime() / 1000);
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        chart: {
          result: [
            {
              meta: { currency: "USD" },
              timestamp: [t1, t2],
              indicators: { quote: [{ open: [10, 11], high: [11, 12], low: [9, 10], close: [10.5, 11.5], volume: [100, 200] }] },
              events: {
                dividends: { "0": { date: t2, amount: 0.25 } },
                splits: { "0": { date: t1, numerator: 4, denominator: 1 }, "1": { date: t2, numerator: 2, denominator: 1 } },
              },
            },
          ],
          error: null,
        },
      }),
    );
    const p = providerWith({ chart, fetchImpl });
    const r = await p.fetchDailyBars("AAPL");
    expect(classify(r)).toBe(DataOutcome.OK);
    expect(r.bars).toHaveLength(2);
    expect(r.bars[1]).toMatchObject({ date: "2024-12-31", close: 11.5, volume: 200 });
    expect(r.corporateActions).toEqual([{ date: "2024-12-31", type: "DIVIDEND", amount: 0.25, currency: "USD" }]);
    expect(r.splitCount).toBe(2); // counted for audit, never stored
  });

  it("raw fallback chart.error 'No data found' → GENUINELY_ABSENT", async () => {
    const chart = vi.fn().mockRejectedValue(new Error("Schema validation failed"));
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } } }),
    );
    const p = providerWith({ chart, fetchImpl });
    const r = await p.fetchDailyBars("TWTR");
    expect(r.providerSaysNotFound).toBe(true);
    expect(classify(r)).toBe(DataOutcome.GENUINELY_ABSENT);
  });

  it("raw fallback HTTP 404 → GENUINELY_ABSENT; HTTP 500 → retryable FETCH_FAILED", async () => {
    const chart = vi.fn().mockRejectedValue(new Error("Schema validation failed"));
    const fetch404 = vi.fn().mockResolvedValue(jsonResponse(404, {}));
    let r = await providerWith({ chart, fetchImpl: fetch404 }).fetchDailyBars("TWTR");
    expect(r.providerSaysNotFound).toBe(true);
    expect(classify(r)).toBe(DataOutcome.GENUINELY_ABSENT);

    const fetch500 = vi.fn().mockResolvedValue(jsonResponse(500, {}));
    r = await providerWith({ chart, fetchImpl: fetch500 }).fetchDailyBars("AAPL");
    expect(fetch500).toHaveBeenCalledTimes(2); // retried once
    expect(r.httpStatus).toBe(500);
    expect(classify(r)).toBe(DataOutcome.FETCH_FAILED);
  });
});

describe("YahooMarketDataProvider — sparse payloads and option defaults", () => {
  it("explicit window is honoured; absent fields map to null, absent events to []", async () => {
    const chart = vi.fn().mockResolvedValue({ quotes: [{ date: "2024-12-31T00:00:00Z" }] });
    const p = providerWith({ chart });
    const r = await p.fetchDailyBars("AAPL", { period1: "2024-01-01", period2: "2024-12-31" });
    expect(r.bars).toEqual([{ date: "2024-12-31", open: null, high: null, low: null, close: null, volume: null }]);
    expect(r.corporateActions).toEqual([]);
    expect(r.splitCount).toBe(0);
    const query = chart.mock.calls[0]![1] as any;
    expect(query.period1.toISOString().slice(0, 10)).toBe("2024-01-01");
    expect(query.period2.toISOString().slice(0, 10)).toBe("2024-12-31");
  });

  it("a bare chart result (no meta/quotes) still classifies as L4 FETCH_FAILED", async () => {
    const p = providerWith({ chart: vi.fn().mockResolvedValue({}) });
    const r = await p.fetchDailyBars("AAPL");
    expect(r.bars).toEqual([]);
    expect(r.failureReason).toBe("http-200-empty-bars");
    expect(classify(r)).toBe(DataOutcome.FETCH_FAILED);
  });

  it("raw fallback on a sparse quote row: missing meta → USD, short arrays → null", async () => {
    const chart = vi.fn().mockRejectedValue(new Error("Schema validation failed"));
    const t = Math.floor(new Date("2024-12-31T00:00:00Z").getTime() / 1000);
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { chart: { result: [{ timestamp: [t, t + 86400], indicators: { quote: [{ open: [10] }] } }], error: null } }),
    );
    const r = await providerWith({ chart, fetchImpl }).fetchDailyBars("AAPL");
    expect(r.corporateActions).toEqual([]);
    expect(r.splitCount).toBe(0);
    expect(r.bars[0]).toMatchObject({ open: 10, high: null, low: null, close: null, volume: null });
    expect(r.bars[1]).toMatchObject({ date: "2025-01-01", open: null });
    expect(classify(r)).toBe(DataOutcome.OK);
  });

  it("non-Error rejection: message-less failure is FETCH_FAILED and retryable", async () => {
    const chart = vi.fn().mockRejectedValue({});
    const r = await providerWith({ chart }).fetchDailyBars("AAPL");
    expect(r.httpStatus).toBeNull();
    expect(r.failureReason).toBe("[object Object]");
    expect(chart).toHaveBeenCalledTimes(2); // unknown transport failure ⇒ one retry
  });

  it("5xx and timeout wording classify without an HTTP status match", async () => {
    const r500 = await providerWith({ chart: vi.fn().mockRejectedValue(new Error("got HTTP 503 from upstream")) }).fetchDailyBars("AAPL");
    expect(r500.failureReason).toBe("http-503");
    const timedOut = await providerWith({ chart: vi.fn().mockRejectedValue(new Error("request timed out")) }).fetchDailyBars("AAPL");
    expect(timedOut.httpStatus).toBeNull();
    expect(timedOut.failureReason).toBe("timeout");
  });

  it("production defaults pace at jitter(200ms) between requests", async () => {
    const sleeps: number[] = [];
    const p = new YahooMarketDataProvider({
      retryBackoffMs: 0,
      sleep: async (ms) => void sleeps.push(ms),
      chart: vi.fn().mockResolvedValue({ meta: { currency: "USD" }, quotes: [QUOTE] }),
    });
    await p.fetchDailyBars("AAPL");
    await p.fetchDailyBars("MSFT");
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]!).toBeGreaterThanOrEqual(200);
    expect(sleeps[0]!).toBeLessThanOrEqual(300);
  });
});
