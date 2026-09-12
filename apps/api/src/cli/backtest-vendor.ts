/**
 * `backtest:vendor` — Phase 4c Track A runner (docs/phase-4c-plan.md).
 *
 * The picker backtest's twin over the Databento vendor archive: locked
 * survivor universe (vendor-loader.ts) → point-in-time replay of the SHIPPED
 * screen (replayScreen / runBacktest, SCREEN_PARAMS untouched, topN truncation
 * lifted exactly as the picker backtest does inside replayScreen) → IC stats +
 * Gate-2-style portfolio vs equal-weight eligible benchmark + exclusion
 * census → JSON + human report under `apps/api/reports/backtest/`.
 *
 * FIREWALL. The vendor window is split chronologically: earlier half =
 * DESIGN (breadth / NW-SE measurement → the bar, locked next session), later
 * half = TEST (spent exactly once, after the bar is locked). The default
 * window is the design half. Any window overlapping the test half requires
 * `--spend-test-half`, and prints a warning — the test half may only be spent
 * after the bar is locked numerically in docs/phase-4c-plan.md.
 *
 * The deciding statistic (mean 20d rank IC, NW t, lag = horizon) and Gate 2
 * (falsification-only, with the dividend upward-bias disclosure) are computed
 * by the same runBacktest machinery as the picker lane; this CLI adds the
 * universe, the window gating, and the loader manifest (audit trail).
 *
 * Usage:
 *   pnpm -C apps/api backtest:vendor [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *                                    [--spend-test-half] [--quiet]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runBacktest, type LaneResult } from "@agentic-trading/quant-core";
import { PrismaService } from "../prisma.service.js";
import { loadVendorLane, type VendorLoaderManifest } from "./vendor-loader.js";

const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

export interface VendorBacktestArgs {
  from: string | null;
  to: string | null;
  spendTestHalf: boolean;
  quiet: boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseVendorBacktestArgs(argv: string[]): VendorBacktestArgs {
  let from: string | null = null;
  let to: string | null = null;
  let spendTestHalf = false;
  let quiet = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--" || arg === "--json") continue;
    if (arg === "--quiet") {
      quiet = true;
      continue;
    }
    if (arg === "--spend-test-half") {
      spendTestHalf = true;
      continue;
    }
    if (arg === "--from" || arg === "--to") {
      const v = argv[++i];
      if (!v || !DATE_RE.test(v)) throw new Error(`${arg} expects YYYY-MM-DD, got "${v ?? ""}"`);
      if (arg === "--from") from = v;
      else to = v;
      continue;
    }
    throw new Error(`unknown argument "${arg}" (expected --from, --to, --spend-test-half, --quiet)`);
  }
  return { from, to, spendTestHalf, quiet };
}

/** The chronological design/test split: the test half starts at the midpoint
 *  session of the vendor replay calendar. Pure — unit-tested. */
export function testHalfStart(calendar: string[]): string | null {
  if (calendar.length < 2) return null;
  return calendar[Math.ceil(calendar.length / 2)]!;
}

/** Window gating (the firewall). Returns the effective [from, to]; refuses
 *  any window reaching into the test half unless explicitly authorised. */
export function resolveWindow(
  calendar: string[],
  args: Pick<VendorBacktestArgs, "from" | "to" | "spendTestHalf">,
): { from: string; to: string; testStart: string } {
  const testStart = testHalfStart(calendar);
  if (!testStart) throw new Error("vendor calendar too short to split into design/test halves");
  const from = args.from ?? calendar[0]!;
  const to = args.to ?? (args.spendTestHalf
    ? calendar[calendar.length - 1]!
    : calendar[calendar.indexOf(testStart) - 1]!);
  if ((to >= testStart || from >= testStart) && !args.spendTestHalf) {
    throw new Error(
      `FIREWALL: window end ${to} reaches the test half (starts ${testStart}). ` +
        "The test half may only be spent once, after the bar is locked in docs/phase-4c-plan.md. " +
        "Re-run with --spend-test-half to override.",
    );
  }
  if (from > to) throw new Error(`--from ${from} is after --to ${to}`);
  return { from, to, testStart };
}

export const TEST_HALF_WARNING =
  "⚠️  TEST-HALF SPEND: this run reads the vendor TEST half. That is legal exactly once, " +
  "after the bar is locked numerically in docs/phase-4c-plan.md. If the bar is not locked, " +
  "stop now — any number printed here spends the lane.";

// ---------------------------------------------------------------------------
// rendering — compact; the full per-lane field set lives in the JSON artifact
// ---------------------------------------------------------------------------

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
const num = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "—");

export function renderVendorBacktest(
  lane: LaneResult | null,
  window: { from: string; to: string; sessions: number; testStart: string; half: "design" | "test" | "mixed" },
  manifest: VendorLoaderManifest,
): string {
  const L: string[] = [];
  L.push("== PHASE 4c TRACK A — VENDOR SCREEN REPLAY ==");
  L.push(
    `window ${window.from} … ${window.to} (${window.sessions} sessions, ${window.half} half; test half starts ${window.testStart}) · SCREEN_PARAMS as shipped`,
  );
  L.push("hypothesis: H1-GENERALITY — fresh names, spent regime; this is never 'validated on fresh data'.");
  L.push("");
  L.push("LOADER MANIFEST (audit trail):");
  L.push(
    `  universe: ${manifest.survivorSymbols} symbols / ${manifest.survivorSeries} survivor series → ${manifest.seriesLoaded} series loaded (${manifest.barsLoaded} bars)`,
  );
  L.push(`  quarantined (gap > 14d, vendor+symbol): ${manifest.quarantinedExcluded}`);
  L.push(
    `  dual-feed symbols: ${manifest.dualFeedSymbols} — one feed by bar count (xnas ${manifest.feedChoices["databento-xnas"]} · xnys ${manifest.feedChoices["databento-xnys"]} total incl. single-feed)`,
  );
  L.push(
    `  splits: ${manifest.splitEventsApplied} events across ${manifest.splitSymbols} symbols (registry + detector rows: ${manifest.extraSplitsApplied.join("; ")})`,
  );
  L.push(
    `  dividends: ${manifest.dividendCoveredSymbols} symbols covered (${manifest.dividendEvents} Yahoo events, nominal at ex-date, scaled onto the split basis); ${manifest.dividendResidualSymbols} residual symbols on price returns (disclosed upward bias, ≤ ~0.1%/yr)`,
  );
  L.push(`  ${manifest.caDegraded}`);
  L.push("");
  if (!lane) {
    L.push("no lane result (too few sessions).");
    return L.join("\n");
  }
  const g1 = lane.gate1;
  L.push(
    `IC (deciding statistic next session; the bar is NOT yet locked — these are design-half measurements only):`,
  );
  L.push(
    `  mean 20d rank IC ${num(g1.meanIc, 4)} · ICIR ${num(g1.icir)} · NW t ${num(g1.nwT, 2)} (lag ${g1.primaryHorizon}) · ${g1.days} days · breadth ${num(g1.meanBreadth, 0)}`,
  );
  L.push(`  SE: naive ${num(g1.naiveSe, 5)} · heuristic ${num(g1.heuristicSe, 5)} · realized NW ${num(g1.nwSe, 5)} (df ${num(g1.degreesOfFreedom, 1)})`);
  for (const h of g1.horizons) {
    L.push(`  ${String(h.horizon).padStart(2)}d: IC ${num(h.meanIc, 4)} · t ${num(h.nwT, 2)} · spread ${pct(h.spreadMean)}`);
  }
  if (g1.byYear.length) {
    L.push(`  by year: ${g1.byYear.map((y) => `${y.year} ${num(y.meanIc, 4)} (${y.days}d)`).join(" · ")}`);
  }
  const gb = lane.gate2Base;
  L.push(
    `GATE 2 (falsification-only; carries the dividend upward-bias disclosure): portfolio ${pct(gb.portfolio.totalReturn)} vs equal-weight eligible ${pct(gb.benchmarkReturn)} → differential ${pct(gb.differential)} · NW t ${num(gb.nwT, 2)} (lag 20)`,
  );
  if (lane.yearly.length) {
    L.push(`  yearly differential: ${lane.yearly.map((y) => `${y.year} ${pct(y.differential)}`).join(" · ")}`);
  }
  const X = lane.exclusions;
  L.push(
    `  exclusion census (descriptive): ${num(X.total, 0)} first-failures vs ${num(X.eligible, 0)} eligible → ${num((X.total / Math.max(1, X.total + X.eligible)) * 100, 1)}% rejected`,
  );
  for (const [reason, n] of Object.entries(X.byReason).sort((a, b) => b[1] - a[1])) {
    L.push(`    ${reason.padEnd(22)} ${num(n, 0).padStart(7)}  (${num(n / Math.max(1, X.days), 0)}/day)`);
  }
  L.push("");
  L.push("Pre-registered caveats:");
  L.push("  · Gate 2 passes are never confirmations; the differential is biased UPWARD by the dividend residual (≤ ~0.1%/yr).");
  L.push("  · adv20 is venue-distorted (no consolidated tape); delisting returns are undefined (a series just stops).");
  L.push("  · Split/ticker-identity risk: quarantined + P2/P3-classified (residual ≈ 0); see the manifest.");
  return L.join("\n");
}

// ---------------------------------------------------------------------------

export interface VendorBacktestReport {
  generatedAt: string;
  window: { from: string; to: string; sessions: number; testStart: string; half: string };
  manifest: VendorLoaderManifest;
  lane: LaneResult | null;
  indexReturn: number | null;
}

export async function runVendorBacktestCli(
  prisma: PrismaService,
  args: VendorBacktestArgs,
  log: (m: string) => void = () => {},
): Promise<VendorBacktestReport> {
  const lane = await loadVendorLane(prisma, { log });
  const { from, to, testStart } = resolveWindow(lane.dates, args);
  if (to >= testStart) log(TEST_HALF_WARNING);
  const windowDates = lane.dates.filter((d) => d >= from && d <= to);
  log(`  replay window ${from} … ${to} (${windowDates.length} sessions)`);

  const out = runBacktest({
    symbolSeries: lane.series,
    dates: windowDates,
    markets: ["US"],
    indexSymbol: { US: "SPY" },
  });
  const evaluated = out.lanes.find((l) => l.market === "US") ?? null;
  const half = to < testStart ? "design" : from >= testStart ? "test" : "mixed";
  return {
    generatedAt: new Date().toISOString(),
    window: { from, to, sessions: windowDates.length, testStart, half },
    manifest: lane.manifest,
    lane: evaluated,
    indexReturn: out.indexReturns.US ?? null,
  };
}

async function main(): Promise<void> {
  const args = parseVendorBacktestArgs(process.argv.slice(2));
  const log = args.quiet ? () => {} : (m: string) => console.error(m);

  const prisma = new PrismaService();
  await prisma.$connect();
  let report: VendorBacktestReport;
  try {
    log("loading vendor store (read-only)…");
    report = await runVendorBacktestCli(prisma, args, log);
  } finally {
    await prisma.$disconnect();
  }

  const text = renderVendorBacktest(report.lane, { ...report.window, half: report.window.half as "design" | "test" | "mixed" }, report.manifest);
  console.log(text);

  const dir = path.join(PKG_ROOT, "reports", "backtest");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  writeFileSync(path.join(dir, `vendor-${stamp}.json`), JSON.stringify(report, null, 2));
  writeFileSync(path.join(dir, `vendor-${stamp}.txt`), `${text}\n`);
  log(`artifacts → apps/api/reports/backtest/vendor-${stamp}.{json,txt}`);
}

const invokedAsScript = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (invokedAsScript) {
  main().catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
  });
}
