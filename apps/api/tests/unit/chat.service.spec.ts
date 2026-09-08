/**
 * ChatService tests (phase-3b-plan §"Tests"): tool-loop sequencing, the
 * 5-round loop guard (incl. the forced no-tools final round), the 20-call
 * session cap with `cap-reached`, AgentDecision cache hits on an identical
 * repeat turn ($0), message/session persistence + resume, token-total
 * accumulation, and tool-arg validation errors returned to the model as
 * `{ error }` payloads. Scripted fake LlmClient (pipeline-test idiom) +
 * throwaway SQLite via the test-db helper.
 */
import { NotFoundException } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmClient, LlmRequest, LlmResponse } from "@agentic-trading/agents";
import { LlmError } from "@agentic-trading/agents";
import { createTestDatabase, destroyTestDatabase, type TestDatabase } from "../helpers/test-db.js";
import { PrismaService } from "../../src/prisma.service.js";
import { ReportsService } from "../../src/reports/reports.service.js";
import { ChatConfig, resolveChatConfig } from "../../src/chat/chat-config.js";
import { CHAT_PROMPT_VERSION, buildChatSystemPrompt } from "../../src/chat/chat-prompts.js";
import { ChatService, MAX_TOOL_ROUNDS, SESSION_LLM_CALL_CAP, type ChatEvent } from "../../src/chat/chat.service.js";
import { validateArgs } from "../../src/chat/tools.js";

/** Scripted fake client: pops one response per call, records requests. */
function scriptedClient(script: Partial<LlmResponse>[]): { client: LlmClient; requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  let i = 0;
  return {
    requests,
    client: {
      async chat(req: LlmRequest): Promise<LlmResponse> {
        requests.push(req);
        const next = script[Math.min(i++, script.length - 1)]!;
        return { content: "", usage: null, ...next };
      },
    },
  };
}

const toolCall = (name: string, args: unknown, id = "call_1"): LlmResponse["toolCalls"] => [
  { id, name, argumentsJson: JSON.stringify(args) },
];

async function drain(gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

describe("ChatService", () => {
  let db: TestDatabase;
  let prisma: PrismaService;

  const makeService = (client: LlmClient): ChatService => {
    const config = Object.create(ChatConfig.prototype) as ChatConfig;
    Object.assign(config, { configured: true, model: "chat-model", client });
    return new ChatService(prisma, new ReportsService(prisma), config);
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
    prisma = new PrismaService();
    await prisma.$connect();

    // Minimal report data so tools have something to return.
    await prisma.instrument.create({ data: { symbol: "AAPL", market: "US", currency: "USD" } });
    const screenRun = await prisma.screenRun.create({
      data: { market: "US", universeSize: 1, ok: 1, genuinelyAbsent: 0, fetchFailed: 0, degraded: false, warningsJson: "[]" },
    });
    await prisma.screenResult.create({
      data: { runId: screenRun.id, symbol: "AAPL", rank: 1, score: 0.9, metricsJson: JSON.stringify({ close: 230.5 }) },
    });
    await prisma.deepDiveRun.create({
      data: { market: "US", screenRunId: screenRun.id, topN: 1, llmCalls: 5, cacheHits: 1, failed: 0, warningsJson: "[]" },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    destroyTestDatabase(db);
    delete process.env.DATABASE_URL;
  });

  it("runs a tool-call round then answers: sequencing, persistence, events", async () => {
    const { client, requests } = scriptedClient([
      { content: "", toolCalls: toolCall("getDailyReport", { market: "US" }) },
      { content: "AAPL leads the US screen.", usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } },
    ]);
    const service = makeService(client);
    const { id } = await service.createSession();
    const events = await drain(service.streamMessage(id, "What's on the US screen?"));

    // usage fires after EVERY live call (running session totals).
    expect(events.map((e) => e.type)).toEqual(["usage", "status", "status", "usage", "chunk", "done"]);
    expect(events[1]).toMatchObject({ type: "status", phase: "start", tool: "getDailyReport", args: { market: "US" } });
    expect(events[2]).toMatchObject({ type: "status", phase: "end", tool: "getDailyReport" });
    expect(events[3]).toMatchObject({ type: "usage", llmCalls: 2, promptTokens: 100, completionTokens: 20 });
    expect(events[4]).toMatchObject({ type: "chunk", text: "AAPL leads the US screen." });

    // Two live calls: tools offered on round 1, response drove round 2.
    expect(requests).toHaveLength(2);
    expect(requests[0]!.tools?.map((t) => t.name)).toEqual(["getDailyReport", "getDeepDive", "getTranscriptEntry", "getPriceHistory", "compareSymbols", "listRuns"]);
    const round2 = requests[1]!.messages;
    expect(round2.at(-2)).toMatchObject({ role: "assistant", toolCalls: [{ id: "call_1", name: "getDailyReport" }] });
    expect(round2.at(-1)!.role).toBe("tool");
    expect(round2.at(-1)!.toolCallId).toBe("call_1");
    expect(round2.at(-1)!.content).toMatch(/^<tool-data name="getDailyReport">\n\{/);
    expect(round2.at(-1)!.content).toContain('"market":"US"');

    // Persistence: user, tool exchange, assistant; title from first message.
    const detail = await service.getSession(id);
    expect(detail.title).toBe("What's on the US screen?");
    expect(detail.messages.map((m) => m.role)).toEqual(["user", "tool", "assistant"]);
    expect(detail.messages[1]).toMatchObject({ toolName: "getDailyReport", toolArgsJson: '{"market":"US"}' });
    expect(JSON.parse(detail.messages[1]!.content)).toMatchObject({ market: "US" });
    expect(detail.llmCalls).toBe(2);
    expect(detail.promptTokens).toBe(100);
    expect(detail.completionTokens).toBe(20);
  });

  it("replays history across turns (tool rows become user-role tool-data blocks)", async () => {
    const { client, requests } = scriptedClient([
      { content: "", toolCalls: toolCall("listRuns", {}) },
      { content: "One US run." },
      { content: "Follow-up answer." },
    ]);
    const service = makeService(client);
    const { id } = await service.createSession();
    await drain(service.streamMessage(id, "List the runs"));
    await drain(service.streamMessage(id, "and the second one?"));
    const turn2 = requests[2]!.messages;
    // system + user1 + tool-data replay + assistant1 + user2
    expect(turn2.map((m) => m.role)).toEqual(["system", "user", "user", "assistant", "user"]);
    expect(turn2[2]!.content).toMatch(/^<tool-data name="listRuns">/);
  });

  it("loop guard: the 5th round is issued without tools; empty answer there is a loop-guard error", async () => {
    const alwaysTools = scriptedClient([{ content: "", toolCalls: toolCall("listRuns", {}) }]);
    const service = makeService(alwaysTools.client);
    const { id } = await service.createSession();
    const events = await drain(service.streamMessage(id, "loop forever"));
    // 5 live calls, 4 executed tool rounds (round 5 has no tools, so its
    // toolCalls cannot be acted on — wait: the fake returns toolCalls even
    // without tools; withTools=false on round 5 → falls through to text
    // check with empty content → loop-guard.
    expect(alwaysTools.requests).toHaveLength(MAX_TOOL_ROUNDS);
    expect(alwaysTools.requests[3]!.tools).toBeDefined();
    expect(alwaysTools.requests[4]!.tools).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "error", error: "loop-guard" });
    expect(events.filter((e) => e.type === "status" && e.phase === "start")).toHaveLength(MAX_TOOL_ROUNDS - 1);
  });

  it("session cap: 20 live calls then a typed cap-reached error, no further LLM calls", async () => {
    const { client, requests } = scriptedClient([{ content: "ok" }]);
    const service = makeService(client);
    const { id } = await service.createSession();
    await prisma.chatSession.update({ where: { id }, data: { llmCalls: SESSION_LLM_CALL_CAP } });
    const events = await drain(service.streamMessage(id, "one more?"));
    expect(events.map((e) => e.type)).toEqual(["error"]);
    expect(events[0]).toMatchObject({ type: "error", error: "cap-reached" });
    expect(requests).toHaveLength(0);
    // The session stays readable and the user message was persisted.
    const detail = await service.getSession(id);
    expect(detail.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("AgentDecision cache: an identical first turn in a second session costs 0 live calls", async () => {
    const { client, requests } = scriptedClient([
      { content: "", toolCalls: toolCall("getDailyReport", { market: "US" }) },
      { content: "Cached answer." },
    ]);
    const service = makeService(client);
    const countDecisions = () => prisma.agentDecision.count({ where: { agent: "chat" } });

    const before = await countDecisions();
    const s1 = await service.createSession();
    await drain(service.streamMessage(s1.id, "same question"));
    expect(requests).toHaveLength(2);
    expect(await countDecisions()).toBe(before + 2); // one audit row per live call

    const s2 = await service.createSession();
    const events = await drain(service.streamMessage(s2.id, "same question"));
    expect(requests).toHaveLength(2); // no new live calls
    expect(await countDecisions()).toBe(before + 2); // cache replay records nothing
    expect(events.map((e) => e.type)).toEqual(["status", "status", "chunk", "done"]); // no usage event: nothing live
    expect(events.at(-2)).toMatchObject({ type: "chunk", text: "Cached answer." });
    const detail = await service.getSession(s2.id);
    expect(detail.llmCalls).toBe(0);

    // Audit rows carry agent="chat" and the chat prompt version.
    const rows = await prisma.agentDecision.findMany({ where: { agent: "chat" }, orderBy: { id: "desc" }, take: 2 });
    expect(rows.every((r) => r.promptVersion === CHAT_PROMPT_VERSION && r.model === "chat-model")).toBe(true);
  });

  it("LlmError surfaces as an llm-failure event, never a throw", async () => {
    const failing: LlmClient = {
      async chat() {
        throw new LlmError("http", "llm http-500: boom", 500);
      },
    };
    const service = makeService(failing);
    const { id } = await service.createSession();
    const events = await drain(service.streamMessage(id, "hi"));
    expect(events).toEqual([{ type: "error", error: "llm-failure", message: "llm http-500: boom" }]);
  });

  it("tool-arg validation failures go back to the model as { error } payloads", async () => {
    const { client, requests } = scriptedClient([
      { content: "", toolCalls: toolCall("getDailyReport", { market: "CN" }) },
      { content: "", toolCalls: toolCall("getDailyReport", {}) }, // missing required market
      { content: "", toolCalls: toolCall("noSuchTool", {}) },
      { content: "Recovered." },
    ]);
    const service = makeService(client);
    const { id } = await service.createSession();
    const events = await drain(service.streamMessage(id, "screen?"));
    expect(events.at(-2)).toMatchObject({ type: "chunk", text: "Recovered." });
    const toolMsgs = requests.at(-1)!.messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(3);
    for (const m of toolMsgs) {
      expect(m.content).toContain('"error"');
    }
    expect(toolMsgs[0]!.content).toContain("must be one of US|HK");
    expect(toolMsgs[1]!.content).toContain("missing required argument");
    expect(toolMsgs[2]!.content).toContain("unknown tool");
  });

  it("service 404s also reach the model as { error } payloads", async () => {
    const { client, requests } = scriptedClient([
      { content: "", toolCalls: toolCall("getPriceHistory", { symbol: "NOSUCH" }) },
      { content: "Unknown symbol." },
    ]);
    const service = makeService(client);
    const { id } = await service.createSession();
    await drain(service.streamMessage(id, "price of NOSUCH?"));
    const toolMsg = requests.at(-1)!.messages.find((m) => m.role === "tool")!;
    expect(toolMsg.content).toContain('"error"');
    expect(toolMsg.content).toContain('unknown symbol \\"NOSUCH\\"');
  });

  it("session title truncates long first messages", async () => {
    const { client } = scriptedClient([{ content: "ok" }]);
    const service = makeService(client);
    const { id } = await service.createSession();
    await drain(service.streamMessage(id, "x".repeat(120)));
    expect((await service.getSession(id)).title).toBe("x".repeat(80));
  });

  it("listSessions returns newest-first summaries with usage totals", async () => {
    const { client } = scriptedClient([{ content: "ok", usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } }]);
    const service = makeService(client);
    const { id } = await service.createSession();
    await drain(service.streamMessage(id, "hello"));
    const sessions = await service.listSessions();
    const mine = sessions.find((s) => s.id === id)!;
    expect(mine).toMatchObject({ title: "hello", llmCalls: 1, promptTokens: 5, completionTokens: 2 });
    expect(typeof mine.createdAt).toBe("string");
  });

  it("getSession 404s on unknown sessions; streamMessage too", async () => {
    const { client } = scriptedClient([{ content: "ok" }]);
    const service = makeService(client);
    await expect(service.getSession(9999)).rejects.toBeInstanceOf(NotFoundException);
    await expect(drain(service.streamMessage(9999, "hi"))).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("ChatConfig resolution", () => {
  it("unconfigured when chat env is missing (no throw, module stays up)", () => {
    const config = resolveChatConfig({}, { loadEnvFiles: false });
    expect(config.configured).toBe(false);
    expect(config.client).toBeNull();
  });

  it("configured with LLM_BASE_URL + LLM_API_KEY + LLM_CHAT_MODEL", () => {
    const config = resolveChatConfig(
      { LLM_BASE_URL: "http://localhost:1234/v1", LLM_API_KEY: "k", LLM_CHAT_MODEL: "k3-256k" },
      { loadEnvFiles: false },
    );
    expect(config.configured).toBe(true);
    expect(config.model).toBe("k3-256k");
  });
});

describe("chat prompt", () => {
  it("is byte-deterministic for a fixed date", () => {
    expect(buildChatSystemPrompt("2026-09-08")).toBe(buildChatSystemPrompt("2026-09-08"));
    expect(buildChatSystemPrompt("2026-09-08")).not.toBe(buildChatSystemPrompt("2026-09-09"));
    expect(buildChatSystemPrompt("2026-09-08")).toContain("Today's date: 2026-09-08.");
  });
});

describe("validateArgs", () => {
  const schema = {
    type: "object",
    properties: { market: { type: "string", enum: ["US", "HK"] }, runId: { type: "integer" }, symbols: { type: "array", items: { type: "string" } } },
    required: ["market"],
  };
  it("accepts valid args and rejects bad ones with messages", () => {
    expect(validateArgs(schema, { market: "US" })).toBeNull();
    expect(validateArgs(schema, { market: "US", runId: 3, symbols: ["A", "B"] })).toBeNull();
    expect(validateArgs(schema, {})).toBe('missing required argument "market"');
    expect(validateArgs(schema, { market: 3 })).toBe('argument "market" must be a string');
    expect(validateArgs(schema, { market: "CN" })).toBe('argument "market" must be one of US|HK');
    expect(validateArgs(schema, { market: "US", runId: 1.5 })).toBe('argument "runId" must be an integer');
    expect(validateArgs(schema, { market: "US", symbols: ["A", 2] })).toBe('argument "symbols" must be an array of strings');
    expect(validateArgs(schema, "nope")).toBe("arguments must be a JSON object");
  });
});
