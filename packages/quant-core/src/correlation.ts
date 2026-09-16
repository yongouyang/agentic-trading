/**
 * Correlation helpers — charter §5.3 diversification measurement (added
 * 2026-09-15): "diversification is asserted but never measured; a correlation
 * matrix over the persisted daily returns would settle it." Pure functions,
 * same convention as indicators.ts: `null` (never NaN, never an exception) on
 * insufficient or degenerate input.
 */
import { Bar } from "./types.js";
import { pearson } from "./ic.js";

/** Minimum overlapping return observations for a meaningful pairwise
 *  correlation; below it the estimate is noise, so the pair reports null. */
export const MIN_CORR_OVERLAP = 20;

/** Daily simple returns keyed by the LATER bar's date, from an oldest-first
 *  bar series. A return is only emitted when both closes are non-null and
 *  positive — gaps in the store produce no observation (the pair intersection
 *  in pairwiseCorrelation then simply excludes that date). Pass ADJUSTED
 *  closes for anything interpreted as economic return (R2). */
export function returnsByDate(bars: Pick<Bar, "date" | "close">[]): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1]!.close;
    const cur = bars[i]!.close;
    if (prev != null && prev > 0 && cur != null && cur > 0) {
      out.set(bars[i]!.date, cur / prev - 1);
    }
  }
  return out;
}

export interface PairwiseCorrelation {
  /** Symbols in matrix order (insertion order of the input map). */
  symbols: string[];
  /** matrix[i][j] = Pearson ρ between symbols i and j over their common
   *  dates; null when the overlap is below MIN_CORR_OVERLAP or degenerate.
   *  Diagonal is 1. */
  matrix: (number | null)[][];
  /** overlaps[i][j] = number of common return observations behind matrix[i][j]. */
  overlaps: number[][];
}

/** Pairwise correlation matrix over date-keyed return series, each pair
 *  intersected on its common dates (symbols keep different calendars — HK
 *  and US sessions, store holes — without fabrication). */
export function pairwiseCorrelation(seriesBySymbol: Map<string, Map<string, number>>): PairwiseCorrelation {
  const symbols = [...seriesBySymbol.keys()];
  const n = symbols.length;
  const matrix: (number | null)[][] = Array.from({ length: n }, () => Array<number | null>(n).fill(null));
  const overlaps: number[][] = Array.from({ length: n }, () => Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    matrix[i]![i] = 1;
    overlaps[i]![i] = seriesBySymbol.get(symbols[i]!)!.size;
    for (let j = i + 1; j < n; j++) {
      const a = seriesBySymbol.get(symbols[i]!)!;
      const b = seriesBySymbol.get(symbols[j]!)!;
      const [small, large] = a.size <= b.size ? [a, b] : [b, a];
      const xs: number[] = [];
      const ys: number[] = [];
      for (const [date, r] of small) {
        const other = large.get(date);
        if (other !== undefined) {
          xs.push(r);
          ys.push(other);
        }
      }
      const rho = xs.length < MIN_CORR_OVERLAP ? null : pearson(xs, ys);
      matrix[i]![j] = rho;
      matrix[j]![i] = rho;
      overlaps[i]![j] = xs.length;
      overlaps[j]![i] = xs.length;
    }
  }
  return { symbols, matrix, overlaps };
}

/** Summary of one triangle of a pairwise matrix (off-diagonal, nulls excluded). */
export interface CorrelationSummary {
  pairs: number;
  /** Pairs below MIN_CORR_OVERLAP or degenerate — excluded from the stats. */
  unmeasurable: number;
  mean: number | null;
  median: number | null;
  max: number | null;
  maxPair: [string, string] | null;
}

/** Off-diagonal summary of a PairwiseCorrelation. All-null ⇒ nulls throughout. */
export function summarizeCorrelation(corr: PairwiseCorrelation): CorrelationSummary {
  const vals: { rho: number; pair: [string, string] }[] = [];
  let unmeasurable = 0;
  for (let i = 0; i < corr.symbols.length; i++) {
    for (let j = i + 1; j < corr.symbols.length; j++) {
      const rho = corr.matrix[i]![j]!;
      if (rho == null) unmeasurable++;
      else vals.push({ rho, pair: [corr.symbols[i]!, corr.symbols[j]!] });
    }
  }
  const sorted = vals.map((v) => v.rho).sort((a, b) => a - b);
  const top = vals.reduce<{ rho: number; pair: [string, string] } | null>((m, v) => (m == null || v.rho > m.rho ? v : m), null);
  return {
    pairs: vals.length,
    unmeasurable,
    mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
    median: sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2) : null,
    max: top?.rho ?? null,
    maxPair: top?.pair ?? null,
  };
}
