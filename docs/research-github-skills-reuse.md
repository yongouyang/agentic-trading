# Research: Reusable Skills & Approaches from the Top Trading Repos

**Date:** 2026-08-30 · **Scope:** Hands-on inspection of the actual source trees
of 9 high-star trading repos to answer one question: *which approaches can we
reuse in agentic-trading?* Star counts and file trees pulled live from the
GitHub API on 2026-08-30; `SKILL.md` files and core modules read directly from
`raw.githubusercontent.com`.

Projects surveyed: TradingAgents (102k★), OpenBB (72k★),
daily_stock_analysis (64k★), ai-hedge-fund (63k★), freqtrade (54k★),
Qlib (48k★), ccxt (44k★), Vibe-Trading (32k★), FinceptTerminal (31k★).

---

## 1. TL;DR

- **Only 4 of the 9 ship real Skills.** Vibe-Trading (**90 skills**),
  ccxt (**25 skills**), daily_stock_analysis (1), and FinceptTerminal
  (a *learned* skill library). TradingAgents, ai-hedge-fund, freqtrade, Qlib,
  and OpenBB ship **zero SKILL.md** — but ai-hedge-fund and Vibe-Trading ship
  the best *architecture patterns*, which matter more.
- **Two different meanings of "skill" are in play**, and both are useful:
  1. **Agent Skills** (`SKILL.md` + YAML frontmatter, progressive disclosure) —
     a *packaging* format. Directly reusable in pi today.
  2. **Voyager-style learned skills** (FinceptTerminal) — natural-language
     task recipes distilled from past successes, retrieved by semantic search
     and injected into the planner prompt. An *improvement mechanism*.
- **Vibe-Trading is the single most reusable asset in this space.** MIT
  licensed, covers **HK/US equities with no API key**, and already implements
  the daily-cadence research loop we were about to build. Given
  [architecture-v1](./architecture-v1.md)'s *"Pure TypeScript — no Python
  service"* decision, it is a **knowledge source to mine, not a runtime to
  depend on** (see §15).
- **ai-hedge-fund v2 was quietly rewritten** into the cleanest small quant
  architecture found — 93 files, and nearly every one contains a pattern worth
  stealing (`AlphaModel`, `PromptCache`, fail-closed risk clamps, `FundSpec`
  YAML, CPCV/PBO validation).
- **Top reusable patterns for us (ranked):** skill-packaged trading knowledge,
  the router-skill loaded before any task, unified quant+LLM signal interface,
  triple-purpose prompt cache, "conviction requests, risk disposes",
  abstain-≠-neutral blending, YAML mandates/playbooks-as-data, strategy decay
  state machine, hash-chained governance ledger. **§11 re-tiers all 23 against
  the v1 scope** — most of the risk/execution machinery is Phase 4+, not now.
- **Do NOT copy code from freqtrade (GPL-3.0) or OpenBB/FinceptTerminal
  (non-standard licenses).** Ideas yes, code no. Vibe-Trading, ai-hedge-fund,
  Qlib, ccxt are MIT; TradingAgents is Apache-2.0 — those are safe to vendor.

---

## 2. Skills Inventory: Who Actually Ships Them

| Project | ★ | License | SKILL.md count | Skills location | MCP |
|---|---|---|---|---|---|
| **Vibe-Trading** | 32k | MIT | **90** ✅ | `agent/src/skills/<name>/SKILL.md` | ✅ `vibe-trading-mcp` |
| **ccxt** | 44k | MIT | **24** ✅ | `.claude/skills/` (9 own) + `.agents/skills/` (15 vendored) | ✅ `ccxt-mcp` skill |
| **daily_stock_analysis** | 64k | MIT | 1 ✅ | root `SKILL.md` (wraps Python services) | ❌ |
| **FinceptTerminal** | 31k | ⚠️ custom | runtime-learned | `skill_library.py` (SQLite + FTS5) | ✅ EDGAR MCP |
| ai-hedge-fund | 63k | MIT | 0 | — | ❌ |
| TradingAgents | 102k | Apache-2.0 | 0 | — | ❌ |
| OpenBB | 72k | ⚠️ custom | 0 | — | ✅ extension |
| freqtrade | 54k | ⚠️ GPL-3.0 | 0 | — | ❌ |
| Qlib | 48k | MIT | 0 | — | ❌ |

**Key finding:** high stars ≠ skills. TradingAgents (102k★) has none. The
skills-first projects are the *newest* (Vibe-Trading, ccxt) — this pattern
formed in 2025–26 and the big legacy repos haven't adopted it.

---

## 3. Deep Dive: Vibe-Trading (the richest source)

32k★, MIT, Python, pushed same-day as this research. Its `SKILL.md` manifest
describes the scope: *"backtesting (10 engines + benchmark comparison panel),
factor analysis, Alpha Zoo (462 pre-built alphas across qlib158/alpha101/
gtja191/academic/fundamental), options pricing, 90 finance skills, 30
multi-agent swarm teams, Trade Journal analyzer, Shadow Account… across 25
market-data sources."*

### 3.1 The 90 Skills, Grouped

| Group | Skills | Relevance to us |
|---|---|---|
| **Data sources** | `yfinance` `akshare` `tushare` `eastmoney` `mootdx` `okx-market` `ccxt` `qveris` **`data-routing`** | 🔴 High |
| **HK/China-specific** | **`hk-connect-flow`** `adr-hshare` `ashare-pre-st-filter` | 🔴 High |
| **Technical analysis** | `technical-basic` `candlestick` `chanlun` `elliott-wave` `ichimoku` `harmonic` `smc` `minute-analysis` | 🟡 Medium |
| **Quant research** | `alpha-zoo` `factor-research` `multi-factor` `quant-statistics` `ml-strategy` `correlation-analysis` `correlation-regime` `volatility` | 🔴 High |
| **Asset selection** | **`etf-analysis`** `dividend-analysis` `fund-analysis` `valuation-model` `financial-statement` `fundamental-filter` `convertible-bond` | 🔴 High |
| **Portfolio** | `asset-allocation` `sector-rotation` `pair-trading` `hedging-strategy` `cross-market-strategy` `risk-analysis` | 🔴 High |
| **Execution** | `execution-model` `market-microstructure` `liquidation-heatmap` `perp-funding-basis` | 🟡 Medium |
| **Meta / workflow** | `backtest-diagnose` `strategy-generate` `strategy-discovery` `strategy-dev-manager` `shadow-account` `trade-journal` `thesis-tracker` `report-generate` `research-goal` `research-discipline` `behavioral-finance` | 🔴 Highest |
| **Investor frameworks** | `investor-lenses` (12 lenses) `management-deep-dive` `private-company-research` `deep-company-series` | 🟡 Medium |
| **Events/sentiment** | `earnings-forecast` `earnings-revision` `event-driven` `corporate-events` `sec-edgar` `edgar-sec-filings` `sentiment-analysis` `social-media-intelligence` `regulatory-knowledge` | 🟡 Medium |
| **Macro/geopolitics** | `global-macro` `macro-analysis` `geopolitical-risk` `commodity-analysis` `credit-analysis` | 🟢 Low |
| **Crypto/DeFi** | `crypto-derivatives` `defi-yield` `stablecoin-flow` `onchain-analysis` `token-unlock-treasury` `meme-rush` | 🟢 Low |

### 3.2 Pattern: The Router Skill (`data-routing`)

The most elegant single idea found. `data-routing`'s description says:

> *"The single ROUTER for every data need. Load this skill BEFORE any backtest,
> data-fetch, or research task to pick the best available source/tool, honour
> auth (env) requirements, and avoid ban-risk providers."*

It is a pure lookup table mapping source → markets → auth env key → network
constraint, plus a capability → tool table:

| Source | Markets | Auth | Network |
|---|---|---|---|
| `yfinance` | US, **HK**, Canada stocks, ETFs | No | Needs Yahoo access |
| `akshare` | A-shares, US, **HK**, futures, macro, forex | No | Unrestricted |
| `tencent` | A-shares, **HK**, US (**never-banned**) | No | Unrestricted |
| `futu` | A/**HK**/US via OpenD gateway | OpenD running | Local gateway |
| `longbridge` | **HK**/US OHLCV | App key + token | API |
| `stooq` / `yahoo` / `sina` | US daily OHLCV | No | Various |

And it's **test-enforced** — `tests/test_data_routing_sources_subset.py`
asserts the router table is a strict subset of the registry's `VALID_SOURCES`.
Documentation that cannot drift from code.

**→ Adopt for us:** one `data-routing` skill in our repo naming *our* providers
(AlphaHardBook / yfinance / akshare / futu / longbridge), with a test asserting
the table matches our loader registry. Solves "which source for 0700.HK vs AAPL"
declaratively instead of hard-coded in each module.

### 3.3 Pattern: Scheduled Research Playbooks

`agent/src/scheduled_research/playbooks/*.md` — 13 files. Each is a
**markdown prompt with YAML frontmatter declaring schedule and data needs**:

```yaml
---
name: Portfolio Checkup
description: Periodic risk x-ray of a stated book — exposure, concentration,
  correlation and drawdown, measured from retrieved prices.
markets: [global, cn, hk, us, crypto]
suggested_schedule: "0 9 * * 6"
suggested_timezone: Asia/Shanghai
data_capabilities:
  - Daily price history long enough to compute volatility, correlation and drawdown
  - Portfolio-level risk decomposition — position weights, volatility contribution…
variables:
  holdings: (no holdings provided — the report cannot run without them)
  benchmark: the broad index of the book's home market
  lookback_days: "252"
---
# Portfolio checkup
…
If no holdings are supplied, stop and say so in one line. Do not invent a book,
do not reuse a book from a previous run, and do not fall back to an index as a
stand-in portfolio.
```

Other playbooks: `a-share-money-flow.md`, `earnings-season-tracker.md`,
`institutional-holdings-diff.md`.

**This is exactly our daily pipeline, expressed as data not code.** Note the
anti-hallucination guard baked into the prompt body — a real pattern.

**→ Adopt for us:** our daily cron should iterate over playbook `.md` files in
`playbooks/`, not hard-coded job functions. A new research routine = a new
markdown file, no recompile, no new module.

### 3.4 Pattern: Strategy Decay State Machine

`strategy_store/decay.py` — treats factors/strategies as *living artifacts that
go stale*, with explicit thresholds and consecutive-signal transitions:

```python
ic_ratio_healthy = 0.7      # rolling IC / baseline IC
ic_ratio_warning = 0.5
ic_ratio_decayed = 0.3
ir_healthy = 1.0;  ir_warning = 0.5;  ir_decayed = 0.1
sharpe_healthy = 1.0;  sharpe_warning = 0.5;  sharpe_decayed = 0.0

warnings_for_monitoring = 3   # ACTIVE     → MONITORING
warnings_for_decayed    = 2   # MONITORING → DECAYED
critical_for_disabled   = 3   # DECAYED    → DISABLED
```

`ArtifactStatus` + `DecaySignal` enums; pure logic, separately testable from
the store.

**→ Adopt for us:** this is the missing half of Day 24 (Strategy Portfolio).
We designed capital allocation across strategies but never asked *"when do we
retire one?"* Add `ACTIVE → MONITORING → DECAYED → DISABLED` with Sharpe-based
thresholds and consecutive-run counting.

### 3.5 Pattern: Governance Ledger (hash-chained, fail-closed)

`governance/ledger.py` is a **tamper-evident append-only JSONL ledger**:
each record carries `seq` + `prev_record_hash`, so editing/deleting any earlier
record breaks every subsequent hash. Design notes worth stealing verbatim:

- **Refuse to extend a broken chain** — verifies the ENTIRE chain before
  appending rather than silently building a valid suffix on tampered history.
  O(n) per append, acceptable because the ledger is *low-volume by construction*
  (one record per order/mandate/breach/halt, not per market tick).
- **fsync after every write**, plus fsync the parent directory on file creation
  (the directory entry for a new file isn't durable otherwise).
- `flock` across the read-tail + append section so two writers can't claim the
  same slot — but explicitly noted as *"a liveness optimization against
  accidental forks, not the source of the tamper-evidence guarantee."*

And `live/enforcement.py` — pre-trade mandate enforcement:

> *"Every check is **fail-closed**: any unparseable input, missing market data,
> or ambiguous field denies the order rather than waving it through. Checks run
> in a fixed order — exclude-list → instrument → asset-class → single-order
> notional → total exposure → leverage → daily count → funding
> (defense-in-depth)."*

Breach taxonomy: `universe`/`instrument` violations are **DENIED outright**
("no widening short of editing the mandate could permit it, and the agent may
never edit the mandate"); `quantitative` violations **PAUSE for
re-authorization**. Broker-side funding ceiling stays as the backstop "the
agent physically cannot breach regardless of any data staleness on our side."

**→ Adopt for us:** the ordered-check-list + fail-closed + three-verdict
taxonomy is the template for our risk gate. The agent-may-never-edit-the-mandate
rule is the correct security boundary.

### 3.6 Pattern: Investor Lenses (opinionated & falsifiable)

`investor-lenses` packages 12 named reasoning frameworks. Its framing is the
best articulation of *why* persona agents are useful:

> *"A lens is a **reasoning procedure**: a fixed, ordered set of questions plus
> explicit veto rules… The value of a lens is that it is **opinionated and
> therefore falsifiable**. A lens tells you, before you look at the answer,
> which signals it ranks first and which facts make it walk away. **Two lenses
> disagreeing on the same evidence is the product, not a bug**: the disagreement
> localizes exactly which assumption the decision rests on."*

Plus the discipline rules: *"Freeze the evidence"* before choosing a lens (a
lens applied to evidence gathered after the lens was chosen is circular);
*"Choose by the situation, never by the answer you want"*; hard disqualifiers
**end the run**, they aren't weighed against positives.

**→ Adopt for us:** disagreement-as-signal justifies multiple agents without
needing them to vote to consensus. And "freeze evidence first" is a concrete
guard against motivated reasoning in an LLM.

### 3.7 Other Vibe-Trading modules worth noting

| Module | Files | What it is |
|---|---|---|
| `swarm/` | 39 | **30 YAML team presets** — `etf_allocation_desk`, `risk_committee`, `quant_strategy_desk`, `investment_committee`, `global_allocation_committee`, `factor_research_committee`, `portfolio_review_board`, `technical_analysis_panel`… org charts as config |
| `memory/` | 7 | `compression` `hierarchy` `lifecycle` `semantic_links` `search_index` — the most complete agent memory impl found |
| `hypotheses/registry.py` | 3 | Durable hypothesis lifecycle: `exploring → testing → validated → rejected → monitoring`. Deliberately *"no dependency on LLMs or live trading services"* |
| `goal/` | 5 | `policy` `context` `store` — long-lived objective tracking |
| `strategy_store/` | 7 | Persisted strategies + metrics + decay + SQLite store |
| `shadow_account/` | — | Journal → extract implicit rules → backtest → delta-PnL report |

### 3.8 Direct use vs. reference only

Vibe-Trading *is* `pip install vibe-trading-ai` and ships `vibe-trading-mcp`, so
HK/US market data, 10 backtest engines and the Alpha Zoo are installable today
with zero API keys — and it handles HK commission/cost modelling and
`.TO`/`.NS`/`.HK`/`.L` suffix conventions.

**But architecture-v1 locks "pure TypeScript — no Python service", so we do not
run it.** Treat it as a MIT-licensed *knowledge corpus*: read the 90 skills for
content, copy the good ideas, and reimplement in TS. The one option worth
keeping consciously on the table (see §15.1) is invoking its MCP server
*out-of-band* from pi during research — Python in the agent harness, never in
the shipped pipeline.

---

## 4. Deep Dive: ccxt (best Skills *distribution* engineering)

44k★, MIT, polyglot (JS/TS/Python/PHP/C#/Go/Java). The skills infrastructure is
the most production-grade found, and it's about **distribution and provenance**,
not content.

### 4.1 Multi-Harness via Symlinks

ccxt splits its 24 skills across two locations by **provenance**:

| Location | Count | Contents |
|---|---|---|
| `.claude/skills/` (real dirs) | **9** | ccxt-authored: `ccxt-python` `ccxt-typescript` `ccxt-go` `ccxt-php` `ccxt-csharp` `ccxt-java` `ccxt-cli` `ccxt-mcp` `new-exchange` |
| `.agents/skills/` (real dirs) | **15** | **Vendored third-party**: `binance` `fiat` `p2p` `trading-signal` `query-token-audit` `payment-assistant` `meme-rush` `onchain-pay-open-api` `square-post` … |
| `.claude/skills/` (symlinks) | **15** | `trading-signal -> ../../.agents/skills/trading-signal` etc. |

So `.agents/skills/` is the canonical home for **imported** skills, and
`.claude/skills/` holds ccxt's own — with symlinks bridging the vendored ones
into every harness that only scans `.claude/`. One canonical copy of each
third-party skill, visible to Claude Code, Codex, OpenCode and Gemini CLI.
Critically, **pi loads `~/.agents/skills/` and project `.agents/skills/`
natively** (pi implements the Agent Skills standard), so the vendored set is
already usable with zero conversion.

The repo also ships, simultaneously: `AGENTS.md`, `CLAUDE.md`, `llms.txt`,
`llms-full.txt`, `context7.json`, `mcp/`, `.claude-plugin/marketplace.json`.
Seven parallel discovery surfaces for different agent ecosystems.

### 4.2 Content-Pinned Skill Lock

`skills-lock.json` vendors *third-party* skills (e.g. from
`binance/binance-skills-hub`) with integrity hashes:

```json
"binance": {
  "source": "binance/binance-skills-hub",
  "sourceType": "github",
  "skillPath": "skills/binance/binance/SKILL.md",
  "computedHash": "645f597edf23cbe8a5f014e46c35e98e6a00a464cf39b70e60088b406123d72c"
}
```

This is a `package-lock.json` for prompt content: pinned provenance + drift
detection. Notably it means ccxt doesn't have to maintain Binance-specific
knowledge itself — it *depends on* the exchange's own skill hub, and records
which upstream path + hash it came from.

### 4.3 One Installer, Four Targets

`install-skills.sh` is deliberately **POSIX `sh`** (not bash) with octal-escape
colors, and installs the same skills to:

```
$HOME/.claude/skills   $HOME/.opencode/skills
$HOME/skills (Codex)   $HOME/.gemini/skills
```

with a `curl -fsSL … | sh` one-liner for remote use, and per-language variants
(`ccxt-typescript ccxt-python ccxt-php ccxt-csharp ccxt-go ccxt-cli ccxt-mcp`).

### 4.4 Skill Content Quality

The `ccxt-python` SKILL.md is a good model of skill writing: frontmatter
description enumerates *when to use it* ("…Use when working with crypto
exchanges in Python projects, trading bots, data analysis, or portfolio
management"), then leads with optional performance notes:

```
pip install orjson      # Faster JSON parsing
pip install coincurve   # Faster ECDSA signing (45ms → 0.05ms)
```

…and gives sync/async/WebSocket quick-starts with the footgun called out inline
(`await exchange.close()  # Important!`).

**→ Adopt for us:** `.agents/skills/` for anything we vendor (free pi
compatibility), `.claude/skills/` for our own, and symlinks bridging them. A
lock file with hashes for any vendored upstream skill. Fail-closed
`description` writing that names trigger contexts.

---

## 5. Deep Dive: ai-hedge-fund v2 (best architecture per file)

63k★, MIT, Python — **recently rewritten**; the "AI hedge fund team with
Buffett/Munger personas" is now a 93-file codebase with a genuine quant
skeleton. Every module opens with a docstring stating its *motivation and
tradeoffs*. The highest pattern-density per line of anything surveyed.

### 5.1 One Interface for Quant Signals AND LLM Agents

```
AlphaModel (ABC)
  ├─ QuantModel — pure Python math (PEAD, regime)
  └─ LLMAgent   — LLM reasons over features (Buffett, Graham, …)
```

All produce the same `Signal` — *"a conviction in [-1, +1] + reasoning"*. The
docstring cites Narang's *Inside the Black Box* and states the boundary
explicitly:

> *"The alpha model only forms a **view**. It does NOT decide position mechanics
> (timing, sizing, holding period) — that's the job of portfolio construction
> and execution. This separation (views vs positions) is deliberate."*

and the point-in-time contract: *"MUST be point-in-time: only use data with
date <= date (no lookahead). Return a Signal with conviction in [-1, +1] —
use 0.0 to express 'no view' (abstain)."*

A persona is **only** `name` + `get_system_prompt()`; all machinery
(snapshot building, JSON extraction, caching, abstention) lives in `LLMAgent`.
Graham's prompt ends with a strict JSON schema and *"Treat the most recent
filing date shown as the present day; do not use any knowledge of anything that
happened after it. Do not invent numbers."*

**→ Adopt for us:** this replaces the vague "Strategy produces a Signal" from
Day 19 with a *quantitatively-typed conviction* that lets LLM and rule-based
models be blended by identical arithmetic. Directly implements our
"agents propose, engine disposes" principle.

### 5.2 The Failure Contract (most valuable single idea here)

From `signals/llm_agent.py`:

> *"- Data-layer errors **PROPAGATE** (fail loud — a broken snapshot must never
>    silently become a neutral view).
>  - LLM call/parse failures **ABSTAIN**: `Signal(value=0.0,
>    metadata.abstained=True)`.
>  - Every LLM decision persists its exact prompt + response (via PromptCache),
>    and an unchanged snapshot never pays for a second LLM call."*

and the blending consequence in `portfolio/construction.py`:

> *"An abstained signal is excluded from numerator **AND denominator**: 'no
> opinion' must not masquerade as 'opinion: neutral'. A non-abstained 0.0
> (e.g. PEAD outside its window) is a real neutral vote and dilutes."*

Same philosophy in `data/protocol.py`:

> *"Contract: empty list / None means the data genuinely doesn't exist.
> Infrastructure failures (auth, rate limits, network, server errors) must
> RAISE — a provider that silently returns empty on failure **poisons
> backtests, because missing data is indistinguishable from 'no signal'.**"*

**→ Adopt for us verbatim.** Three-way distinction (real data / genuinely
absent / fetch failed) is the single most common source of silently-wrong
backtests. And `abstain ≠ neutral` changes the blend formula — must be built in
from day one, impossible to retrofit.

### 5.3 PromptCache: One Artifact, Three Jobs

```python
def prompt_key(agent, model, system, user) -> str:
    payload = f"{agent}|{model}|{system}|{user}"
    return hashlib.sha256(payload.encode()).hexdigest()[:24]
```

> *"This is deliberately three things at once: 1. a **cache** — a backtest
> re-running an agent over an unchanged snapshot costs $0; 2. the **persistence
> record** — the EXACT prompt + response behind every Signal, for replay and
> audit; 3. the **debug trail** — failed parses keep the raw response on disk."*

Corrupt cache entry → treated as miss and rewritten, never raises.

**→ Adopt for us:** this is the answer to the LLM non-determinism and cost
problems flagged in [the landscape research](./research-agentic-trading-landscape.md).
Keying on `hash(agent|model|system|user)` also gives **free backtest
determinism**: a full LLM-in-the-loop backtest over 5 years of history costs
money once, then runs forever for free.

### 5.4 Risk: "Conviction Requests, Risk Disposes"

`risk/limits.py`:

> *"portfolio construction proposes target weights, and this stage clamps them
> against the fund's limits. Everything here is **deterministic arithmetic** —
> the LLM's influence over the book ends at the Signal, and no clamp is ever
> negotiable.*
>
> *Exposure removed by a clamp is NOT redistributed to other names; it stays in
> cash. Redistributing would let the risk stage **increase** positions, which
> inverts its job."*

Each clamp emits a `ClampEvent{limit, ticker, before, after}` so *"every clamp
is explainable"*. Ordering makes the clamp pair **idempotent**. Limits are
Pydantic with `extra="forbid"` and `gt=0/le=1.0` constraints.

**→ Adopt for us:** the non-redistribution rule is a subtle correctness insight
we'd likely have gotten wrong. Our risk gate should return `{weights, clamps[]}`,
not `{weights}`.

### 5.5 Mandate as Data: `FundSpec`

```
FUND      = capital slices over STRATEGIES  (master risk on the netted book)
STRATEGY  = a blend policy over MODELS      (a "pod")
MODEL     = an alpha model -> Signal
```

```yaml
# strategies/deep-value.yaml
name: deep-value
display_name: Deep Value
models:
  - name: graham
    weight: 2.0
  - name: buffett
  - name: munger
blend:
  method: conviction_weighted
  gross_target: 1.0
```

> *"Specs are **data**: a mandate is a serializable YAML/JSON config. The
> wizard, a chat LLM, and the strategy generator all emit this same format —
> nothing downstream ever needs to know who authored a fund. …the kind [LLM vs
> quant] is **derived, never declared**."*

One operational note that matters: *"Models are stateful (LLM prompt caches,
PEAD earnings caches), so they must be constructed **per fund — never per
cycle** — for caches to survive across cycles."*

**→ Adopt for us:** a strategy is a YAML file. This is how an LLM agent should
propose new strategies — emit a spec our validator accepts, never emit Python.
Also: our Day-15 "hypothesis to strategy" pipeline terminates in exactly this
artifact.

### 5.6 Overfitting Validation Is Real

`validation/__init__.py`:

> *"v2 validation framework: **Combinatorial Purged Cross-Validation (CPCV)**,
> **Probability of Backtest Overfitting (PBO)**."*

Plus a dedicated `event_study/` package (`engine`, `stats`, `plot`) and
`features/snapshot.py` (`FundamentalsSnapshot`, `InsufficientData`,
`build_snapshot`).

**→ Adopt for us:** Day 23 currently describes naive time-split OOS. CPCV+PBO
(López de Prado) is a materially stronger guard; `event_study/` is the right
tool for our `earnings-revision`-style event signals.

### 5.7 Honest Known Warts

`construction.py` documents its own limitation rather than hiding it:

> *"Known wart, accepted deliberately: the cross-sectional normalization ignores
> **absolute** conviction — a lone weak view would receive the full gross
> target, which the risk stage then clamps. A min-conviction floor is the
> obvious knob once `evaluate()` can measure it."*

**→ Adopt the habit.** Documenting a known flaw + the precondition for fixing
it is better engineering than either pretending it's fine or fixing it
prematurely.

---

## 6. TradingAgents (102k★) — Org Chart as Graph

No skills (Apache-2.0), 179 files, but the reference implementation of the
debate pattern. Its `agents/` tree is the org chart:

```
agents/
├── analysts/     fundamentals · market · news · sentiment · social_media
├── researchers/  bull_researcher · bear_researcher
├── risk_mgmt/    aggressive_debator · conservative_debator · neutral_debator
├── trader/       trader
└── managers/     research_manager · portfolio_manager
```

Two features beyond the org chart:

1. **`graph/market_data_validation_tools.py` + `dataflows/market_data_validator.py`**
   — a *dedicated agent* whose job is validating incoming market data before
   analysts see it. Consistent with ai-hedge-fund's fail-loud principle.
2. **`graph/checkpointer.py` + `reflection.py` + `memory.py`** — resume-long-runs,
   post-trade reflection, decision memory. Also `scripts/smoke_structured_output.py`
   and `agents/schemas.py` → structured (not prose) agent outputs.
3. **`llm_clients/`** — provider abstraction (`anthropic_client.py`, bedrock, etc.),
   plus `default_config.py` for model defaults.

**→ Adopt for us:** the **3-stance risk debator** (aggressive / conservative /
neutral) is cheap and high-value — it stress-tests a position from fixed
adversarial angles instead of one agent self-reviewing. And data-validation as
its own step, not buried in a loader.

---

## 7. freqtrade (54k★) — Strategy API & Leakage Prevention

⚠️ **GPL-3.0** — read for ideas, do not vendor code.

`IStrategy(ABC, HyperStrategyMixin)` is the most-evolved strategy interface in
OSS trading. Mechanisms worth knowing about:

| Mechanism | Purpose |
|---|---|
| `StrategyResultValidator` | validates strategy output shape |
| `remove_entry_exit_signals` | **strips leakage columns before backtest** |
| `strategy_safe_wrapper` | wraps user hooks so a user bug can't crash the bot |
| `PairLocks` | temporary per-instrument trading bans (risk/ops control) |
| `@informative` decorator + `InformativeCache` | multi-timeframe data without recomputation |
| `minimal_roi` / `stoploss` / `timeframe` as class attrs | hyperoptable params declared as data |
| `CUSTOM_TAG_MAX_LENGTH` | bounded user tags |

**→ Adopt for us:** `remove_entry_exit_signals` is the concrete leakage fix for
our Day 18–19 indicator→signal chain (make columns named `enter_long`/`exit_long`
*invisible* to downstream code). `PairLocks` maps to a HK-specific need:
halt a single symbol after a bad fill without stopping the whole system.
`@informative` caching matters the moment we want weekly trend context on daily
bars.

---

## 8. Qlib (48k★) — Experiment Lineage

MIT. `qlib/` splits `data · model · strategy · backtest · rl · contrib ·
workflow`. The distinctive piece is `workflow/`: an `Experiment → Recorder`
hierarchy deliberately rejecting raw MLflow:

> *"(weak) Allow diverse backend support… we have **record** object with a lot
> of methods (more intuitive), instead of use run_id everytime… Logging **code
> diff** at the start of run. `log_object` and `load_object` for Python object
> directly."*

Unusually candid for OSS — it even lists the cost: *"To be honest, design always
add burdens. For example, You need to create an experiment before you can get a
recorder."*

**→ Adopt for us:** **log the code diff with every backtest run.** Cheap, and it
makes "this Sharpe came from that version of the strategy" answerable
indefinitely. Qlib's Alpha158/360 feature handlers are also the source of the
`qlib158` zoo that Vibe-Trading ships 158 alphas from.

---

## 9. OpenBB (72k★) & FinceptTerminal (31k★)

**OpenBB** — ⚠️ `NOASSERTION` license. No SKILL.md; ships
`openbb_platform/extensions/mcp_server/` and a `cookiecutter/` for building
data extensions. Its strategic signal (already noted in the landscape doc) is
that it now positions itself as *"Open Data Platform for analysts, quants **and
AI agents**"* — i.e. it wants to be the data layer agents call. Useful as a
provider; the license rules out copying.

**FinceptTerminal** — ⚠️ `NOASSERTION`. The one genuinely different idea:
`skill_library.py` implements a **Voyager-style learned skill library**:

> *"SkillLibrary — persistent store of reusable task recipes (Voyager-style).
> Each 'skill' is a **natural-language recipe distilled from a successfully
> completed task** — name, description, and ordered steps. At plan time the
> runner does a top-K semantic search and injects matching skills into the
> planner prompt so common patterns get reused instead of re-decomposed.*
>
> *Storage: same SQLite file as agent_tasks. **FTS5** if available (fast,
> ranked); falls back to LIKE-based search.*"*

Recipe schema: `{version, preconditions, steps: [{name, query}], expected_outputs}`,
plus `success_count` and `last_used_at` for ranking. Also ships an EDGAR MCP
server and its own `rdagents/mcp_server.py`.

**→ Adopt for us:** the hand-written-skills + learned-skills **hybrid**. Our 90
curated skills give breadth at authoring time; a `skill_library` table lets the
agent deposit its own proven recipes and retrieve them by FTS5 at plan time.
FTS5-with-LIKE-fallback over SQLite is the right cost profile for a Mac Mini —
no vector DB required.

---

## 10. daily_stock_analysis (64k★) — Skill as Thin Wrapper

The simplest skills pattern: one root `SKILL.md` (`name: stock_analyzer`) that
documents *existing* service functions and points at their source
([`analyze_stock`](src/services/analyzer_service.py)). It makes an existing
Python service invocable by an agent without changing the service.

Its most valuable content is the **output contract** — a fixed 4-section
decision dashboard:

| Section | Contents |
|---|---|
| `core_conclusion` | one-line summary, signal type, position advice |
| `data_perspective` | trend state, price position, volume, chip structure |
| `intelligence` | news, risk alerts, positive catalysts |
| `battle_plan` | **sniper points** (buy/sell targets), position strategy, risk checklist |

Note the skill's own docstring warns: *"如果未提供 config 对象，函数将自动使用从
.env 文件加载的全局单例实例"* — implicit global config, a coupling we should not
copy.

**→ Adopt for us:** the 4-section **daily report contract**. A fixed schema makes
day-over-day reports diffable and makes "the report changed shape" a testable
failure. `battle_plan` (entry/exit levels + size + risk checklist) is what turns
analysis into something actionable.

---

## 11. Consolidated Reuse Catalog

Ranked by value to *our* NestJS / Mac Mini / daily / HK+US context.

| # | Pattern | Source | Effort | Why it's worth it |
|---|---|---|---|---|
| 1 | **Failure contract: raise vs empty vs abstain** | ai-hedge-fund | S | Prevents silently-poisoned backtests; un-retrofittable later |
| 2 | **`abstain ≠ neutral` in signal blending** | ai-hedge-fund | S | Excluded from numerator *and* denominator |
| 3 | **`AlphaModel` → `Signal(conviction ∈ [-1,1], reasoning)`** | ai-hedge-fund | M | One arithmetic for LLM + rule-based views |
| 4 | **PromptCache (cache + audit + debug)** | ai-hedge-fund | S | $0 backtest reruns; LLM decisions replayable |
| 5 | **Clamp-based risk gate + `ClampEvent` trail, no redistribution** | ai-hedge-fund | M | Correct, explainable, idempotent risk layer |
| 6 | **Strategy/mandate as YAML spec, validated** | ai-hedge-fund | M | Agents emit *data*, never code |
| 7 | **`.agents/skills/` for vendored + symlinks into `.claude/skills/`** | ccxt | S | Free compat with pi, Claude Code, Codex, Gemini; provenance split |
| 8 | **Router skill loaded before any task** | Vibe-Trading | S | Declarative data-source selection, test-enforced |
| 9 | **Playbooks as markdown + cron frontmatter** | Vibe-Trading | M | New daily routine = new `.md`, no code |
| 10 | **Strategy decay state machine** | Vibe-Trading | M | Answers "when do we retire a strategy?" |
| 11 | **Fail-closed ordered mandate checks** | Vibe-Trading | M | Agent can never edit the mandate |
| 12 | **4-section report contract** | daily_stock_analysis | S | Diffable daily output; actionable `battle_plan` |
| 13 | **Anti-hallucination guards in prompts** | both | S | "Do not invent a book… stop and say so in one line" |
| 14 | **`skills-lock.json` with content hashes** | ccxt | S | Vendored skills with provenance + drift detection |
| 15 | **Investor lenses: disagreement is the product** | Vibe-Trading | M | Multi-agent value without false consensus |
| 16 | **Log code diff per backtest run** | Qlib | S | Answers "which version produced this Sharpe" |
| 17 | **CPCV + PBO overfitting validation** | ai-hedge-fund | L | Materially stronger than naive time split |
| 18 | **Voyager learned-skill library (SQLite FTS5)** | FinceptTerminal | L | Agent self-improves; no vector DB needed |
| 19 | **3-stance adversarial risk debators** | TradingAgents | M | Cheap structured self-critique |
| 20 | **Leakage: strip signal columns post-compute** | freqtrade (idea) | S | Removes the #1 backtest cheat |
| 21 | **Pair-level locks (kill one symbol)** | freqtrade (idea) | S | Surgical ops control |
| 22 | **Hash-chained governance ledger** | Vibe-Trading | L | Tamper-evident live-order record |
| 23 | **Shadow Account loop** (journal→rules→backtest→delta) | Vibe-Trading | L | Personalized alpha from own behavior |

---

## 12. Concrete Adoption Plan

### Phase 0 — Mine the knowledge layer (this week, ~0 effort)

Constrained by architecture-v1's **no-Python-service** rule (see §15), this is
*read-only* reuse — no `pip install`, no Python dependency in our tree:

1. Clone Vibe-Trading and ccxt **for reference** (both MIT) and read their
   skills as documentation. Highest-value for our three market lanes:
   `etf-analysis`, `dividend-analysis`, `hk-connect-flow`, `adr-hshare`,
   `technical-basic`, `quant-statistics`, `risk-analysis`, `backtest-diagnose`,
   `research-discipline`.
2. Optionally load them into pi as *skills only* (`~/.pi/settings.json` →
   `"skills": ["~/vendor/Vibe-Trading/agent/src/skills", "~/.agents/skills"]`).
   Reading markdown through pi executes no Python — compatible with the
   no-Python decision, and it lets us evaluate our own skill-writing against a
   mature 90-skill corpus.
3. Their HK cost/commission modelling and `.TO`/`.NS`/`.HK`/`.L` suffix
   conventions inform our own universe normalization (§6 of architecture-v1).

### Phase 1 — Our own skills (small, high leverage)

Create `.agents/skills/` in this repo, one `SKILL.md` each, names
lowercase-hyphen ≤64 chars, specific `description` naming trigger contexts:

| Skill | Content |
|---|---|
| `data-routing` | our providers → markets → env keys, with a test asserting it matches our loader registry |
| `mandate` | our hard portfolio limits + the fail-closed ordered check list |
| `hk-tax-treatment` | condensed from our tax doc: 0% CG, 30% US div WHT, Irish ETFs, estate-tax situs |
| `backtest-diagnose` | our own error taxonomy (zero trades / late first trade / low capital utilization / open at end) |
| `signal-authoring` | the `AlphaModel` contract, point-in-time rule, abstain semantics |
| `data-quality-gate` | the Day-17 7-category checklist **and its failure taxonomy** (§15.2) |
| `universe-lanes` | the three lanes' differing rules: full debate (US/HK) vs weekly allocation review (Irish UCITS, no debate tokens) |

`hk-tax-treatment` and `universe-lanes` are the two skills **no** surveyed repo
has — our differentiators, and exactly what architecture-v1's lane design needs
expressible as retrievable knowledge rather than prompt bloat.

### Phase 2 — Architecture modules (NestJS, v1 scope = stock picker)

| Our module | Adopted pattern |
|---|---|
| `quant-core` signals | `AlphaModel` ABC → `Signal{conviction, reasoning, abstained}` (#3, #2) |
| `market-data/` | three-way error contract: raise / genuinely-empty / fetch-failed (#1) |
| `market-data/` | strip signal columns before downstream sees them (#20) |
| `agents/` | prompt cache keyed `hash(agent\|model\|system\|user)`; prompt-injected discipline guards (#4, #13) |
| `agents/` | 5-tier structured verdict; data-validation as its own step (#19) |
| `scheduler/` | iterate `playbooks/*.md`; `{{variables}}`; frontmatter cron + timezone — **two schedules** (16:45 HK / 06:00 HKT) + weekly Irish-lane (#9) |
| `api/report` | fixed 4-section daily report schema (#12) |

### Phase 4+ — Defer (backtest and risk layers are explicitly out of v1)

| Pattern | When it becomes due |
|---|---|
| Deterministic clamp risk gate + `ClampEvent` trail (#5) | first time anything proposes *weights* rather than a ranking |
| Fail-closed ordered mandate checks (#11) | first broker order (Futu/IBKR integration) |
| Strategy decay state machine (#10) | Phase 4, when screening rules become tracked artifacts |
| CPCV + PBO overfitting validation (#17) | Phase 4 — architecture-v1 already commits to backtesting the screen |
| `FundSpec` YAML mandate (#6) | when we move from watchlist → allocation |
| Hash-chained governance ledger (#22) | the day we go paper→live, not before |
| Agent-editable-playbook / learned-skill FTS5 library (#18) | after the curated skills prove their worth |
| Shadow Account loop (#23) | once we have a real Futu/IBKR trade journal to ingest |

---

## 13. What NOT to Copy

| Anti-pattern | Where | Why avoid |
|---|---|---|
| Vendoring freqtrade code | GPL-3.0 | Viral; study the design only |
| Vendoring OpenBB / Fincept code | `NOASSERTION` / custom | Unusable until checked |
| Single-shot LLM-as-sole-decision-maker | naive demos | ai-hedge-fund splits view → blend → clamp; the split *is* the safety |
| Persona "wisdom of crowds" for sizing | persona-heavy repos | Personas form views; arithmetic sizes them |
| Implicit global config singleton | daily_stock_analysis | Pass config explicitly; hidden global state defeats tests |
| Agent-editable mandate | — | Vibe-Trading: *"the agent may never edit the mandate"* |
| 90 skills at v1 | Vibe-Trading's maturity | Start with 5; each skill needs maintenance and competes for description-token budget |
| Redis-backed queues for a daily 30–90s job | freqtrade/Vibe-Trading infra | `@nestjs/schedule` on a cron is enough for one Mac Mini |

---

## 14. Bottom Line

The three reusable layers, in descending order of immediate value:

1. **Contracts and boundaries** (ai-hedge-fund, Vibe-Trading enforcement) —
   the failure taxonomy, abstain semantics, clamp-not-redistribute,
   agent-cannot-edit-mandate. Small to write, expensive to retrofit, and the
   difference between a system you trust with real money and one you don't.
2. **Skills as the knowledge-packaging format** (ccxt, Vibe-Trading) —
   `.agents/skills/` + router skill + playbooks. Cheap, cross-harness, and the
   mechanism by which domain knowledge (HK Connect flow, ETF selection, our own
   tax treatment) reaches the agent exactly when needed rather than bloating
   every prompt.
3. **Domain content already written for our exact markets** (Vibe-Trading's
   HK/ETF/dividend skills, under MIT) — the fastest path to good skill prose
   for the lanes architecture-v1 defines.

The biggest single realization: **we do not need to author trading domain
knowledge from scratch.** Vibe-Trading ships 90 MIT-licensed skills including
HK-specific `hk-connect-flow`, `etf-analysis` and `dividend-analysis` —
directly readable as reference prose for our own skill writing. Our
differentiated build remains what the landscape doc identified — *our*
seven-module core, *our* risk gate, *our* HK tax-aware lane logic — with
external skill *content* as source material, not as a runtime dependency.

---

## 15. Reconciliation with `architecture-v1.md`

This audit ran *after* the v1 design was agreed, so the two must be squared up.
Three items need explicit resolution.

### 15.1 No Python service — supersedes my "use Vibe-Trading as a backend"

architecture-v1 locks **"Pure TypeScript. No Python service"** and names
`yahoo-finance2` as primary with Alpha Vantage fallback. So the earlier
"register `vibe-trading-mcp`" idea is **withdrawn** — Phase 0 above is now
read-only reference mining, which keeps the no-Python guarantee intact.

What survives unchanged: the skills *format*, the pattern catalog, and reading
MIT skill prose. Vibe-Trading's `data-routing` table remains valuable as a
**design template**, though our own version lists only
`yahoo-finance2 · alpha-vantage · (later) futu-openapi · ibkr`.

One option to decide consciously: the two-tier reuse — pure-TS for our pipeline,
Vibe-Trading's MCP available *out-of-band* for ad-hoc research queries from pi
— doesn't actually violate the no-Python rule, since the Python runtime would
sit in the agent harness, never in the shipped pipeline. Worth keeping on the
table if HK small-cap data quality (architecture-v1's stated Phase 0 weakness)
forces us to want `akshare`/`tencent`/`mootdx` fallbacks we'd rather not
reimplement in TS.

### 15.2 ⚠️ Real conflict: "silently excluded" contradicts the #1 finding

architecture-v1 §4 says:

> *"**A ticker failing checks is silently excluded from screening** — never
> traded on bad data."*

The single most repeated insight across this audit says the *silent* part is
the bug. From ai-hedge-fund's `data/protocol.py`:

> *"Infrastructure failures (auth, rate limits, network, server errors) must
> RAISE — a provider that **silently returns empty on failure poisons
> backtests, because missing data is indistinguishable from 'no signal'."***

And Vibe-Trading's playbook bodies enforce the same instinct — *"If no holdings
are supplied, stop and say so in one line. Do not invent a book."*

**Proposed amendment** — keep the exclusion (correct call: never screen on bad
data), but make it *loud, typed, and reported*:

| Today's plan | Proposed |
|---|---|
| `excluded_tickers = [t for t in universe if checks_pass(t)]` | classify each failure first |

Three-way taxonomy, applied *after* the Day-17 checks:

```typescript
enum DataOutcome {
  OK,               // clean → eligible for screening
  GENUINELY_ABSENT, // delisted, halted all-day, no such symbol →
                    //   exclude, log at info, no alarm
  FETCH_FAILED,     // 429, timeout, 5xx, schema break → exclude from
                    //   TODAY's screen, alert loudly, retry next run
}
```

`FETCH_FAILED` must **never** look like "this ticker has no opportunity." With
~800 tickers and a Yahoo-fallback-only stack, a silent rate-limit batch could
otherwise gut the HK lane while the report reads as a clean, normal run — and
architecture-v1 already flags HK data quality as its known weakness. The daily
report should lead with a data-integrity header (e.g. *"782/800 screened; 11
Yahoo 429s retried; 7 halted; 3 excluded for bad adjustments — HK lane 4% thin
this run"*) and the run should be marked **degraded**, not successful.

### 15.3 Scope correction: v1 is a picker, so most risk machinery is deferred

architecture-v1 §9 puts the backtest engine, portfolio tracking and broker
execution **out of v1**. Several of my highest-ranked patterns (mandate
enforcement, risk clamps, decay state machine, governance ledger, CPCV/PBO)
target those layers. They stay in the catalog but move to **Phase 4+** —
see the re-tiered table in §12.

Two corrections this implies for earlier estimates in
[the NestJS comparison](./research-nestjs-vs-go-platform-choice.md):

- Universe is **~800 tickers**, not the 50–200 assumed there. Still trivially
  fast: 800 × 1,260 daily bars × ~10 incremental indicators is well under a
  second with Day-18 O(1) sliding windows — the conclusion (Node.js is plenty
  for daily batch) is unchanged, and the 20–30 deep-dive LLM calls remain the
  dominant cost by far.
- Two runs/day (16:45 + 06:00 HKT) rather than one — still ~99.9% idle.

### 15.4 Where the audit *strengthens* the v1 design

| v1 decision | Independent validation found |
|---|---|
| "Agents propose, quant core disposes" | ai-hedge-fund's views-vs-positions split; Vibe-Trading's "LLM's influence over the book ends at the Signal" |
| Structured JSON outputs for every agent | ai-hedge-fund's `_SIGNAL_TO_SIGN` + `extract_json`; TradingAgents' `schemas.py` + `smoke_structured_output.py` |
| Persisted decision log | **Upgrade available:** key it by `hash(agent\|model\|system\|user)` and the same artifact gives audit *and* $0 reruns (§5.3) — architecture-v1's decision log gets the caching for free |
| TradingAgents pattern reimplemented, not reused | matches this audit's license findings (v0.3.x is Apache-2.0, so reuse was *permitted* — but pattern-not-code is still right for a TS codebase) |
| Separate, weekly, debate-free Irish UCITS lane | Vibe-Trading's `etf-analysis` treats ETF selection as allocation, not stock debate — same conclusion, reached independently |
| Kimi/OpenAI-compatible provider swap | ai-hedge-fund `llm/registry.py` + `make_llm()`; TradingAgents `llm_clients/` — provider abstraction is standard |
| Phase 4 will backtest the screen | ai-hedge-fund ships CPCV + PBO — the specific stronger methods to reach for, beyond Day 23's naive split |

The **5-tier rating** architecture-v1 chose for verdicts also happens to match
TradingAgents' `agents/utils/rating.py`, so that maps cleanly. But note the
tension worth deciding: a 5-tier ordinal rating and ai-hedge-fund's
`conviction ∈ [-1, +1]` are different representational choices. Recommend
storing **both** — the human-facing 5-tier rating for the UI/report, and a
continuous conviction alongside it, so Phase 4 can backtest the signal without
losing resolution to bucketing.

---

## References

- [Vibe-Trading skills tree](https://github.com/HKUDS/Vibe-Trading/tree/main/agent/src/skills)
- [ccxt skills + installer](https://github.com/ccxt/ccxt/blob/master/install-skills.sh)
- [ai-hedge-fund v2 (`hedge_fund/`)](https://github.com/virattt/ai-hedge-fund/tree/main/hedge_fund) · [VISION.md](https://github.com/virattt/ai-hedge-fund/blob/main/VISION.md) · [ROADMAP.md](https://github.com/virattt/ai-hedge-fund/blob/main/ROADMAP.md)
- [TradingAgents agents tree](https://github.com/TauricResearch/TradingAgents/tree/main/tradingagents/agents)
- [daily_stock_analysis SKILL.md](https://github.com/ZhuLinsen/daily_stock_analysis/blob/main/SKILL.md)
- [FinceptTerminal skill_library.py](https://github.com/Fincept-Corporation/FinceptTerminal/blob/main/fincept-qt/scripts/agents/finagent_core/agentic/skill_library.py)
- [freqtrade IStrategy](https://github.com/freqtrade/freqtrade/blob/develop/freqtrade/strategy/interface.py)
- [Qlib workflow module](https://github.com/microsoft/qlib/tree/main/qlib/workflow)
- [Agent Skills standard](https://agentskills.io/specification) · Pi skills doc
  (`/Users/yongouyang/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs/skills.md`)
- Related: [Architecture v1](./architecture-v1.md) (**agreed design — this
  document is reconciled against it in §15**) ·
  [Landscape research](./research-agentic-trading-landscape.md) ·
  [Language choice](./research-quant-library-language-choice.md) ·
  [NestJS vs Go](./research-nestjs-vs-go-platform-choice.md) ·
  [HK/US tax comparison](./tax-comparison-hk-us-stocks-etfs.md)
