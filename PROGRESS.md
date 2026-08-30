# PROGRESS

Session log for the agentic-trading project. Newest entries on top.
Each entry: what was done, key decisions, and what's next.

---

## 2026-08-30 — Day 21, 22, 23, 24 knowledge extraction → topic docs

### What was done
- Read the JPG slides of `knowledge-base/day_21/` (IMG_6639–6646, 8 slides),
  `day_22/` (IMG_6647–6654, 8 slides), `day_23/` (IMG_6655–6662, 8 slides)
  and `day_24/` (IMG_6663–6670, 8 slides) of "30天学习量化投资" using the
  macOS Vision OCR tool.
- Created four self-contained HTML docs in `docs/`, matching the existing style:
  - `docs/day_21_backtest-engine.html` — Backtest Engine (回测引擎): the
    system orchestrator / director analogy; complete 6-module pipeline (Market →
    Strategy → Order → Broker → Portfolio → Performance); module I/O table;
    tracing one Bar through 6 steps; Engine responsibilities vs non-responsibilities;
    Go Engine struct and Run() pseudocode with the main loop.
  - `docs/day_22_performance-analyzer.html` — Performance Analyzer (绩效分析):
    position in pipeline; three core metrics — Return (how much earned), Max
    Drawdown (worst pain), Sharpe Ratio (risk worth it?); Sharpe reference scale;
    two-strategy comparison (aggressive vs steady); Go struct design with
    PerformanceReport; 7-step computation pipeline.
  - `docs/day_23_parameter-optimization-overfitting.html` — Parameter Optimization
    & Overfitting Prevention (参数优化与防过拟合): parameters as strategy knobs;
    multi-metric batch testing; overfitting signs; single-point trap (isolated
    peaks vs stable plateaus); 2D parameter heatmap with color-coded cells;
    out-of-sample validation with time split; scientific 4-step optimization flow.
  - `docs/day_24_strategy-portfolio.html` — Strategy Portfolio (策略组合):
    Strategy vs Portfolio roles; why combinations are needed (market regime
    cycling); capital allocation with weight bars; correlation explained;
    low-correlation profit/loss offset mechanism; more strategies ≠ better
    diversification (need different return sources); 6-step portfolio construction
    process.
- Verified all four docs render with headless Chrome screenshots; no rendering
  issues found; temporary screenshots deleted.

### Key decisions
- Day 22 reuses the Sharpe scale component from Day 12 for visual consistency.
- Day 23 introduces `.heatmap` CSS with color-coded table cells (hot/warm/cool/peak)
  for the 2D parameter sweep visualization.
- Day 24 uses `.alloc-bar` for capital allocation visualization and the
  `.compare-3` grid for three-strategy examples.
- All docs maintain the bilingual English/Chinese convention.

### What's next (proposed)
1. Continue extraction for remaining days (25–30) as folders appear.
2. Build an index/hub page linking all 24 day docs.
3. Begin implementing the Go modules based on Days 16–21 architecture.

---

## 2026-08-30 — Day 18, 19, 20 knowledge extraction → topic docs

### What was done
- Read the JPG slides of `knowledge-base/day_18/` (IMG_6615–6622, 8 slides),
  `day_19/` (IMG_6623–6630, 8 slides) and `day_20/` (IMG_6631–6638, 8 slides)
  of "30天学习量化投资" using the macOS Vision OCR tool.
- Created three self-contained HTML docs in `docs/`, matching the existing style:
  - `docs/day_18_sliding-window-incremental-sma.html` — 滑动窗口与增量SMA:
    Naive SMA O(N) problem; sliding window O(1) formula (new_sum = old_sum −
    oldest + newest); circular buffer with fixed memory and in-place overwrite
    (with visual ring buffer diagrams); Go SMA struct and Update() implementation;
    why append(window[1:], v) is bad for long-running systems; Reset() for reuse;
    don't prematurely unify Indicator interface; golden cross as edge trigger
    (state machine with IN_UP/IN_DOWN states and Go code).
  - `docs/day_19_strategy-signals-trading-logic.html` — 策略信号与交易逻辑:
    Strategy's sole job is producing signals; Signal struct definition; dual MA
    golden/death cross with state machine; Signal ≠ Order ≠ Trade; same signal
    can produce different outcomes; BUY execution checklist (5 checks); SELL
    execution checklist (5 checks); responsibility boundaries table (Strategy →
    Risk → Order → Broker → Portfolio); complete 8-step trading chain with
    pseudocode.
  - `docs/day_20_trade-simulation-transaction-costs.html` — 成交模拟与交易成本:
    Strategy thinks / Broker executes; ideal vs real fill; slippage definition
    and cumulative impact table; commission types (brokerage, exchange, stamp
    duty) with worked buy/sell examples; complete BUY calculation walkthrough
    (signal → slippage → fill → qty → amount → commission → deduction → account
    update); why costs destroy strategies (gross vs net comparison); high vs low
    turnover cost comparison; slippage control methods.
- Verified all three docs render with headless Chrome screenshots; no rendering
  issues found; temporary screenshots deleted.
- Day 21 folder exists but is empty — skipped.

### Key decisions
- Day 18 introduces `.ring` CSS component for circular buffer visualization
  (colored cells with index labels showing in-place overwrite).
- Day 19 uses `.checklist` component with colored icons for BUY/SELL execution
  checks. State machine flow diagram for IN_UP/IN_DOWN transitions.
- Day 20 uses `.cost-bar` component for visualizing gross return vs cost erosion.
  Three-column comparison for before/after/cost account states.
- All docs maintain the bilingual English/Chinese convention.

### What's next (proposed)
1. Continue extraction for remaining days as folders appear.
2. Build an index/hub page linking all 20 day docs.
3. Begin implementing the Go modules: CSV reader (Day 17) → SMA indicator
   (Day 18) → Strategy signals (Day 19) → Broker simulation (Day 20).

---

## 2026-08-30 — Day 14, 15, 16, 17 knowledge extraction → topic docs

### What was done
- Read the JPG slides of `knowledge-base/day_14/` (IMG_6583–6590, 8 slides),
  `day_15/` (IMG_6591–6598, 8 slides), `day_16/` (IMG_6599–6606, 8 slides)
  and `day_17/` (IMG_6607–6614, 8 slides) of "30天学习量化投资" using the
  macOS Vision OCR tool.
- Created four self-contained HTML docs in `docs/`, matching the existing style:
  - `docs/day_14_risk-control-backtest-framework.html` — 风险控制与第一版回测框架:
    Three-layer risk control system (single-trade / position / account-level);
    risk budget → per-share risk → risk-allowed quantity formula; position limit
    and the min() rule for final buy quantity; account-level brake system (2% daily
    loss stop, 10% drawdown halve, 15% kill switch); stop-loss reality (gap-down
    risk); first backtest framework integrating risk into the pipeline.
  - `docs/day_15_hypothesis-to-strategy.html` — 从假设到策略: The scientific
    method for strategy development (hypothesis → rules → backtest → OOS →
    explain → launch); market hypotheses (trend continuity, mean reversion, etc.);
    translating hypotheses into quantifiable rules (semiconductor ETF trend
    strategy example); multi-dimensional validation; interpretability as the key
    to surviving drawdowns; 5-question pre-launch checklist.
  - `docs/day_16_go-project-structure.html` — Go量化项目结构: Project directory
    layout with `cmd/` + `internal/` + `data/`; modular monolith vs microservices
    rationale; 7 core modules with responsibilities; backtest time-loop
    orchestration; Go `internal/` directory import boundaries; dependency inversion
    with Strategy interface (Go code examples); unit testing pyramid and Go test
    patterns.
  - `docs/day_17_csv-market-data-reader.html` — CSV行情读取: CSV format → Bar
    struct conversion; io.Reader design for data-source decoupling; two-layer
    interface (Reader parses, Loader fetches); Reader responsibility boundaries
    (should/should-not do); comprehensive data quality checklist (7 error
    categories); trading-day vs natural-day time ordering rules.
- Verified all four docs render with headless Chrome screenshots; no rendering
  issues found; temporary screenshots deleted.

### Key decisions
- Day 14 introduces a `.layers` CSS component for the 3-layer risk control stack
  and `.compare-3` for the 3 account-level brake rules.
- Day 15 uses a `.checklist` component for the 5-question pre-launch self-check.
- Day 16 uses a `.tree` component for directory structure display and a `.pyramid`
  for the test pyramid visual. Dark-background code blocks for Go code.
- Day 17 uses a `.sources` grid for data-source types and continues the Go code
  block style from Day 16.
- All docs maintain the bilingual English/Chinese convention.

### What's next (proposed)
1. Continue extraction for remaining days as folders appear.
2. Build an index/hub page linking all 17 day docs.
3. Begin implementing the Go project structure from Day 16.
4. Implement the CSV market data reader from Day 17 as the first module.
5. Feed Day 14 risk control formulas into the risk module design.

---

## 2026-08-30 — Day 11, 12, 13 knowledge extraction → topic docs

### What was done
- Read the JPG slides of `knowledge-base/day_11/` (IMG_6550–6553, 4 slides),
  `day_12/` (IMG_6554–6557, 4 slides) and `day_13/` (IMG_6558–6565, 8 slides)
  of "30天学习量化投资" using the macOS Vision OCR tool.
- Created three self-contained HTML docs in `docs/`, matching the existing style:
  - `docs/day_11_parameter-optimization-overfitting.html` — 参数优化与过拟合:
    Overfitting definition and programmer analogy (memorizing vs learning);
    parameter plateaus vs isolated peaks (with inline SVG bar charts);
    why the highest-return parameter (MA7=35%) is dangerous while the plateau
    (MA5/6/8/9=17-20%) is reliable; out-of-sample testing (train on 2015-2022,
    validate on 2023-2025); decision checklist.
  - `docs/day_12_volatility-sharpe-ratio.html` — 波动率与夏普比率: Volatility as
    "bumpiness" (with SVG equity curves for low vs high vol); Sharpe Ratio formula
    and 5-band visual scale (<0 poor to >3 excellent, with overfitting warning);
    Sharpe vs Max Drawdown comparison (complementary, not substitutable);
    Strategy A (18%/9% vol/Sharpe 2.0) vs B (25%/20% vol/Sharpe 1.25) worked
    comparison.
  - `docs/day_13_position-sizing.html` — 仓位管理: Position definition and
    terminology (满仓/半仓/轻仓/空仓 with visual bars); how position amplifies
    both gains and losses (symmetric tables); fixed position sizing (auto-scaling
    with equity, 4 advantages, conservative/balanced/aggressive ranges); dynamic
    position sizing (volatility-based allocation with SVG curve); leverage as
    multiplier (Sharpe unchanged, no Alpha creation); real Alpha comes from
    strategy improvement; 3-scenario practice exercise.
- Verified all three docs render with headless Chrome screenshots (top + full-page);
  no rendering issues found; temporary screenshots deleted.

### Key decisions
- Day 11 uses inline SVG bar charts to contrast parameter plateaus (flat green bars)
  vs isolated peaks (single red spike) — visual communication of the core concept.
- Day 12 introduces a 5-band Sharpe scale component for quick visual reference.
- Day 13 introduces `.pos-bar` (position bar) and `.compare-3` (3-column grid)
  components to visualize capital allocation.
- All docs continue the bilingual English/Chinese convention.

### What's next (proposed)
1. Continue extraction for remaining days as folders appear.
2. Build an index/hub page linking all 13 day docs.
3. Feed Day 11 overfitting concepts into backtest module validation pipeline.
4. Feed Day 12 Sharpe/volatility metrics into backtest report outputs.
5. Feed Day 13 position sizing into portfolio/risk module design (fixed vs dynamic
   allocation, leverage constraints).

---

## 2026-08-30 — Day 8, 9, 10 knowledge extraction → topic docs

### What was done
- Read the JPG slides of `knowledge-base/day_8/` (IMG_6527–6533 + IMG_6542 cover,
  8 slides), `day_9/` (IMG_6534–6541, 8 slides) and `day_10/` (IMG_6543–6549,
  7 slides) of "30天学习量化投资" using the macOS Vision OCR tool from
  `knowledge-base/day_6/.tools/ocr`.
- Created three self-contained HTML docs in `docs/`, matching the day_6/7 style:
  - `docs/day_8_order-trade-fees-slippage.html` — 订单、成交、手续费与滑点:
    Order vs Trade (intent vs result); the complete Signal→Order→Trade→Portfolio
    chain; slippage definition, sources, and return impact; commission fee formula
    and accumulation effect; partial fills and market depth; a full-cost worked
    calculation (buy 2000 @ 10.05 with 万三 fee); the five hidden costs that make
    real returns fall short of ideal backtests.
  - `docs/day_9_equity-curve-drawdown.html` — 收益曲线、累计收益与最大回撤:
    Equity Curve as the strategy's biography (with SVG chart); cumulative return
    formula and three outcomes (profit/break-even/loss); current drawdown from
    peak; Maximum Drawdown (MDD) computation with worked example (with SVG chart);
    returns and drawdowns coexisting (the classic "back to start but endured -23%"
    example); full practice exercise with Day 0–5 data.
  - `docs/day_10_win-rate-profit-ratio-expectancy.html` — 胜率、盈亏比与期望
    收益: Win rate (frequency ≠ quality); Profit/Loss ratio (win size vs loss
    size); Expected Return formula (the ultimate verdict); the 90%-win-rate-can-
    still-lose trap; trend strategies (low win rate, high P/L, one big win covers
    many small losses); full practice with 10-trade dataset.
- Verified all three docs render with headless Chrome screenshots (top + full-page);
  no rendering issues found; temporary screenshots deleted.

### Key decisions
- Naming follows the existing `day_N_<slug>.html` pattern established by days 1–7.
- Day 9 includes inline SVG charts for the equity curve and MDD diagrams (instead
  of ASCII art) for clearer visual communication.
- Day 10 introduces `.trade-strip` and `.gauge` CSS components for visualizing
  win/loss sequences and expectancy bars — extensions of the existing design
  language.
- All Chinese terms preserved in parentheses alongside English, consistent with
  previous docs.

### What's next (proposed)
1. Continue extraction for days 11–12 when ready.
2. Consider building an index/hub page linking all 10 (soon 12) day docs.
3. Feed Day 8 execution concepts into the `broker/` module design (slippage
   models, partial fill handling).
4. Feed Day 9–10 evaluation metrics into the `backtest/` module (equity curve,
   MDD, win rate, P/L ratio, expected return as report outputs).

---

## 2026-08-30 — Day 4, 5, 7 knowledge extraction → topic docs

### What was done
- Read the JPG slides of `knowledge-base/day_4/` (IMG_6503–6510), `day_5/`
  (IMG_6511–6518) and `day_7/` (IMG_6519–6526), same pipeline as before
  (Vision OCR via `knowledge-base/day_6/.tools/ocr` + direct visual reads,
  three parallel subagents).
- Created three self-contained HTML docs in `docs/`:
  - `docs/day_4_backtest-state-machine.html` — 回测是一个状态机: backtest replays
  history bar-by-bar in strict time order; look-ahead bias (前视偏差) as the
    deadliest sin (5 scenarios, 4 harms); the 6-step daily loop; the Flat↔Long
  two-state FSM with a 15-day dual-MA walkthrough; three core variables
    (cash / position / price).
  - `docs/day_5_time-series-and-arrays.html` — 时间序列与数组: a program sees a
  time series, not a chart; MA as a fixed-size sliding window over the last N
  closes; why averaging all history is wrong; NaN on insufficient data;
    the O(1) incremental sliding-window MA (Go struct with Update).
  - `docs/day_7_bar-signal-position-portfolio.html` — Bar、Signal、Position 与
    Portfolio: the four core data structures (Go struct contracts); Signal as a
  suggestion memo that never mutates the account; floating P&L and average
    cost rules; Equity = Cash + Σ(Qty × Price); position sizing; a full
    Bar→Signal→Risk→Broker→Portfolio worked exercise.
- Fixed two rendering issues found during verification (emoji tofu in day_5,
  `<b>` inside `.io-box` inheriting `display: block` in day_7). Re-screenshotted
  all three docs after fixes — render cleanly; temp screenshots deleted.
- Renamed the docs to `day_N_<slug>.html` (underscore after the day number) to
  match the user's rename of the day_6 doc; updated the day_1–3 filenames and
  their references in the previous PROGRESS entry accordingly.

### Key decisions
- Day 4 slide 8/8's practice table has an internal inconsistency (labels Day 14
  as the sell trigger while its own MA5/MA20 numbers show MA5 > MA20); the doc
  follows slide 6/8's internally consistent 15-day version (buy Day 10, hold
  Day 11–14, sell Day 15).

### What's next (proposed)
1. All available days (1–7) are now extracted — the knowledge base feeds the
   repo skeleton: `data/` (Day 2 + Day 7 Bar), `indicator/` (Day 3 + Day 5 MA),
   `strategy/`/`portfolio/`/`backtest/` (Day 4 + Day 6 + Day 7 contracts).
2. When day_8+ folders appear, run the same extraction pipeline.

---

## 2026-08-30 — Day 1–3 knowledge extraction → topic docs

### What was done
- Read the JPG slides of `knowledge-base/day_1/` (IMG_6480–6486, slides 2–8),
  `day_2/` (IMG_6487–6494) and `day_3/` (IMG_6495–6502) of the course
  "30天学习量化投资", using the same pipeline as day 6: Vision OCR via
  `knowledge-base/day_6/.tools/ocr` plus direct visual reads (three parallel
  subagents, one per day).
- Created three self-contained HTML docs in `docs/`, matching the day_6 style:
  - `docs/day_1_quant-investing-fundamentals.html` — 量化投资入门: core metrics
    (return, max drawdown, win rate, profit factor, Sharpe), an MA golden-cross
    trend strategy walkthrough, reading backtests, and risk control as the
    survival key. (Note: day_1 folder holds slides 2–8; the cover slide is absent.)
  - `docs/day_2_candlestick-ohlcv-data.html` — K线与OHLCV数据: OHLCV structure,
    阳线/阴线 semantics (color encodes Close vs Open only, not the intraday
    path), body & shadows, return rate vs price difference.
  - `docs/day_3_trend-moving-averages.html` — 趋势与移动平均线: "don't predict,
    follow", MA(N) computation and the sliding window, short vs long MAs, the
    dual-MA strategy, and the whipsaw weakness (鞭打效应).
- Verified all three docs render with headless Chrome screenshots; no issues
  found; temporary screenshots deleted.

### Key decisions
- One HTML doc per day in `docs/`, named `day_N-<topic-slug>.html`, reusing the
  day_6 CSS design language verbatim (plus small same-style extensions where a
  day needed new components, e.g. candlestick diagram, formula blocks).
- English as working language with original Chinese terms preserved in
  parentheses — same convention as the day_6 doc.

### What's next (proposed)
1. Continue extraction for the remaining days as their folders appear
   (days 4–5 are still missing).
2. Feed Days 1–3 concepts into the repo skeleton: `data/` (OHLCV from Day 2),
   `indicator/` (MA from Day 3), and the metrics/risk vocabulary (Day 1).

---


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
   own seven-module core from `docs/day_6_quant-system-architecture.html`.
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
