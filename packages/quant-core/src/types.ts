/**
 * Core shared types for the deterministic quant layer.
 * See docs/architecture-v1.md §4 (data layer) and §7 (signal representation).
 */

/** Raw daily OHLCV bar, exactly as delivered by the provider.
 *  R1 store-boundary invariant: stored raw is SPLIT-ADJUSTED as delivered
 *  (Yahoo v8 raw closes already are; a future provider that is not must be
 *  normalized by its loader before storage). Prices here are NEVER used for
 *  signal math directly — the derived adjusted series is (R2). */
export interface Bar {
  /** Session date, YYYY-MM-DD, provider session calendar. */
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

/** Outcome of a daily data fetch/quality gate, per §4.
 *  GENUINELY_ABSENT is SOURCE-SCOPED (verification report Surprise 1): it
 *  means "absent from this provider" (delisted, halted all-day, no such
 *  symbol) — never "the security does not exist"; a live symbol can land in
 *  this bucket. Exclude, log at info, no alarm.
 *  FETCH_FAILED (429, timeout, 5xx, schema break, wrong-shape 200) must never
 *  look like "this ticker has no opportunity": exclude from TODAY's screen,
 *  alert loudly, retry next run. Non-trivial FETCH_FAILED count ⇒ run degraded. */
export enum DataOutcome {
  OK = "OK",
  GENUINELY_ABSENT = "GENUINELY_ABSENT",
  FETCH_FAILED = "FETCH_FAILED",
}

/** Corporate-action event as stored (R1). v1: dividend events ONLY — no split
 *  factor is ever applied locally (stored raw is already split-adjusted;
 *  applying splits double-counts, measured NVDA +900% error). */
export interface CorporateAction {
  /** Ex-date, YYYY-MM-DD. */
  date: string;
  type: "DIVIDEND";
  /** Cash amount per share in `currency`. */
  amount: number;
  /** Currency the dividend is DECLARED in. Beware (measured 2026-08-31):
   *  Yahoo FX-converts USD-declared HK dividends; amounts for USD-declaring
   *  HK names are unusable for local adjustment — flag those instruments
   *  CA_DEGRADED (architecture §4, decided 2026-09-01). */
  currency: string;
}

/** Degraded-adjustment flag (architecture §4): set on USD-declaring HK names
 *  whose Yahoo event amounts cannot drive local adjustment. */
export const CA_DEGRADED = "CA_DEGRADED" as const;

/** 5-tier human-facing rating (UI/report), per §7 dual representation. */
export type Rating = "strong_sell" | "sell" | "neutral" | "buy" | "strong_buy";

/** Dual signal representation (§7): every verdict carries a 5-tier rating
 *  (human-facing) AND a continuous conviction in [-1, +1] (kept at full
 *  resolution so Phase 4 backtests lose nothing to bucketing).
 *  ABSTAIN ≠ NEUTRAL: an abstained signal is excluded from any blend's
 *  numerator AND denominator; a genuine 0.0 conviction is a real neutral
 *  vote. */
export interface Signal {
  instrumentId: string;
  rating: Rating;
  /** Continuous conviction in [-1, +1]. */
  conviction: number;
  /** Explicit abstention — distinct from conviction 0. */
  abstain: boolean;
}
