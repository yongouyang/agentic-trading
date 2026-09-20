/**
 * Phase 7 fundamentals ingest (docs/phase-7-plan.md §2 E1/E2): fetch and store
 * PIT fundamental points for every stored name.
 *   US — SEC EDGAR companyfacts (PIT-safe: each fact carries `filed`).
 *   HK — eastmoney F10 main indicators, columns=ALL (no announcement date
 *        exists; points carry the synthetic periodEnd+90d anchor — probe E2a).
 * Both are failure-as-value per symbol: one name's transport error is logged
 * and skipped, never fatal to the run. Re-ingest rewrites a symbol's points
 * for its source (delete + createMany) — idempotent content, no accumulation.
 */
import { hkSymbolMaps } from "../market-data/hk-symbol-map.js";
import {
  extractEastmoneyHkPoints,
  extractEdgarPoints,
  type FundamentalPointInput,
} from "./metrics.js";

const EDGAR_UA = "agentic-trading research (personal; contact: local)";
const EM_UA = "Mozilla/5.0";
const TIMEOUT_MS = 30_000;

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const jitter = (base: number) => base + Math.random() * base * 0.5;

export interface IngestOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Base spacing between requests, ms (SEC fair access ≈ 10/s; eastmoney uses
   *  the measured-clean 1s). Tests pass 0. */
  spacingMs?: number;
  now?: () => Date;
}

export interface SymbolIngestResult {
  symbol: string;
  points: number;
  failure: string | null;
}

export interface IngestSummary {
  market: "US" | "HK";
  attempted: number;
  ok: number;
  failed: { symbol: string; failure: string }[];
  points: number;
}

/** Minimal store contract — PrismaService satisfies it. */
export interface FundamentalsStore {
  fundamentalPoint: {
    deleteMany(args: { where: { symbol: string; source: string } }): Promise<unknown>;
    createMany(args: { data: FundamentalPointInput[] }): Promise<unknown>;
  };
}

async function fetchJson(
  url: string,
  ua: string,
  fetchImpl: typeof fetch,
): Promise<{ json: unknown } | { failure: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers: { "User-Agent": ua, Accept: "application/json" }, signal: ac.signal });
    if (res.status !== 200) return { failure: `http-${res.status}` };
    const json = await res.json();
    if (typeof json !== "object" || json === null) return { failure: "malformed-json" };
    return { json };
  } catch (err: any) {
    if (err?.name === "AbortError") return { failure: "timeout" };
    return { failure: `transport:${String(err?.cause?.code ?? err?.message ?? err)}`.slice(0, 160) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// US — SEC EDGAR
// ---------------------------------------------------------------------------

/** ticker → CIK via the SEC's static map (one call per run, cached by caller). */
export async function loadEdgarCikMap(
  opts: IngestOptions = {},
): Promise<{ map: Map<string, string> } | { failure: string }> {
  const res = await fetchJson("https://www.sec.gov/files/company_tickers.json", EDGAR_UA, opts.fetchImpl ?? fetch);
  if ("failure" in res) return res;
  const map = new Map<string, string>();
  for (const row of Object.values(res.json as Record<string, unknown>)) {
    const r = row as { ticker?: unknown; cik_str?: unknown };
    if (typeof r?.ticker === "string" && typeof r?.cik_str === "number") {
      map.set(r.ticker.toUpperCase(), String(r.cik_str).padStart(10, "0"));
    }
  }
  return map.size ? { map } : { failure: "empty-cik-map" };
}

export async function ingestUsSymbol(
  store: FundamentalsStore,
  symbol: string,
  cikMap: Map<string, string>,
  opts: IngestOptions = {},
): Promise<SymbolIngestResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  // EDGAR tickers are bare and uppercase; class shares use "-" in our store
  // ("BRK-B") while EDGAR's map also uses "-" — normalize defensively.
  const cik = cikMap.get(symbol.toUpperCase()) ?? cikMap.get(symbol.toUpperCase().replace(/[./]/g, "-"));
  if (!cik) return { symbol, points: 0, failure: "no-cik" };
  const res = await fetchJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, EDGAR_UA, fetchImpl);
  if ("failure" in res) return { symbol, points: 0, failure: res.failure };
  const points = extractEdgarPoints(symbol, res.json);
  await store.fundamentalPoint.deleteMany({ where: { symbol, source: "sec-edgar" } });
  if (points.length) await store.fundamentalPoint.createMany({ data: points });
  return { symbol, points: points.length, failure: null };
}

// ---------------------------------------------------------------------------
// HK — eastmoney F10 main indicators (columns=ALL; probe E2a measured 89)
// ---------------------------------------------------------------------------

export async function ingestHkSymbol(
  store: FundamentalsStore,
  symbol: string,
  opts: IngestOptions = {},
): Promise<SymbolIngestResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { eastmoneySecid } = hkSymbolMaps(symbol); // throws on non-HK — programming error
  const code = eastmoneySecid.slice("116.".length);
  const res = await fetchJson(
    `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_HKF10_FN_MAININDICATOR&columns=ALL` +
      `&filter=(SECURITY_CODE="${code}")&pageNumber=1&pageSize=40&sortTypes=-1&sortColumns=REPORT_DATE&source=F10&client=PC`,
    EM_UA,
    fetchImpl,
  );
  if ("failure" in res) return { symbol, points: 0, failure: res.failure };
  const result = (res.json as any).result;
  if (result === null || result === undefined) {
    // ETFs and names without an F10 report — legitimate absence (measured
    // 2800.HK on the dividend table; same semantics here).
    await store.fundamentalPoint.deleteMany({ where: { symbol, source: "eastmoney-f10" } });
    return { symbol, points: 0, failure: null };
  }
  if (!Array.isArray(result.data)) return { symbol, points: 0, failure: "http-200-wrong-shape" };
  const points = result.data.flatMap((row: unknown) => extractEastmoneyHkPoints(symbol, row));
  await store.fundamentalPoint.deleteMany({ where: { symbol, source: "eastmoney-f10" } });
  if (points.length) await store.fundamentalPoint.createMany({ data: points });
  return { symbol, points: points.length, failure: null };
}

// ---------------------------------------------------------------------------
// run + coverage
// ---------------------------------------------------------------------------

export async function runIngest(
  store: FundamentalsStore,
  market: "US" | "HK",
  symbols: string[],
  opts: IngestOptions = {},
): Promise<IngestSummary> {
  const sleep = opts.sleep ?? realSleep;
  const spacing = opts.spacingMs ?? (market === "US" ? 150 : 1_000);
  const summary: IngestSummary = { market, attempted: 0, ok: 0, failed: [], points: 0 };
  let cikMap: Map<string, string> | null = null;
  if (market === "US") {
    const res = await loadEdgarCikMap(opts);
    if ("failure" in res) {
      summary.failed = symbols.map((symbol) => ({ symbol, failure: `cik-map-${res.failure}` }));
      summary.attempted = symbols.length;
      return summary;
    }
    cikMap = res.map;
  }
  let lastAt = 0;
  for (const symbol of symbols) {
    if (lastAt !== 0) {
      const wait = lastAt + jitter(spacing) - Date.now();
      if (wait > 0) await sleep(wait);
    }
    lastAt = Date.now();
    const r = market === "US" ? await ingestUsSymbol(store, symbol, cikMap!, opts) : await ingestHkSymbol(store, symbol, opts);
    summary.attempted++;
    summary.points += r.points;
    if (r.failure) summary.failed.push({ symbol, failure: r.failure });
    else summary.ok++;
  }
  return summary;
}

export interface CoverageRow {
  market: string;
  names: number;
  /** Names meeting the plan's exit threshold (US: ≥8 quarter/annual revenue
   *  periods; HK: ≥4 semi/annual). */
  meeting: number;
  below: string[];
}

/**
 * The plan §2 exit criterion, computed from the store: US names need ≥8
 * revenue periods (quarter or annual), HK names ≥4 (semi or annual). Counts
 * distinct periodEnds of stored revenue points — restatements don't inflate.
 */
export function computeCoverage(
  points: { symbol: string; metric: string; periodEnd: string; periodType: string }[],
  marketSymbols: string[],
  market: "US" | "HK",
): CoverageRow {
  const threshold = market === "US" ? 8 : 4;
  const wanted = market === "US" ? new Set(["quarter", "annual"]) : new Set(["semi", "annual"]);
  const periodsBySymbol = new Map<string, Set<string>>();
  for (const p of points) {
    if (p.metric !== "revenue" || !wanted.has(p.periodType)) continue;
    if (!periodsBySymbol.has(p.symbol)) periodsBySymbol.set(p.symbol, new Set());
    periodsBySymbol.get(p.symbol)!.add(p.periodEnd);
  }
  const below = marketSymbols.filter((s) => (periodsBySymbol.get(s)?.size ?? 0) < threshold);
  return { market, names: marketSymbols.length, meeting: marketSymbols.length - below.length, below };
}
