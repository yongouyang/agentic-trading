import type { DailyReport } from "@/app/types";

/** Matches GET /reports/daily?market=HK verbatim (docs/phase-3-plan.md §3a). */
export const dailyReportFixture: DailyReport = {
  market: "HK",
  run: {
    id: 7,
    runAt: "2026-09-06T08:00:00.000Z",
    screenRunId: 12,
    topN: 2,
    llmCalls: 12,
    cacheHits: 2,
    failed: 1,
    warnings: ["dummy warning"],
  },
  integrity: {
    universeSize: 3,
    ok: 3,
    genuinelyAbsent: 0,
    fetchFailed: 1,
    degraded: true,
    warnings: ["fetch failed for 0001.HK"],
  },
  rows: [
    {
      rank: 1,
      symbol: "0005.HK",
      score: 0.9,
      metrics: { close: 98.02, sma50: 95.1, mom20: 0.04, caDegraded: false },
      verdict: { rating: "buy", conviction: 0.6, abstain: false, thesis: "solid momentum" },
      deepDiveStatus: "ok",
    },
    {
      rank: 2,
      symbol: "0700.HK",
      score: 0.5,
      metrics: { close: 380.0, caDegraded: true },
      verdict: { rating: "strong_sell", conviction: -0.8, abstain: true, thesis: "overvalued" },
      deepDiveStatus: "ok",
    },
    {
      rank: 3,
      symbol: "0939.HK",
      score: 0.1,
      metrics: {},
      verdict: null,
      deepDiveStatus: "failed:parse-error",
    },
    {
      rank: 4,
      symbol: "1299.HK",
      score: -0.2,
      metrics: {},
      verdict: null,
      deepDiveStatus: null,
    },
  ],
};

// ---- chat fixtures (phase-3b) ----

import type {
  ChatSessionDetail,
  ChatSessionSummary,
  CompareSymbolRow,
  DeepDiveIndex,
  FullTranscriptEntry,
  PriceHistory,
  RunSummary,
} from "@/app/types";

export const toolData = (name: string, data: unknown) =>
  `<tool-data name="${name}">${JSON.stringify(data)}</tool-data>`;

export const priceHistoryFixture: PriceHistory = {
  symbol: "0005.HK",
  days: 250,
  bars: [
    { date: "2026-09-01", close: 98.0, volume: 1000 },
    { date: "2026-09-02", close: 99.5, volume: 2000 },
  ],
  markers: [{ date: "2026-09-02", type: "DIVIDEND", amount: 2, currency: "HKD" }],
};

export const deepDiveIndexFixture: DeepDiveIndex = {
  run: { id: 7, runAt: "2026-09-06T08:00:00.000Z", market: "HK", screenRunId: 12, topN: 2 },
  symbol: "0005.HK",
  status: "ok",
  verdict: {
    instrumentId: "0005.HK",
    rating: "buy",
    conviction: 0.6,
    abstain: false,
    thesis: "solid momentum",
    keyRisks: ["rate sensitivity"],
    invalidationConditions: ["breaks below 200d SMA"],
    asOf: "2026-09-06",
    promptVersion: "v1",
  },
  index: [
    {
      hash: "abc123def456",
      agent: "verdict",
      model: "k3",
      promptVersion: "v1",
      usage: { promptTokens: 100, completionTokens: 50 },
      preview: "verdict preview text",
    },
  ],
};

export const compareFixture: CompareSymbolRow[] = [
  {
    symbol: "0005.HK",
    market: "HK",
    screen: { runId: 12, runAt: "2026-09-06T08:00:00.000Z", rank: 1, score: 0.9, metrics: { close: 98.02 } },
    verdict: { rating: "buy", conviction: 0.6, abstain: false, thesis: "solid momentum" },
  },
  {
    symbol: "0700.HK",
    market: "HK",
    screen: null,
    verdict: null,
  },
];

export const runsFixture: RunSummary[] = [
  { id: 7, runAt: "2026-09-06T08:00:00.000Z", market: "HK", screenRunId: 12, topN: 2, llmCalls: 12, cacheHits: 2, failed: 1 },
];

export const transcriptEntryFixture: FullTranscriptEntry = {
  hash: "abc123def456",
  agent: "verdict",
  model: "k3",
  promptVersion: "v1",
  usage: { promptTokens: 100, completionTokens: 50 },
  systemPrompt: "sys",
  userPrompt: "usr",
  responseText: "resp",
  createdAt: "2026-09-06T08:01:00.000Z",
};

export const sessionSummaryFixture: ChatSessionSummary = {
  id: 1,
  title: "what moved today?",
  createdAt: "2026-09-06T09:00:00.000Z",
  llmCalls: 2,
  promptTokens: 120,
  completionTokens: 45,
};

export const sessionDetailFixture: ChatSessionDetail = {
  ...sessionSummaryFixture,
  messages: [
    {
      id: 1,
      role: "user",
      content: "what moved today?",
      toolName: null,
      toolArgsJson: null,
      createdAt: "2026-09-06T09:00:00.000Z",
    },
    {
      id: 2,
      role: "tool",
      content: toolData("getDailyReport", dailyReportFixture),
      toolName: "getDailyReport",
      toolArgsJson: '{"market":"HK"}',
      createdAt: "2026-09-06T09:00:01.000Z",
    },
    {
      id: 3,
      role: "tool",
      content: toolData("getDeepDive", deepDiveIndexFixture),
      toolName: "getDeepDive",
      toolArgsJson: '{"runId":7,"symbol":"0005.HK"}',
      createdAt: "2026-09-06T09:00:02.000Z",
    },
    {
      id: 4,
      role: "tool",
      content: toolData("getPriceHistory", priceHistoryFixture),
      toolName: "getPriceHistory",
      toolArgsJson: '{"symbol":"0005.HK"}',
      createdAt: "2026-09-06T09:00:03.000Z",
    },
    {
      id: 5,
      role: "tool",
      content: toolData("compareSymbols", { symbols: compareFixture }),
      toolName: "compareSymbols",
      toolArgsJson: '{"symbols":["0005.HK","0700.HK"]}',
      createdAt: "2026-09-06T09:00:04.000Z",
    },
    {
      id: 6,
      role: "tool",
      content: toolData("listRuns", runsFixture),
      toolName: "listRuns",
      toolArgsJson: "{}",
      createdAt: "2026-09-06T09:00:05.000Z",
    },
    {
      id: 7,
      role: "tool",
      content: toolData("getTranscriptEntry", transcriptEntryFixture),
      toolName: "getTranscriptEntry",
      toolArgsJson: '{"hash":"abc123def456"}',
      createdAt: "2026-09-06T09:00:06.000Z",
    },
    {
      id: 8,
      role: "tool",
      content: "not wrapped, not json",
      toolName: "weirdTool",
      toolArgsJson: null,
      createdAt: "2026-09-06T09:00:07.000Z",
    },
    {
      id: 9,
      role: "assistant",
      content: "**HSBC** leads today. See the table above.",
      toolName: null,
      toolArgsJson: null,
      createdAt: "2026-09-06T09:00:08.000Z",
    },
  ],
};
