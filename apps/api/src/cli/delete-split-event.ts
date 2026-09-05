/**
 * SplitEvent deletion (migration-style, loudly logged).
 * Built for the BR 2024-10-04 false positive (PROGRESS 2026-09-05 R4
 * follow-up: 15:8 inband/estimated row, but both store and vendor closes
 * sit ~$215 across that date — the detector was fooled by a single bad
 * open print of 114.75 vs prev close 215.07).
 *
 * Single row:
 *   pnpm -C apps/api split:delete -- --symbol BR --ex-date 2024-10-04 --reason "false positive"
 * Batch from an audit CSV (2026-09-05 in-band corroboration audit):
 *   pnpm -C apps/api split:delete -- --from-csv reports/inband-audit-2026-09-05.csv \
 *     --class uncorroborated --reason "audit 2026-09-05: bad-open-print class" --yes
 *
 * Prints every deleted row's JSON. Refuses (exit 1) when a requested row
 * does not exist. Registry rows are NEVER deleted silently anywhere else —
 * flagged audit rows go through here after review. Batch mode requires
 * --yes so a bare command can never mass-delete.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PrismaService } from "../prisma.service.js";

type Prisma = PrismaService;

async function deleteRow(prisma: Prisma, symbol: string, exDate: string, reason: string): Promise<boolean> {
  const row = await prisma.splitEvent.findUnique({ where: { symbol_exDate: { symbol, exDate } } });
  if (!row) {
    console.error(`NO SplitEvent row for (${symbol}, ${exDate}) — nothing deleted.`);
    return false;
  }
  console.log(`[delete-split-event] reason: ${reason} | deleting: ${JSON.stringify(row)}`);
  await prisma.splitEvent.delete({ where: { symbol_exDate: { symbol, exDate } } });
  return true;
}

function parseAuditCsv(path: string, cls: string): { symbol: string; exDate: string }[] {
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  const hdr = (lines[0] ?? "").split(",");
  const iSym = hdr.indexOf("symbol"), iDate = hdr.indexOf("exDate"), iCls = hdr.indexOf("class");
  if (iSym < 0 || iDate < 0 || iCls < 0) throw new Error(`audit CSV must have symbol,exDate,class columns, got: ${lines[0]}`);
  return lines.slice(1)
    .map((l) => l.split(","))
    .filter((c) => c[iCls] === cls)
    .flatMap((c) => {
      const symbol = c[iSym], exDate = c[iDate];
      return symbol && exDate ? [{ symbol, exDate }] : [];
    });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const reason = get("--reason") ?? "(no reason given)";
  const fromCsv = get("--from-csv");
  const cls = get("--class");

  const prisma = new PrismaService();
  try {
    if (fromCsv) {
      if (!cls) throw new Error("--from-csv requires --class");
      if (!args.includes("--yes")) {
        console.error("refusing batch delete without --yes");
        process.exitCode = 1;
        return;
      }
      const targets = parseAuditCsv(fromCsv, cls);
      console.log(`[delete-split-event] batch: ${targets.length} rows with class=${cls} from ${fromCsv}`);
      let deleted = 0, missing = 0;
      for (const t of targets) {
        if (await deleteRow(prisma, t.symbol, t.exDate, reason)) deleted++;
        else missing++;
      }
      const left = await prisma.splitEvent.count({ where: { source: "inband" } });
      console.log(`[delete-split-event] batch done: ${deleted} deleted, ${missing} missing; inband rows remaining: ${left}`);
      if (missing > 0) process.exitCode = 1;
      return;
    }

    const symbol = get("--symbol");
    const exDate = get("--ex-date");
    if (!symbol || !exDate) throw new Error("usage: --symbol BR --ex-date 2024-10-04 | --from-csv PATH --class CLS --yes [--reason ...]");
    if (!(await deleteRow(prisma, symbol, exDate, reason))) {
      process.exitCode = 1;
      return;
    }
    const remaining = await prisma.splitEvent.count({ where: { symbol } });
    console.log(`[delete-split-event] remaining SplitEvent rows for ${symbol}: ${remaining}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
