/**
 * packages/agents — LLM deep-dive pipeline (architecture §7, phase-2-plan).
 * Pure: no I/O beyond an injected LlmClient and DecisionLog port, so tests
 * never touch network or db. The dual Signal representation (5-tier rating +
 * continuous conviction ∈ [-1,1] + explicit abstain) is owned by quant-core
 * and re-exported here so the agent layer shares ONE definition.
 */
export { type Signal, type Rating, CA_DEGRADED } from "@agentic-trading/quant-core";

import type { Rating } from "@agentic-trading/quant-core";

/** The model stack a deep-dive ran on — one model per pipeline role. */
export interface DeepDiveModels {
  analyst: string;
  debate: string;
  verdict: string;
}

/** Structured verdict emitted after the bull/bear debate (Phase 2). The
 *  Phase-1 skeleton pinned the core fields; Phase 2 extends the contract
 *  with the data date and prompt version so persisted verdicts stay
 *  comparable across prompt changes (phase-2-plan persistence semantics).
 *  Phase 5 (amendment A6) adds the model stack: promptVersion and models
 *  together identify the treatment, and the sample gate pins both — one
 *  treatment per sample. */
export interface Verdict {
  instrumentId: string;
  rating: Rating;
  /** Continuous conviction in [-1, +1]; kept for Phase 4 backtests. */
  conviction: number;
  /** Abstain ≠ neutral: abstained signals are excluded from blend numerator
   *  AND denominator; a genuine 0.0 conviction is a real neutral vote. */
  abstain: boolean;
  thesis: string;
  keyRisks: string[];
  invalidationConditions: string[];
  /** Data date the verdict was judged against (YYYY-MM-DD). */
  asOf: string;
  /** PROMPT_VERSION in force when the verdict was produced. */
  promptVersion: string;
  /** Model stack the deep-dive ran on (Phase-5 A6: the frozen treatment). */
  models: DeepDiveModels;
}

export * from "./llm-client.js";
export * from "./verdict.js";
export * from "./prompts.js";
export * from "./pipeline.js";
