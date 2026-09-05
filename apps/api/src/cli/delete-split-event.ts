/**
 * Single-row SplitEvent deletion (migration-style, loudly logged).
 * Built for the BR 2024-10-04 false positive (PROGRESS 2026-09-05 R4
 * follow-up: 15:8 inband/estimated row, but both store and vendor closes
 * sit ~$215 across that date — the detector was fooled by a single bad
 * open print of 114.75 vs prev close 215.07).
 *
 *   pnpm -C apps/api split:delete -- --symbol BR --ex-date 2024-10-04 --reason "false positive"
 *
 * Prints the exact row JSON before and after; refuses (exit 1) when no
 * matching row exists. Registry rows are NEVER deleted silently anywhere
 * else — flagged audit rows go through here one at a time after review.
 */
import { pathToFileURL } from "node:url";
import { PrismaService } from "../prisma.service.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const symbol = get("--symbol");
  const exDate = get("--ex-date");
  const reason = get("--reason") ?? "(no reason given)";
  if (!symbol || !exDate) throw new Error("usage: tsx src/cli/delete-split-event.ts --symbol BR --ex-date 2024-10-04 --reason ...");

  const prisma = new PrismaService();
  try {
    const row = await prisma.splitEvent.findUnique({ where: { symbol_exDate: { symbol, exDate } } });
    if (!row) {
      console.error(`NO SplitEvent row for (${symbol}, ${exDate}) — nothing deleted.`);
      process.exitCode = 1;
      return;
    }
    console.log(`[delete-split-event] reason: ${reason}`);
    console.log(`[delete-split-event] deleting row: ${JSON.stringify(row)}`);
    await prisma.splitEvent.delete({ where: { symbol_exDate: { symbol, exDate } } });
    const after = await prisma.splitEvent.findUnique({ where: { symbol_exDate: { symbol, exDate } } });
    console.log(`[delete-split-event] post-delete lookup: ${after === null ? "null (gone)" : JSON.stringify(after)}`);
    const remaining = await prisma.splitEvent.count({ where: { symbol } });
    console.log(`[delete-split-event] remaining SplitEvent rows for ${symbol}: ${remaining}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
