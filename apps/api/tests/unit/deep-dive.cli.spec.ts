/**
 * Deep-dive CLI logic (src/cli/deep-dive.ts): arg parsing, env-var contract,
 * target selection (shortlist top-N + ad-hoc --symbol), budget guard (aborts
 * BEFORE overspend, loud), per-name failure isolation, persistence shape —
 * against a throwaway SQLite db with a scripted pipeline runner. No network,
 * no live LLM.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DeepDiveOutcome } from "@agentic-trading/agents";
import { PrismaService } from "../../src/prisma.service.js";
import {
  MAX_CALLS_PER_NAME,
  missingLlmEnv,
  parseDeepDiveArgs,
  resolveLlmApiKey,
  runDeepDiveBatch,
  selectTargets,
  type DeepDiveBatchDeps,
  type PipelineRunner,
} from "../../src/cli/deep-dive.js";
import { createTestDatabase, destroyTestDatabase, type TestDatabase } from "../helpers/test-db.js";

describe("parseDeepDiveArgs", () => {
  it("defaults: market all, top 10, max-calls 200", () => {
    expect(parseDeepDiveArgs([])).toEqual({ market: "all", top: 10, maxCalls: 200 });
  });
  it("parses all flags and skips pnpm's bare --", () => {
    expect(parseDeepDiveArgs(["--", "--market", "hk", "--top", "5", "--symbol", "0700.HK,0005.HK", "--max-calls", "50", "--as-of", "2026-09-05"])).toEqual({
      market: "hk",
      top: 5,
      maxCalls: 50,
      asOf: "2026-09-05",
      symbols: ["0700.HK", "0005.HK"],
    });
  });
  it("rejects bad values loudly", () => {
    expect(() => parseDeepDiveArgs(["--market", "cn"])).toThrow(/--market must be us\|hk\|all/);
    expect(() => parseDeepDiveArgs(["--top", "0"])).toThrow(/--top must be a positive integer/);
    expect(() => parseDeepDiveArgs(["--as-of", "Sept 5"])).toThrow(/--as-of must be YYYY-MM-DD/);
    expect(() => parseDeepDiveArgs(["--nope"])).toThrow(/unknown argument/);
  });
});

describe("missingLlmEnv", () => {
  it("names every missing var", () => {
    expect(missingLlmEnv({} as NodeJS.ProcessEnv)).toEqual(["LLM_BASE_URL", "LLM_API_KEY", "LLM_ANALYST_MODEL", "LLM_DEBATE_MODEL", "LLM_VERDICT_MODEL"]);
    expect(missingLlmEnv({ LLM_BASE_URL: "x", LLM_API_KEY: "k", LLM_ANALYST_MODEL: "a", LLM_DEBATE_MODEL: "d", LLM_VERDICT_MODEL: "v" } as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("LLM_API_KEY_FILE satisfies LLM_API_KEY", () => {
    const env = { LLM_BASE_URL: "x", LLM_API_KEY_FILE: "/tmp/cred.json", LLM_ANALYST_MODEL: "a", LLM_DEBATE_MODEL: "d", LLM_VERDICT_MODEL: "v" } as NodeJS.ProcessEnv;
    expect(missingLlmEnv(env)).toEqual([]);
  });
});

describe("resolveLlmApiKey", () => {
  it("prefers LLM_API_KEY; falls back to the JSON credential file; loud-undefined otherwise", () => {
    const tmp = path.join(tmpdir(), `llm-cred-${Date.now()}.json`);
    writeFileSync(tmp, JSON.stringify({ access_token: "tok-123" }));
    try {
      expect(resolveLlmApiKey({ LLM_API_KEY: "direct", LLM_API_KEY_FILE: tmp } as NodeJS.ProcessEnv)).toBe("direct");
      expect(resolveLlmApiKey({ LLM_API_KEY_FILE: tmp } as NodeJS.ProcessEnv)).toBe("tok-123");
      expect(resolveLlmApiKey({ LLM_API_KEY_FILE: "/nonexistent.json" } as NodeJS.ProcessEnv)).toBeUndefined();
      expect(resolveLlmApiKey({} as NodeJS.ProcessEnv)).toBeUndefined();
    } finally {
      rmSync(tmp, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------

let db: TestDatabase;
let prisma: PrismaService;
let dataDir: string;

const VERDICT = {
  instrumentId: "AAPL",
  rating: "buy" as const,
  conviction: 0.5,
  abstain: false,
  thesis: "t",
  keyRisks: ["r"],
  invalidationConditions: ["i"],
  asOf: "2026-09-05",
  promptVersion: "v1",
};

const okOutcome = (calls = 7, cacheHits = 0): DeepDiveOutcome => ({ ok: true, verdict: VERDICT, hashes: ["h1", "h2"], calls, cacheHits });

beforeAll(async () => {
  db = await createTestDatabase();
  process.env.DATABASE_URL = db.url;
  prisma = new PrismaService();
  await prisma.$connect();

  dataDir = mkdtempSync(path.join(tmpdir(), "deep-dive-data-"));
  writeFileSync(
    path.join(dataDir, "universe.us.json"),
    JSON.stringify({
      symbols: [
        { symbol: "AAPL", name: "Apple Inc.", currency: "USD", kind: "stock" },
        { symbol: "MSFT", name: "Microsoft Corp.", currency: "USD", kind: "stock" },
        { symbol: "SPY", name: "SPDR S&P 500", currency: "USD", kind: "etf" },
      ],
    }),
  );
  writeFileSync(path.join(dataDir, "universe.hk.json"), JSON.stringify({ symbols: [{ symbol: "0700.HK", name: "Tencent", currency: "HKD", kind: "stock" }] }));

  const run = await prisma.screenRun.create({
    data: { market: "US", universeSize: 3, ok: 3, genuinelyAbsent: 0, fetchFailed: 0, degraded: false, warningsJson: "[]" },
  });
  await prisma.screenResult.createMany({
    data: [
      { runId: run.id, symbol: "AAPL", rank: 1, score: 0.9, metricsJson: JSON.stringify({ close: 230.5, caDegraded: false }) },
      { runId: run.id, symbol: "MSFT", rank: 2, score: 0.8, metricsJson: JSON.stringify({ close: 500.1 }) },
      { runId: run.id, symbol: "SPY", rank: 3, score: 0.7, metricsJson: JSON.stringify({ close: 650.2 }) },
    ],
  });
  await prisma.instrument.createMany({
    data: [
      { symbol: "AAPL", market: "US", currency: "USD", name: "Apple Inc." },
      { symbol: "MSFT", market: "US", currency: "USD", name: "Microsoft Corp." },
      { symbol: "SPY", market: "US", currency: "USD", name: "SPDR S&P 500" },
    ],
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  destroyTestDatabase(db);
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATABASE_URL;
});

const ctxFor = (symbol: string) => ({
  ctx: {
    symbol,
    name: symbol,
    market: "US",
    asOf: "2026-09-05",
    screenMetrics: { close: 1 },
    rank: 1,
    score: 0.5,
    recentBars: { lastClose: 1, lastDate: "2026-09-05", change20d: null, change60d: null, adv20: null },
    news: [],
    caDegraded: false,
  },
  warnings: [] as string[],
});

function depsWith(pipeline: PipelineRunner, over: Partial<DeepDiveBatchDeps> = {}): DeepDiveBatchDeps {
  return {
    prisma,
    pipeline,
    buildContext: async (a) => ctxFor(a.symbol),
    maxCalls: 200,
    asOf: "2026-09-05",
    dataDir,
    log: () => {},
    ...over,
  };
}

describe("selectTargets", () => {
  it("takes the latest ScreenRun's top-N by rank, universe supplies name/kind", async () => {
    const { lanes } = await selectTargets(prisma, { market: "us", top: 2, maxCalls: 200 }, dataDir);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.targets.map((t) => [t.symbol, t.kind])).toEqual([
      ["AAPL", "stock"],
      ["MSFT", "stock"],
    ]);
    expect(lanes[0]!.targets[0]!.metrics).toEqual({ close: 230.5, caDegraded: false });
  });

  it("--symbol bypasses the shortlist with latest metrics attached", async () => {
    const { lanes } = await selectTargets(prisma, { market: "all", top: 10, maxCalls: 200, symbols: ["SPY"] }, dataDir);
    expect(lanes[0]!.targets[0]).toMatchObject({ symbol: "SPY", kind: "etf", rank: 3, score: 0.7 });
  });

  it("a lane without a ScreenRun is skipped with a warning", async () => {
    const { lanes, warnings } = await selectTargets(prisma, { market: "all", top: 10, maxCalls: 200 }, dataDir);
    expect(lanes.map((l) => l.market)).toEqual(["US"]);
    expect(warnings.some((w) => w.includes("HK: no ScreenRun"))).toBe(true);
  });
});

describe("runDeepDiveBatch", () => {
  it("happy path: persists DeepDiveRun + reports with verdict JSON and hashes", async () => {
    const reports = await runDeepDiveBatch(depsWith(async () => okOutcome()), { market: "us", top: 3, maxCalls: 200, asOf: "2026-09-05" });
    expect(reports).toHaveLength(1);
    const r = reports[0]!;
    expect(r.failed).toBe(0);
    expect(r.llmCalls).toBe(21);
    expect(r.reports.map((x) => x.status)).toEqual(["ok", "ok", "ok"]);

    const run = await prisma.deepDiveRun.findFirst({ where: { id: (await prisma.deepDiveRun.findFirst({ orderBy: { id: "desc" } }))!.id } });
    expect(run).toMatchObject({ market: "US", topN: 3, llmCalls: 21, cacheHits: 0, failed: 0, status: "complete" });
    const rows = await prisma.deepDiveReport.findMany({ where: { runId: run!.id }, orderBy: { symbol: "asc" } });
    expect(rows.map((x) => x.symbol)).toEqual(["AAPL", "MSFT", "SPY"]);
    const verdict = JSON.parse(rows[0]!.verdictJson!);
    expect(verdict.asOf).toBe("2026-09-05");
    expect(verdict.promptVersion).toBe("v1");
    expect(JSON.parse(rows[0]!.decisionHashesJson!)).toEqual(["h1", "h2"]);
  });

  // W2 (docs/ops-hardening-plan.md): the run row is created BEFORE the lane's
  // name pool, so a kill or crash mid-lane leaves a detectable "running" row
  // instead of nothing. Measured 2026-09-10: the US leg made 40 live calls,
  // completed 4 of 10 verdicts, and discarded all of it invisibly.
  it("a crash after the lane pool leaves a 'running' row and no reports", async () => {
    const exploding = new Proxy(prisma, {
      get(target, prop) {
        if (prop === "deepDiveReport") {
          return new Proxy((target as any).deepDiveReport, {
            get(rt, rp) {
              if (rp === "createMany") return async () => { throw new Error("simulated kill before report write"); };
              return Reflect.get(rt, rp);
            },
          });
        }
        return Reflect.get(target, prop);
      },
    }) as unknown as PrismaService;

    await expect(
      runDeepDiveBatch(depsWith(async () => okOutcome(), { prisma: exploding }), { market: "us", top: 3, maxCalls: 200 }),
    ).rejects.toThrow(/simulated kill/);

    const latest = await prisma.deepDiveRun.findFirst({ orderBy: { id: "desc" } });
    expect(latest).toMatchObject({ market: "US", topN: 3, status: "running", llmCalls: 0, failed: 0 });
    expect(await prisma.deepDiveReport.count({ where: { runId: latest!.id } })).toBe(0);
  });

  it("per-name failure isolation: one failing pipeline never aborts the lane", async () => {
    const pipeline: PipelineRunner = async (ctx) =>
      ctx.symbol === "MSFT" ? { ok: false, failure: "verdict-parse:no JSON object found in response", hashes: ["hx"], calls: 8, cacheHits: 0 } : okOutcome();
    const [r] = await runDeepDiveBatch(depsWith(pipeline), { market: "us", top: 3, maxCalls: 200 });
    expect(r!.failed).toBe(1);
    const msft = r!.reports.find((x) => x.symbol === "MSFT")!;
    expect(msft.status).toMatch(/^failed:verdict-parse:/);
    expect(msft.verdictJson).toBeNull();
    expect(JSON.parse(msft.decisionHashesJson!)).toEqual(["hx"]);
    expect(r!.reports.filter((x) => x.status === "ok")).toHaveLength(2);
  });

  it("a throwing pipeline is caught per name (failed:unexpected)", async () => {
    const pipeline: PipelineRunner = async (ctx) => {
      if (ctx.symbol === "AAPL") throw new Error("boom");
      return okOutcome();
    };
    const [r] = await runDeepDiveBatch(depsWith(pipeline), { market: "us", top: 3, maxCalls: 200 });
    expect(r!.reports.find((x) => x.symbol === "AAPL")!.status).toBe("failed:unexpected:boom");
    expect(r!.failed).toBe(1);
  });

  it("budget guard aborts BEFORE overspend: reservation caps queued names", async () => {
    let started = 0;
    const pipeline: PipelineRunner = async () => (started++, okOutcome(7, 0));
    const [r] = await runDeepDiveBatch(depsWith(pipeline, { maxCalls: MAX_CALLS_PER_NAME }), { market: "us", top: 3, maxCalls: MAX_CALLS_PER_NAME });
    expect(started).toBe(1);
    expect(r!.llmCalls).toBe(7);
    expect(r!.reports.filter((x) => x.status === "failed:budget-exceeded")).toHaveLength(2);
    expect(r!.warnings.some((w) => w.includes("budget:"))).toBe(true);
  });

  it("cache-hit reruns reconcile the reservation (serial pool)", async () => {
    const pipeline: PipelineRunner = async () => okOutcome(0, 7);
    // Reserved 7/name upfront, reconciled to actual 0 after each name — with
    // concurrency 1 a fully-cached rerun fits a budget of one name's worth.
    const [r] = await runDeepDiveBatch(depsWith(pipeline, { maxCalls: MAX_CALLS_PER_NAME, concurrency: 1 }), { market: "us", top: 3, maxCalls: MAX_CALLS_PER_NAME });
    expect(r!.reports.map((x) => x.status)).toEqual(["ok", "ok", "ok"]);
    expect(r!.llmCalls).toBe(0);
    expect(r!.cacheHits).toBe(21);
  });
});
