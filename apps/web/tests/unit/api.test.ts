import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDailyReport, fetchDeepDive, fetchHealth, fetchPriceHistory, fetchRuns } from "@/app/lib/api";
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

  it("fetchDailyReport passes runId through when given (phase 3c)", async () => {
    vi.stubEnv("API_INTERNAL_URL", "http://api.test");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => dailyReportFixture }),
    );
    await fetchDailyReport("HK", 7);
    expect(fetch).toHaveBeenCalledWith("http://api.test/reports/daily?market=HK&runId=7", {
      cache: "no-store",
    });
  });

  it("fetchRuns builds the query from market/symbol and maps 200 to ok (phase 3c)", async () => {
    vi.stubEnv("API_INTERNAL_URL", "http://api.test");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => [{ id: 7 }] }),
    );
    expect(await fetchRuns("HK", "0005.HK")).toEqual({ kind: "ok", runs: [{ id: 7 }] });
    expect(fetch).toHaveBeenCalledWith("http://api.test/reports/runs?market=HK&symbol=0005.HK", {
      cache: "no-store",
    });
  });

  it("fetchRuns never throws: unset base, 5xx, network error and non-array payloads degrade", async () => {
    vi.stubEnv("API_INTERNAL_URL", "");
    expect((await fetchRuns("US")).kind).toBe("unreachable");
    vi.stubEnv("API_INTERNAL_URL", "http://api.test");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 500, ok: false }));
    expect((await fetchRuns("US")).kind).toBe("unreachable");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    expect((await fetchRuns("US")).kind).toBe("unreachable");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ not: "an array" }) }),
    );
    expect(await fetchRuns("US")).toEqual({ kind: "ok", runs: [] });
  });

  // W4d: /ops/health succeeds even when no run exists, so "unreachable" here
  // genuinely means the api is down (not "nothing ran").
  it("fetchHealth maps 200 to ok and every failure to unreachable", async () => {
    vi.stubEnv("API_INTERNAL_URL", "http://api.test");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ asOf: "x", level: "alert", lanes: [], jobs: [] }) }),
    );
    expect(await fetchHealth()).toEqual({ kind: "ok", health: { asOf: "x", level: "alert", lanes: [], jobs: [] } });
    expect(fetch).toHaveBeenCalledWith("http://api.test/ops/health", { cache: "no-store" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 500, ok: false }));
    expect((await fetchHealth()).kind).toBe("unreachable");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    expect((await fetchHealth()).kind).toBe("unreachable");
    vi.stubEnv("API_INTERNAL_URL", "");
    expect((await fetchHealth()).kind).toBe("unreachable");
  });
});
