/**
 * Cost accounting (charter K3, 2026-09-16) — known-answer tests over the pure
 * math plus the two store loaders. No network, no real prices: the point of the
 * module is that a dollar figure is only ever produced from configured prices.
 */
import { describe, expect, it } from "vitest";
import { costOf, loadCostRows, loadRunCosts, parseCapUsd, parsePricing, parseUsageJson, summarize } from "../../src/ops/cost.js";

const PRICING = { inputPerMTok: 0.15, outputPerMTok: 0.6, cacheHitPerMTok: 0.003, basis: "test basis 2026-09-16" };
const usage = (o: Record<string, unknown>) => JSON.stringify(o);

describe("parsePricing — prices are config, never a default", () => {
  it("returns null when either required price is missing or malformed", () => {
    expect(parsePricing({})).toBeNull();
    expect(parsePricing({ LLM_PRICE_INPUT_PER_MTOK: "0.15" })).toBeNull();
    expect(parsePricing({ LLM_PRICE_INPUT_PER_MTOK: "0.15", LLM_PRICE_OUTPUT_PER_MTOK: "abc" })).toBeNull();
    expect(parsePricing({ LLM_PRICE_INPUT_PER_MTOK: "-1", LLM_PRICE_OUTPUT_PER_MTOK: "0.6" })).toBeNull();
  });

  it("treats a missing cache-hit price as optional (hits are then billed at the miss rate)", () => {
    const p = parsePricing({ LLM_PRICE_INPUT_PER_MTOK: "0.15", LLM_PRICE_OUTPUT_PER_MTOK: "0.6" })!;
    expect(p.cacheHitPerMTok).toBeNull();
    expect(p.basis).toBe("basis unspecified");
  });

  it("carries the dated basis through, because a reading without it is not reproducible", () => {
    const p = parsePricing({ LLM_PRICE_INPUT_PER_MTOK: "0.15", LLM_PRICE_OUTPUT_PER_MTOK: "0.6", LLM_PRICE_BASIS: "deepseek-flash peak, 2026-09-16" })!;
    expect(p.basis).toBe("deepseek-flash peak, 2026-09-16");
  });

  it("parses the K3 cap, and reports no cap rather than a zero cap", () => {
    expect(parseCapUsd({ LLM_MONTHLY_CAP_USD: "10" })).toBe(10);
    expect(parseCapUsd({})).toBeNull();
    expect(parseCapUsd({ LLM_MONTHLY_CAP_USD: "free" })).toBeNull();
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

describe("costOf — known answer, cache split and upper bound", () => {
  it("prices hit / miss / output in three buckets", () => {
    const c = costOf({ promptTokens: 1520, completionTokens: 32, cacheHitTokens: 1280, cacheMissTokens: 240 }, PRICING);
    // (1280×0.003 + 240×0.15 + 32×0.6) / 1e6
    expect(c.usd).toBeCloseTo(59.04e-6, 12);
    expect(c.upperBound).toBe(false);
  });

  it("bills every input token at the miss rate when the split is absent, and says so", () => {
    const c = costOf({ promptTokens: 1520, completionTokens: 32, cacheHitTokens: null, cacheMissTokens: null }, PRICING);
    expect(c.usd).toBeCloseTo((1520 * 0.15 + 32 * 0.6) / 1e6, 12);
    expect(c.upperBound).toBe(true);
  });

  it("flags an upper bound when hits are known but no cache-hit price is configured", () => {
    const c = costOf({ promptTokens: 1520, completionTokens: 32, cacheHitTokens: 1280, cacheMissTokens: 240 }, { ...PRICING, cacheHitPerMTok: null });
    expect(c.usd).toBeCloseTo((1520 * 0.15 + 32 * 0.6) / 1e6, 12);
    expect(c.upperBound).toBe(true);
  });
});

describe("summarize", () => {
  const rows = [
    { model: "deepseek-flash", agent: "bull", usageJson: usage({ promptTokens: 1520, completionTokens: 32, promptCacheHitTokens: 1280 }) },
    { model: "deepseek-flash", agent: "chat", usageJson: usage({ promptTokens: 800, completionTokens: 100 }) },
    { model: "k3-256k", agent: "bull", usageJson: null },
  ];

  it("totals, breaks down by model and agent, and counts unreadable rows as unpriced", () => {
    const s = summarize(rows, PRICING, 10);
    expect(s.priced).toBe(true);
    expect(s.totals.calls).toBe(2);
    expect(s.totals.unpricedCalls).toBe(1);
    expect(s.totals.promptTokens).toBe(2320);
    expect(s.byAgent.chat!.calls).toBe(1);
    expect(s.byModel["k3-256k"]!.unpricedCalls).toBe(1);
    expect(s.overCap).toBe(false);
  });

  it("reports the cache-hit rate as measured, over split rows only — never inferred", () => {
    // Only the first row carries a split, so the rate is 1280/1520 — dividing by
    // the total prompt tokens (2320) would silently blend split and pre-split
    // rows into a number that measures nothing.
    expect(summarize(rows, PRICING).cacheHitRate).toBeCloseTo(1280 / 1520, 6);
    expect(summarize([{ model: "m", agent: "a", usageJson: usage({ promptTokens: 10, completionTokens: 1 }) }], PRICING).cacheHitRate).toBeNull();
  });

  it("refuses to produce dollars without prices, and cannot be 'over cap' either", () => {
    const s = summarize(rows, null, 0.000001);
    expect(s.priced).toBe(false);
    expect(s.totals.usd).toBe(0);
    expect(s.overCap).toBe(false);
    expect(s.basis).toBeNull();
  });

  it("flags the summary as an upper bound when any row predates the cache split", () => {
    const s = summarize([{ model: "m", agent: "a", usageJson: usage({ promptTokens: 10, completionTokens: 1 }) }], PRICING);
    expect(s.totals.upperBound).toBe(true);
  });
});

describe("store loaders", () => {
  it("loadCostRows passes the window through and returns the selected columns", async () => {
    let seen: any = null;
    const prisma = {
      agentDecision: {
        findMany: async (args: any) => {
          seen = args;
          return [{ model: "m", agent: "a", usageJson: null }];
        },
      },
    } as any;
    const since = new Date("2026-09-01T00:00:00Z");
    const until = new Date("2026-10-01T00:00:00Z");
    expect(await loadCostRows(prisma, since, until)).toEqual([{ model: "m", agent: "a", usageJson: null }]);
    expect(seen.where.createdAt).toEqual({ gte: since, lt: until });
  });

  it("attributes per-name cost through decisionHashesJson, and keeps FAILED names (they were billed)", async () => {
    const prisma = {
      deepDiveReport: {
        findMany: async () => [
          { symbol: "AAA", status: "ok", decisionHashesJson: JSON.stringify(["h1", "h2"]) },
          { symbol: "BBB", status: "failed:llm-http-403", decisionHashesJson: JSON.stringify(["h3"]) },
          { symbol: "CCC", status: "ok", decisionHashesJson: null },
        ],
      },
      agentDecision: {
        findMany: async () => [
          { hash: "h1", usageJson: usage({ promptTokens: 1000, completionTokens: 100, promptCacheHitTokens: 800 }) },
          { hash: "h2", usageJson: usage({ promptTokens: 500, completionTokens: 50 }) },
          { hash: "h3", usageJson: usage({ promptTokens: 200, completionTokens: 20 }) },
        ],
      },
    } as any;
    const out = await loadRunCosts(prisma, 15, PRICING);
    const byName = Object.fromEntries(out.map((n) => [n.symbol, n]));
    expect(byName.AAA!.calls).toBe(2);
    expect(byName.AAA!.promptTokens).toBe(1500);
    expect(byName.BBB!.decided).toBe(false);
    expect(byName.BBB!.calls).toBe(1); // a failed name is not a free name
    expect(byName.CCC!.calls).toBe(0);
    expect(byName.AAA!.usd).toBeCloseTo((800 * 0.003 + 200 * 0.15 + 100 * 0.6) / 1e6 + (500 * 0.15 + 50 * 0.6) / 1e6, 12);
  });

  it("does not query the decision log at all when no name carries a hash", async () => {
    let called = false;
    const prisma = {
      deepDiveReport: { findMany: async () => [{ symbol: "AAA", status: "ok", decisionHashesJson: "not json" }] },
      agentDecision: {
        findMany: async () => {
          called = true;
          return [];
        },
      },
    } as any;
    expect(await loadRunCosts(prisma, 1, null)).toEqual([{ symbol: "AAA", calls: 0, promptTokens: 0, completionTokens: 0, usd: 0, decided: true }]);
    expect(called).toBe(false);
  });
});
