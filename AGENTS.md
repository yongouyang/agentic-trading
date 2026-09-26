# AGENTS.md — agentic-trading

Guidelines for AI agents working in this repository.

## Project

Agentic trading platform for personal investing. v1 is a stock picker
(daily screen → LLM deep-dive → ranked watchlist); the user trades manually.
The authoritative design is `docs/architecture-v1.md`; session history is in
`PROGRESS.md` (newest entries on top — update it after every work session).

## Scripts and scratch files

**Session and analysis scripts live under `./scripts/<area>/` and are tracked in
git.** Existing areas: `scripts/futu/`, `scripts/databento/`, `scripts/launchd/`,
`scripts/tests/`. Currently 52/52 files under `scripts/` are tracked — keep it
that way, and commit the script in the same session that wrote it.

The rule exists because of a real failure: the 2026-09-25 session wrote five
near-duplicate probe scripts as untracked scratch, and by the time the gap was
noticed they had been deleted — so that session's method survives only in
`SKILL.md` and gitignored `logs/`. A script written to `/tmp` is gone; an
untracked script in a package root is worse, it shows up in `git status` forever
or escapes the ignore rules entirely (the `apps/reports/` incident).

- **Where a script goes:** `./scripts/<area>/` for session/analysis/ops
  scripts. Product CLIs stay in `apps/api/src/cli/` with a `package.json`
  script — those are product code, not scratch. `apps/api/scripts/` holds the
  pre-existing alpha-bridge analysis; new session scripts do not go there.
- **Extend, don't duplicate.** One script that takes flags beats five probes
  that each hardcode a symbol list. If an area already has a script that covers
  the job, add a flag to it.
- **Tracked or deliberately deleted — never dangling.** If a script was truly
  throwaway, delete it in the same session that wrote it and record the finding
  in `PROGRESS.md`. Leaving it untracked is the outcome this rule prevents.
- **Never write session scripts to `/tmp`, the repo root, or a package root.**
  `spike/` is gitignored scratch by design — do not add new material there.
- **Check:** `git ls-files --others --exclude-standard scripts/` must print
  nothing.

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
