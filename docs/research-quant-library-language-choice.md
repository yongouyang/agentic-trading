# Research: Quant Library & Implementation Language Choice

**Date:** 2026-08-30 · **Scope:** Comprehensive comparison of programming
languages for building quantitative trading systems, with a deep-dive on Go vs
Rust. Includes what top-performing hedge funds actually use, the open-source
ecosystem maturity per language, and a recommendation for our project.
Live GitHub star counts pulled from the GitHub API on 2026-08-30.

> ⚠️ **Updated recommendation:** This document evaluates languages for a
> generic quant platform and recommends Go. However, given our actual context
> (single Mac Mini, daily batch, solo developer, LLM-heavy agent layer),
> a subsequent analysis recommends **NestJS (TypeScript)** instead. See
> [`research-nestjs-vs-go-platform-choice.md`](./research-nestjs-vs-go-platform-choice.md)
> for the context-aware decision.

---

## 1. TL;DR

- **Python dominates quant** and always will at the research/alpha layer — no
  language comes close to its ecosystem (NumPy, pandas, scikit-learn, PyTorch,
  Qlib, TA-Lib, zipline, backtrader, FinRL). Every serious fund uses Python
  somewhere in the stack.
- **C++ owns the ultra-low-latency tier** (market making, HFT, order book
  matching engines). When microseconds matter, nothing else competes.
- **Go is the best choice for infrastructure/glue** — data pipelines, order
  routing, microservices, real-time dashboards, concurrent workers. It is
  *not* a quant library language; it's a *quant platform* language.
- **Rust is the emerging contender for performance-critical quant cores** —
  backtesting engines, risk calculations, portfolio optimization. It's 5–8
  years behind C++ in ecosystem maturity but closing fast.
- **For our project, Go is the right primary language.** The architecture we
  designed (Day 16–21: 7-module pipeline, event-driven, concurrent data
  readers) maps perfectly to Go's strengths. Rust can be introduced later
  via FFI for specific hot paths (e.g., backtest engine core).
- **Top hedge funds use a polyglot stack** — no fund runs a single language.
  The pattern is: Python for research → C++/Java for execution → proprietary
  infrastructure in whatever fits.

---

## 2. Language Landscape Overview

### 2.1 The Four Tiers of Quant Systems

```
┌─────────────────────────────────────────────────────────────────┐
│  Tier 1: RESEARCH & ALPHA                                       │
│  Language: Python (dominant), R, Julia, Mathematica             │
│  Tools: pandas, NumPy, scipy, scikit-learn, PyTorch, Qlib       │
│  Latency: seconds to hours (batch)                              │
├─────────────────────────────────────────────────────────────────┤
│  Tier 2: BACKTESTING & STRATEGY VALIDATION                      │
│  Language: Python, Rust (emerging), C++, Go                     │
│  Tools: zipline, backtrader, Lean, hftbacktest, barter-rs       │
│  Latency: minutes per full backtest run                         │
├─────────────────────────────────────────────────────────────────┤
│  Tier 3: REAL-TIME EXECUTION & RISK                             │
│  Language: C++, Java, Rust, Go                                  │
│  Latency: microseconds to milliseconds                          │
├─────────────────────────────────────────────────────────────────┤
│  Tier 4: INFRASTRUCTURE & DATA PIPELINES                        │
│  Language: Go, Java, Rust, Python                               │
│  Tools: Kafka, TimescaleDB, gRPC, Arrow                         │
│  Latency: milliseconds                                          │
└─────────────────────────────────────────────────────────────────┘
```

Our project (the 7-module quant core from Day 6) spans **Tiers 2–4**. We are
building a backtesting engine + real-time execution platform + data pipeline.
We are *not* building an alpha research tool (that's Python's domain).

### 2.2 Quant Open-Source Ecosystem by Language

| Language | Top Quant Repos | Combined ★ | Maturity |
|---|---|---|---|
| **Python** | Qlib (48k), freqtrade (54k), zipline (18k), backtrader (14k), TA-Lib (12k), FinRL (16k), FinGPT (21k) | ~180k+ | **Mature** (15+ years) |
| **C++** | QuantLib (~6k), TA-Lib C core (~12k shared), various HFT engines | ~25k | **Mature** (20+ years) |
| **Rust** | hftbacktest (4.6k), barter-rs (2.2k), RustQuant (1.8k) | ~12k | **Early** (3–5 years) |
| **Go** | indicator (1.6k), alpaca-trade-api-go (0.4k), go-trader (0.3k), shopspring/decimal (7.5k, finance utility) | ~11k | **Early** (3–5 years) |
| **C#** | QuantConnect/Lean (21k) | ~21k | **Mature** (single-project) |
| **Java** | Various proprietary; no dominant OSS quant framework | ~5k | **Fragmented** |

**Key insight:** The Go and Rust quant ecosystems are nearly identical in size
(~11–12k combined stars). The difference is *trajectory* and *what each is
good at*:

- **Rust** is winning in **computation-heavy backtesting** (hftbacktest at
  4.6k★ is the most-starred non-Python backtest engine created in the last
  3 years).
- **Go** is winning in **trading infrastructure** (broker APIs, data feeds,
  concurrent orchestration, microservices).

---

## 3. What Top Hedge Funds Actually Use

### 3.1 Known Technology Stacks

| Fund | AUM | Known Stack | Notes |
|---|---|---|---|
| **Renaissance Technologies (Medallion)** | ~$60B+ | C, C++, proprietary | Axpy (their compute platform) is C-based. Famously hired mathematicians/physicists, not CS people. All code proprietary, no OSS. |
| **Two Sigma** | ~$60B+ | C++, Java, Python, Scala | Heavy JVM stack for execution. Python for research. Proprietary distributed compute ("Gravity"). |
| **Citadel / Citadel Securities** | ~$60B+ | C++, Java, Python, OCaml | C++ for market-making engines. Known to use OCaml for some pricing/risk systems. |
| **DE Shaw** | ~$60B+ | C++, Python, Java, proprietary | "The Firm" — hybrid academic/engineering culture. D.E. Shaw himself was a CS professor. |
| **Point72 / Cubist** | ~$30B+ | C++, Java, Python, kdb+/q | Heavy kdb+ time-series database. C++ for execution, Python for alpha research. |
| **Millennium (platform)** | ~$60B+ | Varies by pod | Each pod/team chooses their own stack. Python + C++ most common. |
| **Balyasny** | ~$20B+ | C++, Python, C# | Known to use QuantConnect-style tooling internally. |
| **Marshall Wace** | ~$60B+ | Python, C++, Java | TOPS platform (their internal quant platform) is Python-heavy. |
| **Jane Street** | ~$20B+ | **OCaml** (primary!) | The famous OCaml shop. ~95% of codebase in OCaml. Uses it for everything: pricing, risk, trading, infrastructure. |
| **Optiver** | ~N/A | C++, Java, Python | Market maker. C++ for matching-engine-tier latency. |
| **Jump Trading** | ~N/A | C++, Rust (reportedly), Python | Known to be evaluating/adopting Rust for new systems. |
| **Hudson River Trading (HRT)** | ~N/A | C++, Python | HFT. C++ core with Python research layer. |

### 3.2 Patterns from Top Funds

1. **No fund uses a single language.** The universal pattern is polyglot:
   - **Python** at the research/alpha layer (always)
   - **C++** (or sometimes Java) at the execution/low-latency layer
   - **Something else** for infrastructure/glue

2. **Go is used at infrastructure-heavy firms**, not as the quant engine:
   - **Bloomberg** — heavy Go adoption for data infrastructure and terminals
   - **Stripe, Square (Block)** — Go for payment/financial infrastructure
   - **Several crypto exchanges** (Coinbase, Kraken) — Go for matching engines and order routers

3. **Rust is being adopted by newer/forward-looking firms:**
   - **Jump Trading** — reportedly using Rust for new systems
   - **Several crypto-native HFT shops** — Rust for market-making bots
   - **Mozilla-origin talent** flowing into quant firms that value memory safety

4. **The "boring" truth:** most fund alpha is in the *math and data*, not
   the language. Renaissance's edge isn't C++ — it's their statistical models
   and 40 years of proprietary signal research. Language is plumbing.

### 3.3 Notable OCaml Case: Jane Street

Jane Street is the most famous counter-example to the "C++ for performance"
orthodoxy. They use OCaml — a functional language — for everything including
real-time trading. Their rationale:

- **Type system catches errors at compile time** → fewer production bugs
- **Pattern matching** → elegant expression of complex trading logic
- **Garbage collector is fast enough** for their latency requirements (they
  are a market maker, not HFT in the nanosecond sense)
- **Developer productivity** → faster to write correct code

This validates our potential approach: **Go for correctness and productivity,
with optional Rust/C++ for hot paths** is a defensible architecture.

---

## 4. Go vs Rust: Deep Comparison for Quant Systems

### 4.1 Head-to-Head Matrix

| Criterion | Go | Rust | Winner |
|---|---|---|---|
| **Raw Performance** | ~2–5x slower than C/C++ | ~1.0–1.2x of C/C++ | **Rust** |
| **Compile Time** | Seconds (fast incremental) | Minutes (slow, thorough) | **Go** |
| **Learning Curve** | Low (days to productive) | High (weeks to months, borrow checker) | **Go** |
| **Concurrency** | Goroutines + channels (simple, built-in) | async/await + tokio (powerful, complex) | **Go** (simplicity) |
| **Memory Safety** | GC-managed (pause times ~1ms typical) | Zero-cost abstractions, no GC | **Rust** |
| **Deterministic Latency** | GC pauses make worst-case unpredictable | No GC → fully deterministic | **Rust** |
| **Ecosystem (Quant)** | Small but growing (~11k★) | Small but growing (~12k★) | **Tie** |
| **Ecosystem (General)** | Massive (web, cloud, DevOps, DB) | Large (systems, CLI, WASM, embedded) | **Go** (broader) |
| **FFI / Interop** | CGo (works but friction) | Excellent (C ABI compatible, PyO3, napi-rs) | **Rust** |
| **Binary Size** | Large (static, ~10–20MB) | Large (static, ~5–15MB) | **Tie** |
| **Deployment** | Single static binary, trivial | Single static binary, trivial | **Tie** |
| **Testing & Tooling** | Excellent (`go test`, race detector, `pprof`) | Good (`cargo test`, `clippy`, `miri`) | **Go** (simpler) |
| **Error Handling** | Explicit (`if err != nil`) | `Result<T, E>` + `?` operator | **Rust** (more ergonomic) |
| **Developer Pool** | Large (easy to hire for) | Smaller (harder to hire, higher bar) | **Go** |
| **AI/ML Integration** | Weak (few ML libs) | Weak (few ML libs) | **Tie** (both weak) |

### 4.2 Performance Benchmarks

From published benchmarks (TechEmpower, Programming Language Benchmarks Game,
and quant-specific micro-benchmarks):

| Operation | Go (ns) | Rust (ns) | C++ (ns) | Python (ns) |
|---|---|---|---|---|
| Integer arithmetic (tight loop) | ~1.0x | ~1.0x | 1.0x (baseline) | ~50–100x |
| Float64 array sum (1M elements) | ~1.2x | ~1.0x | 1.0x | ~80x |
| HashMap insert (1M entries) | ~2.0x | ~1.3x | 1.0x | ~15x |
| JSON parse (1MB) | ~1.5x | ~1.1x | 1.0x | ~10x |
| Concurrent HTTP requests (10K) | ~1.0x (excellent) | ~1.0x (excellent) | ~1.2x | ~5x |
| Order book matching (per order) | ~3–5μs | ~1–2μs | ~0.5–1μs | ~50–100μs |
| SMA calculation (sliding window, 1M bars) | ~1.1x | ~1.0x | 1.0x | ~60x |
| Backtest simulation (10K bars) | ~2–3x | ~1.0–1.2x | 1.0x | ~100x |

**For our use case** (daily-bar backtesting, 10K–100K bars per strategy,
multi-strategy portfolio), Go's ~2–3x overhead vs Rust/C++ is **irrelevant** —
the bottleneck is I/O (reading market data) and the LLM agent layer, not the
compute kernel. Go's ~5μs per order-book operation is more than fast enough
for daily/hourly bar strategies.

### 4.3 Quant Library Ecosystem: Go vs Rust

#### Go Quant Libraries

| Library | ★ | Purpose | Status |
|---|---|---|---|
| [cinar/indicator](https://github.com/cinar/indicator) | 1,598 | Technical analysis indicators (SMA, EMA, MACD, RSI, Bollinger, etc.) | **Active**, good coverage |
| [shopspring/decimal](https://github.com/shopspring/decimal) | 7,469 | Arbitrary-precision decimal (critical for financial math) | **Mature**, widely used |
| [alpacahq/alpaca-trade-api-go](https://github.com/alpacahq/alpaca-trade-api-go) | 427 | Alpaca broker API client | **Active** |
| [richkuo/go-trader](https://github.com/richkuo/go-trader) | 344 | Crypto trading bot (backtest + paper + live) | Active |
| [sklinkert/at](https://github.com/sklinkert/at) | 92 | Trading bot framework | Active |
| [Go-Quant/goquant](https://github.com/Go-Quant/goquant) | 30 | Financial data analysis framework | Early |
| [intrepidkarthi/orderbook](https://github.com/intrepidkarthi/orderbook) | 15 | Limit order book + matching engine | Niche |

**Go ecosystem verdict:** The `indicator` library covers technical analysis
well. `shopspring/decimal` is production-grade for financial math. But there
is **no comprehensive backtesting framework** — you'd build one from scratch
(which is exactly what we're doing in Days 16–24).

#### Rust Quant Libraries

| Library | ★ | Purpose | Status |
|---|---|---|---|
| [nkaz001/hftbacktest](https://github.com/nkaz001/hftbacktest) | 4,565 | HFT backtesting + live trading (order-level simulation) | **Active**, impressive |
| [barter-rs/barter-rs](https://github.com/barter-rs/barter-rs) | 2,246 | Event-driven backtesting + live trading framework | **Active**, well-designed |
| [avhz/RustQuant](https://github.com/avhz/RustQuant) | 1,816 | Quantitative finance library (pricing, risk, portfolio) | **Active**, academic-grade |
| [jensnesten/rust_bt](https://github.com/jensnesten/rust_bt) | 82 | High-performance backtesting engine | Active |
| [calumrussell/rotala](https://github.com/calumrussell/rotala) | 76 | Backtesting engine | Active |
| [alphabench/raptorbt](https://github.com/alphabench/raptorbt) | 38 | Backtest engine + Python bindings (PyO3) | Early |
| [nersent/qpace](https://github.com/nersent/qpace) | 29 | Quant SDK for Python/JS, written in Rust | Early |

**Rust ecosystem verdict:** More mature than Go for quant specifically.
`hftbacktest` and `barter-rs` are genuinely impressive, well-engineered
frameworks. `RustQuant` covers the mathematical finance side (option
pricing, risk metrics, portfolio optimization). But the ecosystem is still
young — fewer battle-tested production deployments than Python or C++.

### 4.4 Architecture Fit for Our Project

Our 7-module architecture (Day 6, implemented Days 16–24):

```
Market Data → Strategy → Order → Broker → Portfolio → Performance
    ↑                                                          │
    └──────────────── Backtest Engine ←────────────────────────┘
```

| Module | Go Fit | Rust Fit | Notes |
|---|---|---|---|
| **Market Data Reader** (Day 17) | ★★★★★ | ★★★ | CSV/file I/O + concurrent streaming = Go sweet spot |
| **Indicator/SMA** (Day 18) | ★★★★ | ★★★★★ | Sliding window math — either works, Rust slightly faster |
| **Strategy Signals** (Day 19) | ★★★★★ | ★★★★ | State machine + signal generation = Go simplicity wins |
| **Trade Simulation** (Day 20) | ★★★★ | ★★★★★ | Slippage/commission calc — Rust's precision helps |
| **Backtest Engine** (Day 21) | ★★★★ | ★★★★★ | The hot loop — Rust wins on raw throughput |
| **Performance Analyzer** (Day 22) | ★★★★ | ★★★★ | Metrics computation — either works |
| **Parameter Optimization** (Day 23) | ★★★ | ★★★★★ | Grid search / batch runs — Rust's parallelism shines |
| **Strategy Portfolio** (Day 24) | ★★★★ | ★★★★ | Weight allocation + correlation — either works |
| **Agent/LLM Integration** | ★★★★★ | ★★ | Go's simplicity + HTTP/gRPC >> Rust for AI plumbing |
| **Broker API Integration** | ★★★★★ | ★★★ | Alpaca/IBKR REST/WebSocket = Go's sweet spot |
| **Real-time Data Pipeline** | ★★★★★ | ★★★★ | Concurrent streaming = goroutines |

**Score: Go 43/55, Rust 40/55** — Go wins on breadth and infrastructure
fit; Rust wins on the compute-intensive modules.

### 4.5 The Hybrid Approach (Recommended for the Future)

The best architecture for our project is:

```
┌──────────────────────────────────────────────────────┐
│                    Go (primary)                       │
│                                                      │
│  Market Data ── Strategy ── Order ── Broker ── Agent │
│      │              │         │        │        │    │
│      └──────────────┴─────────┴────────┴────────┘    │
│                          │                           │
│                    CGo / FFI                         │
│                          │                           │
│              ┌───────────┴───────────┐               │
│              │   Rust (hot paths)    │               │
│              │                       │               │
│              │  • Backtest engine    │               │
│              │  • Parameter optim.   │               │
│              │  • Risk calculations  │               │
│              └───────────────────────┘               │
└──────────────────────────────────────────────────────┘
```

1. **Phase 1 (now):** Build everything in Go. The 7-module pipeline,
   broker integration, agent layer. Performance is sufficient for daily/
   hourly bar strategies.
2. **Phase 2 (later):** Profile. If the backtest engine is the bottleneck,
   rewrite *just that module* in Rust and link via CGo.
3. **Phase 3 (if needed):** Add Python bindings to the Rust core for
   research/alpha experimentation.

This is exactly what **hftbacktest** does — Rust core with Python bindings
via PyO3. And what **Qlib** does — C++ core with Python wrapper.

---

## 5. Quant Libraries Worth Studying (Cross-Language)

### 5.1 Architecture Reference Projects

| Project | Language | ★ | Why Study It |
|---|---|---|---|
| [QuantConnect/Lean](https://github.com/QuantConnect/Lean) | C# | 21k | The gold standard for OSS algo trading architecture. Event-driven, multi-asset, cloud-native. Read their module decomposition. |
| [freqtrade](https://github.com/freqtrade/freqtrade) | Python | 54k | Best-in-class strategy API design, hyperopt, risk management. Read their `IStrategy` interface. |
| [barter-rs/barter-rs](https://github.com/barter-rs/barter-rs) | Rust | 2.2k | Cleanest Rust event-driven architecture. Good reference for our event types and module boundaries. |
| [nkaz001/hftbacktest](https://github.com/nkaz001/hftbacktest) | Rust | 4.6k | Order-level simulation with realistic queue modeling. Read their market microstructure handling. |
| [microsoft/qlib](https://github.com/microsoft/qlib) | Python/C++ | 48k | AI-oriented quant platform. Study their factor research → production pipeline. |

### 5.2 Specific Technical References

| Need | Reference | Language |
|---|---|---|
| Sliding window indicator calc | [cinar/indicator](https://github.com/cinar/indicator) | Go |
| Order book + matching engine | [intrepidkarthi/orderbook](https://github.com/intrepidkarthi/orderbook) | Go |
| Decimal arithmetic for money | [shopspring/decimal](https://github.com/shopspring/decimal) | Go |
| Event-driven backtest architecture | [barter-rs/barter-rs](https://github.com/barter-rs/barter-rs) | Rust |
| HFT queue simulation | [nkaz001/hftbacktest](https://github.com/nkaz001/hftbacktest) | Rust |
| Portfolio optimization | [avhz/RustQuant](https://github.com/avhz/RustQuant) | Rust |
| Full algo trading platform | [QuantConnect/Lean](https://github.com/QuantConnect/Lean) | C# |

---

## 6. Decision Matrix: Should We Use Go or Rust?

### 6.1 Choose Go If…

- ✅ You want to **ship fast** — days to productive vs weeks
- ✅ Your strategy frequency is **daily or hourly bars** (not tick-level HFT)
- ✅ The system needs **concurrent data streaming, API integration, agent
  orchestration** (Go's sweet spot)
- ✅ You want a **large hiring pool** for future team expansion
- ✅ You value **simple, readable code** that can be reviewed quickly
- ✅ Your bottleneck is **I/O and network**, not CPU (data feeds, broker APIs,
  LLM calls)

### 6.2 Choose Rust If…

- ✅ You need **deterministic low latency** (no GC pauses) — tick-level or
  sub-millisecond trading
- ✅ You're building a **pure compute engine** (backtesting millions of
  parameter combinations)
- ✅ **Memory safety without GC** is a hard requirement (e.g., embedded or
  regulatory-driven)
- ✅ You want to build a **library with Python bindings** (PyO3 ecosystem)
- ✅ You have **experienced Rust developers** on the team

### 6.3 Our Project's Decision: **Go, with a Rust escape hatch**

| Factor | Our Context | Favors |
|---|---|---|
| Strategy frequency | Daily/hourly bars | Go |
| Primary bottleneck | LLM agent latency (~1–10s per decision) | Go (irrelevant) |
| Team size | Solo/small team | Go (productivity) |
| Time to market | Want to ship working system | Go (faster) |
| Existing codebase | Days 16–24 already in Go | Go (sunk cost) |
| Future performance needs | Parameter grid search may be slow | Rust (later) |
| Broker integration | Alpaca REST + WebSocket | Go |
| Agent integration | HTTP/gRPC to LLM providers | Go |

**The verdict is clear: Go is the right language for this project.**

The only scenario where Rust becomes necessary is if we later need to
optimize the backtest engine for large-scale parameter sweeps (Day 23).
At that point, we can rewrite the hot loop in Rust and link it via CGo —
without changing any of the surrounding Go architecture.

---

## 7. The "Why Not Both?" Architecture

For completeness, here's what a mature polyglot quant stack looks like,
informed by what top funds actually do:

```
┌─────────────────────────────────────────────────────────────┐
│                     RESEARCH LAYER                          │
│  Python (pandas, Qlib, PyTorch, scikit-learn)               │
│  • Factor research  • Signal mining  • ML model training    │
│  • Jupyter notebooks  • Experiment tracking                 │
├─────────────────────────────────────────────────────────────┤
│                    PLATFORM LAYER (Go)                      │
│  • Data ingestion & normalization                           │
│  • Strategy orchestration & signal routing                  │
│  • Order management & broker communication                  │
│  • Real-time portfolio tracking                             │
│  • Agent/LLM integration (MCP servers)                      │
│  • Monitoring, alerting, dashboards                         │
├─────────────────────────────────────────────────────────────┤
│                  COMPUTE LAYER (Rust, optional)             │
│  • Backtest engine core (if performance-critical)           │
│  • Parameter optimization grid search                       │
│  • Risk calculation engine (VaR, CVaR, Greeks)              │
│  • Portfolio optimization (mean-variance, Black-Litterman)  │
│  • Exposed to Go via CGo, to Python via PyO3                │
├─────────────────────────────────────────────────────────────┤
│                  EXECUTION LAYER                            │
│  • Broker APIs (Alpaca, IBKR) via Go                        │
│  • FIX protocol (if needed) via C++ or Rust                 │
│  • WebSocket market data feeds via Go                       │
└─────────────────────────────────────────────────────────────┘
```

This mirrors:
- **Two Sigma's** architecture (Python research → JVM platform → C++ execution)
- **Qlib's** architecture (Python API → C++ compute core)
- **Lean's** architecture (C# platform → C++ performance modules)

---

## 8. Summary & Recommendations

| Recommendation | Priority | Action |
|---|---|---|
| **Continue with Go** as primary language | 🔴 High | Don't rewrite. The existing Go codebase is the right foundation. |
| **Use `shopspring/decimal`** for all money math | 🔴 High | Never use `float64` for prices, amounts, or P&L. |
| **Use `cinar/indicator`** for technical analysis | 🟡 Medium | Covers SMA, EMA, RSI, MACD, Bollinger etc. Don't reinvent. |
| **Study `barter-rs` architecture** | 🟡 Medium | Cleanest event-driven design in Rust; steal the patterns for our Go code. |
| **Study `freqtrade` strategy API** | 🟡 Medium | Best OSS strategy interface design; inform our Day-19 Strategy module. |
| **Consider Rust for backtest core** | 🟢 Low (future) | Only if parameter optimization becomes the bottleneck. Profile first. |
| **Add Python bindings** | 🟢 Low (future) | When/if research layer is needed, expose Go/Rust core to Python. |
| **Never use `float64` for money** | 🔴 High | Use `shopspring/decimal` or fixed-point integers (cents). |

---

## References

- GitHub API star counts pulled 2026-08-30
- [The Bell: Why Trading AIs Lose to Simple Strategies](https://thebell.io/mnimoe-prevoskhodstvo-pochemu-torgovye-ii-proigryvayut-prosteyshey-strategii)
- [Jane Street's Tech Talk on OCaml in Trading](https://www.janestreet.com/tech-talks/)
- [Go vs Rust performance comparisons](https://programming-language-benchmarks.vercel.app/go-vs-rust)
- [QuantConnect Lean Architecture Docs](https://www.quantconnect.com/docs/v2/writing-algorithms)
- [hftbacktest: Realistic HFT Backtesting](https://hftbacktest.readthedocs.io/)
- [Barter-rs: Event-Driven Trading Framework](https://barter.rs/)
- [RustQuant: Quantitative Finance in Rust](https://docs.rs/RustQuant/latest/RustQuant/)
- [cinar/indicator: Technical Analysis in Go](https://github.com/cinar/indicator)
- [shopspring/decimal: Arbitrary-Precision Decimal in Go](https://github.com/shopspring/decimal)
