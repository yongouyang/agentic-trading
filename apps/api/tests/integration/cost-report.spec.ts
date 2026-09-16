/**
 * `report:cost` against a seeded throwaway SQLite db (same harness as
 * correlation-report.spec.ts) — the invariants that make the report trustworthy
 * rather than merely plausible:
 *
 *   1. first-use attribution RECONCILES: the per-run rows plus the unattributed
 *      remainder equal the month total, with a cache-replayed run costing $0.
 *   2. an unpriced store prints tokens and no dollar sign anywhere.
 *   3. the artifact and the returned report agree, and the month window is the
 *      HKT calendar month (so a 20:30 HKT chain run is inside it).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { formatCostReport, runCostReport } from "../../src/cli/cost-report.js";
import { PrismaService } from "../../src/prisma.service.js";
import { createTestDatabase, destroyTestDatabase, type TestDatabase } from "../helpers/test-db.js";

let db: TestDatabase;
let prisma: PrismaService;
let reportsDir: string;
const savedUrl = process.env.DATABASE_URL;

/** 2026-09-16 12:30 UTC = 20:30 HKT — the chain slot, off-peak. */
const AT = new Date("2026-09-16T12:30:00Z");
const usage = (o: Record<string, unknown>) => JSON.stringify(o);
const PRICES = {
  LLM_PRICE_INPUT_PER_MTOK: "0.15",
  LLM_PRICE_OUTPUT_PER_MTOK: "0.6",
  LLM_PRICE_CACHE_HIT_PER_MTOK: "0.003",
  LLM_PRICE_PEAK_INPUT_PER_MTOK: "0.3",
  LLM_PRICE_PEAK_OUTPUT_PER_MTOK: "1.2",
  LLM_PRICE_PEAK_CACHE_HIT_PER_MTOK: "0.006",
  LLM_PRICE_BASIS: "test basis",
  LLM_MONTHLY_CAP_USD: "10",
};

beforeAll(async () => {
  db = await createTestDatabase();
  process.env.DATABASE_URL = db.url;
  prisma = new PrismaService();
  await prisma.$connect();
  reportsDir = mkdtempSync(path.join(tmpdir(), "cost-report-"));

  // Run 1 (chain): two names, three billed calls.
  await prisma.deepDiveRun.create({ data: { id: 1, market: "US", screenRunId: 1, topN: 2, llmCalls: 3, cacheHits: 0, failed: 0, warningsJson: "[]", status: "complete", source: "chain", runAt: AT } });
  await prisma.deepDiveReport.create({ data: { runId: 1, symbol: "AAA", status: "ok", decisionHashesJson: JSON.stringify(["h1", "h2"]) } });
  await prisma.deepDiveReport.create({ data: { runId: 1, symbol: "BBB", status: "ok", decisionHashesJson: JSON.stringify(["h3"]) } });
  // Run 2 (ad-hoc): re-scores AAA from the app-level cache — h1/h2 are owned by
  // run 1, so this run must cost $0 and say why.
  await prisma.deepDiveRun.create({ data: { id: 2, market: "US", screenRunId: 1, topN: 1, llmCalls: 0, cacheHits: 2, failed: 0, warningsJson: "[]", status: "complete", source: "adhoc", runAt: new Date(AT.getTime() + 600_000) } });
  await prisma.deepDiveReport.create({ data: { runId: 2, symbol: "AAA", status: "ok", decisionHashesJson: JSON.stringify(["h1", "h2"]) } });
  // One decision no run owns (a pre-W2 killed run, or chat).
  await prisma.agentDecision.create({ data: { hash: "orphan", agent: "chat", model: "deepseek-flash", promptVersion: "v1", systemPrompt: "s", userPrompt: "u", responseText: "r", usageJson: usage({ promptTokens: 1000, completionTokens: 100 }), createdAt: AT } });
  for (const [hash, u] of [
    ["h1", usage({ promptTokens: 1000, completionTokens: 100, promptCacheHitTokens: 800 })],
    ["h2", usage({ promptTokens: 500, completionTokens: 50 })],
    ["h3", usage({ promptTokens: 200, completionTokens: 20 })],
  ] as const) {
    await prisma.agentDecision.create({ data: { hash, agent: "bull", model: "deepseek-flash", promptVersion: "v1", systemPrompt: "s", userPrompt: "u", responseText: "r", usageJson: u, createdAt: AT } });
  }
});

afterAll(async () => {
  await prisma.$disconnect();
  if (savedUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedUrl;
  destroyTestDatabase(db);
  rmSync(reportsDir, { recursive: true, force: true });
});

afterEach(() => vi.unstubAllEnvs());

describe("report:cost", () => {
  it("reconciles: per-run rows + unattributed = month total, and a cached re-run is free", async () => {
    for (const [k, v] of Object.entries(PRICES)) vi.stubEnv(k, v);
    const r = await runCostReport({ prisma, reportsDir, now: AT, log: () => {} });

    expect(r.month).toBe("2026-09");
    expect(r.priced).toBe(true);
    expect(r.capUsd).toBe(10);
    expect(r.overCap).toBe(false);
    expect(r.runs).toHaveLength(2);

    const [run1, run2] = r.runs;
    expect(run1!.usd).toBeCloseTo((800 * 0.003 + 200 * 0.15 + 100 * 0.6) / 1e6 + (500 * 0.15 + 50 * 0.6) / 1e6 + (200 * 0.15 + 20 * 0.6) / 1e6, 12);
    expect(run2!.usd).toBe(0); // replayed from cache: no API call, no row, no cost
    expect(run2!.replayed).toBe(2);
    expect(run2!.calls).toBe(0);

    // The invariant this whole attribution rule exists for.
    const sum = r.runs.reduce((a, x) => a + x.usd, 0) + r.unattributedUsd;
    expect(sum).toBeCloseTo(r.totals.usd, 12);
    expect(r.unattributedUsd).toBeCloseTo((1000 * 0.15 + 100 * 0.6) / 1e6, 12); // the orphan only

    // Per-name figures are chain-only, and the cache split is priced, not assumed.
    expect(r.perName.pooled).toBeCloseTo(run1!.usd / 2, 12);
    // Measured over SPLIT rows only: h1 alone carries the split (800 of 1000).
    expect(r.cacheHitRate).toBeCloseTo(800 / 1000, 6);
    // h2/h3 carry no cache split (the realistic state of any pre-2026-09-16 row),
    // so the reading is labelled an upper bound rather than passed off as measured.
    expect(r.totals.upperBound).toBe(true);
  });

  it("writes the dated artifact, and it matches what was returned", async () => {
    for (const [k, v] of Object.entries(PRICES)) vi.stubEnv(k, v);
    const r = await runCostReport({ prisma, reportsDir, now: AT, log: () => {} });
    const onDisk = JSON.parse(readFileSync(path.join(reportsDir, "cost-2026-09.json"), "utf8"));
    expect(onDisk.month).toBe("2026-09");
    expect(onDisk.runs.map((x: { runId: number }) => x.runId)).toEqual(r.runs.map((x) => x.runId));
    expect(onDisk.totals.usd).toBeCloseTo(r.totals.usd, 12);
  });

  it("prints tokens and no dollar sign at all when no prices are configured", async () => {
    vi.stubEnv("LLM_PRICE_INPUT_PER_MTOK", "");
    vi.stubEnv("LLM_PRICE_OUTPUT_PER_MTOK", "");
    const r = await runCostReport({ prisma, reportsDir, now: AT, log: () => {} });
    expect(r.priced).toBe(false);
    expect(r.capUsd).toBeNull();
    expect(r.totals.promptTokens).toBe(2700);
    const out = formatCostReport(r).join("\n");
    expect(out).toMatch(/UNPRICED/);
    expect(out).toMatch(/no row carries the split|no LLM_PRICE/);
    expect(out).not.toMatch(/\$\d/);
  });

  it("places a 20:30 HKT chain run inside the HKT month, not the UTC one", async () => {
    for (const [k, v] of Object.entries(PRICES)) vi.stubEnv(k, v);
    // 2026-09-30 20:30 HKT = 2026-09-30 12:30 UTC — same month either way. The
    // edge is the 1st: 2026-09-01 00:30 HKT is 2026-08-31 16:30 UTC, and must
    // still land in the September report.
    await prisma.deepDiveRun.create({ data: { id: 3, market: "HK", screenRunId: 2, topN: 1, llmCalls: 0, cacheHits: 0, failed: 0, warningsJson: "[]", status: "complete", source: "chain", runAt: new Date("2026-08-31T16:30:00Z") } });
    const r = await runCostReport({ prisma, reportsDir, now: new Date("2026-09-30T12:30:00Z"), log: () => {} });
    expect(r.runs.map((x) => x.runId)).toContain(3);
  });
});
