/**
 * packages/agents — LLM layer skeleton (architecture §7).
 * Lean TradingAgents-inspired pipeline lands in Phase 2; this scaffold pins
 * the verdict contract only. The dual Signal representation (5-tier rating +
 * continuous conviction ∈ [-1,1] + explicit abstain) is owned by quant-core
 * and re-exported here so the agent layer shares ONE definition.
 */
export { type Signal, type Rating, CA_DEGRADED } from "@agentic-trading/quant-core";

import type { Rating } from "@agentic-trading/quant-core";

/** Structured verdict emitted by the Bull/Bear debate (Phase 2). */
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
}
