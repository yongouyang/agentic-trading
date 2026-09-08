/**
 * Chat LLM configuration (phase-3b-plan §"API surface"): the API process's
 * ONLY LLM path. Env: LLM_BASE_URL, LLM_API_KEY (or LLM_API_KEY_FILE → JSON
 * with access_token, the Kimi Code CLI OAuth store — read fresh at process
 * start, same pattern as cli/deep-dive.ts), LLM_CHAT_MODEL; optional
 * LLM_TEMPERATURE / LLM_REASONING_EFFORT. When any required var is missing
 * the module still loads — `configured` is false and the controller serves
 * 503 on chat routes only; reports routes are never affected.
 *
 * Env files (apps/api/.env, then repo-root .env) are loaded manually via
 * util.parseEnv, setting only vars that are NOT already set — process.env
 * always wins (test runs pin DATABASE_URL before module compile).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { Injectable } from "@nestjs/common";
import { OpenAiCompatLlmClient, type LlmClient } from "@agentic-trading/agents";

const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

export const CHAT_REQUIRED_ENV = ["LLM_BASE_URL", "LLM_CHAT_MODEL"] as const; // + LLM_API_KEY or LLM_API_KEY_FILE

export function loadChatEnvFiles(env: NodeJS.ProcessEnv, pkgRoot: string = PKG_ROOT): void {
  for (const p of [path.join(pkgRoot, ".env"), path.resolve(pkgRoot, "..", "..", ".env")]) {
    if (!existsSync(p)) continue;
    try {
      const parsed = parseEnv(readFileSync(p, "utf8"));
      for (const [k, v] of Object.entries(parsed)) {
        if (env[k] === undefined) env[k] = v;
      }
    } catch {
      // Malformed file: skip — the configured check below fails soft (503).
    }
  }
}

/** LLM_API_KEY directly, or LLM_API_KEY_FILE → JSON with access_token (the
 *  rotating Kimi CLI credential; read fresh at process start, never copied). */
export function resolveChatApiKey(env: NodeJS.ProcessEnv): string | undefined {
  if (env.LLM_API_KEY) return env.LLM_API_KEY;
  const file = env.LLM_API_KEY_FILE;
  if (!file) return undefined;
  try {
    const token = (JSON.parse(readFileSync(file, "utf8")) as { access_token?: string }).access_token;
    return token || undefined;
  } catch {
    return undefined;
  }
}

export interface ChatConfigShape {
  configured: boolean;
  model: string | null;
  client: LlmClient | null;
}

/** Pure resolution, separated from the class so the Nest provider has a
 *  parameterless constructor (DI metadata can't express NodeJS.ProcessEnv). */
export function resolveChatConfig(env: NodeJS.ProcessEnv, opts: { loadEnvFiles?: boolean } = {}): ChatConfigShape {
  if (opts.loadEnvFiles !== false) loadChatEnvFiles(env);
  const baseUrl = env.LLM_BASE_URL;
  const apiKey = resolveChatApiKey(env);
  const model = env.LLM_CHAT_MODEL;
  if (baseUrl && apiKey && model) {
    return {
      configured: true,
      model,
      client: new OpenAiCompatLlmClient({
        baseUrl,
        apiKey,
        defaultTemperature: env.LLM_TEMPERATURE ? Number(env.LLM_TEMPERATURE) : undefined,
        defaultReasoningEffort: env.LLM_REASONING_EFFORT || undefined,
      }),
    };
  }
  return { configured: false, model: null, client: null };
}

@Injectable()
export class ChatConfig implements ChatConfigShape {
  readonly configured: boolean;
  readonly model: string | null;
  readonly client: LlmClient | null;

  constructor() {
    const resolved = resolveChatConfig(process.env);
    this.configured = resolved.configured;
    this.model = resolved.model;
    this.client = resolved.client;
  }
}
