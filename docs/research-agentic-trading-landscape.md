# Landscape Research: Agentic Trading Platforms & Frameworks

**Date:** 2026-08-30 · **Scope:** Web + GitHub survey of existing platforms similar to
our goal (an agentic trading platform for personal investment). Star counts pulled
live from the GitHub API on 2026-08-30.

---

## 1. TL;DR

- This space exploded in the last ~18 months. There is **no single dominant
  open-source "agentic trading platform" for personal investors** — instead the
  landscape splits into four layers, and most projects live in only one of them:
  1. **LLM decision-making frameworks** (multi-agent analysis/debate) — e.g.
     TradingAgents, ai-hedge-fund
  2. **Agent-native trading harnesses** (agents + shadow/paper accounts + UI) —
     e.g. Vibe-Trading, AI-Trader, LangAlpha
  3. **Classic execution/backtest engines** (mature, no LLM) — e.g. Lean,
     freqtrade, Hummingbot, Qlib
  4. **Agent-to-market infrastructure** (MCP servers, broker CLIs) — e.g.
     Alpaca MCP, financial-datasets MCP, Kraken CLI
- The most-starred agentic projects are [TradingAgents](https://github.com/TauricResearch/TradingAgents)
  (~102k★), [OpenBB](https://github.com/OpenBB-finance/OpenBB) (~72k★, rebranded
  itself as a data platform "for analysts, quants **and AI agents**"),
  [ai-hedge-fund](https://github.com/virattt/ai-hedge-fund) (~63k★),
  [freqtrade](https://github.com/freqtrade/freqtrade) (~54k★), and
  [Qlib](https://github.com/microsoft/qlib) (~48k★).
- **Nearly every serious project carries an explicit "educational only, not real
  trading" disclaimer.** Almost none close the loop LLM-decision → risk-checked →
  broker execution with a trustworthy backtest. That loop is the gap our project
  sits in — and the risk layer is where the difficulty hides.
- Academic validation is thin: reported Sharpe improvements (e.g. TradingAgents
  paper) are on narrow backtest windows, and independent commentary
  ([The Bell](https://thebell.io/mnimoe-prevoskhodstvo-pochemu-torgovye-ii-proigryvayut-prosteyshey-strategii))
  notes many trading LLMs lose to trivial baselines. Treat all backtest claims
  with skepticism (overfitting is the #1 failure mode —
  [Wisdom Trading](https://wisdomtrading.com/insights/ai-overfitting-trading-systems/),
  [Economic Times](https://m.economictimes.com/wealth/invest/using-chatgpt-for-stock-trades-should-you-let-ai-control-your-money/backtesting-success-doesnt-mean-real-profits/slideshow/128147051.cms)).

---

## 2. Category A — Multi-agent LLM trading frameworks (decision layer)

These simulate a trading firm as collaborating/debating LLM agents. They output
decisions (BUY/SELL/HOLD + sizing), usually against a backtest engine; they do
**not** trade real money.

| Project | Stars | What it is |
|---|---|---|
| [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) | ~102k | The reference architecture: analyst team (fundamentals / sentiment / news / technicals) → bull-vs-bear **debate** → trader → risk mgmt → portfolio manager decision. Paper: [arXiv 2412.20138](https://huggingface.co/papers/2412.20138) (claims superior risk-adjusted returns vs. baselines). |
| [virattt/ai-hedge-fund](https://github.com/virattt/ai-hedge-fund) | ~63k | "AI Hedge Fund Team" PoC; investor personas (incl. Buffett/Munger-style agents) as **pluggable, backtestable alpha models**. Now pip-installable (`aihf`), with mandate files, backtesting vs. benchmark, multi-LLM support. Actively rebuilding toward a persistent always-on fund ([Vision](https://github.com/virattt/ai-hedge-fund/blob/master/VISION.md)). |
| [hsliuping/TradingAgents-CN](https://github.com/hsliuping/TradingAgents-CN) | ~31k | Chinese-enhanced TradingAgents fork for A-shares; web UI, v3 adds workflow designer / skill system. ⚠️ **Hybrid license** — core Apache 2.0 but `app/`+`frontend/` need commercial licensing; maintainers warn about an unauthorized clone site. |
| [QuantSingularity/LLM-Powered-Multi-Agent-Frameworks-for-Algorithmic-Trading](https://github.com/QuantSingularity/LLM-Powered-Multi-Agent-Frameworks-for-Algorithmic-Trading) | — | Hybrid **LLM + RL** pipeline: Analyst / Decision / Risk / Execution with backtesting and broker APIs — closest in spirit to a full loop. |
| [simonlin1212/TradingAgents-astock](https://github.com/simonlin1212/TradingAgents-astock) | ~3.1k | A-share variant: 7 analysts debating under A-share rules; A-share data sources (龙虎榜/游资/解禁). |
| [KylinMountain/TradingAgents-AShare](https://github.com/KylinMountain/TradingAgents-AShare) | ~800 | 15-agent institutional-simulation + debate, full visualization, Docker deploy. |
| [TradingGoose](https://github.com/TradingGoose/TradingGoose.github.io) | — | Multi-agent LLM framework covering both single-stock analysis and portfolio management. |
| [ABMR-TradingAgents](https://github.com/ALEXA8596/ABMR-TradingAgents) | — | "AI hedge fund driven by multi-agent LLM architecture." |

**Pattern:** role-based agent org chart (analysts → debate → decision → risk gate).
Debate/adversarial review is the distinctive idea; single-agent prompting is
consistently outperformed in these projects' own evals.

## 3. Category B — Agent-native trading harnesses (the closest "platform" analogs)

Full products: agent runtime + data + UI + (shadow) accounts. These are the most
direct analogs of what we want to build.

| Project | Stars | What it is |
|---|---|---|
| [HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading) | ~32k | "Your Personal Trading Agent" — one-command install (`pip install vibe-trading-ai`), FastAPI + React 19, **Shadow Account** (agent paper-trades a virtual book before real money), multilingual docs. From HKU Data Intelligence Lab. |
| [HKUDS/AI-Trader](https://github.com/HKUDS/AI-Trader) | ~22k | "100% Fully-Automated Agent-Native Trading" — same lab, more autonomous-execution oriented. |
| [ginlix-ai/LangAlpha](https://github.com/ginlix-ai/LangAlpha) | ~1.7k | "Claude Code for financial markets" — a **vibe-investing harness**: persistent workspace per research goal, iterative Bayesian thesis refinement, parallel subagent market screening, pair-trade idea dashboards. LangChain-based. Philosophically closest to "agent as long-lived investment researcher." |
| [mitchellbernstein/openquant](https://github.com/mitchellbernstein/openquant) | — | "Open-source operating system for quant trading": AI agents + risk engine + insider monitor + strategy backtesting. |
| [simonlin1212/Vibe-Research](https://github.com/simonlin1212/Vibe-Research) | ~2.2k | Personal research agent (A/HK/US): daily review, news radar, holdings, research journal, backtest. |
| [gameworkerkim/vibe-investing](https://github.com/gameworkerkim/vibe-investing) | ~327 | LLM quant tools + multi-agent backtesting for NASDAQ/S&P/crypto. |
| [jason8745/llm-agent-trader](https://github.com/jason8745/llm-agent-trader) | ~460 | LLM decision analysis + backtesting; FastAPI + Next.js. |
| [EthanAlgoX/LLM-TradeBot](https://github.com/EthanAlgoX/LLM-TradeBot), [circuit-framework](https://github.com/EthanXiang777/circuit-framework), [moss-trade-bot-skills](https://github.com/moss-site/moss-trade-bot-skills) | ~300–400 each | Smaller multi-agent systems; "natural language → five-pillar strategy" skills; adaptive real-time strategies. |

**Pattern:** the leading design moves of 2025–26 are (a) **shadow/paper accounts**
as the default agent sandbox, (b) treating the agent's research like a codebase
(persistent, compounding context), (c) shipping as a personal "harness", not a
fund.

## 4. Category C — Classic quant / execution engines (mature, LLM-free)

Not agentic, but they are the execution/backtest layer every serious agentic
platform ends up wrapping or imitating. Relevant to our Day-6 seven-module
architecture (`data / indicator / strategy / risk / broker / portfolio / backtest`).

| Project | Stars | Role |
|---|---|---|
| [OpenBB](https://github.com/OpenBB-finance/OpenBB) | ~72k | Open **data platform** "for analysts, quants and AI agents" — explicitly courting the agent ecosystem as its consumer. |
| [freqtrade](https://github.com/freqtrade/freqtrade) | ~54k | The gold-standard crypto bot: strategy API, backtesting, hyperopt, FreqAI (ML), dry-run mode, Telegram control. Great reference for broker/risk module design. |
| [QuantConnect/Lean](https://github.com/QuantConnect/Lean) | ~21k | Institutional-grade algo engine (C#/Python), multi-asset, cloud backtests, live brokerage integration. |
| [hummingbot](https://github.com/hummingbot/hummingbot) | ~20k | Market-making / HFT crypto bots, connector ecosystem. |
| [microsoft/qlib](https://github.com/microsoft/qlib) | ~48k | AI-oriented quant platform (factor/model research → production); now ships with [RD-Agent](https://github.com/microsoft/RD-Agent). |
| [microsoft/RD-Agent](https://github.com/microsoft/RD-Agent) | ~14k | **Meta-quant**: LLM agents that automate quant R&D (propose → implement → backtest factors/models) inside Qlib. Different goal (automating the researcher, not the trader) but highly relevant architecture. |
| [AI4Finance-Foundation/FinRL](https://github.com/AI4Finance-Foundation/FinRL) | ~16k | Deep-RL trading framework + environments; the RL alternative to LLM agents. |
| [AI4Finance-Foundation/FinGPT](https://github.com/AI4Finance-Foundation/FinGPT) | ~21k | Open financial LLMs (fine-tuned models for sentiment/forecasting). |
| [ta-lib-python](https://github.com/ta-lib/ta-lib-python) | ~12k | Standard technical-indicator library (our `indicator/` module). |

## 5. Category D — Agent-to-market infrastructure (MCP servers, broker APIs)

The connective tissue between an agent and live markets:

- [alpacahq/alpaca-mcp-server](https://github.com/alpacahq/alpaca-mcp-server) (~930★) — **official** Alpaca MCP server: trade stocks/ETFs/crypto/options "in plain English directly from your favorite LLM tools." Alpaca is the de-facto retail broker for agent experiments (free paper-trading API).
- [financial-datasets/mcp-server](https://github.com/financial-datasets/mcp-server) (~2.3k★) — market data MCP (prices, fundamentals) used by TradingAgents/ai-hedge-fund.
- [krakenfx/kraken-cli](https://github.com/krakenfx/kraken-cli) (~700★) — "first AI-native CLI" for crypto/stocks/forex/derivatives trading.
- [CPZ-Lab/cpzai-mcp-server](https://github.com/CPZ-Lab/cpzai-mcp-server) — quant strategies + backtests + **multi-broker order routing (Alpaca/IBKR/FIX)** + risk analytics exposed to agents.
- Broker-side MCP is spreading beyond retail ([Your Bourse MCP for brokerage operations](https://a-teaminsight.com/briefs/your-bourse-releases-mcp-for-trade-server-to-automate-brokerage-operations/)).

**Implication:** we likely don't need to invent broker integration — an MCP tool
layer over Alpaca (paper → live) or IBKR is the emerging standard.

## 6. Curated indexes (keep bookmarked)

- [LLMQuant/awesome-trading-agents](https://github.com/LLMQuant/awesome-trading-agents) — curated list of LLM trading agents / MCPs / skills; its "if you only read three": TradingAgents, ai-hedge-fund, HKUDS/AI-Trader.
- [georgezouq/awesome-ai-in-finance](https://github.com/georgezouq/awesome-ai-in-finance) (~6.5k★) — LLM & DL strategies/tools in finance.
- [wilsonfreitas/awesome-quant](https://github.com/wilsonfreitas/awesome-quant) (~29k★) — the classic quant resources list.
- [AI4Finance Awesome_AI4Finance](https://github.com/AI4Finance-Foundation/Awesome_AI4Finance).
- [Barca0412/Introduction-to-Quantitative-Finance](https://github.com/Barca0412/Introduction-to-Quantitative-Finance) (~1.7k★) — AI+quant tutorial incl. LLM/agent/benchmark reading list.

## 7. Academic & evaluation layer

- **TradingAgents** — [arXiv 2412.20138](https://huggingface.co/papers/2412.20138); reports higher Sharpe, lower volatility/drawdown vs. baselines ([summary](https://www.tradingagents-cn.com/en/research/)).
- **FinMem** — [arXiv 2311.13743](https://arxiv.org/abs/2311.13743), [code](https://github.com/pipiku915/FinMem-LLM-StockTrading) (~950★): layered memory + agent character design improves LLM trading performance. Memory architecture is a live research thread.
- **FinRL-DeepSeek** — [code](https://github.com/benstaf/FinRL_DeepSeek): LLM-infused risk-sensitive RL trading agents (hybrid pattern).
- Surveys: *From Deep Learning to LLMs: A Survey of AI in Quantitative Investment*; *Integrating LLMs in Financial Investments and Market Analysis: A Survey* ([Semantic Scholar](https://www.semanticscholar.org/paper/Integrating-Large-Language-Models-in-Financial-and-Mahdavi-Chen/6e8331657256fdc8f83dd534fcdbf12dfa375359)); [*Agentic Trading: When LLM Agents Meet Financial Markets*](https://ar5iv.labs.arxiv.org/html/2605.19337).
- Benchmarks (early, 2026): **AlphaForgeBench** (end-to-end strategy design with LLMs), **FinPersona-Bench** (psychometric stability of autonomous financial agents). No widely accepted live-trading benchmark exists yet.

## 8. Commercial signals

- [Composer shipped "Trade With AI"](https://www.tradersmagazine.com/xtra/composer-introduces-trade-with-ai-to-enhance-investment-platform/) — regulated retail platform bolting AI onto systematic strategies (not autonomous agents).
- Crypto-side: autonomous AI bots trading across Solana/BNB/Base chains ([Yahoo Finance](https://finance.yahoo.com/news/ai-bots-trade-crypto-across-154921890.html)) — mostly marketing-grade.
- LLMQuant runs a community/benchmark site around the OSS ecosystem.
- ⚠️ Scam-clone risk is real: TradingAgents-CN maintainers publicly flagged an
  unauthorized commercial clone of their code.

## 9. Recurring risks & caveats (consistent across sources)

1. **Backtest overfitting** — LLM strategies overfit history spectacularly;
   "backtesting success doesn't mean real profits."
2. **LLM non-determinism** — same prompt, different trades; reproducibility and
   regression-testing of decisions are unsolved in most repos.
3. **Latency & cost** — LLM-in-the-loop per bar is slow and expensive; all
   practical systems use LLMs at low frequency (daily/thesis level), classic
   rules at high frequency.
4. **Risk gate is the product** — every credible project puts a non-LLM risk
   layer between agent and broker (position limits, kill switches). Matches our
   Day-6 rule: fill reports are the only source of truth; strategy never
   mutates portfolio directly.
5. **Paper trading first** — Vibe-Trading's Shadow Account and Alpaca's paper API
   are the standard safety pattern; we should adopt the same.
6. **Licensing traps** — hybrid licenses (TradingAgents-CN) and "educational
   only" disclaimers on ai-hedge-fund/TradingAgents mean code reuse needs
   license checks.

## 10. What this means for our project

**The gap:** most OSS projects are either (a) LLM decision frameworks with no
real execution/risk stack, or (b) mature engines with no agent layer. Nobody
open-source has nailed **LLM agents + our seven-module quant core + hard risk
gates + paper→live broker path** as a personal-investment platform. That is a
coherent, defensible build.

**Concrete takeaways:**
- Steal the **architecture pattern**, not the code: analyst/debate/risk org
  (TradingAgents), pluggable alpha-model personas (ai-hedge-fund), shadow
  account (Vibe-Trading), persistent research workspace (LangAlpha).
- Build our `backtest/` + `risk/` modules to be the **trusted core** that any
  agent must pass through — agents propose, the engine disposes.
- Use **MCP as the broker/data seam** from day one (Alpaca paper account as the
  first connector) so agents and the platform stay decoupled.
- Read list: TradingAgents paper → FinMem → RD-Agent (for the
  research-automation loop) → awesome-trading-agents for ongoing tracking.

**Open questions to decide next:**
- Markets & broker first target (US equities via Alpaca? crypto? A-shares need
  dedicated data sources like the TradingAgents-astock adaptations).
- Decision frequency for the agent layer (daily thesis vs. intraday).
- Whether to reuse an engine (Lean/freqtrade as backtest backend) or grow our
  own seven-module core as planned in `docs/quant-system-architecture.html`.
