/**
 * Reports service (phase-3-plan §"3a — Read API"; extended in phase-3b with
 * the chat-tool queries: runId-targeted daily, transcript index/entry,
 * listRuns, compareSymbols) — read-only SQL over the persisted ScreenRun /
 * DeepDiveRun / AgentDecision / Bar / CorporateAction tables. NO provider
 * calls, NO LLM calls, ever: the UI can never trigger an LLM call through
 * this module.
 */
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { annualizedVol, deriveAdjustedBars, maxDrawdown, momentum, sma } from "@agentic-trading/quant-core";
import type { Bar, CorporateAction } from "@agentic-trading/quant-core";
import type { Rating } from "@agentic-trading/quant-core";
import type { AgentDecision as AgentDecisionRow } from "@prisma/client";
import { PrismaService } from "../prisma.service.js";

export const REPORT_MARKETS = ["US", "HK"] as const;
export type ReportMarket = (typeof REPORT_MARKETS)[number];

export const MAX_PRICE_HISTORY_DAYS = 2000;
export const DEFAULT_PRICE_HISTORY_DAYS = 250;

// ---------------------------------------------------------------------------
// Response contracts (the web UI is built against these — keep stable).
// ---------------------------------------------------------------------------

export interface IntegrityHeader {
  universeSize: number;
  ok: number;
  genuinelyAbsent: number;
  fetchFailed: number;
  degraded: boolean;
  warnings: string[];
  /** W3b: the newest bar date the store holds for this lane's market, computed
   *  on read. Null when the market has no bars at all. This is what catches a
   *  shortlist ranked from stale data — and a chain that never ran — which a
   *  screen-time value cannot (docs/ops-hardening-plan.md). */
  dataThrough: string | null;
}

/** Compact pass-through of ScreenResult.metricsJson (daily-screen.ts writes
 *  close/sma50/sma200/mom20/mom60/vol60/sharpe252/adv20/mdd252/caDegraded;
 *  whichever are present are passed through). */
export interface MetricsSummary {
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

export interface VerdictOverlay {
  rating: Rating;
  conviction: number;
  abstain: boolean;
  thesis: string;
}

export interface DailyRow {
  rank: number;
  symbol: string;
  score: number;
  metrics: MetricsSummary;
  /** Present only when this symbol was deep-dived in this run AND the
   *  pipeline returned a verdict (status "ok"). Screened-but-not-deep-dived
   *  names (rank > topN) and failed names get null. */
  verdict: VerdictOverlay | null;
  /** DeepDiveReport.status ("ok" | "failed:<slug>") when the name was
   *  deep-dived, null when it was only screened. */
  deepDiveStatus: string | null;
}

export interface DailyReport {
  market: ReportMarket;
  run: {
    id: number;
    runAt: string; // ISO
    screenRunId: number;
    topN: number;
    llmCalls: number;
    cacheHits: number;
    failed: number;
    warnings: string[];
  };
  /** Integrity header of the underlying ScreenRun (architecture §5 step 5). */
  integrity: IntegrityHeader;
  rows: DailyRow[];
}

export interface TranscriptEntry {
  hash: string;
  agent: string;
  model: string;
  promptVersion: string;
  usage: unknown | null;
  systemPrompt: string;
  userPrompt: string;
  responseText: string;
}

/** Transcript index entry (phase-3b §"Tool schema"): the deepDive shape
 *  without the prompt/response bodies, plus a ~500-char response preview so
 *  the chat model can pick which entry to fetch in full. */
export interface TranscriptIndexEntry {
  hash: string;
  agent: string;
  model: string;
  promptVersion: string;
  usage: unknown | null;
  preview: string;
}

export interface DeepDiveIndex {
  run: { id: number; runAt: string; market: string; screenRunId: number; topN: number };
  symbol: string;
  status: string;
  verdict: unknown | null;
  index: TranscriptIndexEntry[];
}

/** One full AgentDecision row, fetched on demand by hash (phase-3b). */
export interface FullTranscriptEntry extends TranscriptEntry {
  createdAt: string; // ISO
}

export interface RunSummary {
  id: number;
  runAt: string; // ISO
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
  /** Row from the symbol's latest ScreenRun; null when the symbol was never
   *  screened (or the lane never screened). */
  screen: { runId: number; runAt: string; rank: number; score: number; metrics: MetricsSummary } | null;
  /** Verdict overlay from the latest DeepDiveReport for the symbol; null when
   *  never deep-dived, failed, or the stored verdict JSON is malformed. */
  verdict: VerdictOverlay | null;
}

export const TRANSCRIPT_PREVIEW_CHARS = 500;

export interface DeepDiveTranscript {
  run: { id: number; runAt: string; market: string; screenRunId: number; topN: number };
  symbol: string;
  status: string;
  /** Full parsed Verdict JSON as persisted; null for failed names. */
  verdict: unknown | null;
  /** AgentDecision rows resolved from decisionHashesJson, in pipeline order. */
  transcript: TranscriptEntry[];
}

export interface PriceHistoryBar {
  date: string;
  /** ADJUSTED close (deriveAdjustedBars — the same series the screen uses). */
  close: number;
  volume: number | null;
}

export interface PriceHistoryMarker {
  date: string;
  type: string; // "DIVIDEND" | "IN_SPECIE"
  amount: number | null;
  currency: string;
}

export interface IndicatorPoint {
  date: string;
  value: number;
}

/** Phase-3c: indicator overlays rolled over the FULL adjusted series (null
 *  lookback points omitted), then sliced to the requested window. Additive —
 *  the 3a bars/markers contract is unchanged. */
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
  bars: PriceHistoryBar[];
  /** ALL corporate actions (DIVIDEND and IN_SPECIE) for chart overlays. */
  markers: PriceHistoryMarker[];
  indicators: PriceHistoryIndicators;
}

// ---------------------------------------------------------------------------

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function parseUsage(usageJson: string | null): unknown | null {
  if (!usageJson) return null;
  try {
    return JSON.parse(usageJson);
  } catch {
    return null;
  }
}

const METRIC_KEYS = ["close", "sma50", "sma200", "mom20", "mom60", "vol60", "sharpe252", "adv20", "mdd252"] as const;

export function summarizeMetrics(metricsJson: string): MetricsSummary {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(metricsJson) as Record<string, unknown>;
  } catch {
    return {};
  }
  const out: MetricsSummary = {};
  for (const k of METRIC_KEYS) {
    const v = obj[k];
    if (typeof v === "number") (out as Record<string, unknown>)[k] = v;
  }
  if (typeof obj.caDegraded === "boolean") out.caDegraded = obj.caDegraded;
  return out;
}

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** DeepDiveRun for the lane joined to its ScreenRun. runId omitted → latest
   *  run for the market; runId given → that run (404 when it doesn't exist or
   *  belongs to a different market). 404 when no DeepDiveRun exists for the
   *  market (lane never deep-dived). */
  async daily(market: string, runId?: number): Promise<DailyReport> {
    if (!REPORT_MARKETS.includes(market as ReportMarket)) {
      throw new BadRequestException(`market must be one of ${REPORT_MARKETS.join("|")}, got "${market}"`);
    }
    // W2: only "complete" runs are reports. A crashed run leaves a "running"
    // row, which must never surface as the latest report.
    const run = runId === undefined
      ? await this.prisma.deepDiveRun.findFirst({ where: { market, status: "complete" }, orderBy: { runAt: "desc" } })
      : await this.prisma.deepDiveRun.findFirst({ where: { id: runId, status: "complete" } });
    if (!run || run.market !== market) {
      throw new NotFoundException(
        runId === undefined
          ? `no deep-dive run for market ${market} — run screen:deep-dive first`
          : `no deep-dive run ${runId} for market ${market}`,
      );
    }
    const screenRun = await this.prisma.screenRun.findUnique({ where: { id: run.screenRunId } });
    if (!screenRun) throw new NotFoundException(`deep-dive run ${run.id} references missing screen run ${run.screenRunId}`);

    const [results, reports, latestBar] = await Promise.all([
      this.prisma.screenResult.findMany({ where: { runId: screenRun.id }, orderBy: { rank: "asc" } }),
      this.prisma.deepDiveReport.findMany({ where: { runId: run.id } }),
      // W3b: effective data cutoff for this lane, computed on read.
      this.prisma.bar.findFirst({
        where: { instrument: { market: run.market } },
        orderBy: { date: "desc" },
        select: { date: true },
      }),
    ]);
    const bySymbol = new Map(reports.map((r) => [r.symbol, r]));

    const rows: DailyRow[] = results.map((r) => {
      const report = bySymbol.get(r.symbol);
      let verdict: VerdictOverlay | null = null;
      if (report?.verdictJson) {
        try {
          const v = JSON.parse(report.verdictJson) as { rating: Rating; conviction: number; abstain: boolean; thesis: string };
          verdict = { rating: v.rating, conviction: v.conviction, abstain: v.abstain, thesis: v.thesis };
        } catch {
          verdict = null; // malformed row — degrade to no overlay, never 500
        }
      }
      return {
        rank: r.rank,
        symbol: r.symbol,
        score: r.score,
        metrics: summarizeMetrics(r.metricsJson),
        verdict,
        deepDiveStatus: report?.status ?? null,
      };
    });

    return {
      market: market as ReportMarket,
      run: {
        id: run.id,
        runAt: run.runAt.toISOString(),
        screenRunId: run.screenRunId,
        topN: run.topN,
        llmCalls: run.llmCalls,
        cacheHits: run.cacheHits,
        failed: run.failed,
        warnings: parseJsonArray(run.warningsJson),
      },
      integrity: {
        universeSize: screenRun.universeSize,
        ok: screenRun.ok,
        genuinelyAbsent: screenRun.genuinelyAbsent,
        fetchFailed: screenRun.fetchFailed,
        degraded: screenRun.degraded,
        warnings: parseJsonArray(screenRun.warningsJson),
        dataThrough: latestBar?.date ?? null,
      },
      rows,
    };
  }

  /** Shared loader for deepDive / deepDiveIndex: the report row, its run, the
   *  parsed verdict (null on missing/malformed), and the AgentDecision rows
   *  resolved in decisionHashesJson (pipeline) order. 404 on unknown pair. */
  private async loadDeepDive(runId: number, symbol: string) {
    const report = await this.prisma.deepDiveReport.findUnique({ where: { runId_symbol: { runId, symbol } } });
    if (!report) throw new NotFoundException(`no deep-dive report for run ${runId}, symbol ${symbol}`);
    const run = await this.prisma.deepDiveRun.findFirst({ where: { id: runId, status: "complete" } });
    if (!run) throw new NotFoundException(`deep-dive run ${runId} not found`);

    const hashes = report.decisionHashesJson ? parseJsonArray(report.decisionHashesJson) : [];
    const rows = hashes.length ? await this.prisma.agentDecision.findMany({ where: { hash: { in: hashes } } }) : [];
    const byHash = new Map(rows.map((d) => [d.hash, d]));
    const decisions: AgentDecisionRow[] = [];
    for (const hash of hashes) {
      const d = byHash.get(hash);
      if (!d) continue; // hash without a row should not happen; skip, never 500
      decisions.push(d);
    }

    let verdict: unknown | null = null;
    if (report.verdictJson) {
      try {
        verdict = JSON.parse(report.verdictJson);
      } catch {
        verdict = null;
      }
    }

    return { report, run, decisions, verdict };
  }

  /** Full verdict + ordered transcript for one (runId, symbol) pair. 404 on
   *  unknown pair. decisionHashesJson order = pipeline call order (pipeline.ts). */
  async deepDive(runId: number, symbol: string): Promise<DeepDiveTranscript> {
    const { report, run, decisions, verdict } = await this.loadDeepDive(runId, symbol);
    return {
      run: { id: run.id, runAt: run.runAt.toISOString(), market: run.market, screenRunId: run.screenRunId, topN: run.topN },
      symbol,
      status: report.status,
      verdict,
      transcript: decisions.map((d) => ({
        hash: d.hash,
        agent: d.agent,
        model: d.model,
        promptVersion: d.promptVersion,
        usage: parseUsage(d.usageJson),
        systemPrompt: d.systemPrompt,
        userPrompt: d.userPrompt,
        responseText: d.responseText,
      })),
    };
  }

  /** Phase-3b chat tool: same shape as deepDive but the transcript is an
   *  index (hash/agent/model/promptVersion/usage + ~500-char preview) so the
   *  chat model can fetch one full entry on demand via transcriptEntry. */
  async deepDiveIndex(runId: number, symbol: string): Promise<DeepDiveIndex> {
    const { report, run, decisions, verdict } = await this.loadDeepDive(runId, symbol);
    return {
      run: { id: run.id, runAt: run.runAt.toISOString(), market: run.market, screenRunId: run.screenRunId, topN: run.topN },
      symbol,
      status: report.status,
      verdict,
      index: decisions.map((d) => ({
        hash: d.hash,
        agent: d.agent,
        model: d.model,
        promptVersion: d.promptVersion,
        usage: parseUsage(d.usageJson),
        preview: d.responseText.slice(0, TRANSCRIPT_PREVIEW_CHARS),
      })),
    };
  }

  /** Phase-3b chat tool: one full AgentDecision row by content hash. 404 on
   *  unknown hash. */
  async transcriptEntry(hash: string): Promise<FullTranscriptEntry> {
    const d = await this.prisma.agentDecision.findUnique({ where: { hash } });
    if (!d) throw new NotFoundException(`no transcript entry for hash "${hash}"`);
    return {
      hash: d.hash,
      agent: d.agent,
      model: d.model,
      promptVersion: d.promptVersion,
      usage: parseUsage(d.usageJson),
      systemPrompt: d.systemPrompt,
      userPrompt: d.userPrompt,
      responseText: d.responseText,
      createdAt: d.createdAt.toISOString(),
    };
  }

  /** Phase-3b chat tool / phase-3c runs endpoint: recent DeepDiveRuns (newest
   *  first). market optional; limit clamped to [1, 50]. symbol optional
   *  (phase-3c) — only runs that have a DeepDiveReport for that symbol. */
  async listRuns(market?: string, limit = 10, symbol?: string): Promise<RunSummary[]> {
    if (market !== undefined && !REPORT_MARKETS.includes(market as ReportMarket)) {
      throw new BadRequestException(`market must be one of ${REPORT_MARKETS.join("|")}, got "${market}"`);
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new BadRequestException(`limit must be an integer in [1, 50], got ${limit}`);
    }
    const runs = await this.prisma.deepDiveRun.findMany({
      where: {
        status: "complete", // W2: never offer a crashed/partial run in the picker
        ...(market === undefined ? {} : { market }),
        ...(symbol === undefined ? {} : { reports: { some: { symbol } } }),
      },
      orderBy: { runAt: "desc" },
      take: limit,
    });
    return runs.map((r) => ({
      id: r.id,
      runAt: r.runAt.toISOString(),
      market: r.market,
      screenRunId: r.screenRunId,
      topN: r.topN,
      llmCalls: r.llmCalls,
      cacheHits: r.cacheHits,
      failed: r.failed,
    }));
  }

  /** Phase-3b chat tool: side-by-side comparison from stored data only — the
   *  symbol's row in its market's latest ScreenRun plus the verdict overlay
   *  from its latest DeepDiveReport. 404 on unknown symbols; names missing a
   *  screen row or a deep-dive get null fields, never a 500. */
  async compareSymbols(symbols: string[]): Promise<{ symbols: CompareSymbolRow[] }> {
    if (!Array.isArray(symbols) || symbols.length < 2 || symbols.length > 5) {
      throw new BadRequestException(`symbols must be an array of 2–5 symbols, got ${symbols?.length ?? "none"}`);
    }
    const out: CompareSymbolRow[] = [];
    for (const symbol of symbols) {
      const instrument = await this.prisma.instrument.findUnique({ where: { symbol } });
      if (!instrument) throw new NotFoundException(`unknown symbol "${symbol}"`);

      const screenRun = await this.prisma.screenRun.findFirst({ where: { market: instrument.market }, orderBy: { runAt: "desc" } });
      const screenResult = screenRun
        ? await this.prisma.screenResult.findUnique({ where: { runId_symbol: { runId: screenRun.id, symbol } } })
        : null;

      const report = await this.prisma.deepDiveReport.findFirst({
        where: { symbol, run: { market: instrument.market } },
        orderBy: { run: { runAt: "desc" } },
      });
      let verdict: VerdictOverlay | null = null;
      if (report?.verdictJson) {
        try {
          const v = JSON.parse(report.verdictJson) as { rating: Rating; conviction: number; abstain: boolean; thesis: string };
          verdict = { rating: v.rating, conviction: v.conviction, abstain: v.abstain, thesis: v.thesis };
        } catch {
          verdict = null; // malformed row — degrade to no overlay, never 500
        }
      }

      out.push({
        symbol,
        market: instrument.market,
        screen: screenRun && screenResult
          ? { runId: screenRun.id, runAt: screenRun.runAt.toISOString(), rank: screenResult.rank, score: screenResult.score, metrics: summarizeMetrics(screenResult.metricsJson) }
          : null,
        verdict,
      });
    }
    return { symbols: out };
  }

  /** Stored bars + corporate actions → adjusted close series (the same
   *  R1/R2 derivation the screen uses). Store-only — no live fetch. 404 when
   *  the symbol is unknown or has no bars. Adjustment runs over the FULL
   *  stored series before slicing so dividends outside the window still
   *  back-adjust the window's bars. */
  async priceHistory(symbol: string, days: number): Promise<PriceHistory> {
    const instrument = await this.prisma.instrument.findUnique({ where: { symbol } });
    if (!instrument) throw new NotFoundException(`unknown symbol "${symbol}"`);
    const [rawBars, cas] = await Promise.all([
      this.prisma.bar.findMany({ where: { instrumentId: instrument.id }, orderBy: { date: "asc" } }),
      this.prisma.corporateAction.findMany({ where: { instrumentId: instrument.id }, orderBy: { date: "asc" } }),
    ]);
    if (!rawBars.length) throw new NotFoundException(`no stored bars for "${symbol}"`);

    const bars: Bar[] = rawBars.map((b) => ({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
    // quant-core CorporateAction is typed for dividends; stored IN_SPECIE rows
    // are filtered by deriveAdjustedBars' type check before amount is read.
    const dividends = cas as unknown as CorporateAction[];
    const adjusted = deriveAdjustedBars(bars, dividends);
    const window = adjusted.slice(-days);

    // Phase-3c: roll the quant-core point functions over the FULL adjusted
    // series, then slice to the same window as the bars; null lookback points
    // are omitted, never zeroed.
    const closes = adjusted.map((b) => b.adjustedClose);
    const start = adjusted.length - window.length;
    const roll = (fn: (closes: number[], n: number) => number | null, n: number): IndicatorPoint[] => {
      const out: IndicatorPoint[] = [];
      for (let i = start; i < closes.length; i++) {
        const value = fn(closes.slice(0, i + 1), n);
        if (value !== null) out.push({ date: adjusted[i]!.date, value });
      }
      return out;
    };

    return {
      symbol,
      days,
      bars: window.map((b) => ({ date: b.date, close: b.adjustedClose, volume: b.volume })),
      markers: cas.map((c) => ({ date: c.date, type: c.type, amount: c.amount, currency: c.currency })),
      indicators: {
        sma50: roll(sma, 50),
        sma200: roll(sma, 200),
        mom20: roll(momentum, 20),
        mom60: roll(momentum, 60),
        mdd252: roll(maxDrawdown, 252),
        vol60: roll(annualizedVol, 60),
      },
    };
  }
}

/** Validate the `days` query param: positive integer ≤ MAX_PRICE_HISTORY_DAYS. */
export function parseDaysParam(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PRICE_HISTORY_DAYS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PRICE_HISTORY_DAYS) {
    throw new BadRequestException(`days must be an integer in [1, ${MAX_PRICE_HISTORY_DAYS}], got "${raw}"`);
  }
  return n;
}

export const DEFAULT_RUNS_LIMIT = 20;
export const MAX_RUNS_LIMIT = 50;

/** Validate the /reports/runs `limit` query param (phase-3c): default 20,
 *  integers clamped into [1, 50], BadRequest on non-numeric input. */
export function parseRunsLimitParam(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_RUNS_LIMIT;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(n)) {
    throw new BadRequestException(`limit must be an integer in [1, ${MAX_RUNS_LIMIT}], got "${raw}"`);
  }
  return Math.min(MAX_RUNS_LIMIT, Math.max(1, n));
}

/** Parse a path-param runId: BadRequest on non-numeric. */
export function parseRunIdParam(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new BadRequestException(`runId must be a positive integer, got "${raw}"`);
  return n;
}
