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
 * **Prices are config, never a default.** They are a provider fact that changes,
 * and hardcoding one is the same mistake the chain preflight made when it pinned
 * `k3-256k`. With no prices configured every surface reports tokens and refuses
 * to invent dollars. Prices come in TWO TIERS, because the provider bills them
 * that way (DeepSeek: peak = Mon-Fri 01:00-04:00 and 06:00-10:00 **UTC**,
 * everything else off-peak at half the peak rate): the nightly chain slots are
 * 20:30/23:03 HKT = 12:30/15:03 UTC and therefore always off-peak, but daytime
 * chat and any manual re-dive can bill at peak, so a row is classified by its
 * own timestamp. The weekday test uses the **UTC** date — HKT 00:00-08:00 is the
 * previous UTC day, so a Monday 07:00 HKT call is a Sunday UTC call.
 *
 * Three honesty rules are baked in:
 *
 * 1. **The prompt-cache split decides the price.** Cache-hit input bills ~50x
 *    cheaper than cache-miss, input tokens outnumber output ~5:1 here, and the 7
 *    calls per name share one long prefix — measured on this prompt shape, the
 *    second call of an identical prefix reported 1280 of 1520 input tokens
 *    cached. Rows written before the split was captured are priced at the miss
 *    rate and flagged `upperBound`, so an old reading can never understate. The
 *    counterfactual is reported too (`naiveUsd`): if a prompt-builder change
 *    breaks prefix reuse, that gap collapses and this is the only place it shows.
 * 2. **A peak row with no peak prices is counted, not silently discounted**
 *    (`tierUnpriced`) — the same principle as `unpricedCalls`.
 * 3. **Reasoning tokens are output.** They arrive inside `completionTokens`
 *    (`completion_tokens_details.reasoning_tokens`) and providers bill them as
 *    output, so no separate bucket is needed — but it is why `completionTokens`
 *    is larger than the visible answer suggests.
 *
 * Attribution is **first-use**: a decision hash belongs to the earliest run that
 * references it, because a repeated prompt is replayed from the app-level cache
 * with no API call and no new row. Measured 2026-09-16: 1,906 references over
 * 1,892 distinct hashes (14 shared, all in the earliest small runs). Without
 * first-use the per-run table double-counts those and cannot reconcile with the
 * month total — under it, a genuinely $0 replay reads as $0, which is true.
 */
import type { PrismaService } from "../prisma.service.js";

/** Env keys, in one place so the CLI and `ops:health` cannot drift. */
export const COST_ENV = {
  /** Off-peak (the base list) */
  input: "LLM_PRICE_INPUT_PER_MTOK",
  output: "LLM_PRICE_OUTPUT_PER_MTOK",
  cacheHit: "LLM_PRICE_CACHE_HIT_PER_MTOK",
  /** Peak (double the off-peak list for DeepSeek; unset ⇒ flagged, never faked) */
  peakInput: "LLM_PRICE_PEAK_INPUT_PER_MTOK",
  peakOutput: "LLM_PRICE_PEAK_OUTPUT_PER_MTOK",
  peakCacheHit: "LLM_PRICE_PEAK_CACHE_HIT_PER_MTOK",
  basis: "LLM_PRICE_BASIS",
  cap: "LLM_MONTHLY_CAP_USD",
} as const;

export interface PriceTier {
  /** USD per 1M cache-MISS input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens (reasoning included). */
  outputPerMTok: number;
  /** USD per 1M cache-HIT input tokens. `null` ⇒ hits billed at the miss rate
   *  (an upper bound, never an understatement). */
  cacheHitPerMTok: number | null;
}

export interface LlmPricing {
  offPeak: PriceTier;
  /** `null` when no peak prices are configured: peak-window rows are then priced
   *  off-peak and counted in `tierUnpriced`. */
  peak: PriceTier | null;
  /** Which price list these numbers came from, e.g. "deepseek-flash off-peak+peak,
   *  2026-09-16". Printed with every reading so a number stays reproducible after
   *  a price change — the report is only meaningful with its basis. */
  basis: string;
}

function positiveNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function tierFrom(env: Record<string, string | undefined>, input: string, output: string, cacheHit: string): PriceTier | null {
  const inputPerMTok = positiveNumber(env[input]);
  const outputPerMTok = positiveNumber(env[output]);
  if (inputPerMTok === null || outputPerMTok === null) return null;
  return { inputPerMTok, outputPerMTok, cacheHitPerMTok: positiveNumber(env[cacheHit]) };
}

/** `null` when the required off-peak prices are absent or malformed — the caller
 *  then reports tokens only. Never throws: a misconfigured price must not take
 *  down `ops:health`. */
export function parsePricing(env: Record<string, string | undefined> = process.env): LlmPricing | null {
  const offPeak = tierFrom(env, COST_ENV.input, COST_ENV.output, COST_ENV.cacheHit);
  if (!offPeak) return null;
  return {
    offPeak,
    peak: tierFrom(env, COST_ENV.peakInput, COST_ENV.peakOutput, COST_ENV.peakCacheHit),
    basis: (env[COST_ENV.basis] ?? "").trim() || "basis unspecified",
  };
}

/** K3's agreed monthly cap. `null` = no cap configured (spend still reported). */
export function parseCapUsd(env: Record<string, string | undefined> = process.env): number | null {
  return positiveNumber(env[COST_ENV.cap]);
}

export type Tier = "peak" | "off-peak";

/** DeepSeek's peak windows are stated in UTC and are weekday-scoped:
 *  01:00-04:00 and 06:00-10:00 UTC, Monday through Friday; all other hours are
 *  off-peak at half the peak rate. Both the hour AND the weekday are read in
 *  UTC — converting the hour to HKT while keeping a local weekday would misfile
 *  every call between 00:00 and 08:00 HKT, which is the previous UTC day. */
export function tierOf(at: Date): Tier {
  const day = at.getUTCDay();
  const h = at.getUTCHours();
  const weekday = day >= 1 && day <= 5;
  return weekday && ((h >= 1 && h < 4) || (h >= 6 && h < 10)) ? "peak" : "off-peak";
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
 *  "absent", never crash a report. */
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
  /** What this row would have cost with no cache hits at all, at its own tier —
   *  the discount actually earned, and the canary for lost prefix reuse. */
  naiveUsd: number;
  tier: Tier;
  cacheHitTokens: number;
  cacheMissTokens: number;
  /** True when the input side was billed entirely at the miss rate because the
   *  split was absent (or no cache-hit price is configured) — so the figure is
   *  an upper bound rather than a measurement. */
  upperBound: boolean;
  /** True when the row billed in a peak window but no peak prices are
   *  configured: the row is priced off-peak and reported as understated. */
  tierUnpriced: boolean;
}

export function costOf(u: UsageTokens, p: LlmPricing, at: Date): CostedUsage {
  const tier = tierOf(at);
  const tierUnpriced = tier === "peak" && p.peak === null;
  const t = tier === "peak" && p.peak ? p.peak : p.offPeak;
  const splitKnown = u.cacheHitTokens !== null && u.cacheMissTokens !== null;
  const hit = splitKnown ? u.cacheHitTokens! : 0;
  const miss = splitKnown ? u.cacheMissTokens! : u.promptTokens;
  const hitRate = t.cacheHitPerMTok ?? t.inputPerMTok;
  return {
    usd: (hit * hitRate + miss * t.inputPerMTok + u.completionTokens * t.outputPerMTok) / 1_000_000,
    naiveUsd: (u.promptTokens * t.inputPerMTok + u.completionTokens * t.outputPerMTok) / 1_000_000,
    tier,
    cacheHitTokens: hit,
    cacheMissTokens: miss,
    upperBound: !splitKnown || t.cacheHitPerMTok === null,
    tierUnpriced,
  };
}

export interface CostRow {
  model: string;
  agent: string;
  createdAt: Date;
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
  naiveUsd: number;
  peakCalls: number;
  offPeakCalls: number;
  /** Peak-window calls priced with off-peak rates (no peak prices configured). */
  tierUnpriced: number;
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
   *  inferred from a synthetic probe. */
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
  naiveUsd: 0,
  peakCalls: 0,
  offPeakCalls: 0,
  tierUnpriced: 0,
  upperBound: false,
});

function add(t: CostTotals, u: UsageTokens, c: CostedUsage | null): void {
  t.calls++;
  t.promptTokens += u.promptTokens;
  t.completionTokens += u.completionTokens;
  t.cacheHitTokens += c?.cacheHitTokens ?? 0;
  t.cacheMissTokens += c?.cacheMissTokens ?? 0;
  if (!c) return;
  t.usd += c.usd;
  t.naiveUsd += c.naiveUsd;
  if (c.tier === "peak") t.peakCalls++;
  else t.offPeakCalls++;
  if (c.tierUnpriced) t.tierUnpriced++;
  t.upperBound = t.upperBound || c.upperBound;
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
    const c = u && pricing ? costOf(u, pricing, row.createdAt) : null;
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
    select: { model: true, agent: true, createdAt: true, usageJson: true },
  });
  return rows as CostRow[];
}

export interface RunRef {
  runId: number;
  market: string;
  runAt: Date;
  source: string;
  topN: number;
  /** Every name the run attempted, with its verdict status. */
  names: { symbol: string; status: string; hashes: string[] }[];
}

/** One run's cost, after first-use attribution. */
export interface RunCost {
  runId: number;
  market: string;
  runAt: Date;
  source: string;
  names: number;
  decidedNames: number;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  usd: number;
  naiveUsd: number;
  /** Hashes this run owns; `replayed` counts those it references but does not own
   *  because an earlier run billed them first (they cost nothing here, which is
   *  the truth of an app-level cache replay). */
  owned: number;
  replayed: number;
  upperBound: boolean;
  tierUnpriced: number;
}

function parseHashes(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === "string") : [];
  } catch {
    return []; // A malformed hash list costs attribution for that name, not the run.
  }
}

/**
 * Runs (chain and ad-hoc) with every name's decision hashes. Loaded with **no
 * lower bound** on purpose: ownership is "earliest run that referenced the hash"
 * across all history, so a window-scoped load would hand a hash to a later run
 * merely because its true owner fell outside the window and inflate it. The
 * caller filters which runs it *displays*; ownership stays correct.
 */
export async function loadRunRefs(prisma: PrismaService, until: Date): Promise<RunRef[]> {
  const runs = await prisma.deepDiveRun.findMany({
    where: { runAt: { lt: until } },
    select: { id: true, market: true, runAt: true, source: true, topN: true },
    orderBy: { runAt: "asc" },
  });
  const reports = await prisma.deepDiveReport.findMany({
    where: { runId: { in: runs.map((r) => r.id) } },
    select: { runId: true, symbol: true, status: true, decisionHashesJson: true },
  });
  const byRun = new Map<number, RunRef["names"]>();
  for (const r of reports) {
    const list = byRun.get(r.runId) ?? [];
    list.push({ symbol: r.symbol, status: r.status, hashes: parseHashes(r.decisionHashesJson) });
    byRun.set(r.runId, list);
  }
  return runs.map((r) => ({ runId: r.id, market: r.market, runAt: r.runAt, source: r.source, topN: r.topN, names: byRun.get(r.id) ?? [] }));
}

/**
 * First-use attribution: each hash belongs to the earliest run (by `runAt`) that
 * references it. Runs must arrive in ascending `runAt` order — `loadRunRefs`
 * guarantees it and the ordering is load-bearing.
 */
export function attributeFirstUse(refs: RunRef[]): Map<number, { owned: Set<string>; replayed: number }> {
  const owner = new Map<string, number>();
  const out = new Map<number, { owned: Set<string>; replayed: number }>();
  for (const ref of refs) {
    const owned = new Set<string>();
    let replayed = 0;
    for (const name of ref.names) {
      for (const h of name.hashes) {
        if (owner.has(h)) {
          replayed++;
          continue;
        }
        owner.set(h, ref.runId);
        owned.add(h);
      }
    }
    out.set(ref.runId, { owned, replayed });
  }
  return out;
}

/** Cost per run under first-use attribution. `refs` must be in ascending runAt
 *  order (see `loadRunRefs`). */
export async function loadRunCosts(prisma: PrismaService, refs: RunRef[], pricing: LlmPricing | null): Promise<RunCost[]> {
  const attribution = attributeFirstUse(refs);
  const ownedHashes = new Set<string>();
  for (const { owned } of attribution.values()) for (const h of owned) ownedHashes.add(h);
  const decisions = ownedHashes.size
    ? await prisma.agentDecision.findMany({
        where: { hash: { in: [...ownedHashes] } },
        select: { hash: true, createdAt: true, usageJson: true },
      })
    : [];
  const byHash = new Map(decisions.map((d) => [d.hash, d]));

  return refs.map((ref) => {
    const { owned, replayed } = attribution.get(ref.runId)!;
    const out: RunCost = {
      runId: ref.runId,
      market: ref.market,
      runAt: ref.runAt,
      source: ref.source,
      names: ref.names.length,
      decidedNames: ref.names.filter((n) => n.status === "ok").length,
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      usd: 0,
      naiveUsd: 0,
      owned: owned.size,
      replayed,
      upperBound: false,
      tierUnpriced: 0,
    };
    for (const h of owned) {
      const d = byHash.get(h);
      const u = d ? parseUsageJson(d.usageJson) : null;
      if (!d || !u) continue;
      out.calls++;
      out.promptTokens += u.promptTokens;
      out.completionTokens += u.completionTokens;
      if (!pricing) continue;
      const c = costOf(u, pricing, d.createdAt);
      out.usd += c.usd;
      out.naiveUsd += c.naiveUsd;
      out.upperBound = out.upperBound || c.upperBound;
      if (c.tierUnpriced) out.tierUnpriced++;
    }
    return out;
  });
}
