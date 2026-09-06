/**
 * Verdict contract validation + the single repair round (phase-2-plan:
 * prompt + strict validate + exactly 1 repair, then fail the name loudly).
 * Provider-agnostic — no reliance on `response_format` support.
 *
 * parseVerdict accepts either a bare JSON object or a fenced/embedded one
 * (models love ```json fences); everything else about the shape is strict:
 * no missing keys, no extra-tolerant coercions beyond trimming.
 */
import type { Rating } from "@agentic-trading/quant-core";

/** The 5-tier rating values, in order (mirrors quant-core's Rating union). */
export const RATINGS = ["strong_sell", "sell", "neutral", "buy", "strong_buy"] as const;

/** The JSON shape the verdict model is asked to produce (see prompts.ts). */
export interface VerdictPayload {
  rating: Rating;
  /** Continuous conviction in [-1, +1]. */
  conviction: number;
  abstain: boolean;
  thesis: string;
  keyRisks: string[];
  invalidationConditions: string[];
}

export type ParseVerdictResult = { ok: true; verdict: VerdictPayload } | { ok: false; error: string };

export const VERDICT_SCHEMA_HINT = `{
  "rating": "strong_sell" | "sell" | "neutral" | "buy" | "strong_buy",
  "conviction": <number in [-1, 1]>,
  "abstain": <boolean — true only when evidence is insufficient to judge>,
  "thesis": <string, 2-4 sentences>,
  "keyRisks": <string[]>,
  "invalidationConditions": <string[] — what would prove this verdict wrong>
}`;

/** Extract the first balanced {...} block, tolerating markdown fences and
 *  surrounding prose. Returns the raw candidate string (still unvalidated). */
export function extractJsonCandidate(text: string): string | null {
  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(text);
  const start = fenced ? text.indexOf(fenced[1]!) : text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

export function parseVerdict(text: string): ParseVerdictResult {
  const candidate = extractJsonCandidate(text);
  if (!candidate) return { ok: false, error: "no JSON object found in response" };
  let obj: unknown;
  try {
    obj = JSON.parse(candidate);
  } catch (e) {
    return { ok: false, error: `JSON.parse failed: ${(e as Error).message}` };
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return { ok: false, error: "top level is not an object" };
  const o = obj as Record<string, unknown>;
  if (typeof o.rating !== "string" || !(RATINGS as readonly string[]).includes(o.rating)) {
    return { ok: false, error: `rating must be one of ${RATINGS.join("/")}, got ${JSON.stringify(o.rating)}` };
  }
  if (typeof o.conviction !== "number" || !Number.isFinite(o.conviction) || o.conviction < -1 || o.conviction > 1) {
    return { ok: false, error: `conviction must be a number in [-1,1], got ${JSON.stringify(o.conviction)}` };
  }
  if (typeof o.abstain !== "boolean") return { ok: false, error: `abstain must be boolean, got ${JSON.stringify(o.abstain)}` };
  if (typeof o.thesis !== "string" || o.thesis.trim() === "") return { ok: false, error: "thesis must be a non-empty string" };
  if (!isStringArray(o.keyRisks)) return { ok: false, error: "keyRisks must be a string array" };
  if (!isStringArray(o.invalidationConditions)) return { ok: false, error: "invalidationConditions must be a string array" };
  return {
    ok: true,
    verdict: {
      rating: o.rating as Rating,
      conviction: o.conviction,
      abstain: o.abstain,
      thesis: o.thesis,
      keyRisks: o.keyRisks,
      invalidationConditions: o.invalidationConditions,
    },
  };
}

/** The single repair-round user message: the schema, what was wrong, and the
 *  offending response. The pipeline sends this once; a second parse failure
 *  fails the name loudly. */
export function buildRepairMessage(originalResponse: string, error: string): string {
  return [
    "Your previous response was not valid. Return ONLY a JSON object matching this exact schema, with no prose and no markdown fences:",
    VERDICT_SCHEMA_HINT,
    "",
    `Validation error: ${error}`,
    "",
    "Your previous response was:",
    originalResponse.slice(0, 4_000),
  ].join("\n");
}
