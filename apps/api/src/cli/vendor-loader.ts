/**
 * Vendor-lane loader — Phase 4c pre-registration (docs/phase-4c-plan.md,
 * "Universe (fixed)" rules 1-4). Loads the locked liquid vendor universe
 * (scripts/databento/liquid-survivors.csv — 1,490 symbols / 1,844 series,
 * >= 252 bars, adv20 >= $20M on vendor volume) from VendorBar as
 * `SymbolSeries[]` for the pure quant-core machinery.
 *
 * The rules, all pre-registered and non-negotiable after the bar locks:
 *
 *  1. QUARANTINE: the 27 gap-bearing series
 *     (scripts/databento/quarantine-gap-series.csv, internal gap > 14 days —
 *     includes the META ticker-identity case) are excluded by vendor+symbol.
 *  2. DUAL FEED: a symbol under both vendor keys (354) loads from ONE feed —
 *     the one with more bars (ties break to databento-xnas, deterministic) —
 *     never concatenated. The choice is recorded in the manifest.
 *  3. SPLITS: VendorBar is as-traded and NEVER locally adjusted (R1 does not
 *     hold for this archive), so splits are applied HERE at load time, as a
 *     backward price adjustment to the raw bars (bars before the ex-date are
 *     scaled by 1/factor, volume by factor — dollar volume is invariant).
 *     Sources: the SplitEvent registry PLUS the two P2/P3 detector-candidate
 *     rows (VENDOR_EXTRA_SPLITS below). Whole-history split adjustment is
 *     exactly PIT-safe for this screen: a split after day T scales the entire
 *     day-T window uniformly, and every screen statistic (SMA alignment,
 *     momentum, sharpe, mdd, dollar-volume) is scale-invariant under a
 *     uniform factor.
 *  4. DIVIDENDS: the Yahoo-harvested layer (scripts/databento/
 *     yahoo-dividends.csv) flows through the picker's own adjustment path
 *     (`deriveAdjustedBars` via `SymbolSeries.dividends`, multiplicative
 *     back-adjustment 1 - D/P_prev with P_prev = previous session's close —
 *     packages/quant-core/src/adjustment.ts:50-68). Amounts are Yahoo-nominal
 *     at ex-date (as-traded basis); because rule 3 pre-scales historical
 *     prices, each dividend amount is scaled by the cumulative factor of
 *     splits with exDate > the dividend's ex-date, keeping D and P_prev on
 *     the same basis (the pre-registered loader caveat: never ratio a
 *     nominal amount against a split-adjusted price). Symbols in
 *     yahoo-dividends-residual.txt (112) get price returns — disclosed in
 *     the manifest and the run report.
 *  5. caDegraded is picker-side metadata with no vendor analogue: false,
 *     and the manifest says so.
 *
 * The DB is read-only; nothing here writes. DB loading of the dividend
 * artifact into a vendor-side table is a separate, later decision.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Bar, CorporateAction, SymbolSeries } from "@agentic-trading/quant-core";
import { PrismaService } from "../prisma.service.js";

const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "..", "..");
const ARTIFACTS = path.join(REPO_ROOT, "scripts", "databento");

/** The two P2/P3 detector-candidate split rows, added to the SplitEvent
 *  registry per the pre-registration (rule 2 of the locked universe).
 *  Provenance:
 *  - CDTX 2024-04-24 1:19 reverse — detected-split-candidates-v4.csv
 *    (factor 0.052632) and p2p3-jump-classification.csv (databento-xnas
 *    survivor feed; the xnys candidate file reads the same event one session
 *    later at 1:27 — the survivor feed's reading is used).
 *  - QXO 2024-07-30 16:3 forward — xnys-split-candidates.csv (factor
 *    5.333333) and p2p3-jump-classification.csv (databento-xnys feed). */
export const VENDOR_EXTRA_SPLITS: VendorSplit[] = [
  { symbol: "CDTX", exDate: "2024-04-24", factor: 1 / 19 },
  { symbol: "QXO", exDate: "2024-07-30", factor: 16 / 3 },
];

export interface VendorSplit {
  symbol: string;
  exDate: string;
  /** ratioNew / ratioOld — > 1 forward split, < 1 reverse split. */
  factor: number;
}

export interface VendorBarRow {
  vendor: string;
  symbol: string;
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

export interface VendorLoaderManifest {
  generatedAt: string;
  survivorSymbols: number;
  survivorSeries: number;
  quarantinedExcluded: number;
  dualFeedSymbols: number;
  feedChoices: { "databento-xnas": number; "databento-xnys": number };
  seriesLoaded: number;
  barsLoaded: number;
  splitSymbols: number;
  splitEventsApplied: number;
  extraSplitsApplied: string[];
  dividendCoveredSymbols: number;
  dividendEvents: number;
  dividendResidualSymbols: number;
  caDegraded: "n/a (vendor lane — always false)";
  windowStart: string | null;
  windowEnd: string | null;
  calendarSessions: number;
}

// ---------------------------------------------------------------------------
// pure core (unit-tested without the DB)
// ---------------------------------------------------------------------------

/** Backward split adjustment of as-traded bars: every bar before a split's
 *  ex-date is scaled by 1/factor in price and by factor in volume (dollar
 *  volume invariant, anchoring the series at the latest bar — the same
 *  backward convention as deriveAdjustedBars). Input bars must be ascending;
 *  returns new objects, input untouched. */
export function applySplitAdjustments(bars: Bar[], splits: VendorSplit[]): Bar[] {
  if (splits.length === 0) return bars.map((b) => ({ ...b }));
  return bars.map((b) => {
    let f = 1;
    for (const s of splits) if (s.exDate > b.date) f *= s.factor;
    if (f === 1) return { ...b };
    return {
      ...b,
      open: b.open == null ? null : b.open / f,
      high: b.high == null ? null : b.high / f,
      low: b.low == null ? null : b.low / f,
      close: b.close == null ? null : b.close / f,
      volume: b.volume == null ? null : b.volume * f,
    };
  });
}

/** Scale Yahoo-nominal dividend amounts onto the split-adjusted bar basis:
 *  amount ÷ Π factors of splits with exDate AFTER the dividend's ex-date
 *  (strictly after — a split and a dividend on the same ex-date leave the
 *  amount on the pre-split basis, matching that session's raw close). */
export function scaleDividendsToSplitBasis(
  dividends: CorporateAction[],
  splits: VendorSplit[],
): CorporateAction[] {
  if (splits.length === 0) return dividends.map((d) => ({ ...d }));
  return dividends.map((d) => {
    let f = 1;
    for (const s of splits) if (s.exDate > d.date) f *= s.factor;
    return f === 1 ? { ...d } : { ...d, amount: d.amount / f };
  });
}

/** Dual-feed rule: one feed per symbol, more bars wins, ties break to
 *  databento-xnas (deterministic). */
export function chooseFeed(perFeed: { vendor: string; barCount: number }[]): string {
  const sorted = [...perFeed].sort(
    (a, b) => b.barCount - a.barCount || a.vendor.localeCompare(b.vendor),
  );
  return sorted[0]!.vendor;
}

/** Merge registry splits with the two detector-candidate rows; the registry
 *  is authoritative on a symbol+exDate collision. */
export function mergeSplits(registry: VendorSplit[], extra: VendorSplit[]): VendorSplit[] {
  const keys = new Set(registry.map((s) => `${s.symbol}|${s.exDate}`));
  const merged = [...registry];
  for (const s of extra) if (!keys.has(`${s.symbol}|${s.exDate}`)) merged.push(s);
  return merged.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.exDate.localeCompare(b.exDate));
}

// ---------------------------------------------------------------------------
// artifact parsing
// ---------------------------------------------------------------------------

function readCsvRows(file: string): string[][] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .filter((l) => l.trim())
    .map((l) => l.split(","));
}

export interface VendorArtifacts {
  survivors: { symbol: string; vendorKeys: string[] }[];
  quarantined: Set<string>; // "vendor|symbol"
  dividends: Map<string, CorporateAction[]>;
  dividendResidual: Set<string>;
}

export function loadVendorArtifacts(dir: string = ARTIFACTS): VendorArtifacts {
  const survivors = readCsvRows(path.join(dir, "liquid-survivors.csv")).map((r) => ({
    symbol: r[0]!,
    vendorKeys: r[1]!.split(";"),
  }));
  const quarantined = new Set(
    readCsvRows(path.join(dir, "quarantine-gap-series.csv")).map((r) => `${r[0]}|${r[1]}`),
  );
  const dividends = new Map<string, CorporateAction[]>();
  for (const r of readCsvRows(path.join(dir, "yahoo-dividends.csv"))) {
    const list = dividends.get(r[0]!) ?? [];
    list.push({ date: r[1]!, type: "DIVIDEND", amount: Number(r[2]), currency: "USD" });
    dividends.set(r[0]!, list);
  }
  const dividendResidual = new Set(
    readFileSync(path.join(dir, "yahoo-dividends-residual.txt"), "utf8")
      .trim()
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => l.split("\t")[0]!),
  );
  return { survivors, quarantined, dividends, dividendResidual };
}

// ---------------------------------------------------------------------------
// pure assembly (unit-tested without the DB)
// ---------------------------------------------------------------------------

export interface AssembledVendorLane {
  series: SymbolSeries[];
  dates: string[];
  windowStart: string | null;
  manifest: VendorLoaderManifest;
}

/** Survivor rows + artifacts + splits → adjusted SymbolSeries and manifest.
 *  Pure: quarantine exclusion, dual-feed choice, split/dividend application. */
export function assembleVendorSeries(
  rows: VendorBarRow[],
  art: VendorArtifacts,
  splits: VendorSplit[],
  minBars = 252,
): AssembledVendorLane {
  const splitsBySymbol = new Map<string, VendorSplit[]>();
  for (const s of splits) {
    const list = splitsBySymbol.get(s.symbol) ?? [];
    list.push(s);
    splitsBySymbol.set(s.symbol, list);
  }

  // The locked universe is the survivor SERIES set, not every feed a survivor
  // symbol happens to have in VendorBar: a symbol whose xnas series alone met
  // the liquidity floor must not pick up its (illiquid) xnys series here.
  const allowedSeries = new Set<string>();
  for (const s of art.survivors) for (const v of s.vendorKeys) allowedSeries.add(`${v}|${s.symbol}`);

  // group bars per series, drop quarantined, apply the dual-feed rule
  const bySeries = new Map<string, { vendor: string; symbol: string; bars: VendorBarRow[] }>();
  const excludedSeries = new Set<string>();
  for (const r of rows) {
    const key = `${r.vendor}|${r.symbol}`;
    if (!allowedSeries.has(key)) continue;
    if (art.quarantined.has(key)) {
      excludedSeries.add(key);
      continue;
    }
    let e = bySeries.get(key);
    if (!e) {
      e = { vendor: r.vendor, symbol: r.symbol, bars: [] };
      bySeries.set(key, e);
    }
    e.bars.push(r);
  }
  const quarantinedExcluded = excludedSeries.size;

  const bySymbol = new Map<string, { vendor: string; bars: VendorBarRow[] }[]>();
  for (const e of bySeries.values()) {
    const list = bySymbol.get(e.symbol) ?? [];
    list.push({ vendor: e.vendor, bars: e.bars });
    bySymbol.set(e.symbol, list);
  }

  const series: SymbolSeries[] = [];
  const allDates = new Set<string>();
  let windowStart: string | null = null;
  let dualFeedSymbols = 0;
  const feedChoices = { "databento-xnas": 0, "databento-xnys": 0 };
  let barsLoaded = 0;
  let splitSymbols = 0;
  let splitEventsApplied = 0;
  let dividendCoveredSymbols = 0;
  let dividendEvents = 0;

  for (const [symbol, feeds] of [...bySymbol.entries()].sort()) {
    if (feeds.length > 1) dualFeedSymbols++;
    const chosen = chooseFeed(feeds.map((f) => ({ vendor: f.vendor, barCount: f.bars.length })));
    feedChoices[chosen as keyof typeof feedChoices]++;
    const raw = feeds.find((f) => f.vendor === chosen)!.bars;
    const symSplits = splitsBySymbol.get(symbol) ?? [];
    if (symSplits.length) {
      splitSymbols++;
      splitEventsApplied += symSplits.length;
    }
    const bars = applySplitAdjustments(raw as unknown as Bar[], symSplits);
    barsLoaded += bars.length;
    for (const b of bars) allDates.add(b.date);
    if (bars.length >= minBars) {
      const d = bars[minBars - 1]!.date;
      if (windowStart === null || d < windowStart) windowStart = d;
    }
    const divs = art.dividends.get(symbol) ?? [];
    if (divs.length) {
      dividendCoveredSymbols++;
      dividendEvents += divs.length;
    }
    series.push({
      symbol,
      market: "US",
      caDegraded: false, // picker-side metadata; no vendor analogue
      bars,
      dividends: scaleDividendsToSplitBasis(divs, symSplits),
    });
  }

  const dates = [...allDates].sort().filter((d) => windowStart === null || d >= windowStart);
  const manifest: VendorLoaderManifest = {
    generatedAt: new Date().toISOString(),
    survivorSymbols: art.survivors.length,
    survivorSeries: art.survivors.reduce((a, s) => a + s.vendorKeys.length, 0),
    quarantinedExcluded,
    dualFeedSymbols,
    feedChoices,
    seriesLoaded: series.length,
    barsLoaded,
    splitSymbols,
    splitEventsApplied,
    extraSplitsApplied: VENDOR_EXTRA_SPLITS.map((s) => `${s.symbol} ${s.exDate} factor ${s.factor.toPrecision(6)}`),
    dividendCoveredSymbols,
    dividendEvents,
    dividendResidualSymbols: [...art.dividendResidual].filter((s) => bySymbol.has(s)).length,
    caDegraded: "n/a (vendor lane — always false)",
    windowStart,
    windowEnd: dates[dates.length - 1] ?? null,
    calendarSessions: dates.length,
  };
  return { series, dates, windowStart, manifest };
}

// ---------------------------------------------------------------------------
// DB-bound loader
// ---------------------------------------------------------------------------

const CHUNK = 500;

export type LoadedVendorLane = AssembledVendorLane;

export async function loadVendorLane(
  prisma: PrismaService,
  opts: { artifactsDir?: string; minBars?: number; log?: (m: string) => void } = {},
): Promise<LoadedVendorLane> {
  const log = opts.log ?? (() => {});
  const minBars = opts.minBars ?? 252; // mirrors MIN_BARS_FOR_REPLAY (backtest-screen.ts:41)
  const art = loadVendorArtifacts(opts.artifactsDir);
  const symbols = art.survivors.map((s) => s.symbol);

  log(`  vendor: ${symbols.length} survivor symbols — loading bars…`);
  const rows: VendorBarRow[] = [];
  for (let i = 0; i < symbols.length; i += CHUNK) {
    const chunk = symbols.slice(i, i + CHUNK);
    const part = (await prisma.vendorBar.findMany({
      where: { symbol: { in: chunk } },
      orderBy: [{ symbol: "asc" }, { vendor: "asc" }, { date: "asc" }],
      select: { vendor: true, symbol: true, date: true, open: true, high: true, low: true, close: true, volume: true },
    })) as VendorBarRow[];
    for (const r of part) rows.push(r); // no spread: chunks hold ~400k rows
  }

  const registryRows: { symbol: string; exDate: string; factor: number }[] = [];
  for (let i = 0; i < symbols.length; i += CHUNK) {
    const part = await prisma.splitEvent.findMany({
      where: { symbol: { in: symbols.slice(i, i + CHUNK) } },
      select: { symbol: true, exDate: true, factor: true },
    });
    for (const r of part) registryRows.push(r);
  }
  const splits = mergeSplits(
    registryRows.map((r) => ({ symbol: r.symbol, exDate: r.exDate, factor: r.factor })),
    VENDOR_EXTRA_SPLITS,
  );

  const lane = assembleVendorSeries(rows, art, splits, minBars);
  const m = lane.manifest;
  log(
    `  vendor: ${m.seriesLoaded} series loaded (${m.barsLoaded} bars) · quarantined ${m.quarantinedExcluded} · dual-feed ${m.dualFeedSymbols} · splits ${m.splitEventsApplied} events/${m.splitSymbols} symbols · dividends ${m.dividendEvents} events/${m.dividendCoveredSymbols} symbols`,
  );
  return lane;
}
