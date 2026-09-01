/**
 * YahooMarketDataProvider — real Yahoo v8 loader (phase-1-spec §2), ported
 * from the proven spike/data-probe.ts pattern:
 *
 *  - yahoo-finance2 `chart()` first (pinned UA "Mozilla/5.0" — the long Chrome
 *    UA drew immediate 429s in probing; concurrency 1; allowAdditionalProps).
 *  - On yahoo-finance2 schema-validation rejection (bars Yahoo actually
 *    served, e.g. zombie meta), fall back to the raw v8 chart endpoint via
 *    plain fetch before classifying.
 *  - Always the full trailing 5-year window unless an explicit window is
 *    given; interval=1d, events=div|split, return=array (the exact option set
 *    verified live in the spike — `includeAdjustedClose` is rejected by the
 *    v4 options schema, and we derive adjusted locally anyway, R1).
 *  - Strictly sequential: 200ms base + uniform 0–50% jitter BETWEEN requests
 *    (internal last-request timestamp; spacing injectable for tests).
 *  - One in-run retry after 5s on 429/timeout/5xx (backoff injectable);
 *    a second failure returns a FETCH_FAILED-classifying response — the
 *    provider NEVER throws for provider failures (throwing is reserved for
 *    programming errors). Classification stays in MarketDataService via
 *    quant-core classifyResponse; the provider never pre-judges.
 *  - Split events are counted (splitCount, audit only) and never stored (R1).
 */
import YahooFinance from "yahoo-finance2";
import type { Bar, CorporateAction } from "@agentic-trading/quant-core";
import type { FetchWindow, MarketDataProvider, RawMarketDataResponse } from "./market-data.types.js";

const UA = "Mozilla/5.0";
const FIVE_YEARS_MS = 5 * 365.25 * 86400_000;
const RAW_TIMEOUT_MS = 25_000;

export interface YahooMarketDataProviderOptions {
  /** Base spacing between requests in ms (default 200; 0 in tests). */
  spacingMs?: number;
  /** In-run retry backoff in ms (default 5000; 0 in tests). */
  retryBackoffMs?: number;
  /** fetch implementation for the raw v8 fallback (default global fetch). */
  fetchImpl?: typeof fetch;
  /** yahoo-finance2 chart function (default: a pinned-UA instance). */
  chart?: (symbol: string, query: Record<string, unknown>) => Promise<unknown>;
  /** sleep function (default real setTimeout; tests inject a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Spike jitter(): base + uniform 0–50%. */
const jitter = (base: number) => base + Math.random() * base * 0.5;

function toDateString(d: unknown): string {
  const date = d instanceof Date ? d : new Date(d as string | number);
  return date.toISOString().slice(0, 10);
}

interface FetchAttempt extends RawMarketDataResponse {
  /** True when the failure is worth one in-run retry (429/timeout/5xx). */
  retryable: boolean;
}

export class YahooMarketDataProvider implements MarketDataProvider {
  private readonly spacingMs: number;
  private readonly retryBackoffMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly chartFn: (symbol: string, query: Record<string, unknown>) => Promise<unknown>;
  private lastRequestAt = 0;

  constructor(opts: YahooMarketDataProviderOptions = {}) {
    this.spacingMs = opts.spacingMs ?? 200;
    this.retryBackoffMs = opts.retryBackoffMs ?? 5_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? realSleep;
    this.chartFn =
      opts.chart ??
      (() => {
        const yf = new YahooFinance({
          fetchOptions: { headers: { "User-Agent": UA } },
          queue: { concurrency: 1, interval: 0 },
          validation: { logErrors: false, logOptionsErrors: false, allowAdditionalProps: true },
        });
        return (symbol, query) => yf.chart(symbol, query as never);
      })();
  }

  /** Sequential pacing: wait until at least jitter(spacingMs) has passed
   *  since the previous request. Exposed internally so tests can zero it. */
  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt === 0 ? 0 : this.lastRequestAt + jitter(this.spacingMs) - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = Date.now();
  }

  async fetchDailyBars(symbol: string, opts?: FetchWindow): Promise<RawMarketDataResponse> {
    const period2 = opts?.period2 ? new Date(opts.period2) : new Date();
    const period1 = opts?.period1 ? new Date(opts.period1) : new Date(period2.getTime() - FIVE_YEARS_MS);

    let attempt = await this.fetchOnce(symbol, period1, period2);
    if (attempt.retryable) {
      await this.sleep(this.retryBackoffMs);
      attempt = await this.fetchOnce(symbol, period1, period2);
    }
    const { retryable: _retryable, ...response } = attempt;
    return response;
  }

  private async fetchOnce(symbol: string, period1: Date, period2: Date): Promise<FetchAttempt> {
    await this.throttle();
    try {
      const r = (await this.chartFn(symbol, {
        period1,
        period2,
        interval: "1d",
        events: "div|split",
        return: "array",
      })) as Record<string, any>;
      return this.mapChartResult(r);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      // yahoo-finance2 schema validation can reject bars Yahoo actually served
      // (e.g. RYL's zombie meta) — fall back to the raw v8 endpoint, same UA.
      if (/Schema validation/i.test(msg)) {
        return this.fetchRaw(symbol, period1, period2);
      }
      return this.classifyError(err);
    }
  }

  /** Map a yahoo-finance2 chart result (object form) to the raw response
   *  shape. Never classifies — wrong shapes flow through for classifyResponse. */
  private mapChartResult(r: Record<string, any>): FetchAttempt {
    const quotes: any[] = r?.quotes ?? [];
    const currency: string = r?.meta?.currency ?? "USD";
    const bars: Bar[] = quotes.map((q) => ({
      date: toDateString(q.date),
      open: q.open ?? null,
      high: q.high ?? null,
      low: q.low ?? null,
      close: q.close ?? null,
      volume: q.volume ?? null,
    }));
    const corporateActions: CorporateAction[] = (r?.events?.dividends ?? []).map((d: any) => ({
      date: toDateString(d.date),
      type: "DIVIDEND" as const,
      amount: d.amount,
      currency,
    }));
    return {
      httpStatus: 200,
      hasTimestamps: quotes.length > 0,
      bars,
      corporateActions,
      providerSaysNotFound: false,
      splitCount: (r?.events?.splits ?? []).length,
      retryable: false,
      ...(quotes.length === 0 ? { failureReason: "http-200-empty-bars" } : {}),
    };
  }

  /** Raw v8 chart endpoint fallback (spike yahooBarsRaw). */
  private async fetchRaw(symbol: string, period1: Date, period2: Date): Promise<FetchAttempt> {
    const p1 = Math.floor(period1.getTime() / 1000);
    const p2 = Math.floor(period2.getTime() / 1000);
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?period1=${p1}&period2=${p2}&interval=1d&events=div%2Csplit&includeAdjustedClose=true`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), RAW_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url, { headers: { "User-Agent": UA }, signal: ac.signal });
      if (res.status !== 200) {
        return {
          httpStatus: res.status,
          hasTimestamps: false,
          bars: [],
          corporateActions: [],
          providerSaysNotFound: res.status === 404,
          failureReason: `http-${res.status}`,
          retryable: res.status === 429 || res.status >= 500,
        };
      }
      const chart = ((await res.json()) as any)?.chart;
      if (chart?.error) {
        const absent = /No data found|Not Found/i.test(JSON.stringify(chart.error));
        return {
          httpStatus: 200,
          hasTimestamps: false,
          bars: [],
          corporateActions: [],
          providerSaysNotFound: absent,
          failureReason: JSON.stringify(chart.error).slice(0, 160),
          retryable: !absent,
        };
      }
      const d = chart?.result?.[0];
      const ts: number[] | undefined = d?.timestamp;
      if (!ts || !ts.length) {
        // HTTP 200 + empty/missing timestamp (incl. zombie meta) — RULE L3/L4.
        return {
          httpStatus: 200,
          hasTimestamps: Boolean(ts?.length),
          bars: [],
          corporateActions: [],
          providerSaysNotFound: false,
          failureReason: `http-200-empty-timestamp (meta.instrumentType=${d?.meta?.instrumentType ?? "?"})`,
          retryable: false,
        };
      }
      const q = d.indicators?.quote?.[0] ?? {};
      const date = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
      const currency: string = d.meta?.currency ?? "USD";
      return {
        httpStatus: 200,
        hasTimestamps: true,
        bars: ts.map((t, i) => ({
          date: date(t),
          // Optional per-array: v8 omits an indicator array entirely on sparse
          // payloads, and reading `undefined[i]` would misclassify a served
          // response as a transport failure.
          open: q.open?.[i] ?? null,
          high: q.high?.[i] ?? null,
          low: q.low?.[i] ?? null,
          close: q.close?.[i] ?? null,
          volume: q.volume?.[i] ?? null,
        })),
        corporateActions: Object.values(d.events?.dividends ?? {}).map((v: any) => ({
          date: date(v.date),
          type: "DIVIDEND" as const,
          amount: v.amount,
          currency,
        })),
        providerSaysNotFound: false,
        splitCount: Object.keys(d.events?.splits ?? {}).length,
        retryable: false,
      };
    } catch (err: any) {
      const timeout = err?.name === "AbortError";
      return {
        httpStatus: null,
        hasTimestamps: false,
        bars: [],
        corporateActions: [],
        providerSaysNotFound: false,
        failureReason: timeout ? "timeout" : String(err?.message ?? err).slice(0, 160),
        retryable: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Classify a yahoo-finance2 thrown error into the raw response shape
   *  (message-based — the library does not expose a stable status field). */
  private classifyError(err: any): FetchAttempt {
    const msg = String(err?.message ?? err);
    if (/No data found|Not Found|symbol may be delisted|404/.test(msg)) {
      return {
        httpStatus: /404/.test(msg) ? 404 : null,
        hasTimestamps: false,
        bars: [],
        corporateActions: [],
        providerSaysNotFound: true,
        failureReason: "no-data-found",
        retryable: false,
      };
    }
    const m = msg.match(/\b(429|5\d\d)\b/);
    const status = m ? Number(m[1]) : null;
    const timeout = /abort|timeout|timed out/i.test(msg);
    return {
      httpStatus: status,
      hasTimestamps: false,
      bars: [],
      corporateActions: [],
      providerSaysNotFound: false,
      failureReason: status ? `http-${status}` : timeout ? "timeout" : msg.slice(0, 160),
      retryable: status === 429 || (status !== null && status >= 500) || timeout || status === null,
    };
  }
}
