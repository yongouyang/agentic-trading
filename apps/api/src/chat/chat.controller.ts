/**
 * Chat controller (phase-3b-plan §"API surface"). The message endpoint is an
 * SSE stream (event: <type>\ndata: <json>\n\n) built from the service's
 * ChatEvent generator; the web side proxies it through verbatim. The 503
 * guard lives HERE (not at module load): when chat env is missing the module
 * still loads and only the LLM-touching routes (create session, post
 * message) 503 — session history stays readable and reports routes are never
 * affected.
 */
import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Res, ServiceUnavailableException } from "@nestjs/common";
import type { Response } from "express";
import { ChatConfig } from "./chat-config.js";
import { ChatService, type SessionDetail, type SessionSummary } from "./chat.service.js";

/** Parse a path-param session id: BadRequest on non-numeric. */
function parseSessionId(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new BadRequestException(`session id must be a positive integer, got "${raw}"`);
  return n;
}

@Controller("chat")
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly config: ChatConfig,
  ) {}

  private assertConfigured(): void {
    if (!this.config.configured) {
      throw new ServiceUnavailableException("chat is not configured — set LLM_BASE_URL, LLM_API_KEY (or LLM_API_KEY_FILE) and LLM_CHAT_MODEL");
    }
  }

  /** POST /chat/sessions → { id }. */
  @Post("sessions")
  async createSession(): Promise<{ id: number }> {
    this.assertConfigured();
    return this.chat.createSession();
  }

  /** GET /chat/sessions — recent sessions for the resume picker. Read-only,
   *  stays up even when chat is unconfigured. */
  @Get("sessions")
  async listSessions(): Promise<SessionSummary[]> {
    return this.chat.listSessions();
  }

  /** GET /chat/sessions/:id — full message history + usage totals. */
  @Get("sessions/:id")
  async getSession(@Param("id") id: string): Promise<SessionDetail> {
    return this.chat.getSession(parseSessionId(id));
  }

  /** POST /chat/sessions/:id/messages { content } → SSE stream of ChatEvent
   *  (event: <type>\ndata: <json>\n\n). Raw express res rather than @Sse —
   *  @Sse registers GET-only. 404/400/503 are thrown BEFORE the stream opens
   *  (real HTTP status codes); once streaming, failures arrive as `error`
   *  events. */
  @Post("sessions/:id/messages")
  @HttpCode(200) // POST defaults to 201; SSE answers 200
  async postMessage(@Param("id") id: string, @Body() body: { content?: unknown }, @Res() res: Response): Promise<void> {
    this.assertConfigured();
    const sessionId = parseSessionId(id);
    const content = typeof body?.content === "string" ? body.content.trim() : "";
    if (!content) throw new BadRequestException("content must be a non-empty string");
    await this.chat.getSession(sessionId); // 404 before the stream opens
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders();
    try {
      for await (const ev of this.chat.streamMessage(sessionId, content)) {
        res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      }
    } finally {
      res.end();
    }
  }
}
