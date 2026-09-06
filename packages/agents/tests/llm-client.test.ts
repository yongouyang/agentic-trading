/**
 * OpenAiCompatLlmClient via injected fetch: request shape, retry policy
 * (transport/5xx/timeout retried once; 4xx and malformed never retried),
 * usage capture. No network.
 */
import { describe, expect, it } from "vitest";
import { LlmError, OpenAiCompatLlmClient } from "../src/llm-client.js";

const okJson = {
  choices: [{ message: { content: "hello" } }],
  usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
};

function fakeFetch(impl: (url: string, init: any) => Promise<any>): { fetchImpl: typeof fetch; calls: { url: string; init: any }[] } {
  const calls: { url: string; init: any }[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return impl(String(url), init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const jsonResponse = (status: number, body: unknown) =>
  ({
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  }) as unknown as Response;

const noSleep = async () => {};
const REQ = { model: "m", messages: [{ role: "user" as const, content: "hi" }] };

describe("OpenAiCompatLlmClient", () => {
  it("POSTs the OpenAI-compatible body and captures usage", async () => {
    const { fetchImpl, calls } = fakeFetch(async () => jsonResponse(200, okJson));
    const client = new OpenAiCompatLlmClient({ baseUrl: "https://llm.example/v1/", apiKey: "k", fetchImpl, sleep: noSleep });
    const res = await client.chat(REQ);
    expect(res).toEqual({ content: "hello", usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://llm.example/v1/chat/completions");
    expect(calls[0]!.init.headers.Authorization).toBe("Bearer k");
    const body = JSON.parse(calls[0]!.init.body);
    expect(body).toEqual({ model: "m", messages: REQ.messages, temperature: 0.2, max_tokens: 2048 });
  });

  it("retries once on 5xx then succeeds", async () => {
    let n = 0;
    const { fetchImpl, calls } = fakeFetch(async () => {
      n++;
      return n === 1 ? jsonResponse(500, "boom") : jsonResponse(200, okJson);
    });
    const client = new OpenAiCompatLlmClient({ baseUrl: "https://x", apiKey: "k", fetchImpl, sleep: noSleep });
    const res = await client.chat(REQ);
    expect(res.content).toBe("hello");
    expect(calls).toHaveLength(2);
  });

  it("does not retry on 4xx", async () => {
    const { fetchImpl, calls } = fakeFetch(async () => jsonResponse(400, "bad request"));
    const client = new OpenAiCompatLlmClient({ baseUrl: "https://x", apiKey: "k", fetchImpl, sleep: noSleep });
    const err = await client.chat(REQ).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).kind).toBe("http");
    expect((err as LlmError).status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it("retries once on transport error then throws LlmError(transport)", async () => {
    const { fetchImpl, calls } = fakeFetch(async () => {
      throw new Error("socket hangup");
    });
    const client = new OpenAiCompatLlmClient({ baseUrl: "https://x", apiKey: "k", fetchImpl, sleep: noSleep });
    const err = await client.chat(REQ).catch((e) => e);
    expect((err as LlmError).kind).toBe("transport");
    expect(calls).toHaveLength(2);
  });

  it("aborts past the timeout and classifies as timeout", async () => {
    const { fetchImpl } = fakeFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }),
    );
    const client = new OpenAiCompatLlmClient({ baseUrl: "https://x", apiKey: "k", fetchImpl, sleep: noSleep, timeoutMs: 5 });
    const err = await client.chat(REQ).catch((e) => e);
    expect((err as LlmError).kind).toBe("timeout");
  });

  it("200 with a wrong-shaped body is malformed, never retried", async () => {
    const { fetchImpl, calls } = fakeFetch(async () => jsonResponse(200, { nope: true }));
    const client = new OpenAiCompatLlmClient({ baseUrl: "https://x", apiKey: "k", fetchImpl, sleep: noSleep });
    const err = await client.chat(REQ).catch((e) => e);
    expect((err as LlmError).kind).toBe("malformed");
    expect(calls).toHaveLength(1);
  });
});
