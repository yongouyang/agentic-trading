/**
 * EastmoneyRepairProvider — HK rescue loader (phase-1-hardening-plan §A).
 *
 * eastmoney `push2his` with `fqt=0` is the ONLY raw-bar HK rescue source
 * (tencent serves no raw HK series — hkfqkline fq='' and hkline/get both
 * return HTTP 200 + empty data; measured 2026-08-31). Request shape ported
 * verbatim from spike/data-probe.ts `eastmoneyHk`, with fields2 extended to
 * f51–f56 (date/open/close/high/low/volume) so full OHLCV Bars can be parsed
 * (the spike only needed date+close), and beg=0&end=20500101 for the full
 * window (superset of the spike's fixed 2021–2026 range).
 *
 * Hard measured constraint: eastmoney hard-drops TCP (temp IP ban) after ~5
 * requests at 0.35s spacing ⇒ ≥2s base + 0–50% jitter between requests
 * (internal last-request timestamp), and callers cap total calls per run
 * (runDailyScreen: 5). Spacing/sleep/fetch are injectable via constructor
 * opts (same testability pattern as YahooMarketDataProvider).
 *
 * This is deliberately NOT the Yahoo provider seam: no CA events exist here
 * (runDailyScreen keeps previously stored Yahoo dividend events on rescue).
 * Provider failures (TCP drop, timeout, non-200, empty klines) return
 * `{ failure: <slug> }` — NEVER throw; throwing is reserved for programming
 * errors (e.g. a non-HK symbol reaching hkSymbolMaps).
 */
import type { Bar } from "@agentic-trading/quant-core";
import { hkSymbolMaps } from "./hk-symbol-map.js";

const UA = "Mozilla/5.0";
const RAW_TIMEOUT_MS = 25_000;

/** Narrow rescue interface (phase-1-hardening-plan §A.2) — not the Yahoo
 *  seam; no corporate-action events exist on this source. */
export interface RepairProvider {
  fetchRawBars(symbol: string): Promise<{ bars: Bar[] } | { failure: string }>;
}

export interface EastmoneyRepairProviderOptions {
  /** Base spacing between requests in ms (default 2000; 0 in tests). */
  spacingMs?: number;
  /** fetch implementation (default global fetch). */
  fetchImpl?: typeof fetch;
  /** sleep function (default real setTimeout; tests inject a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Spike jitter(): base + uniform 0–50%. */
const jitter = (base: number) => base + Math.random() * base * 0.5;

const num = (s: string | undefined): number | null => {
  const v = Number(s);
  return s === undefined || s === "" || Number.isNaN(v) ? null : v;
};

export class EastmoneyRepairProvider implements RepairProvider {
  private readonly spacingMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastRequestAt = 0;

  constructor(opts: EastmoneyRepairProviderOptions = {}) {
    this.spacingMs = opts.spacingMs ?? 2_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? realSleep;
  }

  /** Sequential pacing: wait until at least jitter(spacingMs) has passed
   *  since the previous request (eastmoney ban protection, §A.1). */
  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt === 0 ? 0 : this.lastRequestAt + jitter(this.spacingMs) - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = Date.now();
  }

  async fetchRawBars(symbol: string): Promise<{ bars: Bar[] } | { failure: string }> {
    const { eastmoneySecid } = hkSymbolMaps(symbol); // throws on non-HK — programming error
    await this.throttle();
    const url =
      `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${eastmoneySecid}` +
      `&fields1=f1&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=0&beg=0&end=20500101`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), RAW_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url, { headers: { "User-Agent": UA }, signal: ac.signal });
      if (res.status !== 200) return { failure: `http-${res.status}` };
      const json = (await res.json()) as any;
      const klines: unknown = json?.data?.klines;
      // HTTP 200 + empty bar array is a wrong-shape response, never absence.
      if (!Array.isArray(klines) || klines.length === 0) return { failure: "http-200-empty-klines" };
      const bars: Bar[] = (klines as string[]).map((row) => {
        // fields2=f51..f56 ⇒ date,open,close,high,low,volume (spike row shape).
        const [date, open, close, high, low, volume] = String(row).split(",");
        return { date: date ?? "", open: num(open), high: num(high), low: num(low), close: num(close), volume: num(volume) };
      });
      return { bars };
    } catch (err: any) {
      if (err?.name === "AbortError") return { failure: "timeout" };
      const detail = String(err?.cause?.code ?? err?.cause?.message ?? err?.message ?? err);
      return { failure: `transport:${detail}`.slice(0, 160) };
    } finally {
      clearTimeout(timer);
    }
  }
}
