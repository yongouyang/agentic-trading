/**
 * Fundamentals snapshot shaping (eastmoney-f10.provider.ts, Phase 2) —
 * fixtures are VERBATIM probe responses captured 2026-09-06 (see file
 * headers): HK 00700 main indicators (mixed + annual-filtered), US TSLA
 * org-profile lookup + main indicators (all periods). No network.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EastmoneyF10Provider,
  renderFundamentalsSnapshot,
  scaledMoney,
  signedPct,
  type F10IndicatorRow,
} from "../../src/market-data/eastmoney-f10.provider.js";

const FIXTURES = path.join(fileURLToPath(new URL(".", import.meta.url)), "fixtures");
const fixture = (name: string) => JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));

const row = (over: Partial<F10IndicatorRow>): F10IndicatorRow => ({
  reportDate: "2025-12-31",
  dateTypeCode: "001",
  reportType: "2025年年报",
  currency: "HKD",
  revenue: null,
  revenueYoy: null,
  netProfit: null,
  netProfitYoy: null,
  grossMargin: null,
  netMargin: null,
  roe: null,
  debtRatio: null,
  eps: null,
  operatingCashFlow: null,
  ...over,
});

describe("scaledMoney / signedPct", () => {
  it("scales with fixed precision", () => {
    expect(scaledMoney(751_766_000_000)).toBe("751.77B");
    expect(scaledMoney(28_236_000_000)).toBe("28.24B");
    expect(scaledMoney(-1_591_000_000)).toBe("-1.59B");
    expect(scaledMoney(2_500_000)).toBe("2.50M");
    expect(scaledMoney(999)).toBe("999.00");
    expect(signedPct(13.8596)).toBe("+13.9%");
    expect(signedPct(-4.9488)).toBe("-4.9%");
  });
});

describe("renderFundamentalsSnapshot", () => {
  it("renders latest interim + latest annual, n/a for missing fields", () => {
    const text = renderFundamentalsSnapshot([
      row({ reportDate: "2026-06-30", dateTypeCode: "002", reportType: "2026年中报", revenue: 100e9, revenueYoy: 5.25, netProfit: 20e9 }),
      row({ revenue: 751.766e9, revenueYoy: 13.8596, netProfit: 224.842e9, netProfitYoy: 15.8543, grossMargin: 56.21, roe: 21.13, debtRatio: 39.13, eps: 24.749, operatingCashFlow: 303.052e9 }),
      row({ reportDate: "2024-12-31", revenue: 660e9 }),
    ]);
    expect(text).toBe(
      [
        "2026年中报 (2026-06-30, HKD)",
        "  revenue: 100.00B (yoy +5.3%)",
        "  net profit: 20.00B",
        "  gross margin: n/a, net margin: n/a",
        "  ROE(avg): n/a, debt/assets: n/a, EPS: n/a",
        "2025年年报 (2025-12-31, HKD)",
        "  revenue: 751.77B (yoy +13.9%)",
        "  net profit: 224.84B (yoy +15.9%)",
        "  gross margin: 56.2%, net margin: n/a",
        "  ROE(avg): 21.1%, debt/assets: 39.1%, EPS: 24.75",
        "  operating cash flow: 303.05B",
      ].join("\n"),
    );
  });

  it("returns null on empty rows (ETF / no F10 records)", () => {
    expect(renderFundamentalsSnapshot([])).toBeNull();
  });
});

/** Drive fetchFundamentalsSnapshot with a fetchImpl keyed off the probed
 *  fixtures — exercises URL construction (reportNames, filters, source) and
 *  the HK/US field split end to end. */
function fixtureFetch(map: { match: string; body: unknown }[]): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (url: any) => {
    const u = String(url);
    urls.push(u);
    const hit = map.find((m) => u.includes(m.match));
    if (!hit) return { status: 404, json: async () => ({}) } as Response;
    return { status: 200, json: async () => hit.body } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

const noSleep = async () => {};

describe("EastmoneyF10Provider.fetchFundamentalsSnapshot", () => {
  it("HK: single F10-sourced MAININDICATOR call, HOLDER_PROFIT fields", async () => {
    const { fetchImpl, urls } = fixtureFetch([{ match: "RPT_HKF10_FN_MAININDICATOR", body: fixture("f10-hk-main.json") }]);
    const p = new EastmoneyF10Provider({ fetchImpl, sleep: noSleep, spacingMs: 0 });
    const res = await p.fetchFundamentalsSnapshot("0700.HK");
    expect("failure" in res).toBe(false);
    expect(urls).toHaveLength(1);
    expect(decodeURIComponent(urls[0]!)).toContain('filter=(SECURITY_CODE="00700")');
    expect(urls[0]).toContain("source=F10");
    if ("text" in res) {
      expect(res.text).toContain("2026年中报 (2026-06-30, HKD)");
      expect(res.text).toContain("revenue:");
    }
  });

  it("US: org-profile lookup then SECURITIES-sourced GMAININDICATOR, PARENT_HOLDER_NETPROFIT fields", async () => {
    const { fetchImpl, urls } = fixtureFetch([
      { match: "RPT_USF10_INFO_ORGPROFILE", body: fixture("f10-us-org.json") },
      { match: "RPT_USF10_FN_GMAININDICATOR", body: fixture("f10-us-all.json") },
    ]);
    const p = new EastmoneyF10Provider({ fetchImpl, sleep: noSleep, spacingMs: 0 });
    const res = await p.fetchFundamentalsSnapshot("TSLA");
    expect("failure" in res).toBe(false);
    expect(urls).toHaveLength(2);
    expect(decodeURIComponent(urls[1]!)).toContain('filter=(SECUCODE="TSLA.O")');
    expect(urls[1]).toContain("source=SECURITIES");
    if ("text" in res) {
      expect(res.text).toContain("2026/Q2 (2026-06-30, 美元)");
      expect(res.text).toContain("revenue: 28.24B (yoy +25.5%)");
      expect(res.text).toContain("net profit: 1.11B (yoy -4.9%)");
      expect(res.text).not.toContain("operating cash flow");
    }
    // secucode cached: a second call reuses it (one fewer request per name).
    await p.fetchFundamentalsSnapshot("TSLA");
    expect(urls).toHaveLength(3);
  });

  it("US annual line comes from the same all-periods response", async () => {
    const { fetchImpl } = fixtureFetch([
      { match: "RPT_USF10_INFO_ORGPROFILE", body: fixture("f10-us-org.json") },
      { match: "RPT_USF10_FN_GMAININDICATOR", body: fixture("f10-us-all.json") },
    ]);
    const p = new EastmoneyF10Provider({ fetchImpl, sleep: noSleep, spacingMs: 0 });
    const res = await p.fetchFundamentalsSnapshot("TSLA");
    // fixture page lacks an annual (001) row → interim-only block
    if ("text" in res) expect(res.text).not.toContain("年报");
  });

  it("result:null (ETF) is legitimate absence, not a failure", async () => {
    const { fetchImpl } = fixtureFetch([{ match: "RPT_HKF10_FN_MAININDICATOR", body: { result: null } }]);
    const p = new EastmoneyF10Provider({ fetchImpl, sleep: noSleep, spacingMs: 0 });
    const res = await p.fetchFundamentalsSnapshot("2800.HK");
    expect(res).toEqual({ text: null });
  });

  it("http error is failure-as-value", async () => {
    const fetchImpl = (async () => ({ status: 503, json: async () => ({}) }) as Response) as unknown as typeof fetch;
    const p = new EastmoneyF10Provider({ fetchImpl, sleep: noSleep, spacingMs: 0 });
    const res = await p.fetchFundamentalsSnapshot("0700.HK");
    expect(res).toEqual({ failure: "http-503" });
  });

  it("missing US secucode is a loud failure slug", async () => {
    const { fetchImpl } = fixtureFetch([{ match: "RPT_USF10_INFO_ORGPROFILE", body: { result: { data: [] } } }]);
    const p = new EastmoneyF10Provider({ fetchImpl, sleep: noSleep, spacingMs: 0 });
    const res = await p.fetchFundamentalsSnapshot("NOPE");
    expect(res).toEqual({ failure: "orgprofile-no-secucode" });
  });
});
