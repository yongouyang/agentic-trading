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
 * ## The dividend anchor: the panel is FORWARD-anchored, and why
 *
 * `deriveAdjustedBars` — the shipped screen's convention, and Yahoo's `adjclose`
 * one — is a MULTIPLICATIVE BACK-adjustment anchored at the latest bar:
 *
 *     adj_back(t) = raw(t) × Π{d > t} (1 − D/P_prev)
 *
 * so a value at T carries dividends that go ex AFTER T. That is safe wherever it
 * is used for a RATIO, which is why the screen and the forward-return builder use
 * it: every such factor cancels between the two endpoints (`replay.ts` header
 * note 3). A factor VALUE has no such cancellation, and a factor panel is read
 * cross-sectionally at a fixed T.
 *
 * **The panel therefore uses the forward anchor** (`deriveAdjustedBarsForward`),
 * decided 2026-09-18 after the alternative was measured:
 *
 *     adj_forward(t) = raw(t) / Π{d ≤ t} (1 − D/P_prev)
 *
 * Both conventions satisfy the same ratio identity
 * `adj(t₂)/adj(t₁) = raw(t₂)/raw(t₁) × Π{t₁ < d ≤ t₂} f`, so they agree on EVERY
 * return and differ only in level — and it is the level that the panel needs to be
 * historical.
 *
 * **How big the difference was, because it is the whole reason for the change.**
 * The distortion at T is a per-symbol constant rescaling of the price columns, so
 * the affected alphas are decidable: rescale each symbol's OHLC by a factor drawn
 * from the measured spread and re-run the bridge. On 31 alphas spanning all three
 * contributing zoos, **9 moved and 3 catastrophically** — `alpha101_015` at rank
 * ρ 0.4412 on 1250/1250 dates, `alpha101_092` 0.6701, `alpha101_045` 0.8507. For
 * those the cross-section was dominated by the per-symbol dividend factor rather
 * than by the signal, so an IC computed from it would have been measuring a
 * per-symbol fixed effect assembled from post-T data. (A first 11-alpha sample
 * said 10 of 11 were untouched and the effect was negligible; it was too small and
 * its stride selected scale-invariant alphas. See amendment A2-1.)
 *
 * **Two consequences are now properties rather than caveats.** Truncating a
 * forward-anchored panel is a clean no-op on the data, so the look-ahead invariant
 * is checkable by ordinary truncation (`alpha-bridge.prefix-check.py`) rather than
 * only on sliced text; and the panel is window-independent, so an export ending at
 * T equals the full export's rows ≤ T.
 *
 * **The residual, named because it is real and PIT-legal:** a forward-anchored
 * level is inflated by the symbol's own PAST dividend history, so a
 * level-sensitive alpha reads that history. It is past information, so it is not
 * look-ahead — but its size is measured into the manifest
 * (`pastDividendFactor`) rather than left implicit, exactly as the anchor it
 * replaced was.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  REPLAY_TRUNCATION_BARS,
  deriveAdjustedBarsForward,
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
    method: "deriveAdjustedBarsForward";
    anchor: "first_bar_of_series";
    /** True: a value at t uses only ex-dates at or before t. */
    pointInTime: true;
    /** The residual cost of a total-return series, measured at the replay
     *  window's start across the names priced that day: the level is inflated by
     *  the symbol's own PAST dividends. Past information, so not look-ahead; the
     *  P10–P90 SPREAD is the part that survives into a cross-sectional rank. */
    pastDividendFactor: { symbols: number; median: number; p10: number; p90: number; max: number };
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

/** The adjustment convention is part of the identity of a panel: it changes every
 *  price while leaving the range, the symbol list and the bar count identical, so
 *  a fingerprint without it would let a stale `signals/` set be silently reused
 *  against data it was not computed from. */
export const ADJUSTMENT_TOKEN = "fwd";

/** Deterministic directory key: window + symbol/bar counts + a digest of the
 *  symbol LIST + the adjustment convention. */
export function fingerprintOf(panel: PanelRange, symbols: string[], bars: number, adjustment: string = ADJUSTMENT_TOKEN): string {
  const digest = createHash("sha256").update(symbols.join("\n")).digest("hex").slice(0, 12);
  return `${panel.start}_${panel.end}-${panel.sessions}s-${symbols.length}n-${bars}b-${adjustment}-${digest}`;
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

/**
 * `adj_forward(date) / raw(date)` = `1 / Π{ex-date ≤ date}(1 − D/P_prev)`: the
 * FACTOR by which a forward-anchored level is inflated by the symbol's own PAST
 * dividends at that session.
 *
 * Measured rather than asserted, in the same spirit as the back-anchor's
 * future-dividend factor was: it is the residual cost of the convention, and a
 * level-sensitive alpha reads this history. It is past information, so it is not
 * look-ahead — but the number belongs on the record, not in a footnote.
 */
export function pastDividendFactors(series: SymbolSeries[], date: string): number[] {
  const out: number[] = [];
  for (const s of series) {
    const raw = s.bars.find((b) => b.date === date);
    if (!raw || raw.close == null || raw.close === 0) continue;
    const adj = deriveAdjustedBarsForward(s.bars, s.dividends).find((b) => b.date === date);
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

export interface PanelRangeFilter {
  from?: string;
  to?: string;
}

/** Pure given a loaded lane: adjust once, replay once, derive both universes. */
export function buildLanePanel(lane: LoadedLane, range: PanelRangeFilter = {}): LanePanel {
  const symbols = lane.series.map((s) => s.symbol);
  const bars = new Map<string, Map<string, Bar>>();
  const volume = new Map<string, Map<string, number | null>>();
  let barCount = 0;
  for (const s of lane.series) {
    barCount += s.bars.length;
    const byDate = new Map<string, Bar>();
    for (const b of deriveAdjustedBarsForward(s.bars, s.dividends)) byDate.set(b.date, b);
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

  const inRange = (d: string) => (!range.from || d >= range.from) && (!range.to || d <= range.to);
  return { market: lane.market, symbols, dates: panelDates(lane.series).filter(inRange), bars, volume, mask, replayDays, barCount };
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
  opts: { root: string; log?: (m: string) => void; from?: string; to?: string },
): Promise<PanelExportResult> {
  const log = opts.log ?? (() => {});
  const lane = await loadLane(prisma, market, log);
  // A windowed export is not a convenience: it is the check that the panel is
  // window-INDEPENDENT. With a forward anchor a value at t uses only ex-dates at
  // or before t, so an export ending at T must reproduce the full export's rows
  // <= T exactly. Under the back anchor it cannot, which is how the convention
  // was caught.
  if (opts.from || opts.to) {
    lane.dates = lane.dates.filter((d) => (!opts.from || d >= opts.from) && (!opts.to || d <= opts.to));
    if (lane.windowStart && opts.from && opts.from > lane.windowStart) lane.windowStart = opts.from;
  }
  if (lane.dates.length < 2) throw new Error(`${market}: too few replay sessions (${lane.dates.length})`);
  const panel = buildLanePanel(lane, { from: opts.from, to: opts.to });

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
  const dilutions = pastDividendFactors(lane.series, replayWindow.start).sort((a, b) => a - b);
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
      method: "deriveAdjustedBarsForward",
      anchor: "first_bar_of_series",
      pointInTime: true,
      pastDividendFactor: {
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
      "The panel is forward-anchored (adjustment.pointInTime=true): a value at t uses only ex-dates at or before t. The residual is that a level carries the symbol's PAST dividends, measured in adjustment.pastDividendFactor.",
      "The mask is defined only inside replayWindow; blank means 'not evaluated', which is not the same as 0.",
      "Truncating this panel is a no-op on the data, so the look-ahead invariant is checkable by ordinary truncation.",
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
  const f = m.adjustment.pastDividendFactor;
  out.push(`anchor     forward-anchored (point-in-time) · level vs raw from PAST dividends: median ${f.median.toFixed(4)} · p10 ${f.p10.toFixed(4)} · p90 ${f.p90.toFixed(4)} over ${f.symbols} names`);
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
