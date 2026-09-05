/**
 * Vendor-archive segmentation CLI (research-databento-import.md §6.8,
 * architecture-v1.md §4.2 tail). Post-import pass over VendorBar that
 * detects ticker-reuse stitches and assigns every bar a surrogate segmentId
 * so consumers can always group by (symbol, segmentId). Read-only against
 * everything except VendorBar.segmentId + VendorSegment; raw bars never
 * altered (lossless).
 *
 *   pnpm -C apps/api segment:databento -- [--symbols META,BNY,FB] [--limit N]
 *
 * Plain script, NOT Nest (same shape as cli/import-databento.ts): constructs
 * PrismaService directly and calls runSegmentation(), which tests drive with
 * synthetic series via the exported pure functions.
 *
 * Stitch rule — a boundary exists between consecutive tradeable bars
 * b_{t-1}, b_t when ALL four hold:
 *   (a) calendar gap > 14 days (≈ > 10 missing trading sessions),
 *   (b) price jump open_t / close_{t-1} outside [1/2.5, 2.5],
 *   (c) no SplitEvent for that symbol on date_t,
 *   (d) the jump is not explained by a plausible split — lattice n:d with
 *       n,d ∈ 1..32 ∪ {40,50,64,65,70,80,100} within 5% log, PLUS the
 *       detector's volume signature (scripts/databento/
 *       split_candidate_detector.py): a real k:1 split scales volume by ~k,
 *       so NEAR factors (0.5–4) need day AND 5-session-persistent volume
 *       ratios within ±55% of k, FAR factors need direction-consistent
 *       persistent volume. When volume evidence is insufficient (archive
 *       edge), the price-lattice match alone decides (conservative).
 *       Rationale: the lattice is dense enough that EVERY moderate jump
 *       matches some rational within 5% log (measured: META 15.95× ≈ 16:1
 *       at 0.33% log, BNY 13.60× ≈ 27:2, FB 0.205× ≈ 1:5) — a price-only
 *       condition (d) suppresses the very ticker-reuse stitches this pass
 *       exists to flag (and makes the §6.8 validation set unflaggable).
 *       The volume signature is what discriminates a real split from a
 *       security swap: across META/BNY/FB the occupant changed, so volume
 *       moved opposite to (or wildly off) any split prediction. This is
 *       the one deliberate strengthening over the letter of §6.8 and is
 *       flagged here for review.
 * Same-day ticker reuse without a gap is missed by design (documented
 * limitation, §6.8: "reported, not hidden").
 *
 * Idempotent: a re-run recomputes and replaces each symbol's segments +
 * segmentIds transactionally. Anchors META/BNY/FB are validated against the
 * measured reuse boundaries; an anchor that was scanned and fails makes the
 * exit code 1 (fail-closed, same convention as import:databento).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PrismaService } from "../prisma.service.js";
import { VENDOR } from "./import-databento.js";

const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

// ---------------------------------------------------------------------------
// Stitch rule (pure functions — unit tests drive these directly).
// ---------------------------------------------------------------------------

export const MIN_GAP_CALENDAR_DAYS = 14; // > 10 missing sessions ≈ > 14 calendar days
export const JUMP_LOW = 1 / 2.5;
export const JUMP_HIGH = 2.5;
export const LOG_TOLERANCE = 0.05;
export const LATTICE_PARTS: number[] = [
  ...Array.from({ length: 32 }, (_, i) => i + 1),
  40, 50, 64, 65, 70, 80, 100,
];

// Volume gates mirror split_candidate_detector.py exactly: a k:1 split
// multiplies share count (and roughly volume) by k.
export const NEAR_LO = 0.5;
export const NEAR_HI = 4.0;
export const VOL_TOL = 0.55; // NEAR tier: |volRatio/k − 1| ≤ VOL_TOL, day AND persistent
const PRE_WINDOW = 10;
const POST_WINDOW = 5;
const MIN_WINDOW = 3;

const LATTICE: { factor: number; log: number }[] = (() => {
  const seen = new Set<number>();
  const out: { factor: number; log: number }[] = [];
  for (const n of LATTICE_PARTS)
    for (const d of LATTICE_PARTS) {
      const f = n / d;
      if (seen.has(f)) continue;
      seen.add(f);
      out.push({ factor: f, log: Math.log(f) });
    }
  return out.sort((a, b) => a.log - b.log);
})();

/** Nearest lattice factor to `ratio` in log space, or null when none is
 *  within 5% log. `ratio` is in split-factor orientation (price divisor). */
export function nearestRationalFactor(ratio: number): { factor: number; logDev: number } | null {
  if (!(ratio > 0)) return null;
  const lr = Math.log(ratio);
  let best: { factor: number; logDev: number } | null = null;
  for (const c of LATTICE) {
    const d = Math.abs(c.log - lr);
    if (best === null || d < best.logDev) best = { factor: c.factor, logDev: d };
  }
  return best !== null && best.logDev <= LOG_TOLERANCE ? best : null;
}

/** True when `ratio` matches some rational split factor n:d within 5% log
 *  (price-only test — see the header note on why (d) is not price-only). */
export function matchesRationalFactor(ratio: number): boolean {
  return nearestRationalFactor(ratio) !== null;
}

export interface SegBar {
  date: string;
  open: number;
  close: number;
  volume?: number;
}

function medianOf(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Split-hypothesis test for the boundary bars[i-1] → bars[i] (condition d).
 *  Returns the explaining factor when the jump IS plausibly a split, else
 *  null. Price: r = close_{t-1}/open_t must match the lattice within 5%
 *  log. Volume (detector mirror): NEAR factors need day + persistent
 *  volume ratios ≈ k within VOL_TOL; FAR factors need direction-consistent
 *  persistent volume. Insufficient volume history ⇒ price match alone
 *  decides (conservative: explained ⇒ no boundary). */
export function explainingSplitFactor(bars: SegBar[], i: number): { factor: number; logDev: number } | null {
  const prev = bars[i - 1]!;
  const cur = bars[i]!;
  if (!(prev.close > 0) || !(cur.open > 0)) return null;
  const match = nearestRationalFactor(prev.close / cur.open);
  if (match === null) return null;
  const k = match.factor;
  const pre = bars
    .slice(Math.max(0, i - PRE_WINDOW), i)
    .map((b) => b.volume)
    .filter((v): v is number => typeof v === "number" && v > 0);
  const post = bars
    .slice(i + 1, i + 1 + POST_WINDOW)
    .map((b) => b.volume)
    .filter((v): v is number => typeof v === "number" && v > 0);
  const dayVol = cur.volume;
  const medPre = medianOf(pre);
  const medPost = medianOf(post);
  if (pre.length < MIN_WINDOW || post.length < MIN_WINDOW || medPre === null || medPost === null || medPre <= 0) {
    return match; // insufficient volume evidence — price match decides
  }
  if (k >= NEAR_LO && k <= NEAR_HI) {
    if (typeof dayVol !== "number" || dayVol <= 0) return match;
    const dayRatio = dayVol / medPre;
    const persistRatio = medPost / medPre;
    if (Math.abs(dayRatio / k - 1) > VOL_TOL) return null;
    if (Math.abs(persistRatio / k - 1) > VOL_TOL) return null;
    return match;
  }
  // FAR tier: direction-only persistence gate.
  if ((medPost / medPre - 1) * (k - 1) <= 0) return null;
  return match;
}

export interface StitchBoundary {
  prevDate: string; // last bar of the old occupant
  date: string; // first bar of the new occupant
  gapCalendarDays: number;
  jump: number; // open_t / close_{t-1}
  prevClose: number;
  open: number;
  /** Nearest lattice factor (split-factor orientation) + why it was rejected. */
  rejectedFactor?: { factor: number; logDev: number; reason: string };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function gapCalendarDays(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
}

/** Detect stitch boundaries in one symbol's date-ordered tradeable bars.
 *  `splitDates` = the symbol's SplitEvent ex-dates (condition c). */
export function findBoundaries(bars: SegBar[], splitDates: ReadonlySet<string>): StitchBoundary[] {
  const out: StitchBoundary[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1]!;
    const cur = bars[i]!;
    const gap = gapCalendarDays(prev.date, cur.date);
    if (gap <= MIN_GAP_CALENDAR_DAYS) continue; // (a)
    if (!(prev.close > 0) || !(cur.open > 0)) continue;
    const jump = cur.open / prev.close;
    if (jump >= JUMP_LOW && jump <= JUMP_HIGH) continue; // (b)
    if (splitDates.has(cur.date)) continue; // (c)
    if (explainingSplitFactor(bars, i) !== null) continue; // (d)
    const near = nearestRationalFactor(prev.close / cur.open);
    out.push({
      prevDate: prev.date,
      date: cur.date,
      gapCalendarDays: gap,
      jump,
      prevClose: prev.close,
      open: cur.open,
      ...(near !== null
        ? {
            rejectedFactor: {
              factor: near.factor,
              logDev: near.logDev,
              reason: "volume signature inconsistent with split (occupant swap)",
            },
          }
        : {}),
    });
  }
  return out;
}

export interface Segment {
  segmentId: string; // 'SYM#N', chronological
  firstDate: string;
  lastDate: string;
  evidence: string; // '' for the first/unstitched segment
}

export function boundaryEvidence(b: StitchBoundary): string {
  const factorNote = b.rejectedFactor
    ? `nearest rational ${b.rejectedFactor.factor} (log dev ${b.rejectedFactor.logDev.toFixed(4)}) rejected: ${b.rejectedFactor.reason}`
    : `no rational split factor within ${LOG_TOLERANCE} log`;
  return (
    `stitch ${b.prevDate}→${b.date}: gap ${b.gapCalendarDays}d, ` +
    `jump ${b.jump.toFixed(4)}× (open ${b.open} vs prev close ${b.prevClose}), ` +
    `no SplitEvent on ${b.date}, ${factorNote}`
  );
}

/** Partition a symbol's date-ordered bars into chronological segments;
 *  segment k > 1 carries its opening stitch as evidence. */
export function assignSegments(symbol: string, bars: SegBar[], boundaries: StitchBoundary[]): Segment[] {
  if (!bars.length) return [];
  const boundaryAt = new Map(boundaries.map((b) => [b.date, b]));
  const segments: Segment[] = [];
  let start = 0;
  let evidence = "";
  for (let i = 1; i <= bars.length; i++) {
    const b = i < bars.length ? boundaryAt.get(bars[i]!.date) : undefined;
    if (i === bars.length || b) {
      segments.push({
        segmentId: `${symbol}#${segments.length + 1}`,
        firstDate: bars[start]!.date,
        lastDate: bars[i - 1]!.date,
        evidence,
      });
      start = i;
      evidence = b ? boundaryEvidence(b) : "";
    }
  }
  return segments;
}

// ---------------------------------------------------------------------------
// Typed report (Day-17 style, mirrors ImportReport).
// ---------------------------------------------------------------------------

export interface AnchorCheck {
  symbol: string;
  expected: { prevDate: string; date: string; segments: number };
  actual: { boundaries: { prevDate: string; date: string }[]; segments: number } | null; // null = not scanned/no bars
  pass: boolean;
}

export interface StitchedSymbol {
  symbol: string;
  segments: number;
  boundaries: StitchBoundary[];
}

export interface SegmentReport {
  vendor: string;
  date: string;
  symbolsScanned: number;
  stitchedSymbols: number;
  boundariesTotal: number;
  segmentsCreated: number;
  barsTagged: number;
  stitched: StitchedSymbol[]; // all stitched symbols, worst jump first
  samples: { symbol: string; jump: number; prevDate: string; date: string }[]; // 10 for human review
  anchors: AnchorCheck[];
  text: string;
}

/** Measured ticker-reuse anchors (research doc §6.8) — the validation set. */
export const ANCHORS: Record<string, { prevDate: string; date: string; segments: number }> = {
  META: { prevDate: "2022-01-28", date: "2022-06-09", segments: 2 },
  BNY: { prevDate: "2026-02-06", date: "2026-05-21", segments: 2 },
  FB: { prevDate: "2022-06-08", date: "2025-06-26", segments: 2 },
};

export interface SegmentDeps {
  prisma: PrismaService;
  /** Report output directory (default apps/api/reports). Null disables. */
  reportsDir?: string | null;
  log?: (line: string) => void;
}

export interface SegmentOpts {
  symbols?: string[];
  limit?: number;
}

interface BarRow {
  date: string;
  open: number | null;
  close: number | null;
  volume: number | null;
}

function renderText(r: SegmentReport): string {
  const lines = [
    `== VENDOR SEGMENTATION ==  ${r.vendor} ${r.date}: ${r.symbolsScanned} symbols scanned · ` +
      `${r.stitchedSymbols} stitched · ${r.boundariesTotal} boundaries · ${r.segmentsCreated} segments · ${r.barsTagged} bars tagged`,
    ...r.anchors.map(
      (a) =>
        `anchor ${a.symbol}: ${a.pass ? "PASS" : "FAIL"} — expected ${a.expected.segments} segments, boundary ` +
        `${a.expected.prevDate}→${a.expected.date}; actual ${
          a.actual === null
            ? "not scanned / no bars"
            : `${a.actual.segments} segments, boundaries ` +
              (a.actual.boundaries.length
                ? a.actual.boundaries.map((b) => `${b.prevDate}→${b.date}`).join(", ")
                : "none")
        }`,
    ),
  ];
  if (r.samples.length) {
    lines.push(
      "sample stitched symbols (worst jumps first):",
      ...r.samples.map(
        (s) => `  ${s.symbol}: ${s.jump.toFixed(2)}× at ${s.prevDate}→${s.date}`,
      ),
    );
  }
  return lines.join("\n");
}

/** Full segmentation pass — the function tests drive directly. */
export async function runSegmentation(deps: SegmentDeps, opts: SegmentOpts = {}): Promise<SegmentReport> {
  const { prisma } = deps;
  const log = deps.log ?? console.log;

  // Split registry, grouped by symbol (condition c lookup).
  const splitEvents = await prisma.splitEvent.findMany({ select: { symbol: true, exDate: true } });
  const splitsBySymbol = new Map<string, Set<string>>();
  for (const s of splitEvents) {
    let set = splitsBySymbol.get(s.symbol);
    if (!set) splitsBySymbol.set(s.symbol, (set = new Set()));
    set.add(s.exDate);
  }

  let symbols: string[];
  if (opts.symbols) {
    symbols = [...opts.symbols].sort();
  } else {
    const rows = await prisma.$queryRawUnsafe<{ symbol: string }[]>(
      `SELECT DISTINCT "symbol" FROM "VendorBar" WHERE "vendor" = ? ORDER BY "symbol"`,
      VENDOR,
    );
    symbols = rows.map((r) => r.symbol);
  }
  if (opts.limit !== undefined) symbols = symbols.slice(0, opts.limit);
  log(`segmentation: ${symbols.length} symbols to scan`);

  const stitched: StitchedSymbol[] = [];
  let segmentsCreated = 0;
  let barsTagged = 0;

  for (let idx = 0; idx < symbols.length; idx++) {
    const symbol = symbols[idx]!;
    const rows = await prisma.$queryRawUnsafe<BarRow[]>(
      `SELECT "date", "open", "close", "volume" FROM "VendorBar" WHERE "vendor" = ? AND "symbol" = ? ORDER BY "date"`,
      VENDOR,
      symbol,
    );
    const bars: SegBar[] = rows
      .filter((b) => b.open != null && b.close != null)
      .map((b) => ({ date: b.date, open: b.open!, close: b.close!, ...(b.volume != null ? { volume: b.volume } : {}) }));
    if (!bars.length) continue;
    const boundaries = findBoundaries(bars, splitsBySymbol.get(symbol) ?? new Set());
    const segments = assignSegments(symbol, bars, boundaries);

    await prisma.$transaction(async (tx) => {
      await tx.vendorSegment.deleteMany({ where: { vendor: VENDOR, symbol } });
      await tx.$executeRawUnsafe(
        `UPDATE "VendorBar" SET "segmentId" = NULL WHERE "vendor" = ? AND "symbol" = ?`,
        VENDOR,
        symbol,
      );
      await tx.vendorSegment.createMany({
        data: segments.map((s) => ({ vendor: VENDOR, symbol, ...s })),
      });
      for (const s of segments) {
        await tx.$executeRawUnsafe(
          `UPDATE "VendorBar" SET "segmentId" = ? WHERE "vendor" = ? AND "symbol" = ? AND "date" >= ? AND "date" <= ?`,
          s.segmentId,
          VENDOR,
          symbol,
          s.firstDate,
          s.lastDate,
        );
      }
    });

    segmentsCreated += segments.length;
    barsTagged += bars.length;
    if (boundaries.length) stitched.push({ symbol, segments: segments.length, boundaries });
    if ((idx + 1) % 1000 === 0) log(`progress: ${idx + 1}/${symbols.length} symbols, ${stitched.length} stitched`);
  }

  stitched.sort(
    (a, b) =>
      Math.max(...b.boundaries.map((x) => Math.abs(Math.log(x.jump)))) -
      Math.max(...a.boundaries.map((x) => Math.abs(Math.log(x.jump)))),
  );

  const scanned = new Set(symbols);
  const anchors: AnchorCheck[] = Object.entries(ANCHORS)
    .filter(([sym]) => scanned.has(sym))
    .map(([sym, expected]) => {
      const found = stitched.find((s) => s.symbol === sym);
      const actual = found
        ? {
            boundaries: found.boundaries.map((b) => ({ prevDate: b.prevDate, date: b.date })),
            segments: found.segments,
          }
        : { boundaries: [], segments: 1 };
      const pass =
        actual.segments === expected.segments &&
        actual.boundaries.length === 1 &&
        actual.boundaries[0]!.prevDate === expected.prevDate &&
        actual.boundaries[0]!.date === expected.date;
      return { symbol: sym, expected, actual, pass };
    });

  const samples = stitched.slice(0, 10).map((s) => {
    const worst = [...s.boundaries].sort((a, b) => Math.abs(Math.log(b.jump)) - Math.abs(Math.log(a.jump)))[0]!;
    return { symbol: s.symbol, jump: worst.jump, prevDate: worst.prevDate, date: worst.date };
  });

  const report: SegmentReport = {
    vendor: VENDOR,
    date: new Date().toISOString().slice(0, 10),
    symbolsScanned: symbols.length,
    stitchedSymbols: stitched.length,
    boundariesTotal: stitched.reduce((n, s) => n + s.boundaries.length, 0),
    segmentsCreated,
    barsTagged,
    stitched,
    samples,
    anchors,
    text: "",
  };
  report.text = renderText(report);
  log(report.text);
  if (deps.reportsDir !== null) {
    const dir = deps.reportsDir ?? path.join(PKG_ROOT, "reports");
    mkdirSync(dir, { recursive: true });
    const { text: _text, ...json } = report;
    writeFileSync(path.join(dir, `segment-vendor-bars-${report.date}.json`), JSON.stringify(json, null, 2));
  }
  return report;
}

// ---------------------------------------------------------------------------
// CLI wrapper (argument parsing + wiring only).
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): SegmentOpts {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const opts: SegmentOpts = {};
  const symbols = flag("symbols");
  if (symbols) opts.symbols = symbols.split(",").filter(Boolean);
  const limit = flag("limit");
  if (limit !== undefined) {
    opts.limit = Number(limit);
    if (!Number.isInteger(opts.limit) || opts.limit <= 0) throw new Error(`--limit must be a positive integer (got "${limit}")`);
  }
  return opts;
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const report = await runSegmentation({ prisma }, opts);
    return report.anchors.some((a) => !a.pass) ? 1 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

const invokedAsScript = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (invokedAsScript) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error("FATAL", e);
      process.exit(1);
    });
}
