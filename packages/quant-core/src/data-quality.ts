/**
 * Data-quality module — Day-17 checklist, seeded by porting the check
 * functions from spike/data-probe.ts (measured 2026-08-31, see
 * docs/phase-0-verification-report.md). Checks are typed and loud, never
 * silent (architecture §4).
 */
import { Bar, DataOutcome } from "./types.js";

export interface QualityReport {
  /** Hard defects (duplicates, non-positive close, OHLC violations). */
  failures: string[];
  /** Soft anomalies (gaps, zero volume, stale last bar, >20% outliers). */
  warnings: string[];
}

/** Known market holidays per year (spike allowance heuristic). */
export const HOLIDAYS_PER_YEAR: Record<string, number> = { US: 11, HK: 16, LSE: 9, IDX: 11 };

export function weekdaysBetween(d0: string, d1: string): string[] {
  const out: string[] = [];
  const d = new Date(d0 + "T00:00:00Z");
  const end = new Date(d1 + "T00:00:00Z");
  while (d <= end) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Duplicate session dates. */
export function checkDuplicates(dates: string[]): number {
  const seen = new Set<string>();
  let dups = 0;
  for (const d of dates) (seen.has(d) ? dups++ : seen.add(d));
  return dups;
}

/** Missing weekday sessions beyond the holiday allowance. */
export function findDateGaps(dates: string[], market: string): { missing: string[]; allowance: number } {
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (!first || !last) return { missing: [], allowance: 0 };
  const wd = weekdaysBetween(first, last);
  const years = wd.length / 260;
  const allowance = Math.ceil(years * (HOLIDAYS_PER_YEAR[market] ?? 11)) + 2;
  const seen = new Set(dates);
  return { missing: wd.filter((d) => !seen.has(d)), allowance };
}

/** Zero / null-volume bars. Indices legitimately report none. */
export function findZeroVolumeBars(bars: Bar[]): Bar[] {
  return bars.filter((b) => !b.volume);
}

/** Stale last bar: the newest session is not among the 3 most recent
 *  weekdays. Pass `today` explicitly to keep the check deterministic. */
export function isStaleLastBar(lastDate: string, today: string): boolean {
  const from = new Date(new Date(today + "T00:00:00Z").getTime() - 10 * 86400_000).toISOString().slice(0, 10);
  const recent = weekdaysBetween(from, today).slice(-3);
  return !recent.includes(lastDate);
}

/** OHLC sanity: non-positive close (failure) and close outside [H,L] or
 *  H < L (measured real at the edges — report Surprise 5: 1–16 such bars on
 *  LSE UCITS ETFs and HK edge names). */
export function checkOhlcSanity(bars: Bar[]): { nonPositive: string[]; outsideHL: string[] } {
  const nonPositive: string[] = [];
  const outsideHL: string[] = [];
  for (const b of bars) {
    if (b.close == null) continue;
    if (b.close <= 0) nonPositive.push(b.date);
    if (b.high != null && b.low != null && (b.high < b.low || b.high < b.close || b.low > b.close)) {
      outsideHL.push(b.date);
    }
  }
  return { nonPositive, outsideHL };
}

/** Single-day |return| > 20% outliers (raw closes). Genuine moves exist
 *  (NVDA +24.4% post-earnings) — flag, never auto-repair. */
export function findOutlierMoves(bars: Bar[], threshold = 0.2): { date: string; pct: number }[] {
  const spikes: { date: string; pct: number }[] = [];
  const ordered = bars.filter((b) => b.close != null);
  for (let i = 1; i < ordered.length; i++) {
    const ret = Math.abs(ordered[i]!.close! / ordered[i - 1]!.close! - 1);
    if (ret > threshold) spikes.push({ date: ordered[i]!.date, pct: ret });
  }
  return spikes;
}

/** Full Day-17 check battery over a clean-close series. */
export function runChecks(market: string, bars: Bar[], today: string): QualityReport {
  const clean = bars.filter((b) => b.close != null);
  const dates = clean.map((b) => b.date);
  const failures: string[] = [];
  const warnings: string[] = [];

  const dups = checkDuplicates(dates);
  if (dups) failures.push(`duplicate timestamps: ${dups}`);

  const { missing, allowance } = findDateGaps(dates, market);
  if (missing.length > allowance) {
    warnings.push(`missing sessions: ${missing.length} weekdays absent (allowance ${allowance}); first few: ${missing.slice(0, 5).join(",")}`);
  }

  const { nonPositive, outsideHL } = checkOhlcSanity(clean);
  for (const d of nonPositive) failures.push(`non-positive close on ${d}`);
  if (outsideHL.length) failures.push(`OHLC sanity violations: ${outsideHL.length}/${clean.length} bars [${outsideHL.slice(0, 5).join(",")}]`);

  const zv = findZeroVolumeBars(clean);
  if (market !== "IDX" && zv.length) warnings.push(`zero/null-volume days: ${zv.length} (${zv[0]!.date}…)`);

  const last = dates[dates.length - 1];
  if (last && isStaleLastBar(last, today)) warnings.push(`stale last bar: ${last}`);

  const spikes = findOutlierMoves(clean);
  if (spikes.length) warnings.push(`|ret|>20% outliers: ${spikes.map((s) => `${s.date} ${(s.pct * 100).toFixed(1)}%`).join("; ")}`);

  return { failures, warnings };
}

// ---------------------------------------------------------------------------
// Loader rules — measured provider facts from the verification report,
// encoded as documented, deterministic rules.
// ---------------------------------------------------------------------------

/** RULE L1 (report Surprise 5 / §"HK blue chips"): Yahoo fabricates
 *  zero-volume phantom bars on HKEX holidays (e.g. 2022-01-31 Lunar New Year,
 *  on every HK ticker). Drop zero-volume bars whose date is a known exchange
 *  holiday. Zero-volume bars on real sessions (illiquid names: 0623.HK had
 *  250/1227) are KEPT — they are genuine data. */
export function dropHolidayPhantomBars(bars: Bar[], holidayDates: ReadonlySet<string>): Bar[] {
  return bars.filter((b) => !(holidayDates.has(b.date) && !b.volume));
}

/** RULE L2 (report Surprise 5 / "Loader hardening backlog"): clamp a close
 *  that sits outside [H,L] into the range (Yahoo feed bug, 1–16 bars on edge
 *  names and all 5 LSE UCITS). Also widens H/L to cover O/C. Repair, never
 *  silently: returns the repaired bars plus the list of touched dates so the
 *  caller logs them loudly. */
export function clampOhlc(bars: Bar[]): { bars: Bar[]; repaired: string[] } {
  const repaired: string[] = [];
  const out = bars.map((b) => {
    if (b.open == null || b.high == null || b.low == null || b.close == null) return b;
    let { high, low, close } = b;
    if (close > high || close < low) {
      close = Math.min(Math.max(close, low), high);
      repaired.push(b.date);
    }
    high = Math.max(high, b.open, close);
    low = Math.min(low, b.open, close);
    if (high !== b.high || low !== b.low || close !== b.close) return { ...b, high, low, close };
    return b;
  });
  return { bars: out, repaired };
}

/** Loader-response classification inputs shared by every provider loader. */
export interface RawResponseShape {
  /** HTTP status (or null for transport failure: timeout / dropped conn). */
  httpStatus: number | null;
  /** True when the payload parses but carries no bar/timestamp array. */
  hasTimestamps: boolean;
  /** Number of bars present in the payload. */
  barCount: number;
  /** Provider error body matched against "No data found" / 404 semantics. */
  providerSaysNotFound: boolean;
}

/** RULE L3 / L4 — response-shape → DataOutcome taxonomy (G5, measured 5/5):
 *  - "No data found" / 404                       → GENUINELY_ABSENT (source-scoped!)
 *  - transport failure, 429, timeout, 5xx        → FETCH_FAILED
 *  - HTTP 200 + zombie meta (no timestamps; RYL) → FETCH_FAILED  [RULE L3]
 *  - HTTP 200 + empty bar array (tencent hk0005) → FETCH_FAILED  [RULE L4]
 *  A wrong-shape 200 is NEVER GENUINELY_ABSENT. */
export function classifyResponse(r: RawResponseShape): DataOutcome {
  if (r.providerSaysNotFound || r.httpStatus === 404) return DataOutcome.GENUINELY_ABSENT;
  if (r.httpStatus !== 200) return DataOutcome.FETCH_FAILED;
  if (!r.hasTimestamps || r.barCount === 0) return DataOutcome.FETCH_FAILED;
  return DataOutcome.OK;
}
