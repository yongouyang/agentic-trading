/**
 * Phase 7 P2 ingest (docs/phase-7-plan.md §E3): label every stored name with
 * a coarse sector bucket.
 *   US — EDGAR submissions API `sic` → sectorFromSic.
 *   HK — eastmoney F10 orgprofile `BELONG_INDUSTRY` → sectorFromEastmoneyIndustry.
 * Failure-as-value per symbol; re-runs overwrite the label. Spacing matches
 * the fundamentals ingest (US 150ms, HK 1s + jitter).
 */
import { hkSymbolMaps } from "../market-data/hk-symbol-map.js";
import { sectorFromEastmoneyIndustry, sectorFromSic, type SectorBucket } from "./sectors.js";
import { loadEdgarCikMap, type IngestOptions } from "./ingest.js";

const EDGAR_UA = "agentic-trading research (personal; contact: local)";
const EM_UA = "Mozilla/5.0";
const TIMEOUT_MS = 30_000;

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const jitter = (base: number) => base + Math.random() * base * 0.5;

export interface SectorStore {
  instrument: {
    update(args: { where: { symbol: string }; data: { sector: string } }): Promise<unknown>;
  };
}

async function fetchJson(
  url: string,
  ua: string,
  fetchImpl: typeof fetch,
): Promise<{ json: any } | { failure: string }> {
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

export async function fetchUsSector(
  symbol: string,
  cikMap: Map<string, string>,
  opts: IngestOptions = {},
): Promise<{ sector: SectorBucket; raw: string } | { failure: string }> {
  const cik = cikMap.get(symbol.toUpperCase()) ?? cikMap.get(symbol.toUpperCase().replace(/[./]/g, "-"));
  if (!cik) return { failure: "no-cik" };
  const res = await fetchJson(`https://data.sec.gov/submissions/CIK${cik}.json`, EDGAR_UA, opts.fetchImpl ?? fetch);
  if ("failure" in res) return res;
  const sic = typeof res.json.sic === "string" ? res.json.sic : "";
  return { sector: sectorFromSic(sic), raw: sic ? `${sic} ${res.json.sicDescription ?? ""}`.trim() : "no-sic" };
}

export async function fetchHkSector(
  symbol: string,
  opts: IngestOptions = {},
): Promise<{ sector: SectorBucket; raw: string } | { failure: string }> {
  const { eastmoneySecid } = hkSymbolMaps(symbol);
  const code = eastmoneySecid.slice("116.".length);
  const res = await fetchJson(
    `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_HKF10_INFO_ORGPROFILE&columns=ALL` +
      `&filter=(SECURITY_CODE="${code}")&pageNumber=1&pageSize=1&source=F10&client=PC`,
    EM_UA,
    opts.fetchImpl ?? fetch,
  );
  if ("failure" in res) return res;
  const row = res.json?.result?.data?.[0];
  if (!row) return { failure: "no-orgprofile" };
  const industry = typeof row.BELONG_INDUSTRY === "string" ? row.BELONG_INDUSTRY : "";
  return { sector: sectorFromEastmoneyIndustry(industry), raw: industry || "no-industry" };
}

export interface SectorSummary {
  market: "US" | "HK";
  attempted: number;
  labelled: number;
  failed: { symbol: string; failure: string }[];
  byBucket: Record<string, number>;
}

export async function runSectorRefresh(
  store: SectorStore,
  market: "US" | "HK",
  symbols: string[],
  opts: IngestOptions = {},
): Promise<SectorSummary> {
  const sleep = opts.sleep ?? realSleep;
  const spacing = opts.spacingMs ?? (market === "US" ? 150 : 1_000);
  const summary: SectorSummary = { market, attempted: 0, labelled: 0, failed: [], byBucket: {} };
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
    summary.attempted++;
    const r = market === "US" ? await fetchUsSector(symbol, cikMap!, opts) : await fetchHkSector(symbol, opts);
    if ("failure" in r) {
      summary.failed.push({ symbol, failure: r.failure });
      continue;
    }
    await store.instrument.update({ where: { symbol }, data: { sector: r.sector } });
    summary.labelled++;
    summary.byBucket[r.sector] = (summary.byBucket[r.sector] ?? 0) + 1;
  }
  return summary;
}
