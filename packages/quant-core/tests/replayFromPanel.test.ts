/**
 * Phase 6A A4 — panel → ranked days, and the look-ahead invariant.
 *
 * The invariant block is the important one. A checker that cannot fail has not
 * been tested, so it is run against three hand-written signal functions: two
 * trailing-only ones that must pass, and two that peek (a centred window and a
 * one-row-ahead peek) that it must reject with a located violation.
 */
import { describe, expect, it } from "vitest";
import {
  daysFromSignals,
  defaultSampleIndices,
  eligibleUnder,
  forwardFromPanel,
  trailingPrefixHolds,
  type MaskMatrix,
  type NumberMatrix,
  type SignalFn,
} from "../src/replayFromPanel.js";
import { forwardReturn } from "../src/replay.js";
import { icSeries, icStats } from "../src/ic.js";

const DATES = Array.from({ length: 12 }, (_, i) => `2024-01-${String(i + 2).padStart(2, "0")}`);
const SYMBOLS = ["AAA", "BBB", "CCC"];

/** `values[d][s]` from a per-symbol function. */
function matrix(dates: string[], symbols: string[], f: (d: number, s: number) => number | null): NumberMatrix {
  return { dates, symbols, values: dates.map((_, d) => symbols.map((__, s) => f(d, s))) };
}

function maskMatrix(dates: string[], symbols: string[], f: (d: number, s: number) => 0 | 1 | 2 | null): MaskMatrix {
  return { dates, symbols, values: dates.map((_, d) => symbols.map((__, s) => f(d, s))) };
}

describe("universe masks", () => {
  it("reads U1 as code >= 1 and U2 as code === 2, with null meaning 'not evaluated'", () => {
    expect(eligibleUnder(2, "U2")).toBe(true);
    expect(eligibleUnder(1, "U2")).toBe(false);
    expect(eligibleUnder(1, "U1")).toBe(true);
    expect(eligibleUnder(0, "U1")).toBe(false);
    expect(eligibleUnder(null, "U1")).toBe(false);
    expect(eligibleUnder(null, "U2")).toBe(false);
  });
});

describe("forwardFromPanel", () => {
  it("builds a ratio-correct series without re-applying the dividend adjustment", () => {
    const close = matrix(DATES, ["AAA"], (d) => 100 + d); // 100, 101, 102, …
    const forward = forwardFromPanel(close);
    expect(forward.has("AAA")).toBe(true);
    // 5 sessions after 2024-01-02 (index 0 → index 5): 105/100 - 1.
    expect(forwardReturn(forward.get("AAA")!, DATES[0]!, 5)).toBeCloseTo(105 / 100 - 1, 12);
    // The last 5 sessions have no 5-day label — the conservative direction.
    expect(forwardReturn(forward.get("AAA")!, DATES[DATES.length - 1]!, 5)).toBeNull();
  });

  it("skips null cells so a gapped symbol still yields a series, and drops a symbol with < 2 closes", () => {
    const close = matrix(DATES, ["AAA", "BBB"], (d, s) => {
      if (s === 0) return d === 3 ? null : 100 + d;
      return d === 0 ? 50 : null; // BBB: a single usable close
    });
    const forward = forwardFromPanel(close);
    expect(forward.has("AAA")).toBe(true);
    expect(forward.has("BBB")).toBe(false);
    const series = forward.get("AAA")!;
    expect(series.dates).not.toContain(DATES[3]);
    // Horizon counts AVAILABLE sessions, not calendar sessions — the same
    // convention `buildForwardSeries` uses. AAAA's row 3 is missing, so h = 1
    // from 2024-01-04 (close 102) lands on 2024-01-06 (close 104), not on the
    // absent 2024-01-05.
    expect(forwardReturn(series, DATES[2]!, 1)).toBeCloseTo(104 / 102 - 1, 12);
  });
});

describe("daysFromSignals", () => {
  const signals = matrix(DATES, SYMBOLS, (d, s) => d * 10 + s);
  const mask = maskMatrix(DATES, SYMBOLS, (d, s) => (s === 0 ? 2 : s === 1 ? 1 : 0));

  it("ranks by descending score and assigns 1-based ranks", () => {
    const days = daysFromSignals({ signals, mask, universe: "U1", minBreadth: 2 });
    const day = days[0]!;
    expect(day.date).toBe(DATES[0]);
    expect(day.ranked.map((r) => r.symbol)).toEqual(["BBB", "AAA"]); // 1 > 0
    expect(day.ranked.map((r) => r.rank)).toEqual([1, 2]);
  });

  it("selects the universe: U1 keeps codes 1 and 2, U2 only 2", () => {
    expect(daysFromSignals({ signals, mask, universe: "U1", minBreadth: 1 })[0]!.ranked.map((r) => r.symbol)).toEqual(["BBB", "AAA"]);
    const u2 = daysFromSignals({ signals, mask, universe: "U2", minBreadth: 1 })[0]!;
    expect(u2.ranked.map((r) => r.symbol)).toEqual(["AAA"]);
  });

  it("drops a day below the breadth floor from this alpha's series only", () => {
    // U2 leaves exactly one eligible name, so the default floor (5) drops every day…
    expect(daysFromSignals({ signals, mask, universe: "U2" })).toEqual([]);
    // …while a floor of 1 keeps them, which is how the floor is shown to be the gate.
    expect(daysFromSignals({ signals, mask, universe: "U2", minBreadth: 1 }).length).toBe(DATES.length);
  });

  it("treats a null or non-finite score as 'not computable', not as zero", () => {
    const sparse = matrix(DATES, SYMBOLS, (d, s) => (s === 2 ? null : s === 1 ? Number.NaN : d));
    const days = daysFromSignals({ signals: sparse, mask, universe: "U1", minBreadth: 1 });
    expect(daysFromSignals({ signals: sparse, mask, universe: "U1", minBreadth: 1 })[0]!.ranked.map((r) => r.symbol)).toEqual(["AAA"]);
    expect(days[0]!.ranked).toHaveLength(1);
  });

  it("skips sessions outside the replay window, where the mask is null", () => {
    const windowed = maskMatrix(DATES, SYMBOLS, (d, s) => (d < 3 ? null : s === 0 ? 2 : 1));
    const days = daysFromSignals({ signals, mask: windowed, universe: "U1", minBreadth: 1 });
    expect(days.map((d) => d.date)).toEqual(DATES.slice(3));
  });

  it("breaks score ties deterministically by symbol, so a re-run cannot reorder them", () => {
    const tied = matrix(DATES, SYMBOLS, () => 1);
    const a = daysFromSignals({ signals: tied, mask, universe: "U1", minBreadth: 1 })[0]!;
    const b = daysFromSignals({ signals: tied, mask, universe: "U1", minBreadth: 1 })[0]!;
    expect(a.ranked.map((r) => r.symbol)).toEqual(["AAA", "BBB"]);
    expect(a).toEqual(b);
  });

  it("feeds the Phase-4 IC engine unchanged (the reason the adapter exists)", () => {
    const horizon = 2;
    // Six symbols, five of them U2-eligible, so the day clears MIN_IC_BREADTH (5)
    // — the same floor the screen path lives under. Returns vary by BOTH day and
    // symbol, so the rank correlation is well defined.
    const syms = ["A", "B", "C", "D", "E", "F"];
    const close6 = matrix(DATES, syms, (d, s) =>
      100 * Math.exp(0.01 * (s + 1) * d + 0.05 * Math.sin(d * 0.7 + s)),
    );
    const mask6 = maskMatrix(DATES, syms, (d, s) => (s < 5 ? 2 : 0));
    const forward = forwardFromPanel(close6);
    // The signal must be the exact forward RETURN, not a price difference: a
    // difference `c2 − c0` and a return `c2/c0 − 1` rank symbols differently
    // whenever the base prices differ, so a difference signal is only ~0.9
    // correlated with the label. That is a real property of the panel, and it is
    // why 6A's alphas are z-scored/ranked rather than compared in levels.
    const eligible = (d: number, s: number) => close6.values[d + horizon]?.[s]! / close6.values[d]![s]! - 1;

    const long = matrix(DATES, syms, (d, s) => eligible(d, s));
    const days = daysFromSignals({ signals: long, mask: mask6, universe: "U2" });
    const points = icSeries(days, forward, horizon);

    // Every session with a label, and no session without one: the last `horizon`
    // sessions have no forward return, which is what excludes a delisting's
    // catastrophic tail from every IC observation.
    expect(points).toHaveLength(DATES.length - horizon);
    expect(points.map((p) => p.date)).toEqual(DATES.slice(0, DATES.length - horizon));
    for (const p of points) {
      expect(p.ic).toBeCloseTo(1, 12);
      expect(p.n).toBe(5); // the U2 set, not all six symbols
    }

    // The same signal negated must score −1, which is what proves the sign and
    // the symbol matching rather than a coincidence of ordering.
    const short = matrix(DATES, syms, (d, s) => -eligible(d, s));
    for (const p of icSeries(daysFromSignals({ signals: short, mask: mask6, universe: "U2" }), forward, horizon)) {
      expect(p.ic).toBeCloseTo(-1, 12);
    }

    // A real trailing factor (2-session past return) is not perfectly predictive,
    // so the IC series has variance and the Phase-4 statistics path runs on it.
    const trailing = matrix(DATES, syms, (d, s) => close6.values[d]?.[s]! - (close6.values[d - 2]?.[s] ?? close6.values[d]?.[s]!));
    const tPoints = icSeries(daysFromSignals({ signals: trailing, mask: mask6, universe: "U2" }), forward, horizon);
    expect(tPoints.length).toBeGreaterThan(5);
    const stats = icStats(tPoints, horizon)!;
    expect(stats).not.toBeNull();
    expect(stats.days).toBe(tPoints.length);
    expect(stats.meanBreadth).toBe(5);
    expect(Number.isFinite(stats.nwT)).toBe(true);
  });
});

describe("the look-ahead invariant — and the harness's ability to fail", () => {
  const closes = matrix(DATES, SYMBOLS, (d, s) => 100 + 2 * d + 0.5 * s);
  const fields = { close: closes };

  /** Trailing mean: row d uses rows d-win+1 … d. Must pass. */
  const trailingMean = (win: number): SignalFn => (f, dates, symbols) => {
    const close = f.close!;
    return dates.map((_, d) =>
      symbols.map((__, s) => {
        if (d + 1 < win) return null;
        let sum = 0;
        for (let k = d - win + 1; k <= d; k++) {
          const v = close.values[k]?.[s];
          if (v == null) return null;
          sum += v;
        }
        return sum / win;
      }),
    );
  };

  /** First difference: row d uses rows d-1 and d. Must pass. */
  const diff: SignalFn = (f, dates, symbols) => {
    const close = f.close!;
    return dates.map((_, d) =>
      symbols.map((__, s) => {
        const a = close.values[d - 1]?.[s];
        const b = close.values[d]?.[s];
        return a == null || b == null ? null : b - a;
      }),
    );
  };

  /** CENTRED mean: row d uses rows d-1 … d+1. Look-ahead by construction. */
  const centredMean: SignalFn = (f, dates, symbols) => {
    const close = f.close!;
    return dates.map((_, d) =>
      symbols.map((__, s) => {
        let sum = 0;
        for (let k = d - 1; k <= d + 1; k++) {
          const v = close.values[k]?.[s];
          if (v == null) return null;
          sum += v;
        }
        return sum / 3;
      }),
    );
  };

  /** One-row peek: row d reports row d+1's close. Look-ahead by construction. */
  const peek: SignalFn = (f, dates, symbols) => {
    const close = f.close!;
    return dates.map((_, d) => symbols.map((__, s) => close.values[d + 1]?.[s] ?? null));
  };

  it("passes a trailing-only signal, and says how much it compared", () => {
    const r = trailingPrefixHolds(trailingMean(3), fields);
    expect(r.holds).toBe(true);
    expect(r.firstViolation).toBeNull();
    expect(r.checked.length).toBeGreaterThan(1);
    expect(r.checked).toContain(DATES[DATES.length - 1]);
    expect(r.comparedCells).toBeGreaterThan(0);

    expect(trailingPrefixHolds(diff, fields).holds).toBe(true);
  });

  it("REJECTS a centred window, and locates the violation", () => {
    const r = trailingPrefixHolds(centredMean, fields);
    expect(r.holds).toBe(false);
    expect(r.firstViolation).not.toBeNull();
    expect(SYMBOLS).toContain(r.firstViolation!.symbol);
    expect(DATES).toContain(r.firstViolation!.date);
    // The truncated run cannot see the row after its own end, so it returns null
    // where the full run has a number.
    expect(r.firstViolation!.truncated).toBeNull();
    expect(r.firstViolation!.full).not.toBeNull();
  });

  it("REJECTS a one-row peek", () => {
    const r = trailingPrefixHolds(peek, fields);
    expect(r.holds).toBe(false);
    // The very first sampled truncation already exposes it: with one row of
    // input the peeked row does not exist, so the truncated run returns null
    // where the full run has a price.
    expect(r.firstViolation!.date).toBe(DATES[0]);
    expect(r.firstViolation!.truncated).toBeNull();
    expect(r.firstViolation!.full).toBe(closes.values[1]?.[0]);
  });

  it("treats 'both missing' as agreement, so warmup NaN does not read as a leak", () => {
    // A signal that is null for the first 5 rows and trailing after: the nulls
    // must compare equal, not count as violations.
    const warm = trailingMean(3);
    const r = trailingPrefixHolds(warm, fields, { atIndices: [1, 2, 4] });
    expect(r.holds).toBe(true);
  });

  it("tightens with tolerance, and shows why a SPREAD of truncation points is sampled", () => {
    // The classic shape of a subtle leak: the value depends on how many rows the
    // function was handed. Here that is deliberate; in a real alpha it is a
    // normalisation by the sample length.
    const lengthDependent: SignalFn = (f, dates, symbols) => {
      const base = trailingMean(3)(f, dates, symbols);
      return base.map((row) => row.map((v) => (v == null ? null : v * (1 + 0.01 * dates.length))));
    };
    // At an interior truncation the two runs disagree by ~7.7 % — a violation at
    // any sane tolerance, and still one at 1e-2.
    expect(trailingPrefixHolds(lengthDependent, fields, { atIndices: [3] }).holds).toBe(false);
    expect(trailingPrefixHolds(lengthDependent, fields, { atIndices: [3], tolerance: 1e-2 }).holds).toBe(false);
    expect(trailingPrefixHolds(lengthDependent, fields, { atIndices: [3], tolerance: 0.1 }).holds).toBe(true);
    // At the LAST index the truncated and full inputs have the same length, so
    // this class of leak is invisible there. A checker that only ever truncated
    // at the end would pass it — which is exactly why the default sampling is a
    // spread through the window rather than a single point.
    expect(trailingPrefixHolds(lengthDependent, fields, { atIndices: [DATES.length - 1] }).holds).toBe(true);
  });

  it("samples a spread of truncation points, always including the last", () => {
    const idx = defaultSampleIndices(1003);
    expect(idx.length).toBeLessThanOrEqual(11);
    expect(idx[idx.length - 1]).toBe(1002);
    expect(idx[0]).toBe(0);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(defaultSampleIndices(1)).toEqual([0]);
  });

  it("throws rather than silently passing when there is nothing to check", () => {
    expect(() => trailingPrefixHolds(diff, {})).toThrow(/no fields/);
  });
});
