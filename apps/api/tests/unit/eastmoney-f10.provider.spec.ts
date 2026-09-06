/**
 * Unit tests for EastmoneyF10Provider + parseF10Plan (Phase-2 CA-source
 * decision, 2026-09-06). Parser fixtures are the VERBATIM PLAN_EXPLAIN
 * strings measured live 2026-09-06 (00700, 00005, 01211); provider tests use
 * injected fetch/sleep at zero spacing (same idiom as the repair provider).
 */
import { describe, expect, it, vi } from "vitest";
import {
  EastmoneyF10Provider,
  normalizeF10Date,
  parseF10Plan,
  type EastmoneyF10ProviderOptions,
} from "../../src/market-data/eastmoney-f10.provider.js";

const noSleep = async () => {};

/** Zero spacing — tests never wait (pacing is production discipline). */
function providerWith(opts: EastmoneyF10ProviderOptions) {
  return new EastmoneyF10Provider({ spacingMs: 0, sleep: noSleep, ...opts });
}

function jsonResponse(status: number, body: unknown): Response {
  return { status, json: async () => body } as unknown as Response;
}

describe("parseF10Plan — measured PLAN_EXPLAIN strings (2026-09-06)", () => {
  it("cash HKD: `每股派港币5.3元` (00700 年度分配)", () => {
    expect(parseF10Plan("每股派港币5.3元")).toEqual({
      kind: "cash",
      declaringCurrency: "HKD",
      declaringAmount: 5.3,
      hkdEquivalent: null,
      embeddedBonus: false,
    });
  });

  it("cash USD with nested (计算值) parens: 00005 `每股派美元0.1元(相当于港币0.784234元(计算值))`", () => {
    expect(parseF10Plan("每股派美元0.1元(相当于港币0.784234元(计算值))")).toEqual({
      kind: "cash",
      declaringCurrency: "USD",
      declaringAmount: 0.1,
      hkdEquivalent: 0.784234,
      embeddedBonus: false,
    });
  });

  it("cash CNY: 01211 `每股派人民币0.358元(相当于港币0.41141元)`", () => {
    expect(parseF10Plan("每股派人民币0.358元(相当于港币0.41141元)")).toEqual({
      kind: "cash",
      declaringCurrency: "CNY",
      declaringAmount: 0.358,
      hkdEquivalent: 0.41141,
      embeddedBonus: false,
    });
  });

  it("in-specie with HKD equivalent: `特殊说明:每10股分派1股美团B类普通股股份(相当于每股派18.13港元)`", () => {
    expect(parseF10Plan("特殊说明:每10股分派1股美团B类普通股股份(相当于每股派18.13港元)")).toEqual({
      kind: "in-specie",
      perShares: 10,
      getShares: 1,
      asset: "美团B类普通股股份",
      hkdEquivalentPerShare: 18.13,
      embeddedBonus: false,
    });
  });

  it("in-specie ratio-only: `特殊说明:每21股腾讯股份分派1股京东集团A类普通股股份`", () => {
    expect(parseF10Plan("特殊说明:每21股腾讯股份分派1股京东集团A类普通股股份")).toEqual({
      kind: "in-specie",
      perShares: 21,
      getShares: 1,
      asset: "京东集团A类普通股股份",
      hkdEquivalentPerShare: null,
      embeddedBonus: false,
    });
  });

  it.each([
    ["每3900股分派1股腾讯音乐娱乐集团美国预托股份", 3900, "腾讯音乐娱乐集团美国预托股份"],
    ["每1256股分派1股China Literature Ltd.预留股份", 1256, "China Literature Ltd.预留股份"],
  ])("older ratio-only in-specie: %s", (plan, per, asset) => {
    const p = parseF10Plan(plan);
    expect(p).toMatchObject({ kind: "in-specie", perShares: per, getShares: 1, asset, hkdEquivalentPerShare: null });
  });

  it("bonus: 01211 `每10股派送8股,每10股转12股` (split-class, out of scope)", () => {
    expect(parseF10Plan("每10股派送8股,每10股转12股")).toEqual({ kind: "bonus" });
  });

  it("cash with EMBEDDED bonus clause (1211.HK 2025-06-10, measured): cash parsed, embeddedBonus flagged", () => {
    expect(parseF10Plan("每股派人民币3.974元(相当于港币4.33596元),每10股派送8股,每10股转12股")).toEqual({
      kind: "cash",
      declaringCurrency: "CNY",
      declaringAmount: 3.974,
      hkdEquivalent: 4.33596,
      embeddedBonus: true,
    });
  });

  it("alternate cash ordering (0005.HK 2004 row, measured): `每股派0.13美元(…)`", () => {
    expect(parseF10Plan("每股派0.13美元(相当于港币1.0076元)(可选择以股代息)")).toEqual({
      kind: "cash",
      declaringCurrency: "USD",
      declaringAmount: 0.13,
      hkdEquivalent: 1.0076,
      embeddedBonus: false,
    });
  });

  it("unknown garbage ⇒ kind=unknown (caller warns loudly)", () => {
    expect(parseF10Plan("不派息")).toEqual({ kind: "unknown" });
    expect(parseF10Plan("")).toEqual({ kind: "unknown" });
  });

  it("in-specie wins over cash-looking text inside its own HKD-equivalent clause", () => {
    // `(相当于每股派18.13港元)` contains `每股派…港元` — must NOT parse as cash.
    const p = parseF10Plan("特殊说明:每10股分派1股美团B类普通股股份(相当于每股派18.13港元)");
    expect(p.kind).toBe("in-specie");
  });
});

describe("normalizeF10Date", () => {
  it("YYYY/MM/DD → YYYY-MM-DD; empty and '-' → null", () => {
    expect(normalizeF10Date("2026/05/15")).toBe("2026-05-15");
    expect(normalizeF10Date("2026-05-15")).toBe("2026-05-15");
    expect(normalizeF10Date("")).toBeNull();
    expect(normalizeF10Date("-")).toBeNull();
    expect(normalizeF10Date(null)).toBeNull();
  });
});

const F10_ROW = {
  SECURITY_CODE: "00700",
  UPDATE_DATE: "2026/05/16",
  NOTICE_DATE: "2026/03/18",
  REPORT_TYPE: "年度分配",
  EX_DIVIDEND_DATE: "2026/05/15",
  DIVIDEND_DATE: "2026/05/29",
  TRANSFER_END_DATE: "-",
  YEAR: "2025",
  PLAN_EXPLAIN: "每股派港币5.3元",
  IS_BFP: "0",
};

describe("EastmoneyF10Provider — response parsing (mocked fetch, zero spacing)", () => {
  it("happy path: result.data rows → normalized F10DividendRow[]", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { result: { data: [F10_ROW] } }));
    const p = providerWith({ fetchImpl });
    const r = await p.fetchDividendRows("0700.HK");
    expect("rows" in r && r.rows).toEqual([
      { noticeDate: "2026-03-18", exDate: "2026-05-15", payDate: "2026-05-29", reportType: "年度分配", plan: "每股派港币5.3元" },
    ]);
    const url = String(fetchImpl.mock.calls[0]![0]);
    expect(url).toContain("datacenter.eastmoney.com"); // NOT the ban-prone push2his
    expect(url).toContain("RPT_HKF10_MAIN_DIVBASIC");
    expect(url).toContain('(SECURITY_CODE="00700")'); // bare 5-digit code from secid
  });

  it("empty data array = legitimate absence (01810 non-payer, measured) → rows: [], NOT failure", async () => {
    const p = providerWith({ fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, { result: { data: [] } })) });
    expect(await p.fetchDividendRows("1810.HK")).toEqual({ rows: [] });
  });

  it("result: null (no report for the name — ETF 2800.HK) → rows: [], NOT failure", async () => {
    const p = providerWith({ fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, { result: null })) });
    expect(await p.fetchDividendRows("2800.HK")).toEqual({ rows: [] });
  });

  it("non-200 → {failure}", async () => {
    const p = providerWith({ fetchImpl: vi.fn().mockResolvedValue(jsonResponse(403, {})) });
    expect(await p.fetchDividendRows("0700.HK")).toEqual({ failure: "http-403" });
  });

  it("timeout (abort) → {failure}, never throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
    const p = providerWith({ fetchImpl });
    expect(await p.fetchDividendRows("0700.HK")).toEqual({ failure: "timeout" });
  });

  it("transport error → {failure} with diagnostic", async () => {
    const p = providerWith({ fetchImpl: vi.fn().mockRejectedValue(new Error("fetch failed", { cause: { code: "ECONNRESET" } })) });
    const r = await p.fetchDividendRows("0700.HK");
    expect("failure" in r && r.failure).toContain("ECONNRESET");
  });

  it.each([
    ["non-object json", "garbage"],
    ["result.data not an array", { result: { data: "nope" } }],
  ])("malformed: %s → {failure}", async (_label, body) => {
    const p = providerWith({ fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, body)) });
    const r = await p.fetchDividendRows("0700.HK");
    expect("failure" in r).toBe(true);
  });

  it("throws only on programming errors (non-HK symbol)", async () => {
    const p = providerWith({ fetchImpl: vi.fn() });
    await expect(p.fetchDividendRows("AAPL")).rejects.toThrow(/not a Yahoo HK symbol/);
  });

  it("pacing: production defaults space requests ≥1s, jitter(1000) ∈ [1000, 1500]", async () => {
    const sleeps: number[] = [];
    const body = { result: { data: [F10_ROW] } };
    const p = new EastmoneyF10Provider({
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, body)),
      sleep: async (ms) => void sleeps.push(ms),
    });
    await p.fetchDividendRows("0700.HK"); // no spacingMs given ⇒ default 1000
    await p.fetchDividendRows("0005.HK");
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]!).toBeGreaterThanOrEqual(1000);
    expect(sleeps[0]!).toBeLessThanOrEqual(1500);
  });
});
