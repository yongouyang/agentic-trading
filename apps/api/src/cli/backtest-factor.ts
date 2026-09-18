/**
 * `backtest:factor` — Phase 6A A5 runner (docs/phase-6a-plan.md).
 *
 * Panel + mask (A2) and signal panels (A3) → per-alpha rank IC, Newey–West t,
 * FDR, spread, by-year, label → `apps/api/reports/backtest/factor-<date>.{json,txt}`.
 *
 * **The deciding statistic is unchanged from Phase 4**: mean 20d rank IC with a
 * Newey–West t at lag = horizon, over the lane's eligible cross-section. 5d and
 * 60d are reported and may not override. The evaluation engine is literally the
 * same code the screen backtest runs (`ic.ts`), fed through the `ScoredDay`
 * adapter — that is the whole reason 6A needed no second engine.
 *
 * **This is a manual, in-session CLI.** No scheduled job, no production impact:
 * nothing here reads or writes `SCREEN_PARAMS`, the chain, the dashboard or the
 * deep-dive.
 *
 * Labels are labels. The picker window can only separate IC ≈ 0 from |IC| ≳ 0.03
 * (US) / 0.05 (HK), so `dead` on this window means *uninformative*, never
 * "no edge" — and HK can never exceed `insufficient_evidence` in this phase,
 * whatever the sweep prints, because the vendor archive that would confirm it is
 * US-only.
 *
 * Usage:
 *   pnpm -C apps/api backtest:factor [--market us|hk|all] [--alpha <ids>]
 *                                    [--universe u1|u2|both] [--panel <dir>]
 *                                    [--from <date>] [--to <date>] [--quiet]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  benjaminiHochberg,
  daysFromSignals,
  forwardFromPanel,
  icPower,
  icSeries,
  icStats,
  luckBenchmark,
  spreadSeriesProportional,
  summarizeSpread,
  neweyWestT,
  twoSidedP,
  type Market,
  type MaskMatrix,
  type NumberMatrix,
  type ScoredDay,
  type Universe,
} from "@agentic-trading/quant-core";
import { PANEL_ROOT } from "./panel-export.js";
import { assertAligned, loadPanel, readNumberCsv, type LoadedPanel } from "../backtest/panel-read.js";

const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

// ---------------------------------------------------------------------------
// pre-registered constants — every one of these is a decision, not a default
// ---------------------------------------------------------------------------

/** The statistic that DECIDES (phase-6a fork 6). Mean 20d rank IC, NW t lag = h. */
export const PRIMARY_HORIZON = 20;
/** Reported, may not override. */
export const REPORTED_HORIZONS = [5, 20, 60] as const;
/** BH FDR level (fork 3). */
export const FDR_Q = 0.05;
/**
 * Pre-registered per-lane detection floors — t = 2 at the lanes' own realized
 * NW SE from the Phase-4 screen backtest (`reports/backtest/2026-09-13.txt`):
 * US 2 × 0.01486, HK 2 × 0.02465. They are NOT recomputed here: the point of a
 * pre-registered floor is that it cannot move once the sweep has printed.
 */
export const POWER_FLOOR: Record<Market, number> = { US: 0.0297, HK: 0.0493 };
/** The same two SEs, quoted so the luck benchmark can be stated on both bases. */
export const LANE_NW_SE: Record<Market, number> = { US: 0.01486, HK: 0.02465 };
/** Promotion to A7 is capped (fork: "no post-hoc addition"). */
export const PROMOTION_K = 20;

export type Label = "alive" | "reversed" | "dead";

/**
 * The screening label, exactly as pre-registered:
 *
 *   alive     mean IC > 0 AND BH-FDR survivor AND |IC| ≥ the lane's power floor
 *   reversed  mean IC < 0 AND BH-FDR survivor AND |IC| ≥ the lane's power floor
 *   dead      otherwise — an UNINFORMATIVE label, not a claim of no edge
 *
 * The floor clause is what stops a statistically clean but tiny IC from being
 * called anything: below the floor the lane could not have detected the effect,
 * so its absence is not evidence.
 */
export function labelFor(meanIc: number, fdrReject: boolean, floor: number): Label {
  if (!fdrReject || Math.abs(meanIc) < floor) return "dead";
  return meanIc > 0 ? "alive" : "reversed";
}

export interface HorizonRow {
  horizon: number;
  meanIc: number;
  nwT: number;
  days: number;
  spreadMean: number;
  spreadPositiveShare: number;
  spreadPropMean: number;
  spreadPropNwT: number;
  meanCutoff: number;
}

export interface AlphaRow {
  id: string;
  universe: Universe;
  days: number;
  meanIc: number;
  icir: number;
  nwT: number;
  nwSe: number;
  sd: number;
  lag: number;
  meanBreadth: number;
  ciLo: number;
  ciHi: number;
  df: number;
  quantile: number;
  /** Normal-approximation two-sided p of the NW t — disclosed as an approximation. */
  p: number | null;
  fdrAdjusted: number | null;
  fdrReject: boolean;
  clearedFloor: boolean;
  label: Label;
  byYear: { year: string; meanIc: number; days: number }[];
  horizons: HorizonRow[];
  firstEvaluableSession: string | null;
  declaredMinWarmupBars: number | null;
}

export interface LaneReport {
  market: Market;
  panelDir: string;
  panelFingerprint: string | null;
  panelRange: { start: string; end: string; sessions: number } | undefined;
  replayWindow: { start: string; end: string; sessions: number } | undefined;
  /** The sessions actually evaluated: the mask's defined range, sliced by --from/--to. */
  window: { start: string; end: string; sessions: number };
  universe: Universe;
  breadth: { meanU1: number; meanU2: number };
  powerFloor: number;
  laneNwSe: number;
  luckBenchmarkAtLaneSe: number | null;
  luckBenchmarkAtSweepSe: number | null;
  luckBenchmarkSe: number | null;
  k: number;
  fdrQ: number;
  fdrDiscoveries: number;
  labels: Record<Label, number>;
  rows: AlphaRow[];
  skipped: { id: string; reason: string }[];
  /** US only, per the plan: HK has no confirmation stage. */
  promotion: { id: string; meanIc: number; label: Label }[];
  provenance: Record<string, unknown>;
}

export interface FactorReport {
  generatedAt: string;
  primaryHorizon: number;
  reportedHorizons: number[];
  fdrQ: number;
  promotionK: number;
  lanes: LaneReport[];
}

export interface FactorArgs {
  markets: Market[];
  alphas: string[] | null;
  universes: Universe[];
  panel: string | null;
  from: string | null;
  to: string | null;
  quiet: boolean;
}

export function parseFactorArgs(argv: string[]): FactorArgs {
  const out: FactorArgs = { markets: ["US", "HK"], alphas: null, universes: ["U1", "U2"], panel: null, from: null, to: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue; // pnpm passes a bare --
    if (arg === "--quiet") {
      out.quiet = true;
      continue;
    }
    if (arg === "--json") continue; // JSON is always written to the artifact
    if (arg === "--market") {
      const v = argv[++i];
      if (v === "all") out.markets = ["US", "HK"];
      else if (v === "us") out.markets = ["US"];
      else if (v === "hk") out.markets = ["HK"];
      else throw new Error(`--market must be us|hk|all, got "${v ?? ""}"`);
      continue;
    }
    if (arg === "--universe") {
      const v = (argv[++i] ?? "").toLowerCase();
      if (v === "both") out.universes = ["U1", "U2"];
      else if (v === "u1") out.universes = ["U1"];
      else if (v === "u2") out.universes = ["U2"];
      else throw new Error(`--universe must be u1|u2|both, got "${v}"`);
      continue;
    }
    if (arg === "--panel") {
      out.panel = argv[++i] ?? null;
      continue;
    }
    if (arg === "--alpha") {
      const v = argv[++i];
      if (!v) throw new Error("--alpha needs at least one id");
      out.alphas = v.split(",").map((s) => s.trim()).filter(Boolean);
      continue;
    }
    if (arg === "--from" || arg === "--to") {
      const v = argv[++i];
      if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`${arg} needs YYYY-MM-DD, got "${v ?? ""}"`);
      if (arg === "--from") out.from = v;
      else out.to = v;
      continue;
    }
    throw new Error(`unknown argument "${arg}"`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// statistics
// ---------------------------------------------------------------------------

/** Slice every matrix to the same session range, so the three stay aligned. */
function sliceRange(m: NumberMatrix | MaskMatrix, from: string | null, to: string | null): NumberMatrix | MaskMatrix {
  const keep: number[] = [];
  m.dates.forEach((d, i) => {
    if (from && d < from) return;
    if (to && d > to) return;
    keep.push(i);
  });
  return {
    dates: keep.map((i) => m.dates[i]!),
    symbols: m.symbols,
    values: keep.map((i) => m.values[i]!),
  } as NumberMatrix | MaskMatrix;
}

function yearBuckets(points: { date: string; ic: number }[]): { year: string; meanIc: number; days: number }[] {
  const byYear = new Map<string, number[]>();
  for (const p of points) {
    const year = p.date.slice(0, 4);
    const list = byYear.get(year) ?? [];
    list.push(p.ic);
    byYear.set(year, list);
  }
  return [...byYear.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([year, ics]) => ({ year, meanIc: ics.reduce((a, b) => a + b, 0) / ics.length, days: ics.length }));
}

export function alphaRow(
  id: string,
  universe: Universe,
  days: ScoredDay[],
  forward: ReturnType<typeof forwardFromPanel>,
  meta: { firstEvaluableSession: string | null; declaredMinWarmupBars: number | null },
): AlphaRow | null {
  const points = icSeries(days, forward, PRIMARY_HORIZON);
  const stats = icStats(points, PRIMARY_HORIZON);
  if (!stats) return null; // too few days, or a degenerate IC series
  const power = icPower(stats, PRIMARY_HORIZON);

  const horizons: HorizonRow[] = [];
  for (const h of REPORTED_HORIZONS) {
    const hPoints = h === PRIMARY_HORIZON ? points : icSeries(days, forward, h);
    const hStats = hPoints.length > 0 ? icStats(hPoints, h) : null;
    const cutoffs: number[] = [];
    const prop = spreadSeriesProportional(days, forward, h, cutoffs);
    const propStats = summarizeSpread(prop);
    const propNw = neweyWestT(prop, h);
    horizons.push({
      horizon: h,
      meanIc: hStats?.mean ?? Number.NaN,
      nwT: hStats?.nwT ?? Number.NaN,
      days: hStats?.days ?? 0,
      spreadMean: propStats.mean,
      spreadPositiveShare: propStats.positiveShare,
      spreadPropMean: propStats.mean,
      spreadPropNwT: propNw?.t ?? Number.NaN,
      meanCutoff: cutoffs.length ? cutoffs.reduce((a, b) => a + b, 0) / cutoffs.length : Number.NaN,
    });
  }

  const p = twoSidedP(stats.nwT);
  return {
    id,
    universe,
    days: stats.days,
    meanIc: stats.mean,
    icir: stats.icir,
    nwT: stats.nwT,
    nwSe: stats.nwSe,
    sd: stats.sd,
    lag: stats.lag,
    meanBreadth: stats.meanBreadth,
    ciLo: power.ciLo,
    ciHi: power.ciHi,
    df: power.df,
    quantile: power.quantile,
    p,
    fdrAdjusted: null,
    fdrReject: false,
    clearedFloor: false,
    label: "dead",
    byYear: yearBuckets(points),
    horizons,
    ...meta,
  };
}

/** Apply BH across the lane's alpha set and stamp the labels. Pure. */
export function applyFdr(rows: AlphaRow[], q: number, floor: number): { discoveries: number; k: number } {
  const bh = benjaminiHochberg(rows.map((r) => r.p), q);
  rows.forEach((r, i) => {
    r.fdrAdjusted = bh.adjusted[i] ?? null;
    r.fdrReject = bh.rejected[i] ?? false;
    r.clearedFloor = Math.abs(r.meanIc) >= floor;
    r.label = labelFor(r.meanIc, r.fdrReject, floor);
  });
  return { discoveries: bh.discoveries, k: bh.k };
}

// ---------------------------------------------------------------------------
// running a lane
// ---------------------------------------------------------------------------

export async function runLane(
  market: Market,
  panelDir: string,
  args: Pick<FactorArgs, "alphas" | "universes" | "from" | "to">,
  log: (m: string) => void = () => {},
): Promise<LaneReport> {
  const panel: LoadedPanel = loadPanel(PANEL_ROOT, market, panelDir);
  log(`  ${market}: panel ${path.basename(panel.dir)}`);

  const close = sliceRange(panel.close, args.from, args.to) as NumberMatrix;
  const mask = sliceRange(panel.mask, args.from, args.to) as MaskMatrix;
  if (close.dates.length < PRIMARY_HORIZON + 2) throw new Error(`${market}: ${close.dates.length} sessions in range — too few to evaluate`);
  const forward = forwardFromPanel(close);

  const bridgeAlphas = panel.bridge?.alphas ?? [];
  const available = bridgeAlphas.length ? bridgeAlphas.map((a) => a.id).sort() : [];
  if (available.length === 0) throw new Error(`${market}: no signals in ${panel.signalsDir} — run alpha-bridge.py first`);

  let selected = available;
  if (args.alphas) {
    const missing = args.alphas.filter((a) => !available.includes(a));
    if (missing.length) throw new Error(`${market}: no signals for ${missing.join(", ")} — available: ${available.length} alphas`);
    selected = args.alphas;
  }

  // Breadth is reported for both universes whatever the sweep runs on, because
  // U2's is the number that makes HK's thinness legible. The denominator is the
  // sessions the mask is DEFINED on — the replay window sliced by --from/--to —
  // not the panel's row count: outside the window every cell is null ("not
  // evaluated"), and dividing by those rows understates breadth by ~20 %
  // (438/day instead of the true 547.7 for US).
  let u1 = 0;
  let u2 = 0;
  let inWindow = 0;
  let windowStart: string | null = null;
  let windowEnd: string | null = null;
  mask.values.forEach((row, i) => {
    if (!row.some((c) => c != null)) return;
    inWindow++;
    windowStart ??= mask.dates[i]!;
    windowEnd = mask.dates[i]!;
    for (const code of row) {
      if (code != null && code >= 1) u1++;
      if (code === 2) u2++;
    }
  });
  if (inWindow === 0) throw new Error(`${market}: the mask is undefined on every session in range — is --from/--to inside the replay window?`);

  const rows: AlphaRow[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const bridgeSkipped = new Map((panel.bridge?.skipped ?? []).map((s) => [s.id, `${s.error}: ${s.reason}`]));
  for (const id of selected) {
    if (bridgeSkipped.has(id)) {
      skipped.push({ id, reason: bridgeSkipped.get(id)! });
      continue;
    }
    const signals = sliceRange(readNumberCsv(path.join(panel.signalsDir, `${id}.csv`)), args.from, args.to) as NumberMatrix;
    assertAligned(`${id}.csv`, signals, close);
    const meta = bridgeAlphas.find((a) => a.id === id);
    for (const universe of args.universes) {
      const days = daysFromSignals({ signals, mask, universe });
      const row = alphaRow(id, universe, days, forward, {
        firstEvaluableSession: meta?.firstNonNaNSession ?? null,
        declaredMinWarmupBars: meta?.declaredMinWarmupBars ?? null,
      });
      if (row) rows.push(row);
      else skipped.push({ id: `${id} (${universe})`, reason: "no computable IC series (breadth or variance too low)" });
    }
    log(`  ${market}: ${id} → ${rows.filter((r) => r.id === id).length} row(s)`);
  }

  // U1 is primary (fork 1); the FDR is applied within each universe separately,
  // because they are different families of tests over different cross-sections.
  const floor = POWER_FLOOR[market];
  let discoveries = 0;
  let k = 0;
  for (const universe of args.universes) {
    const subset = rows.filter((r) => r.universe === universe);
    const res = applyFdr(subset, FDR_Q, floor);
    discoveries += res.discoveries;
    k += res.k;
  }

  const ses = rows.map((r) => r.nwSe).filter((s) => Number.isFinite(s) && s > 0);
  const luckSe = ses.length ? ses.reduce((a, b) => a + b, 0) / ses.length : null;
  const labels: Record<Label, number> = { alive: 0, reversed: 0, dead: 0 };
  for (const r of rows) labels[r.label]++;

  const promotion = market === "US"
    ? rows
        .filter((r) => r.fdrReject && r.clearedFloor)
        .sort((a, b) => b.meanIc - a.meanIc)
        .slice(0, PROMOTION_K)
        .map((r) => ({ id: r.id, meanIc: r.meanIc, label: r.label }))
    : [];

  return {
    market,
    panelDir: panel.dir,
    panelFingerprint: panel.manifest.fingerprint ?? null,
    panelRange: panel.manifest.panelRange,
    replayWindow: panel.manifest.replayWindow,
    window: { start: windowStart!, end: windowEnd!, sessions: inWindow },
    universe: args.universes[0]!,
    breadth: { meanU1: u1 / inWindow, meanU2: u2 / inWindow },
    powerFloor: floor,
    laneNwSe: LANE_NW_SE[market],
    /** Both stated on purpose: the lane's pre-registered SE is the number behind
     *  the power floor, while the sweep's own mean SE is what the alphas
     *  actually delivered. They disagree here, and that disagreement is
     *  information rather than noise. */
    luckBenchmarkAtLaneSe: luckBenchmark(k, LANE_NW_SE[market]),
    luckBenchmarkAtSweepSe: luckSe == null ? null : luckBenchmark(k, luckSe),
    luckBenchmarkSe: luckSe,
    k,
    fdrQ: FDR_Q,
    fdrDiscoveries: discoveries,
    labels,
    rows,
    skipped,
    promotion,
    provenance: {
      bridgeVersion: panel.bridge?.bridgeVersion ?? null,
      zoo: panel.bridge?.zoo ?? null,
      runtime: panel.bridge?.runtime ?? null,
      adjustment: panel.manifest.adjustment ?? null,
      universalities: args.universes,
    },
  };
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

const num = (x: number, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "—");
const pct = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%` : "—");

function renderLane(l: LaneReport): string[] {
  const out: string[] = [];
  out.push(`--- ${l.market} ---`);
  out.push(`panel      ${path.basename(l.panelDir)}`);
  out.push(`window     ${l.window.start} … ${l.window.end} (${l.window.sessions} sessions)`);
  out.push(`breadth    U1 ${num(l.breadth.meanU1, 1)}/day · U2 ${num(l.breadth.meanU2, 1)}/day  (U1 is primary; U2 reported)`);
  out.push(
    `statistic  mean ${PRIMARY_HORIZON}d rank IC · NW t (lag ${PRIMARY_HORIZON}) · ${l.rows.length ? l.rows[0]!.days : 0} days on the first row · alphas ${l.rows.length} evaluated, ${l.skipped.length} skipped`,
  );
  out.push(`floors     power floor ${num(l.powerFloor)} (t=2 at the lane's realized NW SE ${num(l.laneNwSe, 5)}) · FDR q=${l.fdrQ} over K=${l.k}`);
  out.push(
    `luck       E[max|IC|] ≈ ${num(l.luckBenchmarkAtLaneSe ?? Number.NaN)} at the lane SE ${num(l.laneNwSe, 5)} · ${num(l.luckBenchmarkAtSweepSe ?? Number.NaN)} at the sweep's own mean SE ${num(l.luckBenchmarkSe ?? Number.NaN, 5)} — K assumed independent, so this is CONSERVATIVE`,
  );
  out.push(`labels     alive ${l.labels.alive} · reversed ${l.labels.reversed} · dead ${l.labels.dead}   (FDR discoveries ${l.fdrDiscoveries})`);
  out.push("");
  out.push(`  ${"alpha".padEnd(26)} ${"univ".padEnd(4)} ${"meanIC".padStart(8)} ${"NWt".padStart(7)} ${"ICIR".padStart(7)} ${"days".padStart(5)} ${"brdth".padStart(6)} ${"p".padStart(9)} ${"FDR".padStart(9)} ${"label".padEnd(9)}`);
  for (const r of [...l.rows].sort((a, b) => b.meanIc - a.meanIc)) {
    out.push(
      `  ${r.id.padEnd(26)} ${r.universe.padEnd(4)} ${num(r.meanIc).padStart(8)} ${num(r.nwT, 2).padStart(7)} ${num(r.icir, 2).padStart(7)}` +
        ` ${String(r.days).padStart(5)} ${num(r.meanBreadth, 1).padStart(6)} ${(r.p == null ? "—" : r.p.toExponential(1)).padStart(9)} ${num(r.fdrAdjusted ?? Number.NaN, 4).padStart(9)} ${r.label.padEnd(9)}`,
    );
  }
  if (l.skipped.length) {
    out.push("");
    out.push(`  skipped:`);
    for (const s of l.skipped) out.push(`    ${s.id}: ${s.reason}`);
  }
  const survivors = l.rows.filter((r) => r.label !== "dead");
  if (survivors.length) {
    out.push("");
    out.push(`  survivors, by year (20d IC):`);
    for (const r of survivors) {
      out.push(`    ${r.id}  ${r.byYear.map((y) => `${y.year} ${num(y.meanIc)} (${y.days}d)`).join(" · ")}`);
    }
    out.push(`  horizons for survivors (5 / 20 / 60):`);
    for (const r of survivors) {
      out.push(
        `    ${r.id}  ` +
          r.horizons.map((h) => `${h.horizon}d IC ${num(h.meanIc)} t ${num(h.nwT, 2)}`).join(" · "),
      );
      out.push(
        `    ${" ".repeat(r.id.length)}  prop spread ` + r.horizons.map((h) => `${h.horizon}d ${pct(h.spreadPropMean)} t ${num(h.spreadPropNwT, 2)}`).join(" · "),
      );
    }
  }
  out.push("");
  if (l.market === "US") {
    out.push(`  PROMOTION to A7 (top ${PROMOTION_K} by mean IC among FDR survivors clearing the floor) — this spends the design half:`);
    if (l.promotion.length === 0) out.push(`    none — no alpha survived FDR at the power floor`);
    for (const p of l.promotion) out.push(`    ${p.id.padEnd(26)} mean IC ${num(p.meanIc)}  ${p.label}`);
  } else {
    out.push(`  PROMOTION: none — the vendor archive is US-only, so HK can never exceed insufficient_evidence in this phase.`);
  }
  return out;
}

export function renderFactor(report: FactorReport, log?: string[]): string {
  const out: string[] = [];
  out.push("== PHASE 6A — FACTOR SWEEP (borrowed alpha library, our statistics) ==");
  out.push(`statistic mean ${report.primaryHorizon}d rank IC with Newey-West t (lag = horizon) — Phase 4's Gate-1 statistic, unchanged`);
  out.push(`reported  ${report.reportedHorizons.join("d / ")}d — 5d and 60d may not override the 20d decision`);
  out.push(`FDR       Benjamini-Hochberg q=${report.fdrQ}, normal-approximation p from the NW t (disclosed)`);
  out.push(`promotion top ${report.promotionK} US alphas by mean IC, pre-registered, no post-hoc addition`);
  out.push("");
  for (const l of report.lanes) {
    out.push(...renderLane(l));
    out.push("");
  }
  out.push("Pre-registered limitations:");
  out.push("  · The picker window can only separate IC ≈ 0 from |IC| ≳ 0.03 (US) / 0.05 (HK), so `dead` means UNINFORMATIVE, not 'no edge'.");
  out.push("  · HK has no confirmation stage: the vendor archive is US-only, so HK cannot exceed insufficient_evidence here.");
  out.push("  · The FDR/luck numbers assume K independent trials; real alphas are correlated, so E[max|IC|] is conservative (harder to pass).");
  out.push("  · p-values are a normal approximation to a HAC t-statistic, mildly anti-conservative in the far tail.");
  out.push("  · Survivorship, one regime, delisting tails absent from IC — unchanged from Phase 4.");
  out.push("  · This is a SCREEN. A label is a shortlist entry, not a verdict; the verdict is A7 on the vendor test half.");
  if (log) out.push(...log);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseFactorArgs(process.argv.slice(2));
  const log = args.quiet ? () => {} : (m: string) => console.error(m);

  const lanes: LaneReport[] = [];
  for (const market of args.markets) lanes.push(await runLane(market, args.panel ?? "", args, log));

  const report: FactorReport = {
    generatedAt: new Date().toISOString(),
    primaryHorizon: PRIMARY_HORIZON,
    reportedHorizons: [...REPORTED_HORIZONS],
    fdrQ: FDR_Q,
    promotionK: PROMOTION_K,
    lanes,
  };
  const text = renderFactor(report);
  console.log(text);

  const dir = path.join(PKG_ROOT, "reports", "backtest");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  writeFileSync(path.join(dir, `factor-${stamp}.json`), JSON.stringify(report, null, 2));
  writeFileSync(path.join(dir, `factor-${stamp}.txt`), `${text}\n`);
  log(`artifacts → apps/api/reports/backtest/factor-${stamp}.{json,txt}`);
}

/** Read a report back — used by the tests and by A7 to consume the promotion list. */
export function readFactorReport(file: string): FactorReport {
  return JSON.parse(readFileSync(file, "utf8")) as FactorReport;
}

const invokedAsScript = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (invokedAsScript) {
  main().catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
  });
}
