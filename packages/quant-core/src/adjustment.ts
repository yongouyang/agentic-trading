/**
 * Price-adjustment module — invariant R1 (architecture §4.2), exactly as
 * measured 2026-08-31 (verification report, G2d detail + Surprise 2):
 *
 *   adj_t = raw_t × Π_{i>t}(1 − D_i / P_prev,i)
 *
 * - Multiplicative back-adjustment, anchored at the latest bar.
 * - DIVIDEND EVENTS ONLY — no split factor: Yahoo v8 raw closes are already
 *   split-adjusted; applying a split factor double-counts (measured NVDA
 *   +900% error; omitting it: 0.0000% vs Yahoo adjclose).
 * - The dividend price base P_prev is the PREVIOUS SESSION'S CLOSE, not the
 *   ex-date close (measured: prev-close 0.0000% vs ex-date-close 0.61% on
 *   2800.HK).
 * - Verified exact (≤0.0001% max deviation vs Yahoo adjclose) on 18 of 20
 *   probed names; the two HK failures are Yahoo FX bugs, not this math.
 */
import { Bar, CorporateAction } from "./types.js";

/** Derive the locally-adjusted close series from raw bars + dividend events.
 *  Returns a map date → adjusted close. Bars with null close are skipped. */
export function deriveAdjustedCloses(bars: Bar[], dividends: CorporateAction[]): Map<string, number> {
  const factors = factorSeries(bars, dividends);
  const out = new Map<string, number>();
  for (const b of bars) if (b.close != null) out.set(b.date, b.close * (factors.get(b.date) ?? 1));
  return out;
}

/** Same convention applied to full OHLC bars (signals read the adjusted
 *  series — R2). The per-bar factor equals the close factor. */
export function deriveAdjustedBars(
  bars: Bar[],
  dividends: CorporateAction[],
): (Bar & { adjustedClose: number })[] {
  const factors = factorSeries(bars, dividends);
  return bars
    .filter((b) => b.close != null)
    .map((b) => {
      const f = factors.get(b.date) ?? 1;
      return {
        ...b,
        open: b.open == null ? null : b.open * f,
        high: b.high == null ? null : b.high * f,
        low: b.low == null ? null : b.low * f,
        close: b.close! * f,
        adjustedClose: b.close! * f,
      };
    });
}

function factorSeries(bars: Bar[], dividends: CorporateAction[]): Map<string, number> {
  const ordered = bars.filter((b) => b.close != null);
  const prevClose = new Map<string, number>();
  ordered.forEach((b, i) => {
    if (i > 0) prevClose.set(b.date, ordered[i - 1]!.close!);
  });
  const divs = dividends.filter((d) => d.type === "DIVIDEND");
  const out = new Map<string, number>();
  for (const b of ordered) {
    let f = 1;
    for (const d of divs) {
      if (d.date > b.date) {
        const p = prevClose.get(d.date);
        if (p) f *= 1 - d.amount / p;
      }
    }
    out.set(b.date, f);
  }
  return out;
}
