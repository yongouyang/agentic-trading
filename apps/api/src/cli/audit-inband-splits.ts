/**
 * Corroboration audit of in-band (source='inband', confidence='estimated')
 * SplitEvent rows against the vendor archive (research-databento-import.md
 * §4.3, decision 6.6; PROGRESS 2026-09-05 R4 follow-up — BR 2024-10-04 was
 * a false positive from a single bad open print).
 *
 *   pnpm -C apps/api audit:inband
 *
 * READ-ONLY: writes reports/inband-audit-<date>.json + .csv, never mutates
 * the registry. Flagged rows are for user review; deletions happen only via
 * cli/delete-split-event.ts with an explicit reason.
 *
 * Rubric (per row): prevClose = last tradeable VendorBar close BEFORE
 * exDate in the same segment; exBar = VendorBar exactly ON exDate in that
 * segment. measured_open = prevClose/exOpen, measured_close = prevClose/
 * exClose; err(r) = |ln(r / factor)|; e = max(err_open, err_close).
 *   corroborated            e ≤ ln(1.25)          ("within 25% log")
 *   drifted-but-plausible   e ≤ 2·ln(1.25)        ("within 2× log")
 *   uncorroborated          otherwise
 *   sits-on-segment-boundary  prev bar and ex-date bar are in different
 *                           VendorSegments (the "jump" is a ticker stitch,
 *                           not corroboration — §6.8)
 *   no-bars                 no tradeable prev bar or no bar on exDate
 * Requiring BOTH open and close to reprice is what separates a real split
 * (repricing persists) from a single bad open print — BR 2024-10-04:
 * measured_open 1.874 ≈ factor 1.875 (err 0.000) but measured_close 0.999
 * (err 0.631 > 2·ln1.25) ⇒ uncorroborated.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PrismaService } from "../prisma.service.js";
import { VENDOR } from "./import-databento.js";

const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

// ---------------------------------------------------------------------------
// Rubric (pure — unit tests drive classifyInbandRow directly).
// ---------------------------------------------------------------------------

export const CORROBORATED_LOG = Math.log(1.25);
export const DRIFTED_LOG = 2 * CORROBORATED_LOG;

export type InbandClass =
  | "corroborated"
  | "drifted-but-plausible"
  | "uncorroborated"
  | "sits-on-segment-boundary"
  | "no-bars";

export interface AuditBar {
  date: string;
  open: number | null;
  close: number | null;
  segmentId: string | null;
}

export interface AuditVerdict {
  cls: InbandClass;
  measuredOpen: number | null;
  measuredClose: number | null;
  errOpen: number | null;
  errClose: number | null;
  prevDate: string | null;
  exSegmentId: string | null;
}

export function classifyInbandRow(
  row: { symbol: string; exDate: string; factor: number },
  bars: AuditBar[],
): AuditVerdict {
  const tradeable = bars.filter((b) => b.open != null && b.close != null);
  const exBar = tradeable.find((b) => b.date === row.exDate);
  const prev = [...tradeable].reverse().find((b) => b.date < row.exDate);
  if (!exBar || !prev) {
    return { cls: "no-bars", measuredOpen: null, measuredClose: null, errOpen: null, errClose: null, prevDate: prev?.date ?? null, exSegmentId: exBar?.segmentId ?? null };
  }
  if (prev.segmentId !== exBar.segmentId) {
    return { cls: "sits-on-segment-boundary", measuredOpen: null, measuredClose: null, errOpen: null, errClose: null, prevDate: prev.date, exSegmentId: exBar.segmentId };
  }
  const measuredOpen = (prev.close as number) / (exBar.open as number);
  const measuredClose = (prev.close as number) / (exBar.close as number);
  const errOpen = Math.abs(Math.log(measuredOpen / row.factor));
  const errClose = Math.abs(Math.log(measuredClose / row.factor));
  const e = Math.max(errOpen, errClose);
  const cls: InbandClass = e <= CORROBORATED_LOG ? "corroborated" : e <= DRIFTED_LOG ? "drifted-but-plausible" : "uncorroborated";
  return { cls, measuredOpen, measuredClose, errOpen, errClose, prevDate: prev.date, exSegmentId: exBar.segmentId };
}

// ---------------------------------------------------------------------------
// Audit run.
// ---------------------------------------------------------------------------

export interface AuditDeps {
  prisma: PrismaService;
  reportsDir?: string | null;
  today?: string;
}

export async function runInbandAudit(deps: AuditDeps): Promise<{ counts: Record<InbandClass, number>; rows: (AuditVerdict & { symbol: string; exDate: string; factor: number })[] }> {
  const { prisma } = deps;
  const rows = await prisma.splitEvent.findMany({ where: { source: "inband" }, orderBy: [{ symbol: "asc" }, { exDate: "asc" }] });

  const bySymbol = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = bySymbol.get(r.symbol) ?? [];
    list.push(r);
    bySymbol.set(r.symbol, list);
  }

  const counts: Record<InbandClass, number> = {
    corroborated: 0,
    "drifted-but-plausible": 0,
    uncorroborated: 0,
    "sits-on-segment-boundary": 0,
    "no-bars": 0,
  };
  const out: (AuditVerdict & { symbol: string; exDate: string; factor: number })[] = [];

  for (const [symbol, symbolRows] of bySymbol) {
    const bars = await prisma.vendorBar.findMany({ where: { vendor: VENDOR, symbol }, orderBy: { date: "asc" } });
    for (const r of symbolRows) {
      const v = classifyInbandRow(r, bars);
      counts[v.cls]++;
      out.push({ symbol, exDate: r.exDate, factor: r.factor, ...v });
    }
  }

  const today = deps.today ?? new Date().toISOString().slice(0, 10);
  if (deps.reportsDir !== null) {
    const dir = deps.reportsDir ?? path.join(PKG_ROOT, "reports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `inband-audit-${today}.json`), JSON.stringify({ date: today, total: rows.length, counts, rows: out }, null, 2));
    const header = "symbol,exDate,factor,class,measuredOpen,measuredClose,errOpen,errClose,prevDate,exSegmentId";
    const csv = out
      .map((r) => [r.symbol, r.exDate, r.factor, r.cls, r.measuredOpen?.toFixed(4) ?? "", r.measuredClose?.toFixed(4) ?? "", r.errOpen?.toFixed(4) ?? "", r.errClose?.toFixed(4) ?? "", r.prevDate ?? "", r.exSegmentId ?? ""].join(","))
      .join("\n");
    writeFileSync(path.join(dir, `inband-audit-${today}.csv`), `${header}\n${csv}\n`);
  }
  return { counts, rows: out };
}

async function main(): Promise<void> {
  const prisma = new PrismaService();
  try {
    const { counts, rows } = await runInbandAudit({ prisma });
    console.log("counts:", JSON.stringify(counts));
    for (const cls of ["uncorroborated", "sits-on-segment-boundary"] as const) {
      const flagged = rows.filter((r) => r.cls === cls);
      console.log(`\n${cls} (${flagged.length}):`);
      for (const r of flagged) console.log(`  ${r.symbol} ${r.exDate} factor=${r.factor} measuredOpen=${r.measuredOpen?.toFixed(3) ?? "-"} measuredClose=${r.measuredClose?.toFixed(3) ?? "-"}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
