/**
 * Cost accounting (charter K3, 2026-09-16) — known-answer tests over the pure
 * math, the tier classification, first-use attribution, and the store loaders.
 * No network: the point of the module is that a dollar figure is only ever
 * produced from configured prices, on a basis that is recorded.
 */
import { describe, expect, it } from "vitest";
import {
  attributeFirstUse,
  costOf,
  loadCostRows,
  loadRunCosts,
  loadRunRefs,
  parseCapUsd,
  parsePricing,
  parseUsageJson,
  summarize,
  tierOf,
  type CostRow,
  type LlmPricing,
  type RunRef,
} from "../../src/ops/cost.js";
import { monthWindow } from "../../src/cli/cost-report.js";

const OFF = 0.15;
const PEAK_INPUT = 0.3;
const PRICING: LlmPricing = {
  offPeak: { inputPerMTok: OFF, outputPerMTok: 0.6, cacheHitPerMTok: 0.003 },
  peak: { inputPerMTok: PEAK_INPUT, outputPerMTok: 1.2, cacheHitPerMTok: 0.006 },
  basis: "test basis 2026-09-16",
};
const usage = (o: Record<string, unknown>) => JSON.stringify(o);
/** 2026-09-16 12:30 UTC = 20:30 HKT → off-peak (the chain slot). */
const OFF_PEAK_AT = new Date("2026-09-16T12:30:00Z");
/** 2026-09-16 08:00 UTC = 16:00 HKT, a Wednesday → peak. */
const PEAK_AT = new Date("2026-09-16T08:00:00Z");
const row = (usageJson: string | null, at: Date = OFF_PEAK_AT, model = "deepseek-flash", agent = "bull"): CostRow => ({ model, agent, createdAt: at, usageJson });

describe("parsePricing — prices are config, never a default", () => {
  it("returns null when either required off-peak price is missing or malformed", () => {
    expect(parsePricing({})).toBeNull();
    expect(parsePricing({ LLM_PRICE_INPUT_PER_MTOK: "0.15" })).toBeNull();
    expect(parsePricing({ LLM_PRICE_INPUT_PER_MTOK: "0.15", LLM_PRICE_OUTPUT_PER_MTOK: "abc" })).toBeNull();
    expect(parsePricing({ LLM_PRICE_INPUT_PER_MTOK: "-1", LLM_PRICE_OUTPUT_PER_MTOK: "0.6" })).toBeNull();
  });

  it("treats the peak tier and the cache-hit price as optional, and says so by leaving them null", () => {
    const p = parsePricing({ LLM_PRICE_INPUT_PER_MTOK: "0.15", LLM_PRICE_OUTPUT_PER_MTOK: "0.6" })!;
    expect(p.peak).toBeNull();
    expect(p.offPeak.cacheHitPerMTok).toBeNull();
    expect(p.basis).toBe("basis unspecified");
  });

  it("reads both tiers, with the peak cache-hit price", () => {
    const p = parsePricing({
      LLM_PRICE_INPUT_PER_MTOK: "0.15",
      LLM_PRICE_OUTPUT_PER_MTOK: "0.6",
      LLM_PRICE_CACHE_HIT_PER_MTOK: "0.003",
      LLM_PRICE_PEAK_INPUT_PER_MTOK: "0.3",
      LLM_PRICE_PEAK_OUTPUT_PER_MTOK: "1.2",
      LLM_PRICE_PEAK_CACHE_HIT_PER_MTOK: "0.006",
      LLM_PRICE_BASIS: "deepseek-flash off-peak+peak, 2026-09-16",
    })!;
    expect(p.peak).toEqual({ inputPerMTok: 0.3, outputPerMTok: 1.2, cacheHitPerMTok: 0.006 });
    expect(p.basis).toBe("deepseek-flash off-peak+peak, 2026-09-16");
  });

  it("ignores a half-configured peak tier rather than mixing tiers", () => {
    const p = parsePricing({ LLM_PRICE_INPUT_PER_MTOK: "0.15", LLM_PRICE_OUTPUT_PER_MTOK: "0.6", LLM_PRICE_PEAK_INPUT_PER_MTOK: "0.3" })!;
    expect(p.peak).toBeNull();
  });

  it("parses the K3 cap, and reports no cap rather than a zero cap", () => {
    expect(parseCapUsd({ LLM_MONTHLY_CAP_USD: "10" })).toBe(10);
    expect(parseCapUsd({})).toBeNull();
    expect(parseCapUsd({ LLM_MONTHLY_CAP_USD: "free" })).toBeNull();
  });
});

describe("tierOf — DeepSeek's windows, in UTC", () => {
  it("classifies the two chain slots as off-peak", () => {
    expect(tierOf(new Date("2026-09-16T12:30:00Z"))).toBe("off-peak"); // 20:30 HKT
    expect(tierOf(new Date("2026-09-16T15:03:00Z"))).toBe("off-peak"); // 23:03 HKT
  });

  it("classifies 01:00-04:00 and 06:00-10:00 UTC on weekdays as peak", () => {
    expect(tierOf(new Date("2026-09-16T01:00:00Z"))).toBe("peak"); // Wednesday, window opens
    expect(tierOf(new Date("2026-09-16T03:59:00Z"))).toBe("peak");
    expect(tierOf(new Date("2026-09-16T04:00:00Z"))).toBe("off-peak"); // exclusive end
    expect(tierOf(new Date("2026-09-16T09:59:00Z"))).toBe("peak"); // 17:59 HKT
    expect(tierOf(new Date("2026-09-16T10:00:00Z"))).toBe("off-peak"); // 18:00 HKT
  });

  it("is off-peak all weekend, even inside the hour windows", () => {
    expect(tierOf(new Date("2026-09-19T02:00:00Z"))).toBe("off-peak"); // Saturday
    expect(tierOf(new Date("2026-09-20T07:00:00Z"))).toBe("off-peak"); // Sunday
  });

  it("uses the UTC weekday, not the HKT one — the edge that would mis-file every HKT morning", () => {
    // Monday 07:00 HKT == Sunday 23:00 UTC: off-peak, and not because of the hour.
    expect(tierOf(new Date("2026-09-20T23:00:00Z"))).toBe("off-peak");
    // Monday 09:00 HKT == Monday 01:00 UTC: peak, same weekday in both zones.
    expect(tierOf(new Date("2026-09-21T01:00:00Z"))).toBe("peak");
    // Friday 09:00 HKT == Friday 01:00 UTC: peak. Saturday 09:00 HKT == Saturday 01:00 UTC: not.
    expect(tierOf(new Date("2026-09-18T01:00:00Z"))).toBe("peak");
    expect(tierOf(new Date("2026-09-19T01:00:00Z"))).toBe("off-peak");
  });
});

describe("parseUsageJson — tolerant of historical and malformed blobs", () => {
  it("reads the cache split when present and derives the miss remainder when absent", () => {
    expect(parseUsageJson(usage({ promptTokens: 1520, completionTokens: 32, promptCacheHitTokens: 1280 }))).toEqual({
      promptTokens: 1520,
      completionTokens: 32,
      cacheHitTokens: 1280,
      cacheMissTokens: 240,
    });
  });

  it("reports a null split rather than guessing one for pre-2026-09-16 rows", () => {
    expect(parseUsageJson(usage({ promptTokens: 12, completionTokens: 3, totalTokens: 15 }))).toEqual({
      promptTokens: 12,
      completionTokens: 3,
      cacheHitTokens: null,
      cacheMissTokens: null,
    });
  });

  it("degrades to null instead of throwing on absent/malformed/foreign blobs", () => {
    expect(parseUsageJson(null)).toBeNull();
    expect(parseUsageJson("not json")).toBeNull();
    expect(parseUsageJson("[]")).toBeNull();
    expect(parseUsageJson(JSON.stringify({ totalTokens: 15 }))).toBeNull(); // no prompt count ⇒ unusable
  });

  it("defaults completion tokens to 0 when the provider omitted them, keeping the input side", () => {
    expect(parseUsageJson(usage({ promptTokens: 100 }))?.completionTokens).toBe(0);
  });
});

describe("costOf — known answer, cache split, tier, upper bound", () => {
  it("prices hit / miss / output in three buckets at the off-peak tier", () => {
    const c = costOf({ promptTokens: 1520, completionTokens: 32, cacheHitTokens: 1280, cacheMissTokens: 240 }, PRICING, OFF_PEAK_AT);
    // (1280×0.003 + 240×0.15 + 32×0.6) / 1e6
    expect(c.usd).toBeCloseTo(59.04e-6, 12);
    expect(c.tier).toBe("off-peak");
    expect(c.upperBound).toBe(false);
    expect(c.tierUnpriced).toBe(false);
  });

  it("bills the peak tier at peak rates when the row sits in a peak window", () => {
    const c = costOf({ promptTokens: 1520, completionTokens: 32, cacheHitTokens: 1280, cacheMissTokens: 240 }, PRICING, PEAK_AT);
    // (1280×0.006 + 240×0.30 + 32×1.2) / 1e6 — exactly double the off-peak row.
    expect(c.usd).toBeCloseTo(118.08e-6, 12);
    expect(c.tier).toBe("peak");
  });

  it("reports the no-cache counterfactual, so the discount earned is visible", () => {
    const c = costOf({ promptTokens: 1520, completionTokens: 32, cacheHitTokens: 1280, cacheMissTokens: 240 }, PRICING, OFF_PEAK_AT);
    expect(c.naiveUsd).toBeCloseTo((1520 * OFF + 32 * 0.6) / 1e6, 12);
    expect(c.naiveUsd).toBeGreaterThan(c.usd);
  });

  it("bills every input token at the miss rate when the split is absent, and says so", () => {
    const c = costOf({ promptTokens: 1520, completionTokens: 32, cacheHitTokens: null, cacheMissTokens: null }, PRICING, OFF_PEAK_AT);
    expect(c.usd).toBeCloseTo(c.naiveUsd, 12);
    expect(c.upperBound).toBe(true);
  });

  it("flags an upper bound when hits are known but no cache-hit price is configured", () => {
    const p = { ...PRICING, offPeak: { ...PRICING.offPeak, cacheHitPerMTok: null } };
    const c = costOf({ promptTokens: 1520, completionTokens: 32, cacheHitTokens: 1280, cacheMissTokens: 240 }, p, OFF_PEAK_AT);
    expect(c.usd).toBeCloseTo((1520 * OFF + 32 * 0.6) / 1e6, 12);
    expect(c.upperBound).toBe(true);
  });

  it("prices a peak row off-peak but FLAGS it when no peak prices are configured", () => {
    const p = { ...PRICING, peak: null };
    const c = costOf({ promptTokens: 100, completionTokens: 10, cacheHitTokens: null, cacheMissTokens: null }, p, PEAK_AT);
    expect(c.usd).toBeCloseTo((100 * OFF + 10 * 0.6) / 1e6, 12);
    expect(c.tierUnpriced).toBe(true);
  });
});

describe("summarize", () => {
  const rows = [
    row(usage({ promptTokens: 1520, completionTokens: 32, promptCacheHitTokens: 1280 })),
    row(usage({ promptTokens: 800, completionTokens: 100 }), OFF_PEAK_AT, "deepseek-flash", "chat"),
    row(usage({ promptTokens: 100, completionTokens: 10 }), PEAK_AT),
    row(null),
  ];

  it("totals, breaks down by model and agent, and counts unreadable rows as unpriced", () => {
    const s = summarize(rows, PRICING, 10);
    expect(s.priced).toBe(true);
    expect(s.totals.calls).toBe(3);
    expect(s.totals.unpricedCalls).toBe(1);
    expect(s.totals.promptTokens).toBe(2420);
    expect(s.byAgent.chat!.calls).toBe(1);
    expect(s.overCap).toBe(false);
  });

  it("counts peak and off-peak calls separately, and surfaces unpriced peak rows", () => {
    expect(summarize(rows, PRICING).totals.peakCalls).toBe(1);
    expect(summarize(rows, PRICING).totals.offPeakCalls).toBe(2);
    expect(summarize(rows, { ...PRICING, peak: null }).totals.tierUnpriced).toBe(1);
  });

  it("reports the cache-hit rate as measured, over split rows only — never inferred", () => {
    // Only the first row carries a split, so the rate is 1280/1520 — dividing by
    // the total prompt tokens would silently blend split and pre-split rows.
    expect(summarize(rows, PRICING).cacheHitRate).toBeCloseTo(1280 / 1520, 6);
    expect(summarize([row(usage({ promptTokens: 10, completionTokens: 1 }))], PRICING).cacheHitRate).toBeNull();
  });

  it("refuses to produce dollars without prices, and cannot be 'over cap' either", () => {
    const s = summarize(rows, null, 0.000001);
    expect(s.priced).toBe(false);
    expect(s.totals.usd).toBe(0);
    expect(s.overCap).toBe(false);
    expect(s.basis).toBeNull();
  });

  it("flags the summary as an upper bound when any row predates the cache split", () => {
    expect(summarize([row(usage({ promptTokens: 10, completionTokens: 1 }))], PRICING).totals.upperBound).toBe(true);
  });
});

describe("first-use attribution", () => {
  const ref = (runId: number, at: string, names: { symbol: string; hashes: string[] }[]): RunRef => ({
    runId,
    market: "US",
    runAt: new Date(at),
    source: "chain",
    topN: names.length,
    names: names.map((n) => ({ ...n, status: "ok" })),
  });

  it("gives a shared hash to the earliest run, so per-run rows reconcile", () => {
    const refs = [
      ref(1, "2026-09-10T12:00:00Z", [{ symbol: "AAA", hashes: ["h1", "h2"] }, { symbol: "BBB", hashes: ["h3"] }]),
      ref(2, "2026-09-11T12:00:00Z", [{ symbol: "AAA", hashes: ["h1", "h4"] }]),
    ];
    const a = attributeFirstUse(refs);
    expect([...a.get(1)!.owned].sort()).toEqual(["h1", "h2", "h3"]);
    expect([...a.get(2)!.owned]).toEqual(["h4"]);
    expect(a.get(2)!.replayed).toBe(1); // h1 was billed by run 1 — a $0 cache replay
  });

  it("ignores a hash-list ordering hazard by owning each hash exactly once", () => {
    const refs = [ref(1, "2026-09-10T12:00:00Z", [{ symbol: "AAA", hashes: ["h1"] }]), ref(2, "2026-09-11T12:00:00Z", [{ symbol: "AAA", hashes: ["h1"] }])];
    const owned = [...attributeFirstUse(refs).values()].reduce((a, v) => a + v.owned.size, 0);
    expect(owned).toBe(1);
  });
});

describe("store loaders", () => {
  it("loadCostRows passes the window through and returns the timestamped columns", async () => {
    let seen: any = null;
    const prisma = {
      agentDecision: {
        findMany: async (args: any) => {
          seen = args;
          return [{ model: "m", agent: "a", createdAt: OFF_PEAK_AT, usageJson: null }];
        },
      },
    } as any;
    const since = new Date("2026-09-01T00:00:00Z");
    const until = new Date("2026-10-01T00:00:00Z");
    expect((await loadCostRows(prisma, since, until))[0]!.createdAt).toEqual(OFF_PEAK_AT);
    expect(seen.where.createdAt).toEqual({ gte: since, lt: until });
  });

  it("loadRunRefs loads ALL history up to `until`, so ownership is never reassigned by a window", async () => {
    let runQuery: any = null;
    const prisma = {
      deepDiveRun: {
        findMany: async (args: any) => {
          runQuery = args;
          return [{ id: 1, market: "US", runAt: OFF_PEAK_AT, source: "chain", topN: 2 }];
        },
      },
      deepDiveReport: {
        findMany: async () => [
          { runId: 1, symbol: "AAA", status: "ok", decisionHashesJson: JSON.stringify(["h1", null, "h2"]) },
          { runId: 1, symbol: "BBB", status: "failed:llm-http-403", decisionHashesJson: "not json" },
        ],
      },
    } as any;
    const until = new Date("2026-10-01T00:00:00Z");
    const refs = await loadRunRefs(prisma, until);
    expect(runQuery.where.runAt).toEqual({ lt: until });
    expect(runQuery.where.since).toBeUndefined();
    expect(refs[0]!.names[0]!.hashes).toEqual(["h1", "h2"]); // non-string entries dropped
    expect(refs[0]!.names[1]!.hashes).toEqual([]); // malformed list loses attribution, not the run
  });

  it("costs each run from its owned hashes and keeps FAILED names (they were billed)", async () => {
    const refs: RunRef[] = [
      {
        runId: 15,
        market: "US",
        runAt: OFF_PEAK_AT,
        source: "chain",
        topN: 2,
        names: [
          { symbol: "AAA", status: "ok", hashes: ["h1", "h2"] },
          { symbol: "BBB", status: "failed:llm-http-403", hashes: ["h3"] },
        ],
      },
    ];
    const prisma = {
      agentDecision: {
        findMany: async () => [
          { hash: "h1", createdAt: OFF_PEAK_AT, usageJson: usage({ promptTokens: 1000, completionTokens: 100, promptCacheHitTokens: 800 }) },
          { hash: "h2", createdAt: OFF_PEAK_AT, usageJson: usage({ promptTokens: 500, completionTokens: 50 }) },
          { hash: "h3", createdAt: OFF_PEAK_AT, usageJson: usage({ promptTokens: 200, completionTokens: 20 }) },
        ],
      },
    } as any;
    const [run] = await loadRunCosts(prisma, refs, PRICING);
    expect(run!.calls).toBe(3);
    expect(run!.names).toBe(2);
    expect(run!.decidedNames).toBe(1);
    expect(run!.promptTokens).toBe(1700);
    expect(run!.usd).toBeCloseTo((800 * 0.003 + 200 * OFF + 100 * 0.6) / 1e6 + (500 * OFF + 50 * 0.6) / 1e6 + (200 * OFF + 20 * 0.6) / 1e6, 12);
  });

  it("still reports tokens (usd 0) with no prices configured", async () => {
    const refs: RunRef[] = [{ runId: 1, market: "HK", runAt: OFF_PEAK_AT, source: "chain", topN: 1, names: [{ symbol: "AAA", status: "ok", hashes: ["h1"] }] }];
    const prisma = { agentDecision: { findMany: async () => [{ hash: "h1", createdAt: OFF_PEAK_AT, usageJson: usage({ promptTokens: 100, completionTokens: 10 }) }] } } as any;
    const [run] = await loadRunCosts(prisma, refs, null);
    expect(run!.promptTokens).toBe(100);
    expect(run!.usd).toBe(0);
  });

  it("does not query the decision log at all when nothing is owned", async () => {
    let called = false;
    const prisma = {
      agentDecision: {
        findMany: async () => {
          called = true;
          return [];
        },
      },
    } as any;
    expect(await loadRunCosts(prisma, [], PRICING)).toEqual([]);
    expect(called).toBe(false);
  });
});

describe("monthWindow — HKT calendar month", () => {
  it("spans HKT midnight to HKT midnight, expressed in UTC", () => {
    const { since, until } = monthWindow("2026-09");
    expect(since.toISOString()).toBe("2026-08-31T16:00:00.000Z"); // 2026-09-01 00:00 HKT
    expect(until.toISOString()).toBe("2026-09-30T16:00:00.000Z"); // 2026-10-01 00:00 HKT
  });

  it("rolls the year over at December", () => {
    const { since, until } = monthWindow("2026-12");
    expect(since.toISOString()).toBe("2026-11-30T16:00:00.000Z");
    expect(until.toISOString()).toBe("2026-12-31T16:00:00.000Z");
  });
});
