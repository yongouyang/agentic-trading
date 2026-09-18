/**
 * Panel → ranked days, and the look-ahead invariant — Phase 6A (A4).
 *
 * Phase 6A reuses the Phase-4 evaluation engine (`ic.ts`, `replay.ts`) rather
 * than writing a second one. That requires one adapter: the screen path gets its
 * ranked days from `replayScreen` (which calls the production screen), while the
 * factor path gets its factor VALUES from the Python bridge and its universe from
 * the panel's mask. Everything downstream — rank IC, Newey–West t, spread,
 * by-year, power floors — is then the same code, which is the only way the
 * deciding number can be single-source.
 *
 * ## Why this file does not build `ReplayDay`s
 *
 * The plan's A4 row says "panel + mask + dates → `ReplayDay[]`". It does not,
 * deliberately: `ScreenPick` carries sma50, sma200, mom20, mom60, vol60,
 * sharpe252, adv20, mdd252 and `caDegraded`, none of which exist on the factor
 * path, and fabricating eight screen metrics to satisfy a type would be a lie
 * encoded in the type system. Instead `ScoredDay` names the three fields the
 * ranking-power readers actually use — symbol, score, rank — and `ReplayDay` is
 * structurally assignable to it, so both paths feed one engine.
 *
 * ## The look-ahead invariant, and what it can and cannot catch
 *
 * `trailingPrefixHolds` recomputes a signal function on a panel truncated at T
 * and compares the prefix with the full run. A trailing-only function must agree
 * to tolerance; a centred window, a `shift(-k)`, or a backward fill must not.
 *
 * **It is a *harness* test, and the harness can fail** — the unit tests include a
 * deliberately centred alpha that it must reject, because a checker that cannot
 * fail has not been tested.
 *
 * One honest ceiling, which is a consequence of amendment A2-1 rather than of
 * this code: on the REAL panel, truncation is not a no-op on the data. The
 * dividend back-adjustment is anchored at the last bar, so cutting the panel at T
 * rescales every remaining row of each symbol by that symbol's future-dividend
 * factor `Π{ex-date > T}(1 − D/P)`. Two runs over the real panel therefore differ
 * by a per-symbol constant even for a perfectly trailing alpha, and the invariant
 * is only cleanly readable there for signal functions that are invariant to a
 * per-symbol scaling (which is exactly the `ts_mean`/`ts_std`/`ts_corr`/`ts_rank`
 * class). This is the second consequence of the anchor choice, and it is one more
 * reason the fork in amendment A2-1 is worth a decision rather than a shrug.
 */
import { ForwardSeries, ScoredDay, ScoredSymbol } from "./replay.js";
import { MIN_IC_BREADTH } from "./ic.js";
import { proportionalCutoff } from "./ic.js";

/** A rectangular `date × symbol` matrix. `null` means "not computable at T" —
 *  distinct from 0, which is a real signal value. */
export interface Matrix<T> {
  dates: string[];
  symbols: string[];
  values: T[][];
}

/** Factor values from the bridge, or prices from the panel export. */
export type NumberMatrix = Matrix<number | null>;
/** The eligibility mask: 0 not U1, 1 U1 only, 2 U1 and screen-eligible, null
 *  outside the replay window (not evaluated — which is NOT the same as 0). */
export type MaskMatrix = Matrix<0 | 1 | 2 | null>;

export type Universe = "U1" | "U2";

/** Eligible under the requested universe. U2 ⊆ U1 by construction, so U2 is a
 *  strict subset test, not a second rule. */
export function eligibleUnder(code: 0 | 1 | 2 | null, universe: Universe): boolean {
  if (code == null) return false;
  return universe === "U2" ? code === 2 : code >= 1;
}

/**
 * Forward-return series per symbol, straight from the panel's adjusted close.
 *
 * **No further adjustment is applied, and that is correct**: the panel's close is
 * already dividend-adjusted, and `forwardReturn` is a ratio of two values from
 * the same series, so every adjustment factor outside the interval cancels
 * (`replay.ts` header note 3). Passing these closes through `deriveAdjustedBars`
 * a second time would double-count the dividends.
 *
 * Symbols with fewer than two usable closes are omitted: they cannot produce a
 * return at any horizon.
 */
export function forwardFromPanel(panel: NumberMatrix): Map<string, ForwardSeries> {
  const out = new Map<string, ForwardSeries>();
  const { dates, symbols, values } = panel;
  for (let s = 0; s < symbols.length; s++) {
    const seriesDates: string[] = [];
    const closes: number[] = [];
    const opens: (number | null)[] = [];
    const index = new Map<string, number>();
    for (let d = 0; d < dates.length; d++) {
      const v = values[d]?.[s];
      if (v == null || !Number.isFinite(v)) continue;
      index.set(dates[d]!, seriesDates.length);
      seriesDates.push(dates[d]!);
      closes.push(v);
      opens.push(null);
    }
    if (closes.length < 2) continue;
    out.set(symbols[s]!, { dates: seriesDates, index, closes, opens });
  }
  return out;
}

export interface DaysFromSignalsOptions {
  /** Factor values, [dateIdx][symbolIdx]. */
  signals: NumberMatrix;
  /** Eligibility mask, aligned with `signals`. */
  mask: MaskMatrix;
  universe: Universe;
  /** Days with fewer eligible scored names are dropped from THIS alpha's series
   *  only. Defaults to the Phase-4 floor, unchanged. */
  minBreadth?: number;
}

/**
 * Eligible, scored names per session, ranked by the factor.
 *
 * Ranking is by descending score with the symbol as a deterministic tie-break, so
 * a re-run cannot reorder equal scores. Rank (not score) is what the
 * proportional top-decile spread reads, so the tie-break is load-bearing rather
 * than cosmetic.
 *
 * No forward-return filter is applied here: that needs `horizon`, and `icSeries`
 * already drops names whose label is unavailable — which is also what excludes a
 * delisting's catastrophic tail from every IC observation (a disclosed,
 * conservative direction).
 */
export function daysFromSignals(opts: DaysFromSignalsOptions): ScoredDay[] {
  const { dates, symbols, values } = opts.signals;
  const minBreadth = opts.minBreadth ?? MIN_IC_BREADTH;
  const out: ScoredDay[] = [];

  for (let d = 0; d < dates.length; d++) {
    const scored: ScoredSymbol[] = [];
    for (let s = 0; s < symbols.length; s++) {
      if (!eligibleUnder(opts.mask.values[d]?.[s] ?? null, opts.universe)) continue;
      const v = values[d]?.[s];
      if (v == null || !Number.isFinite(v)) continue;
      scored.push({ symbol: symbols[s]!, score: v, rank: 0 });
    }
    if (scored.length < minBreadth) continue;
    scored.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
    for (let i = 0; i < scored.length; i++) scored[i]!.rank = i + 1;
    out.push({ date: dates[d]!, ranked: scored });
  }
  return out;
}

/** Top-decile cutoff actually used on a given day — re-exported so the factor
 *  report states the same rule the screen path does rather than restating it. */
export { proportionalCutoff };

// ---------------------------------------------------------------------------
// the look-ahead invariant
// ---------------------------------------------------------------------------

/** A signal function over named matrix columns. Trailing-only by contract. */
export type SignalFn = (
  fields: Record<string, NumberMatrix>,
  dates: string[],
  symbols: string[],
) => (number | null)[][];

export interface TrailingViolation {
  date: string;
  symbol: string;
  truncated: number | null;
  full: number | null;
}

export interface TrailingCheckResult {
  /** Dates at which the prefix comparison was actually performed. */
  checked: string[];
  holds: boolean;
  firstViolation: TrailingViolation | null;
  /** Cells compared before the first violation (or in total). */
  comparedCells: number;
}

function same(a: number | null, b: number | null, tolerance: number): boolean {
  const an = a == null || Number.isNaN(a);
  const bn = b == null || Number.isNaN(b);
  if (an || bn) return an === bn; // both must be missing, or neither
  return Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(b));
}

/**
 * `generate(series[:T]) == generate(series)[:T]` for sampled T.
 *
 * A signal at T that changes when rows after T are appended is look-ahead BY
 * CONSTRUCTION, whatever its formula claims. This is the factor-side twin of the
 * strategy-side causality gate (6B's B1): there the engine repaints, here the
 * factor peeks.
 *
 * `atIndices` defaults to a spread of sampled indices rather than every T: the
 * cost is one full recomputation per sampled T, and the interesting failures (a
 * centred window, a backward fill) show up at any T.
 */
export function trailingPrefixHolds(
  compute: SignalFn,
  fields: Record<string, NumberMatrix>,
  opts: { atIndices?: number[]; tolerance?: number } = {},
): TrailingCheckResult {
  const { dates, symbols } = firstField(fields);
  const tolerance = opts.tolerance ?? 1e-9;
  const indices = opts.atIndices ?? defaultSampleIndices(dates.length);
  const full = compute(fields, dates, symbols);

  const checked: string[] = [];
  let comparedCells = 0;
  for (const i of indices) {
    if (i < 0 || i >= dates.length) continue;
    const truncatedFields: Record<string, NumberMatrix> = {};
    for (const [name, m] of Object.entries(fields)) {
      truncatedFields[name] = { dates: m.dates.slice(0, i + 1), symbols: m.symbols, values: m.values.slice(0, i + 1) };
    }
    const truncatedDates = dates.slice(0, i + 1);
    const truncated = compute(truncatedFields, truncatedDates, symbols);
    checked.push(dates[i]!);
    for (let d = 0; d <= i; d++) {
      for (let s = 0; s < symbols.length; s++) {
        const t = truncated[d]?.[s] ?? null;
        const f = full[d]?.[s] ?? null;
        comparedCells++;
        if (!same(t, f, tolerance)) {
          return {
            checked,
            holds: false,
            firstViolation: { date: dates[d]!, symbol: symbols[s]!, truncated: t, full: f },
            comparedCells,
          };
        }
      }
    }
  }
  return {
    checked,
    holds: true,
    firstViolation: null,
    comparedCells,
  };
}

function firstField(fields: Record<string, NumberMatrix>): { dates: string[]; symbols: string[] } {
  const first = Object.values(fields)[0];
  if (!first) throw new Error("trailingPrefixHolds: no fields supplied");
  return { dates: first.dates, symbols: first.symbols };
}

/** Sampled truncation points: the ends and a spread through the middle, so the
 *  check stays ~10 recomputations instead of one per session. */
export function defaultSampleIndices(n: number): number[] {
  if (n <= 1) return [n - 1];
  const wanted = Math.min(10, n);
  const idx = new Set<number>();
  for (let k = 0; k < wanted; k++) idx.add(Math.round((k * (n - 1)) / Math.max(1, wanted - 1)));
  idx.add(n - 1);
  return [...idx].sort((a, b) => a - b);
}
