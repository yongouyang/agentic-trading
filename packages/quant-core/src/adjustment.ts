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

/**
 * Which end of the sample the cumulative dividend factor is anchored at.
 *
 * **`back`** (the shipped default, and Yahoo's `adjclose` convention):
 *
 *     adj_back(t) = raw(t) × Π{d > t} (1 − D/P_prev)
 *
 * The value at t therefore depends on dividends that go ex AFTER t. Harmless
 * wherever it is used for a RATIO — every such factor appears in both the
 * numerator and the denominator of a return, so it cancels (`replay.ts` header
 * note 3) — but not for a cross-sectional LEVEL comparison, which is what a
 * factor panel feeds. See `docs/phase-6a-plan.md` amendment A2-1.
 *
 * **`forward`** (Phase 6A's panel convention, decided 2026-09-18):
 *
 *     adj_forward(t) = raw(t) / Π{d ≤ t} (1 − D/P_prev)
 *
 * Historically anchored, so the value at t uses only ex-dates at or before t.
 * Both conventions satisfy the same ratio identity,
 * `adj(t₂)/adj(t₁) = raw(t₂)/raw(t₁) × Π{t₁ < d ≤ t₂} f`, which is why they agree
 * on EVERY return and differ only in level — and it is the level identity for
 * which the panel needed the historical one. Truncating a forward-anchored series
 * is also a clean no-op on the data, which is what makes the look-ahead invariant
 * checkable by ordinary truncation. Its residual, stated because it is real: a
 * level is inflated by the symbol's own PAST dividend history, so a
 * level-sensitive alpha reads that history — past information, so not look-ahead,
 * but named in the manifest rather than left implicit.
 */
export type DividendAnchor = "back" | "forward";

/** Derive the locally-adjusted close series from raw bars + dividend events.
 *  Returns a map date → adjusted close. Bars with null close are skipped. */
export function deriveAdjustedCloses(
  bars: Bar[],
  dividends: CorporateAction[],
  anchor: DividendAnchor = "back",
): Map<string, number> {
  const factors = factorSeries(bars, dividends, anchor);
  const out = new Map<string, number>();
  for (const b of bars) if (b.close != null) out.set(b.date, b.close * (factors.get(b.date) ?? 1));
  return out;
}

/** Same convention applied to full OHLC bars (signals read the adjusted
 *  series — R2). The per-bar factor equals the close factor. */
export function deriveAdjustedBars(
  bars: Bar[],
  dividends: CorporateAction[],
  anchor: DividendAnchor = "back",
): (Bar & { adjustedClose: number })[] {
  const factors = factorSeries(bars, dividends, anchor);
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

/**
 * The forward-anchored (historically anchored, PIT-clean) bars — Phase 6A's panel
 * convention. A named alias rather than a bare `"forward"` argument at each call
 * site, because the two conventions are one keyword apart and a silent swap would
 * be invisible in every downstream number.
 */
export function deriveAdjustedBarsForward(bars: Bar[], dividends: CorporateAction[]): (Bar & { adjustedClose: number })[] {
  return deriveAdjustedBars(bars, dividends, "forward");
}

function factorSeries(bars: Bar[], dividends: CorporateAction[], anchor: DividendAnchor): Map<string, number> {
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
      // The ex-date bar already reflects the drop, so `back` scales the bars
      // strictly before it and `forward` scales the bars at or after it. The
      // two are reciprocals of each other's cumulative product, which is what
      // makes their returns identical.
      const applies = anchor === "back" ? d.date > b.date : d.date <= b.date;
      if (!applies) continue;
      const p = prevClose.get(d.date);
      if (!p) continue;
      const step = 1 - d.amount / p;
      if (step <= 0) continue; // a 100 %-or-more distribution has no usable factor
      f *= anchor === "back" ? step : 1 / step;
    }
    out.set(b.date, f);
  }
  return out;
}
