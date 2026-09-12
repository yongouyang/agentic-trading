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
 * Rank descending, per-market `topN` (40 US / 40 HK measurement breadth —
 * the dashboard presents `displayTopN`), ties broken by higher adv20.
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
  /**
   * Candidates persisted per market, by rank. This is the **measurement**
   * breadth: it feeds the deep-dive, so it sets how fast the LLM layer's verdicts
   * can be validated (Phase 5 Fork A — at ~10 verdicts/day a modest IC of 0.10 is
   * ~65 months of accrual away; at 40 it is ~15).
   *
   * It does **not** change H1: `topN` truncates the *output*, not the score, so
   * every Gate-1 ranking statistic is identical at any value, and the backtest
   * replays with the truncation lifted entirely.
   */
  topN: { US: 40, HK: 40 } as const,
  /**
   * What the dashboard presents per market — deliberately smaller and decoupled
   * from `topN` (Phase 5 Fork A): display length is a product choice, while
   * measurement breadth is a token-cost choice, and tying them forced a false
   * trade between a readable list and a validatable sample.
   *
   * HK is 5 because a fixed 15 was **60 % of its ~25-name eligible universe** —
   * not a ranking at all, which is why its measured spread was indistinguishable
   * from its own breadth. US is 10, unchanged (8 % of its 180).
   */
  displayTopN: { US: 10, HK: 5 } as const,
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

/** Options for `runScreen`. */
export interface ScreenOptions {
  /** Override the top-N truncation.
   *
   *  Phase 4 passes a large value to obtain the FULL eligible ranking, because
   *  the IC gate needs every eligible name's score. This is exactly equivalent
   *  for the first N: z-scores are computed over the whole eligible set and the
   *  ranking is sorted before truncation, so scores and ranks are unchanged —
   *  only how many rows come back differs. Asserted by test. */
  topN?: number;
}

export interface ScreenPick {
  rank: number;
  symbol: string;
  /** Market this pick was ranked in. Additive (2026-09-10) so a pick is
   *  self-describing — the Phase-4 backtest and portfolio books are per-market
   *  and cannot otherwise recover provenance from the ranked output. */
  market: Market;
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
export function runScreen(inputs: ScreenInput[], opts: ScreenOptions = {}): ScreenOutput {
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
  //
  // `topN` is per market (Phase 5 Fork A) and `opts.topN` overrides both, which
  // is how the backtest lifts the truncation entirely.
  const ranked: ScreenPick[] = [];
  for (const market of ["US", "HK"] as const) {
    const limit = opts.topN ?? SCREEN_PARAMS.topN[market];
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
    scored.slice(0, limit).forEach((c, i) => {
      ranked.push({
        rank: i + 1,
        symbol: c.symbol,
        market: c.market,
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
