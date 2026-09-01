import { describe, expect, it, vi } from "vitest";
import { EastmoneyRepairProvider, type EastmoneyRepairProviderOptions } from "../../src/market-data/eastmoney-repair.provider.js";
import { hkSymbolMaps } from "../../src/market-data/hk-symbol-map.js";

const noSleep = async () => {};

/** Zero spacing — tests never wait (ban protection is production pacing). */
function providerWith(opts: EastmoneyRepairProviderOptions) {
  return new EastmoneyRepairProvider({ spacingMs: 0, sleep: noSleep, ...opts });
}

function jsonResponse(status: number, body: unknown): Response {
  return { status, json: async () => body } as unknown as Response;
}

describe("hkSymbolMaps — Yahoo 4-digit → eastmoney/tencent 5-digit (plan §A.1)", () => {
  it.each([
    ["0005.HK", "116.00005", "hk00005"],
    ["0700.HK", "116.00700", "hk00700"],
    ["9988.HK", "116.09988", "hk09988"],
  ])("%s → %s / %s", (symbol, secid, tencent) => {
    expect(hkSymbolMaps(symbol)).toEqual({ eastmoneySecid: secid, tencentCode: tencent });
  });

  it.each(["AAPL", "12345.HK", "123.HK", "0005.hk", "0005", "ABCD.HK"])("rejects %s loudly (programming error)", (symbol) => {
    expect(() => hkSymbolMaps(symbol)).toThrow(/not a Yahoo HK symbol/);
  });
});

describe("EastmoneyRepairProvider — response parsing (mocked fetch, zero spacing)", () => {
  it("happy path: pipe-delimited klines → Bar[] (date, OHLC, volume)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        data: {
          klines: ["2024-12-30,10.00,10.50,11.00,9.50,123456", "2024-12-31,10.50,11.00,11.20,10.40,234567"],
        },
      }),
    );
    const p = providerWith({ fetchImpl });
    const r = await p.fetchRawBars("0005.HK");
    expect("bars" in r && r.bars).toEqual([
      { date: "2024-12-30", open: 10.0, close: 10.5, high: 11.0, low: 9.5, volume: 123456 },
      { date: "2024-12-31", open: 10.5, close: 11.0, high: 11.2, low: 10.4, volume: 234567 },
    ]);
    const url = String(fetchImpl.mock.calls[0]![0]);
    expect(url).toContain("secid=116.00005");
    expect(url).toContain("fqt=0"); // raw bars — the only rescue convention
    expect(url).toContain("klt=101");
  });

  it("TCP drop / abort → {failure}, never throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
    const p = providerWith({ fetchImpl });
    const r = await p.fetchRawBars("0700.HK");
    expect(r).toEqual({ failure: "timeout" });
  });

  it("connection reset (temp IP ban shape) → {failure} with diagnostic", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("fetch failed", { cause: { code: "ECONNRESET" } }));
    const p = providerWith({ fetchImpl });
    const r = await p.fetchRawBars("0700.HK");
    expect("failure" in r && r.failure).toContain("ECONNRESET");
  });

  it("non-200 → {failure}", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(403, {}));
    const p = providerWith({ fetchImpl });
    expect(await p.fetchRawBars("0700.HK")).toEqual({ failure: "http-403" });
  });

  it.each([
    ["null data", { data: null }],
    ["empty klines", { data: { klines: [] } }],
    ["missing klines", { data: {} }],
  ])("HTTP 200 + %s → {failure} (wrong-shape 200, never silent)", async (_label, body) => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, body));
    const p = providerWith({ fetchImpl });
    expect(await p.fetchRawBars("0700.HK")).toEqual({ failure: "http-200-empty-klines" });
  });

  it("throws only on programming errors (non-HK symbol)", async () => {
    const p = providerWith({ fetchImpl: vi.fn() });
    await expect(p.fetchRawBars("AAPL")).rejects.toThrow(/not a Yahoo HK symbol/);
  });
});
