/**
 * Close-persistence re-audit of in-band SplitEvent rows (2026-09-05
 * follow-up to audit-inband-splits.ts). The corroboration audit's
 * "drifted-but-plausible" class is mixed:
 *   - GENUINE splits whose ex-day OPEN matches prevClose/factor but the
 *     stock moved intraday (ACRS 2023-11-13 1:5, ACRX 2022-10-26 ~1:15.5),
 *   - BAD OPEN PRINTS where the open spikes/dips for 1-2 sessions but the
 *     CLOSE never leaves the pre-split level (AACT 2023-07-27, AAMI
 *     2025-01-24).
 *
 * Factor convention (same as the corroboration audit): factor ≈
 * prevClose/exOpen, so the factor-implied post-split price level is
 * implied = prevClose / factor.
 *
 * Rule: collect the closes of the ex-date bar and the next up to 3
 * tradeable sessions in the SAME VendorSegment as the ex-date bar.
 * Tolerance is the audit's corroboration tolerance (25% log) and the
 * deciding signature is where the closes SIT, not whether they track the
 * implied level: a bad open print never moves the close off the pre-split
 * level, while genuine splits reprice the close and may then drift
 * (deep-reverse microcaps routinely slide >25% within days — e.g. AGRX
 * 2022-04-27 1:33 — so "stays near implied" alone false-flags ~10% of
 * corroborated rows).
 *   hitsPrev    closes within 25% log of prevClose (unadjusted)
 *   hitsImplied closes within 25% log of prevClose / factor
 *   bad-print           >= 2 closes sit at the UNADJUSTED prevClose level
 *                       AND < 2 closes sit at the implied level — the
 *                       close never repriced at all
 *   genuine-persistent  otherwise (repriced close, drift allowed)
 *   not-testable        no ex-date bar / no prev bar / prev bar in another
 *                       segment (same no-bars / segment-boundary cases as
 *                       the corroboration audit — keep prior verdict)
 * (The impliedHits guard matters for shallow factors 0.64..1.56, where the
 * two tolerance bands overlap — e.g. RELL 2025-04-10 factor 1.39 has all 4
 * closes within 25% log of BOTH levels; those are genuine — the ex-open
 * matched the factor exactly — not bad prints.)
 *
 *   pnpm -C apps/api audit:persistence
 *
 * READ-ONLY: writes reports/inband-audit-persistence-<date>.json + .csv.
 * Deletes happen only via cli/delete-split-event.ts --from-csv --class
 * bad-print after review.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PrismaService } from "../prisma.service.js";
import { VENDOR } from "./import-databento.js";
import { CORROBORATED_LOG } from "./audit-inband-splits.js";

const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

export const PERSIST_LOOKAHEAD = 3; // ex-day + next up to 3 sessions
export const PERSIST_MIN_HITS = 2;

export type PersistenceClass = "genuine-persistent" | "bad-print" | "not-testable";

export interface PersistenceBar {
  date: string;
  close: number | null;
  segmentId: string | null;
}

export interface PersistenceVerdict {
  cls: PersistenceClass;
  persistHits: number | null;
  prevHits: number | null;
  persistTotal: number | null;
  prevDate: string | null;
  exSegmentId: string | null;
}

export function classifyPersistence(
  row: { symbol: string; exDate: string; factor: number },
  bars: PersistenceBar[],
): PersistenceVerdict {
  const tradeable = bars.filter((b) => b.close != null);
  const exIdx = tradeable.findIndex((b) => b.date === row.exDate);
  const exBar = exIdx >= 0 ? tradeable[exIdx] : undefined;
  const prev = [...tradeable].reverse().find((b) => b.date < row.exDate);
  if (!exBar || !prev) {
    return { cls: "not-testable", persistHits: null, prevHits: null, persistTotal: null, prevDate: prev?.date ?? null, exSegmentId: exBar?.segmentId ?? null };
  }
  if (prev.segmentId !== exBar.segmentId) {
    return { cls: "not-testable", persistHits: null, prevHits: null, persistTotal: null, prevDate: prev.date, exSegmentId: exBar.segmentId };
  }
  const prevClose = prev.close as number;
  const implied = prevClose / row.factor;
  const window: number[] = [];
  for (let i = exIdx; i < tradeable.length && window.length < 1 + PERSIST_LOOKAHEAD; i++) {
    const b = tradeable[i];
    if (!b || b.segmentId !== exBar.segmentId) break; // never cross a ticker stitch
    window.push(b.close as number);
  }
  const persistHits = window.filter((c) => Math.abs(Math.log(c / implied)) <= CORROBORATED_LOG).length;
  const prevHits = window.filter((c) => Math.abs(Math.log(c / prevClose)) <= CORROBORATED_LOG).length;
  const cls: PersistenceClass = prevHits >= PERSIST_MIN_HITS && persistHits < PERSIST_MIN_HITS ? "bad-print" : "genuine-persistent";
  return { cls, persistHits, prevHits, persistTotal: window.length, prevDate: prev.date, exSegmentId: exBar.segmentId };
}

export async function runPersistenceAudit(deps: { prisma: PrismaService; reportsDir?: string | null; today?: string }) {
  const { prisma } = deps;
  const rows = await prisma.splitEvent.findMany({ where: { source: "inband" }, orderBy: [{ symbol: "asc" }, { exDate: "asc" }] });

  const bySymbol = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = bySymbol.get(r.symbol) ?? [];
    list.push(r);
    bySymbol.set(r.symbol, list);
  }

  const counts: Record<PersistenceClass, number> = { "genuine-persistent": 0, "bad-print": 0, "not-testable": 0 };
  const out: (PersistenceVerdict & { symbol: string; exDate: string; factor: number })[] = [];

  for (const [symbol, symbolRows] of bySymbol) {
    const bars = await prisma.vendorBar.findMany({ where: { vendor: VENDOR, symbol }, orderBy: { date: "asc" } });
    for (const r of symbolRows) {
      const v = classifyPersistence(r, bars);
      counts[v.cls]++;
      out.push({ symbol, exDate: r.exDate, factor: r.factor, ...v });
    }
  }

  const today = deps.today ?? new Date().toISOString().slice(0, 10);
  if (deps.reportsDir !== null) {
    const dir = deps.reportsDir ?? path.join(PKG_ROOT, "reports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `inband-audit-persistence-${today}.json`), JSON.stringify({ date: today, total: rows.length, counts, rows: out }, null, 2));
    const header = "symbol,exDate,factor,class,persistHits,prevHits,persistTotal,prevDate,exSegmentId";
    const csv = out
      .map((r) => [r.symbol, r.exDate, r.factor, r.cls, r.persistHits ?? "", r.prevHits ?? "", r.persistTotal ?? "", r.prevDate ?? "", r.exSegmentId ?? ""].join(","))
      .join("\n");
    writeFileSync(path.join(dir, `inband-audit-persistence-${today}.csv`), `${header}\n${csv}\n`);
  }
  return { counts, rows: out };
}

async function main(): Promise<void> {
  const prisma = new PrismaService();
  try {
    const { counts, rows } = await runPersistenceAudit({ prisma });
    console.log("counts:", JSON.stringify(counts));
    const anchors = [
      ["AACT", "2023-07-27"], ["AAMI", "2025-01-24"],
      ["ACRS", "2023-11-13"], ["ACRX", "2022-10-26"],
    ] as const;
    console.log("\nanchors:");
    for (const [s, d] of anchors) {
      const r = rows.find((x) => x.symbol === s && x.exDate === d);
      console.log(`  ${s} ${d}: ${r ? `${r.cls} (impliedHits=${r.persistHits} prevHits=${r.prevHits} of ${r.persistTotal})` : "NOT IN REGISTRY"}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
