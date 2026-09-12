/**
 * TencentKlineProvider unit tests (mocked fetch, zero spacing) — the sentinel's
 * date-only cross-check leg. The shapes below are the live ones captured
 * 2026-09-02: `qfqday` for most HK names, `day` only for 3195.HK, and the
 * silent HTTP 200 + empty array (RULE L4) for a wrong code shape.
 */
import { describe, expect, it, vi } from "vitest";
import { TencentKlineProvider, type TencentKlineProviderOptions } from "../../src/market-data/tencent.provider.js";

const noSleep = async () => {};

function providerWith(opts: TencentKlineProviderOptions) {
  return new TencentKlineProvider({ spacingMs: 0, sleep: noSleep, ...opts });
}

function jsonResponse(status: number, body: unknown): Response {
  return { status, json: async () => body } as unknown as Response;
}

/** Live row shape: [date, open, close, high, low, volume, {…}, turnover, …]. */
const row = (date: string) => [date, "162.700", "161.700", "163.200", "161.000", "8201958.000", { cqr: date }, "0.050", "133053.691"];

describe("TencentKlineProvider — request shape (plan §A.1, spike-verbatim)", () => {
  it("maps the Yahoo 4-digit symbol to tencent's 5-digit code, 1200-bar qfq page", () => {
    expect(TencentKlineProvider.urlFor("0005.HK")).toBe(
      "https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get?param=hk00005,day,,,1200,qfq",
    );
    expect(TencentKlineProvider.urlFor("0700.HK")).toContain("param=hk00700,");
  });

  it("sends the pinned UA and the mapped URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: { hk00005: { qfqday: [row("2026-08-26")] } } }));
    const p = providerWith({ fetchImpl });
    await p.fetchSessionDates("0005.HK");
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("param=hk00005,day,,,1200,qfq");
    expect((fetchImpl.mock.calls[0]![1] as RequestInit).headers).toEqual({ "User-Agent": "Mozilla/5.0" });
  });
});

describe("TencentKlineProvider — date-only parsing", () => {
  it("qfqday rows → ascending session dates, series=\"qfq\"", async () => {
    const body = { data: { hk00005: { qfqday: [row("2026-08-26"), row("2026-08-27"), row("2026-08-28")] } } };
    const p = providerWith({ fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, body)) });
    expect(await p.fetchSessionDates("0005.HK")).toEqual({
      dates: ["2026-08-26", "2026-08-27", "2026-08-28"],
      series: "qfq",
    });
  });

  it("3195.HK shape (no qfqday, `day` only) → series=\"day\"", async () => {
    const body = { data: { hk03195: { day: [row("2026-08-26"), row("2026-09-01")], qt: {} } } };
    const p = providerWith({ fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, body)) });
    expect(await p.fetchSessionDates("3195.HK")).toEqual({ dates: ["2026-08-26", "2026-09-01"], series: "day" });
  });

  it("empty qfqday with a populated day falls back to day", async () => {
    const body = { data: { hk03195: { qfqday: [], day: [row("2026-08-26")] } } };
    const p = providerWith({ fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, body)) });
    expect(await p.fetchSessionDates("3195.HK")).toMatchObject({ series: "day", dates: ["2026-08-26"] });
  });

  it("rows with unparseable dates are dropped; all-unparseable is a failure", async () => {
    const mixed = { data: { hk00005: { qfqday: [["", "1"], row("2026-08-27"), [null, "1"]] } } };
    const p1 = providerWith({ fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, mixed)) });
    expect(await p1.fetchSessionDates("0005.HK")).toMatchObject({ dates: ["2026-08-27"] });
    const junk = { data: { hk00005: { qfqday: [["nonsense", "1"]] } } };
    const p2 = providerWith({ fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, junk)) });
    expect(await p2.fetchSessionDates("0005.HK")).toEqual({ failure: "http-200-no-parseable-dates" });
  });
});

describe("TencentKlineProvider — failure taxonomy (never throws)", () => {
  it.each([
    [
      "empty day + empty qfqday (wrong code shape, RULE L4)",
      "0005.HK",
      { data: { hk00005: { day: [], qfqday: [], qt: {} } } },
      /^http-200-empty-bars/,
    ],
    ["node for the requested code absent", "0700.HK", { data: { hk00005: { qfqday: [row("2026-08-26")] } } }, /^http-200-no-node/],
    ["data null", "0005.HK", { data: null }, /^http-200-no-node/],
    ["no data key", "0005.HK", {}, /^http-200-no-node/],
  ])("HTTP 200 + %s → {failure}, never GENUINELY_ABSENT", async (_label, symbol, body, re) => {
    const p = providerWith({ fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, body)) });
    const r = await p.fetchSessionDates(symbol as string);
    expect("failure" in r ? r.failure : r).toMatch(re as RegExp);
    expect("dates" in r ? r.dates : undefined).toBeUndefined();
  });

  it("records the node keys in the empty-bars failure (spike diagnostics)", async () => {
    const body = { data: { hk00005: { day: [], qt: {}, prec: 1 } } };
    const p = providerWith({ fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, body)) });
    expect(await p.fetchSessionDates("0005.HK")).toEqual({ failure: "http-200-empty-bars (keys=day/qt/prec)" });
  });

  it("unparseable body → {failure}", async () => {
    const res = { status: 200, json: async () => { throw new Error("Unexpected end of JSON input"); } } as unknown as Response;
    const p = providerWith({ fetchImpl: vi.fn().mockResolvedValue(res) });
    expect(await p.fetchSessionDates("0005.HK")).toEqual({ failure: "http-200-unparseable" });
  });

  it("non-200 → {failure: http-<status>}", async () => {
    const p = providerWith({ fetchImpl: vi.fn().mockResolvedValue(jsonResponse(503, {})) });
    expect(await p.fetchSessionDates("0005.HK")).toEqual({ failure: "http-503" });
  });

  it("abort → timeout; socket drop → transport:<code>", async () => {
    const abort = providerWith({ fetchImpl: vi.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" })) });
    expect(await abort.fetchSessionDates("0005.HK")).toEqual({ failure: "timeout" });
    const drop = providerWith({ fetchImpl: vi.fn().mockRejectedValue(new Error("fetch failed", { cause: { code: "ECONNRESET" } })) });
    expect(await drop.fetchSessionDates("0005.HK")).toEqual({ failure: "transport:ECONNRESET" });
  });

  it("throws only on programming errors (non-HK symbol)", async () => {
    const p = providerWith({ fetchImpl: vi.fn() });
    await expect(p.fetchSessionDates("AAPL")).rejects.toThrow(/not a Yahoo HK symbol/);
  });

  it("node with no keys at all → empty-bars failure says \"none\"", async () => {
    const p = providerWith({ fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, { data: { hk00005: {} } })) });
    expect(await p.fetchSessionDates("0005.HK")).toEqual({ failure: "http-200-empty-bars (keys=none)" });
  });

  it("non-array rows are ignored rather than crashing", async () => {
    const body = { data: { hk00005: { qfqday: ["junk", 42, row("2026-08-27")] } } };
    const p = providerWith({ fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, body)) });
    expect(await p.fetchSessionDates("0005.HK")).toMatchObject({ dates: ["2026-08-27"] });
  });

  it("error without a cause → transport:<message>", async () => {
    const p = providerWith({ fetchImpl: vi.fn().mockRejectedValue(new Error("socket hang up")) });
    expect(await p.fetchSessionDates("0005.HK")).toEqual({ failure: "transport:socket hang up" });
  });

  it("production default spacing is 500ms (paced, not hammered)", async () => {
    const sleeps: number[] = [];
    const body = { data: { hk00005: { qfqday: [row("2026-08-26")] } } };
    const p = new TencentKlineProvider({
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, body)),
      sleep: async (ms) => void sleeps.push(ms),
    });
    await p.fetchSessionDates("0005.HK");
    await p.fetchSessionDates("0700.HK");
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]!).toBeGreaterThanOrEqual(500);
    expect(sleeps[0]!).toBeLessThanOrEqual(750);
  });
});

describe("TencentKlineProvider — pacing (measured: 9 calls at 0.5–0.6s, no throttling)", () => {
  it("paces the second call to >= jitter(500ms) since the first, deterministically", async () => {
    // The property is the SPACING, not the sleep value. `throttle` sleeps only the
    // REMAINING time to a jittered deadline, so a sleep below `spacingMs` is
    // correct whenever real time has already elapsed since the previous request —
    // which made the previous assertion (`sleep >= 500`) both wrong and flaky: it
    // measured 489.3ms on a run where only ~20ms had elapsed. Freezing the clock and
    // letting the injected sleep advance it tests the actual guarantee.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T00:00:00Z"));
    const sleeps: number[] = [];
    const body = { data: { hk00005: { qfqday: [row("2026-08-26")] } } };
    const p = new TencentKlineProvider({
      spacingMs: 500,
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, body)),
      sleep: async (ms: number) => {
        sleeps.push(ms);
        vi.setSystemTime(Date.now() + ms); // the injected sleep IS the wait
      },
    });
    try {
      await p.fetchSessionDates("0005.HK");
      const afterFirst = Date.now();
      await p.fetchSessionDates("0005.HK");
      const spacing = Date.now() - afterFirst;
      expect(sleeps).toHaveLength(1); // first call unpaced
      expect(sleeps[0]!).toBeGreaterThan(0);
      expect(spacing).toBeGreaterThanOrEqual(500); // the jittered minimum spacing
      expect(sleeps[0]!).toBeLessThanOrEqual(750); // and never more than the cap
    } finally {
      vi.useRealTimers();
    }
  });

  it("never sleeps longer than the jitter cap, and never paces the FIRST call", async () => {
    // The inverted property, so the fix above cannot be mistaken for "always sleep
    // nothing": an unpaced first call and a bounded second one.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T00:00:00Z"));
    const sleeps: number[] = [];
    const body = { data: { hk00005: { qfqday: [row("2026-08-26")] } } };
    const p = new TencentKlineProvider({
      spacingMs: 500,
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, body)),
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    try {
      await p.fetchSessionDates("0005.HK");
      expect(sleeps).toHaveLength(0); // first call is never paced
      await p.fetchSessionDates("0005.HK");
      expect(sleeps).toHaveLength(1);
      expect(sleeps[0]!).toBeLessThanOrEqual(750);
    } finally {
      vi.useRealTimers();
    }
  });
});
