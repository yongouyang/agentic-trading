/**
 * Phase 6A A2 — panel export (docs/phase-6a-plan.md).
 *
 * The pure half only: the writers are exercised end-to-end against the real
 * store by `pnpm -C apps/api panel:export` (run twice — the second must report
 * "nothing written", which is A2's idempotence criterion).
 *
 * What matters here is the universe derivation, because U1/U2 is the one place
 * this module could quietly disagree with the screen: U1 is read off the
 * replay's failure sets, not recomputed, and the nesting `U2 ⊆ U1` is what makes
 * a single three-valued mask lossless.
 */
import { describe, expect, it } from "vitest";
import type { ReplayDay, ScreenPick, SymbolSeries } from "@agentic-trading/quant-core";
import {
  cellNum,
  fingerprintOf,
  pastDividendFactors,
  maskForDay,
  reconcileMask,
  wideCsv,
} from "../../src/backtest/panel-export.js";

const pick = (symbol: string): ScreenPick =>
  ({ rank: 1, symbol, market: "US", score: 0, close: 1, sma50: 1, sma200: 1, mom20: 1, mom60: 1, vol60: 0.1, sharpe252: 1, adv20: 5e7, mdd252: -0.1, caDegraded: false }) as ScreenPick;

const day = (ranked: string[], excluded: Record<string, string[]>, date = "2026-01-05"): ReplayDay => ({
  date,
  ranked: ranked.map(pick),
  excludedCount: Object.keys(excluded).length,
  excludedByReason: { US: {}, HK: {} },
  excludedMarginal: { US: {}, HK: {} },
  excludedSole: { US: {}, HK: {} },
  excludedReasons: excluded,
});

describe("panel export — universe derivation", () => {
  it("nests U2 inside U1 and reads U1 from the failure SET, not the first failure", () => {
    const m = maskForDay(
      day(
        ["PASS"],
        {
          // Fails a SIGNAL gate only: has history, clears the liquidity floor ⇒ U1.
          TRENDY: ["HIGH_VOLATILITY", "BEARISH_ALIGNMENT", "NON_POSITIVE_SHARPE"],
          // Fails the liquidity floor ⇒ NOT U1 (U1 requires BOTH history and liquidity).
          THIN: ["LOW_LIQUIDITY"],
          // Availability is terminal ⇒ NOT U1, and its reasons list is exactly that.
          SHORT: ["INSUFFICIENT_HISTORY"],
        },
      ),
    );
    expect(m.get("PASS")).toBe(2);
    expect(m.get("TRENDY")).toBe(1);
    expect(m.get("THIN")).toBe(0);
    expect(m.get("SHORT")).toBe(0);
    // Invisible names are absent, so the CSV writer emits 0 for them.
    expect(m.has("ABSENT")).toBe(false);
  });

  it("a name is U1-ineligible if EITHER liquidity gate fails", () => {
    const m = maskForDay(day([], { BOTH: ["LOW_LIQUIDITY", "BEARISH_ALIGNMENT"], SHORT: ["INSUFFICIENT_HISTORY", "LOW_LIQUIDITY"] }));
    expect(m.get("BOTH")).toBe(0);
    expect(m.get("SHORT")).toBe(0);
  });
});

describe("panel export — CSV and fingerprint determinism", () => {
  it("formats numbers reproducibly, trimming zeros and blanking nulls", () => {
    expect(cellNum(1.5)).toBe("1.5");
    expect(cellNum(100)).toBe("100");
    expect(cellNum(0.123456789)).toBe("0.123457");
    expect(cellNum(null)).toBe("");
    expect(cellNum(undefined)).toBe("");
    expect(cellNum(Number.NaN)).toBe("");
    // A value that would print in exponential form without rounding.
    expect(cellNum(1e-7)).toBe("0");
    expect(cellNum(1234567.8901234)).toBe("1234567.890123");
  });

  it("emits a rectangular CSV with a date column, and is stable across calls", () => {
    const symbols = ["AAA", "BBB"];
    const dates = ["2026-01-05", "2026-01-06"];
    const v = (d: string, s: string) => (d === "2026-01-06" && s === "AAA" ? "" : "1.25");
    const once = wideCsv(symbols, dates, v);
    expect(once).toBe("date,AAA,BBB\n2026-01-05,1.25,1.25\n2026-01-06,,1.25\n");
    expect(wideCsv(symbols, dates, v)).toBe(once);
  });

  it("fingerprints the panel range and the symbol list, not just the count", () => {
    const r = { start: "2022-09-08", end: "2026-09-17", sessions: 1003 };
    const a = fingerprintOf(r, ["AAA", "BBB"], 2000);
    expect(a).toBe(fingerprintOf(r, ["AAA", "BBB"], 2000));
    // Same counts, different names ⇒ different panel.
    expect(fingerprintOf(r, ["AAA", "CCC"], 2000)).not.toBe(a);
    // Different window ⇒ different panel.
    expect(fingerprintOf({ ...r, end: "2026-09-18" }, ["AAA", "BBB"], 2000)).not.toBe(a);
    expect(a).toContain("2022-09-08_2026-09-17-1003s-2n-2000b-fwd-");
    // The ADJUSTMENT CONVENTION is part of the identity: it changes every price
    // while leaving range, symbols and bar count identical, so a fingerprint
    // without it would let a stale signals/ set be reused against data it was
    // never computed from.
    expect(fingerprintOf(r, ["AAA", "BBB"], 2000, "back")).not.toBe(a);
  });
});

describe("panel export — the forward anchor's residual is measured, not asserted", () => {
  const series = (symbol: string, dividends: SymbolSeries["dividends"]): SymbolSeries => ({
    symbol,
    market: "US",
    caDegraded: false,
    bars: [
      { date: "2024-01-02", open: 100, high: 100, low: 100, close: 100, volume: 1e6 },
      { date: "2024-01-03", open: 100, high: 100, low: 100, close: 100, volume: 1e6 },
      { date: "2024-01-04", open: 98, high: 98, low: 98, close: 98, volume: 1e6 },
    ] as SymbolSeries["bars"],
    dividends,
  });

  it("is 1 for a name with no PAST dividend and above 1 when one exists", () => {
    expect(pastDividendFactors([series("AAA", [])], "2024-01-04")).toEqual([1]);
    // Forward-anchored, so a dividend with ex-date AT OR BEFORE the query date
    // inflates the level by 1/(1 − D/P_prev) = 1/0.99 …
    const before = pastDividendFactors([series("BBB", [{ date: "2024-01-03", type: "DIVIDEND", amount: 1, currency: "USD" }])], "2024-01-04");
    expect(before[0]).toBeCloseTo(1 / 0.99, 10);
    // …and one with an ex-date AFTER it must not move the level at all. That
    // asymmetry is the entire difference between the two conventions.
    const after = pastDividendFactors([series("CCC", [{ date: "2024-01-04", type: "DIVIDEND", amount: 1, currency: "USD" }])], "2024-01-03");
    expect(after[0]).toBe(1);
  });

  it("skips names with no bar on the panel's first session", () => {
    const s = series("CCC", []);
    s.bars = s.bars.slice(1);
    expect(pastDividendFactors([s], "2024-01-02")).toEqual([]);
  });
});

describe("panel export — reconciliation with a stored run", () => {
  const stored = {
    id: 26,
    date: "2026-09-16",
    ok: 10,
    universeSize: 10,
    excluded: { INSUFFICIENT_HISTORY: 3, LOW_LIQUIDITY: 1, BEARISH_ALIGNMENT: 4 },
    resultSymbols: ["AAA", "BBB"],
    panelSymbols: 10,
  };

  it("matches only when the recovered eligible count AND every stored name agree", () => {
    const ok = reconcileMask(day(["AAA", "BBB"], { CCC: ["BEARISH_ALIGNMENT"], DDD: ["INSUFFICIENT_HISTORY"] }), stored);
    expect(ok.status).toBe("match");
    expect(ok.storedEligible).toBe(2); // 10 − (3+1+4)
    expect(ok.maskU2).toBe(2);
    expect(ok.maskU1).toBe(3); // AAA, BBB, CCC — DDD has no history, so not U1
    expect(ok.storedU1Floor).toBe(6); // 10 − (3 + 1)
    expect(ok.missingFromMaskU2).toEqual([]);
  });

  it("does not compare U2 against `ok`, which counts names FED to the screen", () => {
    // Regression: comparing `stored.ok` to U2 reported a false MISMATCH on both
    // real lanes (US ok 555 vs U2 111). Production's eligible count is only
    // recoverable from its own first-failure census.
    const u2 = new Array(111).fill(0).map((_, i) => `S${i}`);
    const real = { ...stored, ok: 555, universeSize: 555, excluded: { BEARISH_ALIGNMENT: 371, DEEP_DRAWDOWN: 19, HIGH_VOLATILITY: 41, INSUFFICIENT_HISTORY: 3, NEGATIVE_MOMENTUM: 6, NON_POSITIVE_SHARPE: 4 }, panelSymbols: 555, resultSymbols: u2.slice(0, 40) };
    expect(reconcileMask(day(u2, {}), real).storedEligible).toBe(111);
    expect(reconcileMask(day(u2, {}), real).status).toBe("match");
  });

  it("reports a count mismatch and any stored name the mask does not mark U2", () => {
    const bad = reconcileMask(day(["AAA"], { BBB: ["NON_POSITIVE_SHARPE"] }), stored);
    expect(bad.status).toBe("mismatch");
    expect(bad.missingFromMaskU2).toEqual(["BBB"]);
    expect(bad.differences[0]).toContain("stored 2 (ok 10 − census 8) vs mask U2 1");
  });

  it("reports the symbol-axis delta rather than asserting U1 equal to production's floor", () => {
    // HK's real shape: 145 stored instruments with bars vs 141 in the run's universe.
    const hk = { ...stored, ok: 141, universeSize: 141, panelSymbols: 145, excluded: { BEARISH_ALIGNMENT: 136, INSUFFICIENT_HISTORY: 3 } };
    const r = reconcileMask(day(["AAA", "BBB"], { CCC: ["BEARISH_ALIGNMENT"], DDD: ["INSUFFICIENT_HISTORY"] }), hk);
    expect(r.extraSymbols).toBe(4);
    expect(r.storedEligible).toBe(2); // 141 − 139
    expect(r.maskU1).toBe(3); // 3 of the 4 extras are U1; U1 is not asserted equal
    expect(r.storedU1Floor).toBe(138); // 141 − (3 + 0)
    expect(r.status).toBe("match"); // U1 differing from the floor is NOT a failure
  });

  it("does not call a session outside the replay window a match", () => {
    const out = reconcileMask(undefined, stored);
    expect(out.status).toBe("outside-window");
    expect(out.differences[0]).toContain("2026-09-16");
  });
});
