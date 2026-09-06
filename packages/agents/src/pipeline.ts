/**
 * Per-name deep-dive orchestration (phase-2-plan):
 *   cache check → news analyst + fundamentals analyst in parallel (ETFs: news
 *   only — a tracker's deep-dive is index/tracking, not Piotroski) → 2-round
 *   bull/bear debate (4 calls, sequential — each round sees the prior ones) →
 *   verdict (1 call) with exactly ONE repair round on parse failure.
 * = 7 calls/stock, 6/ETF when nothing is cached; cache lookup before EVERY
 * call, so an unchanged data snapshot reruns at $0 (the snapshot travels
 * inside the user prompt, so unchanged data ⇒ identical hash).
 *
 * Never throws on LLM failure: returns { ok: false, failure: <slug> } and the
 * caller records status "failed:<slug>". LlmError kinds map to slugs.
 */
import { createHash } from "node:crypto";
import type { LlmClient, LlmRequest, LlmUsage } from "./llm-client.js";
import { LlmError } from "./llm-client.js";
import {
  PROMPT_VERSION,
  buildBearPrompts,
  buildBullPrompts,
  buildFundamentalsAnalystPrompts,
  buildNewsAnalystPrompts,
  buildVerdictPrompts,
  type DebateInput,
  type DeepDiveContext,
  type PromptPair,
} from "./prompts.js";
import { VERDICT_SCHEMA_HINT, buildRepairMessage, parseVerdict, type VerdictPayload } from "./verdict.js";
import type { Verdict } from "./index.js";

export type AgentRole = "news-analyst" | "fundamentals-analyst" | "bull" | "bear" | "verdict";

export interface StoredDecision {
  hash: string;
  responseText: string;
}

/** Decision-log port — backed by the AgentDecision table in apps/api. */
export interface DecisionLog {
  lookup(hash: string): Promise<StoredDecision | null>;
  record(entry: {
    hash: string;
    agent: AgentRole;
    model: string;
    promptVersion: string;
    systemPrompt: string;
    userPrompt: string;
    responseText: string;
    usage: LlmUsage | null;
  }): Promise<void>;
}

export interface DeepDiveModels {
  analyst: string;
  debate: string;
  verdict: string;
}

export interface DeepDiveDeps {
  client: LlmClient;
  log: DecisionLog;
  models: DeepDiveModels;
}

export type DeepDiveOutcome =
  | {
      ok: true;
      verdict: Verdict;
      /** Every AgentDecision hash behind this verdict (audit trail). */
      hashes: string[];
      /** Live LLM calls made (cache misses). */
      calls: number;
      cacheHits: number;
    }
  | { ok: false; failure: string; hashes: string[]; calls: number; cacheHits: number };

/** sha256(agent|model|promptVersion|system|user) — the cache key. */
export function decisionHash(agent: AgentRole, model: string, prompts: PromptPair): string {
  return createHash("sha256").update(`${agent}|${model}|${PROMPT_VERSION}|${prompts.system}|${prompts.user}`).digest("hex");
}

const failureSlug = (err: unknown): string => {
  if (err instanceof LlmError) return `llm-${err.kind}${err.status !== undefined ? `-${err.status}` : ""}`;
  return `unexpected:${String((err as Error)?.message ?? err).slice(0, 80)}`;
};

export async function runDeepDive(deps: DeepDiveDeps, ctx: DeepDiveContext, opts: { isEtf: boolean }): Promise<DeepDiveOutcome> {
  const { client, log, models } = deps;
  const hashes: string[] = [];
  let calls = 0;
  let cacheHits = 0;

  /** One role call with cache check; returns the response text. Throws
   *  LlmError on live-call failure (caught by the outer wrapper). */
  async function roleCall(agent: AgentRole, model: string, prompts: PromptPair, extraMessages: { role: "user"; content: string }[] = []): Promise<string> {
    // The cache key covers the FULL request — repair rounds carry an extra
    // user message, so it joins the hash input.
    const hashInput: PromptPair = extraMessages.length
      ? { system: prompts.system, user: `${prompts.user}\n${extraMessages.map((m) => m.content).join("\n")}` }
      : prompts;
    const hash = decisionHash(agent, model, hashInput);
    hashes.push(hash);
    const cached = await log.lookup(hash);
    if (cached) {
      cacheHits++;
      return cached.responseText;
    }
    const req: LlmRequest = {
      model,
      messages: [{ role: "system", content: prompts.system }, { role: "user", content: prompts.user }, ...extraMessages],
      maxTokens: agent === "verdict" ? 1024 : 2048,
    };
    const res = await client.chat(req);
    calls++;
    await log.record({
      hash,
      agent,
      model,
      promptVersion: PROMPT_VERSION,
      systemPrompt: prompts.system,
      userPrompt: hashInput.user,
      responseText: res.content,
      usage: res.usage,
    });
    return res.content;
  }

  try {
    // Analysts in parallel (ETFs skip the fundamentals analyst entirely).
    const analystJobs: [Promise<string>, Promise<string> | null] = [
      roleCall("news-analyst", models.analyst, buildNewsAnalystPrompts(ctx)),
      opts.isEtf ? null : roleCall("fundamentals-analyst", models.analyst, buildFundamentalsAnalystPrompts(ctx)),
    ];
    const [newsAnalysis, fundamentalsAnalysis] = await Promise.all(analystJobs);

    const input: DebateInput = { newsAnalysis: newsAnalysis!, fundamentalsAnalysis: fundamentalsAnalysis ?? null, priorRounds: [] };
    for (let round = 1; round <= 2; round++) {
      const bull = await roleCall("bull", models.debate, buildBullPrompts(ctx, input));
      input.priorRounds.push({ side: "bull", text: bull });
      const bear = await roleCall("bear", models.debate, buildBearPrompts(ctx, input));
      input.priorRounds.push({ side: "bear", text: bear });
    }

    const verdictPrompts = buildVerdictPrompts(ctx, input, VERDICT_SCHEMA_HINT);
    let responseText = await roleCall("verdict", models.verdict, verdictPrompts);
    let parsed = parseVerdict(responseText);
    if (!parsed.ok) {
      // Exactly one repair round (phase-2-plan), then fail the name loudly.
      responseText = await roleCall("verdict", models.verdict, verdictPrompts, [
        { role: "user", content: buildRepairMessage(responseText, parsed.error) },
      ]);
      parsed = parseVerdict(responseText);
      if (!parsed.ok) return { ok: false, failure: `verdict-parse:${parsed.error.slice(0, 120)}`, hashes, calls, cacheHits };
    }
    const payload: VerdictPayload = parsed.verdict;
    const verdict: Verdict = {
      instrumentId: ctx.symbol,
      rating: payload.rating,
      conviction: payload.conviction,
      abstain: payload.abstain,
      thesis: payload.thesis,
      keyRisks: payload.keyRisks,
      invalidationConditions: payload.invalidationConditions,
      asOf: ctx.asOf,
      promptVersion: PROMPT_VERSION,
    };
    return { ok: true, verdict, hashes, calls, cacheHits };
  } catch (err) {
    return { ok: false, failure: failureSlug(err), hashes, calls, cacheHits };
  }
}
