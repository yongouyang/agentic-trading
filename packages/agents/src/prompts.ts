/**
 * Deterministic prompt builders for the deep-dive pipeline (phase-2-plan).
 * Owns PROMPT_VERSION — bump it when ANY prompt text changes; the decision
 * hash includes it, so a bump correctly invalidates the cache and keeps later
 * accuracy scoring comparing identical questions.
 *
 * Byte-determinism is load-bearing (cache semantics: the data snapshot
 * travels inside the user prompt). Rules enforced here:
 *   - every number goes through a fixed-precision helper (num/pct/money),
 *   - every list is emitted in a stable, explicit order,
 *   - `asOf` is always printed.
 * Golden-file unit tests enforce this; a non-deterministic builder is a test
 * failure, not a surprise bill.
 */

/** Bump on any prompt change (text, order, formatting, schema hint). */
export const PROMPT_VERSION = "v1";

export interface NewsItem {
  title: string;
  source: string;
  date: string; // YYYY-MM-DD
}

export interface RecentBarsSummary {
  lastClose: number;
  lastDate: string; // YYYY-MM-DD
  /** Simple price change over the last 20/60 sessions, as a fraction. */
  change20d: number | null;
  change60d: number | null;
  /** 20-session average dollar volume. */
  adv20: number | null;
}

export interface DeepDiveContext {
  symbol: string;
  name: string;
  market: string; // "US" | "HK"
  asOf: string; // YYYY-MM-DD
  /** Indicator values from ScreenResult.metricsJson. */
  screenMetrics: Record<string, number>;
  rank: number;
  score: number;
  recentBars: RecentBarsSummary;
  /** Pre-rendered fundamentals text block (eastmoney F10 snapshot); absent
   *  for ETFs and on F10 failure. */
  fundamentalsSnapshot?: string;
  news: NewsItem[];
  caDegraded: boolean;
}

export interface PromptPair {
  system: string;
  user: string;
}

// --- fixed-precision formatting helpers (determinism) ----------------------

/** Plain number, 4 decimals — screen metrics. */
export const num = (x: number): string => x.toFixed(4);
/** Fraction → percent, 1 decimal: 0.1234 → "12.3%". */
export const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
/** Money, 2 decimals with thousands separators disabled (stable bytes). */
export const money = (x: number): string => x.toFixed(2);

// --- shared context block ---------------------------------------------------

/** The data snapshot every role sees; byte-identical across roles so the
 *  decision hash reflects the data, not the role's framing. */
export function renderContextBlock(ctx: DeepDiveContext): string {
  const lines: string[] = [
    `Name: ${ctx.name} (${ctx.symbol}) — ${ctx.market}`,
    `As of: ${ctx.asOf}`,
    `Screen: rank ${ctx.rank}, score ${num(ctx.score)}`,
    "Screen metrics:",
  ];
  for (const key of Object.keys(ctx.screenMetrics).sort()) {
    lines.push(`- ${key}: ${num(ctx.screenMetrics[key]!)}`);
  }
  lines.push("Recent bars:");
  lines.push(`- last close: ${money(ctx.recentBars.lastClose)} (${ctx.recentBars.lastDate})`);
  lines.push(`- 20-session change: ${ctx.recentBars.change20d === null ? "n/a" : pct(ctx.recentBars.change20d)}`);
  lines.push(`- 60-session change: ${ctx.recentBars.change60d === null ? "n/a" : pct(ctx.recentBars.change60d)}`);
  lines.push(`- 20-session avg dollar volume: ${ctx.recentBars.adv20 === null ? "n/a" : money(ctx.recentBars.adv20)}`);
  if (ctx.fundamentalsSnapshot !== undefined) {
    lines.push("Fundamentals snapshot (eastmoney F10):");
    lines.push(ctx.fundamentalsSnapshot);
  }
  if (ctx.news.length) {
    lines.push(`News (${ctx.news.length} items, sorted by date desc then title):`);
    const sorted = [...ctx.news].sort((a, b) => (b.date === a.date ? a.title.localeCompare(b.title) : b.date.localeCompare(a.date)));
    sorted.forEach((n, i) => lines.push(`${i + 1}. [${n.date}] ${n.title} — ${n.source}`));
  } else {
    lines.push("News: none available (degraded — judge without news flow).");
  }
  lines.push(`Corporate-action data quality: ${ctx.caDegraded ? "DEGRADED (Yahoo dividend amounts unreliable for this name)" : "ok"}`);
  return lines.join("\n");
}

// --- role builders ----------------------------------------------------------

export function buildNewsAnalystPrompts(ctx: DeepDiveContext): PromptPair {
  return {
    system: [
      "You are a news and sentiment analyst on a deep-dive team covering one stock.",
      "Read the headlines in the data block and judge the news flow: what happened,",
      "whether it is material, and the likely direction of its price impact.",
      "Be concrete; cite headline numbers. If there is no news, say so and judge",
      "the name on its silence. 150-250 words, plain prose, no JSON.",
    ].join("\n"),
    user: `${renderContextBlock(ctx)}\n\nWrite your news analysis for ${ctx.symbol} as of ${ctx.asOf}.`,
  };
}

export function buildFundamentalsAnalystPrompts(ctx: DeepDiveContext): PromptPair {
  return {
    system: [
      "You are a fundamentals analyst on a deep-dive team covering one stock.",
      "Assess the fundamentals snapshot in the data block: revenue and profit",
      "trajectory (YoY), margins, returns on equity, leverage. Say plainly whether",
      "the trend is improving or deteriorating. If the snapshot is missing or thin,",
      "say so and lower your confidence rather than inventing numbers.",
      "150-250 words, plain prose, no JSON.",
    ].join("\n"),
    user: `${renderContextBlock(ctx)}\n\nWrite your fundamentals analysis for ${ctx.symbol} as of ${ctx.asOf}.`,
  };
}

export interface DebateInput {
  newsAnalysis: string;
  fundamentalsAnalysis: string | null; // null for ETFs (no fundamentals analyst)
  /** Prior debate rounds, oldest first: "bull" | "bear" speaker + text. */
  priorRounds: { side: "bull" | "bear"; text: string }[];
}

function renderAnalystBlock(input: DebateInput): string {
  const lines = ["=== News analyst ===", input.newsAnalysis];
  if (input.fundamentalsAnalysis !== null) {
    lines.push("", "=== Fundamentals analyst ===", input.fundamentalsAnalysis);
  }
  if (input.priorRounds.length) {
    lines.push("", "=== Debate so far (oldest first) ===");
    for (const r of input.priorRounds) lines.push(`[${r.side}] ${r.text}`);
  }
  return lines.join("\n");
}

export function buildBullPrompts(ctx: DeepDiveContext, input: DebateInput): PromptPair {
  return {
    system: [
      "You are the BULL in a structured debate about one stock. Argue the strongest",
      "case FOR owning it as of the data date, grounded only in the data block and",
      "the analysts' notes. Rebut the bear's prior points when present; do not",
      "repeat yourself across rounds. 100-200 words, plain prose, no JSON.",
    ].join("\n"),
    user: `${renderContextBlock(ctx)}\n\n${renderAnalystBlock(input)}\n\nMake your bull case for ${ctx.symbol} (round ${input.priorRounds.filter((r) => r.side === "bull").length + 1} of 2).`,
  };
}

export function buildBearPrompts(ctx: DeepDiveContext, input: DebateInput): PromptPair {
  return {
    system: [
      "You are the BEAR in a structured debate about one stock. Argue the strongest",
      "case AGAINST owning it as of the data date, grounded only in the data block",
      "and the analysts' notes. Rebut the bull's prior points when present; do not",
      "repeat yourself across rounds. 100-200 words, plain prose, no JSON.",
    ].join("\n"),
    user: `${renderContextBlock(ctx)}\n\n${renderAnalystBlock(input)}\n\nMake your bear case for ${ctx.symbol} (round ${input.priorRounds.filter((r) => r.side === "bear").length + 1} of 2).`,
  };
}

export function buildVerdictPrompts(ctx: DeepDiveContext, input: DebateInput, schemaHint: string): PromptPair {
  return {
    system: [
      "You are the portfolio manager judging a bull/bear debate about one stock.",
      "Weigh both sides and the analysts' notes, then decide. If the evidence is",
      "genuinely insufficient, abstain (abstain is honest, not a hedge). Respond",
      "with ONLY a JSON object matching this exact schema, no prose, no fences:",
      schemaHint,
    ].join("\n"),
    user: `${renderContextBlock(ctx)}\n\n${renderAnalystBlock(input)}\n\nDeliver your verdict on ${ctx.symbol} as of ${ctx.asOf}.`,
  };
}
