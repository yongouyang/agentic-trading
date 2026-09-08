import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/components/price-chart", () => ({
  PriceChart: () => <div data-testid="price-chart" />,
}));

import { ChatApp } from "@/app/chat/chat-app";
import { sessionSummaryFixture } from "./fixtures";

const enc = new TextEncoder();
const frame = (type: string, payload: unknown) => enc.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);

const baseSession = {
  id: 9,
  title: null,
  createdAt: "2026-09-08T00:00:00.000Z",
  llmCalls: 0,
  promptTokens: 0,
  completionTokens: 0,
  messages: [],
};

function stubFetch(opts: { messages: Response | (() => Response); sessionAfterSend?: object; sessionList?: object[] }) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/chat/sessions" && !init?.method) {
      return new Response(JSON.stringify(opts.sessionList ?? [sessionSummaryFixture]), { status: 200 });
    }
    if (url === "/api/chat/sessions" && init?.method === "POST") {
      return new Response(JSON.stringify({ id: 9 }), { status: 200 });
    }
    if (url === "/api/chat/sessions/9/messages") {
      return typeof opts.messages === "function" ? opts.messages() : opts.messages;
    }
    if (url === "/api/chat/sessions/9") {
      return new Response(JSON.stringify(opts.sessionAfterSend ?? baseSession), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

async function openNewSessionAndType(text = "hi") {
  fireEvent.click(await screen.findByRole("button", { name: "new session" }));
  const input = await screen.findByTestId("chat-input");
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "send" }));
}

describe("chat streaming states", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a trace line per tool call while streaming, then clears it on done", async () => {
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
    vi.stubGlobal(
      "fetch",
      stubFetch({
        messages: () => new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      }),
    );
    render(<ChatApp />);
    await openNewSessionAndType();

    ctl.enqueue(frame("status", { type: "status", phase: "start", tool: "getDailyReport", args: { market: "HK" } }));
    const trace = await screen.findByTestId("trace");
    expect(trace).toHaveTextContent("getDailyReport");
    expect(trace).toHaveTextContent("…");

    ctl.enqueue(frame("status", { type: "status", phase: "end", tool: "getDailyReport" }));
    await waitFor(() => expect(trace).toHaveTextContent("✓"));

    ctl.enqueue(frame("chunk", { type: "chunk", text: "partial answer" }));
    expect(await screen.findByTestId("msg-streaming")).toHaveTextContent("partial answer");

    ctl.enqueue(frame("done", { type: "done", messageId: 2 }));
    ctl.close();
    await waitFor(() => expect(screen.queryByTestId("trace")).toBeNull());
    expect(screen.queryByTestId("msg-streaming")).toBeNull();
  });

  it("tolerates comment frames and malformed data lines", async () => {
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
    vi.stubGlobal(
      "fetch",
      stubFetch({
        messages: () => new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      }),
    );
    render(<ChatApp />);
    await openNewSessionAndType();
    ctl.enqueue(enc.encode("event: ping\n\n"));
    ctl.enqueue(enc.encode("event: chunk\ndata: {not json\n\n"));
    ctl.enqueue(frame("error", { type: "error", error: "loop-guard", message: "" }));
    ctl.close();
    const err = await screen.findByTestId("chat-error");
    // empty message falls back to the typed error slug
    expect(err).toHaveTextContent("loop-guard");
  });

  it("shows the not-configured state when the message post 503s", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({ messages: new Response("{}", { status: 503 }) }),
    );
    render(<ChatApp />);
    await openNewSessionAndType();
    expect(await screen.findByTestId("chat-unconfigured")).toBeInTheDocument();
  });

  it("shows an inline error when the message post returns a non-sse error", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({ messages: new Response(JSON.stringify({ message: "unknown session" }), { status: 404 }) }),
    );
    render(<ChatApp />);
    await openNewSessionAndType();
    expect(await screen.findByTestId("chat-error")).toHaveTextContent("request failed (http 404)");
  });

  it("shows an inline error when the message post fails at the network level", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        messages: () => {
          throw new Error("socket hangup");
        },
      }),
    );
    render(<ChatApp />);
    await openNewSessionAndType();
    expect(await screen.findByTestId("chat-error")).toHaveTextContent("request failed (network)");
  });

  it("session picker: opening a session from the list; failures show a notice", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/chat/sessions" && !init?.method) {
        return new Response(JSON.stringify([{ ...sessionSummaryFixture, title: null }]), { status: 200 });
      }
      if (url === "/api/chat/sessions/1") return new Response("boom", { status: 500 });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatApp />);
    const list = await screen.findByTestId("session-list");
    expect(list).toHaveTextContent("untitled");
    list.querySelector("button")!.click();
    expect(await screen.findByTestId("chat-error")).toHaveTextContent("could not load session 1");
  });

  it("new-session failure (non-503) shows a notice", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/chat/sessions" && !init?.method) return new Response("[]", { status: 200 });
        if (url === "/api/chat/sessions" && init?.method === "POST") return new Response("x", { status: 500 });
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    render(<ChatApp />);
    fireEvent.click(await screen.findByRole("button", { name: "new session" }));
    expect(await screen.findByTestId("chat-error")).toHaveTextContent("could not create a session");
  });

  it("cap notice's 'start a new session' button creates a fresh session", async () => {
    let created = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/chat/sessions" && !init?.method) return new Response("[]", { status: 200 });
        if (url === "/api/chat/sessions" && init?.method === "POST") {
          created += 1;
          return new Response(JSON.stringify({ id: created === 1 ? 9 : 11 }), { status: 200 });
        }
        if (url === "/api/chat/sessions/9") {
          return new Response(JSON.stringify({ ...baseSession, llmCalls: 20 }), { status: 200 });
        }
        if (url === "/api/chat/sessions/11") {
          return new Response(JSON.stringify({ ...baseSession, id: 11 }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    render(<ChatApp />);
    // first session is already at the cap → notice + disabled input
    fireEvent.click(await screen.findByRole("button", { name: "new session" }));
    expect(await screen.findByTestId("cap-notice")).toHaveTextContent("session cap reached");
    expect(screen.getByTestId("chat-input")).toBeDisabled();
    // the notice's affordance creates a fresh, writable session
    fireEvent.click(screen.getByRole("button", { name: "start a new session" }));
    await waitFor(() => expect(screen.queryByTestId("cap-notice")).toBeNull());
    expect(screen.getByTestId("chat-input")).not.toBeDisabled();
    expect(created).toBe(2);
  });
});
