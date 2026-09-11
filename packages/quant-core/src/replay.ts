/**
 * Point-in-time replay driver — Phase 4 (docs/phase-4-plan.md).
 *
 * `runScreen` is a pure function of bars-up-to-day-T, so the backtest is: for
 * each historical session T, feed the screen exactly what production would have
 * seen at T, and record the ranked output. Signal logic stays single-source —
 * this module never reimplements scoring, it only slices history and calls
 * `runScreen`.
 *
 * Three correctness properties, each worth stating because each is a way this
 * could silently lie:
 *
 * 1. **Point-in-time adjustment.** Each day's adjusted series is derived from
 *    only the corporate actions with ex-date ≤ T. Using a later dividend to
 *    adjust an earlier price is look-ahead. The replay slices CAs the same way
 *    it slices bars.
 *
 * 2. **Truncation is exact, not approximate.** Every indicator window is ≤ 252
 *    sessions (sma200, mom60, sharpe252, mdd252, adv20), so a trailing slice of
 *    REPLAY_TRUNCATION_BARS bars yields identical indicator values *and*
 *    identical eligibility (the `length < minBars` test is preserved because a
 *    symbol with ≥252 bars still has ≥252 in the slice, and one with fewer is
 *    unchanged). This is what makes 1031 days × ~683 symbols tractable.
 *    Verified against the full series by test, not assumed.
 *
 * 3. **Forward returns are anchor-invariant.** Back-adjustment factors are
 *    multiplicative and anchored at the latest bar, so for the ratio between two
 *    dates every factor outside the interval cancels:
 *      adj_F(T+h)/adj_F(T) = raw(T+h)/raw(T) × 1/Π{ex in (T, T+h]} f
 *    which is the total return including dividends — the same value for *any*
 *    anchor. So the forward-return series may be built once from the
 *    full-history adjusted series without leaking future information into the
 *    return between T and T+h.
 */
import { Bar, CorporateAction } from "./types.js";
import { deriveAdjustedBars } from "./adjustment.js";
import { Market, ScreenInput, ScreenPick, runScreen } from "./screening.js";

/** Trailing bars retained per symbol per replay day. All screen windows are
 *  ≤ SCREEN_PARAMS.minBars (252), so this is exactly equivalent to passing the
 *  full series — see the header note and the equivalence test. */
export const REPLAY_TRUNCATION_BARS = 252;

export interface SymbolSeries {
  symbol: string;
  market: Market;
  caDegraded: boolean;
  /** Raw bars, ascending by date, as stored. */
  bars: Bar[];
  /** DIVIDEND corporate actions only (R1: splits are never applied locally),
   *  ascending by ex-date. */
  dividends: CorporateAction[];
}

export interface ReplayDay {
  date: string;
  /** Every eligible name, ranked (topN is not applied — the IC gate needs the
   *  whole eligible set; the portfolio rule re-applies its own top-N). */
  ranked: ScreenPick[];
  excludedCount: number;
  /** Rejections by *reason*, per market, for the Phase-4b D3 census. `runScreen`
   *  has always computed this; the replay used to throw it away, which is why the
   *  project never knew which gate was responsible for breadth 180 (US) / 25
   *  (HK) — the single fact that determines the whole lane's statistical power.
   *  Per market because a replay may carry both lanes at once. */
  excludedByReason: Record<Market, Record<string, number>>;
}

/**
 * Aggregate per-day exclusions for one lane into a census (Phase 4b D3). Pure.
 * Descriptive only: it describes the screen's *inputs*, not returns, and may not
 * be used to choose a gate to relax and then re-test IC on the same window.
 */
export interface ExclusionCensus {
  /** reason → total rejections across the window. */
  byReason: Record<string, number>;
  byYear: { year: string; byReason: Record<string, number> }[];
  total: number;
  /** Σ ranked (screen-eligible) observations — the exact denominator for the
   *  reject share, so no invented universe size is involved. */
  eligible: number;
  days: number;
}

export function exclusionCensus(days: ReplayDay[], market: Market): ExclusionCensus {
  const byReason: Record<string, number> = {};
  const years = new Map<string, Record<string, number>>();
  let total = 0;
  let eligible = 0;
  for (const day of days) {
    eligible += day.ranked.reduce((a, p) => a + (p.market === market ? 1 : 0), 0);
    const year = day.date.slice(0, 4);
    const bucket = years.get(year) ?? {};
    years.set(year, bucket);
    for (const [reason, n] of Object.entries(day.excludedByReason[market] ?? {})) {
      byReason[reason] = (byReason[reason] ?? 0) + n;
      bucket[reason] = (bucket[reason] ?? 0) + n;
      total += n;
    }
  }
  return {
    byReason,
    byYear: [...years.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([year, r]) => ({ year, byReason: r })),
    total,
    eligible,
    days: days.length,
  };
}

/** Adjusted prices with a date index — the forward-return / mark lookup. */
export interface ForwardSeries {
  dates: string[];
  index: Map<string, number>;
  closes: number[];
  /** Adjusted opens, aligned with `dates` (null where the provider had none).
   *  Needed for the T+1-open fill convention. */
  opens: (number | null)[];
}

/**
 * Build the full-history adjusted series once per symbol. Anchor-invariant, so
 * this is safe for forward returns (see header note 3).
 */
export function buildForwardSeries(bars: Bar[], dividends: CorporateAction[]): ForwardSeries {
  const adjusted = deriveAdjustedBars(bars, dividends);
  const dates: string[] = [];
  const closes: number[] = [];
  const opens: (number | null)[] = [];
  const index = new Map<string, number>();
  for (const b of adjusted) {
    if (b.close == null) continue;
    index.set(b.date, dates.length);
    dates.push(b.date);
    closes.push(b.close);
    opens.push(b.open);
  }
  return { dates, index, closes, opens };
}

/** Index of the last session at or before `date`, or -1 when none exists. */
export function indexAtOrBefore(series: ForwardSeries, date: string): number {
  const dates = series.dates;
  let lo = 0;
  let hi = dates.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid]! <= date) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** Total return over `horizon` sessions starting at `date`; null when the
 *  horizon runs past the end of history (the last `h` sessions have no label). */
export function forwardReturn(series: ForwardSeries, date: string, horizon: number): number | null {
  const i = series.index.get(date);
  if (i === undefined) return null;
  const j = i + horizon;
  if (j >= series.closes.length) return null;
  const base = series.closes[i]!;
  if (base === 0) return null;
  return series.closes[j]! / base - 1;
}

/**
 * Replay the screen over `dates` (market session calendar, ascending).
 *
 * Pointers into each symbol's bars and dividends advance monotonically across
 * the loop, so total slicing work is linear in symbols × sessions rather than
 * quadratic in history length.
 */
export function replayScreen(
  dates: string[],
  series: SymbolSeries[],
  truncationBars: number = REPLAY_TRUNCATION_BARS,
): ReplayDay[] {
  const n = series.length;
  const barPtr = new Int32Array(n).fill(-1);
  const divStart = new Int32Array(n);
  const divEnd = new Int32Array(n);
  const days: ReplayDay[] = [];

  // Exclusions carry no market of their own, so attribute them via the symbol.
  // Needed because runBacktest may replay both lanes in one pass, while the
  // census is per lane (it exists to explain that lane's breadth).
  const marketBySymbol = new Map<string, Market>();
  for (const s of series) marketBySymbol.set(s.symbol, s.market);

  for (const date of dates) {
    const inputs: ScreenInput[] = [];

    for (let s = 0; s < n; s++) {
      const sym = series[s]!;
      const bars = sym.bars;

      // Advance to the last bar with date <= T (history seen at T).
      let p = barPtr[s]!;
      while (p + 1 < bars.length && bars[p + 1]!.date <= date) p++;
      barPtr[s] = p;
      if (p < 0) continue; // no history yet — symbol invisible at T

      const lo = Math.max(0, p + 1 - truncationBars);
      const barsSlice = bars.slice(lo, p + 1);
      const windowStart = barsSlice[0]!.date;

      // Dividends with ex-date <= T (PIT), minus those that cannot affect any
      // bar in the slice: a dividend with ex-date < windowStart satisfies
      // ex <= b.date for every b in the slice, so it contributes no factor —
      // dropping it is exact, not a shortcut.
      let de = divEnd[s]!;
      while (de < sym.dividends.length && sym.dividends[de]!.date <= date) de++;
      divEnd[s] = de;
      let ds = divStart[s]!;
      while (ds < de && sym.dividends[ds]!.date < windowStart) ds++;
      divStart[s] = ds;

      inputs.push({
        symbol: sym.symbol,
        market: sym.market,
        adjustedBars: deriveAdjustedBars(barsSlice, sym.dividends.slice(ds, de)),
        rawBars: barsSlice,
        caDegraded: sym.caDegraded,
      });
    }

    const screen = runScreen(inputs, { topN: Number.MAX_SAFE_INTEGER });
    const excludedByReason: Record<Market, Record<string, number>> = { US: {}, HK: {} };
    for (const ex of screen.excluded) {
      const m = marketBySymbol.get(ex.symbol);
      if (!m) continue;
      excludedByReason[m][ex.reason] = (excludedByReason[m][ex.reason] ?? 0) + 1;
    }
    days.push({ date, ranked: screen.ranked, excludedCount: screen.excluded.length, excludedByReason });
  }

  return days;
}
