/**
 * runImport end-to-end against a synthetic fixture archive (plain-text fake
 * ".zst" files + injected passthrough decompressor) and a throwaway SQLite db
 * with the real migrations. Covers: sha256 verify + mismatch abort, universe
 * filter, idempotent re-run journal, registry load, VendorBar inserts, and the
 * R4 cross-validation leg against a hand-built Instrument/Bar series.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runImport, VENDOR, type ImportReport } from "../../src/cli/import-databento.js";
import { PrismaService } from "../../src/prisma.service.js";
import { createTestDatabase, destroyTestDatabase, type TestDatabase } from "../helpers/test-db.js";

const HEADER = "ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol";

// NVDA-like: two sessions, a 2:1 split on 2024-06-10, one no-trade row.
const NVDA_CSV = `${HEADER}
2024-06-06T00:00:00Z,35,2,38,100,101,99,100,1000,NVDA
2024-06-07T00:00:00Z,35,2,38,100,103,99.5,102,1100,NVDA
2024-06-08T00:00:00Z,35,2,38,,,,,,NVDA
2024-06-10T00:00:00Z,35,2,38,51,52,50.5,51.5,2200,NVDA
`;
const QQQ_CSV = `${HEADER}
2024-06-06T00:00:00Z,35,2,7,400,401,399,400.5,5000,QQQ
2024-06-07T00:00:00Z,35,2,7,400,402,399.5,401.5,5100,QQQ
`;

let db: TestDatabase;
let prisma: PrismaService;
let archiveDir: string;
const savedUrl = process.env.DATABASE_URL;
const savedHome = process.env.HOME;

function writeFixture(name: string, content: string, corrupt = false): void {
  writeFileSync(path.join(archiveDir, name), corrupt ? content + "tampered" : content);
}

beforeAll(async () => {
  db = await createTestDatabase();
  process.env.DATABASE_URL = db.url;
  prisma = new PrismaService();
  await prisma.$connect();

  archiveDir = mkdtempSync(path.join(tmpdir(), "databento-fixture-"));
  const symbols = ["NVDA", "QQQ", "HE-A", "ZVZZT", "BADH"];
  writeFixture("xnas-itch-20210902-20260901.ohlcv-1d.NVDA.csv.zst", NVDA_CSV);
  for (const s of ["QQQ", "HE-A", "ZVZZT", "BADH"]) {
    writeFixture(`xnas-itch-20210902-20260901.ohlcv-1d.${s}.csv.zst`, QQQ_CSV);
  }
  const manifest = {
    job_id: "fixture",
    // Hashes computed over the CLEAN bytes; BADH is tampered afterwards so its
    // sha256 mismatches the manifest and the import must abort that file.
    files: symbols.map((s) => {
      const filename = `xnas-itch-20210902-20260901.ohlcv-1d.${s}.csv.zst`;
      return { filename, hash: `sha256:${sha256Of(path.join(archiveDir, filename))}` };
    }),
  };
  writeFileSync(path.join(archiveDir, "manifest.json"), JSON.stringify(manifest));
  writeFixture("xnas-itch-20210902-20260901.ohlcv-1d.BADH.csv.zst", QQQ_CSV, true);
  writeFileSync(
    path.join(archiveDir, "yahoo-splits-20210902-20260901.csv"),
    "symbol,ex_date,event,ratio_new,ratio_old,factor\nNVDA,2024-06-10,FORWARD_SPLIT,2,1,2\n",
  );
  writeFileSync(
    path.join(archiveDir, "split-registry-additions.csv"),
    "symbol,ex_date,event,ratio_new,ratio_old,factor,source,confidence\nNVDA,2024-06-10,FORWARD_SPLIT,2,1,1.99,inband,estimated\n",
  );
  writeFileSync(
    path.join(archiveDir, "symbol-listing-exchange.csv"),
    'symbol,listing_exchange,type,flag,security_name\nNVDA,NASDAQ,stock,,"NVIDIA Corporation"\nQQQ,NASDAQ,etf,,"Invesco QQQ"\nZVZZT,NASDAQ,stock,test,"NASDAQ TEST STOCK"\n',
  );

  // The Yahoo store side of the R4 cross-check: an adjusted series for NVDA
  // (split step already removed — Yahoo convention).
  const inst = await prisma.instrument.create({
    data: { symbol: "NVDA", market: "US", currency: "USD", name: "NVIDIA" },
  });
  await prisma.bar.createMany({
    data: [
      { instrumentId: inst.id, date: "2024-06-06", open: 50, high: 50.5, low: 49.5, close: 50, volume: 1000 },
      { instrumentId: inst.id, date: "2024-06-07", open: 50, high: 51.5, low: 49.75, close: 51, volume: 1100 },
      { instrumentId: inst.id, date: "2024-06-10", open: 51, high: 52, low: 50.5, close: 51.5, volume: 2200 },
    ],
  });
});

function sha256Of(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

afterAll(async () => {
  await prisma.$disconnect();
  destroyTestDatabase(db);
  rmSync(archiveDir, { recursive: true, force: true });
  if (savedUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedUrl;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

const deps = () => ({
  prisma,
  dataDir: archiveDir,
  decompress: (p: string) => readFileSync(p, "utf8"),
  reportsDir: null,
  log: () => {},
});

describe("runImport — fixture archive", () => {
  let report: ImportReport;

  it("imports eligible files, aborts the sha256-mismatch file", async () => {
    report = await runImport(deps());
    expect(report.files.inArchive).toBe(5);
    expect(report.files.eligibleUniverse).toBe(3); // NVDA, QQQ, BADH
    expect(report.files.excludedNonPlain).toBe(1); // HE-A
    expect(report.files.excludedTest).toBe(1); // ZVZZT (also listing-flagged)
    expect(report.files.imported).toBe(2);
    expect(report.files.failed).toBe(1);
    expect(report.sha256Failures).toHaveLength(1);
    expect(report.sha256Failures[0]!.symbol).toBe("BADH");

    expect(report.rows.inserted).toBe(5); // NVDA 3 tradeable + QQQ 2
    expect(report.rows.noTradeSkipped).toBe(1);
    expect(report.rowsPerFile).toEqual({ min: 2, max: 3, median: 2.5 });
    expect(report.dateCoverage.minDate).toBe("2024-06-06");
    expect(report.dateCoverage.maxDate).toBe("2024-06-10");

    const nvdaBars = await prisma.vendorBar.findMany({ where: { vendor: VENDOR, symbol: "NVDA" }, orderBy: { date: "asc" } });
    expect(nvdaBars.map((b) => b.close)).toEqual([100, 102, 51.5]); // as-traded
    // The mismatched file left no bars.
    expect(await prisma.vendorBar.count({ where: { symbol: "BADH" } })).toBe(0);
  });

  it("loads the merged registry (Yahoo wins the conflict) and classifications", async () => {
    const events = await prisma.splitEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ symbol: "NVDA", exDate: "2024-06-10", factor: 2, source: "yahoo", confidence: "authoritative" });
    expect(report.registry.conflicts).toBe(1);
    expect(await prisma.vendorInstrument.count()).toBe(3);
  });

  it("cross-validates split-adjusted vendor returns against the Yahoo store", async () => {
    const c = report.crossValidation!;
    expect(c.symbolsCompared).toBe(1);
    expect(c.returnPairs).toBe(2);
    expect(c.matched).toBe(2);
    expect(c.matchRate).toBe(1);
    // Without split adjustment the 06-10 return would be −49.5%, not +0.98%.
    expect(c.medianAbsDeviation).toBeLessThan(1e-9);
  });

  it("is idempotent: a re-run journals-skips files and inserts nothing", async () => {
    const rerun = await runImport(deps());
    expect(rerun.files.imported).toBe(0);
    expect(rerun.files.skippedAlreadyJournaled).toBe(2);
    expect(rerun.rows.inserted).toBe(0);
    expect(await prisma.vendorBar.count({ where: { vendor: VENDOR } })).toBe(5);
    // The sha-mismatch file is retried (non-terminal) and fails again, loudly.
    expect(rerun.sha256Failures).toHaveLength(1);
  });
});
