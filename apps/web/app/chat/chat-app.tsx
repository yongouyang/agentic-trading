"use client";

import { useCallback, useEffect, useState } from "react";
import type { ChatEvent, ChatSessionDetail, ChatSessionSummary } from "../types";
import { Markdown } from "../components/markdown";
import { ToolCard } from "./tool-cards";

const CALL_CAP = 20;

interface Usage {
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
}

interface TraceItem {
  tool: string;
  args: string;
  done: boolean;
}

/** Read an SSE body (event:/data: framing); dispatch each parsed data JSON. */
async function readSse(res: Response, onEvent: (ev: ChatEvent) => void): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      try {
        onEvent(JSON.parse(dataLine.slice(5).trim()) as ChatEvent);
      } catch {
        // malformed frame — skip, never break the stream
      }
    }
  }
}

export function ChatApp({ initialInput = "" }: { initialInput?: string }) {
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [unreachable, setUnreachable] = useState(false);
  const [unconfigured, setUnconfigured] = useState(false);
  const [session, setSession] = useState<ChatSessionDetail | null>(null);
  const [usage, setUsage] = useState<Usage>({ llmCalls: 0, promptTokens: 0, completionTokens: 0 });
  const [input, setInput] = useState(initialInput);
  const [streaming, setStreaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [trace, setTrace] = useState<TraceItem[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [capReached, setCapReached] = useState(false);

  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/sessions", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setSessions((await res.json()) as ChatSessionSummary[]);
      setUnreachable(false);
    } catch {
      setUnreachable(true);
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const openSession = useCallback(async (id: number) => {
    try {
      const res = await fetch(`/api/chat/sessions/${id}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const detail = (await res.json()) as ChatSessionDetail;
      setSession(detail);
      setUsage({
        llmCalls: detail.llmCalls,
        promptTokens: detail.promptTokens,
        completionTokens: detail.completionTokens,
      });
      setCapReached(detail.llmCalls >= CALL_CAP);
    } catch {
      setNotice(`could not load session ${id}`);
    }
  }, []);

  const newSession = useCallback(async () => {
    setNotice(null);
    try {
      const res = await fetch("/api/chat/sessions", { method: "POST" });
      if (res.status === 503) {
        setUnconfigured(true);
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const { id } = (await res.json()) as { id: number };
      await openSession(id);
      void loadSessions();
    } catch {
      setNotice("could not create a session");
    }
  }, [openSession, loadSessions]);

  const send = useCallback(async () => {
    const content = input.trim();
    if (!content || !session || streaming || capReached) return;
    const sessionId = session.id;
    setInput("");
    setStreaming(true);
    setDraft("");
    setTrace([]);
    setNotice(null);
    setSession({
      ...session,
      messages: [
        ...session.messages,
        {
          id: -Date.now(),
          role: "user",
          content,
          toolName: null,
          toolArgsJson: null,
          createdAt: new Date().toISOString(),
        },
      ],
    });
    try {
      const res = await fetch(`/api/chat/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (res.status === 503) {
        setUnconfigured(true);
      } else if (!res.ok || !res.headers.get("content-type")?.includes("text/event-stream")) {
        setNotice(`request failed (http ${res.status})`);
      } else {
        await readSse(res, (ev) => {
          switch (ev.type) {
            case "status":
              setTrace((t) => {
                if (ev.phase === "start") {
                  return [...t, { tool: ev.tool, args: JSON.stringify(ev.args ?? {}), done: false }];
                }
                // mark the latest open call for this tool as done
                const next = [...t];
                for (let i = next.length - 1; i >= 0; i--) {
                  const item = next[i];
                  if (item && !item.done && item.tool === ev.tool) {
                    next[i] = { ...item, done: true };
                    break;
                  }
                }
                return next;
              });
              break;
            case "chunk":
              setDraft((d) => d + ev.text);
              break;
            case "usage":
              setUsage({ llmCalls: ev.llmCalls, promptTokens: ev.promptTokens, completionTokens: ev.completionTokens });
              break;
            case "done":
              break;
            case "error":
              if (ev.error === "cap-reached") {
                setCapReached(true);
              } else {
                setNotice(ev.message || ev.error);
              }
              break;
          }
        });
      }
    } catch {
      setNotice("request failed (network)");
    }
    setStreaming(false);
    setDraft("");
    setTrace([]);
    // Tool cards render from persisted state, not the stream — refetch.
    await openSession(sessionId);
    void loadSessions();
  }, [input, session, streaming, capReached, openSession, loadSessions]);

  const inputDisabled = !session || streaming || capReached || unconfigured;

  return (
    <section data-testid="chat-app">
      <div className="lane-header">
        <span className="meta" data-testid="cost-header">
          calls: {usage.llmCalls}/{CALL_CAP} · tokens: {usage.promptTokens}+{usage.completionTokens}
        </span>
        <button type="button" onClick={() => void newSession()} disabled={streaming}>
          new session
        </button>
      </div>

      {unreachable && (
        <p className="notice" data-testid="chat-unreachable">
          api: unreachable — session history unavailable.
        </p>
      )}
      {unconfigured && (
        <p className="notice" data-testid="chat-unconfigured">
          chat is not configured — set LLM_BASE_URL, LLM_API_KEY and LLM_CHAT_MODEL on the api, then reload.
        </p>
      )}

      {sessions.length > 0 && (
        <div className="chat-sessions" data-testid="session-list">
          {sessions.map((s) => (
            <button
              key={s.id}
              type="button"
              className="session-item"
              data-active={session?.id === s.id || undefined}
              onClick={() => void openSession(s.id)}
            >
              #{s.id} {s.title ?? "untitled"} <span className="meta">({s.llmCalls} calls)</span>
            </button>
          ))}
        </div>
      )}

      {capReached && (
        <p className="notice" data-testid="cap-notice">
          session cap reached ({CALL_CAP} llm calls) — this session is read-only.{" "}
          <button type="button" onClick={() => void newSession()}>
            start a new session
          </button>
        </p>
      )}
      {notice && <p className="notice" data-testid="chat-error">{notice}</p>}

      <div className="chat-messages" data-testid="message-list">
        {session?.messages.map((m) => (
          <div key={m.id} className={`msg msg--${m.role}`} data-testid={`msg-${m.role}`}>
            {m.role === "tool" ? (
              <ToolCard toolName={m.toolName} content={m.content} />
            ) : m.role === "assistant" ? (
              <Markdown text={m.content} />
            ) : (
              <p>{m.content}</p>
            )}
          </div>
        ))}
        {trace.length > 0 && (
          <div className="trace" data-testid="trace">
            {trace.map((t, i) => (
              <div key={i} className="trace-line">
                ⚙ {t.tool}({t.args}) {t.done ? "✓" : "…"}
              </div>
            ))}
          </div>
        )}
        {draft && (
          <div className="msg msg--assistant" data-testid="msg-streaming">
            <Markdown text={draft} />
          </div>
        )}
        {session && session.messages.length === 0 && !draft && (
          <p className="meta">no messages yet — ask about the latest report, a symbol, or past runs.</p>
        )}
      </div>

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          data-testid="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={session ? "ask about the reports…" : "create or pick a session first"}
          disabled={inputDisabled}
        />
        <button type="submit" disabled={inputDisabled || !input.trim()}>
          send
        </button>
      </form>
    </section>
  );
}
