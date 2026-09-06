/**
 * Pipeline orchestration with a scripted fake LlmClient + in-memory
 * DecisionLog: call sequence (7/stock, 6/ETF), cache semantics (second
 * identical run = 0 client calls), verdict repair round (success + loud
 * failure), ETF skipping the fundamentals analyst. No network.
 */
import { describe, expect, it } from "vitest";
import type { LlmClient, LlmRequest } from "../src/llm-client.js";
import { LlmError } from "../src/llm-client.js";
import { decisionHash, runDeepDive, type DecisionLog, type StoredDecision } from "../src/pipeline.js";
import type { DeepDiveContext } from "../src/prompts.js";

const CTX: DeepDiveContext = {
  symbol: "AAPL",
  name: "Apple",
  market: "US",
  asOf: "2026-09-05",
  screenMetrics: { close: 230.5, mom20: 0.02 },
  rank: 1,
  score: 0.9,
  recentBars: { lastClose: 230.5, lastDate: "2026-09-05", change20d: 0.02, change60d: 0.05, adv20: 9e9 },
  fundamentalsSnapshot: "FY2025 revenue ...",
  news: [{ title: "Apple event", source: "Reuters", date: "2026-09-04" }],
  caDegraded: false,
};

const VERDICT_JSON = JSON.stringify({
  rating: "buy",
  conviction: 0.5,
  abstain: false,
  thesis: "Solid.",
  keyRisks: ["valuation"],
  invalidationConditions: ["growth stalls"],
});

class FakeClient implements LlmClient {
  requests: LlmRequest[] = [];
  constructor(private readonly script: (req: LlmRequest, n: number) => string | Error) {}
  async chat(req: LlmRequest) {
    this.requests.push(req);
    const out = this.script(req, this.requests.length);
    if (out instanceof Error) throw out;
    return { content: out, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
  }
}

function memoryLog(): DecisionLog & { store: Map<string, StoredDecision>; recorded: number } {
  const store = new Map<string, StoredDecision>();
  return {
    store,
    recorded: 0,
    async lookup(hash) {
      return store.get(hash) ?? null;
    },
    async record(entry) {
      this.recorded++;
      store.set(entry.hash, { hash: entry.hash, responseText: entry.responseText });
    },
  };
}

const MODELS = { analyst: "m-analyst", debate: "m-debate", verdict: "m-verdict" };
const deps = (client: LlmClient, log: DecisionLog) => ({ client, log, models: MODELS });

describe("runDeepDive — happy path", () => {
  it("makes 7 calls in role order for a stock and returns a full verdict", async () => {
    const client = new FakeClient((req) => (req.model === "m-verdict" ? VERDICT_JSON : `${req.model} says stuff`));
    const log = memoryLog();
    const r = await runDeepDive(deps(client, log), CTX, { isEtf: false });
    expect(r.ok).toBe(true);
    expect(r.calls).toBe(7);
    expect(r.cacheHits).toBe(0);
    const models = client.requests.map((q) => q.model);
    expect(models).toEqual(["m-analyst", "m-analyst", "m-debate", "m-debate", "m-debate", "m-debate", "m-verdict"]);
    expect(r.hashes).toHaveLength(7);
    if (r.ok) {
      expect(r.verdict).toEqual({
        instrumentId: "AAPL",
        rating: "buy",
        conviction: 0.5,
        abstain: false,
        thesis: "Solid.",
        keyRisks: ["valuation"],
        invalidationConditions: ["growth stalls"],
        asOf: "2026-09-05",
        promptVersion: "v1",
      });
    }
    expect(log.recorded).toBe(7);
  });

  it("debate round 2 sees round 1 text", async () => {
    const client = new FakeClient((req) => (req.model === "m-verdict" ? VERDICT_JSON : "text"));
    await runDeepDive(deps(client, memoryLog()), CTX, { isEtf: false });
    const debateCalls = client.requests.filter((q) => q.model === "m-debate");
    expect(debateCalls[2]!.messages[1]!.content).toContain("[bull] text");
    expect(debateCalls[3]!.messages[1]!.content).toContain("[bear] text");
  });

  it("ETF skips the fundamentals analyst: 6 calls, no fundamentals prompt", async () => {
    const client = new FakeClient((req) => (req.model === "m-verdict" ? VERDICT_JSON : "text"));
    const r = await runDeepDive(deps(client, memoryLog()), CTX, { isEtf: true });
    expect(r.ok).toBe(true);
    expect(r.calls).toBe(6);
    const all = client.requests.flatMap((q) => q.messages.map((m) => m.content)).join("\n");
    expect(all).not.toContain("fundamentals analyst on a deep-dive team");
  });
});

describe("runDeepDive — cache", () => {
  it("second identical run makes zero client calls", async () => {
    const client = new FakeClient((req) => (req.model === "m-verdict" ? VERDICT_JSON : "text"));
    const log = memoryLog();
    const first = await runDeepDive(deps(client, log), CTX, { isEtf: false });
    expect(first.calls).toBe(7);
    const second = await runDeepDive(deps(client, log), CTX, { isEtf: false });
    expect(second.ok).toBe(true);
    expect(second.calls).toBe(0);
    expect(second.cacheHits).toBe(7);
    expect(client.requests).toHaveLength(7);
    expect(second.hashes).toEqual(first.hashes);
    if (first.ok && second.ok) expect(second.verdict).toEqual(first.verdict);
  });

  it("hash covers agent, model, and prompt bytes", () => {
    const p = { system: "s", user: "u" };
    expect(decisionHash("bull", "m", p)).not.toBe(decisionHash("bear", "m", p));
    expect(decisionHash("bull", "m", p)).not.toBe(decisionHash("bull", "m2", p));
    expect(decisionHash("bull", "m", p)).toBe(decisionHash("bull", "m", { ...p }));
  });
});

describe("runDeepDive — verdict repair", () => {
  it("one repair round rescues a malformed verdict", async () => {
    let verdictCalls = 0;
    const client = new FakeClient((req) => {
      if (req.model !== "m-verdict") return "text";
      verdictCalls++;
      return verdictCalls === 1 ? "not json at all" : VERDICT_JSON;
    });
    const r = await runDeepDive(deps(client, memoryLog()), CTX, { isEtf: false });
    expect(r.ok).toBe(true);
    expect(r.calls).toBe(8);
    const repairReq = client.requests.at(-1)!;
    expect(repairReq.messages).toHaveLength(3);
    expect(repairReq.messages[2]!.content).toContain("not json at all");
    expect(repairReq.messages[2]!.content).toContain("Validation error");
  });

  it("repair exhaustion fails the name loudly with verdict-parse slug", async () => {
    const client = new FakeClient((req) => (req.model === "m-verdict" ? "still garbage" : "text"));
    const r = await runDeepDive(deps(client, memoryLog()), CTX, { isEtf: false });
    expect(r.ok).toBe(false);
    expect(r.calls).toBe(8);
    if (!r.ok) expect(r.failure).toMatch(/^verdict-parse:/);
  });
});

describe("runDeepDive — LLM failure isolation", () => {
  it("an LlmError becomes a typed failure slug, never a throw", async () => {
    const client = new FakeClient(() => new LlmError("timeout", "llm request timed out after 60000ms"));
    const r = await runDeepDive(deps(client, memoryLog()), CTX, { isEtf: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure).toBe("llm-timeout");
  });

  it("http status is carried in the slug", async () => {
    const client = new FakeClient(() => new LlmError("http", "llm http-500", 500));
    const r = await runDeepDive(deps(client, memoryLog()), CTX, { isEtf: false });
    if (!r.ok) expect(r.failure).toBe("llm-http-500");
  });
});
