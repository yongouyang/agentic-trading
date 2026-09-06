# Phase 2 Plan — Lean Agent Pipeline + Persisted Daily Reports

Planning session 2026-09-06 (deep tier). All forks decided by the user;
this document is the execution spec. Architecture: `architecture-v1.md`
§5 step 4 + §7. Phase 1 + hardening plan are complete and accepted.

## Locked decisions (2026-09-06)

| Fork | Decision |
|---|---|
| Fundamentals analyst source | **eastmoney F10 three-statements, stocks only.** HK ETFs skip the fundamentals analyst entirely (a tracker's deep-dive is index/tracking, not Piotroski) — news + technicals only. F10 has no ETF records and no US dividend feed, but DOES carry HK+US three-statement history (measured: 00700 = 1,124/585/966 rows; TSLA 537/525/1,654). |
| News/sentiment sourcing | **Google News RSS per name (both lanes; CN+EN queries for HK) + Yahoo news as supplement** where the endpoint cooperates. Cap ~10 headlines (title/source/date). The LLM judges sentiment itself — no separate sentiment model. |
| Structured output | **Prompt + strict validate + exactly 1 repair round** ("return valid JSON per this schema"), then fail the name loudly. Provider-agnostic; no reliance on `response_format` support. |
| Deep-dive breadth | **Top 10 per lane** (~20 names/day ≈ 120–160 LLM calls), plus `--symbol` for ad-hoc names, `--top N` to tune. |
| Model assignment | **Local: Kimi (Moonshot) for all three roles.** Deploy (AWS via GitHub Actions): **DeepSeek `deepseek-v4-flash`** — profile already proven in ib-learning-site. |

## Provider/model configuration (env contract)

```
LLM_BASE_URL        # local: https://api.moonshot.cn/v1 · deploy: https://api.deepseek.com/v1
LLM_API_KEY         # platform key (see warning below)
LLM_ANALYST_MODEL   # role-specific model IDs; local default: same Kimi ID for all three
LLM_DEBATE_MODEL
LLM_VERDICT_MODEL
```

**Measured constraint (from ib-learning-site `docs/ai-feedback.md`, verified
with a probe Lambda):** `api.moonshot.cn` is intermittently **blackholed from
AWS ap-east-1** (TLS connects, then 8/8 connect timeouts); `api.moonshot.ai`
requires international-platform keys. DeepSeek's endpoint is globally fronted.
⇒ the deploy profile is DeepSeek-only; this is not a preference but a
network fact. Also: a Kimi Code CLI subscription credential is a product
login, NOT an open-platform API key — the local profile needs a Moonshot
platform key in `.env` (user supplies; model IDs are env values, never
hardcoded).

Deploy secret pattern (mirrors ib-learning-site): one JSON GitHub secret
holding the full env set. v1 runs locally; deploy is post-v1.

## Persistence (Prisma, matching warningsJson/metricsJson idiom)

```prisma
model AgentDecision {
  id           Int      @id @default(autoincrement())
  hash         String   @unique  // sha256(agent|model|promptVersion|system|user)
  agent        String   // "news-analyst" | "fundamentals-analyst" | "bull" | "bear" | "verdict"
  model        String
  promptVersion String  // bumped when any prompt changes — without it, later
                        // accuracy scoring compares different questions
  systemPrompt String
  userPrompt   String
  responseText String
  usageJson    String?  // prompt/completion tokens when the provider reports them
  createdAt    DateTime @default(now())
}

model DeepDiveRun {
  id          Int      @id @default(autoincrement())
  runAt       DateTime @default(now())
  market      String   // "US" | "HK"
  screenRunId Int      // the ScreenRun this deep-dive follows
  topN        Int
  llmCalls    Int
  cacheHits   Int
  failed      Int
  warningsJson String
  reports     DeepDiveReport[]
}

model DeepDiveReport {
  id           Int      @id @default(autoincrement())
  runId        Int
  symbol       String
  status       String   // "ok" | "failed:<slug>" — per-name isolation, never aborts the run
  verdictJson  String?  // Verdict (packages/agents) serialized
  decisionHashesJson String? // every AgentDecision hash behind this verdict (audit trail)
  run          DeepDiveRun @relation(fields: [runId], references: [id])
  @@unique([runId, symbol])
}
```

**Cache semantics**: the data snapshot travels INSIDE the user prompt, so an
unchanged snapshot produces an identical hash ⇒ $0 rerun with zero extra
validity logic. Load-bearing consequence: **prompt builders are
byte-deterministic** — fixed number rounding, stable ordering, explicit
`asOf`. Golden-file unit tests enforce this; a non-deterministic builder is
a test failure, not a surprise bill.

## Module design

`packages/agents` (pure, no I/O beyond an injected client):
- `llm-client.ts` — OpenAI-compatible chat-completions via plain `fetch`
  (no new dependency; project idiom). Timeout (60s), 1 retry on transport
  error, usage capture. Fully injectable → tests never touch the network.
- `prompts.ts` — deterministic builders: system+user per agent role from a
  `DeepDiveContext`. Owns `PROMPT_VERSION`.
- `pipeline.ts` — per-name flow with injected client + decision-log port:
  news analyst + fundamentals analyst in parallel (ETFs: news only) →
  bull/bear debate 2 rounds (4 calls) → verdict (1 call) = 7 calls/stock,
  6/ETF. Cache lookup before every call.
- `verdict.ts` — strict parser/validator for the verdict JSON + the single
  repair-round protocol. Extends the pinned `Verdict` contract with
  `asOf` and `promptVersion`.

`apps/api`:
- `src/market-data/eastmoney-f10.provider.ts` — extend with statement
  endpoints (akshare-measured reportNames: `RPT_HKF10_FN_MAININDICATOR`,
  `RPT_HKF10_FN_{BALANCE,INCOME,CASHFLOW}_PC`). A one-off probe step pins
  exact fields before the snapshot assembler is written (§2.3 of
  `research-akshare-tickdb.md`: 12/12 reachable at ~1s pacing).
- `src/agents/context.ts` — `DeepDiveContext` assembly: screen metrics from
  `ScreenResult.metricsJson` + recent store bars summary + F10 fundamentals
  snapshot (stocks) + news headlines.
- `src/agents/news.ts` — Google News RSS per name (HK: CN+EN), Yahoo news
  supplement; top ~10 headlines, failure-as-value (news absence degrades a
  report section, never the run).
- `src/cli/deep-dive.ts` + script `screen:deep-dive` — reads the latest
  `ScreenRun` per lane, takes top N, concurrency pool ~4, per-name
  try/catch → `failed:<slug>`, `--max-calls` budget guard (default 200)
  that aborts BEFORE overspend, persists DeepDiveRun + reports.

## Tests (vitest, no live LLM)

- Prompt-builder determinism goldens (same context → byte-identical prompts).
- Verdict parser: valid, schema-violation, repair-round success, repair
  failure → loud name failure.
- Cache: second identical pipeline run makes zero client calls.
- Pipeline: fake client scripted responses; ETF path skips fundamentals.
- Context assembler: F10 snapshot shaping, news capping, HK CN+EN queries.
- CLI: budget guard, per-name failure isolation, persistence shape.

## Build order & acceptance

1. Prisma migration (AgentDecision + DeepDiveRun + DeepDiveReport).
2. packages/agents: llm-client + verdict parser + prompt builders (+tests).
3. F10 statement probe (one-off, pin fields) → context assembler (+tests).
4. News assembler (+tests).
5. pipeline.ts (+tests) → CLI wiring.
6. Live smoke: `screen:deep-dive -- --market hk --top 2` on the Kimi local
   profile — verify report rows, decision-log rows, cache-hit rerun at $0.

**Acceptance:** suites green + tsc clean; one live smoke run persists a
well-formed DeepDiveRun with verdicts passing schema validation; an
immediate rerun makes zero LLM calls (cache); a corrupted fake verdict
response exercises the repair path end-to-end.

## Cost envelope

~20 names/day × 7 calls ≈ 140 calls/day. At Moonshot/Kimi pricing this is
pennies/day (architecture §5). The `--max-calls` guard + token caps make
runaway spend a loud failure, never a silent bill.
