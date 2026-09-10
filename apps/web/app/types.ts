/**
 * API response contracts for the read-only report endpoints served by
 * @agentic-trading/api (docs/phase-3-plan.md §3a — Read API). Keep in sync
 * with apps/api/src/reports.
 */

export type Rating = "strong_sell" | "sell" | "hold" | "buy" | "strong_buy";

export interface IntegrityHeader {
  universeSize: number;
  ok: number;
  genuinelyAbsent: number;
  fetchFailed: number;
  degraded: boolean;
  warnings: string[];
  /** W3b: newest bar date the store holds for this lane's market (yyyy-mm-dd).
   *  Optional so an older api response renders exactly as it did before. */
  dataThrough?: string | null;
}

export interface DailyRun {
  id: number;
  runAt: string;
  screenRunId: number;
  topN: number;
  llmCalls: number;
  cacheHits: number;
  failed: number;
  warnings: string[];
}

export interface RowMetrics {
  close?: number;
  sma50?: number;
  sma200?: number;
  mom20?: number;
  mom60?: number;
  vol60?: number;
  sharpe252?: number;
  adv20?: number;
  mdd252?: number;
  caDegraded?: boolean;
}

export interface RowVerdict {
  rating: Rating;
  conviction: number;
  abstain: boolean;
  thesis: string;
}

export interface WatchlistRow {
  rank: number;
  symbol: string;
  score: number;
  metrics: RowMetrics;
  verdict: RowVerdict | null;
  deepDiveStatus: string | null;
}

export interface DailyReport {
  market: "US" | "HK";
  run: DailyRun;
  integrity: IntegrityHeader;
  rows: WatchlistRow[];
}

export interface Verdict {
  instrumentId: string;
  rating: Rating;
  conviction: number;
  abstain: boolean;
  thesis: string;
  keyRisks: string[];
  invalidationConditions: string[];
  asOf: string;
  promptVersion: string;
}

export interface TranscriptEntry {
  hash: string;
  agent: string;
  model: string;
  promptVersion: string;
  usage: { promptTokens: number; completionTokens: number } | null;
  systemPrompt: string;
  userPrompt: string;
  responseText: string;
}

export interface DeepDiveReport {
  run: { id: number; runAt: string; market: string; screenRunId: number; topN: number };
  symbol: string;
  status: string;
  verdict: Verdict | null;
  transcript: TranscriptEntry[];
}

export interface PriceBar {
  date: string;
  close: number;
  volume: number;
}

export interface PriceMarker {
  date: string;
  type: string;
  amount?: number;
  currency?: string;
}

/** Phase-3c indicator overlays (GET .../price-history `indicators` field).
 *  Optional on the web type: persisted chat tool payloads from before 3c
 *  don't carry it — the chart renders pane 0 only when absent. */
export interface IndicatorPoint {
  date: string;
  value: number;
}

export interface PriceHistoryIndicators {
  sma50: IndicatorPoint[];
  sma200: IndicatorPoint[];
  mom20: IndicatorPoint[];
  mom60: IndicatorPoint[];
  mdd252: IndicatorPoint[];
  vol60: IndicatorPoint[];
}

export interface PriceHistory {
  symbol: string;
  days: number;
  bars: PriceBar[];
  markers: PriceMarker[];
  indicators?: PriceHistoryIndicators;
}

/**
 * Chat contracts (docs/phase-3b-plan.md §"API surface"). Keep in sync with
 * apps/api/src/chat.
 */

export interface ChatSessionSummary {
  id: number;
  title: string | null;
  createdAt: string;
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant" | "tool";
  content: string;
  toolName: string | null;
  toolArgsJson: string | null;
  createdAt: string;
}

export interface ChatSessionDetail extends ChatSessionSummary {
  messages: ChatMessage[];
}

/** SSE events streamed by POST /chat/sessions/:id/messages. The `data` JSON
 *  always carries `type` (the `event:` line is redundant framing). */
export type ChatEvent =
  | { type: "status"; phase: "start" | "end"; tool: string; args?: unknown }
  | { type: "chunk"; text: string }
  | { type: "usage"; llmCalls: number; promptTokens: number; completionTokens: number }
  | { type: "done"; messageId: number }
  | { type: "error"; error: "cap-reached" | "llm-failure" | "loop-guard"; message: string };

/** Tool payload shapes (apps/api/src/reports/reports.service.ts). These ride
 *  inside role="tool" messages as `<tool-data name="…">…json…</tool-data>`. */

export interface TranscriptIndexEntry {
  hash: string;
  agent: string;
  model: string;
  promptVersion: string;
  usage: { promptTokens: number; completionTokens: number } | null;
  preview: string;
}

export interface DeepDiveIndex {
  run: { id: number; runAt: string; market: string; screenRunId: number; topN: number };
  symbol: string;
  status: string;
  verdict: Verdict | null;
  index: TranscriptIndexEntry[];
}

export interface FullTranscriptEntry extends TranscriptEntry {
  createdAt: string;
}

export interface RunSummary {
  id: number;
  runAt: string;
  market: string;
  screenRunId: number;
  topN: number;
  llmCalls: number;
  cacheHits: number;
  failed: number;
}

export interface CompareSymbolRow {
  symbol: string;
  market: string;
  screen: { runId: number; runAt: string; rank: number; score: number; metrics: RowMetrics } | null;
  verdict: RowVerdict | null;
}
