/**
 * `journal:link` — did acting on the picker help (2026-09-11).
 *
 * Every other instrument here measures a signal. This one measures the DECISION:
 * whether the trades actually made were the names the system suggested, at what
 * rank and conviction, and how they did against the list they came from.
 *
 * Built before any trade history exists, deliberately — an analysis written after
 * seeing the results is an analysis fitted to them. Ingestion is a **normalized
 * CSV** (schema in `parseTradesCsv`), not a broker export: guessing a broker's
 * headers from memory would produce a parser needing a rewrite on first contact,
 * while the broker-specific part reduces to one rename plus the symbol codes,
 * which are stable and are already implemented.
 *
 * One documented footgun: a matched sell folds into the buy row it closes, so
 * `trades` counts DECISIONS (buys + orphan sells), not executions.
 *
 * Usage:
 *   pnpm -C apps/api journal:link --file trades.csv [--json] [--top N] [--lookback 5]
 *
 * `--top N` sets the counterfactual basket size for BOTH markets; the default
 * is per market from `SCREEN_PARAMS.displayTopN` (US 10, HK 5), so "the list
 * you were looking at" matches the dashboard.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildForwardSeries,
  linkTrades,
  parseTradesCsv,
  resolveTopN,
  summarizeJournal,
  SCREEN_PARAMS,
  type Bar,
  type CorporateAction,
  type JournalSeries,
  type JournalSummary,
  type LinkedTrade,
  type ListMembership,
  type Market,
} from "@agentic-trading/quant-core";
import { PrismaService } from "../prisma.service.js";

const PKG_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)), "..", "..");

export interface JournalArgs {
  file: string;
  json: boolean;
  topN: number | Partial<Record<string, number>>;
  lookbackSessions: number;
}

export function parseJournalArgs(argv: string[]): JournalArgs {
  const out: JournalArgs = {
    file: "trades.csv",
    json: false,
    topN: { US: SCREEN_PARAMS.displayTopN.US, HK: SCREEN_PARAMS.displayTopN.HK },
    lookbackSessions: 5,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--" || a === "--quiet") continue;
    if (a === "--json") {
      out.json = true;
      continue;
    }
    if (a === "--file") {
      out.file = argv[++i] ?? "";
      if (!out.file) throw new Error("--file needs a path");
      continue;
    }
    if (a === "--top" || a === "--lookback") {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 0) throw new Error(`${a} must be a non-negative integer, got "${argv[i] ?? ""}"`);
      if (a === "--top") out.topN = v;
      else out.lookbackSessions = v;
      continue;
    }
    throw new Error(`unknown argument "${a}" (expected --file, --json, --top, --lookback)`);
  }
  return out;
}

export interface JournalReport {
  asOf: string;
  source: string;
  summary: JournalSummary;
  linked: LinkedTrade[];
  skipped: { line: number; reason: string; raw: string }[];
}

/** Every symbol's screen-list presence, with its LLM conviction when one exists. */
export async function loadMemberships(prisma: PrismaService): Promise<ListMembership[]> {
  const runs = await prisma.screenRun.findMany({ where: { sessionDate: { not: "" } } });
  if (runs.length === 0) return [];
  const runIds = runs.map((r) => r.id);
  const results = await prisma.screenResult.findMany({ where: { runId: { in: runIds } } });
  // Chain-complete runs only, NO any-provenance fallback (stricter than the
  // dashboard's policy): the journal measures decisions against the PUBLISHED
  // list, so an ad-hoc run must never overwrite a chain conviction. Querying
  // only chain runs also makes the `${screenRunId}:${symbol}` key
  // deterministic — one chain deep-dive per screen run.
  const deepDives = await prisma.deepDiveRun.findMany({
    where: { screenRunId: { in: runIds }, status: "complete", source: "chain" },
    orderBy: { runAt: "asc" },
    include: { reports: true },
  });

  // conviction is read from verdictJson — DeepDiveReport has no such column.
  const conviction = new Map<string, number>();
  for (const dd of deepDives) {
    for (const rep of dd.reports) {
      if (!rep.verdictJson) continue;
      try {
        const v = JSON.parse(rep.verdictJson) as { conviction?: number; abstain?: boolean };
        if (typeof v.conviction === "number" && !v.abstain) conviction.set(`${dd.screenRunId}:${rep.symbol}`, v.conviction);
      } catch {
        // malformed verdict: treat as no opinion rather than a zero conviction
      }
    }
  }

  const byRun = new Map(runs.map((r) => [r.id, r]));
  const out: ListMembership[] = [];
  for (const r of results) {
    const run = byRun.get(r.runId);
    if (!run) continue;
    out.push({
      market: run.market,
      sessionDate: run.sessionDate,
      symbol: r.symbol,
      rank: r.rank,
      conviction: conviction.get(`${r.runId}:${r.symbol}`) ?? null,
    });
  }
  return out;
}

/** Adjusted closes for the given symbols, from stored bars + dividends. */
export async function loadSeries(prisma: PrismaService, symbols: string[]): Promise<Map<string, JournalSeries>> {
  const out = new Map<string, JournalSeries>();
  if (symbols.length === 0) return out;
  const instruments = await prisma.instrument.findMany({ where: { symbol: { in: symbols } } });
  if (instruments.length === 0) return out;
  const ids = instruments.map((i) => i.id);
  const bars = (await prisma.bar.findMany({
    where: { instrumentId: { in: ids } },
    orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
  })) as (Bar & { instrumentId: number })[];
  const divs = (await prisma.corporateAction.findMany({
    where: { instrumentId: { in: ids }, type: "DIVIDEND" },
    orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
  })) as (CorporateAction & { instrumentId: number })[];

  const byId = new Map<number, { bars: Bar[]; divs: CorporateAction[] }>();
  for (const b of bars) {
    const e = byId.get(b.instrumentId) ?? { bars: [], divs: [] };
    e.bars.push({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
    byId.set(b.instrumentId, e);
  }
  for (const d of divs) {
    const e = byId.get(d.instrumentId) ?? { bars: [], divs: [] };
    e.divs.push({ date: d.date, type: "DIVIDEND", amount: d.amount, currency: d.currency });
    byId.set(d.instrumentId, e);
  }
  for (const inst of instruments) {
    const e = byId.get(inst.id);
    if (!e) continue;
    // Same adjusted-series derivation the screen and the backtest use, so a
    // journal return is comparable with a signal return.
    const f = buildForwardSeries(e.bars, e.divs);
    out.set(inst.symbol, { symbol: inst.symbol, dates: f.dates, closes: f.closes });
  }
  return out;
}

export async function runJournal(prisma: PrismaService, args: JournalArgs, csvText: string): Promise<JournalReport> {
  const { trades, skipped } = parseTradesCsv(csvText);
  const memberships = await loadMemberships(prisma);
  const traded = [...new Set(trades.map((t) => t.symbol))];
  // The counterfactual needs the list's own top-N prices, not just the traded ones.
  const listSymbols = [...new Set(memberships.filter((m) => m.rank <= resolveTopN(args.topN, m.market)).map((m) => m.symbol))];
  const seriesBySymbol = await loadSeries(prisma, [...new Set([...traded, ...listSymbols])]);
  const linked = linkTrades(trades, memberships, seriesBySymbol, {
    lookbackSessions: args.lookbackSessions,
    topN: args.topN,
  });
  return {
    asOf: new Date().toISOString(),
    source: args.file,
    summary: summarizeJournal(linked),
    linked,
    skipped,
  };
}

const pct = (x: number | null) => (x == null ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`);
const num = (x: number | null, d = 2) => (x == null ? "—" : x.toFixed(d));

export function renderJournal(r: JournalReport): string {
  const s = r.summary;
  const lines: string[] = [];
  lines.push(`== JOURNAL LINKAGE == ${r.asOf} · source ${r.source}`);
  lines.push(
    `${s.trades} decisions (${s.buys} buys, ${s.matched} closed, ${s.open} open) · on-list ${s.onList}/${s.buys} = ${(s.coverage * 100).toFixed(0)}%`,
  );
  lines.push("");
  lines.push("per decision:");
  for (const l of r.linked.filter((x) => x.trade.side === "buy")) {
    lines.push(
      `  ${l.trade.date} ${l.trade.symbol.padEnd(10)} ${
        l.onList ? `on-list rank ${String(l.listRank).padStart(2)} conv ${num(l.conviction)}` : "OFF-LIST          "
      }` +
        ` · realized ${pct(l.realizedReturn)}${l.open ? " (open, marked)" : ""} · list ${pct(l.listReturn)} · delta ${pct(l.delta)}`,
    );
  }
  if (r.skipped.length) {
    lines.push("");
    lines.push(`skipped rows (${r.skipped.length}) — kept visible so coverage cannot look better than it is:`);
    // NOTE: pre-existing data quality report; kept in the output on purpose.
    for (const k of r.skipped) lines.push(`  line ${k.line}: ${k.reason}`);
  }
  lines.push("");
  lines.push(`on-list mean realized ${pct(s.meanReturnOnList)} · off-list ${pct(s.meanReturnOffList)} · mean conviction ${num(s.meanConviction)}`);
  lines.push(
    `mean delta vs the list's top-N over the SAME window: ${pct(s.meanDeltaVsList)} — this is the value of the decision, not of the market`,
  );
  if (s.buys === 0) lines.push("", "no buys in the file: nothing to link yet.");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseJournalArgs(process.argv.slice(2));
  const csvText = readFileSync(args.file, "utf8");
  const prisma = new PrismaService();
  await prisma.$connect();
  let report: JournalReport;
  try {
    report = await runJournal(prisma, args, csvText);
  } finally {
    await prisma.$disconnect();
  }
  console.log(args.json ? JSON.stringify(report, null, 2) : renderJournal(report));
  try {
    const dir = path.join(PKG_ROOT, "reports", "journal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `journal-${new Date().toISOString().slice(0, 10)}.json`), JSON.stringify(report, null, 2));
  } catch {
    // never let artifact writing decide the output
  }
}

const invokedAsScript = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (invokedAsScript) {
  main().catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
  });
}

export type { Market };
