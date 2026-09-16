/**
 * Deterministic screening — phase-1-spec §4, exactly as pinned.
 *
 * ⚠️ HYPOTHESIS H1 — every threshold and weight below is the hypothesis that
 * Phase 4 backtests; they are chosen to be conventional and defensible, not
 * optimal. Do not tune before then.
 *
 * Hypothesized economic mechanism (charter §5.3, written 2026-09-15 — one
 * sentence per component; the *hypothesis* Phase 4/5 tests, not an
 * established result):
 *   mom60 (w 0.50) — medium-term momentum rides investor underreaction:
 *     anchoring and gradual information diffusion (plus institutional
 *     herding) make prices drift for months after fundamentals shift.
 *   mom20 (w 0.25) — the same underreaction at monthly scale, but noisier
 *     and more reversal-prone, hence half weight.
 *   sharpe252 (w 0.25) — return per unit of volatility rewards steady
 *     compounders over jumpy gainers; economically a quality/predictability
 *     tilt (the low-volatility anomaly: lottery-demand leaves steady names
 *     underpriced).
 *   trend alignment (gate, close > SMA50 > SMA200) — requires the drift to
 *     be established at two timescales, filtering falling-knife bounces
 *     where positive momentum is an artifact inside a downtrend.
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
  /** When set, each exclusion also carries `reasons` — ALL failing gates in the
   *  chain's order (order-independent attribution). `reason` stays the first
   *  failure, so output is identical to today's when this is unset. */
  allFailures?: boolean;
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
   *  "NEGATIVE_MOMENTUM", "NON_POSITIVE_SHARPE". The FIRST failing gate —
   *  the if/else-if chain's semantics, unchanged. */
  reason: string;
  /** ALL failing gates, in the chain's order. Present only when
   *  `ScreenOptions.allFailures` is set. `reason` is always `reasons[0]`.
   *  INSUFFICIENT_HISTORY is terminal: with too few bars the downstream metrics
   *  are uncomputable, so the list is exactly `["INSUFFICIENT_HISTORY"]` — that
   *  is an availability statement, not "all gates fail". */
  reasons?: string[];
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

/** The metrics one name's gates read, computed once. */
interface GateMetrics {
  close: number | undefined;
  adv20: number | null;
  vol60: number | null;
  mdd252: number | null;
  sma50: number | null;
  sma200: number | null;
  mom20: number | null;
  mom60: number | null;
  sharpe252: number | null;
}

/** Every failing gate for one name, in the §4 chain's fixed order.
 *
 *  Gate 1 (INSUFFICIENT_HISTORY) is terminal: below `minBars` the downstream
 *  metrics are uncomputable, so the list is exactly `["INSUFFICIENT_HISTORY"]`
 *  — an availability statement, NOT "all gates fail". Otherwise gates 2–7 are
 *  evaluated independently, each with exactly the chain's condition (a null
 *  metric fails its gate, matching the chain). A passing name gets `[]`. */
function failingGates(market: Market, barCount: number, m: GateMetrics): string[] {
  if (barCount < SCREEN_PARAMS.minBars || m.close == null) {
    return ["INSUFFICIENT_HISTORY"];
  }
  const close = m.close;
  const fails: string[] = [];
  // Eligibility (§4).
  const floor = SCREEN_PARAMS.advFloor[market];
  if (m.adv20 == null || m.adv20 < floor) fails.push("LOW_LIQUIDITY");
  if (m.vol60 == null || m.vol60 > SCREEN_PARAMS.volMax) fails.push("HIGH_VOLATILITY");
  if (m.mdd252 == null || m.mdd252 < SCREEN_PARAMS.mddMin) fails.push("DEEP_DRAWDOWN");
  // Signal conditions (§4) — all must hold.
  if (m.sma50 == null || m.sma200 == null || !(close > m.sma50 && m.sma50 > m.sma200)) fails.push("BEARISH_ALIGNMENT");
  if (m.mom20 == null || m.mom60 == null || !(m.mom60 > 0)) fails.push("NEGATIVE_MOMENTUM");
  if (m.sharpe252 == null || !(m.sharpe252 > 0)) fails.push("NON_POSITIVE_SHARPE");
  return fails;
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

    // Eligibility (§4) — `reason` is the FIRST failing gate (the historical
    // if/else-if chain's semantics, unchanged); `reasons` lists them all.
    const fails = failingGates(inp.market, closes.length, {
      close,
      adv20,
      vol60,
      mdd252,
      sma50,
      sma200,
      mom20,
      mom60,
      sharpe252,
    });
    if (fails.length > 0) {
      const exclusion: ScreenExclusion = { symbol: inp.symbol, reason: fails[0]! };
      if (opts.allFailures) exclusion.reasons = fails;
      excluded.push(exclusion);
    } else {
      // Every gate passed, so every metric is non-null (a null metric fails its
      // gate — see failingGates).
      eligible.push({
        symbol: inp.symbol,
        market: inp.market,
        close: close!,
        sma50: sma50!,
        sma200: sma200!,
        mom20: mom20!,
        mom60: mom60!,
        vol60: vol60!,
        sharpe252: sharpe252!,
        adv20: adv20!,
        mdd252: mdd252!,
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
