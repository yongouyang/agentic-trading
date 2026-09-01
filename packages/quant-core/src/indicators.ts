/**
 * Indicator module — phase-1-spec §3. Batch pure functions over the
 * ADJUSTED close series (R2), except `advDollar` which reads raw bars
 * (liquidity is measured in traded dollars). Pinned windows: SMA20/50/200,
 * mom20/60, vol60, sharpe252, adv20, mdd252.
 *
 * Every function returns `number | null` — `null` (never NaN, never an
 * exception) on insufficient history or degenerate input; the screener
 * treats `null` as ineligible.
 */
import { Bar } from "./types.js";

/** Simple moving average of the last `n` values. Pinned window: SMA20/50/200. */
export function sma(closes: number[], n: number): number | null {
  if (n < 1 || closes.length < n) return null;
  let sum = 0;
  for (let i = closes.length - n; i < closes.length; i++) sum += closes[i]!;
  return sum / n;
}

/** Momentum: `c_t / c_{t−n} − 1`. Pinned window: mom20, mom60. */
export function momentum(closes: number[], n: number): number | null {
  if (n < 1 || closes.length < n + 1) return null;
  const base = closes[closes.length - 1 - n]!;
  if (base === 0) return null;
  return closes[closes.length - 1]! / base - 1;
}

/** Daily simple returns over the last `n` bars (n−1 returns), oldest first. */
function simpleReturns(closes: number[], n: number): number[] | null {
  if (n < 2 || closes.length < n) return null;
  const out: number[] = [];
  for (let i = closes.length - n + 1; i < closes.length; i++) {
    const prev = closes[i - 1]!;
    if (prev === 0) return null;
    out.push(closes[i]! / prev - 1);
  }
  return out;
}

/** Sample stdev (n−1 denominator); null on fewer than 2 points. */
function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

/** Annualized volatility: stdev of daily simple returns over the last `n`
 *  bars × √252. Pinned window: vol60. */
export function annualizedVol(closes: number[], n: number): number | null {
  const rets = simpleReturns(closes, n);
  if (!rets) return null;
  const sd = stdev(rets);
  if (sd == null) return null;
  return sd * Math.sqrt(252);
}

/** Sharpe ratio: annualized return over the last `n` bars ÷ annualized vol
 *  over the same window; risk-free = 0 (Day-12 beginner approximation,
 *  pinned for v1). Annualized return = mean daily simple return × 252.
 *  null on zero variance (degenerate input). Pinned window: sharpe252. */
export function sharpe(closes: number[], n: number): number | null {
  const rets = simpleReturns(closes, n);
  if (!rets) return null;
  const sd = stdev(rets);
  if (sd == null || sd === 0) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  return (mean * 252) / (sd * Math.sqrt(252));
}

/** Average daily dollar volume: MEDIAN of `close × volume` over the last
 *  `n` bars, in instrument currency. Uses RAW bars (R2: liquidity is
 *  measured in traded dollars). Pinned window: adv20. Bars with null close
 *  or volume are skipped; null if fewer than ⌈n/2⌉ usable bars remain in
 *  the window. (Null-tolerance pinned 2026-09-01 after live seeding: Yahoo
 *  sporadically serves null-volume bars — incl. the in-progress session
 *  bar when a run happens during market hours — and a single such bar must
 *  not zero a mega-cap's liquidity; Day 17 treats it as a warning.) */
export function advDollar(bars: Bar[], n: number): number | null {
  if (n < 1 || bars.length < n) return null;
  const last = bars.slice(-n).filter((b) => b.close != null && b.volume != null);
  if (last.length < Math.ceil(n / 2)) return null;
  const dv = last.map((b) => b.close! * b.volume!).sort((a, b) => a - b);
  const mid = Math.floor(dv.length / 2);
  return dv.length % 2 ? dv[mid]! : (dv[mid - 1]! + dv[mid]!) / 2;
}

/** Maximum drawdown over the last `n` values:
 *  min over the window of `c_t / max(c_{≤t}) − 1` (≤ 0). Pinned window:
 *  mdd252. */
export function maxDrawdown(closes: number[], n: number): number | null {
  if (n < 1 || closes.length < n) return null;
  const win = closes.slice(-n);
  if (win.some((c) => c <= 0)) return null;
  let peak = win[0]!;
  let mdd = 0;
  for (const c of win) {
    if (c > peak) peak = c;
    const dd = c / peak - 1;
    if (dd < mdd) mdd = dd;
  }
  return mdd;
}
