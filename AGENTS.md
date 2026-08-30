# AGENTS.md — agentic-trading

Guidelines for AI agents working in this repository.

## Project

Agentic trading platform for personal investing. v1 is a stock picker
(daily screen → LLM deep-dive → ranked watchlist); the user trades manually.
The authoritative design is `docs/architecture-v1.md`; session history is in
`PROGRESS.md` (newest entries on top — update it after every work session).

## Model usage policy (all harnesses)

Two working modes, two model tiers — the pattern is the same regardless of
harness: **deep tier** for thinking work, **fast tier** for execution work.
The agent cannot switch its own model mid-session — when the phase changes,
the agent must **tell the user to switch** and state which model/effort.

| Harness | Deep tier (high thinking) | Fast tier (low thinking) |
|---|---|---|
| Kimi Code CLI | `k3` | `k3-256k` (same model, 256K window, ~half quota — no quality drop) |
| pi harness | `qwen3.8 max` ⚠️ | `qwen3.8 flash` ⚠️ |

⚠️ Qwen model IDs as specified by the user — verify exact IDs against the pi
harness model catalog. Note: max/flash are *different models*, so the fast
tier has a real quality step-down (unlike k3/k3-256k); escalate back to the
deep tier readily when implementation surfaces unexpected ambiguity.

Phase mapping:

| Phase | Tier | Why |
|---|---|---|
| Design, architecture, implementation planning, analysis, strategy/research discussions, ambiguous decision points | Deep + high thinking | Quality matters more than cost here |
| Pure implementation with decisions already agreed (scaffolding, modules, tests, doc extraction, mechanical refactors) | Fast + low thinking | Execution, not deliberation — cheaper and faster |

Rules:

- **Default to the fast tier + low thinking** whenever a task's decisions are
  already recorded in `docs/architecture-v1.md` or an agreed plan.
- **Escalate to the deep tier + high thinking** when hitting a genuine design
  fork, a cross-cutting analysis, unexpected ambiguity mid-implementation, or
  anything that changes agreed decisions. Say so explicitly and ask the user
  to switch.
- If a task mixes both (e.g. plan then build), finish the planning discussion
  first, then prompt the switch before writing code.
