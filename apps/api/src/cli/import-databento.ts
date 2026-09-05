/**
 * DataBento XNAS archive import CLI (research-databento-import.md §6.5–6.7,
 * step §7.4). Read-only against the archive; additive against the store.
 *
 *   pnpm -C apps/api import:databento -- [--dir ~/Downloads/XNAS-...] [--limit N] [--symbols AAPL,NVDA]
 *
 * Plain script, NOT Nest (same shape as cli/daily-screen.ts): constructs
 * PrismaService directly and calls runImport(), which tests drive with a
 * fixture dir + injected decompressor. No network, no Yahoo calls.
 *
 * What it does, in order:
 *   1. Universe census — archive filenames → symbols (URL-decode with raw
 *      fallback), plain-only filter mirroring scripts/databento/
 *      yahoo-splits-sweep.mjs isPlain() exactly, plus exclusion of the known
 *      test symbols (listing-CSV flag=test ∪ hardcoded Z-class list).
 *   2. Split registry load — Yahoo sweep CSV ∪ FAR-tier in-band additions,
 *      dedupe on (symbol, exDate) with Yahoo winning; upsert SplitEvent.
 *      Listing classification → VendorInstrument upsert.
 *   3. Per file: manifest sha256 verify (mismatch ⇒ skip file, loud outcome)
 *      → zstd -dc → parse (no-trade rows skipped + counted) → INSERT OR
 *      REPLACE into VendorBar in one transaction → journal row in
 *      VendorImportFile. Re-runs skip files already journaled ok.
 *   4. R4 cross-validation (report-only): for symbols shared with the Yahoo
 *      store (Instrument/Bar, US lane), daily close-to-close returns from
 *      VendorBar — split-step-corrected on ex-dates via SplitEvent factors —
 *      vs stored returns; match rate + median abs deviation.
 *
 * Bars are stored AS-TRADED (decision 6.5). Instrument/Bar and R1 are never
 * touched; adjusted vendor series is derived on read.
 *
 * Exit code: 0 clean; 1 if any file failed or sha256 mismatched (cron-able,
 * same convention as screen:sentinel); FATAL error also exits 1.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PrismaService } from "../prisma.service.js";

export const VENDOR = "databento-xnas";
const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

// ---------------------------------------------------------------------------
// Universe classification (mirrors scripts/databento/yahoo-splits-sweep.mjs).
// ---------------------------------------------------------------------------

export function symbolFromFilename(fn: string): string | null {
  const m = fn.match(/^xnas-itch-\d{8}-\d{8}\.ohlcv-1d\.(.+)\.csv\.zst$/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1]!; // mixed/literal %-encoding — keep raw
  }
}

/** Exact mirror of the sweep script's isPlain() — do not drift. */
export function isPlain(sym: string): boolean {
  if (/[=#+]$/.test(sym)) return false; // NYSE-ADF '#', when-issued '=', warrant '+'
  if (sym.includes("-")) return false; // NYSE class/preferred via ADF
  if (/^[A-Z]{5}$/.test(sym) && "UWR".includes(sym.at(-1)!)) return false; // 5-char Nasdaq suffix
  return true;
}

/** Known exchange test symbols (research doc §2/§6.6: "the 9 known test
 *  symbols (ZVZZT-class)"). Hardcoded so delisted test names not present in
 *  symbol-listing-exchange.csv are still excluded; the importer also excludes
 *  anything flagged `test` in that CSV. */
export const KNOWN_TEST_SYMBOLS = new Set([
  "ZVZZT", "ZJZZT", "ZWZZT", "ZBZZT", "ZXZZT", "ZVV", "ZZZ", "ZEXIT", "ZIEXT",
  "ZCZZT", "ZXYZ", "ZTEST", "ZBA", "ZVOL",
]);

export type UniverseClass = "plain" | "non-plain" | "test";

export function classifySymbol(sym: string, flaggedTest: ReadonlySet<string>): UniverseClass {
  if (!isPlain(sym)) return "non-plain";
  if (KNOWN_TEST_SYMBOLS.has(sym) || flaggedTest.has(sym)) return "test";
  return "plain";
}

// ---------------------------------------------------------------------------
// CSV parsing.
// ---------------------------------------------------------------------------

export interface VendorBarRow {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ParseOutcome {
  bars: VendorBarRow[];
  /** Sessions with empty open/close/volume (no-trade days) — skipped, counted. */
  noTradeSkipped: number;
  totalRows: number;
}

/** Parse one decompressed ohlcv-1d CSV. Fixed-point decimal strings parse as
 *  plain numbers. Rows with empty open/close/volume are no-trade sessions. */
export function parseOhlcvCsv(text: string): ParseOutcome {
  const lines = text.split("\n");
  const bars: VendorBarRow[] = [];
  let noTradeSkipped = 0;
  let totalRows = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    totalRows++;
    const c = line.split(",");
    // ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol
    const open = c[4] ?? "";
    const close = c[7] ?? "";
    const volume = c[8] ?? "";
    if (open === "" || close === "" || volume === "") {
      noTradeSkipped++;
      continue;
    }
    bars.push({
      date: (c[0] ?? "").slice(0, 10),
      open: Number(open),
      high: Number(c[5]),
      low: Number(c[6]),
      close: Number(close),
      volume: Number(volume),
    });
  }
  return { bars, noTradeSkipped, totalRows };
}

/** Minimal quoted-field CSV parser (symbol-listing-exchange.csv security_name
 *  contains commas + quotes). Returns records keyed by the header row. */
export function parseCsvRecords(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift() ?? [];
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

// ---------------------------------------------------------------------------
// Split registry (Yahoo authoritative ∪ FAR-tier in-band estimated).
// ---------------------------------------------------------------------------

export interface SplitEventRow {
  symbol: string;
  exDate: string;
  event: string; // FORWARD_SPLIT | REVERSE_SPLIT
  ratioNew: number;
  ratioOld: number;
  factor: number;
  source: "yahoo" | "inband";
  confidence: "authoritative" | "estimated";
}

export function parseYahooRegistryCsv(text: string): SplitEventRow[] {
  return parseCsvRecords(text).map((r) => ({
    symbol: r.symbol!,
    exDate: r.ex_date!,
    event: r.event!,
    ratioNew: Number(r.ratio_new),
    ratioOld: Number(r.ratio_old),
    factor: Number(r.factor),
    source: "yahoo" as const,
    confidence: "authoritative" as const,
  }));
}

export function parseInbandAdditionsCsv(text: string): SplitEventRow[] {
  return parseCsvRecords(text).map((r) => ({
    symbol: r.symbol!,
    exDate: r.ex_date!,
    event: r.event!,
    ratioNew: Number(r.ratio_new),
    ratioOld: Number(r.ratio_old),
    factor: Number(r.factor),
    source: "inband" as const,
    confidence: "estimated" as const,
  }));
}

/** Dedupe on (symbol, exDate); Yahoo wins on conflict (decision §6.6).
 *  Test symbols are dropped from the final registry. */
export function mergeSplitRegistries(
  yahoo: SplitEventRow[],
  inband: SplitEventRow[],
  flaggedTest: ReadonlySet<string> = new Set(),
): { merged: SplitEventRow[]; conflicts: { symbol: string; exDate: string }[]; droppedTest: number } {
  const byKey = new Map<string, SplitEventRow>();
  const conflicts: { symbol: string; exDate: string }[] = [];
  let droppedTest = 0;
  for (const row of yahoo) {
    if (KNOWN_TEST_SYMBOLS.has(row.symbol) || flaggedTest.has(row.symbol)) {
      droppedTest++;
      continue;
    }
    byKey.set(`${row.symbol}${row.exDate}`, row);
  }
  for (const row of inband) {
    if (KNOWN_TEST_SYMBOLS.has(row.symbol) || flaggedTest.has(row.symbol)) {
      droppedTest++;
      continue;
    }
    const key = `${row.symbol}${row.exDate}`;
    if (byKey.has(key)) {
      conflicts.push({ symbol: row.symbol, exDate: row.exDate });
      continue; // Yahoo wins
    }
    byKey.set(key, row);
  }
  return { merged: [...byKey.values()], conflicts, droppedTest };
}

// ---------------------------------------------------------------------------
// R4 return adjustment math (validation only — VendorBar stays as-traded).
// ---------------------------------------------------------------------------

export interface DatedClose {
  date: string;
  close: number;
}

/** Daily close-to-close returns of an as-traded series with the split step
 *  removed on ex-dates: on an ex-date with factor f = ratioNew/ratioOld the
 *  pre-split price scales by 1/f, so the corrected return is
 *  close_t·f / close_{t-1} − 1. Multiple splits on one date multiply.
 *  Returns one entry per consecutive pair, keyed by the later date. */
export function splitAdjustedReturns(
  bars: DatedClose[],
  splits: { exDate: string; factor: number }[],
): Map<string, number> {
  const factorOnDate = new Map<string, number>();
  for (const s of splits) {
    factorOnDate.set(s.exDate, (factorOnDate.get(s.exDate) ?? 1) * s.factor);
  }
  const out = new Map<string, number>();
  const ordered = [...bars].sort((a, b) => a.date.localeCompare(b.date));
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!.close;
    const cur = ordered[i]!.close;
    if (prev === 0) continue;
    const f = factorOnDate.get(ordered[i]!.date) ?? 1;
    out.set(ordered[i]!.date, (cur * f) / prev - 1);
  }
  return out;
}

/** Plain close-to-close returns (no adjustment), keyed by the later date. */
export function rawReturns(bars: DatedClose[]): Map<string, number> {
  return splitAdjustedReturns(bars, []);
}

// ---------------------------------------------------------------------------
// Typed validation report (Day-17 style: structured, tallied, JSON-able).
// ---------------------------------------------------------------------------

export interface FileFailure {
  file: string;
  symbol: string | null;
  reason: string;
}

export interface CrossValidationReport {
  tolerance: number;
  symbolsCompared: number;
  symbolsSkipped: { symbol: string; reason: string }[];
  returnPairs: number;
  matched: number;
  matchRate: number | null;
  medianAbsDeviation: number | null;
  worst: { symbol: string; date: string; vendorReturn: number; storeReturn: number; absDeviation: number }[];
}

export interface ImportReport {
  vendor: string;
  dataDir: string;
  date: string;
  files: {
    inArchive: number;
    inManifest: number;
    missingFromManifest: string[];
    eligibleUniverse: number;
    excludedNonPlain: number;
    excludedTest: number;
    testSymbols: string[];
    imported: number;
    skippedAlreadyJournaled: number;
    failed: number;
  };
  sha256Failures: FileFailure[];
  failures: FileFailure[];
  rows: { inserted: number; noTradeSkipped: number };
  rowsPerFile: { min: number; max: number; median: number } | null;
  zeroTradeableSymbols: string[];
  dateCoverage: { minDate: string | null; maxDate: string | null; medianSessionsPerSymbol: number | null };
  registry: { yahooRows: number; inbandRows: number; mergedRows: number; conflicts: number; droppedTest: number };
  vendorInstruments: number;
  crossValidation: CrossValidationReport | null;
  text: string;
}

export interface ImportDeps {
  prisma: PrismaService;
  /** Archive directory (default ~/Downloads/XNAS-20260902-W559N3FC8U). */
  dataDir?: string;
  /** Decompress a .zst file to text (default: system `zstd -dc`). Tests inject. */
  decompress?: (filePath: string) => string;
  /** Report output directory (default apps/api/reports). Null disables. */
  reportsDir?: string | null;
  log?: (line: string) => void;
}

export interface ImportOpts {
  limit?: number;
  symbols?: string[];
  /** Skip the R4 store cross-validation leg. */
  skipCrossValidation?: boolean;
}

function defaultDecompress(filePath: string): string {
  return execFileSync("zstd", ["-dc", filePath], { maxBuffer: 256 * 1024 * 1024, encoding: "utf8" });
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const INSERT_CHUNK = 100; // 700 params/query, under SQLite's 999 default

interface RawExecutor {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

async function insertVendorBars(prisma: RawExecutor, symbol: string, bars: VendorBarRow[]): Promise<void> {
  for (let i = 0; i < bars.length; i += INSERT_CHUNK) {
    const chunk = bars.slice(i, i + INSERT_CHUNK);
    const values = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = chunk.flatMap((b) => [VENDOR, symbol, b.date, b.open, b.high, b.low, b.close, b.volume]);
    await prisma.$executeRawUnsafe(
      `INSERT OR REPLACE INTO "VendorBar" ("vendor","symbol","date","open","high","low","close","volume") VALUES ${values}`,
      ...params,
    );
  }
}

function renderText(r: ImportReport): string {
  const f = r.files;
  const lines = [
    `== DATABENTO IMPORT ==  ${r.vendor} ${r.date}: ${f.imported}/${f.eligibleUniverse} files imported · ` +
      `${f.skippedAlreadyJournaled} already journaled · ${f.excludedNonPlain} non-plain · ${f.excludedTest} test · ` +
      `${f.failed} failed · ${r.sha256Failures.length} sha256-mismatch`,
    `rows: ${r.rows.inserted} inserted · ${r.rows.noTradeSkipped} no-trade skipped · ` +
      (r.rowsPerFile ? `per-file min/max/median ${r.rowsPerFile.min}/${r.rowsPerFile.max}/${r.rowsPerFile.median}` : "per-file —"),
    `coverage: ${r.dateCoverage.minDate ?? "—"} → ${r.dateCoverage.maxDate ?? "—"} · ` +
      `zero-tradeable symbols: ${r.zeroTradeableSymbols.length}` +
      (r.zeroTradeableSymbols.length ? ` (${r.zeroTradeableSymbols.slice(0, 10).join(",")}${r.zeroTradeableSymbols.length > 10 ? ", …" : ""})` : ""),
    `registry: ${r.registry.mergedRows} events (yahoo ${r.registry.yahooRows} + inband ${r.registry.inbandRows} · ` +
      `${r.registry.conflicts} conflicts won by yahoo · ${r.registry.droppedTest} test-symbol rows dropped) · ` +
      `${r.vendorInstruments} listing classifications`,
  ];
  if (r.crossValidation) {
    const c = r.crossValidation;
    lines.push(
      `== R4 CROSS-VALIDATION ==  ${c.symbolsCompared} shared symbols · ${c.returnPairs} return pairs · ` +
        `match rate ${c.matchRate == null ? "—" : (c.matchRate * 100).toFixed(1) + "%"} (|Δ| ≤ ${c.tolerance}) · ` +
        `median |Δ| ${c.medianAbsDeviation == null ? "—" : c.medianAbsDeviation.toExponential(2)}`,
      ...c.worst.map(
        (w) =>
          `  worst: ${w.symbol} ${w.date} vendor ${w.vendorReturn.toFixed(4)} vs store ${w.storeReturn.toFixed(4)} (|Δ| ${w.absDeviation.toFixed(4)})`,
      ),
    );
  }
  if (r.sha256Failures.length) {
    lines.push(`sha256 failures: ${r.sha256Failures.map((x) => x.file).join(", ")}`);
  }
  if (r.failures.length) {
    lines.push(`failures: ${r.failures.map((x) => `${x.file}: ${x.reason}`).join("; ")}`);
  }
  return lines.join("\n");
}

/** Full import pipeline — the function tests drive directly. */
export async function runImport(deps: ImportDeps, opts: ImportOpts = {}): Promise<ImportReport> {
  const { prisma } = deps;
  const log = deps.log ?? console.log;
  const dataDir = path.resolve(
    (deps.dataDir ?? path.join(os.homedir(), "Downloads/XNAS-20260902-W559N3FC8U")).replace(/^~/, os.homedir()),
  );
  const decompress = deps.decompress ?? defaultDecompress;

  // ---- census -------------------------------------------------------------
  const manifestRaw = JSON.parse(readFileSync(path.join(dataDir, "manifest.json"), "utf8")) as {
    files: { filename: string; hash: string }[];
  };
  const manifestHashes = new Map(
    manifestRaw.files.filter((f) => f.filename.endsWith(".csv.zst")).map((f) => [f.filename, f.hash.replace(/^sha256:/, "")]),
  );
  const archiveFiles = readdirSync(dataDir).filter((f) => f.endsWith(".csv.zst")).sort();
  const missingFromManifest = archiveFiles.filter((f) => !manifestHashes.has(f));

  // Listing classification doubles as the test-flag source and VendorInstrument load.
  const listingRows = parseCsvRecords(readFileSync(path.join(dataDir, "symbol-listing-exchange.csv"), "utf8"));
  const flaggedTest = new Set(listingRows.filter((r) => r.flag === "test").map((r) => r.symbol!));

  interface Candidate {
    file: string;
    symbol: string;
  }
  const candidates: Candidate[] = [];
  let excludedNonPlain = 0;
  const testSymbols: string[] = [];
  for (const file of archiveFiles) {
    const symbol = symbolFromFilename(file);
    if (symbol === null) continue;
    const cls = classifySymbol(symbol, flaggedTest);
    if (cls === "non-plain") {
      excludedNonPlain++;
      continue;
    }
    if (cls === "test") {
      testSymbols.push(symbol);
      continue;
    }
    candidates.push({ file, symbol });
  }
  const onlySymbols = opts.symbols ? new Set(opts.symbols) : null;
  const eligible = candidates.filter((c) => !onlySymbols || onlySymbols.has(c.symbol));
  const toProcess = eligible.slice(0, opts.limit ?? eligible.length);

  log(`universe: ${archiveFiles.length} archive files → ${candidates.length} plain ` +
    `(${excludedNonPlain} non-plain, ${testSymbols.length} test excluded); processing ${toProcess.length}`);

  // ---- registry + listing classification ----------------------------------
  const yahooRows = parseYahooRegistryCsv(readFileSync(path.join(dataDir, "yahoo-splits-20210902-20260901.csv"), "utf8"));
  const inbandRows = parseInbandAdditionsCsv(readFileSync(path.join(dataDir, "split-registry-additions.csv"), "utf8"));
  const registry = mergeSplitRegistries(yahooRows, inbandRows, flaggedTest);
  await prisma.$transaction(
    registry.merged.map((r) =>
      prisma.splitEvent.upsert({
        where: { symbol_exDate: { symbol: r.symbol, exDate: r.exDate } },
        create: r,
        update: r,
      }),
    ),
  );
  await prisma.vendorInstrument.deleteMany();
  await prisma.vendorInstrument.createMany({
    data: listingRows.map((r) => ({
      symbol: r.symbol!,
      listingExchange: r.listing_exchange || null,
      type: r.type || null,
      flag: r.flag || null,
      securityName: r.security_name || null,
    })),
  });
  log(`registry: ${registry.merged.length} split events · ${listingRows.length} listing classifications`);

  // ---- per-file import ------------------------------------------------------
  const journaled = new Set(
    (await prisma.vendorImportFile.findMany({ where: { vendor: VENDOR, status: "ok" }, select: { file: true } })).map(
      (j) => j.file,
    ),
  );
  const sha256Failures: FileFailure[] = [];
  const failures: FileFailure[] = [];
  const rowCounts: number[] = [];
  const zeroTradeable: string[] = [];
  const sessionCounts = new Map<string, number>();
  let imported = 0;
  let skippedJournaled = 0;
  let rowsInserted = 0;
  let noTradeTotal = 0;
  let minDate: string | null = null;
  let maxDate: string | null = null;

  for (const { file, symbol } of toProcess) {
    if (journaled.has(file)) {
      skippedJournaled++;
      continue;
    }
    const filePath = path.join(dataDir, file);
    const expectedHash = manifestHashes.get(file);
    if (expectedHash !== undefined) {
      const actual = sha256File(filePath);
      if (actual !== expectedHash) {
        sha256Failures.push({ file, symbol, reason: `sha256 ${actual.slice(0, 12)}… != manifest ${expectedHash.slice(0, 12)}…` });
        await prisma.vendorImportFile.upsert({
          where: { vendor_file: { vendor: VENDOR, file } },
          create: { vendor: VENDOR, file, symbol, sha256: actual, rows: 0, noTradeSkipped: 0, status: "sha-mismatch" },
          update: { status: "sha-mismatch", sha256: actual },
        });
        continue;
      }
    }
    try {
      const parsed = parseOhlcvCsv(decompress(filePath));
      if (parsed.bars.length === 0) zeroTradeable.push(symbol);
      await prisma.$transaction(async (tx) => {
        await insertVendorBars(tx, symbol, parsed.bars);
        await tx.vendorImportFile.upsert({
          where: { vendor_file: { vendor: VENDOR, file } },
          create: {
            vendor: VENDOR,
            file,
            symbol,
            sha256: expectedHash ?? sha256File(filePath),
            rows: parsed.bars.length,
            noTradeSkipped: parsed.noTradeSkipped,
            status: "ok",
          },
          update: { rows: parsed.bars.length, noTradeSkipped: parsed.noTradeSkipped, status: "ok" },
        });
      });
      imported++;
      rowCounts.push(parsed.bars.length);
      sessionCounts.set(symbol, parsed.bars.length);
      rowsInserted += parsed.bars.length;
      noTradeTotal += parsed.noTradeSkipped;
      for (const b of parsed.bars) {
        if (minDate === null || b.date < minDate) minDate = b.date;
        if (maxDate === null || b.date > maxDate) maxDate = b.date;
      }
      if (imported % 500 === 0) log(`progress: ${imported} files imported, ${rowsInserted} rows`);
    } catch (e) {
      failures.push({ file, symbol, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  // ---- R4 cross-validation vs the Yahoo store (report only) -----------------
  let crossValidation: CrossValidationReport | null = null;
  if (!opts.skipCrossValidation) {
    crossValidation = await runCrossValidation(prisma);
    log(`cross-validation: ${crossValidation.symbolsCompared} symbols, match rate ${
      crossValidation.matchRate == null ? "—" : (crossValidation.matchRate * 100).toFixed(1) + "%"
    }`);
  }

  const report: ImportReport = {
    vendor: VENDOR,
    dataDir,
    date: new Date().toISOString().slice(0, 10),
    files: {
      inArchive: archiveFiles.length,
      inManifest: manifestHashes.size,
      missingFromManifest,
      eligibleUniverse: candidates.length,
      excludedNonPlain,
      excludedTest: testSymbols.length,
      testSymbols: testSymbols.sort(),
      imported,
      skippedAlreadyJournaled: skippedJournaled,
      failed: failures.length + sha256Failures.length,
    },
    sha256Failures,
    failures,
    rows: { inserted: rowsInserted, noTradeSkipped: noTradeTotal },
    rowsPerFile: rowCounts.length
      ? { min: Math.min(...rowCounts), max: Math.max(...rowCounts), median: median(rowCounts)! }
      : null,
    zeroTradeableSymbols: zeroTradeable.sort(),
    dateCoverage: {
      minDate,
      maxDate,
      medianSessionsPerSymbol: median([...sessionCounts.values()]),
    },
    registry: {
      yahooRows: yahooRows.length,
      inbandRows: inbandRows.length,
      mergedRows: registry.merged.length,
      conflicts: registry.conflicts.length,
      droppedTest: registry.droppedTest,
    },
    vendorInstruments: listingRows.length,
    crossValidation,
    text: "",
  };
  report.text = renderText(report);
  log(report.text);
  if (deps.reportsDir !== null) {
    const dir = deps.reportsDir ?? path.join(PKG_ROOT, "reports");
    mkdirSync(dir, { recursive: true });
    const { text: _text, ...json } = report;
    writeFileSync(path.join(dir, `import-databento-${report.date}.json`), JSON.stringify(json, null, 2));
  }
  return report;
}

const CROSSVAL_TOLERANCE = 0.001; // |Δreturn| ≤ 0.1% counts as a match

async function runCrossValidation(prisma: PrismaService): Promise<CrossValidationReport> {
  const instruments = await prisma.instrument.findMany({ where: { market: "US" }, include: { bars: { orderBy: { date: "asc" } } } });
  const skipped: { symbol: string; reason: string }[] = [];
  let compared = 0;
  let pairs = 0;
  let matched = 0;
  const deviations: number[] = [];
  const worst: CrossValidationReport["worst"] = [];
  for (const inst of instruments) {
    const vendorBars = await prisma.vendorBar.findMany({
      where: { vendor: VENDOR, symbol: inst.symbol },
      orderBy: { date: "asc" },
    });
    const tradeable = vendorBars.filter((b) => b.close != null);
    const stored = inst.bars.filter((b) => b.close != null);
    if (!tradeable.length || !stored.length) {
      skipped.push({ symbol: inst.symbol, reason: tradeable.length ? "no stored bars" : "no vendor bars" });
      continue;
    }
    const splits = await prisma.splitEvent.findMany({ where: { symbol: inst.symbol } });
    const vendorReturns = splitAdjustedReturns(
      tradeable.map((b) => ({ date: b.date, close: b.close! })),
      splits.map((s) => ({ exDate: s.exDate, factor: s.factor })),
    );
    const storeReturns = rawReturns(stored.map((b) => ({ date: b.date, close: b.close! })));
    compared++;
    for (const [date, vr] of vendorReturns) {
      const sr = storeReturns.get(date);
      if (sr === undefined) continue;
      const dev = Math.abs(vr - sr);
      pairs++;
      deviations.push(dev);
      if (dev <= CROSSVAL_TOLERANCE) matched++;
      worst.push({ symbol: inst.symbol, date, vendorReturn: vr, storeReturn: sr, absDeviation: dev });
    }
  }
  worst.sort((a, b) => b.absDeviation - a.absDeviation);
  return {
    tolerance: CROSSVAL_TOLERANCE,
    symbolsCompared: compared,
    symbolsSkipped: skipped,
    returnPairs: pairs,
    matched,
    matchRate: pairs ? matched / pairs : null,
    medianAbsDeviation: median(deviations),
    worst: worst.slice(0, 5),
  };
}

// ---------------------------------------------------------------------------
// CLI wrapper (argument parsing + wiring only).
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { opts: ImportOpts; dataDir?: string } {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const opts: ImportOpts = {};
  const limit = flag("limit");
  if (limit !== undefined) {
    opts.limit = Number(limit);
    if (!Number.isInteger(opts.limit) || opts.limit <= 0) throw new Error(`--limit must be a positive integer (got "${limit}")`);
  }
  const symbols = flag("symbols");
  if (symbols) opts.symbols = symbols.split(",").filter(Boolean);
  if (argv.includes("--skip-cross-validation")) opts.skipCrossValidation = true;
  return { opts, dataDir: flag("dir") };
}

async function main(): Promise<number> {
  const { opts, dataDir } = parseArgs(process.argv.slice(2));
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const report = await runImport({ prisma, ...(dataDir ? { dataDir } : {}) }, opts);
    return report.failures.length || report.sha256Failures.length ? 1 : 0;
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
