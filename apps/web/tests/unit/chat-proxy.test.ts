import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sessionsRoute from "@/app/api/chat/sessions/route";
import * as sessionRoute from "@/app/api/chat/sessions/[id]/route";
import * as messagesRoute from "@/app/api/chat/sessions/[id]/messages/route";

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("chat SSE proxy route handlers", () => {
  beforeEach(() => {
    vi.stubEnv("API_INTERNAL_URL", "http://api.test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("503s cleanly when API_INTERNAL_URL is unset", async () => {
    vi.unstubAllEnvs();
    const res = await sessionsRoute.POST();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: expect.stringContaining("not configured") });
  });

  it("POST /api/chat/sessions forwards method and relays the upstream response", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 9 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await sessionsRoute.POST();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.test/chat/sessions",
      expect.objectContaining({ method: "POST" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 9 });
  });

  it("relays an upstream 503 (chat unconfigured) with its body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "chat is not configured" }), { status: 503 })),
    );
    const res = await sessionsRoute.POST();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ message: "chat is not configured" });
  });

  it("502s cleanly when the upstream is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("connection refused"))));
    const res = await sessionsRoute.GET();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "api unreachable" });
  });

  it("GET /api/chat/sessions/:id forwards the id", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await sessionRoute.GET(new Request("http://web.test/api/chat/sessions/4"), params("4"));
    expect(fetchMock).toHaveBeenCalledWith("http://api.test/chat/sessions/4", expect.anything());
  });

  it("POST messages streams the SSE body through with text/event-stream", async () => {
    const sse =
      'event: chunk\ndata: {"type":"chunk","text":"hel"}\n\nevent: chunk\ndata: {"type":"chunk","text":"lo"}\n\nevent: done\ndata: {"type":"done","messageId":3}\n\n';
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(sse));
              c.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const req = new Request("http://web.test/api/chat/sessions/3/messages", {
      method: "POST",
      body: JSON.stringify({ content: "hi" }),
    });
    const res = await messagesRoute.POST(req, params("3"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.test/chat/sessions/3/messages",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ content: "hi" }) }),
    );
    // body is a stream, not buffered text — read it through the reader
    expect(res.body).toBeInstanceOf(ReadableStream);
    const reader = res.body!.getReader();
    let out = "";
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    expect(out).toBe(sse);
  });

  it("POST messages relays pre-stream http errors (e.g. 404) instead of streaming", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "session not found" }), { status: 404 })),
    );
    const req = new Request("http://web.test/api/chat/sessions/99/messages", {
      method: "POST",
      body: JSON.stringify({ content: "hi" }),
    });
    const res = await messagesRoute.POST(req, params("99"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "session not found" });
  });

  it("POST messages 503s cleanly when API_INTERNAL_URL is unset", async () => {
    vi.unstubAllEnvs();
    const req = new Request("http://web.test/api/chat/sessions/3/messages", {
      method: "POST",
      body: JSON.stringify({ content: "hi" }),
    });
    const res = await messagesRoute.POST(req, params("3"));
    expect(res.status).toBe(503);
  });

  it("POST messages 502s cleanly when the upstream is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))));
    const req = new Request("http://web.test/api/chat/sessions/3/messages", {
      method: "POST",
      body: JSON.stringify({ content: "hi" }),
    });
    const res = await messagesRoute.POST(req, params("3"));
    expect(res.status).toBe(502);
  });
});
