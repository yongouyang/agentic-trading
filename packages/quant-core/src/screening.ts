/**
 * Deterministic screening — phase-1-spec §4, exactly as pinned.
 *
 * ⚠️ HYPOTHESIS H1 — every threshold and weight below is the hypothesis that
 * Phase 4 backtests; they are chosen to be conventional and defensible, not
 * optimal. Do not tune before then.
 *
 * Eligibility (failing any ⇒ excluded, reason recorded):
 *   ≥252 adjusted bars; adv20 ≥ floor; vol60 ≤ 0.60; mdd252 ≥ −0.50.
 * Signal (all must hold):
 *   close > SMA50 AND SMA50 > SMA200; mom60 > 0; sharpe252 > 0.
 * Score: per-market cross-sectional z-scores over the day's eligible set,
 *   score = 0.50·z(mom60) + 0.25·z(mom20) + 0.25·z(sharpe252).
 * Rank descending, top 15 per market, ties broken by higher adv20.
 */
import { Bar } from "./types.js";
import { advDollar, annualizedVol, maxDrawdown, momentum, sharpe, sma } from "./indicators.js";

/** HYPOTHESIS H1 — Phase 4 backtests these; do not tune before then. */
export const SCREEN_PARAMS = {
  minBars: 252,
  /** adv20 liquidity floor per market, in instrument currency. */
  advFloor: { US: 20_000_000, HK: 100_000_000 } as const,
  volMax: 0.6,
  mddMin: -0.5,
  topN: 15,
  weights: { mom60: 0.5, mom20: 0.25, sharpe252: 0.25 } as const,
} as const;

export type Market = "US" | "HK";

/** Per-ticker screen input: adjusted bars drive every indicator except
 *  adv20, which reads `rawBars` (R2). */
export interface ScreenInput {
  symbol: string;
  market: Market;
  /** Adjusted OHLC bars (from `deriveAdjustedBars`), oldest first. */
  adjustedBars: Bar[];
  /** Raw bars for adv20 (liquidity in traded dollars). */
  rawBars: Bar[];
  /** CA_DEGRADED annotation — included in output when passing, not excluded. */
  caDegraded: boolean;
}

export interface ScreenPick {
  rank: number;
  symbol: string;
  score: number;
  close: number;
  sma50: number;
  sma200: number;
  mom20: number;
  mom60: number;
  vol60: number;
  sharpe252: number;
  adv20: number;
  mdd252: number;
  caDegraded: boolean;
}

export interface ScreenExclusion {
  symbol: string;
  /** Machine-stable reason, e.g. "INSUFFICIENT_HISTORY", "LOW_LIQUIDITY",
   *  "HIGH_VOLATILITY", "DEEP_DRAWDOWN", "BEARISH_ALIGNMENT",
   *  "NEGATIVE_MOMENTUM", "NON_POSITIVE_SHARPE". */
  reason: string;
}

export interface ScreenOutput {
  ranked: ScreenPick[];
  excluded: ScreenExclusion[];
}

/** Population stdev; 0 on empty/degenerate input. */
function pstdev(xs: number[]): number {
  if (xs.length === 0) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
}

/** z-score over the eligible set (population stdev; stdev=0 ⇒ z=0 for all). */
function zscores(xs: number[]): number[] {
  if (xs.length === 0) return [];
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = pstdev(xs);
  if (sd === 0) return xs.map(() => 0);
  return xs.map((x) => (x - mean) / sd);
}

interface Candidate {
  symbol: string;
  market: Market;
  close: number;
  sma50: number;
  sma200: number;
  mom20: number;
  mom60: number;
  vol60: number;
  sharpe252: number;
  adv20: number;
  mdd252: number;
  caDegraded: boolean;
}

/** Run the deterministic §4 screen over one day's inputs (both markets may
 *  be mixed; ranking is per market). Pure function — no I/O. */
export function runScreen(inputs: ScreenInput[]): ScreenOutput {
  const excluded: ScreenExclusion[] = [];
  const eligible: Candidate[] = [];

  for (const inp of inputs) {
    const closes = inp.adjustedBars.map((b) => b.close!);
    const close = closes[closes.length - 1];
    const adv20 = advDollar(inp.rawBars, 20);
    const vol60 = annualizedVol(closes, 60);
    const mdd252 = maxDrawdown(closes, 252);
    const sma50 = sma(closes, 50);
    const sma200 = sma(closes, 200);
    const mom20 = momentum(closes, 20);
    const mom60 = momentum(closes, 60);
    const sharpe252 = sharpe(closes, 252);

    // Eligibility (§4) — first failing reason recorded.
    const floor = SCREEN_PARAMS.advFloor[inp.market];
    if (closes.length < SCREEN_PARAMS.minBars || close == null) {
      excluded.push({ symbol: inp.symbol, reason: "INSUFFICIENT_HISTORY" });
    } else if (adv20 == null || adv20 < floor) {
      excluded.push({ symbol: inp.symbol, reason: "LOW_LIQUIDITY" });
    } else if (vol60 == null || vol60 > SCREEN_PARAMS.volMax) {
      excluded.push({ symbol: inp.symbol, reason: "HIGH_VOLATILITY" });
    } else if (mdd252 == null || mdd252 < SCREEN_PARAMS.mddMin) {
      excluded.push({ symbol: inp.symbol, reason: "DEEP_DRAWDOWN" });
      // Signal conditions (§4) — all must hold.
    } else if (sma50 == null || sma200 == null || !(close > sma50 && sma50 > sma200)) {
      excluded.push({ symbol: inp.symbol, reason: "BEARISH_ALIGNMENT" });
    } else if (mom20 == null || mom60 == null || !(mom60 > 0)) {
      excluded.push({ symbol: inp.symbol, reason: "NEGATIVE_MOMENTUM" });
    } else if (sharpe252 == null || !(sharpe252 > 0)) {
      excluded.push({ symbol: inp.symbol, reason: "NON_POSITIVE_SHARPE" });
    } else {
      eligible.push({
        symbol: inp.symbol,
        market: inp.market,
        close,
        sma50,
        sma200,
        mom20,
        mom60,
        vol60,
        sharpe252,
        adv20,
        mdd252,
        caDegraded: inp.caDegraded,
      });
    }
  }

  // Score + rank per market: cross-sectional z-scores over the day's
  // eligible set; descending, top N, ties broken by higher adv20.
  const ranked: ScreenPick[] = [];
  for (const market of ["US", "HK"] as const) {
    const set = eligible.filter((c) => c.market === market);
    const zMom60 = zscores(set.map((c) => c.mom60));
    const zMom20 = zscores(set.map((c) => c.mom20));
    const zSharpe = zscores(set.map((c) => c.sharpe252));
    const scored = set.map((c, i) => ({
      ...c,
      score:
        SCREEN_PARAMS.weights.mom60 * zMom60[i]! +
        SCREEN_PARAMS.weights.mom20 * zMom20[i]! +
        SCREEN_PARAMS.weights.sharpe252 * zSharpe[i]!,
    }));
    scored.sort((a, b) => b.score - a.score || b.adv20 - a.adv20);
    scored.slice(0, SCREEN_PARAMS.topN).forEach((c, i) => {
      ranked.push({
        rank: i + 1,
        symbol: c.symbol,
        score: c.score,
        close: c.close,
        sma50: c.sma50,
        sma200: c.sma200,
        mom20: c.mom20,
        mom60: c.mom60,
        vol60: c.vol60,
        sharpe252: c.sharpe252,
        adv20: c.adv20,
        mdd252: c.mdd252,
        caDegraded: c.caDegraded,
      });
    });
  }

  return { ranked, excluded };
}
