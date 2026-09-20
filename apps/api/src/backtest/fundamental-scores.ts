/**
 * Phase 7 P4 — building the PIT score panel (docs/phase-7-plan.md §3–§4).
 *
 * Turns stored FundamentalPoints + the price panel into date × symbol score
 * matrices the backtest CLI consumes. The look-ahead discipline:
 *
 *  - Per symbol, the fundamental state is recomputed ONCE per distinct filedAt
 *    (the only dates the known-set changes) via `pointsKnownAt` — the single
 *    sanctioned PIT read. A panel session T sees the snapshot from the latest
 *    filedAt ≤ T.
 *  - E/P uses the snapshot's TTM earnings and share count but the close AT T
 *    (price is known at T; the fundamentals legs are PIT).
 *  - Cross-sectional winsorized z-scores are computed per session across the
 *    names with a snapshot; the final score is the declared market-weighted
 *    blend (US 70/30, HK 60/40 — §3, not tunable).
 *
 * A name enters the panel only when it has a computable score (≥3 of 5
 * components plus a full E/P leg set) — the §4 warmup falls out of the TTM
 * requirements rather than a separate counter.
 */
import {
  combineScore,
  compositeComponents,
  latestStock,
  qualityCompositeZ,
  trailingTwelveMonths,
  winsorizedZScores,
  type CompositeComponents,
  type PitPoint,
} from "@agentic-trading/quant-core";
import { pointsKnownAt } from "../fundamentals/metrics.js";

export interface FundamentalRow {
  symbol: string;
  metric: string;
  periodEnd: string;
  periodType: string;
  filedAt: string;
  value: number;
}

interface Snapshot {
  filedAt: string;
  components: CompositeComponents;
  /** E/P legs at the snapshot; the price leg is applied per session. */
  niTtm: number | null;
  shares: number | null;
}

/** Per-symbol snapshots at each distinct filedAt (sorted ascending). Pure. */
export function buildSnapshots(points: FundamentalRow[]): Snapshot[] {
  const asPit: PitPoint[] = points.map((p) => ({
    metric: p.metric,
    periodEnd: p.periodEnd,
    periodType: p.periodType as PitPoint["periodType"],
    filedAt: p.filedAt,
    value: p.value,
  }));
  const filings = [...new Set(points.map((p) => p.filedAt))].sort();
  return filings.map((filedAt) => {
    const known = pointsKnownAt(asPit, filedAt);
    return {
      filedAt,
      components: compositeComponents(known, filedAt),
      niTtm: trailingTwelveMonths(known, "netIncome", filedAt),
      shares: latestStock(known, "sharesOutstanding", filedAt),
    };
  });
}

export interface ScorePanel {
  /** Final blended score, [dateIdx][symbolIdx], null = not scored. */
  score: (number | null)[][];
  /** Earnings yield, same shape (the valuation-ceiling input). */
  ep: (number | null)[][];
}

/**
 * The blended score panel for one market, aligned to the price panel's axes.
 * `closes[d][s]` is the dividend-adjusted close (the E/P price leg).
 */
export function buildScorePanel(
  market: "US" | "HK",
  dates: string[],
  symbols: string[],
  closes: (number | null)[][],
  pointsBySymbol: Map<string, FundamentalRow[]>,
): ScorePanel {
  const snapshotsBySymbol = new Map<string, Snapshot[]>();
  for (const [sym, pts] of pointsBySymbol) {
    if (pts.length) snapshotsBySymbol.set(sym, buildSnapshots(pts));
  }

  const score: (number | null)[][] = [];
  const ep: (number | null)[][] = [];
  // Per-symbol cursor into its snapshot list (dates and filings both ascend).
  const cursor = new Map<string, number>();
  const current = new Map<string, Snapshot>();

  for (let d = 0; d < dates.length; d++) {
    const date = dates[d]!;
    for (const [sym, snaps] of snapshotsBySymbol) {
      let c = cursor.get(sym) ?? 0;
      while (c < snaps.length && snaps[c]!.filedAt <= date) c++;
      if (c > 0) {
        cursor.set(sym, c);
        current.set(sym, snaps[c - 1]!);
      }
    }
    const componentsArr: CompositeComponents[] = [];
    const epArr: (number | null)[] = [];
    const positions: number[] = [];
    for (let s = 0; s < symbols.length; s++) {
      const snap = current.get(symbols[s]!);
      if (!snap) continue;
      positions.push(s);
      componentsArr.push(snap.components);
      const px = closes[d]?.[s];
      epArr.push(
        px != null && px > 0 && snap.niTtm != null && snap.shares != null && snap.shares > 0
          ? snap.niTtm / (snap.shares * px)
          : null,
      );
    }
    const qz = qualityCompositeZ(componentsArr);
    const ez = winsorizedZScores(epArr);
    const scoreRow = new Array<number | null>(symbols.length).fill(null);
    const epRow = new Array<number | null>(symbols.length).fill(null);
    for (let i = 0; i < positions.length; i++) {
      const s = positions[i]!;
      epRow[s] = epArr[i]!;
      const q = qz[i] ?? null;
      const e = ez[i] ?? null;
      if (q != null && e != null) scoreRow[s] = combineScore(market, q, e);
    }
    score.push(scoreRow);
    ep.push(epRow);
  }
  return { score, ep };
}
