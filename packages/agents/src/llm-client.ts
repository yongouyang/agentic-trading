/**
 * OpenAI-compatible chat-completions client via plain fetch (project idiom —
 * no new dependency). One client serves all three pipeline roles; the model
 * is chosen per call. Fully injectable (fetchImpl/timeout) so tests never
 * touch the network.
 *
 * Discipline (phase-2-plan): 60s AbortController timeout, exactly 1 retry on
 * transport errors and 5xx, no retry on 4xx (a bad request fails loudly and
 * immediately). Returns { content, usage }; every failure path throws a typed
 * LlmError — the pipeline catches and turns it into a per-name failure.
 */
export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface LlmResponse {
  content: string;
  usage: LlmUsage | null;
}

export interface LlmRequest {
  model: string;
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  /** OpenAI-style reasoning effort hint ("low" | "high"…). The Kimi coding
   *  endpoint accepts `reasoning_effort` (measured 2026-09-06: 200 with
   *  "low"); omitted entirely when unset — providers vary. */
  reasoningEffort?: string;
}

/** The port the pipeline depends on — fakes implement this in tests. */
export interface LlmClient {
  chat(req: LlmRequest): Promise<LlmResponse>;
}

export type LlmErrorKind = "timeout" | "transport" | "http" | "malformed";

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly status?: number;

  constructor(kind: LlmErrorKind, message: string, status?: number) {
    super(message);
    this.name = "LlmError";
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

export interface OpenAiCompatLlmClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Default 60s (phase-2-plan). */
  timeoutMs?: number;
  /** Applied when a request omits temperature. Default 0.2 — EXCEPT the Kimi
   *  coding endpoint (k3-256k) which 400s on anything but 1 (measured
   *  2026-09-06): pass 1 there via LLM_TEMPERATURE. */
  defaultTemperature?: number;
  /** Applied when a request omits reasoningEffort (e.g. "low" for the
   *  k3-256k smoke profile — user decision 2026-09-06). */
  defaultReasoningEffort?: string;
  /** Injectable for tests (default global fetch). */
  fetchImpl?: typeof fetch;
  /** Injectable for tests (default real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class OpenAiCompatLlmClient implements LlmClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly defaultTemperature?: number;
  private readonly defaultReasoningEffort?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: OpenAiCompatLlmClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.defaultTemperature = opts.defaultTemperature;
    this.defaultReasoningEffort = opts.defaultReasoningEffort;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? realSleep;
  }

  async chat(req: LlmRequest): Promise<LlmResponse> {
    let lastError: LlmError | null = null;
    // 1 initial attempt + 1 retry, only for transport/5xx/timeout.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await this.sleep(500);
      try {
        return await this.attempt(req);
      } catch (err) {
        if (err instanceof LlmError && (err.kind === "http" && err.status !== undefined && err.status < 500)) throw err;
        if (err instanceof LlmError && err.kind === "malformed") throw err;
        lastError = err instanceof LlmError ? err : new LlmError("transport", String(err));
      }
    }
    throw lastError ?? new LlmError("transport", "exhausted retries");
  }

  private async attempt(req: LlmRequest): Promise<LlmResponse> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "User-Agent": "Mozilla/5.0",
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          temperature: req.temperature ?? this.defaultTemperature ?? 0.2,
          max_tokens: req.maxTokens ?? 2048,
          ...((req.reasoningEffort ?? this.defaultReasoningEffort)
            ? { reasoning_effort: req.reasoningEffort ?? this.defaultReasoningEffort }
            : {}),
        }),
        signal: ac.signal,
      });
      if (res.status !== 200) {
        const body = await res.text().catch(() => "");
        throw new LlmError("http", `llm http-${res.status}: ${body.slice(0, 200)}`, res.status);
      }
      const json = (await res.json().catch(() => null)) as any;
      const content = json?.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new LlmError("malformed", "llm 200 without choices[0].message.content");
      const u = json?.usage;
      const usage: LlmUsage | null =
        u && typeof u === "object"
          ? {
              promptTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : null,
              completionTokens: typeof u.completion_tokens === "number" ? u.completion_tokens : null,
              totalTokens: typeof u.total_tokens === "number" ? u.total_tokens : null,
            }
          : null;
      return { content, usage };
    } catch (err: any) {
      if (err instanceof LlmError) throw err;
      if (err?.name === "AbortError") throw new LlmError("timeout", `llm request timed out after ${this.timeoutMs}ms`);
      throw new LlmError("transport", String(err?.cause?.code ?? err?.message ?? err).slice(0, 200));
    } finally {
      clearTimeout(timer);
    }
  }
}
