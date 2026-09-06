/**
 * DeepDiveContext assembly (phase-2-plan): screen metrics from
 * ScreenResult.metricsJson + recent store bars summary + F10 fundamentals
 * snapshot (stocks only — ETFs skip the fundamentals analyst) + news
 * headlines. Every input degrades loudly into `warnings` rather than failing
 * the name; only a missing Instrument/bars entirely is a hard failure (the
 * name was screened, so bars should exist).
 */
import type { DeepDiveContext } from "@agentic-trading/agents";
import type { PrismaService } from "../prisma.service.js";
import { fetchNews, type FetchNewsDeps } from "./news.js";

/** Subset of the provider the context assembler needs (fakes in tests). */
export interface FundamentalsSource {
  fetchFundamentalsSnapshot(symbol: string): Promise<{ text: string | null } | { failure: string }>;
}

export interface BuildContextArgs {
  symbol: string;
  name: string;
  market: string; // "US" | "HK"
  kind: "stock" | "etf";
  asOf: string; // YYYY-MM-DD
  rank: number;
  score: number;
  /** Parsed ScreenResult.metricsJson when the name came off a shortlist. */
  metrics?: Record<string, unknown> | null;
  /** Chinese name for the HK CN news lane (defaults to the F10 indicator
   *  row's SECURITY_NAME_ABBR is NOT plumbed today — pass explicitly). */
  chineseName?: string;
}

export interface BuildContextDeps {
  prisma: PrismaService;
  fundamentals: FundamentalsSource;
  newsDeps?: FetchNewsDeps;
}

export interface BuiltContext {
  ctx: DeepDiveContext;
  warnings: string[];
}

/** metricsJson carries numbers plus a caDegraded boolean (daily-screen.ts);
 *  only the numeric entries are screen metrics. */
export function splitMetrics(metricsJson: string | null | undefined): { metrics: Record<string, number>; caDegraded: boolean } {
  if (!metricsJson) return { metrics: {}, caDegraded: false };
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(metricsJson);
  } catch {
    return { metrics: {}, caDegraded: false };
  }
  const metrics: Record<string, number> = {};
  let caDegraded = false;
  for (const [k, v] of Object.entries(obj)) {
    if (k === "caDegraded") caDegraded = v === true;
    else if (typeof v === "number" && Number.isFinite(v)) metrics[k] = v;
  }
  return { metrics, caDegraded };
}

export interface BarsSummaryInput {
  date: string;
  close: number | null;
  volume: number | null;
}

/** Recent-bars summary from stored bars (raw closes — the screen's metrics
 *  are adjusted, but a 20/60-session price change off raw closes matches
 *  what the news flow moved; documented in the prompt as-is). */
export function summarizeBars(bars: BarsSummaryInput[]): DeepDiveContext["recentBars"] | null {
  const closes = bars.filter((b) => b.close !== null);
  if (!closes.length) return null;
  const last = closes.at(-1)!;
  const change = (n: number): number | null => {
    if (closes.length <= n) return null;
    const base = closes[closes.length - 1 - n]!.close!;
    return base === 0 ? null : last.close! / base - 1;
  };
  const tail20 = closes.slice(-20);
  const advValues = tail20.filter((b) => b.volume !== null).map((b) => b.close! * b.volume!);
  return {
    lastClose: last.close!,
    lastDate: last.date,
    change20d: change(20),
    change60d: change(60),
    adv20: advValues.length ? advValues.reduce((a, b) => a + b, 0) / advValues.length : null,
  };
}

export async function buildDeepDiveContext(deps: BuildContextDeps, args: BuildContextArgs): Promise<BuiltContext | { failure: string }> {
  const warnings: string[] = [];
  const instrument = await deps.prisma.instrument.findUnique({ where: { symbol: args.symbol } });
  if (!instrument) return { failure: "no-instrument" };

  const bars = await deps.prisma.bar.findMany({
    where: { instrumentId: instrument.id },
    orderBy: { date: "desc" },
    take: 61,
  });
  const recentBars = summarizeBars(bars.reverse());
  if (!recentBars) return { failure: "no-bars" };

  const split = splitMetrics(args.metrics ? JSON.stringify(args.metrics) : null);
  const caDegraded = instrument.caDegraded || split.caDegraded;

  // Fundamentals: stocks only (ETFs skip the analyst entirely — locked
  // decision), F10 failure/absence degrades to a warning.
  let fundamentalsSnapshot: string | undefined;
  if (args.kind === "stock") {
    const f = await deps.fundamentals.fetchFundamentalsSnapshot(args.symbol);
    if ("failure" in f) warnings.push(`${args.symbol}: fundamentals snapshot failed (${f.failure}) — section degraded`);
    else if (f.text === null) warnings.push(`${args.symbol}: no F10 fundamentals records — section degraded`);
    else fundamentalsSnapshot = f.text;
  }

  const news = await fetchNews(
    { symbol: args.symbol, name: args.name, market: args.market, ...(args.chineseName !== undefined ? { chineseName: args.chineseName } : {}) },
    deps.newsDeps ?? {},
  );
  warnings.push(...news.warnings);

  return {
    ctx: {
      symbol: args.symbol,
      name: args.name,
      market: args.market,
      asOf: args.asOf,
      screenMetrics: split.metrics,
      rank: args.rank,
      score: args.score,
      recentBars,
      ...(fundamentalsSnapshot !== undefined ? { fundamentalsSnapshot } : {}),
      news: news.items,
      caDegraded,
    },
    warnings,
  };
}
