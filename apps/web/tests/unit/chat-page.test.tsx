import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/components/price-chart", () => ({
  PriceChart: () => <div data-testid="price-chart" />,
}));

import { ChatApp } from "@/app/chat/chat-app";
import { sessionSummaryFixture, toolData } from "./fixtures";

const sseFrame = (type: string, payload: unknown) => `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;

function sseResponse(events: [string, unknown][]): Response {
  const text = events.map(([t, p]) => sseFrame(t, p)).join("");
  return new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const emptySession = {
  id: 9,
  title: null,
  createdAt: "2026-09-08T00:00:00.000Z",
  llmCalls: 0,
  promptTokens: 0,
  completionTokens: 0,
  messages: [],
};

const answeredSession = {
  ...emptySession,
  llmCalls: 2,
  promptTokens: 120,
  completionTokens: 45,
  messages: [
    { id: 1, role: "user", content: "hi", toolName: null, toolArgsJson: null, createdAt: "2026-09-08T00:00:01.000Z" },
    {
      id: 2,
      role: "tool",
      content: toolData("listRuns", [{ id: 7, runAt: "2026-09-06T08:00:00.000Z", market: "HK", screenRunId: 12, topN: 2, llmCalls: 12, cacheHits: 2, failed: 1 }]),
      toolName: "listRuns",
      toolArgsJson: "{}",
      createdAt: "2026-09-08T00:00:02.000Z",
    },
    { id: 3, role: "assistant", content: "hello **there**", toolName: null, toolArgsJson: null, createdAt: "2026-09-08T00:00:03.000Z" },
  ],
};

function stubChatFetch(opts: { messageResponse?: Response; sessionAfterSend?: object; createStatus?: number }) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/chat/sessions" && !init?.method) {
      return new Response(JSON.stringify([sessionSummaryFixture]), { status: 200 });
    }
    if (url === "/api/chat/sessions" && init?.method === "POST") {
      const status = opts.createStatus ?? 200;
      return new Response(status === 200 ? JSON.stringify({ id: 9 }) : "{}", { status });
    }
    if (url === "/api/chat/sessions/9/messages") {
      return opts.messageResponse ?? sseResponse([["done", { type: "done", messageId: 3 }]]);
    }
    if (url === "/api/chat/sessions/9") {
      return new Response(JSON.stringify(opts.sessionAfterSend ?? emptySession), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

describe("chat page (client)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a session, streams an answer, updates the cost header, renders the tool card", async () => {
    vi.stubGlobal(
      "fetch",
      stubChatFetch({
        sessionAfterSend: answeredSession,
        messageResponse: sseResponse([
          ["status", { type: "status", phase: "start", tool: "listRuns", args: {} }],
          ["status", { type: "status", phase: "end", tool: "listRuns" }],
          ["chunk", { type: "chunk", text: "hello " }],
          ["chunk", { type: "chunk", text: "**there**" }],
          ["usage", { type: "usage", llmCalls: 2, promptTokens: 120, completionTokens: 45 }],
          ["done", { type: "done", messageId: 3 }],
        ]),
      }),
    );
    render(<ChatApp />);
    fireEvent.click(await screen.findByRole("button", { name: "new session" }));
    const input = await screen.findByTestId("chat-input");
    fireEvent.change(input, { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "send" }));

    // persisted answer + tool card render after done
    const list = await screen.findByTestId("message-list");
    await waitFor(() => expect(list).toHaveTextContent("hello"));
    expect(list.querySelector("strong")).toHaveTextContent("there");
    expect(screen.getByTestId("tool-card-runs")).toHaveTextContent("HK");
    expect(screen.getByTestId("cost-header")).toHaveTextContent("calls: 2/20 · tokens: 120+45");
  });

  it("shows the cap notice and disables input on cap-reached", async () => {
    vi.stubGlobal(
      "fetch",
      stubChatFetch({
        sessionAfterSend: { ...answeredSession, llmCalls: 20 },
        messageResponse: sseResponse([
          ["error", { type: "error", error: "cap-reached", message: "session llm-call cap reached (20)" }],
        ]),
      }),
    );
    render(<ChatApp />);
    fireEvent.click(await screen.findByRole("button", { name: "new session" }));
    const input = await screen.findByTestId("chat-input");
    fireEvent.change(input, { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "send" }));

    const notice = await screen.findByTestId("cap-notice");
    expect(notice).toHaveTextContent("session cap reached");
    expect(screen.getByRole("button", { name: "start a new session" })).toBeInTheDocument();
    expect(screen.getByTestId("chat-input")).toBeDisabled();
  });

  it("shows inline errors for llm-failure", async () => {
    vi.stubGlobal(
      "fetch",
      stubChatFetch({
        messageResponse: sseResponse([
          ["error", { type: "error", error: "llm-failure", message: "provider 500" }],
        ]),
      }),
    );
    render(<ChatApp />);
    fireEvent.click(await screen.findByRole("button", { name: "new session" }));
    const input = await screen.findByTestId("chat-input");
    fireEvent.change(input, { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "send" }));
    const err = await screen.findByTestId("chat-error");
    expect(err).toHaveTextContent("provider 500");
    expect(screen.getByTestId("chat-input")).not.toBeDisabled();
  });

  it("shows a not-configured state when session creation 503s", async () => {
    vi.stubGlobal("fetch", stubChatFetch({ createStatus: 503 }));
    render(<ChatApp />);
    fireEvent.click(await screen.findByRole("button", { name: "new session" }));
    const notice = await screen.findByTestId("chat-unconfigured");
    expect(notice).toHaveTextContent("chat is not configured");
  });

  it("shows an unreachable notice when the session list fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("down"))));
    render(<ChatApp />);
    expect(await screen.findByTestId("chat-unreachable")).toHaveTextContent("api: unreachable");
  });
});
