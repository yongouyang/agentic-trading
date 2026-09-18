/**
 * Phase 6A A2 — panel export (docs/phase-6a-plan.md).
 *
 * Store (read-only) → wide `date × symbol` panels the Python alpha bridge can
 * read with pandas, plus the two universes the phase is built on, plus a
 * manifest that makes every choice inspectable.
 *
 *   Universal / U1  PIT ≥ 252 bars at T AND adv20(T) ≥ SCREEN_PARAMS.advFloor.
 *                   No trend, volatility or drawdown gate.
 *   Screen-eligible / U2  the shipped gate set — ReplayDay.ranked.
 *
 * **U1 is DERIVED from the same `runScreen(allFailures)` output that already
 * produced the Phase-4 censuses**, via the replay's `excludedReasons` opt-in: a
 * name is U1-eligible iff its failure set contains neither
 * `INSUFFICIENT_HISTORY` nor `LOW_LIQUIDITY`. Nothing here recomputes an
 * indicator, so there is no second implementation to drift from the screen.
 * `U2 ⊆ U1` holds by construction (a name that passed every gate failed
 * neither), which is why one three-valued mask can carry both.
 *
 * ## What this file does NOT guarantee — the dividend anchor
 *
 * The panel is dividend-adjusted by `deriveAdjustedBars`, which is a
 * MULTIPLICATIVE BACK-adjustment anchored at the latest bar of the series it is
 * given (R1). Handing it the full history therefore makes the value at date T
 * depend on dividends that ex-date AFTER T — in the project's own vocabulary,
 * look-ahead in the X variable.
 *
 * The project already relies on this convention elsewhere and it is safe there
 * for a stated reason: a forward RETURN is a ratio of two adjusted values, so
 * every factor outside the interval cancels (`replay.ts` header note 3). A
 * factor VALUE has no such cancellation. What survives is worth stating exactly,
 * because it bounds the damage:
 *
 *   adj(T) = raw(T) × Π{div ex-date > T} (1 − D/P_prev)
 *
 * so for a FIXED T the distortion is a per-symbol CONSTANT, and every
 * date-to-date ratio within one symbol is unaffected (any alpha built from
 * `ts_mean`, `ts_std`, `ts_corr`, `ts_rank` or a difference of log prices is
 * therefore exactly PIT-safe). What is not safe is a CROSS-SECTIONAL comparison
 * at fixed T across symbols whose future dividend streams differ — which
 * includes every `rank`/`zscore` alpha. The size of that distortion is measured
 * per lane and written into the manifest (`futureDividendFactor`), so it is a
 * number on the record rather than a defence in prose.
 *
 * The alternative — raw, unadjusted prices — removes the leakage by removing the
 * dividend return too, which is the larger error. A PIT-correct adjusted panel
 * is not expressible as a single matrix. The phase plan locked
 * `deriveAdjustedBars`, so this follows it and discloses; re-opening the fork is
 * the user's call, and the manifest carries what that decision would need.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  REPLAY_TRUNCATION_BARS,
  deriveAdjustedBars,
  replayScreen,
  type Bar,
  type Market,
  type ReplayDay,
  type SymbolSeries,
} from "@agentic-trading/quant-core";
import { PrismaService } from "../prisma.service.js";
import { hktDate, loadLane, type LoadedLane } from "../cli/backtest-screen.js";

/** The mask's alphabet. `U2 ⊆ U1` by construction, so one column carries both. */
export const ELIGIBLE_LEGEND: Record<string, string> = {
  "0": "evaluated and NOT U1: failed INSUFFICIENT_HISTORY or LOW_LIQUIDITY, or invisible at T (no bar)",
  "1": "U1 only: passed the availability + liquidity gates, failed a risk or signal gate",
  "2": "U1 and screen-eligible (U2): passed every gate",
  "": "outside the replay window — the screen was not run for this session",
};

export const PANEL_FIELDS = ["close", "open", "high", "low", "volume"] as const;
export type PanelField = (typeof PANEL_FIELDS)[number];

export interface PanelRange {
  start: string;
  end: string;
  sessions: number;
}

export interface PanelManifest {
  /** First export of this fingerprint; preserved verbatim across re-exports so
   *  a re-run is byte-identical and can be asserted to be a no-op. */
  generatedAt: string;
  market: Market;
  fingerprint: string;
  /** Every session the panel has a row for, across all symbols. */
  panelRange: PanelRange;
  /** The replay window a sweep runs on (loadLane): where the mask is defined. */
  replayWindow: PanelRange;
  /** Sessions that exist only as alpha warmup — before `replayWindow.start`. */
  warmupSessions: number;
  symbols: number;
  bars: number;
  adjustment: {
    method: "deriveAdjustedBars";
    anchor: "latest_bar_of_series";
    /** False, and this is the honest value: see the module header. */
    pointInTime: false;
    /** |Π{div ex-date > replayWindow.start}(1 − D/P_prev)| across the names
     *  priced on the window's first session. The LEVEL mostly reflects each
     *  name's dividend yield; the P10–P90 SPREAD is the part that survives into
     *  a cross-sectional rank, which is why both are reported. */
    futureDividendFactor: { symbols: number; median: number; p10: number; p90: number; max: number };
    volume: "as_stored (provider split-consistent; never locally adjusted)";
  };
  warmup: { replayTruncationBars: number };
  eligibleLegend: Record<string, string>;
  counts: { u1Observations: number; u2Observations: number; u1PerSession: number; u2PerSession: number };
  reconciliation: MaskReconciliation | null;
  columns: { date: string; fields: PanelField[]; eligible: string };
  limits: string[];
}

/** U2 (and the U1 relationship) checked against a stored production run — A2's
 *  exit criterion.
 *
 *  **The exact check is `storedEligible === maskU2`**, where production's
 *  eligible count is recovered from its own persisted first-failure census:
 *
 *      storedEligible = ok − Σ(census)
 *
 *  `ok` is the number of names production FED to the screen (not the number that
 *  passed — an early reading of this file compared `ok` to U2 and reported a
 *  false MISMATCH on both lanes). `status` also requires every stored ranked
 *  name to be marked U2.
 *
 *  **U1 is deliberately NOT asserted equal.** U1 is a liquidity universe
 *  (history + `adv20`), not an index-membership one, so it is computed over
 *  every stored instrument with bars — a SUPERSET of production's universe (the
 *  two coincide for US; for HK the panel carries 4 names the store kept after
 *  Phase-5 A5 removed them from the index). The counts are reported side by
 *  side with the symbol-axis delta so a reader can see the gap and its cause
 *  rather than have it hidden by an equality that would fail for the wrong
 *  reason. */
export interface MaskReconciliation {
  screenRunId: number;
  date: string;
  status: "match" | "mismatch" | "no-stored-run" | "outside-window";
  /** Names production fed to the screen. */
  storedInputs: number;
  /** `ok − Σ(first-failure census)` — production's screen-eligible count. */
  storedEligible: number;
  maskU2: number;
  /** Informational; see the note above on why this is not an equality. */
  maskU1: number;
  storedU1Floor: number;
  /** Instruments in the panel that the stored run did not screen. */
  extraSymbols: number;
  storedResultSymbols: number;
  missingFromMaskU2: string[];
  differences: string[];
}

export interface PanelExportResult {
  market: Market;
  fingerprint: string;
  dir: string;
  manifest: PanelManifest;
  /** Files whose bytes actually changed. Empty ⇒ the re-export was a no-op. */
  written: string[];
}

// ---------------------------------------------------------------------------
// pure builders
// ---------------------------------------------------------------------------

/** Fixed-decimal, trailing-zero-trimmed, empty for null. The exact formatter is
 *  a contract: A3 asserts a bridge re-run is byte-identical, and it reads these
 *  files, so the bytes must not depend on platform float printing. */
export function cellNum(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return "";
  return String(Number(x.toFixed(6)));
}

/** One CSV: header `date,<symbols…>`, one row per session, cells from `value`. */
export function wideCsv(symbols: string[], dates: string[], value: (date: string, symbol: string) => string): string {
  const out: string[] = [`date,${symbols.join(",")}`];
  for (const d of dates) {
    const cells = new Array<string>(symbols.length);
    for (let s = 0; s < symbols.length; s++) cells[s] = value(d, symbols[s]!);
    out.push(`${d},${cells.join(",")}`);
  }
  return `${out.join("\n")}\n`;
}

/** Deterministic directory key: lane + window + symbol/bar counts (+ a digest of
 *  the symbol LIST, so swapping one name for another is a different panel). */
export function fingerprintOf(panel: PanelRange, symbols: string[], bars: number): string {
  const digest = createHash("sha256").update(symbols.join("\n")).digest("hex").slice(0, 12);
  return `${panel.start}_${panel.end}-${panel.sessions}s-${symbols.length}n-${bars}b-${digest}`;
}

/** Session dates present in a lane's series, ascending. Unlike `loadLane().dates`
 *  this is NOT filtered to the replay window: those earlier sessions are the
 *  alphas' warmup. */
export function panelDates(series: SymbolSeries[]): string[] {
  const all = new Set<string>();
  for (const s of series) for (const b of s.bars) all.add(b.date);
  return [...all].sort();
}

/** The two universes for one replay day, as a symbol → code map. Names absent
 *  from the map are invisible at T and read as 0. */
export function maskForDay(day: ReplayDay): Map<string, 0 | 1 | 2> {
  const mask = new Map<string, 0 | 1 | 2>();
  for (const p of day.ranked) mask.set(p.symbol, 2);
  for (const [symbol, fails] of Object.entries(day.excludedReasons ?? {})) {
    const u1 = !fails.includes("INSUFFICIENT_HISTORY") && !fails.includes("LOW_LIQUIDITY");
    mask.set(symbol, u1 ? 1 : 0);
  }
  return mask;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]!;
}

/** `adj(first) / raw(first)` = Π{div ex-date > first}(1 − D/P_prev): how far the
 *  full-history anchor moves a value at the panel's first session. */
export function futureDividendFactors(series: SymbolSeries[], firstDate: string): number[] {
  const out: number[] = [];
  for (const s of series) {
    const raw = s.bars.find((b) => b.date === firstDate);
    if (!raw || raw.close == null || raw.close === 0) continue;
    const adj = deriveAdjustedBars(s.bars, s.dividends).find((b) => b.date === firstDate);
    if (!adj) continue;
    out.push(adj.adjustedClose / raw.close);
  }
  return out;
}

// ---------------------------------------------------------------------------
// assembling a lane
// ---------------------------------------------------------------------------

export interface LanePanel {
  market: Market;
  symbols: string[];
  dates: string[];
  /** symbol → date → adjusted OHLC bar. */
  bars: Map<string, Map<string, Bar>>;
  /** volume as stored, from the raw series (a null-close bar still has volume). */
  volume: Map<string, Map<string, number | null>>;
  /** date → symbol → U1/U2 code, for replay-window sessions only. */
  mask: Map<string, Map<string, 0 | 1 | 2>>;
  replayDays: ReplayDay[];
  barCount: number;
}

/** Pure given a loaded lane: adjust once, replay once, derive both universes. */
export function buildLanePanel(lane: LoadedLane): LanePanel {
  const symbols = lane.series.map((s) => s.symbol);
  const bars = new Map<string, Map<string, Bar>>();
  const volume = new Map<string, Map<string, number | null>>();
  let barCount = 0;
  for (const s of lane.series) {
    barCount += s.bars.length;
    const byDate = new Map<string, Bar>();
    for (const b of deriveAdjustedBars(s.bars, s.dividends)) byDate.set(b.date, b);
    bars.set(s.symbol, byDate);
    const vol = new Map<string, number | null>();
    for (const b of s.bars) vol.set(b.date, b.volume);
    volume.set(s.symbol, vol);
  }

  // The SAME call the Phase-4 runner makes — same truncation, same lift of the
  // top-N cap — plus the opt-in that keeps each name's failure set.
  const replayDays = replayScreen(lane.dates, lane.series, REPLAY_TRUNCATION_BARS, { excludedReasons: true });
  const mask = new Map<string, Map<string, 0 | 1 | 2>>();
  for (const day of replayDays) mask.set(day.date, maskForDay(day));

  return { market: lane.market, symbols, dates: panelDates(lane.series), bars, volume, mask, replayDays, barCount };
}

function writeIfChanged(file: string, content: string, written: string[]): void {
  try {
    if (readFileSync(file, "utf8") === content) return;
  } catch {
    // absent → fall through to write
  }
  writeFileSync(file, content);
  written.push(path.basename(file));
}

// ---------------------------------------------------------------------------
// reconciliation against a stored production run
// ---------------------------------------------------------------------------

export function reconcileMask(day: ReplayDay | undefined, stored: {
  id: number;
  date: string;
  ok: number;
  universeSize: number;
  excluded: Record<string, number>;
  resultSymbols: string[];
  panelSymbols: number;
}): MaskReconciliation {
  const censusTotal = Object.values(stored.excluded).reduce((a, b) => a + b, 0);
  const base = {
    screenRunId: stored.id,
    date: stored.date,
    storedInputs: stored.ok,
    storedEligible: stored.ok - censusTotal,
    storedResultSymbols: stored.resultSymbols.length,
    storedU1Floor: stored.universeSize - ((stored.excluded.INSUFFICIENT_HISTORY ?? 0) + (stored.excluded.LOW_LIQUIDITY ?? 0)),
    extraSymbols: stored.panelSymbols - stored.universeSize,
  };
  if (!day) {
    return { ...base, status: "outside-window", maskU2: 0, maskU1: 0, missingFromMaskU2: [], differences: [`session ${stored.date} is outside the replay window`] };
  }
  const mask = maskForDay(day);
  let maskU1 = 0;
  let maskU2 = 0;
  for (const code of mask.values()) {
    if (code >= 1) maskU1++;
    if (code === 2) maskU2++;
  }
  const missingFromMaskU2 = stored.resultSymbols.filter((s) => mask.get(s) !== 2);
  const differences: string[] = [];
  if (maskU2 !== base.storedEligible) differences.push(`screen-eligible: stored ${base.storedEligible} (ok ${stored.ok} − census ${censusTotal}) vs mask U2 ${maskU2}`);
  if (missingFromMaskU2.length) differences.push(`${missingFromMaskU2.length} stored ranked name(s) not marked U2: ${missingFromMaskU2.slice(0, 8).join(", ")}`);
  return { ...base, status: differences.length === 0 ? "match" : "mismatch", maskU2, maskU1, missingFromMaskU2, differences };
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

/** Narrow helper so the reconciliation rule stays identical to
 *  `auditAgainstProduction`: newest run with a census, preferring a chain row
 *  (a `rescreen` row's census is the replay's own output, so it proves nothing). */
async function storedRunFor(prisma: PrismaService, market: Market) {
  const runs = await prisma.screenRun.findMany({ where: { market }, orderBy: { runAt: "desc" }, take: 25 });
  const withCensus = runs.filter((r) => r.excludedJson && r.excludedJson !== "{}");
  const candidate = withCensus.find((r) => r.source !== "rescreen") ?? withCensus[0];
  return candidate ?? null;
}

export async function exportPanel(
  prisma: PrismaService,
  market: Market,
  opts: { root: string; log?: (m: string) => void },
): Promise<PanelExportResult> {
  const log = opts.log ?? (() => {});
  const lane = await loadLane(prisma, market, log);
  if (lane.dates.length < 2) throw new Error(`${market}: too few replay sessions (${lane.dates.length})`);
  const panel = buildLanePanel(lane);

  const replayWindow: PanelRange = {
    start: lane.dates[0]!,
    end: lane.dates[lane.dates.length - 1]!,
    sessions: lane.dates.length,
  };
  const panelRange: PanelRange = {
    start: panel.dates[0]!,
    end: panel.dates[panel.dates.length - 1]!,
    sessions: panel.dates.length,
  };
  const fingerprint = fingerprintOf(panelRange, panel.symbols, panel.barCount);
  const dir = path.join(opts.root, `${market.toLowerCase()}-${fingerprint}`);

  // counts + the anchor-drift measurement
  let u1 = 0;
  let u2 = 0;
  for (const oneDay of panel.mask.values()) {
    for (const code of oneDay.values()) {
      if (code >= 1) u1++;
      if (code === 2) u2++;
    }
  }
  // Measured at the REPLAY WINDOW start, not the panel's first session: the
  // panel's first session is usually priced by a handful of names, which would
  // measure nothing. This is the cross-sectional spread of the anchor drift on
  // the session a sweep's first factor value is computed at.
  const dilutions = futureDividendFactors(lane.series, replayWindow.start).sort((a, b) => a - b);
  const stored = await storedRunFor(prisma, market);
  let reconciliation: MaskReconciliation | null = null;
  if (stored) {
    const date = stored.sessionDate || hktDate(stored.runAt);
    const results = await prisma.screenResult.findMany({ where: { runId: stored.id }, select: { symbol: true } });
    reconciliation = reconcileMask(panel.replayDays.find((d) => d.date === date), {
      id: stored.id,
      date,
      ok: stored.ok,
      universeSize: stored.universeSize,
      excluded: JSON.parse(stored.excludedJson) as Record<string, number>,
      resultSymbols: results.map((r) => r.symbol),
      panelSymbols: panel.symbols.length,
    });
  }

  const manifest: PanelManifest = {
    generatedAt: new Date().toISOString(),
    market,
    fingerprint,
    panelRange,
    replayWindow,
    warmupSessions: panel.dates.filter((d) => d < replayWindow.start).length,
    symbols: panel.symbols.length,
    bars: panel.barCount,
    adjustment: {
      method: "deriveAdjustedBars",
      anchor: "latest_bar_of_series",
      pointInTime: false,
      futureDividendFactor: {
        symbols: dilutions.length,
        median: quantile(dilutions, 0.5),
        p10: quantile(dilutions, 0.1),
        p90: quantile(dilutions, 0.9),
        max: dilutions.length ? dilutions[dilutions.length - 1]! : NaN,
      },
      volume: "as_stored (provider split-consistent; never locally adjusted)",
    },
    warmup: { replayTruncationBars: REPLAY_TRUNCATION_BARS },
    eligibleLegend: ELIGIBLE_LEGEND,
    counts: { u1Observations: u1, u2Observations: u2, u1PerSession: u1 / replayWindow.sessions, u2PerSession: u2 / replayWindow.sessions },
    reconciliation,
    columns: { date: "YYYY-MM-DD, the lane's own session calendar", fields: [...PANEL_FIELDS], eligible: "0 | 1 | 2 | (blank outside the replay window)" },
    limits: [
      "Survivorship: the store holds today's universe, so every claim is relative and an upper bound.",
      "adjustment.pointInTime=false — the anchor is the last bar, so cross-sectional (rank/zscore) alphas see a per-symbol constant from future dividends. Bound in futureDividendFactor; see the module header for why within-symbol ratios are unaffected.",
      "The mask is defined only inside replayWindow; blank means 'not evaluated', which is not the same as 0.",
      "Volume is as stored (split-consistent per R1) and never dividend-adjusted.",
    ],
  };

  // generatedAt is preserved from the first export so a re-export is a no-op.
  const manifestFile = path.join(dir, "manifest.json");
  const written: string[] = [];
  try {
    const prior = JSON.parse(readFileSync(manifestFile, "utf8")) as PanelManifest;
    if (prior.generatedAt) manifest.generatedAt = prior.generatedAt;
  } catch {
    // first export
  }

  mkdirSync(dir, { recursive: true });
  for (const field of PANEL_FIELDS) {
    const text = wideCsv(panel.symbols, panel.dates, (d, sym) => {
      if (field === "volume") return cellNum(panel.volume.get(sym)?.get(d));
      return cellNum(panel.bars.get(sym)?.get(d)?.[field]);
    });
    writeIfChanged(path.join(dir, `${field}.csv`), text, written);
  }
  const eligible = wideCsv(panel.symbols, panel.dates, (d, sym) => {
    const day = panel.mask.get(d);
    if (!day) return ""; // outside the replay window
    return String(day.get(sym) ?? 0);
  });
  writeIfChanged(path.join(dir, "eligible.csv"), eligible, written);
  writeIfChanged(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, written);

  return { market, fingerprint, dir, manifest, written };
}

export function renderPanelSummary(r: PanelExportResult): string {
  const m = r.manifest;
  const out: string[] = [];
  out.push(`--- ${m.market} ---`);
  out.push(`panel      ${m.panelRange.start} … ${m.panelRange.end} (${m.panelRange.sessions} sessions) · ${m.symbols} symbols · ${m.bars} bars`);
  out.push(`replay     ${m.replayWindow.start} … ${m.replayWindow.end} (${m.replayWindow.sessions} sessions) · ${m.warmupSessions} warmup sessions before it`);
  out.push(`universes  U1 ${m.counts.u1Observations} name-observations (${m.counts.u1PerSession.toFixed(1)}/session) · U2 ${m.counts.u2Observations} (${m.counts.u2PerSession.toFixed(1)}/session)`);
  const f = m.adjustment.futureDividendFactor;
  out.push(`anchor     dividend-adjusted, anchor = last bar (NOT point-in-time) · Π(1−D/P) after panel start: median ${f.median.toFixed(4)} · p10 ${f.p10.toFixed(4)} · p90 ${f.p90.toFixed(4)} over ${f.symbols} names`);
  const c = m.reconciliation;
  if (!c) out.push(`reconcile  no stored ScreenRun to compare against`);
  else {
    out.push(
      `reconcile  ${c.status.toUpperCase()} vs ScreenRun ${c.screenRunId} (${c.date}) · eligible stored ${c.storedEligible} (ok ${c.storedInputs} − census) vs mask U2 ${c.maskU2} · stored ranked ${c.storedResultSymbols}`,
    );
    out.push(`           U1 (informational, liquidity universe ⊇ production's): mask ${c.maskU1} vs stored floor ${c.storedU1Floor} · panel carries ${c.extraSymbols} instrument(s) the stored run did not screen`);
  }
  for (const d of c?.differences ?? []) out.push(`           ${d}`);
  out.push(`dir        ${r.dir}`);
  out.push(r.written.length ? `wrote      ${r.written.join(", ")}` : `wrote      nothing — re-export is a no-op`);
  return out.join("\n");
}
