/**
 * Chat controller integration (phase-3b): boot the real AppModule against a
 * throwaway SQLite db with ChatConfig overridden — (a) unconfigured: chat's
 * LLM-touching routes 503 while reports/health stay up (the "exactly one
 * guarded LLM path" invariant); (b) configured with a fake client: the
 * message endpoint streams standard SSE framing (event:/data: pairs). No
 * network, deterministic.
 */
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmClient } from "@agentic-trading/agents";
import { AppModule } from "../../src/app.module.js";
import { ChatConfig, resolveChatConfig } from "../../src/chat/chat-config.js";
import { PrismaService } from "../../src/prisma.service.js";
import { createTestDatabase, destroyTestDatabase, type TestDatabase } from "../helpers/test-db.js";

async function boot(dbUrl: string, config: ChatConfig): Promise<{ app: INestApplication; baseUrl: string }> {
  process.env.DATABASE_URL = dbUrl;
  const prisma = new PrismaService();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .overrideProvider(ChatConfig)
    .useValue(config)
    .compile();
  const app = moduleRef.createNestApplication();
  await app.listen(0);
  return { app, baseUrl: (await app.getUrl()).replace("[::1]", "localhost") };
}

describe("chat routes, unconfigured", () => {
  let app: INestApplication;
  let baseUrl: string;
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    ({ app, baseUrl } = await boot(db.url, resolveChatConfig({}, { loadEnvFiles: false }) as ChatConfig));
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATABASE_URL;
    destroyTestDatabase(db);
  });

  it("POST /chat/sessions and POST messages 503; GETs and reports stay up", async () => {
    expect((await fetch(`${baseUrl}/chat/sessions`, { method: "POST" })).status).toBe(503);
    expect((await fetch(`${baseUrl}/chat/sessions/1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    })).status).toBe(503);
    // Read-only chat routes stay readable (empty db → empty list, 404 detail).
    expect((await fetch(`${baseUrl}/chat/sessions`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/chat/sessions/1`)).status).toBe(404);
    // The rest of the API is unaffected.
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
    const daily = await fetch(`${baseUrl}/reports/daily?market=US`);
    expect(daily.status).toBe(404); // no data — but NOT a 503
  });
});

describe("chat routes, configured (fake client)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    const client: LlmClient = {
      async chat() {
        return { content: "Hello from the fake model.", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
      },
    };
    const config = Object.create(ChatConfig.prototype) as ChatConfig;
    Object.assign(config, { configured: true, model: "fake-chat", client });
    ({ app, baseUrl } = await boot(db.url, config));
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATABASE_URL;
    destroyTestDatabase(db);
  });

  it("create session → post message streams SSE events → history persisted", async () => {
    const created = await fetch(`${baseUrl}/chat/sessions`, { method: "POST" });
    expect(created.status).toBe(201);
    const { id } = await created.json();

    const res = await fetch(`${baseUrl}/chat/sessions/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    // Standard framing: event: <type>\ndata: <json>\n\n
    const frames = body.split("\n\n").filter(Boolean);
    const parsed = frames.map((f) => {
      const [eventLine, dataLine] = f.split("\n");
      return { event: eventLine!.replace(/^event: /, ""), data: JSON.parse(dataLine!.replace(/^data: /, "")) };
    });
    expect(parsed.map((f) => f.event)).toEqual(["usage", "chunk", "done"]);
    expect(parsed[0]!.data).toMatchObject({ type: "usage", llmCalls: 1, promptTokens: 10, completionTokens: 5 });
    expect(parsed[1]!.data).toMatchObject({ type: "chunk", text: "Hello from the fake model." });
    expect(parsed[2]!.data.type).toBe("done");

    const detail = await (await fetch(`${baseUrl}/chat/sessions/${id}`)).json();
    expect(detail.title).toBe("hi");
    expect(detail.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    expect(detail.llmCalls).toBe(1);

    const list = await (await fetch(`${baseUrl}/chat/sessions`)).json();
    expect(list.some((s: { id: number }) => s.id === id)).toBe(true);
  });

  it("400 on empty content, 404 on unknown session, 400 on non-numeric id", async () => {
    const created = await (await fetch(`${baseUrl}/chat/sessions`, { method: "POST" })).json();
    const post = (sid: string | number, body: unknown) =>
      fetch(`${baseUrl}/chat/sessions/${sid}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post(created.id, { content: "  " })).status).toBe(400);
    expect((await post(created.id, {})).status).toBe(400);
    expect((await post(9999, { content: "hi" })).status).toBe(404);
    expect((await post("abc", { content: "hi" })).status).toBe(400);
  });
});
