# PROGRESS

Session log for the agentic-trading project. Newest entries on top.
Each entry: what was done, key decisions, and what's next.

---

## 2026-08-30 — Landscape research: existing agentic trading platforms (web + GitHub)

### What was done
- Ran a web + GitHub survey (GitHub API star counts fetched live) of platforms
  similar to our goal; compiled into
  `docs/research-agentic-trading-landscape.md`.
- Landscape splits into four layers: (A) multi-agent LLM decision frameworks
  — TradingAgents (~102k★), ai-hedge-fund (~63k★), TradingAgents-CN (~31k★);
  (B) agent-native trading harnesses — HKUDS Vibe-Trading (~32k★, shadow
  account), HKUDS AI-Trader (~22k★), LangAlpha ("Claude Code for markets");
  (C) classic engines — OpenBB, freqtrade, Lean, Hummingbot, Qlib (+RD-Agent),
  FinRL; (D) agent-to-market infra — Alpaca MCP, financial-datasets MCP,
  Kraken CLI.
- Academic layer is thin: TradingAgents paper (arXiv 2412.20138), FinMem
  (layered memory), early 2026 benchmarks (AlphaForgeBench, FinPersona-Bench);
  recurring warning across sources is backtest overfitting + no accepted
  live-trading benchmark.

### Key decisions
- **Gap identified**: no OSS project combines LLM agents + a trusted quant core
  (our seven modules) + hard non-LLM risk gates + paper→live broker path for
  personal investing — that is our defensible build target.
- Patterns to adopt: agents-proposes/engine-disposes risk gate, shadow (paper)
  account before live, MCP as the broker/data seam, persistent research
  workspace.
- All major decision-layer projects are "educational only" — code reuse needs
  license checks (TradingAgents-CN is hybrid-licensed; clones/scams exist).

### What's next (proposed)
1. Decide first market/broker target (Alpaca paper trading is the obvious
   default) and agent decision frequency.
2. Decide: reuse an engine (Lean/freqtrade) as backtest backend vs. grow our
   own seven-module core from `docs/quant-system-architecture.html`.
3. Skim-read candidates: TradingAgents paper, FinMem, RD-Agent; track
   `LLMQuant/awesome-trading-agents` for new entrants.

---

## 2026-08-30 — Day 6 knowledge extraction → architecture doc

### What was done
- Read all 8 pages of `knowledge-base/day_6/` (page_1.JPG – page_8.JPG), a Chinese
  course series "30天学习量化投资 · Day 6: 量化系统架构" covering the core
  components of a quant trading system.
- Created `docs/quant-system-architecture.html` — a self-contained (no external
  dependencies) HTML architecture document distilling the slides into the
  initial building blocks  of this project:
  1. Why modularize (monolith vs. modular)
  2. System overview: 7 core modules + backtest collaboration loop diagram
  3. Module specifications: responsibilities, I/O contracts, worked examples
     (OHLCV bars, MA5 calc, MA golden-cross strategy, AAPL fill math with
     fees/slippage, risk-rule table)
  4. Core design principles: four roles (Strategy / Risk / Broker / Portfolio),
     low coupling via stable interfaces, DIP, anti-patterns with code examples
  5. Proposed repository skeleton + inter-module data contracts table
  6. Practice roadmap (Bollinger Band breakout-sell scenario)
- Verified rendering with headless Chrome screenshots; fixed a CSS bug
  (`.tree` block missing `white-space: pre`) found during verification;
  removed the temporary screenshots afterward.

### Key decisions
- **HTML over Markdown** for the architecture doc: the content is diagram-heavy
  (module map, flow diagrams, comparison panels), and a single self-contained
  HTML file renders them better than md.
- **Seven top-level modules** adopted as the project skeleton:
  `data/`, `indicator/`, `strategy/`, `risk/`, `broker/`, `portfolio/`, `backtest/`.
- **Interface-first design (DIP)**: modules collaborate through stable
  interfaces, not direct calls. The `Strategy` interface sketch is kept in the
  slides' Go-style syntax, but the implementation language is **not decided yet**
  — the repo currently has no code, only docs and knowledge base.
- **Key domain rule recorded**: the fill report (成交回报) is the only source of
  truth for account state; Strategy never mutates Portfolio directly.
- Doc written in English (user's working language) with original Chinese terms
  annotated where they carry specific meaning.

### What's next (suggested, from Day 6 practice roadmap)
1. `indicator/` — implement Bollinger Bands BB(20,2).
2. `strategy/` — emit sell signal when close breaks above the upper band.
3. `portfolio/` / `broker/` — insufficient-balance / insufficient-position checks.
4. `backtest/` — run one simple strategy end-to-end and produce a report
   (annual return, max drawdown, Sharpe, win rate, profit factor, # trades).
5. Decide the implementation language before writing the first module.
