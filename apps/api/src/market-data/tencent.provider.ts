/**
 * TencentKlineProvider — HK **session-date** cross-check source for the weekly
 * sentinel (phase-1-hardening-plan §B check 3, architecture §4.3).
 *
 * Deliberately narrow: it returns DATES ONLY, never closes. Two measured
 * reasons (docs/phase-0-verification-report.md §"New finding", spike 2026-08-31):
 *  - tencent serves NO raw (unadjusted) HK series — `fq=""` on hkfqkline and
 *    hkline/get both answer HTTP 200 with empty data, so its closes can never
 *    be compared with our raw store;
 *  - its `qfq` closes use an undisclosed adjustment convention (RULE R4), so
 *    comparing them would manufacture false alarms.
 * Session DATES, however, are convention-free, which makes them usable as an
 * independent session-calendar check on Yahoo. Request shape is the spike's
 * verbatim `tencentHk()`: `param=hk<5-digit>,day,,,1200,qfq` (Yahoo is
 * 4-digit — mapping via `hkSymbolMaps`).
 *
 * Measured operational facts encoded here:
 *  - ≤1200 bars per call ⇒ tencent covers ~4.6y of the 5y store; the sentinel
 *    diff restricts itself to the overlapping window (a 5y backfill would need
 *    2 calls — out of scope for a date-overlap check).
 *  - 9 calls at 0.5–0.6s spacing: zero throttling ⇒ 500ms base + 0–50% jitter.
 *  - HTTP 200 + empty bar array (wrong-but-plausible code shape, e.g. the
 *    4-digit `hk0005`) is a FETCH_FAILED-classifying shape, NEVER absence
 *    (RULE L4) — surfaced as `{ failure: "http-200-empty-bars" }`.
 *  - `qfqday` is absent on some names (measured 3195.HK): fall back to `day`.
 *
 * Provider failures return `{ failure }` and never throw; throwing is reserved
 * for programming errors (a non-HK symbol reaching hkSymbolMaps). Spacing,
 * sleep and fetch are injectable (same testability pattern as
 * YahooMarketDataProvider / EastmoneyRepairProvider).
 */
import { hkSymbolMaps } from "./hk-symbol-map.js";

const UA = "Mozilla/5.0";
const RAW_TIMEOUT_MS = 25_000;
/** Spike's pinned page size — tencent's hard per-call cap. */
const TENCENT_BAR_CAP = 1200;

/** Result of the date-only cross-check fetch. `{ dates }` on success,
 *  `{ failure }` on any provider problem (never throws). */
export interface TencentDatesOk {
  dates: string[];
  /** Which array the dates came from — "qfq" (adjusted series) or "day"
   *  (unadjusted series, some ETFs). Diagnostic only; dates are identical
   *  session calendars either way. */
  series: "qfq" | "day";
}
export type TencentDatesResult = TencentDatesOk | { failure: string };

/** Seam the sentinel depends on (fake-injectable in tests). */
export interface TencentDateSource {
  fetchSessionDates(symbol: string): Promise<TencentDatesResult>;
}

export interface TencentKlineProviderOptions {
  /** Base spacing between requests in ms (default 500; 0 in tests). */
  spacingMs?: number;
  /** fetch implementation (default global fetch). */
  fetchImpl?: typeof fetch;
  /** sleep function (default real setTimeout; tests inject a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Spike jitter(): base + uniform 0–50%. */
const jitter = (base: number) => base + Math.random() * base * 0.5;

export class TencentKlineProvider implements TencentDateSource {
  private readonly spacingMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastRequestAt = 0;

  constructor(opts: TencentKlineProviderOptions = {}) {
    this.spacingMs = opts.spacingMs ?? 500;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? realSleep;
  }

  /** Sequential pacing: wait until at least jitter(spacingMs) has elapsed
   *  since the previous request. */
  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt === 0 ? 0 : this.lastRequestAt + jitter(this.spacingMs) - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = Date.now();
  }

  /** Request URL (exported shape for tests/docs — identical to the spike's). */
  static urlFor(symbol: string): string {
    const { tencentCode } = hkSymbolMaps(symbol);
    return `https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get?param=${tencentCode},day,,,${TENCENT_BAR_CAP},qfq`;
  }

  async fetchSessionDates(symbol: string): Promise<TencentDatesResult> {
    const { tencentCode } = hkSymbolMaps(symbol); // throws on non-HK — programming error
    await this.throttle();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), RAW_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(TencentKlineProvider.urlFor(symbol), {
        headers: { "User-Agent": UA },
        signal: ac.signal,
      });
      if (res.status !== 200) return { failure: `http-${res.status}` };
      const json = (await res.json().catch(() => null)) as any;
      if (!json) return { failure: "http-200-unparseable" };
      const node = json?.data?.[tencentCode];
      if (!node || typeof node !== "object") return { failure: "http-200-no-node" };
      const qfq: unknown = node.qfqday;
      const day: unknown = node.day;
      const rows = (Array.isArray(qfq) && qfq.length ? qfq : Array.isArray(day) && day.length ? day : null) as
        | unknown[]
        | null;
      // RULE L4: a wrong-shape 200 (empty day/qfqday array) is a fetch failure,
      // never GENUINELY_ABSENT.
      if (!rows) {
        return { failure: `http-200-empty-bars (keys=${Object.keys(node).slice(0, 6).join("/") || "none"})` };
      }
      const series: "qfq" | "day" = Array.isArray(qfq) && qfq.length ? "qfq" : "day";
      const dates = rows
        .map((row) => (Array.isArray(row) ? String(row[0] ?? "") : ""))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
      if (!dates.length) return { failure: "http-200-no-parseable-dates" };
      return { dates, series };
    } catch (err: any) {
      if (err?.name === "AbortError") return { failure: "timeout" };
      const detail = String(err?.cause?.code ?? err?.cause?.message ?? err?.message ?? err);
      return { failure: `transport:${detail}`.slice(0, 160) };
    } finally {
      clearTimeout(timer);
    }
  }
}
