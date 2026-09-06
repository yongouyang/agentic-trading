/**
 * News assembler (phase-2-plan): Google News RSS per name — HK names get TWO
 * queries (Chinese name + "0700.HK"-style code), US names one
 * ("AAPL Apple"-style symbol+name) — plus a Yahoo news supplement where the
 * endpoint cooperates. Cap 10 headlines (title/source/date), exact-title
 * dedupe. Failure-as-value: news absence degrades a report section, NEVER
 * the run — every failure path returns warnings, nothing throws.
 *
 * RSS is parsed with a minimal regex extractor (no new dependency): Google
 * News RSS items are well-formed <item> blocks with <title>, <source>,
 * <pubDate>. If the XML turns hostile the parser degrades to titles-only
 * rather than failing.
 */
import type { NewsItem } from "@agentic-trading/agents";

export type { NewsItem };

const UA = "Mozilla/5.0";
const NEWS_TIMEOUT_MS = 20_000;
export const NEWS_CAP = 10;

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const jitter = (base: number) => base + Math.random() * base * 0.5;

export interface NewsQuery {
  q: string;
  hl: string;
  gl: string;
  ceid: string;
}

/** Query plans per lane. HK: Chinese name (when known — F10 supplies
 *  SECURITY_NAME_ABBR; else the English name) + the "0700.HK"-style code.
 *  US: "<SYMBOL> <short name>". */
export function googleNewsQueries(input: { symbol: string; name: string; market: string; chineseName?: string }): NewsQuery[] {
  if (input.market === "HK") {
    const code = `${input.symbol.padStart(5, "0")}`; // "0700.HK" already 4-digit + .HK
    const cn = input.chineseName ?? input.name;
    return [
      { q: cn, hl: "zh-CN", gl: "CN", ceid: "CN:zh-Hans" },
      { q: code, hl: "en-HK", gl: "HK", ceid: "HK:en" },
    ];
  }
  const shortName = input.name.split(" ")[0] ?? input.name;
  return [{ q: `${input.symbol} ${shortName}`, hl: "en-US", gl: "US", ceid: "US:en" }];
}

export function googleNewsUrl(query: NewsQuery): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query.q)}&hl=${query.hl}&gl=${query.gl}&ceid=${query.ceid}`;
}

// --- minimal RSS extraction -------------------------------------------------

const decodeEntities = (s: string): string =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const tagText = (block: string, tag: string): string | null => {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
  return m ? decodeEntities(m[1]!.trim()) : null;
};

/** Parse Google News RSS items. Titles arrive as "Headline - Source"; the
 *  <source> tag carries the publisher, so the title suffix is stripped when
 *  it matches. Unparseable items are skipped (degrade, never fail). */
export function parseGoogleNewsRss(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1]!;
    const rawTitle = tagText(block, "title");
    if (!rawTitle) continue;
    const source = tagText(block, "source");
    let title = rawTitle;
    if (source && rawTitle.endsWith(` - ${source}`)) title = rawTitle.slice(0, -(source.length + 3));
    const pub = tagText(block, "pubDate");
    const ts = pub ? Date.parse(pub) : NaN;
    items.push({ title, source: source ?? "", date: Number.isNaN(ts) ? "" : new Date(ts).toISOString().slice(0, 10) });
  }
  return items;
}

/** Exact-title dedupe, first occurrence wins (queries are fetched in order,
 *  so the CN lane wins ties for HK names). */
export function dedupeByTitle(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  return items.filter((n) => (seen.has(n.title) ? false : (seen.add(n.title), true)));
}

// --- fetcher ----------------------------------------------------------------

export interface YahooNewsHit {
  title: string;
  publisher?: string;
  providerPublishTime?: Date | string | number;
}

export interface FetchNewsDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Spacing between RSS requests in ms (default 800; 0 in tests). */
  spacingMs?: number;
  /** Yahoo supplement (default: yahoo-finance2 search); injectable. Set to
   *  null to disable. */
  yahooSearch?: ((symbol: string, opts: { newsCount: number }) => Promise<{ news?: YahooNewsHit[] }>) | null;
}

export interface FetchNewsResult {
  items: NewsItem[];
  warnings: string[];
}

export async function fetchNews(
  input: { symbol: string; name: string; market: string; chineseName?: string },
  deps: FetchNewsDeps = {},
): Promise<FetchNewsResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? realSleep;
  const spacingMs = deps.spacingMs ?? 800;
  const warnings: string[] = [];
  const collected: NewsItem[] = [];

  const queries = googleNewsQueries(input);
  let first = true;
  for (const q of queries) {
    if (!first) await sleep(jitter(spacingMs));
    first = false;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), NEWS_TIMEOUT_MS);
    try {
      const res = await fetchImpl(googleNewsUrl(q), { headers: { "User-Agent": UA }, signal: ac.signal });
      if (res.status !== 200) {
        warnings.push(`${input.symbol}: google-news http-${res.status} for "${q.q}"`);
        continue;
      }
      collected.push(...parseGoogleNewsRss(await res.text()));
    } catch (err: any) {
      warnings.push(`${input.symbol}: google-news ${err?.name === "AbortError" ? "timeout" : "transport"} for "${q.q}"`);
    } finally {
      clearTimeout(timer);
    }
  }

  // Yahoo supplement — endpoint reliability unknown (v4); loud degradation.
  if (deps.yahooSearch !== null) {
    const search =
      deps.yahooSearch ??
      (async (symbol: string, opts: { newsCount: number }) => {
        const { default: YahooFinance } = await import("yahoo-finance2");
        const yf = new YahooFinance({
          fetchOptions: { headers: { "User-Agent": UA } },
          validation: { logErrors: false, logOptionsErrors: false, allowAdditionalProps: true },
        });
        return (await yf.search(symbol, { newsCount: opts.newsCount })) as { news?: YahooNewsHit[] };
      });
    try {
      const res = await search(input.symbol, { newsCount: 8 });
      for (const n of res.news ?? []) {
        if (typeof n.title !== "string" || !n.title) continue;
        const ts = n.providerPublishTime ? new Date(n.providerPublishTime) : null;
        collected.push({
          title: n.title,
          source: typeof n.publisher === "string" ? n.publisher : "Yahoo",
          date: ts && !Number.isNaN(ts.getTime()) ? ts.toISOString().slice(0, 10) : "",
        });
      }
    } catch (err: any) {
      warnings.push(`${input.symbol}: yahoo news supplement failed (${String(err?.message ?? err).slice(0, 80)}) — RSS only`);
    }
  }

  // Newest first (undated last), exact-title dedupe, cap.
  const sorted = [...collected].sort((a, b) => (b.date === a.date ? a.title.localeCompare(b.title) : b.date.localeCompare(a.date)));
  return { items: dedupeByTitle(sorted).slice(0, NEWS_CAP), warnings };
}
