# @agentic-trading/agents

LLM layer — lean TradingAgents-inspired pipeline (architecture-v1 §7).
Phase 2 scope: News/Sentiment + Fundamentals analysts → Bull vs Bear debate →
structured `Verdict` (dual signal: 5-tier rating + conviction ∈ [-1,1] +
explicit abstain, imported from `@agentic-trading/quant-core`).
Provider-agnostic OpenAI-compatible client via `LLM_ANALYST_MODEL` /
`LLM_DEBATE_MODEL` / `LLM_VERDICT_MODEL`. No LLM code yet — skeleton only.
