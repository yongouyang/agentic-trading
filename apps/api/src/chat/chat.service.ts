/**
 * Chat service (phase-3b-plan): the tool-calling loop over persisted
 * sessions. Read-only by construction — the only side effects are
 * ChatSession/ChatMessage rows and AgentDecision audit rows (agent="chat");
 * tools are in-process ReportsService reads. Every LLM call is
 * content-addressed (sha256 over agent|model|promptVersion|system|serialized
 * messages) and looked up BEFORE the live call, so an exact-repeat turn costs
 * $0. Tool-call rounds store their toolCalls inside the AgentDecision
 * usageJson blob (responseText stays the plain assistant text) so a cached
 * round replays byte-identically.
 *
 * Guardrails (locked 2026-09-07): 20 live LLM calls per session (hard stop,
 * `cap-reached`), max 5 tool-call rounds per user message (the 5th round is
 * issued WITHOUT tools so the model must answer with what it has; an empty
 * answer there is a `loop-guard` error). LlmError → `llm-failure` event —
 * the generator never throws after the session pre-check.
 */
import { createHash } from "node:crypto";
import { Injectable, NotFoundException } from "@nestjs/common";
import type { LlmMessage, LlmRequest, LlmToolCall, LlmUsage } from "@agentic-trading/agents";
import { PrismaService } from "../prisma.service.js";
import { ReportsService } from "../reports/reports.service.js";
import { ChatConfig } from "./chat-config.js";
import { CHAT_PROMPT_VERSION, buildChatSystemPrompt } from "./chat-prompts.js";
import { buildChatTools, chatToolSchemas, executeToolCall, wrapToolData, type ChatTool } from "./tools.js";

export const SESSION_LLM_CALL_CAP = 20;
export const MAX_TOOL_ROUNDS = 5;
/** How many persisted messages are replayed into the context (the rest stays
 *  in SQLite, not the context). */
export const HISTORY_MESSAGES = 20;
/** Soft context bound: replayed history is trimmed oldest-first past this
 *  many characters (~token-bound without a tokenizer). */
export const HISTORY_CHAR_BUDGET = 60_000;
const TITLE_CHARS = 80;
const CHUNK_CHARS = 600;

export type ChatEvent =
  | { type: "status"; phase: "start" | "end"; tool: string; args?: unknown }
  | { type: "chunk"; text: string }
  | { type: "usage"; llmCalls: number; promptTokens: number; completionTokens: number }
  | { type: "done"; messageId: number }
  | { type: "error"; error: "cap-reached" | "llm-failure" | "loop-guard"; message: string };

export interface SessionSummary {
  id: number;
  title: string | null;
  createdAt: string;
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
}

export interface SessionDetail extends SessionSummary {
  messages: {
    id: number;
    role: string;
    content: string;
    toolName: string | null;
    toolArgsJson: string | null;
    createdAt: string;
  }[];
}

function chatHash(model: string, system: string, messages: LlmMessage[]): string {
  return createHash("sha256").update(`chat|${model}|${CHAT_PROMPT_VERSION}|${system}|${JSON.stringify(messages)}`).digest("hex");
}

/** Cached chat call payload: usage fields plus any toolCalls, stored flat in
 *  usageJson so responseText remains the plain assistant text. */
interface CachedChatCall {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  toolCalls?: LlmToolCall[];
}

@Injectable()
export class ChatService {
  private readonly tools: ChatTool[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly reports: ReportsService,
    private readonly config: ChatConfig,
  ) {
    this.tools = buildChatTools(reports);
  }

  get configured(): boolean {
    return this.config.configured;
  }

  async createSession(): Promise<{ id: number }> {
    const session = await this.prisma.chatSession.create({ data: {} });
    return { id: session.id };
  }

  async listSessions(): Promise<SessionSummary[]> {
    const sessions = await this.prisma.chatSession.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
    return sessions.map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt.toISOString(),
      llmCalls: s.llmCalls,
      promptTokens: s.promptTokens,
      completionTokens: s.completionTokens,
    }));
  }

  async getSession(id: number): Promise<SessionDetail> {
    const session = await this.prisma.chatSession.findUnique({ where: { id } });
    if (!session) throw new NotFoundException(`chat session ${id} not found`);
    const messages = await this.prisma.chatMessage.findMany({ where: { sessionId: id }, orderBy: { id: "asc" } });
    return {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt.toISOString(),
      llmCalls: session.llmCalls,
      promptTokens: session.promptTokens,
      completionTokens: session.completionTokens,
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        toolName: m.toolName,
        toolArgsJson: m.toolArgsJson,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  /** One user turn: persist the message, run the tool loop, stream events.
   *  Never throws — failures are `error` events. */
  async *streamMessage(sessionId: number, content: string): AsyncGenerator<ChatEvent> {
    const session = await this.prisma.chatSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException(`chat session ${sessionId} not found`);
    const client = this.config.client;
    const model = this.config.model;
    if (!this.config.configured || !client || !model) {
      yield { type: "error", error: "llm-failure", message: "chat is not configured (missing LLM chat env)" };
      return;
    }

    await this.prisma.chatMessage.create({ data: { sessionId, role: "user", content } });
    if (!session.title) {
      await this.prisma.chatSession.update({ where: { id: sessionId }, data: { title: content.slice(0, TITLE_CHARS) } });
    }

    let { llmCalls, promptTokens, completionTokens } = session;
    if (llmCalls >= SESSION_LLM_CALL_CAP) {
      yield { type: "error", error: "cap-reached", message: `session cap reached (${SESSION_LLM_CALL_CAP} LLM calls) — start a fresh session` };
      return;
    }

    const system = buildChatSystemPrompt(new Date().toISOString().slice(0, 10));
    const history = await this.loadHistory(sessionId);
    const messages: LlmMessage[] = [...history];
    let rounds = 0;

    while (true) {
      rounds++;
      const withTools = rounds < MAX_TOOL_ROUNDS;
      if (llmCalls >= SESSION_LLM_CALL_CAP) {
        yield { type: "error", error: "cap-reached", message: `session cap reached (${SESSION_LLM_CALL_CAP} LLM calls) — start a fresh session` };
        return;
      }

      const req: LlmRequest = {
        model,
        messages: [{ role: "system", content: system }, ...messages],
        maxTokens: 4096,
        ...(withTools ? { tools: chatToolSchemas(this.tools) } : {}),
      };
      const hash = chatHash(model, system, messages);
      const cached = await this.prisma.agentDecision.findUnique({ where: { hash } });

      let text: string;
      let toolCalls: LlmToolCall[] | undefined;
      if (cached) {
        // $0 replay: toolCalls ride inside the cached usageJson blob.
        let blob: CachedChatCall = { promptTokens: null, completionTokens: null, totalTokens: null };
        try {
          if (cached.usageJson) blob = { ...blob, ...(JSON.parse(cached.usageJson) as CachedChatCall) };
        } catch {
          // malformed cache row: replay text only
        }
        text = cached.responseText;
        toolCalls = blob.toolCalls;
      } else {
        let res;
        try {
          res = await client.chat(req);
        } catch (err) {
          yield { type: "error", error: "llm-failure", message: String((err as Error)?.message ?? err).slice(0, 300) };
          return;
        }
        llmCalls++;
        promptTokens += res.usage?.promptTokens ?? 0;
        completionTokens += res.usage?.completionTokens ?? 0;
        const usage: LlmUsage | null = res.usage;
        const blob: CachedChatCall = { ...(usage ?? { promptTokens: null, completionTokens: null, totalTokens: null }), ...(res.toolCalls?.length ? { toolCalls: res.toolCalls } : {}) };
        await this.prisma.agentDecision
          .create({
            data: {
              hash,
              agent: "chat",
              model,
              promptVersion: CHAT_PROMPT_VERSION,
              systemPrompt: system,
              userPrompt: JSON.stringify(messages),
              responseText: res.content,
              usageJson: JSON.stringify(blob),
            },
          })
          .catch((e: { code?: string }) => {
            if (e?.code === "P2002") return; // concurrent identical turn — cache won the race
            throw e;
          });
        await this.prisma.chatSession.update({
          where: { id: sessionId },
          data: { llmCalls: { increment: 1 }, promptTokens: { increment: usage?.promptTokens ?? 0 }, completionTokens: { increment: usage?.completionTokens ?? 0 } },
        });
        yield { type: "usage", llmCalls, promptTokens, completionTokens };
        text = res.content;
        toolCalls = res.toolCalls;
      }

      if (toolCalls?.length && withTools) {
        messages.push({ role: "assistant", content: text, toolCalls });
        for (const call of toolCalls) {
          let args: unknown = null;
          try {
            args = JSON.parse(call.argumentsJson || "{}");
          } catch {
            args = call.argumentsJson;
          }
          yield { type: "status", phase: "start", tool: call.name, args };
          let payload: unknown;
          try {
            payload = await executeToolCall(this.tools, call.name, call.argumentsJson);
          } catch (err) {
            // Store-level bug (not a 400/404 — those come back as payloads).
            yield { type: "error", error: "llm-failure", message: `tool ${call.name} failed: ${String((err as Error)?.message ?? err).slice(0, 200)}` };
            return;
          }
          yield { type: "status", phase: "end", tool: call.name };
          const toolContent = JSON.stringify(payload);
          messages.push({ role: "tool", toolCallId: call.id, content: wrapToolData(call.name, payload) });
          await this.prisma.chatMessage.create({
            data: { sessionId, role: "tool", content: toolContent, toolName: call.name, toolArgsJson: call.argumentsJson },
          });
        }
        continue;
      }

      if (!text) {
        // The forced final round (or a bare response) produced no text.
        yield { type: "error", error: "loop-guard", message: `model produced no answer after ${rounds} round(s)` };
        return;
      }
      for (let i = 0; i < text.length; i += CHUNK_CHARS) {
        yield { type: "chunk", text: text.slice(i, i + CHUNK_CHARS) };
      }
      const assistant = await this.prisma.chatMessage.create({ data: { sessionId, role: "assistant", content: text } });
      yield { type: "done", messageId: assistant.id };
      return;
    }
  }

  /** Last N persisted messages replayed as context. Tool rows replay as
   *  user-role tool-data blocks (OpenAI requires tool messages to follow a
   *  tool_calls assistant turn from the SAME request, so cross-turn replay
   *  uses the quoted-data form — which is also the injection posture). */
  private async loadHistory(sessionId: number): Promise<LlmMessage[]> {
    const rows = await this.prisma.chatMessage.findMany({ where: { sessionId }, orderBy: { id: "desc" }, take: HISTORY_MESSAGES });
    const messages: LlmMessage[] = rows.reverse().map((m) => {
      if (m.role === "tool") return { role: "user", content: wrapToolData(m.toolName ?? "tool", safeParse(m.content)) };
      return { role: m.role as "user" | "assistant", content: m.content };
    });
    // Soft char budget: drop the oldest replayed messages first, never the
    // trailing (current) user message.
    while (messages.length > 1 && messages.reduce((n, m) => n + m.content.length, 0) > HISTORY_CHAR_BUDGET) {
      messages.shift();
    }
    return messages;
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}
