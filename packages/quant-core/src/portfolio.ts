/**
 * Portfolio simulation — Phase 4 Gate 2 (docs/phase-4-plan.md).
 *
 * Rank-hysteresis hold (a locked Phase-4 decision): buy a name when it enters
 * top-N, hold it until its rank falls past the buffer rank or it stops being
 * eligible, cap N concurrent positions, equal-weight sizing. This mirrors how a
 * daily manual watchlist is actually used, rather than a daily full-rebalance
 * that would churn on rank noise.
 *
 * Execution follows Day 21: **signal at the close of T, fill at the open of
 * T+1**. That lag is a real cost the benchmark does not bear, so the benchmark
 * comparison is conservative for the strategy — deliberately.
 *
 * One book **per market**. The screen ranks per market and the two lanes have
 * different cost models and separate verdicts, so a single combined book would
 * have to invent a cross-market ranking that the strategy never produces.
 *
 * Simplifications, each recorded so a later reader cannot mistake them for
 * realism:
 *  - Fractional shares (no board lots).
 *  - Prices come from the full-history adjusted series; see replay.ts note 3 for
 *    why that is anchor-invariant and not look-ahead for a return between T and
 *    T+h.
 *  - Open positions are closed at the final bar, with costs, so trade statistics
 *    are complete rather than censored.
 */
import { Market } from "./screening.js";
import { ForwardSeries, ReplayDay, indexAtOrBefore } from "./replay.js";

/** Per-side trading cost in basis points. Base = the Day-21 model: US ~0
 *  commission + 5bp slippage; HK 0.1 % stamp duty + 0.03 % fees + 10bp slippage
 *  ≈ 23bp per side. */
export interface CostModel {
  perSideBps: Record<Market, number>;
}

export const BASE_COSTS: CostModel = { perSideBps: { US: 5, HK: 23 } };

/** Multiply every per-side cost — the Day-15 sensitivity sweep. */
export function scaleCosts(model: CostModel, multiplier: number): CostModel {
  return { perSideBps: { US: model.perSideBps.US * multiplier, HK: model.perSideBps.HK * multiplier } };
}

export interface PortfolioParams {
  topN: number;
  bufferRank: number;
  costs: CostModel;
}

export interface Trade {
  symbol: string;
  market: Market;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  returnPct: number;
  holdingSessions: number;
}

export interface PortfolioMetrics {
  totalReturn: number;
  annualizedReturn: number;
  maxDrawdown: number;
  /** Longest run of sessions below a prior peak (drawdown duration). */
  maxDrawdownSessions: number;
  sharpe: number;
  winRate: number;
  plRatio: number;
  tradeCount: number;
  avgHoldingSessions: number;
  /** Traded notional ÷ mean equity ÷ years, both sides (annualised). */
  turnover: number;
  sessions: number;
}

export interface PortfolioResult {
  market: Market;
  dates: string[];
  equity: number[];
  dailyReturns: number[];
  trades: Trade[];
  metrics: PortfolioMetrics;
}

interface Holding {
  shares: number;
  entryPrice: number;
  entryDate: string;
  entryIdx: number;
}

interface Order {
  symbol: string;
  side: "buy" | "sell";
}

/** Fill price for a session: the open, falling back to the close when the
 *  provider has no open for that bar. Returns null when neither exists. */
function fillPrice(series: ForwardSeries, idx: number): number | null {
  const o = series.opens[idx];
  if (o != null && o > 0) return o;
  const c = series.closes[idx];
  return c != null && c > 0 ? c : null;
}

/**
 * Simulate one market's book over the replay days.
 *
 * A name is tradable on day T only when that symbol has a bar on T — a stale
 * series cannot be filled at a real price, so it is skipped rather than carried
 * at yesterday's price.
 */
export function simulatePortfolio(
  days: ReplayDay[],
  forward: Map<string, ForwardSeries>,
  params: PortfolioParams,
  market: Market,
): PortfolioResult {
  const dates = days.map((d) => d.date);
  const rate = params.costs.perSideBps[market] / 10_000;
  const equity: number[] = [];
  const dailyReturns: number[] = [];
  const trades: Trade[] = [];

  const holdings = new Map<string, Holding>();
  let cash = 1; // unit equity
  let tradedNotional = 0;
  let pending: Order[] = [];

  // Per-day ranking restricted to this market.
  const ranksByDay: Map<string, number>[] = days.map((d) => {
    const m = new Map<string, number>();
    for (const p of d.ranked) if (p.market === market) m.set(p.symbol, p.rank);
    return m;
  });

  const markAt = (sym: string, date: string): number | null => {
    const s = forward.get(sym);
    if (!s) return null;
    const i = indexAtOrBefore(s, date);
    return i < 0 ? null : s.closes[i]!;
  };

  for (let t = 0; t < days.length; t++) {
    const day = days[t]!;

    // --- 1. execute the previous session's signals at today's OPEN ---
    if (pending.length > 0) {
      const equityPrev = equity.length > 0 ? equity[equity.length - 1]! : cash;

      for (const o of pending) {
        if (o.side !== "sell") continue;
        const h = holdings.get(o.symbol);
        const s = forward.get(o.symbol);
        if (!h || !s) continue;
        const idx = s.index.get(day.date);
        if (idx === undefined) continue; // no bar today — cannot fill
        const px = fillPrice(s, idx);
        if (px == null) continue;
        const proceeds = h.shares * px * (1 - rate);
        tradedNotional += h.shares * px;
        cash += proceeds;
        trades.push({
          symbol: o.symbol,
          market,
          entryDate: h.entryDate,
          exitDate: day.date,
          entryPrice: h.entryPrice,
          exitPrice: px,
          pnl: proceeds - h.shares * h.entryPrice,
          returnPct: px / h.entryPrice - 1,
          holdingSessions: idx - h.entryIdx,
        });
        holdings.delete(o.symbol);
      }

      const buys = pending.filter((o) => o.side === "buy" && !holdings.has(o.symbol));
      if (buys.length > 0) {
        const notional = equityPrev / params.topN;
        for (const o of buys) {
          const s = forward.get(o.symbol);
          if (!s) continue;
          const idx = s.index.get(day.date);
          if (idx === undefined) continue;
          const px = fillPrice(s, idx);
          if (px == null) continue;
          // Size so the TOTAL outlay (including the entry cost) equals the
          // target notional. Sizing on `notional / px` and then adding the cost
          // on top made the outlay marginally exceed the target, which the cash
          // guard below then rejected — silently producing zero trades when
          // topN == 1.
          const shares = notional / (px * (1 + rate));
          const outlay = shares * px * (1 + rate);
          if (outlay > cash) continue; // no leverage: skip rather than overdraw
          cash -= outlay;
          tradedNotional += shares * px;
          holdings.set(o.symbol, { shares, entryPrice: px, entryDate: day.date, entryIdx: idx });
        }
      }
    }

    // --- 2. mark to market at today's CLOSE ---
    let value = cash;
    for (const [sym, h] of holdings) {
      const px = markAt(sym, day.date); // carries the last known mark on a gap
      if (px != null) value += h.shares * px;
    }
    equity.push(value);
    dailyReturns.push(t === 0 ? 0 : value / equity[t - 1]! - 1);

    // --- 3. today's ranking → orders for tomorrow ---
    const ranks = ranksByDay[t]!;
    const orders: Order[] = [];
    let kept = 0;
    for (const [sym] of holdings) {
      const r = ranks.get(sym);
      if (r === undefined || r > params.bufferRank) orders.push({ symbol: sym, side: "sell" });
      else kept++;
    }
    let slots = params.topN - kept;
    for (const [sym, rank] of ranks) {
      if (slots <= 0) break;
      if (rank > params.topN) continue; // ranks are sparse, not contiguous
      if (holdings.has(sym)) continue;
      orders.push({ symbol: sym, side: "buy" });
      slots--;
    }
    pending = orders;
  }

  // Close whatever is still open at the final bar so trade stats are complete.
  const lastDate = dates[dates.length - 1];
  if (lastDate && holdings.size > 0) {
    for (const [sym, h] of holdings) {
      const s = forward.get(sym);
      if (!s) continue;
      const idx = indexAtOrBefore(s, lastDate);
      if (idx < 0) continue;
      const px = s.closes[idx]!;
      if (px == null) continue;
      const proceeds = h.shares * px * (1 - rate);
      cash += proceeds;
      trades.push({
        symbol: sym,
        market,
        entryDate: h.entryDate,
        exitDate: lastDate,
        entryPrice: h.entryPrice,
        exitPrice: px,
        pnl: proceeds - h.shares * h.entryPrice,
        returnPct: px / h.entryPrice - 1,
        holdingSessions: idx - h.entryIdx,
      });
    }
    holdings.clear();
    equity[equity.length - 1] = cash;
  }

  return {
    market,
    dates,
    equity,
    dailyReturns,
    trades,
    metrics: portfolioMetrics(equity, dailyReturns, trades, tradedNotional),
  };
}

export function portfolioMetrics(equity: number[], dailyReturns: number[], trades: Trade[], tradedNotional: number): PortfolioMetrics {
  const sessions = equity.length;
  const first = equity[0] ?? 1;
  const lastV = equity[equity.length - 1] ?? first;
  const totalReturn = first === 0 ? 0 : lastV / first - 1;
  const annualizedReturn = sessions > 0 && first > 0 && lastV > 0 ? Math.pow(lastV / first, 252 / sessions) - 1 : 0;

  let peak = equity[0] ?? 1;
  let peakIdx = 0;
  let maxDrawdown = 0;
  let maxDrawdownSessions = 0;
  for (let i = 0; i < sessions; i++) {
    const v = equity[i]!;
    if (v > peak) {
      peak = v;
      peakIdx = i;
    }
    const dd = peak === 0 ? 0 : v / peak - 1;
    if (dd < maxDrawdown) maxDrawdown = dd;
    maxDrawdownSessions = Math.max(maxDrawdownSessions, i - peakIdx);
  }

  const rets = dailyReturns.slice(1);
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sd = rets.length > 1 ? Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const sharpe = sd === 0 ? 0 : (mean / sd) * Math.sqrt(252);

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const avgWin = wins.length ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, t) => a + t.pnl, 0) / losses.length : 0;

  const meanEquity = sessions ? equity.reduce((a, b) => a + b, 0) / sessions : 1;
  const years = sessions / 252;

  return {
    totalReturn,
    annualizedReturn,
    maxDrawdown,
    maxDrawdownSessions,
    sharpe,
    winRate: trades.length ? wins.length / trades.length : 0,
    plRatio: avgLoss === 0 ? (avgWin > 0 ? Infinity : 0) : Math.abs(avgWin / avgLoss),
    tradeCount: trades.length,
    avgHoldingSessions: trades.length ? trades.reduce((a, t) => a + t.holdingSessions, 0) / trades.length : 0,
    turnover: meanEquity > 0 && years > 0 ? tradedNotional / meanEquity / years : 0,
    sessions,
  };
}

/**
 * Equal-weight benchmark: each day, hold the set that was ELIGIBLE on the
 * previous session, equally weighted, cost-free. It shares the screen's own
 * universe and eligibility filters, which is what makes it a like-for-like
 * baseline rather than a flattering one.
 */
export function benchmarkReturns(days: ReplayDay[], forward: Map<string, ForwardSeries>, market: Market): number[] {
  const out: number[] = [0];
  for (let t = 1; t < days.length; t++) {
    const prev = days[t - 1]!;
    const today = days[t]!;
    const rets: number[] = [];
    for (const pick of prev.ranked) {
      if (pick.market !== market) continue;
      const s = forward.get(pick.symbol);
      if (!s) continue;
      const i = s.index.get(prev.date);
      const j = s.index.get(today.date);
      if (i === undefined || j === undefined) continue;
      const a = s.closes[i]!;
      const b = s.closes[j]!;
      if (a === 0) continue;
      rets.push(b / a - 1);
    }
    out.push(rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0);
  }
  return out;
}
