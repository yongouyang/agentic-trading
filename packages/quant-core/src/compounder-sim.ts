/**
 * Phase 7 P4 — the pre-registered portfolio simulation (docs/phase-7-plan.md
 * §4). Distinct from the Phase-4 simulator: re-ranks are QUARTERLY (not
 * daily), entry requires the valuation ceiling and the gate, and the gate has
 * EXIT AUTHORITY between re-ranks (D2).
 *
 * Mechanics, all declared in the plan:
 *  - Re-rank on the first session of each quarter. Candidates: scored names
 *    passing (a) the E/P ceiling — exclude the universe's bottom E/P quintile
 *    of the day — and (b) the gate at the re-rank date. Target top-20 equal
 *    weight; a holding survives while its rank stays within the top-40 buffer
 *    AND its gate still passes.
 *  - Gate evaluated nightly: a break exits at the NEXT session's close ("the
 *    conservative side of the bar", §4).
 *  - Re-entry only at a quarterly re-rank.
 *  - ALL orders — re-rank entries and exits, gate exits — execute at the next
 *    session's close. The panel carries no open leg; one fill rule for every
 *    order keeps the simulation symmetric.
 * All inputs (scores, E/P, gate states) must already be PIT — this module
 * consumes matrices and never looks forward.
 */

export interface QuarterlySimInput {
  dates: string[];
  symbols: string[];
  /** Dividend-adjusted close, [dateIdx][symbolIdx]; null = no bar. */
  close: (number | null)[][];
  /** Blended score per §3; null = not scored that day. */
  score: (number | null)[][];
  /** Earnings yield; null = not computable that day. */
  ep: (number | null)[][];
  /** Gate pass state; null = gate cannot attest (treated as NOT passing). */
  gatePass: (boolean | null)[][] | null;
  topN: number;
  bufferRank: number;
  /** Per-side cost as a rate (e.g. 0.001 = 10 bps). */
  costRate: number;
  /** First date index allowed to host a re-rank (warmup). */
  startIdx: number;
  /** false = the ungated benchmark variant (gate ignored entirely). */
  gated: boolean;
}

export interface SimTrade {
  symbol: string;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  returnPct: number;
  exitReason: "rerank" | "gate" | "final";
}

export interface QuarterlySimResult {
  dates: string[];
  equity: number[];
  dailyReturns: number[];
  trades: SimTrade[];
}

/** First session index of each quarter within [startIdx, dates.length). */
export function quarterlyRerankDates(dates: string[], startIdx: number): Set<number> {
  const out = new Set<number>();
  let prevQuarter = -1;
  for (let d = Math.max(0, startIdx); d < dates.length; d++) {
    const dt = dates[d]!;
    const quarter = Number(dt.slice(0, 4)) * 4 + Math.floor((Number(dt.slice(5, 7)) - 1) / 3);
    if (quarter !== prevQuarter) {
      out.add(d);
      prevQuarter = quarter;
    }
  }
  return out;
}

/** The E/P ceiling at one date (§4): exclude the bottom quintile of the day's
 *  computable E/Ps — the most expensive 20%. Returns a pass/keep row where
 *  null = does not pass (or not computable). */
export function epCeiling(epRow: (number | null)[]): (number | null)[] {
  const present = epRow.filter((v): v is number => v != null).sort((a, b) => a - b);
  if (present.length < 5) return epRow.map(() => null);
  // Exclude the bottom floor(0.2·n) values — the most expensive quintile.
  const floor = present[Math.min(present.length - 1, Math.floor(0.2 * present.length))]!;
  return epRow.map((v) => (v != null && v >= floor ? v : null));
}

interface Holding {
  shares: number;
  entryPrice: number;
  entryDate: string;
}

interface PendingOrder {
  symbol: string;
  side: "buy" | "sell";
  reason: SimTrade["exitReason"];
}

export function simulateQuarterlyCompounder(input: QuarterlySimInput): QuarterlySimResult {
  const { dates, symbols, close, score, ep, gatePass, topN, bufferRank, costRate, startIdx, gated } = input;
  const posOf = new Map(symbols.map((s, i) => [s, i]));
  const reranks = quarterlyRerankDates(dates, startIdx);
  const equity: number[] = [];
  const dailyReturns: number[] = [];
  const trades: SimTrade[] = [];
  const holdings = new Map<string, Holding>();
  const lastMark = new Map<string, number>();
  let cash = 1;
  let pending: PendingOrder[] = [];

  const gateOk = (d: number, s: number): boolean => !gated || gatePass?.[d]?.[s] === true;

  const sellAtClose = (d: number, sym: string, reason: SimTrade["exitReason"]): boolean => {
    const h = holdings.get(sym);
    const s = posOf.get(sym);
    const px = s === undefined ? null : close[d]?.[s];
    if (!h || px == null || px <= 0) return false;
    cash += h.shares * px * (1 - costRate);
    trades.push({
      symbol: sym,
      entryDate: h.entryDate,
      exitDate: dates[d]!,
      entryPrice: h.entryPrice,
      exitPrice: px,
      returnPct: px / h.entryPrice - 1,
      exitReason: reason,
    });
    holdings.delete(sym);
    return true;
  };

  for (let d = 0; d < dates.length; d++) {
    // 1. execute yesterday's orders at today's close (before marking)
    const sells = pending.filter((o) => o.side === "sell");
    const buys = pending.filter((o) => o.side === "buy");
    pending = [];
    for (const o of sells) sellAtClose(d, o.symbol, o.reason);
    if (buys.length) {
      const equityPrev = equity.length ? equity[equity.length - 1]! : cash;
      const notional = equityPrev / topN;
      for (const o of buys) {
        if (holdings.has(o.symbol)) continue;
        const s = posOf.get(o.symbol);
        const px = s === undefined ? null : close[d]?.[s];
        if (px == null || px <= 0) continue;
        const shares = notional / (px * (1 + costRate));
        const outlay = shares * px * (1 + costRate);
        if (outlay > cash) continue; // no leverage
        cash -= outlay;
        holdings.set(o.symbol, { shares, entryPrice: px, entryDate: dates[d]! });
      }
    }

    // 2. mark to market at today's close — carrying the last known mark
    // across a gap day (a missing bar must not zero the position)
    let value = cash;
    for (const [sym, h] of holdings) {
      const s = posOf.get(sym);
      const px = s === undefined ? null : close[d]?.[s];
      if (px != null && px > 0) lastMark.set(sym, px);
      const mark = px ?? lastMark.get(sym);
      if (mark != null) value += h.shares * mark;
    }
    equity.push(value);
    dailyReturns.push(d === 0 ? 0 : value / equity[d - 1]! - 1);

    // 3. signals at today's close → orders for tomorrow
    if (reranks.has(d)) {
      const ceiling = epCeiling(ep[d]!);
      const ranked: { s: number; score: number }[] = [];
      for (let s = 0; s < symbols.length; s++) {
        const sc = score[d]![s];
        if (sc == null || ceiling[s] == null || !gateOk(d, s)) continue;
        ranked.push({ s, score: sc });
      }
      ranked.sort((a, b) => b.score - a.score || symbols[a.s]!.localeCompare(symbols[b.s]!));
      const rankOf = new Map(ranked.map((r, i) => [symbols[r.s]!, i + 1]));
      for (const sym of holdings.keys()) {
        const s = posOf.get(sym)!;
        const r = rankOf.get(sym);
        if (r === undefined || r > bufferRank || !gateOk(d, s)) {
          pending.push({ symbol: sym, side: "sell", reason: "rerank" });
        }
      }
      let slots = topN - (holdings.size - pending.length);
      for (const r of ranked) {
        if (slots <= 0) break;
        if ((rankOf.get(symbols[r.s]!) ?? 0) > topN) continue;
        if (holdings.has(symbols[r.s]!)) continue;
        pending.push({ symbol: symbols[r.s]!, side: "buy", reason: "rerank" });
        slots--;
      }
    } else if (gated && gatePass) {
      // Nightly gate check (D2): a break exits at tomorrow's close.
      for (const sym of holdings.keys()) {
        const s = posOf.get(sym)!;
        if (gatePass[d]?.[s] === false) pending.push({ symbol: sym, side: "sell", reason: "gate" });
      }
    }
  }

  // final liquidation at the last close for complete trade stats
  const last = dates.length - 1;
  for (const sym of [...holdings.keys()]) sellAtClose(last, sym, "final");
  if (equity.length) equity[last] = cash;

  return { dates, equity, dailyReturns, trades };
}
