/**
 * Deep-dive CLI (phase-2-plan) — the lean agent pipeline over the daily
 * screen's shortlist, persisting DeepDiveRun + DeepDiveReport per lane and
 * logging every LLM decision in AgentDecision (content-addressed cache: an
 * unchanged data snapshot reruns at $0).
 *
 *   pnpm -C apps/api screen:deep-dive [-- --market us|hk|all] [-- --top N]
 *                                    [-- --symbol A,B] [-- --max-calls N]
 *                                    [-- --as-of YYYY-MM-DD]
 *
 * Reads the LATEST ScreenRun per lane and takes its top-N ScreenResults by
 * rank. --symbol bypasses the shortlist: the name's Instrument row and its
 * latest ScreenResult metrics (any run) are used when present; rank/score
 * degrade to 0 and screenRunId to the lane's latest run (0 when none).
 *
 * Env contract (phase-2-plan): LLM_BASE_URL, LLM_API_KEY (or
 * LLM_API_KEY_FILE → JSON with access_token, e.g. the Kimi Code CLI's
 * OAuth store), LLM_ANALYST_MODEL, LLM_DEBATE_MODEL, LLM_VERDICT_MODEL;
 * optional LLM_TEMPERATURE (k3-256k needs 1 — measured) and
 * LLM_REASONING_EFFORT ("low" for the smoke profile). Loaded via Node's
 * native
 * process.loadEnvFile (Node 22; no dotenv in this repo), tried IN ORDER:
 * apps/api/.env first, then the repo-root .env (../../.env from apps/api) —
 * the first file found wins for the vars it defines; missing files are
 * skipped silently, but when names will actually be processed and any
 * required var is still unset the CLI FAILS LOUD naming every missing var.
 *
 * --max-calls (default 200) is a hard budget checked BEFORE each name: when
 * the next name could push the run past the cap (7 calls/stock, 6/ETF
 * worst case), the run stops queueing and remaining names are recorded
 * failed:budget-exceeded — a loud abort, never a silent bill.
 *
 * Plain script, NOT Nest (same idiom as daily-screen.ts). Tests drive
 * runDeepDiveBatch() directly with fakes; main() is only env/args/wiring.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OpenAiCompatLlmClient, runDeepDive, type DecisionLog, type DeepDiveOutcome } from "@agentic-trading/agents";
import type { DeepDiveContext } from "@agentic-trading/agents";
import { PrismaService } from "../prisma.service.js";
import { EastmoneyF10Provider } from "../market-data/eastmoney-f10.provider.js";
import { buildDeepDiveContext, type BuiltContext } from "../agents/context.js";
import type { FetchNewsDeps } from "../agents/news.js";

const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

export const REQUIRED_LLM_ENV = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_ANALYST_MODEL", "LLM_DEBATE_MODEL", "LLM_VERDICT_MODEL"] as const;

/** Worst-case live calls per name (7 stock / 6 ETF) — the budget guard uses
 *  the stock number so it never overshoots. */
export const MAX_CALLS_PER_NAME = 7;

export type LaneArg = "us" | "hk";

export interface DeepDiveCliArgs {
  market: LaneArg | "all";
  top: number;
  symbols?: string[];
  maxCalls: number;
  asOf?: string;
}

export function parseDeepDiveArgs(argv: string[]): DeepDiveCliArgs {
  const args: DeepDiveCliArgs = { market: "all", top: 10, maxCalls: 200 };
  const symbols: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") continue; // pnpm injects a bare "--"
    const next = (): string => {
      const v = argv[++i];
      if (!v) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === "--market") {
      const v = next();
      if (v !== "us" && v !== "hk" && v !== "all") throw new Error(`--market must be us|hk|all, got "${v}"`);
      args.market = v;
    } else if (arg === "--top") {
      args.top = Number(next());
      if (!Number.isInteger(args.top) || args.top < 1) throw new Error("--top must be a positive integer");
    } else if (arg === "--max-calls") {
      args.maxCalls = Number(next());
      if (!Number.isInteger(args.maxCalls) || args.maxCalls < 1) throw new Error("--max-calls must be a positive integer");
    } else if (arg === "--as-of") {
      args.asOf = next();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(args.asOf)) throw new Error("--as-of must be YYYY-MM-DD");
    } else if (arg === "--symbol") {
      symbols.push(
        ...next()
          .split(",")
          .filter(Boolean),
      );
    } else throw new Error(`unknown argument "${arg}" (expected --market/--top/--symbol/--max-calls/--as-of)`);
  }
  if (symbols.length) args.symbols = symbols;
  return args;
}

/** Native .env loading (Node 22 process.loadEnvFile; no dotenv here). Order:
 *  apps/api/.env, then repo-root .env. Missing files are skipped. */
export function loadEnvFiles(pkgRoot: string = PKG_ROOT): string[] {
  const loaded: string[] = [];
  for (const p of [path.join(pkgRoot, ".env"), path.resolve(pkgRoot, "..", "..", ".env")]) {
    if (!existsSync(p)) continue;
    try {
      process.loadEnvFile(p);
      loaded.push(p);
    } catch {
      // Malformed file: skip loudly at call site via the missing-vars check.
    }
  }
  return loaded;
}

export function missingLlmEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return REQUIRED_LLM_ENV.filter((k) => !env[k] && !(k === "LLM_API_KEY" && env.LLM_API_KEY_FILE));
}

/** LLM_API_KEY directly, or LLM_API_KEY_FILE pointing at a JSON credential
 *  with an `access_token` field (the Kimi Code CLI's OAuth store at
 *  ~/.kimi-code/credentials/kimi-code.json — a ROTATING subscription token,
 *  so it is read fresh at process start, never copied into .env).
 *  User decision 2026-09-06: local smoke profile = the CLI's own credential. */
export function resolveLlmApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.LLM_API_KEY) return env.LLM_API_KEY;
  const file = env.LLM_API_KEY_FILE;
  if (!file) return undefined;
  try {
    const token = (JSON.parse(readFileSync(file, "utf8")) as { access_token?: string }).access_token;
    return token || undefined;
  } catch {
    return undefined; // missing/malformed file → the missing-env check fails loud
  }
}

// ---------------------------------------------------------------------------

export interface DeepDiveTarget {
  symbol: string;
  name: string;
  market: string; // "US" | "HK"
  kind: "stock" | "etf";
  rank: number;
  score: number;
  metrics: Record<string, unknown> | null;
}

/** The pipeline function signature the batch runner needs (injected — tests
 *  script it, main() wires the real runDeepDive). */
export type PipelineRunner = (ctx: DeepDiveContext, opts: { isEtf: boolean }) => Promise<DeepDiveOutcome>;

export interface DeepDiveBatchDeps {
  prisma: PrismaService;
  pipeline: PipelineRunner;
  /** Context assembler (injectable; default wires F10 + news). */
  buildContext?: (args: {
    symbol: string;
    name: string;
    market: string;
    kind: "stock" | "etf";
    asOf: string;
    rank: number;
    score: number;
    metrics: Record<string, unknown> | null;
  }) => Promise<BuiltContext | { failure: string }>;
  concurrency?: number;
  maxCalls: number;
  asOf?: string;
  dataDir?: string;
  log?: (line: string) => void;
}

export interface LaneDeepDiveReport {
  market: string;
  screenRunId: number;
  topN: number;
  llmCalls: number;
  cacheHits: number;
  failed: number;
  warnings: string[];
  reports: { symbol: string; status: string; verdictJson: string | null; decisionHashesJson: string | null }[];
}

interface UniverseMeta {
  name: string;
  kind: "stock" | "etf";
}

function loadUniverses(dataDir: string): Map<string, UniverseMeta> {
  const map = new Map<string, UniverseMeta>();
  for (const lane of ["us", "hk"] as const) {
    const file = path.join(dataDir, `universe.${lane}.json`);
    if (!existsSync(file)) continue;
    const raw = JSON.parse(readFileSync(file, "utf8"));
    for (const e of raw.symbols as { symbol: string; name: string; kind: "stock" | "etf" }[]) {
      map.set(e.symbol, { name: e.name, kind: e.kind });
    }
  }
  return map;
}

/** Latest ScreenRun per lane + top-N targets by rank. --symbol names bypass
 *  the shortlist: latest metrics from any run, rank/score 0 when absent. */
export async function selectTargets(
  prisma: PrismaService,
  args: DeepDiveCliArgs,
  dataDir: string,
): Promise<{ lanes: { market: string; screenRunId: number; targets: DeepDiveTarget[] }[]; warnings: string[] }> {
  const universe = loadUniverses(dataDir);
  const warnings: string[] = [];
  const lanes: { market: string; screenRunId: number; targets: DeepDiveTarget[] }[] = [];

  if (args.symbols?.length) {
    const byMarket = new Map<string, DeepDiveTarget[]>();
    for (const symbol of args.symbols) {
      const market = symbol.endsWith(".HK") ? "HK" : "US";
      const meta = universe.get(symbol);
      const instrument = await prisma.instrument.findUnique({ where: { symbol } });
      if (!instrument) warnings.push(`${symbol}: no Instrument row — ad-hoc name will fail at context assembly`);
      const latestResult = await prisma.screenResult.findFirst({ where: { symbol }, orderBy: { runId: "desc" } });
      const latestRun = latestResult ? null : await prisma.screenRun.findFirst({ where: { market }, orderBy: { runAt: "desc" } });
      const list = byMarket.get(market) ?? [];
      list.push({
        symbol,
        name: instrument?.name ?? meta?.name ?? symbol,
        market,
        kind: meta?.kind ?? "stock",
        rank: latestResult?.rank ?? 0,
        score: latestResult?.score ?? 0,
        metrics: latestResult ? (JSON.parse(latestResult.metricsJson) as Record<string, unknown>) : null,
      });
      byMarket.set(market, list);
      void latestRun;
    }
    for (const [market, targets] of [...byMarket.entries()].sort()) {
      const run = await prisma.screenRun.findFirst({ where: { market }, orderBy: { runAt: "desc" } });
      lanes.push({ market, screenRunId: run?.id ?? 0, targets });
    }
    return { lanes, warnings };
  }

  const laneArgs: LaneArg[] = args.market === "all" ? ["us", "hk"] : [args.market];
  for (const lane of laneArgs) {
    const market = lane.toUpperCase();
    const run = await prisma.screenRun.findFirst({ where: { market }, orderBy: { runAt: "desc" } });
    if (!run) {
      warnings.push(`${market}: no ScreenRun yet — run screen:daily first, lane skipped`);
      continue;
    }
    const results = await prisma.screenResult.findMany({ where: { runId: run.id }, orderBy: { rank: "asc" }, take: args.top });
    const targets: DeepDiveTarget[] = results.map((r) => {
      const meta = universe.get(r.symbol);
      return {
        symbol: r.symbol,
        name: meta?.name ?? r.symbol,
        market,
        kind: meta?.kind ?? "stock",
        rank: r.rank,
        score: r.score,
        metrics: JSON.parse(r.metricsJson) as Record<string, unknown>,
      };
    });
    lanes.push({ market, screenRunId: run.id, targets });
  }
  return { lanes, warnings };
}

/** Concurrency pool (p-limit-style, hand-rolled). Order of results matches
 *  input order regardless of completion order. */
async function pool<T, R>(items: T[], size: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!, i);
      }
    }),
  );
  return results;
}

export async function runDeepDiveBatch(deps: DeepDiveBatchDeps, args: DeepDiveCliArgs): Promise<LaneDeepDiveReport[]> {
  const log = deps.log ?? console.log;
  const dataDir = deps.dataDir ?? path.join(PKG_ROOT, "data");
  const asOf = args.asOf ?? new Date().toISOString().slice(0, 10);
  let callsUsed = 0;
  // Reserved worst-case budget (7/name) committed SYNCHRONOUSLY when a name
  // starts — with a concurrency pool, four names can pass the guard before
  // the first pipeline call resolves, so the check must reserve, not count.
  let callsReserved = 0;
  let budgetExhausted = false;

  const { lanes, warnings: selWarnings } = await selectTargets(deps.prisma, args, dataDir);
  for (const w of selWarnings) log(`WARN ${w}`);

  const reports: LaneDeepDiveReport[] = [];
  for (const lane of lanes) {
    const warnings: string[] = [...selWarnings];
    const laneReport: LaneDeepDiveReport = {
      market: lane.market,
      screenRunId: lane.screenRunId,
      topN: lane.targets.length,
      llmCalls: 0,
      cacheHits: 0,
      failed: 0,
      warnings,
      reports: [],
    };

    // W2: create the run row BEFORE the name pool so a crash or kill leaves a
    // detectable "running" row instead of nothing (docs/ops-hardening-plan.md).
    // Counters are reconciled and the status flipped to "complete" only after
    // the DeepDiveReport rows are written, so a half-written run is never
    // presented as complete.
    const run = await deps.prisma.deepDiveRun.create({
      data: {
        market: lane.market,
        screenRunId: lane.screenRunId,
        topN: lane.targets.length,
        llmCalls: 0,
        cacheHits: 0,
        failed: 0,
        warningsJson: "[]",
        status: "running",
      },
    });

    const outcomes = await pool(lane.targets, deps.concurrency ?? 4, async (target) => {
      // Budget guard: reserved BEFORE the name starts; never overshoots.
      if (budgetExhausted || callsReserved + MAX_CALLS_PER_NAME > deps.maxCalls) {
        budgetExhausted = true;
        return { symbol: target.symbol, status: "failed:budget-exceeded", verdictJson: null, decisionHashesJson: null, calls: 0, cacheHits: 0 };
      }
      callsReserved += MAX_CALLS_PER_NAME;
      try {
        const build =
          deps.buildContext ??
          (async (a: Parameters<NonNullable<DeepDiveBatchDeps["buildContext"]>>[0]) => {
            const f10 = new EastmoneyF10Provider();
            const newsDeps: FetchNewsDeps = {};
            return buildDeepDiveContext({ prisma: deps.prisma, fundamentals: f10, newsDeps }, a);
          });
        const built = await build({
          symbol: target.symbol,
          name: target.name,
          market: target.market,
          kind: target.kind,
          asOf,
          rank: target.rank,
          score: target.score,
          metrics: target.metrics,
        });
        if ("failure" in built) {
          return { symbol: target.symbol, status: `failed:${built.failure}`, verdictJson: null, decisionHashesJson: null, calls: 0, cacheHits: 0 };
        }
        for (const w of built.warnings) warnings.push(`${target.symbol}: ${w}`);
        const outcome = await deps.pipeline(built.ctx, { isEtf: target.kind === "etf" });
        callsUsed += outcome.calls;
        callsReserved += outcome.calls - MAX_CALLS_PER_NAME; // reconcile reservation to actual
        if (!outcome.ok) {
          return {
            symbol: target.symbol,
            status: `failed:${outcome.failure}`,
            verdictJson: null,
            decisionHashesJson: outcome.hashes.length ? JSON.stringify(outcome.hashes) : null,
            calls: outcome.calls,
            cacheHits: outcome.cacheHits,
          };
        }
        return {
          symbol: target.symbol,
          status: "ok",
          verdictJson: JSON.stringify(outcome.verdict),
          decisionHashesJson: JSON.stringify(outcome.hashes),
          calls: outcome.calls,
          cacheHits: outcome.cacheHits,
        };
      } catch (err: any) {
        return { symbol: target.symbol, status: `failed:unexpected:${String(err?.message ?? err).slice(0, 60)}`, verdictJson: null, decisionHashesJson: null, calls: 0, cacheHits: 0 };
      }
    });

    for (const o of outcomes) {
      laneReport.reports.push({ symbol: o.symbol, status: o.status, verdictJson: o.verdictJson, decisionHashesJson: o.decisionHashesJson });
      laneReport.llmCalls += o.calls;
      laneReport.cacheHits += o.cacheHits;
      if (o.status !== "ok") laneReport.failed++;
      log(`${o.symbol}: ${o.status}${o.status === "ok" ? ` (${o.calls} calls, ${o.cacheHits} cache hits)` : ""}`);
    }
    if (budgetExhausted) {
      warnings.push(`budget: --max-calls ${deps.maxCalls} reached after ${callsUsed} live calls — remaining names marked failed:budget-exceeded (LOUD abort before overspend)`);
      log(`⚠ budget exhausted: ${callsUsed}/${deps.maxCalls} calls used`);
    }

    // Persist: the reports first, then close out the pre-created run row.
    await deps.prisma.deepDiveReport.createMany({
      data: laneReport.reports.map((r) => ({ runId: run.id, symbol: r.symbol, status: r.status, verdictJson: r.verdictJson, decisionHashesJson: r.decisionHashesJson })),
    });
    await deps.prisma.deepDiveRun.update({
      where: { id: run.id },
      data: {
        llmCalls: laneReport.llmCalls,
        cacheHits: laneReport.cacheHits,
        failed: laneReport.failed,
        warningsJson: JSON.stringify(warnings),
        status: "complete",
      },
    });
    log(
      `deep-dive ${lane.market} run=${run.id} screenRun=${lane.screenRunId} names=${lane.targets.length} ` +
        `ok=${lane.targets.length - laneReport.failed} failed=${laneReport.failed} llmCalls=${laneReport.llmCalls} cacheHits=${laneReport.cacheHits} budget=${deps.maxCalls}`,
    );
    reports.push(laneReport);
  }
  return reports;
}

// ---------------------------------------------------------------------------
// CLI wrapper (env + args + wiring only).
// ---------------------------------------------------------------------------

function prismaDecisionLog(prisma: PrismaService): DecisionLog {
  return {
    async lookup(hash) {
      const row = await prisma.agentDecision.findUnique({ where: { hash } });
      return row ? { hash: row.hash, responseText: row.responseText } : null;
    },
    async record(entry) {
      await prisma.agentDecision
        .create({
          data: {
            hash: entry.hash,
            agent: entry.agent,
            model: entry.model,
            promptVersion: entry.promptVersion,
            systemPrompt: entry.systemPrompt,
            userPrompt: entry.userPrompt,
            responseText: entry.responseText,
            usageJson: entry.usage ? JSON.stringify(entry.usage) : null,
          },
        })
        .catch((e: any) => {
          // Concurrent duplicate hash (pool of 4): the row already exists —
          // the cache just did its job one name too late.
          if (e?.code === "P2002") return;
          throw e;
        });
    },
  };
}

async function main(): Promise<void> {
  const args = parseDeepDiveArgs(process.argv.slice(2));
  const loadedEnv = loadEnvFiles();
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const { lanes } = await selectTargets(prisma, args, path.join(PKG_ROOT, "data"));
    const nameCount = lanes.reduce((n, l) => n + l.targets.length, 0);
    if (nameCount > 0) {
      const missing = missingLlmEnv();
      if (missing.length) {
        console.error(`FATAL missing LLM env vars: ${missing.join(", ")} — set them in apps/api/.env or the repo-root .env (loaded: ${loadedEnv.join(", ") || "none"})`);
        process.exitCode = 1;
        return;
      }
    }
    const client = new OpenAiCompatLlmClient({
      baseUrl: process.env.LLM_BASE_URL!,
      apiKey: resolveLlmApiKey()!,
      // Kimi coding endpoint (k3-256k) 400s on temperature ≠ 1 (measured
      // 2026-09-06); other providers default to the client's 0.2.
      defaultTemperature: process.env.LLM_TEMPERATURE ? Number(process.env.LLM_TEMPERATURE) : undefined,
      defaultReasoningEffort: process.env.LLM_REASONING_EFFORT || undefined,
    });
    const models = {
      analyst: process.env.LLM_ANALYST_MODEL!,
      debate: process.env.LLM_DEBATE_MODEL!,
      verdict: process.env.LLM_VERDICT_MODEL!,
    };
    const log = prismaDecisionLog(prisma);
    const pipeline: PipelineRunner = (ctx, opts) => runDeepDive({ client, log, models }, ctx, opts);
    const reports = await runDeepDiveBatch({ prisma, pipeline, maxCalls: args.maxCalls }, args);
    // W1a (docs/ops-hardening-plan.md): ANY name failure makes the leg non-zero.
    // The previous rule required a 100% lane failure (failed === topN), so 9 of
    // 10 names could fail — or the whole leg could be killed after completing
    // half the names — and the chain still exited 0.
    if (reports.some((r) => r.failed > 0)) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

const invokedAsScript = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (invokedAsScript) {
  main().catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
  });
}
