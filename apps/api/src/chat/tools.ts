/**
 * Chat tool registry (phase-3b-plan §"Tool schema"): the six read-only tools,
 * each executing as an in-process ReportsService call — no HTTP, no LLM calls,
 * no writes. Arg validation is hand-rolled (no schema dep in the repo);
 * validation failures and service 400/404s are returned TO THE MODEL as a
 * `{ error: "…" }` tool result so it can correct itself, never thrown into
 * the chat loop.
 */
import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { LlmTool } from "@agentic-trading/agents";
import { DEFAULT_PRICE_HISTORY_DAYS, MAX_PRICE_HISTORY_DAYS, ReportsService } from "../reports/reports.service.js";

export interface ChatTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<unknown>;
}

/** Minimal JSON-schema-subset validator: object args, required keys, and
 *  string / integer / string-array property types. Returns an error message
 *  or null. */
export function validateArgs(schema: Record<string, unknown>, args: unknown): string | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return "arguments must be a JSON object";
  const properties = (schema.properties ?? {}) as Record<string, { type?: string; enum?: unknown[]; items?: { type?: string } }>;
  for (const key of (schema.required as string[] | undefined) ?? []) {
    if ((args as Record<string, unknown>)[key] === undefined) return `missing required argument "${key}"`;
  }
  for (const [key, spec] of Object.entries(properties)) {
    const value = (args as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (spec.type === "string" && typeof value !== "string") return `argument "${key}" must be a string`;
    if (spec.type === "integer" && !Number.isInteger(value)) return `argument "${key}" must be an integer`;
    if (spec.type === "array" && (!Array.isArray(value) || (spec.items?.type === "string" && value.some((v) => typeof v !== "string")))) {
      return `argument "${key}" must be an array of strings`;
    }
    if (spec.enum && !spec.enum.includes(value)) return `argument "${key}" must be one of ${spec.enum.join("|")}`;
  }
  return null;
}

/** Parse + validate + execute one tool call. Every failure mode returns an
 *  `{ error }` payload for the model; this function never throws. */
export async function executeToolCall(tools: ChatTool[], name: string, argumentsJson: string): Promise<unknown> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { error: `unknown tool "${name}"` };
  let args: unknown;
  try {
    args = JSON.parse(argumentsJson || "{}");
  } catch {
    return { error: `arguments for "${name}" are not valid JSON` };
  }
  const invalid = validateArgs(tool.parameters, args);
  if (invalid) return { error: invalid };
  try {
    return await tool.execute(args as Record<string, unknown>);
  } catch (err) {
    if (err instanceof NotFoundException || err instanceof BadRequestException) return { error: err.message };
    throw err; // a store-level failure is a real bug — let the loop turn it into llm-failure
  }
}

/** Wrap a tool result as a quoted data block (injection posture, locked
 *  2026-09-07): content inside is data, never instructions. */
export function wrapToolData(name: string, payload: unknown): string {
  return `<tool-data name="${name}">\n${JSON.stringify(payload)}\n</tool-data>`;
}

export function buildChatTools(reports: ReportsService): ChatTool[] {
  return [
    {
      name: "getDailyReport",
      description:
        "Ranked daily screen rows with verdict overlays for one market lane: integrity header + per-name rank, score, metrics, verdict. Omits runId for the latest run; pass runId (from listRuns) for a historical run.",
      parameters: {
        type: "object",
        properties: {
          market: { type: "string", enum: ["US", "HK"] },
          runId: { type: "integer" },
        },
        required: ["market"],
      },
      execute: (a) => reports.daily(a.market as string, a.runId as number | undefined),
    },
    {
      name: "getDeepDive",
      description:
        "One name's deep-dive within a run: status, full verdict JSON, and a transcript INDEX (hash, agent, model, usage, ~500-char preview per entry). Use getTranscriptEntry(hash) to fetch one full transcript entry.",
      parameters: {
        type: "object",
        properties: { runId: { type: "integer" }, symbol: { type: "string" } },
        required: ["runId", "symbol"],
      },
      execute: (a) => reports.deepDiveIndex(a.runId as number, a.symbol as string),
    },
    {
      name: "getTranscriptEntry",
      description: "One full deep-dive transcript entry by its hash (from a getDeepDive index): system prompt, user prompt, full response text.",
      parameters: {
        type: "object",
        properties: { hash: { type: "string" } },
        required: ["hash"],
      },
      execute: (a) => reports.transcriptEntry(a.hash as string),
    },
    {
      name: "getPriceHistory",
      description: `Adjusted daily closes + corporate-action markers for a symbol, from stored bars only. days defaults to ${DEFAULT_PRICE_HISTORY_DAYS}, max ${MAX_PRICE_HISTORY_DAYS}.`,
      parameters: {
        type: "object",
        properties: { symbol: { type: "string" }, days: { type: "integer" } },
        required: ["symbol"],
      },
      execute: (a) => {
        const days = (a.days as number | undefined) ?? DEFAULT_PRICE_HISTORY_DAYS;
        if (days < 1 || days > MAX_PRICE_HISTORY_DAYS) {
          throw new BadRequestException(`days must be an integer in [1, ${MAX_PRICE_HISTORY_DAYS}], got ${days}`);
        }
        return reports.priceHistory(a.symbol as string, days);
      },
    },
    {
      name: "compareSymbols",
      description: "Side-by-side comparison of 2–5 symbols from stored data: each name's latest screen row (rank, score, metrics) plus its latest deep-dive verdict overlay.",
      parameters: {
        type: "object",
        properties: { symbols: { type: "array", items: { type: "string" } } },
        required: ["symbols"],
      },
      execute: (a) => reports.compareSymbols(a.symbols as string[]),
    },
    {
      name: "listRuns",
      description: "Recent deep-dive runs (id, runAt, market, topN, llmCalls), newest first — use to target historical runs with getDailyReport/getDeepDive.",
      parameters: {
        type: "object",
        properties: {
          market: { type: "string", enum: ["US", "HK"] },
          limit: { type: "integer" },
        },
      },
      execute: (a) => reports.listRuns(a.market as string | undefined, a.limit as number | undefined),
    },
  ];
}

/** Wire shape for the LLM request (OpenAI function tools). */
export function chatToolSchemas(tools: ChatTool[]): LlmTool[] {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}
