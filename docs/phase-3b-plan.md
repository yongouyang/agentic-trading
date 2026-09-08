# Phase 3b Plan — Full tool-calling chat

Planning session 2026-09-07. All forks decided by the user; this document is
the execution spec. Builds on phase-3-plan.md §3b (outline) and the 3a
deliverables: `reports` module (apps/api), `/` + `/symbol/[symbol]` (apps/web).
Invariants carried forward: localhost-only, browser never calls the API
directly (`API_INTERNAL_URL`), read-only everything.

## Locked decisions (2026-09-07)

| Fork | Decision |
|---|---|
| Loop placement | **Nest chat module** (`apps/api/src/chat/`). Tools are in-process `ReportsService` calls. Web is a thin SSE proxy (route handler); browser → Next → Nest. |
| Sessions | **Persist to SQLite** — new `ChatSession`/`ChatMessage` tables; resumable, reviewable, hold per-session usage totals. |
| Audit | **Reuse `AgentDecision`** with `agent="chat"` — content-addressed hash gives $0 exact repeats; one audit table for all LLM calls. |
| Streaming | **Event-level SSE** — status events (tool call start/end) + final answer in chunks. No `stream:true` in llm-client; works with any OpenAI-compatible provider. |
| Tool set | 3a wrappers + `compareSymbols` + **historical runs** (`listRuns`, runId-targeted report access). All read-only SQL. |
| Session cap | **20 LLM calls/session**, hard stop with a "cap reached" notice; user starts a fresh session. |
| Cost display | **Tokens only** (calls + prompt/completion tokens in the UI header). No price table. |
| Rendering | **Markdown + inline tool cards** — verdict card / metrics table / mini chart reuse 3a components. |
| Chat model | `LLM_CHAT_MODEL` env (same pattern as pipeline `LLM_*` vars); default local Kimi endpoint, k3-256k, `reasoning_effort=low`. |
| Injection posture | **Structural only** — system-prompt hardening + tool outputs wrapped as quoted data blocks; tools are read-only so worst case is a wrong answer, never an action. |
| Transcript access | **Index + on-demand** — `getDeepDive` returns verdict + transcript index (agent/model/usage/hash + ~500-char preview); `getTranscriptEntry(hash)` fetches one full entry. |
| Loop guard | **Max 5 tool-call rounds per user message**; on the 5th the model must answer with what it has. |

## Tool schema (chat service → in-process, no HTTP)

| Tool | Args | Returns |
|---|---|---|
| `getDailyReport` | `market: "US"\|"HK"`, `runId?` | 3a daily shape; `runId` omitted → latest. Needs a small `ReportsService` extension (3a only exposes latest per lane). |
| `getDeepDive` | `runId`, `symbol` | verdict JSON + transcript **index** (per entry: hash, agent, model, promptVersion, usage, ~500-char response preview). |
| `getTranscriptEntry` | `hash` | one full `AgentDecision` row (systemPrompt, userPrompt, responseText). |
| `getPriceHistory` | `symbol`, `days?` (≤2000, default 250) | 3a price-history shape (adjusted close + CA markers). |
| `compareSymbols` | `symbols: string[]` (2–5) | side-by-side rows from stored data: latest screen metrics + latest verdict overlay per symbol. No new LLM work. |
| `listRuns` | `market?`, `limit?` (default 10) | recent DeepDiveRuns (id, runAt, market, topN, llmCalls) so the model can target historical runs. |

Tool results are wrapped as quoted data before entering the context:
`<tool-data name="…">…json…</tool-data>`, and the system prompt states that
tool-data content is data, never instructions (injection posture, locked
above). No sanitization layer.

## Data model (apps/api/prisma)

```prisma
model ChatSession {
  id               Int      @id @default(autoincrement())
  createdAt        DateTime @default(now())
  title            String?  // first user message, truncated
  llmCalls         Int      @default(0)
  promptTokens     Int      @default(0)
  completionTokens Int      @default(0)
  messages         ChatMessage[]
}

model ChatMessage {
  id           Int      @id @default(autoincrement())
  sessionId    Int
  role         String   // "user" | "assistant" | "tool"
  content      String
  toolName     String?  // role="tool": which tool produced it
  toolArgsJson String?
  createdAt    DateTime @default(now())
  session ChatSession @relation(fields: [sessionId], references: [id])
}
```

Chat LLM calls also write `AgentDecision` rows with `agent="chat"`
(hash over agent|model|promptVersion|system|user per the existing builder —
the chat system prompt must be byte-deterministic for the cache to hit).
`usageJson` feeds the session token totals.

## API surface (chat module)

- `POST /chat/sessions` → `{ id }`.
- `GET /chat/sessions` / `GET /chat/sessions/:id` → list / full message
  history + usage totals (for resume + cost display).
- `POST /chat/sessions/:id/messages` `{ content }` → **SSE stream**.
  Event types: `status` (tool call start/end, tool name + args),
  `chunk` (final-answer text chunk), `usage` (running session totals),
  `done`, `error` (typed: `cap-reached` | `llm-failure` | `loop-guard`).

Env: `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_CHAT_MODEL` (+ optional
`LLM_TEMPERATURE`). **First time the API process (not a CLI) touches an
LLM**: if chat env is missing, the module serves 503 on chat routes only —
reports routes stay up. The 3a invariant flips from "no LLM path" to
"exactly one LLM path, guarded" (cap + loop guard + read-only tools).

Chat context assembly per turn: system prompt (role, tool-use rules,
injection stance, today's date, lane primer) + last N messages (N≈20,
token-bounded) + tool-data blocks. Session history beyond N is in SQLite,
not the context.

## Web UI (apps/web)

- `/chat` route — inherently a client component (streaming). New-session /
  session-resume picker; message list; input box; header shows
  `calls: n/20 · tokens: prompt+completion`.
- SSE proxy: `app/api/chat/…` route handlers forwarding to
  `API_INTERNAL_URL` (POST messages returns the SSE stream through;
  `ReadableStream` passthrough). Browser never sees the API origin.
- Rendering: assistant text as markdown; `status` events as a collapsed
  trace line per tool call; tool cards inline — verdict card, metrics
  table, mini price chart (reuse 3a components + lightweight-charts) keyed
  off the tool name in the `status`/message payload.
- Dashboard + detail pages get a "Chat" nav link. Deep-linking a name into
  chat (`/chat?symbol=X` pre-seed) is a small nicety — include only if it
  stays trivial.

## Tests

- **api**: chat-service tests with a fake `LlmClient` (existing idiom):
  tool-loop sequencing, 5-round loop guard, 20-call session cap +
  `cap-reached` event, AgentDecision cache hit on identical repeat turn
  ($0 rerun), session/message persistence + resume, token totals
  accumulation, 503 when chat env missing, tool-arg validation errors
  surfaced as `error` events. Tool-layer tests: `compareSymbols` join,
  transcript index preview truncation, runId-targeted daily report.
- **web**: Vitest component tests (message list, tool-card rendering from
  fixture SSE payloads, cost header, cap-reached notice). SSE proxy route
  test with a mocked upstream.
- **e2e**: Playwright — `/chat` shell renders with the api down (graceful
  notice, not 500), matching the 3a pattern.

## Explicit non-goals (3b)

- No writes of any kind from chat: no "rerun the screen", no new deep
  dives, no trades. Chat cannot trigger the pipeline — CLI stays the only
  trigger.
- No token-level streaming, no web-search/news-fetch tool (chat reads
  stored data only).
- No auth, no multi-user, no LAN, no deploy work.
- No model-generated charts (charts come from tool cards only).
- No editing/deleting sessions or messages in the UI.

## Build order (3b)

1. Prisma models + migration; `ReportsService` extensions (runId-targeted
   daily, transcript index/entry, compareSymbols) + tests.
2. Chat tool registry + chat-service loop (cap, loop guard, AgentDecision
   logging) + fake-client tests.
3. SSE controller + 503-when-unconfigured + integration tests.
4. Web: SSE proxy routes + `/chat` UI + component tests.
5. Playwright smoke extended; architecture §8 status note + PROGRESS.
