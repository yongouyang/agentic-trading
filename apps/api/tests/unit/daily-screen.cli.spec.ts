/**
 * Daily-screen CLI wiring tests: the fail-closed store guard (added after the
 * 2026-09-01 run-6 incident, where a dummy run rewrote the HK lane's real 5y
 * series with 30 synthetic bars per name and the header still looked healthy)
 * and the provenance label helper.
 */
import { describe, expect, it } from "vitest";
import { assessLaneDegraded, assertRealProviderStore, isDummyProviderLabel } from "../../src/cli/daily-screen.js";

// W3a (docs/ops-hardening-plan.md): a single date wiped across most of a lane
// must mark the run degraded. The numbers below are the real measured cases.
describe("assessLaneDegraded — whole-universe session gap", () => {
  const byDate = (entries: [string, number][]) => new Map(entries);

  it("01: 2026-09-10 US, 555/555 dropped 2026-09-09 => degraded with a dated gap", () => {
    const r = assessLaneDegraded({ nullCloseByDate: byDate([["2026-09-09", 555]]), universeSize: 555, fetchFailedCount: 0 });
    expect(r.degraded).toBe(true);
    expect(r.wholeUniverseGap).toBe(true);
    expect(r.gapDate).toBe("2026-09-09");
    expect(r.gapCount).toBe(555);
  });

  it("a large TOTAL spread thinly is not a gap — concentration is the trigger", () => {
    // 1110 drops across three dates on a 1000-name lane: 40/35/36% per date.
    // Volume alone must never trip it, only concentration on one date.
    const r = assessLaneDegraded({ nullCloseByDate: byDate([["2026-09-08", 400], ["2026-09-09", 350], ["2026-09-10", 360]]), universeSize: 1000, fetchFailedCount: 0 });
    expect(r.wholeUniverseGap).toBe(false);
    expect(r.degraded).toBe(false);
    expect(r.gapDate).toBeNull();
  });

  it("the real 09-06 US and 09-09 HK shapes stay clean (per-date maxima, not totals)", () => {
    // Measured from apps/api/reports/*.json: 09-06 US dropped 61 bars but its
    // worst DATE held only 3 of 555; 09-09 HK dropped 105 of 131 but spread
    // with a worst date of 19. Totals are loud, concentration is the signal.
    expect(assessLaneDegraded({ nullCloseByDate: byDate([["2026-08-25", 3], ["2026-08-26", 3]]), universeSize: 555, fetchFailedCount: 0 }).degraded).toBe(false);
    expect(assessLaneDegraded({ nullCloseByDate: byDate([["2026-09-08", 19], ["2025-10-24", 16]]), universeSize: 131, fetchFailedCount: 0 }).degraded).toBe(false);
  });

  it("boundary is strict (>50%, not >=50%)", () => {
    expect(assessLaneDegraded({ nullCloseByDate: byDate([["d", 50]]), universeSize: 100, fetchFailedCount: 0 }).wholeUniverseGap).toBe(false);
    expect(assessLaneDegraded({ nullCloseByDate: byDate([["d", 51]]), universeSize: 100, fetchFailedCount: 0 }).wholeUniverseGap).toBe(true);
  });

  it("picks the worst date when several are present", () => {
    const r = assessLaneDegraded({ nullCloseByDate: byDate([["a", 10], ["b", 900], ["c", 20]]), universeSize: 1000, fetchFailedCount: 0 });
    expect(r.gapDate).toBe("b");
  });

  it("the pre-existing 2% fetch-failure rule still applies (no null drops)", () => {
    expect(assessLaneDegraded({ nullCloseByDate: byDate([]), universeSize: 555, fetchFailedCount: 12 }).degraded).toBe(true);
    expect(assessLaneDegraded({ nullCloseByDate: byDate([]), universeSize: 555, fetchFailedCount: 11 }).degraded).toBe(false);
  });
});

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
