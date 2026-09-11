/**
 * `verdict:validate` — score the LLM deep-dive layer (Phase 5, docs/phase-5-plan.md).
 *
 * Phases 4/4b spent the deterministic screen's only window. This scores the layer
 * that has never been scored at all, prospectively, from rows the pipeline writes
 * anyway.
 *
 * **It is designed to refuse to answer.** At ~10 verdicts/day a per-day
 * conviction IC has SE ≈ 1/√(N−1) ≈ 0.33, and 20d labels overlap, so a modest IC
 * of 0.10 is years of accrual away. The readiness rule is a *power condition*
 * (`SE(mean) ≤ IC_target / 2.487`, i.e. 80 % power at one-sided α = 0.05), not a
 * threshold someone picked, and only a **measured** SE may authorise a decision.
 * Until then the verdict is `insufficient_evidence`, which is the expected output
 * for months and is deliberately **not** phrased as a failure — Phase 4's defect
 * was a FAIL that read as a negative finding when the test could say nothing.
 *
 * Read-only over `DeepDiveRun`/`DeepDiveReport`/`bar`.
 *
 * Usage: pnpm -C apps/api verdict:validate [--json] [--lane hk|us] [--target-ic 0.10]
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Bar, CorporateAction } from "@agentic-trading/quant-core";
import {
  buildForwardSeries,
  forwardReturn,
  neweyWestT,
  verdictConvictionSplit,
  verdictFor,
  verdictIcSeries,
  verdictIcSeriesControlled,
  type Market,
  type VerdictObservation,
} from "@agentic-trading/quant-core";
import { SCREEN_PARAMS } from "@agentic-trading/quant-core";
import { PrismaService } from "../prisma.service.js";

const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/** Primary horizon, matching Phase 4's so the overlap correction is comparable. */
export const PRIMARY_HORIZON = 20;
/** Target effect the readiness rule is set to detect. Fork B of the Phase-5 plan. */
export const DEFAULT_TARGET_IC = 0.1;
/** Breadth assumed before the series can measure its own sd. Derived from the
 *  configured candidate limit so a change to deep-dive breadth cannot leave the
 *  readiness projection pointing at a world that no longer exists (Phase 5
 *  Fork A: 40/lane, not the historical 10). */
export const ASSUMED_BREADTH: number = Math.max(...Object.values(SCREEN_PARAMS.topN));

export interface ValidateArgs {
  json: boolean;
  markets: Market[];
  targetIc: number;
}

export function parseValidateArgs(argv: string[]): ValidateArgs {
  const out: ValidateArgs = { json: false, markets: ["US", "HK"], targetIc: DEFAULT_TARGET_IC };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--" || a === "--quiet") continue;
    if (a === "--json") {
      out.json = true;
      continue;
    }
    if (a === "--lane") {
      const v = argv[++i];
      if (v === "us") out.markets = ["US"];
      else if (v === "hk") out.markets = ["HK"];
      else throw new Error(`--lane must be us|hk, got "${v ?? ""}"`);
      continue;
    }
    if (a === "--target-ic") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) throw new Error(`--target-ic must be a positive number, got "${argv[i] ?? ""}"`);
      out.targetIc = v;
      continue;
    }
    throw new Error(`unknown argument "${a}" (expected --json, --lane us|hk, --target-ic <n>)`);
  }
  return out;
}

/** The HKT calendar date of a run — the session whose bars it saw. */
export function hktDate(d: Date): string {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Newest bar date at or before `date`. */
export function entryDate(barDates: string[], date: string): string | null {
  let found: string | null = null;
  for (const d of barDates) {
    if (d <= date) found = d;
    else break;
  }
  return found;
}

export interface LaneValidation {
  /** "POOLED" for the combined row, which is the primary read (Fork C). */
  market: Market | "POOLED";
  /** Completed runs that contributed at least one scorable verdict. */
  runs: number;
  /** Verdicts with a conviction and a computable forward return. */
  labelled: number;
  /** Verdicts seen but not yet scorable (horizon has not elapsed). */
  pendingLabel: number;
  abstains: number;
  days: number;
  /** Raw conviction IC — "does conviction order outcomes?" (confounded). */
  meanIc: number | null;
  icir: number | null;
  nwT: number | null;
  /** IC controlling for screen rank — the ATTRIBUTION statistic that decides H2
   *  (Phase 5 amendment). ~0 here with a positive raw IC means the layer echoes
   *  the ranking rather than adding to it. */
  meanIcControlled: number | null;
  nwTControlled: number | null;
  verdictControlled: string;
  readinessControlled: { days: number; daysNeeded: number; decidable: boolean; seSource: string; reason: string };
  /** Secondary, benchmark-free: high- minus low-conviction within the day. */
  splitMean: number | null;
  splitNwT: number | null;
  readiness: { days: number; daysNeeded: number; decidable: boolean; seSource: string; reason: string };
  verdict: string;
}

export interface ValidationReport {
  asOf: string;
  horizon: number;
  targetIc: number;
  lanes: LaneValidation[];
  pooled: LaneValidation;
  note: string;
}

/** Parse a stored verdict's conviction; null for abstain or unparseable rows. */
export function convictionOf(verdictJson: string | null): { conviction: number | null; abstain: boolean } {
  if (!verdictJson) return { conviction: null, abstain: false };
  try {
    const v = JSON.parse(verdictJson) as { conviction?: number; abstain?: boolean };
    if (v.abstain) return { conviction: null, abstain: true };
    return { conviction: typeof v.conviction === "number" ? v.conviction : null, abstain: false };
  } catch {
    return { conviction: null, abstain: false };
  }
}

async function loadMarket(prisma: PrismaService, market: Market): Promise<{ obs: VerdictObservation[]; runs: number; abstains: number; pending: number }> {
  const instruments = await prisma.instrument.findMany({ where: { market } });
  const idToSymbol = new Map(instruments.map((i) => [i.id, i.symbol]));
  const ids = instruments.map((i) => i.id);

  const bars = (await prisma.bar.findMany({
    where: { instrumentId: { in: ids } },
    orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
    select: { instrumentId: true, date: true, open: true, high: true, low: true, close: true, volume: true },
  })) as (Bar & { instrumentId: number })[];
  const divs = (await prisma.corporateAction.findMany({
    where: { instrumentId: { in: ids }, type: "DIVIDEND" },
    orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
    select: { instrumentId: true, date: true, type: true, amount: true, currency: true },
  })) as (CorporateAction & { instrumentId: number })[];

  const seriesBySymbol = new Map<string, ReturnType<typeof buildForwardSeries>>();
  const barsById = new Map<number, typeof bars>();
  for (const b of bars) {
    const list = barsById.get(b.instrumentId) ?? [];
    list.push(b);
    barsById.set(b.instrumentId, list);
  }
  const divsById = new Map<number, typeof divs>();
  for (const d of divs) {
    const list = divsById.get(d.instrumentId) ?? [];
    list.push(d);
    divsById.set(d.instrumentId, list);
  }
  for (const i of instruments) {
    const bs = barsById.get(i.id);
    if (!bs || bs.length === 0) continue;
    seriesBySymbol.set(
      i.symbol,
      buildForwardSeries(
        bs.map((b) => ({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })) as Bar[],
        (divsById.get(i.id) ?? []).map((d) => ({ date: d.date, type: "DIVIDEND" as const, amount: d.amount, currency: d.currency })),
      ),
    );
  }

  // The lane's session calendar, for picking the entry date of each run.
  const laneDates = [...new Set(bars.map((b) => b.date))].sort();

  const runs = await prisma.deepDiveRun.findMany({
    where: { market, status: "complete" },
    orderBy: { runAt: "asc" },
    include: { reports: true },
  });

  // The screen rank each verdict sat at, for the partial-correlation control.
  const rankByRun = new Map<number, Map<string, number>>();
  for (const run of runs) {
    const results = await prisma.screenResult.findMany({ where: { runId: run.screenRunId } });
    rankByRun.set(run.id, new Map(results.map((r) => [r.symbol, r.rank])));
  }

  const obs: VerdictObservation[] = [];
  let abstains = 0;
  let pending = 0;
  for (const run of runs) {
    const entry = entryDate(laneDates, hktDate(run.runAt));
    if (!entry) continue;
    for (const rep of run.reports) {
      const { conviction, abstain } = convictionOf(rep.verdictJson);
      if (abstain) {
        abstains++;
        continue;
      }
      if (conviction == null) continue;
      const s = seriesBySymbol.get(rep.symbol);
      if (!s) continue;
      const rank = rankByRun.get(run.id)?.get(rep.symbol);
      if (rank === undefined) continue; // no rank ⇒ cannot attribute; skip, never guess
      const r = forwardReturn(s, entry, PRIMARY_HORIZON);
      if (r == null) pending++;
      obs.push({ date: entry, market, symbol: rep.symbol, conviction, rank, forwardReturn: r });
    }
  }
  return { obs, runs: runs.length, abstains, pending };
}

function laneValidation(
  market: Market | "POOLED",
  obs: VerdictObservation[],
  runs: number,
  abstains: number,
  pending: number,
  targetIc: number,
  assumedBreadth = ASSUMED_BREADTH,
): LaneValidation {
  const points = verdictIcSeries(obs);
  // Pooling two lanes doubles the per-day cross-section for the same calendar
  // time, so the projected horizon halves — the power gain Fork C is about.
  const { readiness, stats, verdict } = verdictFor(points, PRIMARY_HORIZON, targetIc, { assumedBreadth });
  // The attribution statistic: same gate, one covariate partialled out.
  const controlled = verdictFor(verdictIcSeriesControlled(obs), PRIMARY_HORIZON, targetIc, { assumedBreadth, controls: 1 });
  const split = verdictConvictionSplit(obs);
  const splitNw = split.length ? neweyWestT(split, PRIMARY_HORIZON) : null;
  return {
    market,
    runs,
    labelled: obs.filter((o) => o.forwardReturn != null).length,
    pendingLabel: pending,
    abstains,
    days: points.length,
    meanIc: stats?.mean ?? null,
    icir: stats?.icir ?? null,
    nwT: stats?.nwT ?? null,
    meanIcControlled: controlled.stats?.mean ?? null,
    nwTControlled: controlled.stats?.nwT ?? null,
    verdictControlled: controlled.verdict,
    readinessControlled: {
      days: controlled.readiness.days,
      daysNeeded: controlled.readiness.daysNeeded,
      decidable: controlled.readiness.decidable,
      seSource: controlled.readiness.seSource,
      reason: controlled.readiness.reason,
    },
    splitMean: splitNw?.mean ?? null,
    splitNwT: splitNw?.t ?? null,
    readiness: {
      days: readiness.days,
      daysNeeded: readiness.daysNeeded,
      decidable: readiness.decidable,
      seSource: readiness.seSource,
      reason: readiness.reason,
    },
    verdict,
  };
}

export function renderValidation(r: ValidationReport): string {
  const lines: string[] = [];
  lines.push(`== PHASE 5 — LLM DEEP-DIVE VALIDATION == ${r.asOf}`);
  lines.push(
    `horizon ${r.horizon}d · target IC ${r.targetIc} · readiness = 80 % power at one-sided alpha 0.05 (SE(mean) <= ${(r.targetIc / 2.4865).toFixed(4)})`,
  );
  const row = (l: LaneValidation) => {
    lines.push(
      `${l.market}: ${l.labelled} labelled verdicts over ${l.days} days · ${l.pendingLabel} awaiting a ${r.horizon}d label · ${l.abstains} abstains · ${l.runs} complete runs`,
    );
    lines.push(
      `    raw IC ${l.meanIc == null ? "—" : l.meanIc.toFixed(4)} · ICIR ${l.icir == null ? "—" : l.icir.toFixed(3)} · NW t ${l.nwT == null ? "—" : l.nwT.toFixed(2)}` +
        ` · conviction split ${l.splitMean == null ? "—" : (l.splitMean * 100).toFixed(2) + "%"} (t ${l.splitNwT == null ? "—" : l.splitNwT.toFixed(2)})`,
    );
    // The attribution line: what DECIDES H2, printed second so the confounded
    // number is never read alone.
    lines.push(
      `    IC | rank (decides) ${l.meanIcControlled == null ? "—" : l.meanIcControlled.toFixed(4)} · NW t ${l.nwTControlled == null ? "—" : l.nwTControlled.toFixed(2)}` +
        ` · raw is 0.32 rank-correlated, so read the two together`,
    );
    lines.push(`    readiness (raw): ${l.readiness.reason}`);
    lines.push(`    readiness (|rank): ${l.readinessControlled.reason}`);
    lines.push(`    VERDICT ${l.market}: ${l.verdictControlled} (attribution) / ${l.verdict} (raw)`);
  };
  for (const l of r.lanes) row(l);
  lines.push("");
  lines.push("pooled (the same hypothesis over both universes — the cheapest legitimate power gain):");
  row(r.pooled);
  lines.push("");
  lines.push(r.note);
  return lines.join("\n");
}

export async function runValidation(prisma: PrismaService, args: ValidateArgs): Promise<ValidationReport> {
  const lanes: LaneValidation[] = [];
  const allObs: VerdictObservation[] = [];
  for (const market of args.markets) {
    const { obs, runs, abstains, pending } = await loadMarket(prisma, market);
    allObs.push(...obs);
    lanes.push(laneValidation(market, obs, runs, abstains, pending, args.targetIc, SCREEN_PARAMS.topN[market]));
  }
  const pooled = laneValidation(
    "POOLED",
    allObs,
    lanes.reduce((a, l) => a + l.runs, 0),
    lanes.reduce((a, l) => a + l.abstains, 0),
    lanes.reduce((a, l) => a + l.pendingLabel, 0),
    args.targetIc,
    ASSUMED_BREADTH * Math.max(1, args.markets.length),
  );
  return {
    asOf: new Date().toISOString(),
    horizon: PRIMARY_HORIZON,
    targetIc: args.targetIc,
    lanes,
    pooled,
    note:
      "`insufficient_evidence` is the expected output for months — it is not a failure, and it is not evidence of no edge. " +
      "The readiness rule refuses to decide until only a MEASURED se may authorise one, and the required horizon scales as 1/breadth: " +
      "widening the deep-dive is a token-cost decision, not a time decision (docs/phase-5-plan.md).",
  };
}

async function main(): Promise<void> {
  const args = parseValidateArgs(process.argv.slice(2));
  const prisma = new PrismaService();
  await prisma.$connect();
  let report: ValidationReport;
  try {
    report = await runValidation(prisma, args);
  } finally {
    await prisma.$disconnect();
  }
  console.log(args.json ? JSON.stringify(report, null, 2) : renderValidation(report));

  const dir = path.join(PKG_ROOT, "reports", "verdict");
  try {
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    writeFileSync(path.join(dir, `verdict-${stamp}.json`), JSON.stringify(report, null, 2));
  } catch {
    // never let artifact writing decide the verdict
  }
  // Exit 0 while undecidable, by design: this is a status readout, not a gate.
}

const invokedAsScript = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (invokedAsScript) {
  main().catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
  });
}
