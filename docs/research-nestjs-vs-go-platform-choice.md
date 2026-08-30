# Research: NestJS vs Go for the Trading Platform

**Date:** 2026-08-30 · **Scope:** Honest evaluation of whether to build the
agentic trading platform in NestJS (TypeScript) instead of Go, given the
actual deployment context: **single Mac Mini, daily data processing, no
existing code** (Days 16–24 are docs only, nothing implemented yet).

---

## 1. TL;DR

**For a single Mac Mini processing daily bars, NestJS is arguably the better
choice.** The previous Go recommendation was made in a vacuum (generic
"which language is best for quant"). In the real context — solo developer,
daily batch frequency, LLM-heavy agent layer, web dashboard needs — NestJS
offers faster time-to-value with no meaningful performance sacrifice.

Go's advantages (single binary, raw speed, concurrency model) are solutions
to problems we don't have:
- Single binary? We're on one Mac — `pm2 start` works fine.
- Raw speed? Daily bars + LLM calls at ~2–10s each — Node.js is plenty fast.
- Concurrency? Daily batch is sequential by nature.

NestJS's advantages (familiarity, ecosystem, built-in architecture, web
dashboard, AI SDKs) solve problems we *do* have.

**Recommendation: Use NestJS. Revisit Go only if we scale to distributed
multi-machine or intraday tick-level processing.**

---

## 2. Real Workload Analysis

Before comparing languages, let's quantify what the system actually does
on a typical day:

### 2.1 Daily Processing Cycle

```
06:00  ┌─ Cron triggers daily pipeline
       │
06:01  ├─ 1. Download OHLCV data
       │     ~50–200 stocks/ETFs × 1 API call each
       │     ~5–30 seconds total (network-bound)
       │
06:01  ├─ 2. Update indicators (SMA, EMA, RSI, MACD...)
       │     ~50–200 stocks × ~1000 bars × ~5 indicators
       │     ~0.5–2 seconds total (compute-bound)
       │
06:02  ├─ 3. Generate strategy signals
       │     ~1–5 strategies × ~50–200 stocks
       │     ~0.1–1 second total (compute-bound)
       │
06:02  ├─ 4. LLM agent analysis (the slow part!)
       │     ~1–5 LLM calls × 2–10 seconds each
       │     ~10–50 seconds total (network-bound)
       │
06:03  ├─ 5. Risk checks + order generation
       │     ~milliseconds
       │
06:03  ├─ 6. Submit orders to broker API
       │     ~1–5 API calls × ~1 second each
       │     ~5 seconds total (network-bound)
       │
06:03  ├─ 7. Update portfolio + performance metrics
       │     ~milliseconds
       │
06:03  └─ Done. System idle for ~23h 57m.
```

### 2.2 Where Time Is Actually Spent

| Phase | Time | Bottleneck | Node.js OK? |
|---|---|---|---|
| Data download | 5–30s | **Network I/O** | ✅ Yes |
| Indicator calc | 0.5–2s | Compute | ✅ Yes (trivial) |
| Strategy signals | 0.1–1s | Compute | ✅ Yes (trivial) |
| LLM agent calls | 10–50s | **Network I/O** | ✅ Yes |
| Order execution | ~5s | **Network I/O** | ✅ Yes |
| Portfolio update | <0.1s | Compute | ✅ Yes |
| **Total daily run** | **~30–90s** | | |

**The system is idle 99.9% of the time.** The only compute-heavy phase
(indicators + signals) takes <2 seconds in Node.js. The bottleneck is
*always* network I/O (API calls, LLM calls). **Go's 2–3x compute advantage
saves you less than 1 second per day.**

### 2.3 Backtesting Workload (On-Demand)

When you run a backtest manually:

| Scenario | Node.js Time | Go Time | Difference |
|---|---|---|---|
| 1 strategy, 5 years daily bars (~1,260 bars) | ~50ms | ~15ms | 35ms (irrelevant) |
| 5 strategies, 10 years (~2,520 bars each) | ~500ms | ~150ms | 350ms (irrelevant) |
| Parameter sweep: 100 combos × 5 years | ~5s | ~1.5s | 3.5s (noticeable, but acceptable) |
| Parameter sweep: 1,000 combos × 10 years | ~50s | ~15s | 35s (this is where Go wins) |

**Verdict:** For daily operations, Node.js is fine. Only large parameter
sweeps would benefit from Go/Rust, and even then, 50 seconds is acceptable
for a batch job you run occasionally.

---

## 3. NestJS Architecture Fit

### 3.1 NestJS Modules Map Perfectly to Our 7-Module Design

```
src/
├── market-data/          # Day 17: CSV/API data reader
│   ├── market-data.module.ts
│   ├── market-data.service.ts    ← Data ingestion
│   ├── csv-reader.service.ts
│   └── alpaca-data.service.ts    ← Broker API data
│
├── indicators/           # Day 18: SMA, EMA, RSI, MACD
│   ├── indicators.module.ts
│   ├── sma.service.ts
│   ├── ema.service.ts
│   └── rsi.service.ts
│
├── strategy/             # Day 19: Signal generation
│   ├── strategy.module.ts
│   ├── strategy.service.ts       ← Signal struct/interface
│   ├── dual-ma.strategy.ts       ← Concrete strategy
│   └── strategy.interface.ts
│
├── broker/               # Day 20: Trade simulation
│   ├── broker.module.ts
│   ├── broker.service.ts
│   ├── alpaca-broker.service.ts  ← Live broker
│   └── paper-broker.service.ts   ← Paper trading
│
├── portfolio/            # Day 24: Portfolio management
│   ├── portfolio.module.ts
│   ├── portfolio.service.ts
│   └── allocation.service.ts
│
├── backtest/             # Day 21: Backtest engine
│   ├── backtest.module.ts
│   ├── backtest-engine.service.ts
│   └── trade-simulator.service.ts
│
├── performance/          # Day 22: Performance analyzer
│   ├── performance.module.ts
│   ├── metrics.service.ts        ← Sharpe, MDD, return
│   └── report.service.ts
│
├── optimizer/            # Day 23: Parameter optimization
│   ├── optimizer.module.ts
│   ├── grid-search.service.ts
│   └── overfit-guard.service.ts
│
├── agent/                # LLM agent layer
│   ├── agent.module.ts
│   ├── analyst.service.ts        ← Market analysis
│   ├── risk-gate.service.ts      ← Risk checks
│   └── llm-client.service.ts     ← OpenAI/Anthropic client
│
├── scheduler/            # Daily cron orchestration
│   ├── scheduler.module.ts
│   └── daily-pipeline.service.ts ← BullMQ / @Cron
│
├── api/                  # REST API + WebSocket
│   ├── api.module.ts
│   ├── dashboard.controller.ts   ← Web dashboard API
│   └── ws.gateway.ts             ← Real-time updates
│
└── app.module.ts         # Root module wiring
```

**NestJS's DI container + module system is almost a 1:1 mapping to our
architecture.** Each `module.ts` defines boundaries, each `service.ts` is a
clean unit. The @Module/@Injectable decorators enforce the separation of
concerns we designed in Day 6.

### 3.2 NestJS Built-in Solutions for Our Needs

| Need | NestJS Solution | Go Equivalent |
|---|---|---|
| Module system | `@Module()` decorators (built-in) | Manual package organization |
| Dependency injection | `@Injectable()` (built-in) | Wire manually or use `wire`/`dig` |
| Scheduled jobs | `@Cron()` via `@nestjs/schedule` | `robfig/cron` (3rd party) |
| Task queues | `@nestjs/bull` (BullMQ) | `asynq` or `machinery` (3rd party) |
| REST API | `@Controller()` (built-in) | `gin`/`fiber` (3rd party) |
| WebSocket | `@WebSocketGateway()` (built-in) | `gorilla/websocket` (3rd party) |
| Validation | `class-validator` + `ValidationPipe` | `go-playground/validator` (3rd party) |
| Config | `@nestjs/config` | `viper` or `koanf` (3rd party) |
| Database | `@nestjs/typeorm` or Prisma | `gorm` or `sqlx` (3rd party) |
| Auth | `@nestjs/passport` (built-in) | Manual JWT/OAuth |
| Testing | Jest (built-in) | `go test` (built-in) |
| CLI | `@nestjs/cli` scaffolding | `cobra` (3rd party) |
| Health checks | `@nestjs/terminus` | Manual |

**In Go, you'd choose and glue together ~10 third-party libraries.**
**In NestJS, they're all first-party, documented together, and designed
to work as a system.**

---

## 4. The TypeScript Ecosystem Advantage

### 4.1 Financial/Math Libraries

| Library | Purpose | Maturity |
|---|---|---|
| [decimal.js](https://github.com/MikeMcl/decimal.js) (3k★) | Arbitrary-precision decimal (like `shopspring/decimal`) | **Mature** (10+ years) |
| [technicalindicators](https://github.com/anandanand84/technicalindicators) (1.4k★) | SMA, EMA, RSI, MACD, Bollinger, etc. | **Mature** |
| [portfolio-analytics](https://github.com/...) | Sharpe, Sortino, MDD, VaR | Moderate |
| [simple-statistics](https://github.com/simple-statistics/simple-statistics) (1.4k★) | Statistical functions (correlation, regression) | **Mature** |
| [date-fns](https://github.com/date-fns/date-fns) (35k★) | Date/time handling for market calendars | **Mature** |

**Verdict:** TypeScript's financial library ecosystem is *adequate*. Not as
broad as Python, but covers everything we need for daily-bar strategies.
`decimal.js` + `technicalindicators` covers our core math needs.

### 4.2 AI/LLM Ecosystem (Where TypeScript Wins)

| Library | ★ | Notes |
|---|---|---|
| [Vercel AI SDK](https://github.com/vercel/ai) | 14k+ | Best-in-class LLM streaming, tool use, multi-provider. TypeScript-native. |
| [LangChain.js](https://github.com/langchain-ai/langchainjs) | 12k+ | Agent frameworks, chains, memory, tools. Full parity with Python LangChain. |
| [OpenAI SDK](https://github.com/openai/openai-node) | 8k+ | Official, TypeScript-first. |
| [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript) | 3k+ | Official, TypeScript-first. |
| [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk) | 5k+ | Official MCP SDK. TypeScript is the *reference implementation*. |

**This is where TypeScript has a decisive advantage over Go.** The AI/LLM
ecosystem in TypeScript is:
- **First-class** — OpenAI, Anthropic, Vercel all ship TypeScript SDKs first
- **More mature** — LangChain.js has 12k★ vs Go's LangChainGo at ~3k★
- **Better typed** — The SDKs leverage TypeScript's type system heavily
- **MCP-native** — The official MCP SDK is TypeScript; Go's is community-maintained

For an **agentic** trading platform where LLM integration is a core feature
(not an afterthought), TypeScript's AI ecosystem is a genuine competitive
advantage.

### 4.3 Full-Stack Advantage

With NestJS + TypeScript:
- **One language** for backend, frontend (React/Next.js), scripts, CLI tools
- **Shared types** — `Signal`, `Order`, `Position`, `PerformanceReport`
  interfaces used across the entire stack
- **One package manager** — `pnpm` workspace with `apps/api` + `apps/web`
- **One type checker** — catch API contract mismatches at compile time

With Go:
- Backend in Go, frontend in TypeScript anyway
- API types defined twice (Go structs + TypeScript interfaces)
- Or use code generation (OpenAPI → TypeScript) which adds complexity

---

## 5. Honest Downsides of NestJS

### 5.1 Performance Ceiling

| Metric | Node.js | Go | Impact on Us |
|---|---|---|---|
| Startup time | ~1–3s | ~0.01s | Negligible (always-on) |
| Idle memory | ~80–150MB | ~20–40MB | Mac Mini has 16GB+ RAM |
| Peak memory (backtest) | ~300–500MB | ~100–200MB | Fine for single-user |
| GC pause | ~1–10ms | ~0.5–2ms | Irrelevant at daily freq |
| Max throughput | ~10K ops/sec | ~100K ops/sec | We need ~100 ops/day |

**Verdict:** The performance gap exists but is irrelevant for our use case.
A Mac Mini M2 has 16GB RAM — Node.js using 150MB is nothing.

### 5.2 TypeScript's Type System Is Weaker Than Go's

TypeScript's types are **structural and erasable** — they exist only at
compile time and can be bypassed with `as any`. Go's types are **nominal
and enforced at runtime**.

**Mitigation:**
- Use strict mode (`"strict": true` in tsconfig.json)
- Use Zod for runtime validation of external data (market data, API responses)
- Use branded types for money: `type USD = number & { readonly __brand: 'USD' }`
- Never use `any` — treat it like `unsafe` in Rust

### 5.3 Decimal.js Is Slower Than Go's shopspring/decimal

| Operation | decimal.js | Go shopspring | Python decimal |
|---|---|---|---|
| Add two decimals | ~1μs | ~0.1μs | ~5μs |
| Multiply | ~2μs | ~0.2μs | ~8μs |

For our scale (hundreds of calculations per day), this is irrelevant.
But if we ever process millions of ticks, Go's decimal would matter.

### 5.4 No Institutional-Grade Quant Framework

Unlike Go (which has `cinar/indicator`) or Rust (which has `hftbacktest`,
`barter-rs`, `RustQuant`), TypeScript has **no battle-tested quant framework**.
We'd be building most of the quant core from scratch.

**This is the same situation as Go** — neither has a dominant quant
framework. But we've already designed the architecture (Days 6–24), so
we're building from scratch regardless of language.

---

## 6. Go's Remaining Advantages (and Whether They Matter)

| Go Advantage | Does It Matter for Us? | Why |
|---|---|---|
| **Single static binary** | 🟡 Somewhat | `pm2` + compiled JS works fine on Mac Mini. But Go binary is cleaner. |
| **2–3x faster compute** | 🔴 No | Daily bars + LLM calls → compute is not the bottleneck. Saves <1s/day. |
| **Better concurrency model** | 🔴 No | Daily batch is sequential. No need for 10K concurrent goroutines. |
| **Lower memory footprint** | 🔴 No | Mac Mini has 16GB+. Node using 150MB vs Go's 30MB is irrelevant. |
| **Deterministic latency (no GC)** | 🔴 No | We're not doing HFT. 10ms GC pauses don't matter. |
| **Stronger type safety** | 🟡 Somewhat | TypeScript strict + Zod covers 90% of cases. Go catches more at compile time. |
| **Better quant libraries** | 🟡 Somewhat | `cinar/indicator` and `shopspring/decimal` are nice. But `technicalindicators` + `decimal.js` cover the same ground. |
| **Future distributed scaling** | 🔴 No (currently) | If we ever need to scale to multiple machines, Go wins. But YAGNI. |

**Score: 0 items where Go's advantage is critical, 3 where it's somewhat
helpful, 5 where it's irrelevant.**

---

## 7. Developer Velocity Comparison

This is the hardest to quantify but the most important for a solo project.

### 7.1 Lines of Code Estimate

For the same 7-module system:

| Component | NestJS (est.) | Go (est.) | Notes |
|---|---|---|---|
| Module boilerplate | ~50 lines (decorators) | ~200 lines (manual wiring) | NestJS DI reduces boilerplate |
| Data layer (ORM) | ~100 lines (Prisma/TypeORM) | ~300 lines (sqlx + migrations) | ORM vs raw SQL |
| REST API | ~80 lines (decorators) | ~200 lines (gin handlers) | NestJS is more concise |
| WebSocket | ~30 lines (gateway) | ~100 lines (gorilla) | NestJS abstracts protocol |
| Cron scheduler | ~20 lines (@Cron) | ~80 lines (robfig/cron) | Decorator vs manual |
| Validation | ~30 lines (class-validator) | ~100 lines (manual) | Declarative vs imperative |
| Config | ~20 lines (ConfigService) | ~60 lines (viper) | Similar |
| Error handling | Moderate (try/catch) | Verbose (if err != nil) | Go is more verbose |
| **Total platform code** | **~2,000 lines** | **~3,500 lines** | **~40% more code in Go** |

### 7.2 Time to First Working Backtest

| Step | NestJS | Go |
|---|---|---|
| Project setup | `nest new` → 30s | `go mod init` → 10s |
| Choose & configure libraries | ~2 hours (known ecosystem) | ~4 hours (research + glue) |
| Data reader module | ~2 hours | ~3 hours |
| Indicator module | ~2 hours | ~2 hours |
| Strategy module | ~2 hours | ~3 hours |
| Backtest engine | ~4 hours | ~4 hours |
| Wire everything together | ~1 hour (DI handles it) | ~3 hours (manual wiring) |
| **Total to first backtest** | **~13 hours** | **~19 hours** |

**Estimated 30% faster in NestJS** due to DI, decorators, and ecosystem
familiarity.

---

## 8. Recommended NestJS Architecture

### 8.1 Project Structure (Monorepo)

```
agentic-trading/
├── apps/
│   ├── api/                # NestJS backend
│   │   ├── src/
│   │   │   ├── market-data/
│   │   │   ├── indicators/
│   │   │   ├── strategy/
│   │   │   ├── broker/
│   │   │   ├── portfolio/
│   │   │   ├── backtest/
│   │   │   ├── performance/
│   │   │   ├── optimizer/
│   │   │   ├── agent/
│   │   │   ├── scheduler/
│   │   │   └── api/
│   │   └── package.json
│   │
│   └── web/                # Next.js frontend (future)
│       └── package.json
│
├── packages/
│   ├── shared-types/       # Shared TypeScript interfaces
│   │   ├── signal.ts
│   │   ├── order.ts
│   │   ├── position.ts
│   │   └── performance.ts
│   │
│   ├── market-data/        # Data sources (reusable)
│   └── indicators/         # Technical indicators (reusable)
│
├── data/                   # Local data storage
│   ├── daily/              # OHLCV CSV files
│   └── db/                 # SQLite or PostgreSQL
│
├── pnpm-workspace.yaml
├── turbo.json              # Turborepo build orchestration
└── package.json
```

### 8.2 Key Technology Choices

| Concern | Choice | Why |
|---|---|---|
| **Framework** | NestJS 10+ | Module system, DI, decorators |
| **Language** | TypeScript 5.x (strict) | Type safety, ecosystem |
| **Runtime** | Node.js 22 LTS | Stable, good performance |
| **Database** | SQLite (via Prisma) | Single-file, zero config, perfect for Mac Mini |
| **Decimal math** | `decimal.js` | Never use `number` for money |
| **Indicators** | `technicalindicators` | SMA, EMA, RSI, MACD, Bollinger |
| **Statistics** | `simple-statistics` | Correlation, regression, Sharpe |
| **Scheduler** | `@nestjs/schedule` + `@nestjs/bull` | Cron + queue |
| **LLM** | Vercel AI SDK | Multi-provider streaming, tool use |
| **MCP** | `@modelcontextprotocol/sdk` | Official TypeScript SDK |
| **Validation** | `zod` + `class-validator` | Runtime + compile-time |
| **Process manager** | PM2 | Auto-restart, log management |
| **Testing** | Jest + `@nestjs/testing` | Built-in |

### 8.3 Money Safety Pattern

```typescript
import Decimal from 'decimal.js';

// Branded type for type-level safety
type USD = Decimal & { readonly __brand: 'USD' };

// Factory function (single point of creation)
function usd(amount: string | number): USD {
  return new Decimal(amount).toDecimalPlaces(2) as USD;
}

// Usage throughout the codebase
const price = usd('150.25');
const quantity = usd('10');
const total = price.mul(quantity) as USD;  // $1,502.50

// Never do this:
const bad: number = 150.25;  // ❌ float64 money
const worse = 0.1 + 0.2;     // ❌ 0.30000000000000004
```

---

## 9. When to Reconsider Go

Switch to Go (or add a Go microservice) only if:

| Trigger | Why Go | Probability |
|---|---|---|
| Strategy frequency moves to **intraday tick-level** | Need sub-ms latency, no GC | 🟢 Low |
| System scales to **multiple machines** | Go's binary deployment + concurrency | 🟢 Low |
| Parameter sweep needs **10,000+ combinations** | Go/Rust 3x compute advantage | 🟡 Medium |
| **Regulatory requirement** for auditable binaries | Single binary = single artifact | 🔴 Very Low |
| Team grows and **Go developers join** | Split modules by team expertise | 🟡 Medium |

**The migration path is clean:** if any of these triggers fire, extract that
specific module into a Go microservice that the NestJS platform calls via
HTTP/gRPC. You don't rewrite the whole system.

---

## 10. Comparison with Other Alternatives

For completeness, other options considered and rejected:

| Option | Why Not |
|---|---|
| **Python (FastAPI/Django)** | Best quant ecosystem but: poor type safety, no built-in DI/module system, GIL for concurrency, messy deployment, slower runtime. Better as a research *companion* to NestJS. |
| **Rust (Axum/Actix)** | Best performance but: steepest learning curve, smallest ecosystem for web/AI, compile times kill iteration speed. Overkill for daily batch. |
| **Java (Spring Boot)** | Similar architecture to NestJS but: verbose, heavy JVM, feels dated for a solo project. NestJS gives the same structure with less ceremony. |
| **C# (.NET)** | Surprisingly good (Lean uses it) but: smaller AI/LLM ecosystem, less community support for trading use cases outside QuantConnect. |
| **Elixir (Phoenix)** | Excellent concurrency (BEAM), good for real-time, but: tiny quant/AI ecosystem, niche hiring pool, steep learning curve for functional paradigm. |

---

## 11. Final Decision Matrix

| Factor | Weight | NestJS | Go | Winner |
|---|---|---|---|---|
| Developer velocity (solo) | 🔴 High | ★★★★★ | ★★★ | NestJS |
| LLM/AI ecosystem | 🔴 High | ★★★★★ | ★★ | NestJS |
| Module architecture fit | 🔴 High | ★★★★★ | ★★★★ | NestJS |
| Daily batch performance | 🟡 Medium | ★★★★ | ★★★★★ | Go (but irrelevant) |
| Quant library ecosystem | 🟡 Medium | ★★★ | ★★★ | Tie (both weak) |
| Money/math safety | 🟡 Medium | ★★★★ (decimal.js + Zod) | ★★★★★ (shopspring + types) | Go (slightly) |
| Web dashboard | 🟡 Medium | ★★★★★ (same language) | ★★ (separate frontend) | NestJS |
| Deployment simplicity | 🟡 Medium | ★★★★ (PM2) | ★★★★★ (single binary) | Go (slightly) |
| Future scalability | 🟢 Low | ★★★ | ★★★★★ | Go |
| Community for quant | 🟢 Low | ★★ | ★★★ | Go (slightly) |
| **Weighted Total** | | **4.2** | **3.4** | **NestJS** |

---

## 12. Summary

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  NESTJS (TypeScript)                                        │
│                                                             │
│  ✅ Perfect module system for our 7-module architecture     │
│  ✅ Best-in-class LLM/AI SDKs (Vercel AI, LangChain, MCP)   │
│  ✅ Faster development (DI, decorators, shared types)       │
│  ✅ One language for full stack                             │
│  ✅ Adequate performance for daily batch on Mac Mini        │
│  ✅ Huge npm ecosystem for every need                       │
│                                                             │
│  ⚠️  Weaker type system than Go (mitigated by strict + Zod) │
│  ⚠️  No institutional quant framework (build from scratch)  │
│  ⚠️  Not suitable for HFT/tick-level (not our use case)     │
│                                                             │
│  RECOMMENDED for: solo developer, Mac Mini, daily bars,     │
│  LLM-heavy agentic platform                                 │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  GO                                                         │
│                                                             │
│  ✅ Single binary deployment                                │
│  ✅ 2–3x faster compute                                     │
│  ✅ Better concurrency model                                │
│  ✅ Better quant libraries (indicator, decimal)             │
│  ✅ Stronger type system                                    │
│                                                             │
│  ⚠️  40% more code to write                                 │
│  ⚠️  Weaker LLM/AI ecosystem                                │
│  ⚠️  Manual DI and wiring                                   │
│  ⚠️  Separate frontend language needed                      │
│                                                             │
│  RECOMMENDED for: team, distributed system, intraday/HFT,   │
│  performance-critical backtesting                           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Bottom line:** For a solo developer building an agentic trading platform
on a single Mac Mini with daily processing, **NestJS is the pragmatic
choice**. It's not about which language is "best for quant" in theory —
it's about which language gets a working system in your hands fastest.

The previous Go recommendation was technically sound for a generic quant
platform. But given the real constraints (solo, daily, Mac Mini, LLM-heavy),
NestJS wins on the factors that actually matter.

---

## References

- GitHub API star counts pulled 2026-08-30
- [NestJS Documentation](https://docs.nestjs.com/)
- [decimal.js](https://github.com/MikeMcl/decimal.js) — arbitrary-precision decimal for JS
- [technicalindicators](https://github.com/anandanand84/technicalindicators) — TA library for JS/TS
- [Vercel AI SDK](https://sdk.vercel.ai/) — LLM integration framework
- [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Prisma ORM](https://www.prisma.io/) — TypeScript-first database toolkit
- [BullMQ](https://docs.bullmq.io/) — Redis-backed queue for Node.js
- [PM2 Process Manager](https://pm2.keymetrics.io/) — Node.js production runner
- [chrisleekr/binance-trading-bot](https://github.com/chrisleekr/binance-trading-bot) (5.5k★) — Reference NestJS trading bot
- [QuantiaAI/grid-pilot](https://github.com/QuantiaAI/grid-pilot) (212★) — NestJS trading bot reference
