/**
 * News assembler (src/agents/news.ts) — RSS parsing from a fixture string,
 * both lanes' query construction, dedupe/cap, failure-as-value (RSS http
 * error, transport, Yahoo supplement failure). No network.
 */
import { describe, expect, it } from "vitest";
import { dedupeByTitle, fetchNews, googleNewsQueries, googleNewsUrl, parseGoogleNewsRss, NEWS_CAP } from "../../src/agents/news.js";

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>腾讯控股 - Google 新闻</title>
<item>
<title><![CDATA[腾讯控股公布中期业绩 收入超预期 - 财新网]]></title>
<link>https://news.google.com/read/abc</link>
<pubDate>Fri, 04 Sep 2026 08:00:00 GMT</pubDate>
<source url="https://caixin.com">财新网</source>
</item>
<item>
<title>Tencent rallies on AI push - Reuters</title>
<pubDate>Thu, 03 Sep 2026 12:30:00 GMT</pubDate>
<source url="https://reuters.com">Reuters</source>
</item>
<item>
<title>Broken item without source</title>
<pubDate>not-a-date</pubDate>
</item>
<item><link>no title at all</link></item>
</channel></rss>`;

describe("parseGoogleNewsRss", () => {
  it("extracts title/source/date, strips the '- Source' title suffix", () => {
    const items = parseGoogleNewsRss(RSS);
    expect(items).toHaveLength(3); // title-less item skipped (degrade, not fail)
    expect(items[0]).toEqual({ title: "腾讯控股公布中期业绩 收入超预期", source: "财新网", date: "2026-09-04" });
    expect(items[1]).toEqual({ title: "Tencent rallies on AI push", source: "Reuters", date: "2026-09-03" });
    expect(items[2]).toEqual({ title: "Broken item without source", source: "", date: "" });
  });

  it("hostile XML degrades to empty, never throws", () => {
    expect(parseGoogleNewsRss("not xml at all")).toEqual([]);
    expect(parseGoogleNewsRss("<rss><channel><item>broken")).toEqual([]);
  });
});

describe("googleNewsQueries", () => {
  it("HK: Chinese-name CN lane + code EN-HK lane", () => {
    const qs = googleNewsQueries({ symbol: "0700.HK", name: "Tencent Holdings Ltd.", market: "HK", chineseName: "腾讯控股" });
    expect(qs).toEqual([
      { q: "腾讯控股", hl: "zh-CN", gl: "CN", ceid: "CN:zh-Hans" },
      { q: "0700.HK", hl: "en-HK", gl: "HK", ceid: "HK:en" },
    ]);
    expect(googleNewsUrl(qs[0]!)).toBe(`https://news.google.com/rss/search?q=${encodeURIComponent("腾讯控股")}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`);
  });

  it("HK without a Chinese name falls back to the English name", () => {
    const qs = googleNewsQueries({ symbol: "0005.HK", name: "HSBC Holdings plc", market: "HK" });
    expect(qs[0]!.q).toBe("HSBC Holdings plc");
  });

  it("US: symbol + short name, single en-US lane", () => {
    const qs = googleNewsQueries({ symbol: "AAPL", name: "Apple Inc.", market: "US" });
    expect(qs).toEqual([{ q: "AAPL Apple", hl: "en-US", gl: "US", ceid: "US:en" }]);
  });
});

describe("dedupeByTitle", () => {
  it("exact-title dedupe keeps first occurrence", () => {
    const items = dedupeByTitle([
      { title: "A", source: "s1", date: "2026-09-04" },
      { title: "A", source: "s2", date: "2026-09-03" },
      { title: "B", source: "s1", date: "2026-09-01" },
    ]);
    expect(items.map((i) => i.source)).toEqual(["s1", "s1"]);
  });
});

const rssResponse = (xml: string) => ({ status: 200, text: async () => xml }) as Response;

describe("fetchNews", () => {
  const noSleep = async () => {};

  it("HK fetches both lanes, merges, sorts newest first, caps at NEWS_CAP", async () => {
    const urls: string[] = [];
    const many = Array.from({ length: 8 }, (_, i) => `<item><title>CN story ${i}</title><pubDate>Thu, 03 Sep 2026 0${i}:00:00 GMT</pubDate><source>财新</source></item>`).join("");
    const fetchImpl = (async (url: any) => {
      urls.push(String(url));
      return String(url).includes("zh-CN") ? rssResponse(`<rss><channel>${many}</channel></rss>`) : rssResponse(RSS);
    }) as unknown as typeof fetch;
    const r = await fetchNews(
      { symbol: "0700.HK", name: "Tencent", market: "HK", chineseName: "腾讯控股" },
      { fetchImpl, sleep: noSleep, spacingMs: 0, yahooSearch: null },
    );
    expect(r.warnings).toEqual([]);
    expect(urls).toHaveLength(2);
    expect(r.items.length).toBeLessThanOrEqual(NEWS_CAP);
    // Newest first: the RSS fixture's 2026-09-04 item leads the dated ones.
    expect(r.items[0]!.date).toBe("2026-09-04");
  });

  it("RSS http failure degrades to a warning, Yahoo supplement still merges", async () => {
    const fetchImpl = (async () => ({ status: 429, text: async () => "" }) as Response) as unknown as typeof fetch;
    const yahooSearch = async () => ({ news: [{ title: "Yahoo only story", publisher: "Yahoo Finance", providerPublishTime: new Date("2026-09-05T00:00:00Z") }] });
    const r = await fetchNews({ symbol: "AAPL", name: "Apple Inc.", market: "US" }, { fetchImpl, sleep: noSleep, spacingMs: 0, yahooSearch });
    expect(r.warnings.some((w) => w.includes("http-429"))).toBe(true);
    expect(r.items).toEqual([{ title: "Yahoo only story", source: "Yahoo Finance", date: "2026-09-05" }]);
  });

  it("Yahoo supplement failure is a loud warning, RSS still returns", async () => {
    const fetchImpl = (async () => rssResponse(RSS)) as unknown as typeof fetch;
    const yahooSearch = async () => {
      throw new Error("Invalid Schema");
    };
    const r = await fetchNews({ symbol: "AAPL", name: "Apple Inc.", market: "US" }, { fetchImpl, sleep: noSleep, spacingMs: 0, yahooSearch });
    expect(r.warnings.some((w) => w.includes("yahoo news supplement failed"))).toBe(true);
    expect(r.items.length).toBeGreaterThan(0);
  });

  it("transport failure on every lane yields empty items + warnings, never throws", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await fetchNews({ symbol: "0700.HK", name: "Tencent", market: "HK" }, { fetchImpl, sleep: noSleep, spacingMs: 0, yahooSearch: null });
    expect(r.items).toEqual([]);
    expect(r.warnings).toHaveLength(2);
  });
});
