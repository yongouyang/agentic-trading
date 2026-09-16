/**
 * Cost accounting over the decision log (2026-09-16, charter K3).
 *
 * K3 is a *discipline* gate — "monthly token/compute spend stays inside the
 * agreed cap" — and until now the number did not exist in code: the 15,602
 * tokens-per-name figure lived in prose and was computed by hand. The
 * measurement basis was already there and complete, which is why this module
 * adds no table and no write path:
 *
 * - `AgentDecision.usageJson` records `{promptTokens, completionTokens,
 *   totalTokens}` for **every live call** (pipeline and chat). Verified over the
 *   whole store at 2026-09-16: 1,929 rows, 0 with a null usageJson.
 * - An app-level cache hit (`DecisionLog.lookup`) makes no API call and writes
 *   no row, so it is correctly free.
 * - A call rejected with a 4xx throws before `record`: no row, and nothing was
 *   billed. A call that was billed but then failed validation (the repair-round
 *   path) IS recorded and so IS counted.
 * - Attribution to a session/name is a join that already works:
 *   `DeepDiveReport.decisionHashesJson → AgentDecision.hash` (measured on run
 *   15: 261 decisions, 493,639 input + 95,637 output tokens over 37 names =
 *   15,926 tokens/name, reproducing the charter's 15,602).
 *
 * **Prices are config, never a default.** They are a provider fact that changes
 * (DeepSeek restructured V4.1-Flash pricing on 2026-09-10, has peak/off-peak
 * tiers, and published sources disagree), and hardcoding one is the same mistake
 * the chain preflight made when it pinned `k3-256k`. With no prices configured
 * every surface reports tokens and refuses to invent dollars.
 *
 * Two honesty rules are baked in:
 *
 * 1. **The prompt-cache split decides the price.** Cache-hit input bills ~50x
 *    cheaper than cache-miss, input tokens outnumber output ~5:1 here, and the 7
 *    calls per name share one long prefix — measured on this prompt shape, the
 *    second call of an identical prefix reported 1280 of 1520 input tokens
 *    cached. Rows written before the split was captured are priced at the miss
 *    rate and flagged `upperBound`, so an old reading can never understate.
 * 2. **Reasoning tokens are output.** They arrive inside `completionTokens`
 *    (`completion_tokens_details.reasoning_tokens`) and providers bill them as
 *    output, so no separate bucket is needed — but it is why `completionTokens`
 *    is larger than the visible answer suggests.
 */
import type { PrismaService } from "../prisma.service.js";

/** Env keys, in one place so the CLI and `ops:health` cannot drift. */
export const COST_ENV = {
  input: "LLM_PRICE_INPUT_PER_MTOK",
  output: "LLM_PRICE_OUTPUT_PER_MTOK",
  cacheHit: "LLM_PRICE_CACHE_HIT_PER_MTOK",
  basis: "LLM_PRICE_BASIS",
  cap: "LLM_MONTHLY_CAP_USD",
} as const;

export interface LlmPricing {
  /** USD per 1M cache-MISS input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens (reasoning included). */
  outputPerMTok: number;
  /** USD per 1M cache-HIT input tokens. `null` ⇒ hits billed at the miss rate
   *  (an upper bound, never an understatement). */
  cacheHitPerMTok: number | null;
  /** Which price list these numbers came from, e.g. "deepseek-flash peak,
   *  2026-09-16". Printed with every reading so a number stays reproducible
   *  after a price change — the report is only meaningful with its basis. */
  basis: string;
}

function positiveNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** `null` when the required prices are absent or malformed — the caller then
 *  reports tokens only. Never throws: a misconfigured price must not take down
 *  `ops:health`. */
export function parsePricing(env: Record<string, string | undefined> = process.env): LlmPricing | null {
  const inputPerMTok = positiveNumber(env[COST_ENV.input]);
  const outputPerMTok = positiveNumber(env[COST_ENV.output]);
  if (inputPerMTok === null || outputPerMTok === null) return null;
  return {
    inputPerMTok,
    outputPerMTok,
    cacheHitPerMTok: positiveNumber(env[COST_ENV.cacheHit]),
    basis: (env[COST_ENV.basis] ?? "").trim() || "basis unspecified",
  };
}

/** K3's agreed monthly cap. `null` = no cap configured (spend still reported). */
export function parseCapUsd(env: Record<string, string | undefined> = process.env): number | null {
  return positiveNumber(env[COST_ENV.cap]);
}

export interface UsageTokens {
  promptTokens: number;
  completionTokens: number;
  /** `null` on rows that predate cache-split capture (all of them before
   *  2026-09-16) — the difference between an accurate and an upper-bound read. */
  cacheHitTokens: number | null;
  cacheMissTokens: number | null;
}

/** Tolerant by design: this reads a log column written by several call sites
 *  (pipeline, chat) plus historical rows, and a malformed blob must degrade to
 *  "unpriced/absent", never crash a report. */
export function parseUsageJson(usageJson: string | null): UsageTokens | null {
  if (!usageJson) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(usageJson);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const promptTokens = num(o.promptTokens);
  if (promptTokens === null) return null;
  const hit = num(o.promptCacheHitTokens);
  const miss = num(o.promptCacheMissTokens) ?? (hit !== null ? Math.max(promptTokens - hit, 0) : null);
  return { promptTokens, completionTokens: num(o.completionTokens) ?? 0, cacheHitTokens: hit, cacheMissTokens: miss };
}

export interface CostedUsage {
  usd: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  /** True when the input side was billed entirely at the miss rate because the
   *  split was absent (or no cache-hit price is configured) — so the figure is
   *  an upper bound rather than a measurement. */
  upperBound: boolean;
}

export function costOf(u: UsageTokens, p: LlmPricing): CostedUsage {
  const splitKnown = u.cacheHitTokens !== null && u.cacheMissTokens !== null;
  const hit = splitKnown ? u.cacheHitTokens! : 0;
  const miss = splitKnown ? u.cacheMissTokens! : u.promptTokens;
  const hitRate = p.cacheHitPerMTok ?? p.inputPerMTok;
  const usd = (hit * hitRate + miss * p.inputPerMTok + u.completionTokens * p.outputPerMTok) / 1_000_000;
  return {
    usd,
    cacheHitTokens: hit,
    cacheMissTokens: miss,
    upperBound: !splitKnown || p.cacheHitPerMTok === null,
  };
}

export interface CostRow {
  model: string;
  agent: string;
  usageJson: string | null;
}

export interface CostTotals {
  calls: number;
  /** Calls whose usage blob was missing/malformed — counted so a token figure is
   *  never mistaken for complete when rows had to be skipped. */
  unpricedCalls: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  usd: number;
  /** Any contributing row was priced on an upper bound (see `costOf`). */
  upperBound: boolean;
}

export interface CostSummary {
  /** False when no prices are configured — then `usd` fields are 0 and no
   *  surface may print a dollar figure. */
  priced: boolean;
  basis: string | null;
  capUsd: number | null;
  overCap: boolean;
  totals: CostTotals;
  byModel: Record<string, CostTotals>;
  byAgent: Record<string, CostTotals>;
  /** Measured, over the rows that carry a split. `null` when none do — never
   *  inferred from the synthetic probe. */
  cacheHitRate: number | null;
}

const emptyTotals = (): CostTotals => ({
  calls: 0,
  unpricedCalls: 0,
  promptTokens: 0,
  completionTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  usd: 0,
  upperBound: false,
});

function add(t: CostTotals, u: UsageTokens, c: CostedUsage | null): void {
  t.calls++;
  t.promptTokens += u.promptTokens;
  t.completionTokens += u.completionTokens;
  t.cacheHitTokens += c?.cacheHitTokens ?? 0;
  t.cacheMissTokens += c?.cacheMissTokens ?? 0;
  if (c) {
    t.usd += c.usd;
    t.upperBound = t.upperBound || c.upperBound;
  }
}

export function summarize(rows: CostRow[], pricing: LlmPricing | null, capUsd: number | null = null): CostSummary {
  const totals = emptyTotals();
  const byModel: Record<string, CostTotals> = {};
  const byAgent: Record<string, CostTotals> = {};
  let splitRows = 0;
  let measureHit = 0;
  let measurePrompt = 0;

  for (const row of rows) {
    const u = parseUsageJson(row.usageJson);
    const c = u && pricing ? costOf(u, pricing) : null;
    const model = (byModel[row.model] ??= emptyTotals());
    const agent = (byAgent[row.agent] ??= emptyTotals());
    if (!u) {
      totals.unpricedCalls++;
      model.unpricedCalls++;
      agent.unpricedCalls++;
      continue;
    }
    add(totals, u, c);
    add(model, u, c);
    add(agent, u, c);
    if (u.cacheHitTokens !== null) {
      splitRows++;
      measureHit += u.cacheHitTokens;
      measurePrompt += u.promptTokens;
    }
  }

  return {
    priced: pricing !== null,
    basis: pricing?.basis ?? null,
    capUsd,
    overCap: pricing !== null && capUsd !== null && totals.usd > capUsd,
    totals,
    byModel,
    byAgent,
    cacheHitRate: splitRows > 0 && measurePrompt > 0 ? measureHit / measurePrompt : null,
  };
}

/** Live calls in `[since, until)`. Read-only. */
export async function loadCostRows(prisma: PrismaService, since: Date, until: Date): Promise<CostRow[]> {
  const rows = await prisma.agentDecision.findMany({
    where: { createdAt: { gte: since, lt: until } },
    select: { model: true, agent: true, usageJson: true },
  });
  return rows as CostRow[];
}

export interface NameTokens {
  symbol: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  usd: number;
  decided: boolean;
}

/** Per-name cost for one deep-dive run, via `decisionHashesJson → hash`. Names
 *  whose verdict failed still carry their billed decisions, so they are counted
 *  and marked `decided: false` — a failed name is not a free name. */
export async function loadRunCosts(prisma: PrismaService, runId: number, pricing: LlmPricing | null): Promise<NameTokens[]> {
  const reports = await prisma.deepDiveReport.findMany({
    where: { runId },
    select: { symbol: true, status: true, decisionHashesJson: true },
  });
  const hashes: string[] = [];
  const hashesBySymbol = new Map<string, string[]>();
  for (const r of reports) {
    if (!r.decisionHashesJson) continue;
    try {
      const parsed: unknown = JSON.parse(r.decisionHashesJson);
      const list = Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === "string") : [];
      hashesBySymbol.set(r.symbol, list);
      hashes.push(...list);
    } catch {
      // A malformed hash list costs attribution for that name, not the run.
    }
  }
  const decisions = hashes.length
    ? await prisma.agentDecision.findMany({
        where: { hash: { in: hashes } },
        select: { hash: true, usageJson: true },
      })
    : [];
  const usageByHash = new Map<string, UsageTokens>();
  for (const d of decisions) {
    const u = parseUsageJson(d.usageJson);
    if (u) usageByHash.set(d.hash, u);
  }
  return reports.map((r) => {
    const out: NameTokens = { symbol: r.symbol, calls: 0, promptTokens: 0, completionTokens: 0, usd: 0, decided: r.status === "ok" };
    for (const h of hashesBySymbol.get(r.symbol) ?? []) {
      const u = usageByHash.get(h);
      if (!u) continue;
      out.calls++;
      out.promptTokens += u.promptTokens;
      out.completionTokens += u.completionTokens;
      if (pricing) out.usd += costOf(u, pricing).usd;
    }
    return out;
  });
}
