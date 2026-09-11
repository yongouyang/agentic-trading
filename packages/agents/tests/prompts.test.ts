/**
 * Determinism goldens for the prompt builders (phase-2-plan: byte-identical
 * prompts for identical contexts — the cache hash depends on it). Also pins
 * the stable-ordering rules: shuffled metrics keys / news order must produce
 * the same bytes.
 */
import { describe, expect, it } from "vitest";
import {
  PROMPT_VERSION,
  buildBearPrompts,
  buildBullPrompts,
  buildFundamentalsAnalystPrompts,
  buildNewsAnalystPrompts,
  buildVerdictPrompts,
  money,
  num,
  pct,
  renderContextBlock,
  type DeepDiveContext,
} from "../src/prompts.js";
import { VERDICT_SCHEMA_HINT } from "../src/verdict.js";

const CTX: DeepDiveContext = {
  symbol: "00700.HK",
  name: "腾讯控股",
  market: "HK",
  asOf: "2026-09-05",
  screenMetrics: { close: 612.5, sma50: 590.125678, mom20: 0.03456, sharpe252: 1.23456 },
  rank: 3,
  score: 0.812345,
  recentBars: { lastClose: 612.5, lastDate: "2026-09-05", change20d: 0.03456, change60d: -0.01234, adv20: 4_560_000_000 },
  fundamentalsSnapshot: "FY2025 (2025-12-31, CNY)\nrevenue: 660000000000 (yoy +8.4%)",
  news: [
    { title: "Tencent beats estimates", source: "Reuters", date: "2026-09-04" },
    { title: "游戏新规落地", source: "财新", date: "2026-09-03" },
  ],
  caDegraded: false,
};

describe("formatting helpers (fixed precision)", () => {
  it("num/pct/money are byte-stable", () => {
    expect(num(0.812345)).toBe("0.8123");
    expect(num(612.5)).toBe("612.5000");
    expect(pct(0.03456)).toBe("3.5%");
    expect(pct(-0.01234)).toBe("-1.2%");
    expect(money(4_560_000_000)).toBe("4560000000.00");
  });
});

describe("renderContextBlock", () => {
  it("is deterministic across calls and input ordering", () => {
    const a = renderContextBlock(CTX);
    const shuffled: DeepDiveContext = {
      ...CTX,
      screenMetrics: { sharpe252: 1.23456, mom20: 0.03456, sma50: 590.125678, close: 612.5 },
      news: [...CTX.news].reverse(),
    };
    expect(renderContextBlock(shuffled)).toBe(a);
    expect(renderContextBlock(CTX)).toBe(a);
  });

  it("pins the golden context block", () => {
    expect(renderContextBlock(CTX)).toMatchInlineSnapshot(`
      "Name: 腾讯控股 (00700.HK) — HK
      As of: 2026-09-05
      Screen: rank 3, score 0.8123
      Screen metrics:
      - close: 612.5000
      - mom20: 0.0346
      - sharpe252: 1.2346
      - sma50: 590.1257
      Recent bars:
      - last close: 612.50 (2026-09-05)
      - 20-session change: 3.5%
      - 60-session change: -1.2%
      - 20-session avg dollar volume: 4560000000.00
      Fundamentals snapshot (eastmoney F10):
      FY2025 (2025-12-31, CNY)
      revenue: 660000000000 (yoy +8.4%)
      News (2 items, sorted by date desc then title):
      1. [2026-09-04] Tencent beats estimates — Reuters
      2. [2026-09-03] 游戏新规落地 — 财新
      Corporate-action data quality: ok"
    `);
  });

  it("renders explicit degraded/absent sections instead of omitting silently", () => {
    const bare = renderContextBlock({ ...CTX, fundamentalsSnapshot: undefined, news: [], caDegraded: true });
    expect(bare).toContain("News: none available (degraded");
    expect(bare).toContain("Corporate-action data quality: DEGRADED");
    expect(bare).not.toContain("Fundamentals snapshot");
  });
});

describe("role builders", () => {
  it("every builder is deterministic for the same context", () => {
    const input = { newsAnalysis: "news text", fundamentalsAnalysis: "fund text", priorRounds: [{ side: "bull" as const, text: "bull r1" }] };
    const builders = [
      () => buildNewsAnalystPrompts(CTX),
      () => buildFundamentalsAnalystPrompts(CTX),
      () => buildBullPrompts(CTX, input),
      () => buildBearPrompts(CTX, input),
      () => buildVerdictPrompts(CTX, input, VERDICT_SCHEMA_HINT),
    ];
    for (const b of builders) expect(b()).toEqual(b());
  });

  it("debate round numbering derives from prior rounds deterministically", () => {
    const input = { newsAnalysis: "n", fundamentalsAnalysis: null, priorRounds: [] as { side: "bull" | "bear"; text: string }[] };
    expect(buildBullPrompts(CTX, input).user).toContain("round 1 of 2");
    input.priorRounds.push({ side: "bull", text: "b1" }, { side: "bear", text: "r1" });
    expect(buildBullPrompts(CTX, input).user).toContain("round 2 of 2");
    expect(buildBearPrompts(CTX, input).user).toContain("round 2 of 2");
    expect(buildBullPrompts(CTX, input).user).toContain("[bear] r1");
  });

  it("PROMPT_VERSION is a pinned constant", () => {
    // Pinned for a reason beyond prompt hygiene: apps/api's verdict:validate
    // samples exactly this version (SAMPLE_PROMPT_VERSION, a local constant
    // because a cross-package value import resolves to undefined under that
    // package's vitest). The Phase 5 sample is accrued against ONE treatment, so
    // bumping this resets a ~7.5-month clock and discards the verdicts accrued
    // under v1. If this assertion fails, that is a real decision — update
    // SAMPLE_PROMPT_VERSION deliberately rather than reflexively.
    expect(PROMPT_VERSION).toBe("v1");
  });
});
