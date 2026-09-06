/**
 * DataBento XNYS archive import CLI — per-day sibling of import-databento.ts
 * (research-databento-import.md; PROGRESS 2026-09-05 XNYS review). Read-only
 * against the archive; additive against the store.
 *
 *   pnpm -C apps/api import:databento:xnys -- [--dir ~/Downloads/XNYS-...] [--limit N]
 *     [--symbols BRK.B,GME] [--manifest path] [--listing path] [--dry-run]
 *
 * Differences from the XNAS importer, all driven by the archive being
 * per-DAY (1,254 files × ~7.5k symbols) instead of per-symbol:
 *   1. Streaming-ish ingest: one day file at a time, rows buffered ONLY for
 *      symbols in the import manifest (scripts/databento/
 *      xnys-import-manifest.csv — the approved universe, Option A) MINUS the
 *      user-approved test/derivative exclusion set: the manifest accidentally
 *      carries 19 NTEST-class symbols; the ported classifier drops them from
 *      the active universe (reported loudly, not silently).
 *   2. Symbols arrive in NYSE space notation (`BRK B`). Storage follows the
 *      XNAS convention (VendorBar holds `BRK.B` — verified in dev.db), so
 *      the storage symbol is space→dot normalized. The raw `symbol` column
 *      is matched EXACTLY against the manifest's raw space notation.
 *   3. Classifier port: bare isPlain() does NOT catch NYSE derivative
 *      suffixes — explicit exclusion of space suffixes WS/WSA/WSB, U,
 *      PR[A-Z], WI, RT, RTWI, WD (the faithful mirror of XNAS's
 *      =/+/- exclusions), plus NYSE test names (NTEST G…Z, CTEST A,
 *      MTEST A, PTEST) ∪ KNOWN_TEST_SYMBOLS ∪ listing flag=test.
 *   4. VendorInstrument: same nasdaqtraded.txt-join reference CSV as XNAS
 *      (dot notation) — manifest symbols are upserted (never deleteMany;
 *      the XNAS rows must survive).
 *   5. Missing dates per symbol are NORMAL (thin names have holes; XNYS has
 *      no no-trade rows) — absent dates are not an error.
 *
 * Journal: VendorImportFile keyed (vendor='databento-xnys', file=day
 * filename); sha256 from manifest.json (the XNYS manifest hashes carry a
 * `sha256:` prefix — stripped). symbol column stores the session date.
 *
 * --dry-run: full scan, zero DB access (no journal reads, no writes).
 *
 * Exit code: 0 clean; 1 if any file failed or sha256 mismatched.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PrismaService } from "../prisma.service.js";
import {
  isPlain,
  KNOWN_TEST_SYMBOLS,
  parseCsvRecords,
  type VendorBarRow,
} from "./import-databento.js";

export const VENDOR = "databento-xnys";
const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "..", "..");
const DEFAULT_MANIFEST = path.join(REPO_ROOT, "scripts/databento/xnys-import-manifest.csv");
const DEFAULT_LISTING = path.join(
  os.homedir(),
  "Downloads/XNAS-20260902-W559N3FC8U/symbol-listing-exchange.csv",
);

// ---------------------------------------------------------------------------
// Filename / symbol handling.
// ---------------------------------------------------------------------------

export function dateFromFilename(fn: string): string | null {
  const m = fn.match(/^xnys-pillar-(\d{4})(\d{2})(\d{2})\.ohlcv-1d\.csv\.zst$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** NYSE space notation → storage notation. The XNAS importer stores share
 *  classes dotted (`BRK.B` in VendorBar/VendorInstrument), so XNYS `BRK B`
 *  normalizes to `BRK.B`. */
export function normalizeSymbol(raw: string): string {
  return raw.replace(/ /g, ".");
}

/** NYSE space-notation derivative suffixes that bare isPlain() misses:
 *  WS/WSA/WSB warrants, U units, PR[A-Z] preferreds, WI when-issued,
 *  RT/RTWI rights, WD when-distributed. Mirrors the XNAS exclusion of
 *  `=`, `+`, `-` classes (decision: universe = plain symbols only). */
const DERIVATIVE_SUFFIX = /^(WSA?|WSB|U|PR[A-Z]|WI|RTWI|RT|WD)$/;

/** NYSE test symbols in raw space notation (user-approved set). */
export const NYSE_TEST_SYMBOLS = new Set([
  ..."GHIJKLMNOQYZ".split("").map((s) => `NTEST ${s}`),
  "CTEST A",
  "MTEST A",
  "PTEST",
]);

export type XnysClass = "plain" | "non-plain" | "test";

/** Defense-in-depth classifier; the manifest is the universe authority.
 *  `flaggedTest` is in dot (listing-reference) notation. */
export function classifyXnysSymbol(raw: string, flaggedTest: ReadonlySet<string>): XnysClass {
  if (NYSE_TEST_SYMBOLS.has(raw)) return "test";
  const norm = normalizeSymbol(raw);
  if (KNOWN_TEST_SYMBOLS.has(norm) || flaggedTest.has(norm)) return "test";
  const sp = raw.indexOf(" ");
  if (sp !== -1 && DERIVATIVE_SUFFIX.test(raw.slice(sp + 1))) return "non-plain";
  if (!isPlain(norm)) return "non-plain";
  return "plain";
}

// ---------------------------------------------------------------------------
// Day-file parsing.
// ---------------------------------------------------------------------------

export interface DayParseOutcome {
  /** Manifest symbols matched in this file → bar (storage/normalized symbol). */
  matched: Map<string, VendorBarRow>;
  totalRows: number;
  /** Rows whose raw symbol is in the manifest. */
  manifestRows: number;
  /** Non-manifest rows rejected by the classifier. */
  rejectedNonPlain: number;
  rejectedTest: number;
  /** Non-manifest rows that classify plain (out-of-universe plain names). */
  nonManifestPlain: number;
  /** Duplicate (symbol, date) rows within the file — last wins. */
  duplicates: number;
  /** Empty open/close/volume rows (XNYS has none; counted defensively). */
  noTradeSkipped: number;
  /** high<low, high<open/close, low>open/close, non-positive px, volume<0. */
  ohlcViolations: number;
}

/** Parse one decompressed per-day ohlcv-1d CSV. Only raw symbols present in
 *  `manifestSymbols` (exact match on the raw space notation) are buffered. */
export function parseDayCsv(text: string, manifestSymbols: ReadonlySet<string>): DayParseOutcome {
  const out: DayParseOutcome = {
    matched: new Map(),
    totalRows: 0,
    manifestRows: 0,
    rejectedNonPlain: 0,
    rejectedTest: 0,
    nonManifestPlain: 0,
    duplicates: 0,
    noTradeSkipped: 0,
    ohlcViolations: 0,
  };
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    out.totalRows++;
    const c = line.split(",");
    // ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol
    const raw = c[9] ?? "";
    if (!manifestSymbols.has(raw)) {
      // Cheap pre-check: anything with a space + derivative suffix, or the
      // known test names, without running the full classifier per row.
      const sp = raw.indexOf(" ");
      if (sp !== -1 && DERIVATIVE_SUFFIX.test(raw.slice(sp + 1))) out.rejectedNonPlain++;
      else if (raw.startsWith("NTEST ") || raw.startsWith("CTEST ") || raw.startsWith("MTEST ") || raw === "PTEST")
        out.rejectedTest++;
      else out.nonManifestPlain++;
      continue;
    }
    out.manifestRows++;
    const open = c[4] ?? "";
    const close = c[7] ?? "";
    const volume = c[8] ?? "";
    if (open === "" || close === "" || volume === "") {
      out.noTradeSkipped++;
      continue;
    }
    const bar: VendorBarRow = {
      date: (c[0] ?? "").slice(0, 10),
      open: Number(open),
      high: Number(c[5]),
      low: Number(c[6]),
      close: Number(close),
      volume: Number(volume),
    };
    if (
      !(bar.high >= bar.low) ||
      bar.high < bar.open ||
      bar.high < bar.close ||
      bar.low > bar.open ||
      bar.low > bar.close ||
      bar.open <= 0 ||
      bar.close <= 0 ||
      bar.volume < 0
    ) {
      out.ohlcViolations++;
    }
    const sym = normalizeSymbol(raw);
    if (out.matched.has(sym)) out.duplicates++;
    out.matched.set(sym, bar);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Typed validation report (same style as the XNAS importer).
// ---------------------------------------------------------------------------

export interface XnysFileFailure {
  file: string;
  date: string | null;
  reason: string;
}

export interface XnysImportReport {
  vendor: string;
  dataDir: string;
  date: string;
  dryRun: boolean;
  files: {
    inArchive: number;
    inManifest: number;
    missingFromManifest: string[];
    processed: number;
    skippedAlreadyJournaled: number;
    failed: number;
  };
  manifest: {
    symbols: number;
    /** Manifest symbols the ported classifier would reject (should be 0). */
    classifierWouldReject: { symbol: string; cls: XnysClass }[];
    seen: number;
    unseen: string[];
  };
  classifier: { rejectedNonPlain: number; rejectedTest: number; nonManifestPlain: number };
  sha256Failures: XnysFileFailure[];
  failures: XnysFileFailure[];
  rows: { inserted: number; manifestRows: number; totalRows: number; noTradeSkipped: number };
  rowsPerFile: { min: number; max: number; median: number } | null;
  duplicates: number;
  ohlcViolations: number;
  dateCoverage: { minDate: string | null; maxDate: string | null; medianSessionsPerSymbol: number | null };
  vendorInstruments: { upserted: number; unmatchedManifestSymbols: number };
  text: string;
}

export interface XnysImportDeps {
  /** Required unless opts.dryRun. */
  prisma?: PrismaService;
  dataDir?: string;
  /** Import-universe manifest CSV (default scripts/databento/xnys-import-manifest.csv). */
  manifestPath?: string;
  /** nasdaqtraded.txt-join listing reference CSV (dot notation). */
  listingPath?: string;
  decompress?: (filePath: string) => string;
  reportsDir?: string | null;
  log?: (line: string) => void;
}

export interface XnysImportOpts {
  limit?: number;
  /** Storage (dot) notation. */
  symbols?: string[];
  dryRun?: boolean;
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

async function insertVendorBars(prisma: RawExecutor, rows: { symbol: string; bar: VendorBarRow }[]): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    const values = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = chunk.flatMap((r) => [VENDOR, r.symbol, r.bar.date, r.bar.open, r.bar.high, r.bar.low, r.bar.close, r.bar.volume]);
    await prisma.$executeRawUnsafe(
      `INSERT OR REPLACE INTO "VendorBar" ("vendor","symbol","date","open","high","low","close","volume") VALUES ${values}`,
      ...params,
    );
  }
}

function renderText(r: XnysImportReport): string {
  const f = r.files;
  const lines = [
    `== DATABENTO XNYS IMPORT ==${r.dryRun ? " (dry-run)" : ""}  ${r.vendor} ${r.date}: ${f.processed}/${f.inArchive} day files · ` +
      `${f.skippedAlreadyJournaled} already journaled · ${f.failed} failed · ${r.sha256Failures.length} sha256-mismatch`,
    `rows: ${r.rows.inserted} matched (${r.rows.manifestRows} manifest rows of ${r.rows.totalRows} total) · ` +
      `${r.rows.noTradeSkipped} no-trade skipped · ${r.duplicates} duplicate (symbol,date) · ${r.ohlcViolations} OHLC violations · ` +
      (r.rowsPerFile ? `per-file min/max/median ${r.rowsPerFile.min}/${r.rowsPerFile.max}/${r.rowsPerFile.median}` : "per-file —"),
    `manifest: ${r.manifest.seen}/${r.manifest.symbols} symbols seen · ${r.manifest.unseen.length} unseen · ` +
      `${r.manifest.classifierWouldReject.length} classifier-rejections of manifest symbols` +
      (r.manifest.classifierWouldReject.length
        ? ` (${r.manifest.classifierWouldReject.slice(0, 10).map((x) => `${x.symbol}:${x.cls}`).join(",")})`
        : ""),
    `classifier: ${r.classifier.rejectedNonPlain} non-plain rows · ${r.classifier.rejectedTest} test rows · ` +
      `${r.classifier.nonManifestPlain} out-of-universe plain rows`,
    `coverage: ${r.dateCoverage.minDate ?? "—"} → ${r.dateCoverage.maxDate ?? "—"} · ` +
      `median sessions/symbol ${r.dateCoverage.medianSessionsPerSymbol ?? "—"} · ` +
      `VendorInstrument: ${r.vendorInstruments.upserted} upserted, ${r.vendorInstruments.unmatchedManifestSymbols} manifest symbols unmatched in listing reference`,
  ];
  if (r.sha256Failures.length) {
    lines.push(`sha256 failures: ${r.sha256Failures.map((x) => x.file).join(", ")}`);
  }
  if (r.failures.length) {
    lines.push(`failures: ${r.failures.map((x) => `${x.file}: ${x.reason}`).join("; ")}`);
  }
  return lines.join("\n");
}

/** Full import pipeline — the function tests drive directly. */
export async function runImport(deps: XnysImportDeps, opts: XnysImportOpts = {}): Promise<XnysImportReport> {
  const dryRun = opts.dryRun ?? false;
  const prisma = deps.prisma;
  if (!dryRun && !prisma) throw new Error("prisma is required unless --dry-run");
  const log = deps.log ?? console.log;
  const dataDir = path.resolve(
    (deps.dataDir ?? path.join(os.homedir(), "Downloads/XNYS-20260903-GYR7NW7XTP")).replace(/^~/, os.homedir()),
  );
  const manifestPath = (deps.manifestPath ?? DEFAULT_MANIFEST).replace(/^~/, os.homedir());
  const listingPath = (deps.listingPath ?? DEFAULT_LISTING).replace(/^~/, os.homedir());
  const decompress = deps.decompress ?? defaultDecompress;

  // ---- universe manifest (the authority) ------------------------------------
  const manifestSymbols = new Set(
    parseCsvRecords(readFileSync(manifestPath, "utf8"))
      .map((r) => r.symbol!)
      .filter(Boolean),
  );

  // ---- listing reference (VendorInstrument join + test flags) ---------------
  const listingRows = parseCsvRecords(readFileSync(listingPath, "utf8"));
  const flaggedTest = new Set(listingRows.filter((r) => r.flag === "test").map((r) => r.symbol!));
  const listingBySymbol = new Map(listingRows.map((r) => [r.symbol!, r]));

  // Defense-in-depth: the manifest accidentally carries 19 test symbols
  // (NTEST-class, CTEST/MTEST/PTEST, listing flag=test) — the user-approved
  // exclusion set applies on top, so the effective universe is manifest minus
  // classifier-rejected. Rejections are reported, not silent.
  const classifierWouldReject: { symbol: string; cls: XnysClass }[] = [];
  const eligibleSymbols = new Set<string>();
  for (const raw of manifestSymbols) {
    const cls = classifyXnysSymbol(raw, flaggedTest);
    if (cls !== "plain") classifierWouldReject.push({ symbol: raw, cls });
    else eligibleSymbols.add(raw);
  }

  // ---- archive census ---------------------------------------------------------
  const manifestRaw = JSON.parse(readFileSync(path.join(dataDir, "manifest.json"), "utf8")) as {
    files: { filename: string; hash: string }[];
  };
  const manifestHashes = new Map(
    manifestRaw.files.filter((f) => f.filename.endsWith(".csv.zst")).map((f) => [f.filename, f.hash.replace(/^sha256:/, "")]),
  );
  const archiveFiles = readdirSync(dataDir)
    .filter((f) => dateFromFilename(f) !== null)
    .sort();
  const missingFromManifest = archiveFiles.filter((f) => !manifestHashes.has(f));

  const onlySymbols = opts.symbols ? new Set(opts.symbols) : null;
  const activeManifest = onlySymbols
    ? new Set([...eligibleSymbols].filter((s) => onlySymbols.has(normalizeSymbol(s))))
    : eligibleSymbols;
  const toProcess = archiveFiles.slice(0, opts.limit ?? archiveFiles.length);

  log(
    `universe: ${manifestSymbols.size} manifest symbols → ${eligibleSymbols.size} plain ` +
      `(${classifierWouldReject.length} classifier-rejected; ${activeManifest.size} active) · ` +
      `${archiveFiles.length} day files; processing ${toProcess.length}${dryRun ? " [dry-run]" : ""}`,
  );

  // ---- VendorInstrument upsert (additive — never deleteMany) ----------------
  let viUpserted = 0;
  let viUnmatched = 0;
  if (!dryRun) {
    const upserts = [];
    for (const raw of activeManifest) {
      const norm = normalizeSymbol(raw);
      const ref = listingBySymbol.get(norm);
      if (!ref) {
        viUnmatched++;
        continue;
      }
      upserts.push(
        prisma!.vendorInstrument.upsert({
          where: { symbol: norm },
          create: {
            symbol: norm,
            listingExchange: ref.listing_exchange || null,
            type: ref.type || null,
            flag: ref.flag || null,
            securityName: ref.security_name || null,
          },
          update: {
            listingExchange: ref.listing_exchange || null,
            type: ref.type || null,
            flag: ref.flag || null,
            securityName: ref.security_name || null,
          },
        }),
      );
    }
    for (let i = 0; i < upserts.length; i += 500) {
      await prisma!.$transaction(upserts.slice(i, i + 500));
    }
    viUpserted = upserts.length;
    log(`VendorInstrument: ${viUpserted} upserted · ${viUnmatched} manifest symbols unmatched in listing reference`);
  } else {
    for (const raw of activeManifest) {
      if (listingBySymbol.has(normalizeSymbol(raw))) viUpserted++;
      else viUnmatched++;
    }
  }

  // ---- per-day import ---------------------------------------------------------
  const journaled = dryRun
    ? new Set<string>()
    : new Set(
        (
          await prisma!.vendorImportFile.findMany({
            where: { vendor: VENDOR, status: "ok" },
            select: { file: true },
          })
        ).map((j) => j.file),
      );
  const sha256Failures: XnysFileFailure[] = [];
  const failures: XnysFileFailure[] = [];
  const rowCounts: number[] = [];
  const sessionCounts = new Map<string, number>();
  const symbolsSeen = new Set<string>();
  let processed = 0;
  let skippedJournaled = 0;
  let rowsInserted = 0;
  let manifestRowTotal = 0;
  let rowTotal = 0;
  let noTradeTotal = 0;
  let dupTotal = 0;
  let ohlcViolTotal = 0;
  let rejectedNonPlain = 0;
  let rejectedTest = 0;
  let nonManifestPlain = 0;
  let minDate: string | null = null;
  let maxDate: string | null = null;

  for (const file of toProcess) {
    const date = dateFromFilename(file);
    if (journaled.has(file)) {
      skippedJournaled++;
      continue;
    }
    const filePath = path.join(dataDir, file);
    const expectedHash = manifestHashes.get(file);
    if (expectedHash !== undefined) {
      const actual = sha256File(filePath);
      if (actual !== expectedHash) {
        sha256Failures.push({ file, date, reason: `sha256 ${actual.slice(0, 12)}… != manifest ${expectedHash.slice(0, 12)}…` });
        if (!dryRun) {
          await prisma!.vendorImportFile.upsert({
            where: { vendor_file: { vendor: VENDOR, file } },
            create: { vendor: VENDOR, file, symbol: date ?? "", sha256: actual, rows: 0, noTradeSkipped: 0, status: "sha-mismatch" },
            update: { status: "sha-mismatch", sha256: actual },
          });
        }
        continue;
      }
    }
    try {
      const parsed = parseDayCsv(decompress(filePath), activeManifest);
      const rows = [...parsed.matched.entries()].map(([symbol, bar]) => ({ symbol, bar }));
      if (!dryRun) {
        await prisma!.$transaction(async (tx) => {
          await insertVendorBars(tx, rows);
          await tx.vendorImportFile.upsert({
            where: { vendor_file: { vendor: VENDOR, file } },
            create: {
              vendor: VENDOR,
              file,
              symbol: date ?? "",
              sha256: expectedHash ?? sha256File(filePath),
              rows: rows.length,
              noTradeSkipped: parsed.noTradeSkipped,
              status: "ok",
            },
            update: { rows: rows.length, noTradeSkipped: parsed.noTradeSkipped, status: "ok" },
          });
        });
      }
      processed++;
      rowCounts.push(rows.length);
      rowsInserted += rows.length;
      manifestRowTotal += parsed.manifestRows;
      rowTotal += parsed.totalRows;
      noTradeTotal += parsed.noTradeSkipped;
      dupTotal += parsed.duplicates;
      ohlcViolTotal += parsed.ohlcViolations;
      rejectedNonPlain += parsed.rejectedNonPlain;
      rejectedTest += parsed.rejectedTest;
      nonManifestPlain += parsed.nonManifestPlain;
      for (const [symbol, bar] of parsed.matched) {
        symbolsSeen.add(symbol);
        sessionCounts.set(symbol, (sessionCounts.get(symbol) ?? 0) + 1);
        if (minDate === null || bar.date < minDate) minDate = bar.date;
        if (maxDate === null || bar.date > maxDate) maxDate = bar.date;
      }
      if (processed % 250 === 0) log(`progress: ${processed} day files, ${rowsInserted} matched rows`);
    } catch (e) {
      failures.push({ file, date, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  const unseen = [...activeManifest]
    .map(normalizeSymbol)
    .filter((s) => !symbolsSeen.has(s))
    .sort();

  const report: XnysImportReport = {
    vendor: VENDOR,
    dataDir,
    date: new Date().toISOString().slice(0, 10),
    dryRun,
    files: {
      inArchive: archiveFiles.length,
      inManifest: manifestHashes.size,
      missingFromManifest,
      processed,
      skippedAlreadyJournaled: skippedJournaled,
      failed: failures.length + sha256Failures.length,
    },
    manifest: {
      symbols: activeManifest.size,
      classifierWouldReject,
      seen: symbolsSeen.size,
      unseen,
    },
    classifier: { rejectedNonPlain, rejectedTest, nonManifestPlain },
    sha256Failures,
    failures,
    rows: { inserted: rowsInserted, manifestRows: manifestRowTotal, totalRows: rowTotal, noTradeSkipped: noTradeTotal },
    rowsPerFile: rowCounts.length
      ? { min: Math.min(...rowCounts), max: Math.max(...rowCounts), median: median(rowCounts)! }
      : null,
    duplicates: dupTotal,
    ohlcViolations: ohlcViolTotal,
    dateCoverage: { minDate, maxDate, medianSessionsPerSymbol: median([...sessionCounts.values()]) },
    vendorInstruments: { upserted: viUpserted, unmatchedManifestSymbols: viUnmatched },
    text: "",
  };
  report.text = renderText(report);
  log(report.text);
  if (deps.reportsDir !== null) {
    const dir = deps.reportsDir ?? path.join(PKG_ROOT, "reports");
    mkdirSync(dir, { recursive: true });
    const { text: _text, ...json } = report;
    writeFileSync(
      path.join(dir, `import-databento-xnys-${report.date}${dryRun ? "-dryrun" : ""}.json`),
      JSON.stringify(json, null, 2),
    );
  }
  return report;
}

// ---------------------------------------------------------------------------
// CLI wrapper (argument parsing + wiring only).
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { opts: XnysImportOpts; deps: Pick<XnysImportDeps, "dataDir" | "manifestPath" | "listingPath"> } {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const opts: XnysImportOpts = {};
  const limit = flag("limit");
  if (limit !== undefined) {
    opts.limit = Number(limit);
    if (!Number.isInteger(opts.limit) || opts.limit <= 0) throw new Error(`--limit must be a positive integer (got "${limit}")`);
  }
  const symbols = flag("symbols");
  if (symbols) opts.symbols = symbols.split(",").filter(Boolean);
  if (argv.includes("--dry-run")) opts.dryRun = true;
  return {
    opts,
    deps: {
      ...(flag("dir") !== undefined ? { dataDir: flag("dir") } : {}),
      ...(flag("manifest") !== undefined ? { manifestPath: flag("manifest") } : {}),
      ...(flag("listing") !== undefined ? { listingPath: flag("listing") } : {}),
    },
  };
}

async function main(): Promise<number> {
  const { opts, deps } = parseArgs(process.argv.slice(2));
  if (opts.dryRun) {
    const report = await runImport({ ...deps }, opts);
    return report.failures.length || report.sha256Failures.length ? 1 : 0;
  }
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const report = await runImport({ ...deps, prisma }, opts);
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
