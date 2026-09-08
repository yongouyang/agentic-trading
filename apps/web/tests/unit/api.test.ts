import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDailyReport, fetchDeepDive, fetchPriceHistory } from "@/app/lib/api";
import { dailyReportFixture } from "./fixtures";

describe("lib/api fetch helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns unreachable when API_INTERNAL_URL is not set", async () => {
    vi.stubEnv("API_INTERNAL_URL", "");
    expect((await fetchDailyReport("US")).kind).toBe("unreachable");
    expect((await fetchDeepDive(1, "AAPL")).kind).toBe("unreachable");
    expect((await fetchPriceHistory("AAPL")).kind).toBe("unreachable");
  });

  it("fetchDailyReport maps 404 to no-run and 200 to ok", async () => {
    vi.stubEnv("API_INTERNAL_URL", "http://api.test");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ status: 404, ok: false })
        .mockResolvedValueOnce({ status: 200, ok: true, json: async () => dailyReportFixture }),
    );
    expect((await fetchDailyReport("US")).kind).toBe("no-run");
    const ok = await fetchDailyReport("HK");
    expect(ok).toEqual({ kind: "ok", report: dailyReportFixture });
    expect(fetch).toHaveBeenCalledWith("http://api.test/reports/daily?market=HK", {
      cache: "no-store",
    });
  });

  it("maps network errors and 5xx to unreachable", async () => {
    vi.stubEnv("API_INTERNAL_URL", "http://api.test");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    expect((await fetchDailyReport("US")).kind).toBe("unreachable");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 500, ok: false }));
    expect((await fetchDeepDive(1, "AAPL")).kind).toBe("unreachable");
    expect((await fetchPriceHistory("AAPL")).kind).toBe("unreachable");
  });

  it("fetchDeepDive maps 404 to not-found", async () => {
    vi.stubEnv("API_INTERNAL_URL", "http://api.test");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 404, ok: false }));
    expect((await fetchDeepDive(7, "AAPL")).kind).toBe("not-found");
  });

  it("fetchPriceHistory maps 404 to not-found", async () => {
    vi.stubEnv("API_INTERNAL_URL", "http://api.test");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 404, ok: false }));
    expect((await fetchPriceHistory("XXXX")).kind).toBe("not-found");
  });

  it("encodes symbols in paths", async () => {
    vi.stubEnv("API_INTERNAL_URL", "http://api.test");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({ symbol: "0005.HK", days: 250, bars: [], markers: [] }),
      }),
    );
    await fetchPriceHistory("0005.HK");
    expect(fetch).toHaveBeenCalledWith(
      "http://api.test/instruments/0005.HK/price-history?days=250",
      { cache: "no-store" },
    );
  });
});
